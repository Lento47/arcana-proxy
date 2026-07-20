// src/free-usage-do.ts
// Durable Object that owns the authoritative free-usage state for a single
// subject key. One DO per subject key, addressed by the same SHA-256-derived
// key the KV path uses (`free_usage:<sha256("free:" + userId).slice(0,40)>`).
//
// Why a DO: the spec calls for atomic reservation under concurrent requests.
// The KV path uses optimistic read-modify-write, which means two concurrent
// `reserveFreeTurn` calls for the same subject can both read `turnsUsed=9`
// and both write `turnsUsed=10`, admitting 11 turns. The spec QA test
// "11 concurrent unique turn requests admit exactly 10" cannot pass under KV.
// A DO serializes the read-modify-write inside one isolate.
//
// Lifecycle: this file is added in a non-behavior-changing commit. The
// `FREE_USAGE_DO_ENABLED` env var gates the proxy's call sites. While the
// flag is off (default), the proxy still uses KV; the DO is unreachable from
// any code path. After staging smoke-test, the flag is flipped on in a
// separate commit and the spec QA test is expected to pass.
//
// The class implements two RPC methods via `fetch`:
//   POST /reserve  body: FreeReserveRequest
//     -> FreeTurnAdmission  (allowed, error, snapshot)
//   POST /settle   body: FreeSettleRequest
//     -> { ok: true } | { ok: false }
//   GET  /snapshot
//     -> FreeUsageSnapshot  (free user shape; for /v1/free-usage/sessions/current)

interface FreeTurnReservationDO {
  admittedAt: number
  providerCalls: number
  status: "admitted" | "completed" | "failed"
  settledAt?: number
}

interface FreeUsageRecordDO {
  freeSessionId: string
  arcanaSessionKey: string
  activatedAt: number
  expiresAt: number
  resetAt: number
  turnsUsed: number
  tokensUsed: number
  reservations: string  // JSON-encoded Record<string, FreeTurnReservationDO>
  hydrated: number      // 0 = not yet hydrated from KV, 1 = hydrated
}

// Mirror the constants from src/index.ts. Kept in sync via the doc-sync check.
// DO NOT change without updating both files.
const FREE_SESSION_TURN_LIMIT = 10
const FREE_SESSION_DURATION_MS = 60 * 60 * 1000
const FREE_SESSION_RESET_MS = 7 * 24 * 60 * 60 * 1000
const FREE_TURN_PROVIDER_CALL_LIMIT = 2
const FREE_MAX_INPUT_TOKENS = 16_384
const FREE_MAX_OUTPUT_TOKENS = 2_048
const FREE_PROVIDER_ATTEMPT_LIMIT = 2
const FREE_WEEKLY_TOKEN_AGGREGATE = 200_000

type FreeUsageState = "eligible" | "active" | "exhausted" | "expired"

interface FreeUsageSnapshot {
  state: FreeUsageState
  freeSessionId?: string
  activatedAt?: string
  expiresAt?: string
  resetAt?: string
  used: number
  remaining: number
  limit: number
  tokensUsed: number
  tokensLimit: number
  tokensRemaining: number
}

interface FreeTurnAdmission {
  allowed: boolean
  error?: string
  message?: string
  recordKey?: string  // always the DO id; kept for caller symmetry with the KV path
  turnKey?: string
  snapshot: FreeUsageSnapshot
}

interface FreeReserveRequest {
  sessionKey: string
  turnKey: string
  inputTokens: number
  now: number  // caller-supplied; lets tests use a fake clock
}

interface FreeSettleRequest {
  turnKey: string
  status: "completed" | "failed"
  tokensIn: number
  tokensOut: number
  now: number
}

// Exported for the wrangler class binding. The proxy reaches it via
//   env.FREE_USAGE.idFromName(subjectKey)
//   env.FREE_USAGE.get(env.FREE_USAGE.idFromName(subjectKey))
// and then stub.fetch(new Request("https://do/reserve", { method: "POST", body: ... }))
export class FreeUsageDO {
  private readonly state: DurableObjectState
  constructor(state: DurableObjectState) {
    this.state = state
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS free_usage (
        id INTEGER PRIMARY KEY,
        record TEXT NOT NULL
      )
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/reserve" && request.method === "POST") {
        const body = (await request.json()) as FreeReserveRequest
        const result = await this.reserve(body)
        return Response.json(result)
      }
      if (url.pathname === "/settle" && request.method === "POST") {
        const body = (await request.json()) as FreeSettleRequest
        const ok = await this.settle(body)
        return Response.json({ ok })
      }
      if (url.pathname === "/snapshot" && request.method === "GET") {
        const record = this.readRecord()
        return Response.json(snapshot(record))
      }
      if (url.pathname === "/hydrate" && request.method === "POST") {
        // One-shot migration: a free user may have a record already in KV from
        // before the DO was enabled. On first DO hit, the proxy calls /hydrate
        // with the KV record (if any). We accept the record if it is still in
        // its weekly window; otherwise we ignore it. The KV record is NOT
        // deleted by the DO — it stays as a backup until the TTL expires.
        const body = (await request.json()) as { kv: FreeUsageRecordDO | null; now: number }
        return Response.json({ ok: this.hydrate(body.kv, body.now) })
      }
      return new Response("not_found", { status: 404 })
    } catch (e) {
      return Response.json({ error: "do_error", message: String(e) }, { status: 500 })
    }
  }

  // --- SQL helpers (the DO's storage is the only authoritative store) ---

  private readRecord(): FreeUsageRecordDO | null {
    const row = this.state.storage.sql.exec<{ record: string }>(
      "SELECT record FROM free_usage WHERE id = 1 LIMIT 1"
    ).one()
    if (!row) return null
    const parsed = JSON.parse(row.record) as FreeUsageRecordDO
    return parsed
  }

  private writeRecord(record: FreeUsageRecordDO): void {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO free_usage (id, record) VALUES (1, ?)",
      JSON.stringify(record)
    )
  }

  // --- public methods (exposed via fetch RPC) ---

  private reserve(req: FreeReserveRequest): FreeTurnAdmission {
    const now = req.now
    let record = this.readRecord()
    if (!record || now >= record.resetAt) {
      record = {
        freeSessionId: `free_${crypto.randomUUID()}`,
        arcanaSessionKey: req.sessionKey,
        activatedAt: now,
        expiresAt: now + FREE_SESSION_DURATION_MS,
        resetAt: now + FREE_SESSION_RESET_MS,
        turnsUsed: 0,
        tokensUsed: 0,
        reservations: "{}",
        hydrated: 1,
      }
    }

    // 1. conversation-mismatch
    if (record.arcanaSessionKey !== req.sessionKey) {
      return {
        allowed: false,
        error: "free_session_conversation_mismatch",
        message: "This free session is already bound to another Arcana conversation.",
        snapshot: snapshot(record, now),
      }
    }

    const reservations = parseReservations(record.reservations)

    // 2. existing reservation (idempotent retry on the same turn_id)
    const existing = reservations[req.turnKey]
    if (existing) {
      if (existing.providerCalls >= FREE_TURN_PROVIDER_CALL_LIMIT) {
        return {
          allowed: false,
          error: "free_turn_budget_reached",
          message: "This free turn reached its internal provider-call limit.",
          snapshot: snapshot(record, now),
        }
      }
      existing.providerCalls++
      record.reservations = JSON.stringify(reservations)
      this.writeRecord(record)
      return { allowed: true, recordKey: "do", turnKey: req.turnKey, snapshot: snapshot(record, now) }
    }

    // 3. weekly aggregate cap (the cheap pre-flight)
    if (record.tokensUsed + req.inputTokens > FREE_WEEKLY_TOKEN_AGGREGATE) {
      return {
        allowed: false,
        error: "free_weekly_token_limit_reached",
        message: `This free week's token allowance is used up. Weekly limit: ${FREE_WEEKLY_TOKEN_AGGREGATE.toLocaleString("en")} combined in+out tokens. Resets at ${new Date(record.resetAt).toISOString()}.`,
        snapshot: snapshot(record, now),
      }
    }

    // 4. per-turn input cap
    if (req.inputTokens > FREE_MAX_INPUT_TOKENS) {
      return {
        allowed: false,
        error: "free_turn_budget_reached",
        message: `Free turns are limited to about ${FREE_MAX_INPUT_TOKENS.toLocaleString("en")} input tokens. Output is capped at ${FREE_MAX_OUTPUT_TOKENS.toLocaleString("en")} tokens.`,
        snapshot: snapshot(record, now),
      }
    }

    // 5. session expired
    if (now >= record.expiresAt) {
      return {
        allowed: false,
        error: "free_session_expired",
        message: "The one-hour free session has ended.",
        snapshot: snapshot(record, now),
      }
    }

    // 6. NEW: weekly cooldown — emits free_weekly_cooldown per the spec.
    //    Under KV, this branch was unreachable (the read returned null and a
    //    new record was created, ignoring the cooldown). Under the DO, we can
    //    see the prior record's resetAt and reject explicitly.
    if (now < record.resetAt && record.turnsUsed >= FREE_SESSION_TURN_LIMIT) {
      return {
        allowed: false,
        error: "free_weekly_cooldown",
        message: `Weekly reset in effect. Resets at ${new Date(record.resetAt).toISOString()}.`,
        snapshot: snapshot(record, now),
      }
    }

    // 7. turns exhausted (10-turn cap hit; this is the in-window case)
    if (record.turnsUsed >= FREE_SESSION_TURN_LIMIT) {
      return {
        allowed: false,
        error: "free_turn_limit_reached",
        message: "The free session has used all 10 turns.",
        snapshot: snapshot(record, now),
      }
    }

    // 8. admit
    record.turnsUsed++
    reservations[req.turnKey] = { admittedAt: now, providerCalls: 1, status: "admitted" }
    record.reservations = JSON.stringify(reservations)
    this.writeRecord(record)
    return { allowed: true, recordKey: "do", turnKey: req.turnKey, snapshot: snapshot(record, now) }
  }

  private settle(req: FreeSettleRequest): boolean {
    const record = this.readRecord()
    if (!record) return false
    const reservations = parseReservations(record.reservations)
    const turn = reservations[req.turnKey]
    if (!turn) return false
    turn.status = req.status
    turn.settledAt = req.now
    if (req.status === "completed") {
      const delta = Math.max(0, req.tokensIn) + Math.max(0, req.tokensOut)
      record.tokensUsed = Math.min(FREE_WEEKLY_TOKEN_AGGREGATE, record.tokensUsed + delta)
    }
    record.reservations = JSON.stringify(reservations)
    this.writeRecord(record)
    return true
  }

  private hydrate(kv: FreeUsageRecordDO | null, now: number): boolean {
    if (!kv) return false
    if (this.readRecord()) return false  // DO already has a record
    if (now >= kv.resetAt) return false   // prior record is in the past; ignore
    this.writeRecord({ ...kv, hydrated: 1 })
    return true
  }
}

// --- pure helpers (no `this` needed) ---

function parseReservations(json: string): Record<string, FreeTurnReservationDO> {
  try {
    const parsed = JSON.parse(json) as Record<string, FreeTurnReservationDO>
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function snapshot(record: FreeUsageRecordDO | null, now: number = Date.now()): FreeUsageSnapshot {
  if (!record || now >= record.resetAt) {
    return {
      state: "eligible",
      used: 0,
      remaining: FREE_SESSION_TURN_LIMIT,
      limit: FREE_SESSION_TURN_LIMIT,
      tokensUsed: 0,
      tokensLimit: FREE_WEEKLY_TOKEN_AGGREGATE,
      tokensRemaining: FREE_WEEKLY_TOKEN_AGGREGATE,
    }
  }
  const state: FreeUsageState =
    record.turnsUsed >= FREE_SESSION_TURN_LIMIT || record.tokensUsed >= FREE_WEEKLY_TOKEN_AGGREGATE
      ? "exhausted"
      : now >= record.expiresAt
        ? "expired"
        : "active"
  return {
    state,
    freeSessionId: record.freeSessionId,
    activatedAt: new Date(record.activatedAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    resetAt: new Date(record.resetAt).toISOString(),
    used: record.turnsUsed,
    remaining: Math.max(0, FREE_SESSION_TURN_LIMIT - record.turnsUsed),
    limit: FREE_SESSION_TURN_LIMIT,
    tokensUsed: record.tokensUsed,
    tokensLimit: FREE_WEEKLY_TOKEN_AGGREGATE,
    tokensRemaining: Math.max(0, FREE_WEEKLY_TOKEN_AGGREGATE - record.tokensUsed),
  }
}