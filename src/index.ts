import type { AnalyticsEvent } from "./types"
// The OmniRouteContainer class is defined in src/container.ts and re-exported
// here because the wrangler config references it by name. The class is
// INSTANTIATED only inside the warm Worker (which owns the container app);
// the proxy Worker only references the type for env typing.
export { OmniRouteContainer } from "./container"
import type { OmniRouteContainer } from "./container"
export { FreeUsageDO } from "./free-usage-do"
import type { FreeUsageDO } from "./free-usage-do"

const OPENROUTER_URL = "https://openrouter.ai/api"
const AIHUBMIX_URL = "https://aihubmix.com"
const AIHUBMIX_FALLBACK_URL = "https://api.inferera.com"
const AIHUBMIX_URLS = [AIHUBMIX_URL, AIHUBMIX_FALLBACK_URL]
const CLOUDFLARE_URL_FALLBACK = "https://api.cloudflare.com/client/v4/accounts/_cf_account_missing_/ai/v1"

function cloudflareBaseURL(env: Env): string {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  if (!account) return CLOUDFLARE_URL_FALLBACK
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/v1`
}
const PAYPAL_LIVE = "https://api-m.paypal.com"
const PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com"

interface Env {
  OPENROUTER_KEY?: string
  OPENROUTER_KEYS?: string       // comma-separated pool of API keys for rotation
  OMNIRoute_KEY?: string
  OMNIRoute_KEYS?: string        // comma-separated pool of API keys for rotation
  AIHUBMIX_KEY?: string
  AIHUBMIX_KEYS?: string         // comma-separated pool of API keys for rotation
  CLOUDFLARE_KEY?: string
  CLOUDFLARE_KEYS?: string      // comma-separated pool of Cloudflare API tokens (Workers AI: Read)
  CLOUDFLARE_ACCOUNT_ID?: string  // Cloudflare account ID; required for Workers AI
  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  PAYPAL_SANDBOX?: string
  ARCANA_PROXY: KVNamespace
  ARCANA_LICENSE: KVNamespace
  ARCANA_PROXY_ANALYTICS?: AnalyticsEngineDataset
  EMAIL?: SendEmail
  TRIAL_ENABLED?: string
  MERCHANT_ID?: string
  PAYPAL_WEBHOOK_ID?: string
  ARCANA_ADMIN_KEY?: string
  ARCANA_ADMIN_KEYS?: string
  // The OmniRoute container app is owned by the warm Worker
  // (`arcana-omniroute-warm`). The proxy reaches it through a service
  // binding; the warm Worker exposes a single `omFetch` RPC that proxies
  // to the container. Optional so the type-check passes when the binding
  // is absent; the priority list is forced to ["openrouter"] when unset.
  OMNIRoute_WARM?: { omFetch: (req: Request) => Promise<Response> }
  OMNIRoute_WARM_QUEUE?: Queue
}

type Provider = "openrouter" | "omniroute" | "aihubmix" | "cloudflare"

function isProvider(value: unknown): value is Provider {
  return value === "openrouter" || value === "omniroute" || value === "aihubmix" || value === "cloudflare"
}

// --- OpenRouter API key pool (rotation + rate-limit cooldown) ---
interface KeyState {
  key: string
  cooldownUntil: number
  failures: number
}
let keyPool: KeyState[] = []
let keyPoolIndex = 0
const KEY_COOLDOWN_MS = 30000      // 30s after rate-limit or auth error
const KEY_MAX_FAILURES = 3          // eject key after 3 consecutive failures

function initKeyPool(env: Env): KeyState[] {
  if (keyPool.length > 0) return keyPool
  const raw = env.OPENROUTER_KEYS || env.OPENROUTER_KEY || ""
  const keys = raw.split(",").map(k => k.trim()).filter(Boolean)
  if (keys.length === 0) return []
  keyPool = keys.map(k => ({ key: k, cooldownUntil: 0, failures: 0 }))
  return keyPool
}

function getOpenRouterKey(env: Env): string | null {
  const pool = initKeyPool(env)
  if (pool.length === 0) return null
  const now = Date.now()
  // Try round-robin, skipping keys in cooldown
  for (let i = 0; i < pool.length; i++) {
    const idx = (keyPoolIndex + i) % pool.length
    const ks = pool[idx]
    if (now >= ks.cooldownUntil) {
      keyPoolIndex = (idx + 1) % pool.length
      return ks.key
    }
  }
  // All keys in cooldown — return the one with earliest recovery
  const best = pool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b)
  return best.key
}

function markKeyRateLimited(key: string): void {
  const ks = keyPool.find(k => k.key === key)
  if (!ks) return
  const now = Date.now()
  ks.failures++
  // Exponential backoff: 30s, 60s, 120s
  const backoff = KEY_COOLDOWN_MS * Math.pow(2, Math.min(ks.failures - 1, 3))
  ks.cooldownUntil = now + backoff
  if (ks.failures >= KEY_MAX_FAILURES) {
    ks.cooldownUntil = now + 5 * 60 * 1000  // 5-minute hard cooldown
  }
}

function markKeySuccess(key: string): void {
  const ks = keyPool.find(k => k.key === key)
  if (ks) ks.failures = 0
}
// --- end key pool ---

// --- OmniRoute key pool (same shape, separate instance) ---
let omniKeyPool: KeyState[] = []
let omniKeyPoolIndex = 0

function initOmniKeyPool(env: Env): KeyState[] {
  if (omniKeyPool.length > 0) return omniKeyPool
  const raw = env.OMNIRoute_KEYS || env.OMNIRoute_KEY || ""
  const keys = raw.split(",").map(k => k.trim()).filter(Boolean)
  if (keys.length === 0) return []
  omniKeyPool = keys.map(k => ({ key: k, cooldownUntil: 0, failures: 0 }))
  return omniKeyPool
}

function getOmniKey(env: Env): string | null {
  const pool = initOmniKeyPool(env)
  if (pool.length === 0) return null
  const now = Date.now()
  for (let i = 0; i < pool.length; i++) {
    const idx = (omniKeyPoolIndex + i) % pool.length
    const ks = pool[idx]
    if (now >= ks.cooldownUntil) {
      omniKeyPoolIndex = (idx + 1) % pool.length
      return ks.key
    }
  }
  const best = pool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b)
  return best.key
}

function markOmniKeyRateLimited(key: string): void {
  const ks = omniKeyPool.find(k => k.key === key)
  if (!ks) return
  const now = Date.now()
  ks.failures++
  const backoff = KEY_COOLDOWN_MS * Math.pow(2, Math.min(ks.failures - 1, 3))
  ks.cooldownUntil = now + backoff
  if (ks.failures >= KEY_MAX_FAILURES) {
    ks.cooldownUntil = now + 5 * 60 * 1000
  }
}

function markOmniKeySuccess(key: string): void {
  const ks = omniKeyPool.find(k => k.key === key)
  if (ks) ks.failures = 0
}
// --- end OmniRoute key pool ---

// --- AIHubMix key pool (OpenAI-compatible, default base with Inferera fallback) ---
let aiHubMixKeyPool: KeyState[] = []
let aiHubMixKeyPoolIndex = 0

function initAIHubMixKeyPool(env: Env): KeyState[] {
  if (aiHubMixKeyPool.length > 0) return aiHubMixKeyPool
  const raw = env.AIHUBMIX_KEYS || env.AIHUBMIX_KEY || ""
  const keys = raw.split(",").map(k => k.trim()).filter(Boolean)
  if (keys.length === 0) return []
  aiHubMixKeyPool = keys.map(k => ({ key: k, cooldownUntil: 0, failures: 0 }))
  return aiHubMixKeyPool
}

function getAIHubMixKey(env: Env): string | null {
  const pool = initAIHubMixKeyPool(env)
  if (pool.length === 0) return null
  const now = Date.now()
  for (let i = 0; i < pool.length; i++) {
    const idx = (aiHubMixKeyPoolIndex + i) % pool.length
    const ks = pool[idx]
    if (now >= ks.cooldownUntil) {
      aiHubMixKeyPoolIndex = (idx + 1) % pool.length
      return ks.key
    }
  }
  const best = pool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b)
  return best.key
}

function markAIHubMixKeyRateLimited(key: string): void {
  const ks = aiHubMixKeyPool.find(k => k.key === key)
  if (!ks) return
  const now = Date.now()
  ks.failures++
  const backoff = KEY_COOLDOWN_MS * Math.pow(2, Math.min(ks.failures - 1, 3))
  ks.cooldownUntil = now + backoff
  if (ks.failures >= KEY_MAX_FAILURES) {
    ks.cooldownUntil = now + 5 * 60 * 1000
  }
}

function markAIHubMixKeySuccess(key: string): void {
  const ks = aiHubMixKeyPool.find(k => k.key === key)
  if (ks) ks.failures = 0
}

// --- Cloudflare Workers AI key pool (token rotation, matches AIHubMix shape) ---
let cloudflareKeyPool: KeyState[] = []
let cloudflareKeyPoolIndex = 0

function initCloudflareKeyPool(env: Env): KeyState[] {
  if (cloudflareKeyPool.length > 0) return cloudflareKeyPool
  const raw = env.CLOUDFLARE_KEYS || env.CLOUDFLARE_KEY || ""
  const keys = raw.split(",").map(k => k.trim()).filter(Boolean)
  if (keys.length === 0) return []
  cloudflareKeyPool = keys.map(k => ({ key: k, cooldownUntil: 0, failures: 0 }))
  return cloudflareKeyPool
}

function getCloudflareKey(env: Env): string | null {
  const pool = initCloudflareKeyPool(env)
  if (pool.length === 0) return null
  const now = Date.now()
  for (let i = 0; i < pool.length; i++) {
    const idx = (cloudflareKeyPoolIndex + i) % pool.length
    const ks = pool[idx]
    if (now >= ks.cooldownUntil) {
      cloudflareKeyPoolIndex = (idx + 1) % pool.length
      return ks.key
    }
  }
  const best = pool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b)
  return best.key
}

function markCloudflareKeyRateLimited(key: string): void {
  const ks = cloudflareKeyPool.find(k => k.key === key)
  if (!ks) return
  const now = Date.now()
  ks.failures++
  const backoff = KEY_COOLDOWN_MS * Math.pow(2, Math.min(ks.failures - 1, 3))
  ks.cooldownUntil = now + backoff
  if (ks.failures >= KEY_MAX_FAILURES) {
    ks.cooldownUntil = now + 5 * 60 * 1000
  }
}

function markCloudflareKeySuccess(key: string): void {
  const ks = cloudflareKeyPool.find(k => k.key === key)
  if (ks) ks.failures = 0
}
// --- end Cloudflare key pool ---

async function fetchAIHubMix(path: string, init: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < AIHUBMIX_URLS.length; i++) {
    const baseURL = AIHUBMIX_URLS[i]!
    try {
      const response = await fetch(`${baseURL}${path}`, init)
      if (i === 0 && response.status >= 500) {
        await response.arrayBuffer().catch(() => undefined)
        continue
      }
      return response
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error("AIHubMix upstream unavailable")
}
// --- end AIHubMix key pool ---

// --- Provider priority list (KV-backed, env fallback) ---
// If the container binding is absent, force the priority list to ["openrouter"]
// so the new code is a no-op until the OmniRoute image is actually pushed.
let providerPriorityCache: Provider[] | null = null
let providerPriorityCacheTime = 0
const PROVIDER_PRIORITY_TTL = 60_000  // re-read KV at most once per minute per isolate

async function getProviderPriority(env: Env, ctx: ExecutionContext): Promise<Provider[]> {
  const now = Date.now()
  if (providerPriorityCache && now - providerPriorityCacheTime < PROVIDER_PRIORITY_TTL) {
    return providerPriorityCache
  }
  let list: Provider[] = ["openrouter"]  // safe default
  try {
    const raw = await env.ARCANA_PROXY.get("provider:priority", "json") as Provider[] | null
    if (Array.isArray(raw) && raw.length > 0) {
      // Whitelist: only allow known providers, drop everything else.
      const filtered = raw.filter(isProvider).filter((p) => p !== "omniroute" || Boolean(env.OMNIRoute_WARM))
      if (filtered.length > 0) list = filtered
    }
  } catch {}
  providerPriorityCache = list
  providerPriorityCacheTime = now
  return list
}

function resolveProvider(model: string, priority: Provider[]): { provider: Provider; model: string } | null {
  if (model.startsWith("omni/")) return { provider: "omniroute", model: model.slice(5) }
  if (model.startsWith("or/")) return { provider: "openrouter", model: model.slice(3) }
  if (model.startsWith("aihubmix/")) return { provider: "aihubmix", model: model.slice("aihubmix/".length) }
  if (model.startsWith("aihub/")) return { provider: "aihubmix", model: model.slice("aihub/".length) }
  if (model.startsWith("cf/")) return { provider: "cloudflare", model: model.slice(3) }
  if (model.startsWith("cloudflare/")) return { provider: "cloudflare", model: model.slice("cloudflare/".length) }
  for (const p of priority) return { provider: p, model }
  return null
}

// Throttled warm-up queue producer. Per-isolate, max one enqueue per 30s.
// Fires only on the cold path (first OmniRoute call after the binding sees
// traffic) so we don't spam the queue on warm instances.
let lastOmniWarmEnqueued = 0
const OMNI_WARM_THROTTLE_MS = 30_000
function maybeEnqueueOmniWarm(env: Env, ctx: ExecutionContext): void {
  if (!env.OMNIRoute_WARM_QUEUE) return
  const now = Date.now()
  if (now - lastOmniWarmEnqueued < OMNI_WARM_THROTTLE_MS) return
  lastOmniWarmEnqueued = now
  ctx.waitUntil(env.OMNIRoute_WARM_QUEUE.send({ kind: "warm", ts: now }).catch(() => {}))
}
// --- end provider priority ---

const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000
const SUBSCRIPTION_CREDITS = 500 // $5 worth of credits bundled with Pro

interface SendEmail {
  send(msg: {
    to: string | string[]
    from: { email: string; name?: string }
    subject: string
    html?: string
    text?: string
    cc?: string | string[]
    bcc?: string | string[]
    replyTo?: string
    headers?: Record<string, string>
  }): Promise<{ messageId: string }>
}

// Per-IP + per-user rate limiting
const ipLimits = new Map<string, { count: number; resetAt: number }>()
const userLimits = new Map<string, { count: number; resetAt: number }>()
const freeIpLimits = new Map<string, { count: number; resetAt: number }>()
const freeUserLimits = new Map<string, { count: number; resetAt: number }>()
const IP_RATE_LIMIT = 50
const USER_RATE_LIMIT = 25
const FREE_IP_RATE_LIMIT = 20
const FREE_USER_RATE_LIMIT = 8
const RATE_WINDOW = 60000

// Daily usage limits by tier
const DAILY_LIMITS: Record<string, number> = {
  free: 50,
  trial: 200,
  pro: 2000,
  team: 5000,
  enterprise: Infinity,
}

async function checkDailyLimit(userId: string, tier: string, kv: KVNamespace): Promise<{ allowed: boolean; remaining: number }> {
  const limit = DAILY_LIMITS[tier] ?? DAILY_LIMITS.free
  if (limit === Infinity) return { allowed: true, remaining: Infinity }
  const date = new Date().toISOString().split("T")[0]!
  // Never put a raw JWT/long id into a KV key (usage:daily:<id>:<date>).
  const subject = utf8Len(userId) > 80 ? (await sha256Hex(userId)).slice(0, 40) : userId
  const key = `usage:daily:${subject}:${date}`
  if (!kvKeyOk(key)) return { allowed: true, remaining: limit } // fail open rather than 500
  const current = parseInt((await kv.get(key)) ?? "0")
  if (current >= limit) return { allowed: false, remaining: 0 }
  const remaining = limit - current - 1
  // Increment in background (fire-and-forget, TTL to midnight UTC)
  const now = Date.now()
  const midnight = new Date(date + "T23:59:59Z").getTime()
  kv.put(key, String(current + 1), { expirationTtl: Math.ceil((midnight - now) / 1000) })
  return { allowed: true, remaining }
}

const FREE_SESSION_TURN_LIMIT = 10
const FREE_SESSION_DURATION_MS = 60 * 60 * 1000
const FREE_SESSION_RESET_MS = 7 * 24 * 60 * 60 * 1000
const FREE_TURN_PROVIDER_CALL_LIMIT = 2     // 2 provider dispatches per turn-id: original + one failover attempt on hard 5xx/429
const FREE_MAX_INPUT_TOKENS = 16_384           // ~16K raw input per turn (down from 32K)
const FREE_MAX_OUTPUT_TOKENS = 2_048           // ~2K output per turn (down from 4K); biggest single cost lever
const FREE_PROVIDER_ATTEMPT_LIMIT = 2          // unchanged
const FREE_WEEKLY_TOKEN_AGGREGATE = 200_000    // per-subject-key combined in+out cap; reset anchored to activated_at + 7d

type FreeUsageState = "eligible" | "active" | "exhausted" | "expired"
type FreeTurnStatus = "admitted" | "completed" | "failed"

interface FreeTurnReservation {
  admittedAt: number
  providerCalls: number
  status: FreeTurnStatus
  settledAt?: number
}

interface FreeUsageRecord {
  freeSessionId: string
  arcanaSessionKey: string
  activatedAt: number
  expiresAt: number
  resetAt: number
  turnsUsed: number
  tokensUsed: number                 // combined in+out tokens settled across this weekly record; reset anchored to resetAt
  reservations: Record<string, FreeTurnReservation>
}

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
  recordKey?: string
  turnKey?: string
  snapshot: FreeUsageSnapshot
}

function billableTier(tier: string): boolean {
  return tier !== "enterprise" && tier !== "free"
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function freeUsageTtl(record: FreeUsageRecord, now = Date.now()): number {
  return Math.max(60, Math.ceil((record.resetAt - now) / 1000) + 3600)
}

function freeUsageSnapshot(record: FreeUsageRecord | null, now = Date.now()): FreeUsageSnapshot {
  if (!record || now >= record.resetAt) return { state: "eligible", used: 0, remaining: FREE_SESSION_TURN_LIMIT, limit: FREE_SESSION_TURN_LIMIT, tokensUsed: 0, tokensLimit: FREE_WEEKLY_TOKEN_AGGREGATE, tokensRemaining: FREE_WEEKLY_TOKEN_AGGREGATE }
  const state: FreeUsageState = record.turnsUsed >= FREE_SESSION_TURN_LIMIT
    ? "exhausted"
    : record.tokensUsed >= FREE_WEEKLY_TOKEN_AGGREGATE
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

function freeUsageHeaders(snapshot?: FreeUsageSnapshot): Record<string, string> {
  if (!snapshot) return {}
  const headers: Record<string, string> = {
    "X-Arcana-Free-State": snapshot.state,
    "X-Arcana-Free-Used": String(snapshot.used),
    "X-Arcana-Free-Remaining": String(snapshot.remaining),
    "X-Arcana-Free-Limit": String(snapshot.limit),
    "X-Arcana-Free-Tokens-Used": String(snapshot.tokensUsed),
    "X-Arcana-Free-Tokens-Remaining": String(snapshot.tokensRemaining),
    "X-Arcana-Free-Tokens-Limit": String(snapshot.tokensLimit),
  }
  if (snapshot.expiresAt) headers["X-Arcana-Free-Expires-At"] = snapshot.expiresAt
  if (snapshot.resetAt) headers["X-Arcana-Free-Reset-At"] = snapshot.resetAt
  return headers
}

function freeTurnId(request: Request, body: any): string {
  return request.headers.get("x-arcana-turn-id")
    ?? request.headers.get("x-arcana-turn")
    ?? request.headers.get("x-arcana-request")
    ?? body?.metadata?.turn_id
    ?? body?.turn_id
    ?? crypto.randomUUID()
}

function freeConversationId(request: Request, body: any): string {
  return request.headers.get("x-arcana-session-id")
    ?? request.headers.get("x-arcana-session")
    ?? body?.metadata?.arcana_session_id
    ?? body?.metadata?.session_id
    ?? body?.session_id
    ?? "default"
}


function clampFreeRequestBody(body: any): any {
  const next = { ...body }
  if (Number(next.max_tokens) > FREE_MAX_OUTPUT_TOKENS) next.max_tokens = FREE_MAX_OUTPUT_TOKENS
  if (Number(next.max_completion_tokens) > FREE_MAX_OUTPUT_TOKENS) next.max_completion_tokens = FREE_MAX_OUTPUT_TOKENS
  if (next.max_tokens === undefined && next.max_completion_tokens === undefined) next.max_tokens = FREE_MAX_OUTPUT_TOKENS
  return next
}

async function readFreeUsageRecord(userId: string, kv: KVNamespace): Promise<{ key: string; record: FreeUsageRecord | null }> {
  const subject = (await sha256Hex(`free:${userId}`)).slice(0, 40)
  const key = `free_usage:${subject}`
  const raw = await kv.get(key, "json") as any
  if (!raw || typeof raw !== "object") return { key, record: null }
  return { key, record: { ...raw, reservations: raw.reservations ?? {} } as FreeUsageRecord }
}

async function reserveFreeTurn(request: Request, body: any, user: { id: string; tier: string }, inputTokens: number, kv: KVNamespace): Promise<FreeTurnAdmission> {
  const now = Date.now()
  const { key, record: stored } = await readFreeUsageRecord(user.id, kv)
  const sessionKey = (await sha256Hex(`session:${freeConversationId(request, body)}`)).slice(0, 40)
  const turnKey = (await sha256Hex(`turn:${freeTurnId(request, body)}`)).slice(0, 40)
  let record = stored && now < stored.resetAt ? stored : null
  if (!record) {
    record = {
      freeSessionId: `free_${crypto.randomUUID()}`,
      arcanaSessionKey: sessionKey,
      activatedAt: now,
      expiresAt: now + FREE_SESSION_DURATION_MS,
      resetAt: now + FREE_SESSION_RESET_MS,
      turnsUsed: 0,
      tokensUsed: 0,
      reservations: {},
    }
  }

  if (record.arcanaSessionKey !== sessionKey) {
    return {
      allowed: false,
      error: "free_session_conversation_mismatch",
      message: "This free session is already bound to another Arcana conversation.",
      snapshot: freeUsageSnapshot(record, now),
    }
  }

  const existing = record.reservations[turnKey]
  if (existing) {
    if (existing.providerCalls >= FREE_TURN_PROVIDER_CALL_LIMIT) {
      return {
        allowed: false,
        error: "free_turn_budget_reached",
        message: "This free turn reached its internal provider-call limit.",
        snapshot: freeUsageSnapshot(record, now),
      }
    }
    existing.providerCalls++
    await kv.put(key, JSON.stringify(record), { expirationTtl: freeUsageTtl(record, now) })
    return { allowed: true, recordKey: key, turnKey, snapshot: freeUsageSnapshot(record, now) }
  }

  // Weekly aggregate: reject up front if admitting this turn would obviously push tokens over the cap.
  // (provider-call token accounting happens at settle, so this is a cheap guard against the worst case.)
  if (record.tokensUsed + inputTokens > FREE_WEEKLY_TOKEN_AGGREGATE) {
    return {
      allowed: false,
      error: "free_weekly_token_limit_reached",
      message: `This free week's token allowance is used up. Weekly limit: ${FREE_WEEKLY_TOKEN_AGGREGATE.toLocaleString("en")} combined in+out tokens. Resets at ${new Date(record.resetAt).toISOString()}.`,
      snapshot: freeUsageSnapshot(record, now),
    }
  }
  if (inputTokens > FREE_MAX_INPUT_TOKENS) {
    return {
      allowed: false,
      error: "free_turn_budget_reached",
      message: `Free turns are limited to about ${FREE_MAX_INPUT_TOKENS.toLocaleString("en")} input tokens. Output is capped at ${FREE_MAX_OUTPUT_TOKENS.toLocaleString("en")} tokens.`,
      snapshot: freeUsageSnapshot(record, now),
    }
  }
  if (now >= record.expiresAt) {
    return {
      allowed: false,
      error: "free_session_expired",
      message: "The one-hour free session has ended.",
      snapshot: freeUsageSnapshot(record, now),
    }
  }
  if (record.turnsUsed >= FREE_SESSION_TURN_LIMIT) {
    return {
      allowed: false,
      error: "free_turn_limit_reached",
      message: "The free session has used all 10 turns.",
      snapshot: freeUsageSnapshot(record, now),
    }
  }

  record.turnsUsed++
  record.reservations[turnKey] = { admittedAt: now, providerCalls: 1, status: "admitted" }
  await kv.put(key, JSON.stringify(record), { expirationTtl: freeUsageTtl(record, now) })
  return { allowed: true, recordKey: key, turnKey, snapshot: freeUsageSnapshot(record, now) }
}

async function settleFreeTurn(admission: FreeTurnAdmission | undefined, status: "completed" | "failed", kv: KVNamespace, tokensIn: number = 0, tokensOut: number = 0): Promise<void> {
  if (!admission?.allowed || !admission.recordKey || !admission.turnKey) return
  const record = await kv.get(admission.recordKey, "json") as FreeUsageRecord | null
  const turn = record?.reservations?.[admission.turnKey]
  if (!record || !turn) return
  turn.status = status
  turn.settledAt = Date.now()
  // Aggregate token accounting. Only count completed turns toward the weekly cap;
  // failed turns consumed a provider dispatch but the user received no useful output,
  // and we don't want a flaky upstream to silently drain the free allowance.
  if (status === "completed") {
    const delta = Math.max(0, tokensIn) + Math.max(0, tokensOut)
    // Hard clamp to the weekly cap — last-write-wins, KV is eventually consistent.
    record.tokensUsed = Math.min(FREE_WEEKLY_TOKEN_AGGREGATE, record.tokensUsed + delta)
  }
  await kv.put(admission.recordKey, JSON.stringify(record), { expirationTtl: freeUsageTtl(record) })
}

async function getFreeUsageCurrent(user: { id: string; tier: string }, env: Env, cors: Record<string, string>): Promise<Response> {
  if (user.tier !== "free") return json({ state: "licensed", limit: null, used: 0, remaining: null }, 200, cors)
  const { record } = await readFreeUsageRecord(user.id, env.ARCANA_PROXY)
  const snapshot = freeUsageSnapshot(record)
  return json(snapshot, 200, { ...cors, ...freeUsageHeaders(snapshot) })
}

// License cache
let cleanupCounter = 0
let licenseCache: Map<string, { id: string; tier: string }> | null = null
let licenseCacheTime = 0
const LICENSE_CACHE_TTL = 300000

// Supabase JWT verification
const SUPABASE_JWKS_URL = "https://ndaejikkbckaeygtruwl.supabase.co/auth/v1/.well-known/jwks.json"
let jwksCache: { keys: any[] } | null = null
let jwksCacheTime = 0
const JWKS_CACHE_TTL = 3_600_000
let ecdsaKeyCache: { kid: string; key: CryptoKey } | null = null

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/")
  while (str.length % 4) str += "="
  return Uint8Array.from(atob(str), c => c.charCodeAt(0))
}

function b64decode(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/")
  while (s.length % 4) s += "="
  return atob(s)
}

async function verifySupabaseJWT(token: string): Promise<{ sub: string; email: string } | null> {
  if (!token.startsWith("eyJ")) return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  let header: any
  try { header = JSON.parse(b64decode(parts[0])) } catch { return null }
  if (header.alg !== "ES256") return null
  const now = Date.now()
  if (!jwksCache || now - jwksCacheTime > JWKS_CACHE_TTL) {
    const r = await fetch(SUPABASE_JWKS_URL)
    if (!r.ok) return null
    jwksCache = await r.json() as any
    jwksCacheTime = now
    ecdsaKeyCache = null
  }
  const jwk = (jwksCache?.keys ?? []).find((k: any) => k.kid === header.kid && k.alg === "ES256")
  if (!jwk) return null
  try {
    if (!ecdsaKeyCache || ecdsaKeyCache.kid !== header.kid) {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
      ecdsaKeyCache = { kid: header.kid, key }
    }
    const data = new TextEncoder().encode(parts[0] + "." + parts[1])
    const sig = base64urlDecode(parts[2])
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecdsaKeyCache.key, sig, data)
    if (!valid) return null
  } catch { return null }
  let payload: any
  try { payload = JSON.parse(b64decode(parts[1])) } catch { return null }
  if (payload.exp && payload.exp * 1000 < now) return null
  if (payload.aud !== "authenticated") return null
  return { sub: payload.sub, email: payload.email || "" }
}

/** Cloudflare KV rejects keys longer than 512 UTF-8 bytes (error 414). */
const KV_KEY_MAX_BYTES = 512

function utf8Len(s: string): number {
  // TextEncoder is available in Workers; length in bytes, not JS string length.
  return new TextEncoder().encode(s).length
}

function kvKeyOk(key: string): boolean {
  return utf8Len(key) <= KV_KEY_MAX_BYTES
}

/** Safe KV get — never calls KV with an oversized key (returns null instead of 500). */
async function kvGetJson<T = unknown>(kv: KVNamespace, key: string): Promise<T | null> {
  if (!kvKeyOk(key)) {
    console.error(`[kv] refused GET: key is ${utf8Len(key)} bytes (max ${KV_KEY_MAX_BYTES}): ${key.slice(0, 48)}…`)
    return null
  }
  return (await kv.get(key, "json")) as T | null
}

async function kvPutJson(kv: KVNamespace, key: string, value: unknown, options?: KVNamespacePutOptions): Promise<boolean> {
  if (!kvKeyOk(key)) {
    console.error(`[kv] refused PUT: key is ${utf8Len(key)} bytes (max ${KV_KEY_MAX_BYTES}): ${key.slice(0, 48)}…`)
    return false
  }
  await kv.put(key, JSON.stringify(value), options)
  return true
}

function listAdminKeys(env?: Env): string[] {
  if (!env) return []
  const raw = (env.ARCANA_ADMIN_KEYS || env.ARCANA_ADMIN_KEY || "").trim()
  if (!raw) return []
  return raw.split(",").map((k) => k.trim()).filter(Boolean)
}

async function getUser(auth: string | null, kv: KVNamespace, ctx: ExecutionContext, env?: Env): Promise<{ id: string; tier: string } | null> {
  if (!auth || !auth.startsWith("Bearer ")) return null
  const key = auth.slice(7).trim()
  if (!key) return null
  const now = Date.now()

  // ── 1. Admin keys FIRST ──────────────────────────────────────────────
  // Defense-in-depth: never use the raw bearer as a KV key for admins.
  // (A 44-char admin key makes license:<key> only ~52 bytes — well under the
  // CF 512-byte limit. The historical 999-byte 414 was license: + ~991-byte
  // bearer, i.e. a JWT/opaque token reaching this path, not a short admin key.)
  const adminKeys = listAdminKeys(env)
  if (adminKeys.includes(key)) {
    return { id: "Admin", tier: "enterprise" }
  }

  // Diagnose oversize bearers without logging secrets.
  const bearerBytes = utf8Len(key)
  if (bearerBytes > 400) {
    console.error(
      `[getUser] long bearer: ${bearerBytes} bytes, ` +
        `license:key would be ${utf8Len(`license:${key}`)} bytes, ` +
        `startsWithEyJ=${key.startsWith("eyJ")}, parts=${key.split(".").length}`,
    )
  }

  // ── 2. Trial tokens — ephemeral ──────────────────────────────────────
  if (key.startsWith("trial_")) {
    if (!env?.TRIAL_ENABLED || env.TRIAL_ENABLED !== "true") return null
    const trialKey = `trial:${key}`
    if (!kvKeyOk(trialKey)) return null
    const trial = await kvGetJson<any>(kv, trialKey)
    if (!trial) return null
    if (now > trial.expiresAt) {
      if (kvKeyOk(trialKey)) await kv.delete(trialKey)
      return null
    }
    return { id: `trial_${key.slice(6, 14)}`, tier: "pro" }
  }

  // ── 3. JWT — store only by short subject id, never by raw token ───────
  if (key.startsWith("eyJ") && key.split(".").length === 3) {
    const jwtUser = await verifySupabaseJWT(key)
    if (jwtUser) {
      let sbUser = licenseCache?.get("sb:" + jwtUser.sub)
      if (sbUser) return sbUser
      const accountKey = `account:${jwtUser.sub}`
      const stored = await kvGetJson<any>(kv, accountKey)
      if (stored) {
        sbUser = { id: jwtUser.sub, tier: stored.tier || "free" }
        licenseCache?.set("sb:" + jwtUser.sub, sbUser)
        return sbUser
      }
      sbUser = { id: jwtUser.sub, tier: "free" }
      ctx.waitUntil(kvPutJson(kv, accountKey, { username: jwtUser.email, tier: "free" }).then(() => undefined))
      licenseCache?.set("sb:" + jwtUser.sub, sbUser)
      return sbUser
    }
    // Invalid JWT — do not fall through into license:${jwt} (key too long).
    return null
  }

  // ── 4. Short license / account keys only ─────────────────────────────
  // Opaque tokens that would make license:<token> exceed 512 bytes must never
  // touch KV. 999-byte failures are exactly license: (8) + 991-byte bearer.
  const licenseKvKey = `license:${key}`
  if (!kvKeyOk(licenseKvKey)) {
    console.error(
      `[getUser] refusing license: KV for ${bearerBytes}-byte bearer ` +
        `(license:key = ${utf8Len(licenseKvKey)} bytes). Not a short license key.`,
    )
    return null
  }

  if (!licenseCache || now - licenseCacheTime > LICENSE_CACHE_TTL) {
    licenseCache = new Map()
    licenseCacheTime = now
  }
  let user = licenseCache.get(key)
  if (user) return user

  const raw = await kvGetJson<any>(kv, licenseKvKey)
  if (raw) {
    // Normalize to {id, tier} — never promote raw blobs as user.id if missing.
    const normalized = {
      id: String(raw.id ?? raw.email ?? key.slice(0, 12)),
      tier: String(raw.tier ?? "free"),
    }
    licenseCache.set(key, normalized)
    return normalized
  }
  // Workers Cache API — globally replicated, sub-10ms reads.
  {
    const cache = caches.default
    const cacheUrl = `https://arcana-proxy/license/${encodeURIComponent(key)}`
    const cached = await cache.match(cacheUrl)
    if (cached) {
      user = (await cached.json()) as { id: string; tier: string }
      licenseCache.set(key, user)
      ctx.waitUntil(kvPutJson(kv, licenseKvKey, user).then(() => undefined))
      return user
    }
  }

  const accountKvKey = `account:${key}`
  if (kvKeyOk(accountKvKey)) {
    const account = await kvGetJson<any>(kv, accountKvKey)
    if (account) {
      user = { id: account.username ?? account.email ?? "user", tier: "free" }
      licenseCache.set(key, user)
      return user
    }
  }

  // Fallback: validate against license server (handles cross-KV namespace).
  // Only for short keys (already gated by licenseKvKey length).
  try {
    const res = await fetch(`https://arcana-license-server.lejzerv.workers.dev/api/license/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: key, machineId: `proxy-${key.slice(0, 8)}` }),
      signal: AbortSignal.timeout(5000),
    })
    const body = await res.json() as any
    // The license server signs responses as { data, signature }; unsigned
    // deployments return the payload flat. Handle both shapes.
    const data = body?.data ?? body
    if (data?.valid) {
      user = { id: key.slice(0, 12), tier: data.tier ?? "free" }
      licenseCache.set(key, user)
      ctx.waitUntil(kvPutJson(kv, licenseKvKey, user).then(() => undefined))
      const cacheUrl = `https://arcana-proxy/license/${encodeURIComponent(key)}`
      const cachedRes = new Response(JSON.stringify(user))
      cachedRes.headers.set("Cache-Control", "max-age=86400")
      ctx.waitUntil(caches.default.put(cacheUrl, cachedRes))
      return user
    }
  } catch {}
  return null
}

function checkRateLimit(key: string, map: Map<string, { count: number; resetAt: number }>, limit: number): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const entry = map.get(key)
  if (!entry || now > entry.resetAt) { map.set(key, { count: 1, resetAt: now + RATE_WINDOW }); return { allowed: true, remaining: limit - 1 } }
  if (entry.count >= limit) return { allowed: false, remaining: 0 }
  entry.count++
  return { allowed: true, remaining: limit - entry.count }
}

async function getPayPalToken(env: Env): Promise<string> {
  const mode = env.PAYPAL_SANDBOX === "true" ? "sandbox" : "live"
  const base = env.PAYPAL_SANDBOX === "true" ? PAYPAL_SANDBOX : PAYPAL_LIVE
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new Error(`paypal token: missing PAYPAL_CLIENT_ID/SECRET (mode=${mode})`)
  }
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  })
  const data = (await res.json()) as any
  if (!data.access_token) {
    // Surface the real cause (e.g. invalid_client = sandbox creds against the live
    // endpoint, or a wrong secret). Credentials themselves are never logged.
    throw new Error(
      `paypal token failed (HTTP ${res.status}, mode=${mode}): ${data.error ?? ""} ${data.error_description ?? ""}`.trim(),
    )
  }
  return data.access_token
}

function paypalBase(env: Env): string {
  return env.PAYPAL_SANDBOX === "true" ? PAYPAL_SANDBOX : PAYPAL_LIVE
}

const PRICING = {
  cheap: { input: 0.0000003, output: 0.0000011 },
  mid: { input: 0.000003, output: 0.00001 },
  premium: { input: 0.000005, output: 0.00002 },
  ultra: { input: 0.00003, output: 0.00006 },
}

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const m = model.toLowerCase()
  let rate = PRICING.mid
  if (m.includes("deepseek") || m.includes("qwen") || m.includes("mistral") || m.includes("gemma")) rate = PRICING.cheap
  else if (m.includes("gpt-4o-mini") || m.includes("gemini-flash") || m.includes("claude-haiku")) rate = PRICING.mid
  else if (m.includes("claude-sonnet") || m.includes("gpt-4o") || m.includes("gpt-5")) rate = PRICING.premium
  else if (m.includes("claude-opus")) rate = PRICING.ultra
  return (tokensIn * rate.input + tokensOut * rate.output) * 1.4
}

async function getBalance(userId: string, kv: KVNamespace): Promise<number> {
  const raw = await kv.get(`balance:${userId}`, "json") as any
  return raw?.credits ?? 0
}

async function deductBalance(userId: string, cost: number, kv: KVNamespace): Promise<void> {
  // Read-write with optimistic locking via KV put (last write wins — acceptable for this scale)
  const raw = await kv.get(`balance:${userId}`, "json") as any
  const current = raw?.credits ?? 0
  await kv.put(`balance:${userId}`, JSON.stringify({ credits: Math.max(0, current - cost), updatedAt: Date.now() }))
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown"
    const origin = request.headers.get("Origin") || ""
    const allowedOrigin = origin === "https://arcana.otnelhq.com" || /^https?:\/\/localhost(:\d+)?$/.test(origin)
      ? origin
      : "https://arcana.otnelhq.com"
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Arcana-Request, X-Arcana-Turn, X-Arcana-Turn-Id, X-Arcana-Session, X-Arcana-Session-Id",
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

    // Reject request bodies larger than 1MB
    const contentLength = request.headers.get("content-length")
    if (contentLength && parseInt(contentLength) > 1_048_576) {
      return json({ error: "payload_too_large", message: "Request body exceeds 1MB limit" }, 413, corsHeaders)
    }

    // Periodic cleanup of rate limit maps (every 100 requests instead of setInterval)
    cleanupCounter++
    if (cleanupCounter % 100 === 0) {
      const now = Date.now()
      for (const [key, val] of ipLimits.entries()) { if (now > val.resetAt) ipLimits.delete(key) }
      for (const [key, val] of userLimits.entries()) { if (now > val.resetAt) userLimits.delete(key) }
      for (const [key, val] of freeIpLimits.entries()) { if (now > val.resetAt) freeIpLimits.delete(key) }
      for (const [key, val] of freeUserLimits.entries()) { if (now > val.resetAt) freeUserLimits.delete(key) }
    }

    // IP-based rate limiting (all endpoints)
    const ipRl = checkRateLimit(clientIp, ipLimits, IP_RATE_LIMIT)
    if (!ipRl.allowed) return json({ error: "rate_limited", message: "IP rate limit exceeded: 50 req/min" }, 429, corsHeaders)

    try {
      // Public endpoints (IP rate limit only)
      if (url.pathname === "/v1/identity/validate-email") return handleValidateEmail(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/create-order") return handleCreateOrder(request, env, ctx, corsHeaders)
      if (url.pathname === "/v1/pay/capture-order") return handleCaptureOrder(request, env, ctx, corsHeaders)
      if (url.pathname === "/v1/pay/capture-return") return handleCaptureReturn(request, env, ctx, corsHeaders)
      if (url.pathname === "/v1/pay/webhook") return handlePayPalWebhook(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/setup-plans") return handleSetupPlans(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/create-sub") return handleCreateSub(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/sub-status") return handleSubStatus(request, env, corsHeaders)
      if (url.pathname === "/v1/trial/start") return handleTrialStart(request, env, corsHeaders)

      // Admin endpoints — admin key only; never route through getUser/license KV
      // (long admin secrets used to throw KV 414 before adminAuthorized ran).
      if (url.pathname.startsWith("/v1/admin/")) {
        if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, 401, corsHeaders)
        if (url.pathname === "/v1/admin/providers") {
          if (request.method === "GET") return handleAdminGetProviders(env, corsHeaders)
          if (request.method === "PUT") return handleAdminSetProviders(request, env, ctx, corsHeaders)
          return json({ error: "method_not_allowed" }, 405, corsHeaders)
        }
        if (url.pathname === "/v1/admin/licenses") {
          if (request.method === "POST") return handleAdminMintLicense(request, env, corsHeaders)
          return json({ error: "method_not_allowed" }, 405, corsHeaders)
        }
        return json({ error: "not_found" }, 404, corsHeaders)
      }

      // Auth required
      const user = await getUser(request.headers.get("Authorization"), env.ARCANA_PROXY, ctx, env)
      if (!user) return json({ error: "unauthorized" }, 401, corsHeaders)

      // User rate limiting (per-minute)
      const userRl = checkRateLimit(user.id, userLimits, USER_RATE_LIMIT)
      if (!userRl.allowed) return json({ error: "rate_limited", message: "25 req/min per user" }, 429, corsHeaders)
      if (user.tier === "free") {
        const freeIpRl = checkRateLimit(`free:${clientIp}`, freeIpLimits, FREE_IP_RATE_LIMIT)
        if (!freeIpRl.allowed) return json({ error: "rate_limited", message: "Free IP burst limit exceeded: 20 req/min" }, 429, corsHeaders)
        const freeUserRl = checkRateLimit(`free:${user.id}`, freeUserLimits, FREE_USER_RATE_LIMIT)
        if (!freeUserRl.allowed) return json({ error: "rate_limited", message: "Free user burst limit exceeded: 8 req/min" }, 429, corsHeaders)
      }

      // Daily usage limit (per-tier)
      if (user.tier !== "enterprise") {
        const daily = await checkDailyLimit(user.id, user.tier, env.ARCANA_PROXY)
        if (!daily.allowed) {
          return json({
            error: "daily_limit_reached",
            message: user.tier === "free"
              ? "Daily limit reached (50 requests). Upgrade to Pro for 2,000/day."
              : "Daily limit reached. Upgrade your plan for more capacity.",
            remaining: 0,
          }, 429, corsHeaders)
        }
        // Add remaining quota to response headers for all requests below
        if (daily.remaining < 50) {
          corsHeaders["X-RateLimit-Remaining"] = String(daily.remaining)
        }
      }

      // Match /v1/sessions/:uuid before the switch
      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([a-f0-9-]+)$/)
      if (sessionMatch && request.method === "GET") {
        return handleGetSessionDetail(sessionMatch[1], user, env, corsHeaders)
      }

      switch (url.pathname) {
        case "/v1/chat/completions":
        case "/v1/embeddings":
          return proxyWithFailover(request, env, user, corsHeaders, url.pathname, ctx)
        case "/v1/models":
          return listModels(env, corsHeaders)
        case "/v1/usage":
          return getUserUsage(user, env, corsHeaders)
        case "/v1/free-usage/sessions/current":
          if (request.method === "GET") return getFreeUsageCurrent(user, env, corsHeaders)
          return json({ error: "method_not_allowed" }, 405, corsHeaders)
        case "/v1/balance":
          return handleGetBalance(user, env, corsHeaders)
        case "/v1/send-receipt":
          return handleSendTestReceipt(request, env, user, corsHeaders)
        case "/v1/auth/resolve-email":
          return handleResolveEmail(request, env, corsHeaders)
        case "/v1/sessions":
          if (request.method === "GET") return handleGetSessions(request, user, env, corsHeaders)
          return json({ error: "method_not_allowed" }, 405, corsHeaders)
        case "/v1/purchases":
          if (request.method === "GET") return handleGetPurchases(user, env, corsHeaders)
          return json({ error: "method_not_allowed" }, 405, corsHeaders)
        case "/v1/profile":
          if (request.method === "GET") return handleGetProfile(user, env, corsHeaders)
          if (request.method === "PUT") return handlePutProfile(request, user, env, corsHeaders)
          return json({ error: "method_not_allowed" }, 405, corsHeaders)
        case "/v1/health":
          return json({ status: "ok", service: "arcana-proxy", user: user.id, tier: user.tier }, 200, corsHeaders)
        default:
          return json({ error: "not_found" }, 404, corsHeaders)
      }
    } catch (e) {
      console.error(e)
      return json({ error: "internal_error", message: String(e) }, 500, corsHeaders)
    }
  },
}

async function proxyOpenRouter(request: Request, env: Env, user: { id: string; tier: string }, cors: Record<string, string>, path: string, ctx: ExecutionContext): Promise<Response> {
  let body = await request.json() as any
  if (!body.model) return json({ error: "model_required" }, 400, cors)

  // Estimate max cost from actual request size and pre-deduct
  const inputTokens = body.messages?.reduce((a: number, m: any) => a + (m.content?.length ?? 0) / 4, 0) ?? 500
  const maxCost = estimateCost(body.model, Math.min(inputTokens, 128000), 2000)
  const margin = 1.4

  // Acquire lock to prevent race conditions on balance — nonce-based CAS removes TOCTOU
  const lockKey = `lock:${user.id}`
  const lockValue = crypto.randomUUID()
  await env.ARCANA_PROXY.put(lockKey, lockValue, { expirationTtl: 60 })
  const currentLock = await env.ARCANA_PROXY.get(lockKey)
  if (currentLock !== lockValue && user.tier !== "enterprise") {
    return json({ error: "too_many_requests", message: "A previous request is still processing." }, 429, cors)
  }
  const releaseLock = async () => {
    try {
      const current = await env.ARCANA_PROXY.get(lockKey)
      if (current === lockValue) await env.ARCANA_PROXY.delete(lockKey)
    } catch {}
  }

  let freeAdmission: FreeTurnAdmission | undefined
  const responseHeaders = () => ({ ...cors, ...freeUsageHeaders(freeAdmission?.snapshot) })
  try {
    if (user.tier === "free") {
      freeAdmission = await reserveFreeTurn(request, body, user, inputTokens, env.ARCANA_PROXY)
      if (!freeAdmission.allowed) {
        await releaseLock()
        return json({ error: freeAdmission.error, message: freeAdmission.message, freeUsage: freeAdmission.snapshot }, 429, responseHeaders())
      }
      body = clampFreeRequestBody(body)
    } else if (billableTier(user.tier)) {
      const balance = await getBalance(user.id, env.ARCANA_PROXY)
      if (balance < maxCost) { await releaseLock(); return json({ error: "insufficient_balance", message: "Add credits via arcana proxy buy", balance, required: Math.round(maxCost) }, 402, cors) }
      await deductBalance(user.id, maxCost, env.ARCANA_PROXY)
    }
  } catch { await releaseLock(); throw new Error("lock error") }

  const openRouterKey = getOpenRouterKey(env)
  if (!openRouterKey) {
    ctx.waitUntil(settleFreeTurn(freeAdmission, "failed", env.ARCANA_PROXY))
    await releaseLock()
    return json({ error: "no_api_key", message: "No OpenRouter API key configured" }, 500, responseHeaders())
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${openRouterKey}`,
    "HTTP-Referer": "https://arcana.otnelhq.com",
    "X-Title": "arcana",
  })
  if (body.model) body.user = user.id

  // Cloudflare (Workers AI) is wired as a *secondary* dispatch behind the cf/ or cloudflare/ prefix.
  // The provider priority list is a *failover* list, not a routing list — bare model names go to the
  // first provider in the list (openrouter today). Use the prefix to opt into cloudflare explicitly.
  const cfPrefixed = typeof body.model === "string" && (body.model.startsWith("cf/") || body.model.startsWith("cloudflare/"))
  if (cfPrefixed) body.model = body.model.replace(/^cloudflare\//, "").replace(/^cf\//, "")
  const startTime = Date.now()
  const isStream = body.stream === true
  let response: Response
  if (cfPrefixed) {
    const cfKey = getCloudflareKey(env)
    if (!cfKey || !env.CLOUDFLARE_ACCOUNT_ID) {
      ctx.waitUntil(settleFreeTurn(freeAdmission, "failed", env.ARCANA_PROXY))
      await releaseLock()
      return json({ error: "no_api_key", message: "No Cloudflare account ID or API token configured" }, 500, responseHeaders())
    }
    const cfHeaders = new Headers({ "Content-Type": "application/json", Authorization: `Bearer ${cfKey}` })
    response = await fetch(`${cloudflareBaseURL(env)}${path}`, { method: "POST", headers: cfHeaders, body: JSON.stringify(body) })
    if (!response.ok && (response.status === 429 || response.status === 401)) markCloudflareKeyRateLimited(cfKey)
  } else {
    response = await fetch(`${OPENROUTER_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
  }

  if (!response.ok) {
    if (response.status === 429 || response.status === 401) markKeyRateLimited(openRouterKey)
    if (billableTier(user.tier)) await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
    ctx.waitUntil(settleFreeTurn(freeAdmission, "failed", env.ARCANA_PROXY))
    await releaseLock()
    const errorBody = await response.text()
    return json({ error: "upstream_error", message: errorBody.slice(0, 100) }, response.status, responseHeaders())
  }
  markKeySuccess(openRouterKey)

  const adjustBalance = async (tokensIn: number, tokensOut: number, openRouterCost?: number) => {
    const actualCost = openRouterCost ?? estimateCost(body.model, tokensIn, tokensOut)
    if (billableTier(user.tier)) {
      const refund = maxCost - actualCost
      if (refund > 0) await deductBalance(user.id, -refund, env.ARCANA_PROXY)
    }
    if (env.ARCANA_PROXY_ANALYTICS) {
      env.ARCANA_PROXY_ANALYTICS.writeDataPoint({
        blobs: [user.id, body.model, user.tier, body.model],
        doubles: [tokensIn, tokensOut, actualCost * margin, Date.now() - startTime],
      })
    }
  }

  if (isStream && response.body) {
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullResponse = ""
    let streamFailed = false
    ;(async () => {
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; const chunk = decoder.decode(value, { stream: true }); fullResponse += chunk; await writer.write(value) }
      } catch { streamFailed = true } finally {
        await writer.close()
        const usage = extractUsage(fullResponse, body.model)
        if (usage) {
          adjustBalance(usage.inputTokens, usage.outputTokens, usage.totalCost)
          const sc = (usage.totalCost ?? estimateCost(body.model, usage.inputTokens, usage.outputTokens)) * margin * 100
          ctx.waitUntil(recordSession(user, body.model, "openrouter", usage.inputTokens, usage.outputTokens, sc, Date.now() - startTime, streamFailed ? "failed" : "completed", body.messages?.length ?? 0, env.ARCANA_PROXY))
          ctx.waitUntil(settleFreeTurn(freeAdmission, streamFailed ? "failed" : "completed", env.ARCANA_PROXY, streamFailed ? 0 : usage.inputTokens, streamFailed ? 0 : usage.outputTokens))
        }
        else if (streamFailed && billableTier(user.tier)) await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
        if (streamFailed) ctx.waitUntil(settleFreeTurn(freeAdmission, "failed", env.ARCANA_PROXY))
        await releaseLock()
      }
    })()
    return new Response(readable, { status: response.status, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...responseHeaders() } })
  }

  const data = await response.json() as any
  let tokensIn = 0, tokensOut = 0
  if (data.usage) {
    tokensIn = data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0
    tokensOut = data.usage.completion_tokens ?? data.usage.output_tokens ?? 0
    const openRouterCost = data.usage.total_cost // OpenRouter's actual cost in USD
    await adjustBalance(tokensIn, tokensOut, openRouterCost)
    const sc = (openRouterCost ?? estimateCost(body.model, tokensIn, tokensOut)) * margin * 100
    ctx.waitUntil(recordSession(user, body.model, "openrouter", tokensIn, tokensOut, sc, Date.now() - startTime, "completed", body.messages?.length ?? 0, env.ARCANA_PROXY))
  }
  ctx.waitUntil(settleFreeTurn(freeAdmission, "completed", env.ARCANA_PROXY, tokensIn, tokensOut))
  await releaseLock()
  return json(data, response.status, responseHeaders())
}

function extractUsage(responseText: string, model: string): { inputTokens: number; outputTokens: number; totalCost?: number } | null {
  try {
    const lines = responseText.split("\n").filter((l) => l.startsWith("data: "))
    const last = lines[lines.length - 1]
    if (!last || last === "data: [DONE]") return null
    const parsed = JSON.parse(last.slice(6))
    if (parsed.usage) return { inputTokens: parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? 0, totalCost: parsed.usage.total_cost }
    return null
  } catch { return null }
}

// --- Multi-provider failover wrapper ---
// Mirrors proxyOpenRouter's flow (lock, balance, upstream call, stream handling)
// but routes through the priority list with hard-failure failover. Bare model
// names walk the priority list; omni/<model> / or/<model> force a specific
// provider. proxyOpenRouter is unchanged.
async function proxyWithFailover(request: Request, env: Env, user: { id: string; tier: string }, cors: Record<string, string>, path: string, ctx: ExecutionContext): Promise<Response> {
  let body = await request.json() as any
  if (!body.model) return json({ error: "model_required" }, 400, cors)
  const requestedModel = String(body.model)

  const priority = await getProviderPriority(env, ctx)
  const resolved = resolveProvider(requestedModel, priority)
  if (!resolved) return json({ error: "no_provider_available" }, 503, cors)

  // Forced via prefix — run only that provider. Otherwise walk the list.
  const isForced = requestedModel.startsWith("omni/") || requestedModel.startsWith("or/") || requestedModel.startsWith("aihubmix/") || requestedModel.startsWith("aihub/")
  let attemptOrder: Provider[] = isForced ? [resolved.provider] : priority
  if (user.tier === "free" && !isForced && attemptOrder.length > FREE_PROVIDER_ATTEMPT_LIMIT) {
    attemptOrder = attemptOrder.slice(0, FREE_PROVIDER_ATTEMPT_LIMIT)
  }

  // Pre-flight: if all providers we might use are missing, fail fast.
  if (attemptOrder.includes("openrouter") && !getOpenRouterKey(env)) {
    if (attemptOrder.length === 1) return json({ error: "no_api_key", message: "No OpenRouter API key configured" }, 500, cors)
  }
  if (attemptOrder.includes("omniroute") && (!env.OMNIRoute_WARM || !getOmniKey(env))) {
    if (attemptOrder.length === 1) return json({ error: "no_api_key", message: "No OmniRoute key or container binding" }, 500, cors)
  }
  if (attemptOrder.includes("aihubmix") && !getAIHubMixKey(env)) {
    if (attemptOrder.length === 1) return json({ error: "no_api_key", message: "No AIHubMix API key configured" }, 500, cors)
  }
  if (attemptOrder.includes("cloudflare") && (!env.CLOUDFLARE_ACCOUNT_ID || !getCloudflareKey(env))) {
    if (attemptOrder.length === 1) return json({ error: "no_api_key", message: "No Cloudflare account ID or API token configured" }, 500, cors)
  }

  // Estimate max cost from the FIRST provider's model name. Cost is provider-
  // agnostic (it's a USD figure tied to the model), so we use the bare model
  // string for the estimate. Pre-deduct happens up front; refund on total fail.
  const inputTokens = body.messages?.reduce((a: number, m: any) => a + (m.content?.length ?? 0) / 4, 0) ?? 500
  const maxCost = estimateCost(resolved.model, Math.min(inputTokens, 128000), 2000)
  const margin = 1.4

  // Per-user lock (same pattern as proxyOpenRouter)
  const lockKey = `lock:${user.id}`
  const lockValue = crypto.randomUUID()
  await env.ARCANA_PROXY.put(lockKey, lockValue, { expirationTtl: 60 })
  const currentLock = await env.ARCANA_PROXY.get(lockKey)
  if (currentLock !== lockValue && user.tier !== "enterprise") {
    return json({ error: "too_many_requests", message: "A previous request is still processing." }, 429, cors)
  }
  const releaseLock = async () => {
    try {
      const current = await env.ARCANA_PROXY.get(lockKey)
      if (current === lockValue) await env.ARCANA_PROXY.delete(lockKey)
    } catch {}
  }

  let freeAdmission: FreeTurnAdmission | undefined
  const responseHeaders = () => ({ ...cors, ...freeUsageHeaders(freeAdmission?.snapshot) })
  try {
    if (user.tier === "free") {
      freeAdmission = await reserveFreeTurn(request, body, user, inputTokens, env.ARCANA_PROXY)
      if (!freeAdmission.allowed) {
        await releaseLock()
        return json({ error: freeAdmission.error, message: freeAdmission.message, freeUsage: freeAdmission.snapshot }, 429, responseHeaders())
      }
      body = clampFreeRequestBody(body)
    } else if (billableTier(user.tier)) {
      const balance = await getBalance(user.id, env.ARCANA_PROXY)
      if (balance < maxCost) { await releaseLock(); return json({ error: "insufficient_balance", message: "Add credits via arcana proxy buy", balance, required: Math.round(maxCost) }, 402, cors) }
      await deductBalance(user.id, maxCost, env.ARCANA_PROXY)
    }
  } catch { await releaseLock(); throw new Error("lock error") }

  const startTime = Date.now()
  let attemptedProviders: Provider[] = []
  let lastErrorStatus = 500
  let lastErrorBody = "no_attempt"

  for (const provider of attemptOrder) {
    attemptedProviders.push(provider)

    if (provider === "omniroute" && env.OMNIRoute_WARM) {
      maybeEnqueueOmniWarm(env, ctx)  // best-effort warm-up
    }

    let response: Response
    let providerKey: string | null = null
    let upstreamModel = resolved.model
    try {
      if (provider === "openrouter") {
        providerKey = getOpenRouterKey(env)
        if (!providerKey) { lastErrorStatus = 500; lastErrorBody = "no_openrouter_key"; continue }
        const headers = new Headers({
          "Content-Type": "application/json",
          Authorization: `Bearer ${providerKey}`,
          "HTTP-Referer": "https://arcana.otnelhq.com",
          "X-Title": "arcana",
        })
        const outbound = { ...body, model: upstreamModel, user: user.id }
        response = await fetch(`${OPENROUTER_URL}${path}`, { method: "POST", headers, body: JSON.stringify(outbound) })
      } else if (provider === "aihubmix") {
        providerKey = getAIHubMixKey(env)
        if (!providerKey) { lastErrorStatus = 500; lastErrorBody = "no_aihubmix_key"; continue }
        const headers = new Headers({
          "Content-Type": "application/json",
          Authorization: `Bearer ${providerKey}`,
        })
        const outbound = { ...body, model: upstreamModel, user: user.id }
        response = await fetchAIHubMix(path, { method: "POST", headers, body: JSON.stringify(outbound) })
      } else if (provider === "cloudflare") {
        providerKey = getCloudflareKey(env)
        if (!providerKey) { lastErrorStatus = 500; lastErrorBody = "no_cloudflare_key"; continue }
        const headers = new Headers({
          "Content-Type": "application/json",
          Authorization: `Bearer ${providerKey}`,
        })
        const outbound = { ...body, model: upstreamModel, user: user.id }
        response = await fetch(`${cloudflareBaseURL(env)}${path}`, { method: "POST", headers, body: JSON.stringify(outbound) })
      } else {
        providerKey = getOmniKey(env)
        if (!providerKey) { lastErrorStatus = 500; lastErrorBody = "no_omniroute_key"; continue }
        // OmniRoute is OpenAI-compatible. We can't talk to the container
        // directly because the container app is owned by the warm Worker
        // (Cloudflare Containers are 1:1 with their owning Worker). Instead
        // we send a service-binding RPC to the warm Worker, which forwards
        // to the container. The warm Worker exposes a single RPC method:
        //   omFetch(req: Request): Promise<Response>
        const headers = new Headers({
          "Content-Type": "application/json",
          Authorization: `Bearer ${providerKey}`,
        })
        const outbound = { ...body, model: upstreamModel, user: user.id }
        const innerReq = new Request(`https://omniroute.local${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(outbound),
        })
        response = await (env.OMNIRoute_WARM as { omFetch: (r: Request) => Promise<Response> }).omFetch(innerReq)
      }
    } catch (e) {
      // Network/timeout — treat as hard fail, try next.
      if (providerKey && provider === "openrouter") markKeyRateLimited(providerKey)
      if (providerKey && provider === "omniroute") markOmniKeyRateLimited(providerKey)
      if (providerKey && provider === "aihubmix") markAIHubMixKeyRateLimited(providerKey)
      if (providerKey && provider === "cloudflare") markCloudflareKeyRateLimited(providerKey)
      lastErrorStatus = 502
      lastErrorBody = `upstream_unreachable: ${String(e).slice(0, 80)}`
      console.error(`provider ${provider} fetch failed`, e)
      continue
    }

    // Hard-fail check: 5xx, 429, 401 → try next. Other 4xx = client bug, no failover.
    if (!response.ok) {
      const hardFail = response.status >= 500 || response.status === 429 || response.status === 401
      if (hardFail) {
        if (providerKey && provider === "openrouter") markKeyRateLimited(providerKey)
        if (providerKey && provider === "omniroute") markOmniKeyRateLimited(providerKey)
        if (providerKey && provider === "aihubmix") markAIHubMixKeyRateLimited(providerKey)
        if (providerKey && provider === "cloudflare") markCloudflareKeyRateLimited(providerKey)
        const errorBody = await response.text()
        lastErrorStatus = response.status
        lastErrorBody = errorBody.slice(0, 200)
        console.error(`provider ${provider} hard-fail`, response.status, errorBody.slice(0, 200))
        // Last provider in the list — don't loop forever.
        if (attemptedProviders.length >= attemptOrder.length) {
          if (billableTier(user.tier)) await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
          ctx.waitUntil(settleFreeTurn(freeAdmission, "failed", env.ARCANA_PROXY))
          await releaseLock()
          return json({ error: "upstream_error", provider, message: lastErrorBody }, lastErrorStatus, responseHeaders())
        }
        continue
      } else {
        // Client-side error (400, 404, etc.) — bubble up as-is, refund nothing.
        if (billableTier(user.tier)) await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
        ctx.waitUntil(settleFreeTurn(freeAdmission, "failed", env.ARCANA_PROXY))
        await releaseLock()
        const errorBody = await response.text()
        return json({ error: "upstream_error", provider, message: errorBody.slice(0, 200) }, response.status, responseHeaders())
      }
    }

    // Success path.
    if (providerKey && provider === "openrouter") markKeySuccess(providerKey)
    if (providerKey && provider === "omniroute") markOmniKeySuccess(providerKey)
    if (providerKey && provider === "aihubmix") markAIHubMixKeySuccess(providerKey)
    if (providerKey && provider === "cloudflare") markCloudflareKeySuccess(providerKey)

    const adjustBalance = async (tokensIn: number, tokensOut: number, upstreamCost?: number) => {
      const actualCost = upstreamCost ?? estimateCost(resolved.model, tokensIn, tokensOut)
      if (billableTier(user.tier)) {
        const refund = maxCost - actualCost
        if (refund > 0) await deductBalance(user.id, -refund, env.ARCANA_PROXY)
      }
      if (env.ARCANA_PROXY_ANALYTICS) {
        env.ARCANA_PROXY_ANALYTICS.writeDataPoint({
          blobs: [user.id, `${provider}:${resolved.model}`, user.tier, provider],
          doubles: [tokensIn, tokensOut, actualCost * margin, Date.now() - startTime],
        })
      }
    }

    const isStream = body.stream === true
    if (isStream && response.body) {
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fullResponse = ""
      let bytesStreamed = 0
      let streamFailed = false
      let failoverTriggered = false
      ;(async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytesStreamed += value.byteLength
            const chunk = decoder.decode(value, { stream: true })
            fullResponse += chunk
            await writer.write(value)
          }
        } catch {
          streamFailed = true
          // Stream failover rule: only re-attempt on the next provider if we
          // haven't sent ANY bytes to the client yet. Otherwise the user has
          // already seen partial output and a different model's continuation
          // would be a confusing UX. Refund and close.
          if (bytesStreamed > 0) {
            if (billableTier(user.tier)) await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
          } else if (attemptedProviders.length < attemptOrder.length) {
            // Try the next provider. The client gets an error trailer; the
            // actual retry happens via the failover at the request level
            // (a future request will use the next provider on the first
            // attempt, or the user can resubmit). We surface a clear error.
            failoverTriggered = true
          }
        } finally {
          await writer.close()
          const usage = extractUsage(fullResponse, resolved.model)
          if (usage) {
            adjustBalance(usage.inputTokens, usage.outputTokens, usage.totalCost)
            const sc = (usage.totalCost ?? estimateCost(resolved.model, usage.inputTokens, usage.outputTokens)) * margin * 100
            ctx.waitUntil(recordSession(user, resolved.model, provider, usage.inputTokens, usage.outputTokens, sc, Date.now() - startTime, streamFailed ? "failed" : "completed", body.messages?.length ?? 0, env.ARCANA_PROXY))
            ctx.waitUntil(settleFreeTurn(freeAdmission, streamFailed ? "failed" : "completed", env.ARCANA_PROXY, streamFailed ? 0 : usage.inputTokens, streamFailed ? 0 : usage.outputTokens))
          }
          else if (streamFailed && !failoverTriggered && billableTier(user.tier)) await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
          if (streamFailed && !failoverTriggered) ctx.waitUntil(settleFreeTurn(freeAdmission, "failed", env.ARCANA_PROXY))
          await releaseLock()
        }
      })()
      const headers: Record<string, string> = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...responseHeaders() }
      headers["X-Provider"] = provider
      return new Response(readable, { status: response.status, headers })
    }

    const data = await response.json() as any
    if (data.usage) {
      const tokensIn = data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0
      const tokensOut = data.usage.completion_tokens ?? data.usage.output_tokens ?? 0
      const upstreamCost = data.usage.total_cost
      await adjustBalance(tokensIn, tokensOut, upstreamCost)
      const sc = (upstreamCost ?? estimateCost(resolved.model, tokensIn, tokensOut)) * margin * 100
      ctx.waitUntil(recordSession(user, resolved.model, provider, tokensIn, tokensOut, sc, Date.now() - startTime, "completed", body.messages?.length ?? 0, env.ARCANA_PROXY))
    }
    // When data.usage is absent (some upstreams don't report it), we don't accumulate tokens;
    // the per-turn input cap and the 10-turn limit are still in force.
    const settledIn = data?.usage ? (data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0) : 0
    const settledOut = data?.usage ? (data.usage.completion_tokens ?? data.usage.output_tokens ?? 0) : 0
    ctx.waitUntil(settleFreeTurn(freeAdmission, "completed", env.ARCANA_PROXY, settledIn, settledOut))
    await releaseLock()
    const successHeaders = { ...responseHeaders(), "X-Provider": provider }
    return json(data, response.status, successHeaders)
  }

  // All providers in attemptOrder failed.
  if (billableTier(user.tier)) await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
  ctx.waitUntil(settleFreeTurn(freeAdmission, "failed", env.ARCANA_PROXY))
  await releaseLock()
  return json({ error: "all_providers_failed", providers: attemptedProviders, lastStatus: lastErrorStatus, message: lastErrorBody }, 502, responseHeaders())
}
// --- end multi-provider failover ---

async function handleCreateOrder(request: Request, env: Env, ctx: ExecutionContext, cors: Record<string, string>): Promise<Response> {
  try {
    let body = await request.json() as any
    const amount = Number(body.amount)
    // Idempotency check FIRST — before any PayPal API calls
    const idempotencyKey = request.headers.get("Idempotency-Key")
    if (idempotencyKey) {
      const existing = await env.ARCANA_PROXY.get(`idempotent:${idempotencyKey}`, "json") as any
      if (existing) return json(existing, 200, cors)
    }
    if (!isFinite(amount) || amount < 5) return json({ error: "Minimum $5" }, 400, cors)

    // Web flow: bind the buyer's identity so we can auto-credit on PayPal return.
    // Primary: email lookup (subscription users). Fallback: license key (non-subscribers).
    // CLI flow omits both and captures explicitly via /v1/pay/capture-order.
    let creditUserId: string | null = null
    let captureToken: string | null = null
    const email = body.email ? String(body.email).trim().toLowerCase() : null
    if (email) {
      const idx = await env.ARCANA_PROXY.get(`email_account:${email}`, "json") as any
      if (!idx) return json({ error: "invalid_email", message: "Email not found. Subscribe first or use a license key." }, 400, cors)
      creditUserId = email // balance:${email} is the canonical balance key for subscribers
    } else if (body.userId) {
      const buyer = await getUser(`Bearer ${String(body.userId).trim()}`, env.ARCANA_PROXY, ctx, env)
      if (!buyer) return json({ error: "invalid_key", message: "Arcana key not recognized. Use your email or license key." }, 400, cors)
      creditUserId = buyer.id
    }

    const token = await getPayPalToken(env)
    const base = paypalBase(env)
    const orderPayload: any = { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: amount.toFixed(2) } }] }
    if (creditUserId) {
      captureToken = crypto.randomUUID()
      orderPayload.application_context = {
        brand_name: "Arcana",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: `https://arcana.otnelhq.com/credits/return?capture_token=${captureToken}`,
        cancel_url: "https://arcana.otnelhq.com/credits?cancelled=1",
      }
    }
    const orderRes = await fetch(`${base}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(orderPayload),
    })
    const order = await orderRes.json() as any
    if (!order.id) {
      const detail =
        order?.message ?? order?.error_description ?? order?.name ?? JSON.stringify(order).slice(0, 200)
      console.error("paypal create-order failed", { status: orderRes.status, detail })
      return json(
        { error: "paypal_error", message: `PayPal order failed (HTTP ${orderRes.status}): ${detail}` },
        500,
        cors,
      )
    }

    await env.ARCANA_PROXY.put(`purchase:${order.id}`, JSON.stringify({ amount, creditUserId, captureToken, status: "created" }), { expirationTtl: 86400 })

    if (idempotencyKey) {
      await env.ARCANA_PROXY.put(`idempotent:${idempotencyKey}`, JSON.stringify({ orderId: order.id }), { expirationTtl: 86400 })
    }

    const approvalUrl = order.links?.find((l: any) => l.rel === "approve")?.href
    return json({ orderId: order.id, approvalUrl }, 200, cors)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error("paypal create-order exception", { message })
    return json({ error: "paypal_error", message }, 500, cors)
  }
}

// Public, order-bound capture for the web Buy Credits flow. PayPal redirects the buyer to
// /credits/return?token=<orderId>; the buyer's account was bound at create time, so no auth
// is needed here — we credit the stored account and PayPal blocks any double-capture.
async function handleCaptureReturn(request: Request, env: Env, ctx: ExecutionContext, cors: Record<string, string>): Promise<Response> {
  try {
    const url = new URL(request.url)
    let orderId = url.searchParams.get("token") ?? url.searchParams.get("orderId")
    if (!orderId && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as any
      orderId = body.token ?? body.orderId ?? null
    }
    if (!orderId) return json({ error: "missing_order" }, 400, cors)

    const purchase = await env.ARCANA_PROXY.get(`purchase:${orderId}`, "json") as any
    if (!purchase) return json({ error: "order_not_found" }, 404, cors)
    if (!purchase.creditUserId) return json({ error: "order_not_web", message: "Finish this order with: arcana proxy capture " + orderId }, 400, cors)

    // Verify one-time capture token to prevent order ID enumeration
    const captureToken = url.searchParams.get("capture_token")
    if (purchase.captureToken && purchase.captureToken !== captureToken) {
      return json({ error: "invalid_capture_token" }, 403, cors)
    }

    // Idempotent — already credited
    if (purchase.status === "completed") {
      const bal = await getBalance(purchase.creditUserId, env.ARCANA_PROXY)
      return json({ success: true, alreadyCaptured: true, creditsAdded: purchase.credits ?? 0, newBalance: Math.round(bal) }, 200, cors)
    }

    const token = await getPayPalToken(env)
    const base = paypalBase(env)
    const capRes = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    })
    const capture = await capRes.json() as any
    if (capture.status !== "COMPLETED") return json({ error: "payment_not_completed", status: capture.status, message: "Payment capture failed. Please contact support." }, 400, cors)

    const valueStr = capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ?? String(purchase.amount ?? "0")
    const [whole, frac = "00"] = valueStr.split(".")
    const credits = parseInt(whole) * 100 + parseInt((frac + "00").slice(0, 2))
    const existing = await env.ARCANA_PROXY.get(`balance:${purchase.creditUserId}`, "json") as any
    const newBalance = (existing?.credits ?? 0) + credits
    await env.ARCANA_PROXY.put(`balance:${purchase.creditUserId}`, JSON.stringify({ credits: newBalance, updatedAt: Date.now() }))
    await env.ARCANA_PROXY.put(`purchase:${orderId}`, JSON.stringify({ ...purchase, credits, status: "completed" }), { expirationTtl: 86400 * 30 })
    ctx.waitUntil(recordPurchase(purchase.creditUserId, orderId, purchase.amount, credits, env.ARCANA_PROXY))

    return json({ success: true, creditsAdded: credits, newBalance: Math.round(newBalance) }, 200, cors)
  } catch (e) {
    return json({ error: "capture_error" }, 500, cors)
  }
}

async function handleCaptureOrder(request: Request, env: Env, ctx: ExecutionContext, cors: Record<string, string>): Promise<Response> {
  try {
    let body = await request.json() as any
    const { orderId } = body
    if (!orderId) return json({ error: "Missing orderId" }, 400, cors)

    // Caller must be authenticated. Credits go to the caller's RESOLVED account id
    // (the same identity /v1/balance and the subscription webhook use), so any real
    // license key works — not just ARCANA-DEV keys. Body userId is no longer trusted.
    const auth = request.headers.get("Authorization")
    const caller = await getUser(auth, env.ARCANA_PROXY, ctx, env)
    if (!caller) return json({ error: "unauthorized" }, 401, cors)

    const purchase = await env.ARCANA_PROXY.get(`purchase:${orderId}`, "json") as any
    // Double-capture protection
    if (purchase?.status === "completed") return json({ error: "order_already_captured" }, 400, cors)
    // If the order was bound to a buyer at create time, only that buyer (or a dev) may capture it.
    if (purchase?.creditUserId && purchase.creditUserId !== caller.id) {
      return json({ error: "forbidden" }, 403, cors)
    }
    const creditTarget = purchase?.creditUserId ?? caller.id

    const token = await getPayPalToken(env)
    const base = paypalBase(env)
    const captureRes = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    })
    const capture = await captureRes.json() as any
    if (capture.status !== "COMPLETED") return json({ error: "payment_not_completed", status: capture.status }, 400, cors)

    const valueStr = capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ?? String(purchase?.amount ?? "0")
    const amount = parseFloat(valueStr)
    const [whole, frac = "00"] = valueStr.split(".")
    const credits = parseInt(whole) * 100 + parseInt((frac + "00").slice(0, 2))
    const existing = await env.ARCANA_PROXY.get(`balance:${creditTarget}`, "json") as any
    const currentCredits = existing?.credits ?? 0
    await env.ARCANA_PROXY.put(`balance:${creditTarget}`, JSON.stringify({ credits: currentCredits + credits, updatedAt: Date.now() }))
    await env.ARCANA_PROXY.put(`purchase:${orderId}`, JSON.stringify({ ...(purchase ?? {}), creditUserId: creditTarget, amount, credits, status: "completed" }), { expirationTtl: 86400 * 30 })
    ctx.waitUntil(recordPurchase(creditTarget, orderId, amount, credits, env.ARCANA_PROXY))

    // Send receipt email (fire-and-forget)
    const email = request.headers.get("X-Receipt-Email")
    if (email) sendReceiptEmail(env, email, amount, credits, orderId)

    // Abuse detection: flag if same IP creates multiple orders rapidly
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown"
    const orderCount = await env.ARCANA_PROXY.get(`abuse:orders:${clientIp}:${Math.floor(Date.now() / 60000)}`, "json") as any ?? 0
    await env.ARCANA_PROXY.put(`abuse:orders:${clientIp}:${Math.floor(Date.now() / 60000)}`, JSON.stringify(orderCount + 1), { expirationTtl: 120 })

    return json({ success: true, creditsAdded: credits, newBalance: currentCredits + credits }, 200, cors)
  } catch (e) {
    return json({ error: "capture_error" }, 500, cors)
  }
}

async function handlePayPalWebhook(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  try {
    const rawBody = await request.text()
    const body = JSON.parse(rawBody)
    const eventType = body.event_type
    const resource = body.resource ?? {}

    // PayPal webhook signature verification
    const transmissionId = request.headers.get("PAYPAL-TRANSMISSION-ID")
    const transmissionTime = request.headers.get("PAYPAL-TRANSMISSION-TIME")
    const transmissionSig = request.headers.get("PAYPAL-TRANSMISSION-SIG")
    const certUrl = request.headers.get("PAYPAL-CERT-URL")
    const webhookId = env.PAYPAL_WEBHOOK_ID

    if (transmissionId && transmissionTime && transmissionSig && certUrl && webhookId) {
      const authAlgo = request.headers.get("PAYPAL-AUTH-ALGO") ?? ""
      const token = await getPayPalToken(env)
      const verifyRes = await fetch(`${paypalBase(env)}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          auth_algo: authAlgo,
          cert_url: certUrl,
          transmission_id: transmissionId,
          transmission_sig: transmissionSig,
          transmission_time: transmissionTime,
          webhook_id: webhookId,
          webhook_event: body,
        }),
      })
      const verifyData = await verifyRes.json() as any
      if (verifyData.verification_status !== "SUCCESS") {
        return json({ error: "webhook_verification_failed", status: verifyData.verification_status }, 403, cors)
      }
    } else {
      // Headers or webhook ID missing — skip verification for backward compatibility
      console?.warn?.("PayPal webhook verification skipped: missing headers or PAYPAL_WEBHOOK_ID")
    }

    switch (eventType) {
      case "BILLING.SUBSCRIPTION.ACTIVATED": {
        const subId = resource.id
        const email = resource.subscriber?.email_address
        if (!subId || !email) return json({ error: "missing_fields" }, 400, cors)
        const key = await generateLicenseKey()
        const pending = await env.ARCANA_PROXY.get(`sub_pending:${subId}`, "json") as any
        const planKey = pending?.plan ?? "pro_monthly"
        const isYearly = planKey === "pro_yearly"
        const days = isYearly ? 365 : 30
        const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000
        await env.ARCANA_PROXY.put(`license:${key}`, JSON.stringify({ id: email, tier: "pro", subscriptionId: subId, expiresAt }))
        await env.ARCANA_PROXY.put(`sub:${subId}`, JSON.stringify({ email, plan: planKey, status: "active", expiresAt, createdAt: Date.now() }), { expirationTtl: 365 * 86400 })
        // Add bundled credits ($5 = 500 credits)
        // Reverse index: email → license key + sub ID for email-based lookup
        await env.ARCANA_PROXY.put(`email_account:${email}`, JSON.stringify({ licenseKey: key, subId, tier: "pro", createdAt: Date.now() }), { expirationTtl: 365 * 86400 })
        const existing = await env.ARCANA_PROXY.get(`balance:${email}`, "json") as any
        const current = existing?.credits ?? 0
        await env.ARCANA_PROXY.put(`balance:${email}`, JSON.stringify({ credits: current + SUBSCRIPTION_CREDITS, updatedAt: Date.now() }))
        sendSubscriptionEmail(env, email, key, resource.plan?.name ?? (isYearly ? "Pro Yearly" : "Pro Monthly"), isYearly ? 190 : 19)
        break
      }
      case "PAYMENT.SALE.COMPLETED": {
        const subId = resource.billing_agreement_id
        if (!subId) return json({ error: "missing_sub_id" }, 400, cors)
        const sub = await env.ARCANA_PROXY.get(`sub:${subId}`, "json") as any
        if (sub) {
          const renewDays = sub.plan === "pro_yearly" ? 365 : 30
          sub.expiresAt = Date.now() + renewDays * 24 * 60 * 60 * 1000
          sub.status = "active"
          sub.renewalAtRisk = false
          await env.ARCANA_PROXY.put(`sub:${subId}`, JSON.stringify(sub), { expirationTtl: 365 * 86400 })
          if (sub.email) {
            const bal = await env.ARCANA_PROXY.get(`balance:${sub.email}`, "json") as any
            const cur = bal?.credits ?? 0
            await env.ARCANA_PROXY.put(`balance:${sub.email}`, JSON.stringify({ credits: cur + SUBSCRIPTION_CREDITS, updatedAt: Date.now() }))
          }
        }
        break
      }
      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.SUSPENDED":
      case "BILLING.SUBSCRIPTION.EXPIRED": {
        const subId = resource.id
        if (!subId) return json({ error: "missing_sub_id" }, 400, cors)
        const sub = await env.ARCANA_PROXY.get(`sub:${subId}`, "json") as any
        if (sub) {
          const statusMap: Record<string, string> = { "BILLING.SUBSCRIPTION.CANCELLED": "cancelled", "BILLING.SUBSCRIPTION.SUSPENDED": "suspended", "BILLING.SUBSCRIPTION.EXPIRED": "expired" }
          sub.status = statusMap[eventType] ?? "cancelled"
          await env.ARCANA_PROXY.put(`sub:${subId}`, JSON.stringify(sub), { expirationTtl: 365 * 86400 })
        }
        break
      }
      case "BILLING.SUBSCRIPTION.UPDATED": {
        const subId = resource.id
        if (!subId) return json({ error: "missing_sub_id" }, 400, cors)
        const sub = await env.ARCANA_PROXY.get(`sub:${subId}`, "json") as any
        if (sub) {
          sub.status = resource.status?.toLowerCase() ?? sub.status
          await env.ARCANA_PROXY.put(`sub:${subId}`, JSON.stringify(sub), { expirationTtl: 365 * 86400 })
        }
        break
      }
      case "PAYMENT.CAPTURE.REFUNDED":
      case "PAYMENT.CAPTURE.REVERSED": {
        const subId = resource.billing_agreement_id
        if (!subId) return json({ error: "missing_sub_id" }, 400, cors)
        const sub = await env.ARCANA_PROXY.get(`sub:${subId}`, "json") as any
        if (sub) {
          sub.status = "revoked"
          await env.ARCANA_PROXY.put(`sub:${subId}`, JSON.stringify(sub), { expirationTtl: 365 * 86400 })
        }
        break
      }
      case "PAYMENT.SALE.DENIED": {
        const subId = resource.billing_agreement_id
        if (!subId) return json({ error: "missing_sub_id" }, 400, cors)
        const sub = await env.ARCANA_PROXY.get(`sub:${subId}`, "json") as any
        if (sub) {
          sub.renewalAtRisk = true
          await env.ARCANA_PROXY.put(`sub:${subId}`, JSON.stringify(sub), { expirationTtl: 365 * 86400 })
        }
        break
      }
    }
    return json({ received: true }, 200, cors)
  } catch (e) {
    return json({ error: "webhook_error" }, 500, cors)
  }
}

// --- Email theme ---
const THEME = {
  bg: "#0B0D12",
  card: "#11151C",
  border: "#1D2430",
  borderLight: "#2A3345",
  text: "#E7ECF3",
  textMuted: "#8A94A6",
  textDim: "#5B6380",
  textDimmer: "#3D4560",
  accent: "#8B5CF6",
  success: "#10B981",
  code: "#D9F99D",
  fontStack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function wrapInLayout(title: string, innerHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
<style>
@media (prefers-color-scheme: light) {
  body, table, td, div, p { background-color: ${THEME.bg} !important; color: ${THEME.text} !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${THEME.bg};font-family:${THEME.fontStack}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:${THEME.card};border:1px solid ${THEME.border};border-radius:8px">
${innerHtml}
</table>
</td></tr></table>
</body>
</html>`
}

function generateLicenseKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `ARCANA-PRO-${b64}`
}

async function handleValidateEmail(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  try {
    const url = new URL(request.url)
    const email = url.searchParams.get("email")?.trim().toLowerCase()
    if (!email) return json({ valid: false, error: "missing_email" }, 400, cors)
    const idx = await env.ARCANA_PROXY.get(`email_account:${email}`, "json") as any
    if (!idx) return json({ valid: false, message: "No account found for this email" }, 404, cors)
    return json({ valid: true, tier: idx.tier, created: idx.createdAt }, 200, cors)
  } catch (e) {
    return json({ valid: false, error: "lookup_error" }, 500, cors)
  }
}

// Authenticated email resolution — lets a logged-in user recover their license key(s)
// The email_account index is maintained for subscription lookup but NEVER used for authentication.
async function handleResolveEmail(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const url = new URL(request.url)
  const email = url.searchParams.get("email")?.trim().toLowerCase()
  if (!email) return json({ error: "missing_email" }, 400, cors)
  const idx = await env.ARCANA_PROXY.get(`email_account:${email}`, "json") as any
  if (!idx) return json({ error: "email_not_found" }, 404, cors)
  return json({ email, licenseKey: idx.licenseKey, subId: idx.subId, tier: idx.tier, createdAt: idx.createdAt }, 200, cors)
}

async function handleSetupPlans(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const auth = request.headers.get("Authorization")
  const adminKey = env.ARCANA_ADMIN_KEY
  if (!adminKey || auth !== `Bearer ${adminKey}`) return json({ error: "unauthorized" }, 401, cors)
  try {
    const token = await getPayPalToken(env)
    const base = paypalBase(env)

    // Create product
    const productRes = await fetch(`${base}/v1/catalogs/products`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": `arcana-product-pro-${Date.now()}` },
      body: JSON.stringify({ name: "Arcana Pro", type: "SERVICE", description: "Arcana AI agent — Pro subscription" }),
    })
    const product = await productRes.json() as any
    if (!product.id) return json({ error: "product_creation_failed", message: "PayPal product creation failed. Please try again." }, 500, cors)
    const productId = product.id

    // Create billing plan
    const planRes = await fetch(`${base}/v1/billing/plans`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": `arcana-plan-pro-monthly-${Date.now()}` },
      body: JSON.stringify({
        product_id: productId,
        name: "Pro Monthly",
        description: "Arcana Pro — $19/month",
        status: "ACTIVE",
        billing_cycles: [{
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: "19.00", currency_code: "USD" } },
        }],
        payment_preferences: {
          auto_bill_outstanding: true,
          payment_failure_threshold: 3,
        },
      }),
    })
    const plan = await planRes.json() as any
    if (!plan.id) return json({ error: "plan_creation_failed", message: "PayPal plan creation failed. Please try again." }, 500, cors)

    // Store monthly plan in KV
    await env.ARCANA_PROXY.put("plan:pro_monthly", JSON.stringify({ productId, planId: plan.id, price: 19, tier: "pro", interval: "MONTH" }))

    // Create yearly billing plan under the same product
    const yearlyRes = await fetch(`${base}/v1/billing/plans`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": `arcana-plan-pro-yearly-${Date.now()}` },
      body: JSON.stringify({
        product_id: productId,
        name: "Pro Yearly",
        description: "Arcana Pro — $190/year",
        status: "ACTIVE",
        billing_cycles: [{
          frequency: { interval_unit: "YEAR", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: "190.00", currency_code: "USD" } },
        }],
        payment_preferences: {
          auto_bill_outstanding: true,
          payment_failure_threshold: 3,
        },
      }),
    })
    const yearly = await yearlyRes.json() as any
    if (!yearly.id) return json({ error: "yearly_plan_creation_failed", message: "PayPal yearly plan creation failed. Please try again." }, 500, cors)
    await env.ARCANA_PROXY.put("plan:pro_yearly", JSON.stringify({ productId, planId: yearly.id, price: 190, tier: "pro", interval: "YEAR" }))

    return json({ productId, monthlyPlanId: plan.id, yearlyPlanId: yearly.id }, 200, cors)
  } catch (e) {
    return json({ error: "setup_failed" }, 500, cors)
  }
}

async function handleCreateSub(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const origin = request.headers.get("Origin") || ""
  const allowed = origin === "https://arcana.otnelhq.com" || /^https?:\/\/localhost(:\d+)?$/.test(origin)
  if (!allowed) return json({ error: "forbidden", message: "Requests must come from arcana.otnelhq.com" }, 403, cors)
  try {
    const body = await request.json().catch(() => ({})) as any
    const planKey = body.plan ?? "pro_monthly"
    if (planKey !== "pro_monthly" && planKey !== "pro_yearly") return json({ error: "invalid_plan" }, 400, cors)
    const plan = await env.ARCANA_PROXY.get(`plan:${planKey}`, "json") as any
    if (!plan) return json({ error: "plan_not_configured" }, 503, cors)

    const token = await getPayPalToken(env)
    const base = paypalBase(env)
    const subRes = await fetch(`${base}/v1/billing/subscriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": `arcana-sub-${Date.now()}-${crypto.randomUUID?.()?.slice(0, 8) ?? Math.random().toString(36).slice(2, 10)}` },
      body: JSON.stringify({
        plan_id: plan.planId,
        application_context: {
          brand_name: "Arcana",
          locale: "en-US",
          user_action: "SUBSCRIBE_NOW",
          payment_method: { payer_selected: "PAYPAL", payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED" },
          return_url: "https://arcana.otnelhq.com",
          cancel_url: "https://arcana.otnelhq.com",
        },
      }),
    })
    const sub = await subRes.json() as any
    if (!sub.id) return json({ error: "subscription_creation_failed", message: "Subscription creation failed. Please try again." }, 500, cors)

    // Store pending subscription
    await env.ARCANA_PROXY.put(`sub_pending:${sub.id}`, JSON.stringify({ plan: planKey, createdAt: Date.now(), status: "pending" }), { expirationTtl: 3600 })

    const approvalUrl = sub.links?.find((l: any) => l.rel === "approve")?.href
    return json({ subscriptionId: sub.id, approvalUrl }, 200, cors)
  } catch (e) {
    return json({ error: "create_sub_error" }, 500, cors)
  }
}

async function handleSubStatus(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const url = new URL(request.url)
  const subId = url.searchParams.get("id")
  if (!subId) return json({ error: "missing_id" }, 400, cors)
  const sub = await env.ARCANA_PROXY.get(`sub:${subId}`, "json") as any
  if (!sub) return json({ error: "not_found" }, 404, cors)
  return json({ subscriptionId: subId, ...sub }, 200, cors)
}

// Admin endpoints for the provider priority list. Same gate as /v1/pay/setup-plans.
function adminAuthorized(request: Request, env: Env): boolean {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() ?? ""
  if (!token) return false
  const keys = listAdminKeys(env)
  return keys.length > 0 && keys.includes(token)
}

async function handleAdminGetProviders(env: Env, cors: Record<string, string>): Promise<Response> {
  const stored = await env.ARCANA_PROXY.get("provider:priority", "json") as Provider[] | null
  return json({
    priority: stored ?? ["openrouter"],
    containerConfigured: Boolean(env.OMNIRoute_WARM),
    providers: {
      openrouter: { configured: Boolean(env.OPENROUTER_KEYS || env.OPENROUTER_KEY) },
      omniroute: { configured: Boolean(env.OMNIRoute_WARM && (env.OMNIRoute_KEYS || env.OMNIRoute_KEY)) },
      aihubmix: { configured: Boolean(env.AIHUBMIX_KEYS || env.AIHUBMIX_KEY), baseURL: AIHUBMIX_URL, fallbackBaseURL: AIHUBMIX_FALLBACK_URL },
      cloudflare: { configured: Boolean((env.CLOUDFLARE_KEYS || env.CLOUDFLARE_KEY) && env.CLOUDFLARE_ACCOUNT_ID), baseURL: cloudflareBaseURL({ CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } as Env) },
    },
  }, 200, cors)
}

async function handleAdminSetProviders(request: Request, env: Env, ctx: ExecutionContext, cors: Record<string, string>): Promise<Response> {
  if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, 401, cors)
  const body = await request.json().catch(() => ({})) as any
  const priority = body?.priority
  if (!Array.isArray(priority) || priority.length === 0) return json({ error: "priority_must_be_nonempty_array" }, 400, cors)
  // Whitelist — never trust caller-provided provider names.
  const filtered = priority.filter(isProvider)
  if (filtered.length === 0) return json({ error: "no_valid_providers" }, 400, cors)
  if (filtered.includes("omniroute") && !env.OMNIRoute_WARM) {
    return json({ error: "omniroute_not_configured", message: "OMNIRoute service binding is missing — deploy the warm Worker first" }, 400, cors)
  }
  if (filtered.includes("aihubmix") && !(env.AIHUBMIX_KEYS || env.AIHUBMIX_KEY)) {
    return json({ error: "aihubmix_not_configured", message: "AIHUBMIX_KEYS or AIHUBMIX_KEY must be configured first" }, 400, cors)
  }
  if (filtered.includes("cloudflare") && (!(env.CLOUDFLARE_KEYS || env.CLOUDFLARE_KEY) || !env.CLOUDFLARE_ACCOUNT_ID)) {
    return json({ error: "cloudflare_not_configured", message: "CLOUDFLARE_KEYS/CLOUDFLARE_KEY and CLOUDFLARE_ACCOUNT_ID must be configured first" }, 400, cors)
  }
  // 1-hour TTL doubles as a cache bust for stale isolates that already cached
  // the priority list in memory.
  await env.ARCANA_PROXY.put("provider:priority", JSON.stringify(filtered), { expirationTtl: 3600 })
  // Best-effort cache flush on the local isolate.
  providerPriorityCache = null
  providerPriorityCacheTime = 0
  return json({ ok: true, priority: filtered }, 200, cors)
}

// Admin: mint a fresh license key bound to a Supabase user. Used by the site
// device-flow completion handler at /auth/device/complete. The returned key
// is the same shape as PayPal-issued keys (ARCANA-PRO-...) and validates via
// the standard license:<key> lookup in getUser().
async function handleAdminMintLicense(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  // Caller already passed adminAuthorized when routed via /v1/admin/*; keep a
  // defense-in-depth check for direct calls / tests.
  if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, 401, cors)
  const body = await request.json().catch(() => ({})) as any
  const supabaseUserId = String(body?.supabaseUserId ?? "").trim()
  const email = String(body?.email ?? "").trim().toLowerCase()
  const planRaw = String(body?.plan ?? "pro").trim().toLowerCase()
  const allowedPlans = new Set(["pro", "team", "enterprise"])
  const plan = allowedPlans.has(planRaw) ? planRaw : "pro"
  if (!supabaseUserId || !email) return json({ error: "missing_fields", required: ["supabaseUserId", "email"] }, 400, cors)

  const key = generateLicenseKey()
  const createdAt = Date.now()
  const licenseKvKey = `license:${key}`
  const emailKvKey = `email_account:${email}`
  if (!kvKeyOk(licenseKvKey) || !kvKeyOk(emailKvKey)) {
    return json({ error: "kv_key_too_long", message: "Generated license or email key exceeds KV limit" }, 500, cors)
  }
  // No expiresAt — device-flow keys are open-ended. The reverse index is
  // mirrored from the PayPal path so /v1/identity/validate-email and other
  // email-lookup routes continue to work uniformly.
  await env.ARCANA_PROXY.put(licenseKvKey, JSON.stringify({
    id: email,
    tier: plan,
    supabaseUserId,
    source: "device_flow",
    createdAt,
  }))
  await env.ARCANA_PROXY.put(emailKvKey, JSON.stringify({
    licenseKey: key,
    tier: plan,
    source: "device_flow",
    createdAt,
  }), { expirationTtl: 365 * 86400 })
  return json({ licenseKey: key, tier: plan, createdAt }, 200, cors)
}

async function sendSubscriptionEmail(env: Env, to: string, key: string, planName: string, price: number = 19): Promise<void> {
  if (!env.EMAIL) return
  try {
    const safeKey = escapeHtml(key)
    const safePlan = escapeHtml(planName)
    const inner = `
<tr><td style="padding:24px 32px 0"><span role="img" aria-label="Arcana" style="color:${THEME.accent};font-size:16px">⛧</span> <span style="color:${THEME.textMuted}">ARCANA</span> <span style="color:${THEME.textDim};font-size:11px">decrypt the arcane</span></td></tr>
<tr><td style="padding:16px 32px 0"><div style="border-bottom:1px solid ${THEME.border}"></div></td></tr>
<tr><td style="padding:28px 32px 4px;text-align:center">
<div style="color:${THEME.success};font-size:11px;font-weight:600;letter-spacing:.5px;margin-bottom:8px">● Confirmed</div>
<div style="font-size:28px;font-weight:700;color:${THEME.text}">${safePlan}</div>
<div style="font-size:13px;color:${THEME.textMuted};margin-top:6px">$${price}.00 USD · includes 500 proxy credits</div>
</td></tr>
<tr><td style="padding:20px 32px 0"><div style="border-bottom:1px solid ${THEME.border}"></div></td></tr>
<tr><td style="padding:20px 32px 8px">
<div style="color:${THEME.textMuted};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Your License Key</div>
<div style="background:${THEME.bg};border:1px solid ${THEME.border};padding:14px;text-align:center;font-family:ui-monospace,monospace;font-size:14px;color:${THEME.code};word-break:break-all;user-select:all">${safeKey}</div>
<p style="color:${THEME.textDim};font-size:12px;margin-top:12px;line-height:1.5">Enter this key in the CLI:<br><code style="background:${THEME.bg};padding:4px 8px;color:${THEME.code};font-family:monospace;font-size:12px">arcana license activate ${escapeHtml(key.slice(0, 16))}...</code></p>
</td></tr>
<tr><td style="padding:0 32px"><div style="border-bottom:1px solid ${THEME.border}"></div></td></tr>
<tr><td style="padding:20px 32px 24px;text-align:center">
<div style="color:${THEME.textDim};font-size:11px">ARCANA Runtime Infrastructure · Otnel</div>
</td></tr>`
    await env.EMAIL.send({
      to,
      from: { email: "receipts@otnelhq.com", name: "Arcana" },
      subject: "Your Arcana Pro license key is ready",
      html: wrapInLayout("Arcana Pro — License Key", inner),
      text: `Arcana Pro — License Key\n\nYour Pro subscription is active.\nLicense key: ${key}\n\nEnter in CLI: arcana license activate ${key}\n\nARCANA Runtime Infrastructure`,
    })
  } catch {}
}

function receiptHtml(amount: string, credits: string, details: [string, string][], status: string, ctaUrl?: string): string {
  const detailRows = details.map(([label, val]) =>
    `<tr><td style="padding:8px 0;color:${THEME.textMuted};font-size:13px">${escapeHtml(label)}</td><td style="padding:8px 0;color:${THEME.text};font-size:13px;text-align:right;font-family:ui-monospace,SFMono-Regular,monospace">${escapeHtml(val)}</td></tr>`
  ).join("")
  const safeStatus = escapeHtml(status)
  const inner = `
<!-- header -->
<tr><td style="padding:24px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="font-size:13px;color:${THEME.textMuted};vertical-align:middle">
<span role="img" aria-label="Arcana" style="color:${THEME.accent};font-size:16px;margin-right:6px">⛧</span>ARCANA<span style="color:${THEME.textDim};margin-left:8px;font-size:11px">decrypt the arcane</span>
</td></tr></table>
</td></tr>

<!-- divider -->
<tr><td style="padding:16px 32px 0"><div style="border-bottom:1px solid ${THEME.border}"></div></td></tr>

<!-- hero -->
<tr><td style="padding:28px 32px 4px;text-align:center">
<div style="color:${THEME.success};font-size:11px;font-weight:600;letter-spacing:0.5px;margin-bottom:8px">● ${safeStatus}</div>
<div style="font-size:36px;font-weight:700;color:${THEME.text};letter-spacing:-0.5px">+${escapeHtml(credits)}</div>
<div style="font-size:13px;color:${THEME.textMuted};margin-top:6px">${escapeHtml(amount)}</div>
</td></tr>

<!-- divider -->
<tr><td style="padding:20px 32px 0"><div style="border-bottom:1px solid ${THEME.border}"></div></td></tr>

<!-- details -->
<tr><td style="padding:20px 32px 8px">
<div style="color:${THEME.textMuted};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Allocation Details</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${detailRows}</table>
</td></tr>

<!-- divider -->
<tr><td style="padding:0 32px"><div style="border-bottom:1px solid ${THEME.border}"></div></td></tr>

<!-- cta + footer -->
<tr><td style="padding:20px 32px 24px;text-align:center">
${ctaUrl ? `<a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:10px 24px;background:${THEME.border};color:${THEME.text};font-size:13px;font-weight:500;border-radius:6px;text-decoration:none;border:1px solid ${THEME.borderLight}">View Receipt →</a><br><br>` : ""}
<div style="color:${THEME.textDim};font-size:11px">ARCANA Runtime Infrastructure · Delivered via Otnel</div>
<div style="color:${THEME.textDimmer};font-size:10px;margin-top:2px">receipts@otnelhq.com</div>
</td></tr>`
  return wrapInLayout("Arcana Receipt", inner)
}

function receiptText(credits: string, amount: string, details: [string, string][], status: string, receiptUrl?: string): string {
  const sep = "─".repeat(44)
  const lines = details.map(([l, v]) => `  ${l.padEnd(22)} ${v}`).join("\n")
  const receiptLine = receiptUrl ? `\n  View Receipt →  ${receiptUrl}` : ""
  return `${" ".repeat(14)}ARCANA\n${" ".repeat(10)}decrypt the arcane\n${sep}\n  ${status.toUpperCase()}\n\n  +${credits}\n  ${amount}\n${sep}\n  Allocation Details\n${sep}\n${lines}\n${sep}${receiptLine}\n${sep}\n  ARCANA Runtime Infrastructure  ·  Otnel`
}

async function sendReceiptEmail(env: Env, to: string, amount: number, credits: number, orderId: string): Promise<void> {
  if (!env.EMAIL) return
  try {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
    const amt = `$${amount.toFixed(2)} USD`
    const crd = `${credits.toLocaleString("en")} Credits`
    const details: [string, string][] = [
      ["Credits Added", crd],
      ["Transaction ID", orderId],
      ["Date", ts],
      ["Workspace", "Personal"],
    ]
    await env.EMAIL.send({
      to,
      from: { email: "receipts@otnelhq.com", name: "Arcana" },
      subject: `Credits allocated — ${crd} — ${amt}`,
      html: receiptHtml(amt, crd, details, "Confirmed"),
      text: receiptText(crd, amt, details, "Confirmed"),
    })
  } catch {}
}

async function handleTrialStart(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.TRIAL_ENABLED || env.TRIAL_ENABLED !== "true") return json({ error: "trials_disabled" }, 404, cors)
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors)
  const body = await request.json().catch(() => ({})) as any
  const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown"
  // One trial per IP
  const existing = await env.ARCANA_PROXY.get(`trial_ip:${clientIp}`, "json") as any
  if (existing) return json({ error: "trial_already_claimed", token: existing.token }, 409, cors)

  const token = "trial_" + Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("")
  const now = Date.now()
  const trial = { tier: "pro", startedAt: now, expiresAt: now + TRIAL_DURATION_MS, source: body.source ?? "web" }
  await env.ARCANA_PROXY.put(`trial:${token}`, JSON.stringify(trial), { expirationTtl: Math.ceil(TRIAL_DURATION_MS / 1000) })
  await env.ARCANA_PROXY.put(`trial_ip:${clientIp}`, JSON.stringify({ token }), { expirationTtl: Math.ceil(TRIAL_DURATION_MS / 1000) })
  return json({ token, tier: "pro", expiresAt: new Date(trial.expiresAt).toISOString(), expiresIn: "14 days" }, 200, cors)
}

async function recordSession(user: { id: string }, model: string, provider: string, tokensIn: number, tokensOut: number, costCredits: number, durationMs: number, status: "completed" | "failed" | "streamed", messageCount: number, kv: KVNamespace): Promise<void> {
  const sessionId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const summary = { id: sessionId, model, provider, tokensIn, tokensOut, costCredits, durationMs, createdAt, status, messageCount }
  const detail = { ...summary, userId: user.id, summary: "(generated)", firstMessage: "", lastMessage: "" }
  try {
    await kv.put(`session:${sessionId}`, JSON.stringify(detail), { expirationTtl: 86400 * 90 })
    const raw = await kv.get(`user_sessions:${user.id}`, "json") as any[] || []
    raw.unshift(summary)
    if (raw.length > 50) raw.length = 50
    await kv.put(`user_sessions:${user.id}`, JSON.stringify(raw), { expirationTtl: 86400 * 90 })
  } catch {}
}

async function recordPurchase(userId: string, orderId: string, amount: number, credits: number, kv: KVNamespace): Promise<void> {
  try {
    const raw = await kv.get(`user_purchases:${userId}`, "json") as any[] || []
    raw.unshift({ orderId, amount, credits, status: "completed", createdAt: new Date().toISOString(), paymentMethod: "paypal" })
    if (raw.length > 100) raw.length = 100
    await kv.put(`user_purchases:${userId}`, JSON.stringify(raw), { expirationTtl: 86400 * 365 })
  } catch {}
}

async function handleGetSessions(request: Request, user: { id: string }, env: Env, cors: Record<string, string>): Promise<Response> {
  const url = new URL(request.url)
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 50)
  const raw = await env.ARCANA_PROXY.get(`user_sessions:${user.id}`, "json") as any[] || []
  const sessions = raw.slice(0, limit)
  return json({ sessions, total: raw.length }, 200, cors)
}

async function handleGetSessionDetail(sessionId: string, user: { id: string }, env: Env, cors: Record<string, string>): Promise<Response> {
  const session = await env.ARCANA_PROXY.get(`session:${sessionId}`, "json") as any
  if (!session) return json({ error: "not_found" }, 404, cors)
  if (session.userId !== user.id) return json({ error: "forbidden" }, 403, cors)
  return json(session, 200, cors)
}

async function handleGetPurchases(user: { id: string }, env: Env, cors: Record<string, string>): Promise<Response> {
  const raw = await env.ARCANA_PROXY.get(`user_purchases:${user.id}`, "json") as any[] || []
  return json({ purchases: raw }, 200, cors)
}

async function handleGetProfile(user: { id: string }, env: Env, cors: Record<string, string>): Promise<Response> {
  const profile = await env.ARCANA_PROXY.get(`profile:${user.id}`, "json") as any
  return json(profile ?? { displayName: "", theme: "dark", notifications: { emailReceipts: true, usageAlerts: false } }, 200, cors)
}

async function handlePutProfile(request: Request, user: { id: string }, env: Env, cors: Record<string, string>): Promise<Response> {
  let body = await request.json() as any
  const allowed = ["displayName", "theme", "notifications"]
  const clean: any = {}
  for (const key of allowed) {
    if (body[key] !== undefined) clean[key] = body[key]
  }
  clean.updatedAt = Date.now()
  await env.ARCANA_PROXY.put(`profile:${user.id}`, JSON.stringify(clean))
  return json({ ok: true, profile: clean }, 200, cors)
}

async function handleGetBalance(user: { id: string }, env: Env, cors: Record<string, string>): Promise<Response> {
  const credits = await getBalance(user.id, env.ARCANA_PROXY)
  return json({ userId: user.id, credits: Math.round(credits), dollars: (credits / 100).toFixed(2) }, 200, cors)
}

async function handleSendTestReceipt(request: Request, env: Env, user: { id: string }, cors: Record<string, string>): Promise<Response> {
  if (!env.EMAIL) return json({ error: "email_service_not_configured" }, 503, cors)
  const body = await request.json().catch(() => ({})) as any
  const to = body.email
  if (!to) return json({ error: "email_required" }, 400, cors)
  const amount = body.amount ?? 10
  const credits = body.credits ?? amount * 100
  const transactionId = body.transactionId ?? "txn_test_" + Date.now().toString(36)
  try {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
    const amt = `$${Number(amount).toFixed(2)} USD`
    const crd = `${Number(credits).toLocaleString("en")} Credits`
    const details: [string, string][] = [
      ["Credits Added", crd],
      ["Transaction ID", transactionId],
      ["Date", ts],
      ["Workspace", body.workspace ?? "Personal"],
    ]
    const r = await env.EMAIL.send({
      to,
      from: { email: "receipts@otnelhq.com", name: "Arcana" },
      subject: `Credits allocated — ${crd} — ${amt}`,
      html: receiptHtml(amt, crd, details, body.status ?? "Confirmed"),
      text: receiptText(crd, amt, details, body.status ?? "Confirmed"),
    })
    return json({ sent: true, messageId: r.messageId, to, amount, credits, transactionId }, 200, cors)
  } catch (e: any) {
    return json({ error: "send_failed" }, 500, cors)
  }
}

function prefixedModelList(data: any, prefix: string, ownedBy: string): any[] {
  const models = Array.isArray(data?.data) ? data.data : []
  return models
    .filter((model: any) => model && typeof model.id === "string")
    .map((model: any) => ({ ...model, id: `${prefix}${model.id}`, owned_by: model.owned_by ?? ownedBy }))
}

async function listModels(env: Env, cors: Record<string, string>): Promise<Response> {
  const models: any[] = []
  const errors: Array<{ provider: Provider; status: number; message: string }> = []

  const openRouterKey = getOpenRouterKey(env)
  if (openRouterKey) {
    try {
      const response = await fetch(`${OPENROUTER_URL}/v1/models`, { headers: { Authorization: `Bearer ${openRouterKey}` } })
      if (response.ok) {
        markKeySuccess(openRouterKey)
        const data = await response.json() as any
        if (Array.isArray(data?.data)) models.push(...data.data)
      } else {
        if (response.status === 429 || response.status === 401) markKeyRateLimited(openRouterKey)
        errors.push({ provider: "openrouter", status: response.status, message: (await response.text()).slice(0, 160) })
      }
    } catch (error) {
      markKeyRateLimited(openRouterKey)
      errors.push({ provider: "openrouter", status: 502, message: String(error).slice(0, 160) })
    }
  }

  const aiHubMixKey = getAIHubMixKey(env)
  if (aiHubMixKey) {
    try {
      const response = await fetchAIHubMix("/v1/models", { headers: { Authorization: `Bearer ${aiHubMixKey}` } })
      if (response.ok) {
        markAIHubMixKeySuccess(aiHubMixKey)
        const data = await response.json() as any
        models.push(...prefixedModelList(data, "aihubmix/", "aihubmix"))
      } else {
        if (response.status === 429 || response.status === 401) markAIHubMixKeyRateLimited(aiHubMixKey)
        errors.push({ provider: "aihubmix", status: response.status, message: (await response.text()).slice(0, 160) })
      }
    } catch (error) {
      markAIHubMixKeyRateLimited(aiHubMixKey)
      errors.push({ provider: "aihubmix", status: 502, message: String(error).slice(0, 160) })
    }
  }

  const cloudflareKey = getCloudflareKey(env)
  if (cloudflareKey && env.CLOUDFLARE_ACCOUNT_ID) {
    try {
      const response = await fetch(`${cloudflareBaseURL(env)}/v1/models`, { headers: { Authorization: `Bearer ${cloudflareKey}` } })
      if (response.ok) {
        markCloudflareKeySuccess(cloudflareKey)
        const data = await response.json() as any
        // Workers AI returns { result: [...] } (Cloudflare-native) or { data: [...] } (OpenAI-compat).
        // Normalise to a list, then prefix with "cloudflare/" so the client catalog can disambiguate.
        const raw = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.result) ? data.result : [])
        for (const m of raw) {
          if (m && typeof m.id === "string") models.push({ ...m, id: `cloudflare/${m.id}`, owned_by: "cloudflare" })
          else if (m && typeof m.name === "string") models.push({ ...m, id: `cloudflare/${m.name}`, owned_by: "cloudflare" })
        }
      } else {
        if (response.status === 429 || response.status === 401) markCloudflareKeyRateLimited(cloudflareKey)
        errors.push({ provider: "cloudflare", status: response.status, message: (await response.text()).slice(0, 160) })
      }
    } catch (error) {
      markCloudflareKeyRateLimited(cloudflareKey)
      errors.push({ provider: "cloudflare", status: 502, message: String(error).slice(0, 160) })
    }
  }
  if (models.length > 0) return json({ object: "list", data: models }, 200, cors)
  if (errors.length > 0) return json({ error: "models_unavailable", providers: errors }, 502, cors)
  return json({ error: "no_api_key", message: "No provider API key configured" }, 500, cors)
}

async function getUserUsage(user: { id: string }, env: Env, cors: Record<string, string>): Promise<Response> {
  const date = new Date().toISOString().split("T")[0]!
  const subject = utf8Len(user.id) > 80 ? (await sha256Hex(user.id)).slice(0, 40) : user.id
  const key = `usage:${subject}:${date}`
  const data = (kvKeyOk(key) ? await env.ARCANA_PROXY.get(key, "json") : null) as any ?? {}
  return json({ userId: user.id, date, ...data }, 200, cors)
}

function json(data: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } })
}
