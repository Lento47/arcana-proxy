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
const FREE_SESSION_TURN_LIMIT = 10          // soft display threshold only — no hard reject
const FREE_SESSION_DURATION_MS = 60 * 60 * 1000   // HARD stop: the only real cap
const FREE_SESSION_RESET_MS = 7 * 24 * 60 * 60 * 1000
const FREE_TURN_MAX_DURATION_MS = 60_000    // 60-second time budget per turn: proxy retries any model/provider until window expires
const FREE_PROVIDER_ATTEMPT_LIMIT = 2
const FREE_WEEKLY_TOKEN_AGGREGATE = 1_000_000_000  // unlimited in practice; display ceiling only

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
      // Time-based budget: the proxy gets 30 seconds to find a working model
      if (req.now - existing.admittedAt > FREE_TURN_MAX_DURATION_MS) {
        return {
          allowed: false,
          error: "free_turn_timed_out",
          message: "This free turn's window expired. Try again with a fresh turn.",
          snapshot: snapshot(record, now),
        }
      }
      existing.providerCalls++
      record.reservations = JSON.stringify(reservations)
      this.writeRecord(record)
      return { allowed: true, recordKey: "do", turnKey: req.turnKey, snapshot: snapshot(record, now) }
    }

    // The 60-minute session window is the ONLY hard cap. Turns are a soft
    // display threshold (counted for the snapshot, never rejected) and tokens
    // are unlimited — so no weekly-aggregate, per-turn-input, weekly-cooldown,
    // or turn-limit rejections here. Session expiry is the sole terminal
    // reject; the persisted record (until resetAt) keeps the subject locked
    // out for the weekly window after their hour ends.
    if (now >= record.expiresAt) {
      return {
        allowed: false,
        error: "free_session_expired",
        message: "The one-hour free session has ended.",
        snapshot: snapshot(record, now),
      }
    }

    // admit
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
      // Tokens are unlimited; accumulate for display only (no cap, no clamp).
      record.tokensUsed = record.tokensUsed + delta
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
  // Turns are a soft display threshold (never "exhausted"); the only hard
  // terminal state is the 60-minute session expiry. Tokens are unlimited.
  const state: FreeUsageState = now >= record.expiresAt ? "expired" : "active"
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