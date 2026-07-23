/**
 * Top-tier free routing algorithm for Arcana.
 *
 * Goals:
 *  - Quality over quantity: rank free models, prefer signal density.
 *  - Progressive tokens: expand budget only when free turns are succeeding.
 *  - Scale-ready: rate limits and weekly free caps designed for ~5k free users.
 *  - Discover free / free-long / Chinese long-context from live catalog.
 *
 * Free users never default to paid Aihubmix. Paid long Chinese models are
 * classified for Pro / future tiers, not free product path.
 */

export type ClassifiedModel = {
  id: string
  free: boolean
  contextLength: number
  longContext: boolean // ≥ 256k
  megaContext: boolean // ≥ 900k
  chinese: boolean
  coding: boolean
  qualityScore: number
  promptPrice: number
  completionPrice: number
}

export type FreePoolSnapshot = {
  updatedAt: string
  free: ClassifiedModel[]
  freeLong: ClassifiedModel[]
  paidLongChinese: ClassifiedModel[]
  defaultModel: string
}

export type ProgressiveBudget = {
  maxInputTokens: number
  maxOutputTokens: number
  tier: "lean" | "standard" | "expanded"
  reason: string
}

// ── Constants (scale for ~5k free users) ──────────────────────────────────

/** Seed pool if catalog discovery fails or is empty */
export const FREE_MODEL_SEED = [
  "openrouter/free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "openai/gpt-oss-20b:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "tencent/hy3:free",
] as const

export const FREE_MODEL_DEFAULT = "openrouter/free"

/**
 * Free product caps. Product intent (2026-07): a free session is one 60-minute
 * window of effectively unlimited use. The 10-turn counter is a SOFT display
 * threshold — it does not hard-block; the only hard stop is the 60-minute
 * session window, after which the weekly (7-day) reset locks the subject out
 * until resetAt. Token caps are unlimited (set high enough to never bind); the
 * server stops tracking them as a gate. Rate limits (FREE_IP/USER/GLOBAL) still
 * pace burst abuse; they do not cap total session usage.
 */
export const FREE_SESSION_TURN_LIMIT = 10          // soft display threshold only — no hard reject
export const FREE_SESSION_DURATION_MS = 60 * 60 * 1000   // HARD stop: the only real cap
export const FREE_SESSION_RESET_MS = 7 * 24 * 60 * 60 * 1000
export const FREE_WEEKLY_TOKEN_AGGREGATE = 1_000_000_000  // unlimited in practice; display ceiling only

/**
 * Progressive wire budgets. With unlimited tokens, all tiers are set to a
 * high ceiling so clampBodyToBudget never truncates free traffic. The tier
 * label is still reported (X-Arcana-Free-Budget-Tier) for observability.
 */
export const FREE_BUDGET = {
  lean: { maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
  standard: { maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
  expanded: { maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
} as const

/** Absolute ceiling (never exceed even on expanded) */
export const FREE_MAX_INPUT_TOKENS = FREE_BUDGET.expanded.maxInputTokens
export const FREE_MAX_OUTPUT_TOKENS = FREE_BUDGET.expanded.maxOutputTokens

/** Rate limits sized for ~5k free MAU (peak ~50–100 free LLM req/min globally) */
export const FREE_IP_RATE_LIMIT = 15 // was 20 — tighter under multi-account
export const FREE_USER_RATE_LIMIT = 8 // was 12 — one user shouldn't hog free pool
export const FREE_GLOBAL_SOFT_RPM = 120 // isolate-local soft brake for free LLM paths

const CHINESE_RE =
  /qwen|deepseek|glm|yi-|moonshot|kimi|minimax|baichuan|internlm|stepfun|doubao|hunyuan|ernie|zhipu|01-ai|alibaba|tencent|bytedance|hy3|seedream|yuanbao/i
const CODING_RE = /code|coder|coding|instruct|chat|it$|oss|nemotron|gemma|llama|qwen|deepseek|glm/i
const LONG_CTX = 262_144
const MEGA_CTX = 900_000

const POOL_KV_KEY = "free:model_pools"
const POOL_TTL_SEC = 3600 // reclassify at least hourly

// ── Classification ────────────────────────────────────────────────────────

function priceNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : 1
  }
  return 1 // unknown → treat as paid
}

function contextLen(m: any): number {
  const c =
    m?.context_length
    ?? m?.contextLength
    ?? m?.top_provider?.context_length
    ?? m?.architecture?.context_length
    ?? 0
  const n = Number(c)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function isFreePricing(m: any, id: string): boolean {
  if (/:free$/i.test(id) || /^openrouter\/free$/i.test(id)) return true
  const p = priceNum(m?.pricing?.prompt ?? m?.pricing?.input)
  const c = priceNum(m?.pricing?.completion ?? m?.pricing?.output)
  // OpenRouter free variants are 0/0; some list null
  if (p === 0 && c === 0) return true
  return false
}

/**
 * Quality score 0–100. Higher = prefer for free agent turns.
 * Quality over raw size: coding/instruct + free + healthy family beat giant empty free shells.
 */
export function scoreModel(m: ClassifiedModel): number {
  let s = 0
  if (m.free) s += 25
  // Context: diminishing returns; 128k–256k is sweet for free agent; 1M is bonus
  if (m.contextLength >= MEGA_CTX) s += 18
  else if (m.contextLength >= LONG_CTX) s += 14
  else if (m.contextLength >= 128_000) s += 10
  else if (m.contextLength >= 32_000) s += 6
  else s += 2

  if (m.coding) s += 12
  if (m.chinese && m.free) s += 10 // free Chinese long-context is rare gold
  if (m.chinese && m.megaContext && !m.free) s += 8 // paid CN long — pro pool

  // Family quality priors (agent/coding usefulness on free)
  const id = m.id.toLowerCase()
  if (/qwen|deepseek|glm|gemma|gpt-oss|nemotron|llama|hy3|kimi|minimax/.test(id)) s += 8
  if (/70b|72b|32b|27b|31b|235b|397b|ultra|super|pro/.test(id)) s += 5
  if (/nano|tiny|1b|2b|3b|4b|7b|8b|9b|embed|safety|tts|whisper|image|video/.test(id)) s -= 6
  if (/embed|rerank|moderation|whisper|tts|image|video|lyria/.test(id)) s -= 30

  // Prefer meta free router as resilient default, not highest quality.
  // Boost dominates any single free model (e.g. nvidia/nemotron-3-ultra-550b
  // scores ~64) so openrouter/free tops the pool and is the first free→free
  // failover candidate. OpenRouter's meta router auto-picks an available free
  // model, so it returns content where giant free shells (550b nemotron) often
  // return 200-empty when overloaded — which previously caused client retry
  // storms that tripped ARC_RATE_LIMIT.
  if (id === "openrouter/free") s += 50

  return Math.max(0, Math.min(100, s))
}

export function classifyModel(raw: any): ClassifiedModel | null {
  const id = String(raw?.id ?? raw?.name ?? "").trim()
  if (!id) return null
  // Skip aihubmix-prefixed duplicates for free pool (route free via OpenRouter)
  if (id.startsWith("aihubmix/") || id.startsWith("cloudflare/")) return null

  const free = isFreePricing(raw, id)
  const ctx = contextLen(raw)
  const chinese = CHINESE_RE.test(id)
  const coding = CODING_RE.test(id)
  const model: ClassifiedModel = {
    id,
    free,
    contextLength: ctx,
    longContext: ctx >= LONG_CTX,
    megaContext: ctx >= MEGA_CTX,
    chinese,
    coding,
    qualityScore: 0,
    promptPrice: priceNum(raw?.pricing?.prompt ?? raw?.pricing?.input),
    completionPrice: priceNum(raw?.pricing?.completion ?? raw?.pricing?.output),
  }
  model.qualityScore = scoreModel(model)
  return model
}

function isAgentUsable(m: ClassifiedModel): boolean {
  const id = m.id.toLowerCase()
  // Free agent pool: chat/coding only — never embeddings, safety, media
  if (/embed|rerank|moderation|safety|whisper|tts|image|video|lyria|asr|transcri/i.test(id)) return false
  if (m.qualityScore < 25) return false
  return true
}

export function buildPoolsFromCatalog(models: any[]): FreePoolSnapshot {
  const classified = models
    .map(classifyModel)
    .filter((m): m is ClassifiedModel => !!m)

  const free = classified
    .filter((m) => m.free && isAgentUsable(m))
    .sort((a, b) => b.qualityScore - a.qualityScore)

  const freeLong = free
    .filter((m) => m.longContext || m.megaContext)
    .sort((a, b) => b.qualityScore - a.qualityScore || b.contextLength - a.contextLength)

  const paidLongChinese = classified
    .filter((m) => !m.free && m.chinese && (m.longContext || m.megaContext))
    .sort((a, b) => b.qualityScore - a.qualityScore || a.promptPrice - b.promptPrice)
    .slice(0, 40)

  // Ensure seed models present
  const freeIds = new Set(free.map((m) => m.id))
  for (const seed of FREE_MODEL_SEED) {
    if (!freeIds.has(seed)) {
      free.push({
        id: seed,
        free: true,
        contextLength: 32_000,
        longContext: false,
        megaContext: false,
        chinese: /tencent|hy3|qwen|deepseek/i.test(seed),
        coding: true,
        qualityScore: seed === FREE_MODEL_DEFAULT ? 40 : 30,
        promptPrice: 0,
        completionPrice: 0,
      })
    }
  }
  free.sort((a, b) => b.qualityScore - a.qualityScore)

  return {
    updatedAt: new Date().toISOString(),
    free: free.slice(0, 60),
    freeLong: freeLong.slice(0, 20),
    paidLongChinese,
    defaultModel: free[0]?.id || FREE_MODEL_DEFAULT,
  }
}

// ── Pool cache ────────────────────────────────────────────────────────────

let poolMem: { at: number; snap: FreePoolSnapshot } | null = null
const POOL_MEM_TTL_MS = 10 * 60 * 1000

export function invalidateFreePoolCache(): void {
  poolMem = null
}

export async function loadFreePools(
  kv: KVNamespace,
  fetchCatalog: () => Promise<any[]>,
  opts?: { force?: boolean },
): Promise<FreePoolSnapshot> {
  const now = Date.now()
  if (!opts?.force && poolMem && now - poolMem.at < POOL_MEM_TTL_MS) return poolMem.snap

  if (!opts?.force) {
    try {
      const cached = (await kv.get(POOL_KV_KEY, "json")) as FreePoolSnapshot | null
      if (cached?.free?.length && cached.updatedAt) {
        const age = now - new Date(cached.updatedAt).getTime()
        if (age < POOL_TTL_SEC * 1000) {
          poolMem = { at: now, snap: cached }
          return cached
        }
      }
    } catch {}
  }

  // Refresh from catalog
  let models: any[] = []
  try {
    models = await fetchCatalog()
  } catch {}
  const snap = buildPoolsFromCatalog(models)
  poolMem = { at: now, snap }
  try {
    await kv.put(POOL_KV_KEY, JSON.stringify(snap), { expirationTtl: POOL_TTL_SEC * 6 })
  } catch {}
  return snap
}

export function seedPoolSnapshot(): FreePoolSnapshot {
  const free = FREE_MODEL_SEED.map((id) => {
    const m: ClassifiedModel = {
      id,
      free: true,
      contextLength: 32_000,
      longContext: false,
      megaContext: false,
      chinese: /tencent|hy3|qwen|deepseek/i.test(id),
      coding: true,
      qualityScore: 0,
      promptPrice: 0,
      completionPrice: 0,
    }
    m.qualityScore = scoreModel(m)
    return m
  }).sort((a, b) => b.qualityScore - a.qualityScore)
  return {
    updatedAt: new Date().toISOString(),
    free,
    freeLong: [],
    paidLongChinese: [],
    defaultModel: FREE_MODEL_DEFAULT,
  }
}

// ── Routing decisions ─────────────────────────────────────────────────────

export function isFreeModelId(model: string, pool?: FreePoolSnapshot): boolean {
  const m = model.replace(/^(aihubmix|aihub|or|omni|cf|cloudflare)\//, "").trim()
  if (!m) return false
  if (/:free$/i.test(m) || /^openrouter\/free$/i.test(m)) return true
  if (pool?.free.some((x) => x.id === m || x.id === model)) return true
  for (const s of FREE_MODEL_SEED) if (s === m || s === model) return true
  return false
}

export function ensureFreeModel(
  requested: string,
  pool: FreePoolSnapshot,
  opts?: { preferLong?: boolean },
): { model: string; remapped: boolean; from: string; qualityScore: number } {
  const raw = String(requested || "").trim()
  const stripped = raw.replace(/^(aihubmix|aihub|or|omni|cf|cloudflare)\//, "")

  if (isFreeModelId(raw, pool) || isFreeModelId(stripped, pool)) {
    const id = isFreeModelId(stripped, pool) ? stripped : raw.replace(/^(aihubmix|aihub|or)\//, "")
    const hit = pool.free.find((x) => x.id === id)
    return {
      model: id,
      remapped: id !== raw,
      from: raw,
      qualityScore: hit?.qualityScore ?? 40,
    }
  }

  // Paid or unknown → best free (long if preferred and available)
  const pick =
    (opts?.preferLong && pool.freeLong[0])
    || pool.free[0]
    || { id: FREE_MODEL_DEFAULT, qualityScore: 40 }

  return {
    model: pick.id,
    remapped: true,
    from: raw || "(none)",
    qualityScore: pick.qualityScore,
  }
}

/** Free→free failover list ranked by quality, optional long-first */
export function freeModelFailoverList(
  primary: string,
  pool: FreePoolSnapshot,
  max = 4,
  preferLong = false,
): string[] {
  const ranked = preferLong && pool.freeLong.length
    ? [...pool.freeLong, ...pool.free]
    : [...pool.free]
  const out: string[] = []
  const seen = new Set<string>([primary, primary.replace(/^(or|aihubmix)\//, "")])
  for (const m of ranked) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m.id)
    if (out.length >= max) break
  }
  return out
}

/**
 * Progressive token budget: lean → standard → expanded.
 * Expand only when free turns are succeeding and session is mid-flight.
 * Quality first: never expand on failures or first turn (establish signal).
 */
export function progressiveBudget(input: {
  turnsUsed: number
  turnsLimit: number
  tokensUsed: number
  tokensLimit: number
  lastTurnFailed?: boolean
  preferLong?: boolean
}): ProgressiveBudget {
  const remainingTurns = Math.max(0, input.turnsLimit - input.turnsUsed)
  const tokenPressure = input.tokensLimit > 0 ? input.tokensUsed / input.tokensLimit : 0

  // Always lean if failing, almost out of weekly tokens, or first turn
  if (input.lastTurnFailed || input.turnsUsed <= 1 || tokenPressure > 0.75) {
    return {
      ...FREE_BUDGET.lean,
      tier: "lean",
      reason: input.lastTurnFailed
        ? "last_turn_failed"
        : input.turnsUsed <= 1
          ? "first_turns_lean"
          : "token_pressure",
    }
  }

  // Expanded: healthy mid-session, budget left, quality path open
  if (
    input.turnsUsed >= 4
    && remainingTurns >= 2
    && tokenPressure < 0.45
    && !input.preferLong // long tasks stay standard; packer selects, model may be long
  ) {
    return {
      ...FREE_BUDGET.expanded,
      tier: "expanded",
      reason: "healthy_mid_session",
    }
  }

  // Standard default after turn 2
  if (input.turnsUsed >= 2 && tokenPressure < 0.65) {
    return {
      ...FREE_BUDGET.standard,
      tier: "standard",
      reason: "steady_progress",
    }
  }

  return {
    ...FREE_BUDGET.lean,
    tier: "lean",
    reason: "default_lean",
  }
}

export function clampBodyToBudget(body: any, budget: ProgressiveBudget): any {
  const next = { ...body }
  if (Number(next.max_tokens) > budget.maxOutputTokens || next.max_tokens === undefined) {
    next.max_tokens = budget.maxOutputTokens
  }
  if (Number(next.max_completion_tokens) > budget.maxOutputTokens) {
    next.max_completion_tokens = budget.maxOutputTokens
  }
  if (next.max_completion_tokens === undefined && next.max_tokens === undefined) {
    next.max_tokens = budget.maxOutputTokens
  }
  return next
}

/** Heuristic: request looks like it needs long context (still pack, but prefer free-long models) */
export function wantsLongContext(body: any, headerFlag?: string | null): boolean {
  if (headerFlag === "1" || headerFlag === "true" || headerFlag === "long") return true
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  let chars = 0
  for (const m of msgs) {
    const c = m?.content
    if (typeof c === "string") chars += c.length
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (typeof p?.text === "string") chars += p.text.length
      }
    }
  }
  // ~12k+ chars ≈ multi-file / long paste → prefer free-long if any
  return chars >= 12_000
}

// ── EWMA Global free soft rate (per isolate — best-effort for 5k scale) ────
//
// EWMA-smoothed load tracker.  rawCount is the instantaneous sliding-window
// count (same as before).  smoothedLoad is an EWMA of that count, updated
// on every allow().  This prevents a single burst from looking like sustained
// load — the load factor only rises if the burst persists.

const freeGlobalHits: number[] = []

let globalLoadEwma = 0
let globalLoadEwmaLast = 0
const GLOBAL_LOAD_EWMA_ALPHA = 0.25

export function freeGlobalAllow(rpm = FREE_GLOBAL_SOFT_RPM): boolean {
  const now = Date.now()
  while (freeGlobalHits.length && now - freeGlobalHits[0]! > 60_000) freeGlobalHits.shift()

  // Update EWMA load (before adding this request, so it reflects prior load)
  if (globalLoadEwmaLast > 0 && now > globalLoadEwmaLast) {
    globalLoadEwma = GLOBAL_LOAD_EWMA_ALPHA * freeGlobalHits.length + (1 - GLOBAL_LOAD_EWMA_ALPHA) * globalLoadEwma
  } else if (globalLoadEwmaLast === 0) {
    globalLoadEwma = freeGlobalHits.length
  }
  globalLoadEwmaLast = now

  if (freeGlobalHits.length >= rpm) return false
  freeGlobalHits.push(now)
  return true
}

export function freeGlobalLoad(): number {
  const now = Date.now()
  while (freeGlobalHits.length && now - freeGlobalHits[0]! > 60_000) freeGlobalHits.shift()
  // Return the EWMA-smoothed value without mutating state.
  // Only freeGlobalAllow() updates the EWMA — this keeps the smoothed
  // signal stable when load is queried multiple times in one request cycle.
  if (globalLoadEwmaLast > 0 && now > globalLoadEwmaLast) {
    // Compute what the EWMA would be, but leave globalLoadEwma alone
    // so a subsequent freeGlobalAllow() doesn't double-count.
    const updated = GLOBAL_LOAD_EWMA_ALPHA * freeGlobalHits.length + (1 - GLOBAL_LOAD_EWMA_ALPHA) * globalLoadEwma
    return Math.round(Math.max(0, updated))
  }
  return Math.round(Math.max(0, globalLoadEwma))
}

// ── Load Factor System (hybrid load-sensing scheduler) ───────────────────────
//
// The load factor (0.0–1.0) is a composite of two signals:
//   60% — upstream provider error rate (circuit breaker failures)
//   40% — local request rate relative to FREE_GLOBAL_SOFT_RPM
//
// Resources scale smoothly within four bands (green → yellow → orange → red)
// so users always get their 10 turns / 1-hour session, but the quality and
// speed tighten proportionally to protect the pool under load.
//
// The factor is cached per-isolate (60s TTL) and lazily written to KV via
// ctx.waitUntil() — zero latency impact on the request path.

export type LoadLevelBand = "green" | "yellow" | "orange" | "red"

export interface LoadFactorConfig {
  loadFactor: number         // 0.0–1.0 raw composite score
  band: LoadLevelBand        // the band this factor falls in
  turnTimeoutMs: number      // scaled turn timeout (ms)
  outputLimit: number        // scaled max_output_tokens
  failoverCount: number      // scaled model failover list size
  userRpm: number            // scaled per-user rate limi
  ipRpm: number              // scaled per-IP rate limit
}

type BandDef = { floor: number; ceiling: number; label: LoadLevelBand }

const LOAD_BANDS: BandDef[] = [
  { floor: 0.00, ceiling: 0.33, label: "green" },
  { floor: 0.33, ceiling: 0.66, label: "yellow" },
  { floor: 0.66, ceiling: 0.85, label: "orange" },
  { floor: 0.85, ceiling: 1.00, label: "red" },
]

/**
 * Resource values at band boundaries.
 * Index: 0 = green high, 1 = green low (= yellow high),
 * 2 = yellow low (= orange high), 3 = orange low (= red high),
 * 4 = red low.
 */
const RESOURCE_RANGES = {
  turnTimeoutMs:   [30_000, 25_000, 18_000, 12_000, 8_000],
  outputLimit:     [100_000, 60_000, 30_000, 15_000, 8_000],
  failoverCount:   [15, 10, 6, 4, 2],
  userRpm:         [8, 6, 4, 3, 2],
  ipRpm:           [15, 12, 8, 6, 4],
}

/** Scale a resource value within its current band based on load factor progress. */
export function scaleResource(loadFactor: number, range: number[]): number {
  for (const band of LOAD_BANDS) {
    if (loadFactor >= band.floor && loadFactor < band.ceiling) {
      const progress = (loadFactor - band.floor) / (band.ceiling - band.floor)
      const high = range[LOAD_BANDS.indexOf(band)]!
      const low = range[LOAD_BANDS.indexOf(band) + 1]!
      return Math.round(high - progress * (high - low))
    }
  }
  return range[range.length - 1]!
}

/** Build a full LoadFactorConfig from a raw load factor. */
export function computeLoadConfig(loadFactor: number): LoadFactorConfig {
  const clamped = Math.min(1, Math.max(0, loadFactor))
  let band: LoadLevelBand = "green"
  for (const b of LOAD_BANDS) {
    if (clamped >= b.floor && clamped < b.ceiling) { band = b.label; break }
  }
  return {
    loadFactor: clamped,
    band,
    turnTimeoutMs: scaleResource(clamped, RESOURCE_RANGES.turnTimeoutMs),
    outputLimit: scaleResource(clamped, RESOURCE_RANGES.outputLimit),
    failoverCount: scaleResource(clamped, RESOURCE_RANGES.failoverCount),
    userRpm: scaleResource(clamped, RESOURCE_RANGES.userRpm),
    ipRpm: scaleResource(clamped, RESOURCE_RANGES.ipRpm),
  }
}

// ── EWMA Circuit tracking (feeds the error-rate signal) ────────────────────
//
// Replaced raw-ratio + broken-halving-decay with true EWMA.
// The old approach (failures / attempts) had a fatal bias: halving both
// counters preserves the exact ratio. 3 failures in 10 attempts = 0.3;
// halve both → 1 failure in 5 attempts = still 0.3.  The error rate never
// decayed on its own — it could only be diluted by hundreds of fresh
// successes.  For a single-user deployment a transient upstream blip
// permanently elevated the load factor, throttling all subsequent requests.
//
// New approach: EWMA with per-observation alpha.  Each observation updates
// the smoothed error rate.  α=0.30 on failures (30 % weight to new signal),
// α=0.50 on successes (faster recovery — error rate drops 50 % per success).
// Staleness: if no activity for 60 s, error rate decays toward 0 at 5 %/s.
// Minimum 10 observations before reporting a non-zero rate (warm-up guard).

const EWMA_ALPHA_FAILURE = 0.30
const EWMA_ALPHA_SUCCESS = 0.50
const EWMA_STALE_MS = 60_000
const EWMA_DECAY_PER_MS = 0.0005  // ~5 % per second when stale → 0 in ~20 s
const EWMA_MIN_OBSERVATIONS = 10

let ewmaErrorRate = 0
let ewmaErrorCount = 0
let ewmaErrorLastUpdate = 0

/** Record an upstream provider attempt (successful or failed) for load sensing. */
export function recordCircuitActivity(attempt: boolean, failure: boolean): void {
  const now = Date.now()

  // Apply staleness decay if we've been idle
  if (ewmaErrorCount > 0 && ewmaErrorLastUpdate > 0 && now - ewmaErrorLastUpdate > EWMA_STALE_MS) {
    const idleMs = now - ewmaErrorLastUpdate
    ewmaErrorRate = Math.max(0, ewmaErrorRate - EWMA_DECAY_PER_MS * idleMs)
  }

  ewmaErrorLastUpdate = now

  // EWMA update: new observation gets α weight, history gets (1-α) weight
  if (attempt) {
    const alpha = failure ? EWMA_ALPHA_FAILURE : EWMA_ALPHA_SUCCESS
    const observation = failure ? 1.0 : 0.0
    ewmaErrorRate = alpha * observation + (1 - alpha) * ewmaErrorRate
    ewmaErrorCount++
  }
}

/** Compute the local error rate from circuit-tracking data (0..1, EWMA-smoothed). */
export function computeLocalErrorRate(): number {
  if (ewmaErrorCount < EWMA_MIN_OBSERVATIONS) return 0
  // Compute staleness decay on a transient copy — do NOT mutate the global
  // ewmaErrorRate or ewmaErrorLastUpdate.  The write side (recordCircuitActivity)
  // owns the authoritative state; the read side decays a snapshot on the fly.
  const now = Date.now()
  let rate = ewmaErrorRate
  if (ewmaErrorLastUpdate > 0 && now - ewmaErrorLastUpdate > EWMA_STALE_MS) {
    const idleMs = now - ewmaErrorLastUpdate
    rate = Math.max(0, rate - EWMA_DECAY_PER_MS * idleMs)
  }
  return Math.min(1, Math.max(0, rate))
}

// ── Load-level cache + lazy KV writer (Option A) ───────────────────────────
//
// The load factor is cached per-isolate for 60 seconds. When the cache is
// stale, the first request to need it recomputes it from local signals and
// writes it to KV in the background via ctx.waitUntil().
//
// Single-user bias: for deployments with one user (the common case), subtract
// LOAD_BIAS_SINGLE_USER (0.20) from the computed factor.  This biases the
// rate limiter toward false positives (allowing requests) rather than false
// negatives (blocking them).  The user is the only one using the system —
// there is no contention to protect against.

const LOAD_BIAS_SINGLE_USER = 0.20

let loadLevelCache: { factor: number; at: number } | null = null
const LOAD_LEVEL_CACHE_TTL = 60_000

/**
 * Get the current system load factor.
 *
 * Cached per-isolate for 60s. When stale, recomputes from local error rate +
 * request rate, then lazily writes the raw factor to KV so other isolates can
 * observe it (via the KV key "free:load_factor"). The write is fire-and-forget
 * via ctx.waitUntil() — no latency impact on the current request.
 */
export async function getLoadLevel(
  kv: KVNamespace,
  ctx: ExecutionContext,
): Promise<LoadFactorConfig> {
  const now = Date.now()
  if (loadLevelCache && now - loadLevelCache.at < LOAD_LEVEL_CACHE_TTL) {
    return computeLoadConfig(loadLevelCache.factor)
  }

  // Compute from local signals (EWMA error rate, no more broken halving bias)
  const errorRate = computeLocalErrorRate()
  const requestRate = freeGlobalLoad()
  const rawFactor = Math.min(1, Math.max(0,
    0.6 * (errorRate / 0.5) + 0.4 * (requestRate / FREE_GLOBAL_SOFT_RPM)
  ))
  // Single-user bias: subtract to favor allowing over blocking.
  // Negative load factor stays green; positive but low stays green longer.
  const factor = Math.max(0, rawFactor - LOAD_BIAS_SINGLE_USER)

  // Write to KV in background (fire-and-forget, TTL 120s so transient spikes
  // don't linger, but stale values persist long enough for other isolates)
  ctx.waitUntil(
    kv.put("free:load_factor", String(factor), { expirationTtl: 120 })
      .catch(() => {}),
  )

  loadLevelCache = { factor, at: now }
  return computeLoadConfig(factor)
}

/**
 * Invalidate the local load-level cache (used when static config forces a reset).
 * Primarily for tests and manual admin operations.
 */
export function invalidateLoadLevelCache(): void {
  loadLevelCache = null
}
