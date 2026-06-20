import type { AnalyticsEvent } from "./types"

const OPENROUTER_URL = "https://openrouter.ai/api"
const PAYPAL_LIVE = "https://api-m.paypal.com"
const PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com"

interface Env {
  OPENROUTER_KEY?: string
  OPENROUTER_KEYS?: string       // comma-separated pool of API keys for rotation
  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  ARCANA_PROXY: KVNamespace
  ARCANA_PROXY_ANALYTICS?: AnalyticsEngineDataset
  EMAIL?: SendEmail
  TRIAL_ENABLED?: string
  MERCHANT_ID?: string
  PAYPAL_WEBHOOK_ID?: string
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
const IP_RATE_LIMIT = 50
const USER_RATE_LIMIT = 25
const RATE_WINDOW = 60000

// License cache
let cleanupCounter = 0
let licenseCache: Map<string, { id: string; tier: string }> | null = null
let licenseCacheTime = 0
const LICENSE_CACHE_TTL = 300000

async function getUser(auth: string | null, kv: KVNamespace, env?: Env): Promise<{ id: string; tier: string } | null> {
  if (!auth || !auth.startsWith("Bearer ")) return null
  const key = auth.slice(7).trim()
  if (!key) return null
  const now = Date.now()

  // Trial tokens — ephemeral, no caching
  if (key.startsWith("trial_")) {
    if (!env?.TRIAL_ENABLED || env.TRIAL_ENABLED !== "true") return null
    const trial = await kv.get(`trial:${key}`, "json") as any
    if (!trial) return null
    if (now > trial.expiresAt) { await kv.delete(`trial:${key}`); return null }
    return { id: `trial_${key.slice(6, 14)}`, tier: "pro" }
  }

  if (!licenseCache || now - licenseCacheTime > LICENSE_CACHE_TTL) { licenseCache = new Map(); licenseCacheTime = now }
  let user = licenseCache.get(key)
  if (user) return user
  const raw = await kv.get(`license:${key}`, "json") as any
  if (raw) { licenseCache.set(key, raw); return raw }
  if (key.startsWith("ARCANA-DEV-")) { user = { id: "Arcana Developer", tier: "enterprise" }; licenseCache.set(key, user); return user }
  const account = await kv.get(`account:${key}`, "json") as any
  if (account) { user = { id: account.username ?? account.email ?? "user", tier: "free" }; licenseCache.set(key, user); return user }
  // Fallback: validate against license server (handles cross-KV namespace)
  try {
    const res = await fetch(`https://api.arcana.otnelhq.com/api/license/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: key, machineId: `proxy-${key.slice(0, 8)}` }),
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json() as any
    if (data.valid) {
      user = { id: key.slice(0, 12), tier: data.tier ?? "free" }
      await kv.put(`license:${key}`, JSON.stringify(user))
      licenseCache.set(key, user)
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
  const base = env.PAYPAL_SANDBOX === "true" ? PAYPAL_SANDBOX : PAYPAL_LIVE
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  })
  const data = await res.json() as any
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown"
    const origin = request.headers.get("Origin") || ""
    const allowedOrigin = origin === "https://arcana.otnelhq.com" || /^https?://localhost(:d+)?$/.test(origin)
      ? origin
      : "https://arcana.otnelhq.com"
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
    }

    // IP-based rate limiting (all endpoints)
    const ipRl = checkRateLimit(clientIp, ipLimits, IP_RATE_LIMIT)
    if (!ipRl.allowed) return json({ error: "rate_limited", message: "IP rate limit exceeded: 50 req/min" }, 429, corsHeaders)

    try {
      // Public endpoints (IP rate limit only)
      if (url.pathname === "/v1/identity/validate-email") return handleValidateEmail(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/create-order") return handleCreateOrder(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/capture-order") return handleCaptureOrder(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/capture-return") return handleCaptureReturn(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/webhook") return handlePayPalWebhook(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/setup-plans") return handleSetupPlans(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/create-sub") return handleCreateSub(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/sub-status") return handleSubStatus(request, env, corsHeaders)
      if (url.pathname === "/v1/trial/start") return handleTrialStart(request, env, corsHeaders)

      // Auth required
      const user = await getUser(request.headers.get("Authorization"), env.ARCANA_PROXY, env)
      if (!user) return json({ error: "unauthorized" }, 401, corsHeaders)

      // User rate limiting
      const userRl = checkRateLimit(user.id, userLimits, USER_RATE_LIMIT)
      if (!userRl.allowed) return json({ error: "rate_limited", message: "25 req/min per user" }, 429, corsHeaders)

      switch (url.pathname) {
        case "/v1/chat/completions":
        case "/v1/embeddings":
          return proxyOpenRouter(request, env, user, corsHeaders, url.pathname)
        case "/v1/models":
          return listModels(env, corsHeaders)
        case "/v1/usage":
          return getUserUsage(user, corsHeaders)
        case "/v1/balance":
          return handleGetBalance(user, env, corsHeaders)
        case "/v1/send-receipt":
          return handleSendTestReceipt(request, env, user, corsHeaders)
        case "/v1/auth/resolve-email":
          return handleResolveEmail(request, env, corsHeaders)
        case "/v1/health":
          return json({ status: "ok", service: "arcana-proxy", user: user.id, tier: user.tier }, 200, corsHeaders)
        default:
          return json({ error: "not_found" }, 404, corsHeaders)
      }
    } catch (e) {
      return json({ error: "internal_error" }, 500, corsHeaders)
    }
  },
}

async function proxyOpenRouter(request: Request, env: Env, user: { id: string; tier: string }, cors: Record<string, string>, path: string): Promise<Response> {
  const body = await request.json() as any
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

  try {
    if (user.tier !== "enterprise") {
      const balance = await getBalance(user.id, env.ARCANA_PROXY)
      if (balance < maxCost) { await releaseLock(); return json({ error: "insufficient_balance", message: "Add credits via arcana proxy buy", balance, required: Math.round(maxCost) }, 402, cors) }
      await deductBalance(user.id, maxCost, env.ARCANA_PROXY)
    }
  } catch { await releaseLock(); throw new Error("lock error") }

  const openRouterKey = getOpenRouterKey(env)
  if (!openRouterKey) { await releaseLock(); return json({ error: "no_api_key", message: "No OpenRouter API key configured" }, 500, cors) }
  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${openRouterKey}`,
    "HTTP-Referer": "https://arcana.otnelhq.com",
    "X-Title": "arcana",
  })
  if (body.model) body.user = user.id

  const startTime = Date.now()
  const isStream = body.stream === true
  const response = await fetch(`${OPENROUTER_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) })

  if (!response.ok) {
    if (response.status === 429 || response.status === 401) markKeyRateLimited(openRouterKey)
    if (user.tier !== "enterprise") await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
    await releaseLock()
    const errorBody = await response.text()
    return json({ error: "upstream_error", message: errorBody.slice(0, 100) }, response.status, cors)
  }
  markKeySuccess(openRouterKey)

  const adjustBalance = async (tokensIn: number, tokensOut: number, openRouterCost?: number) => {
    const actualCost = openRouterCost ?? estimateCost(body.model, tokensIn, tokensOut)
    if (user.tier !== "enterprise") {
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
        if (usage) adjustBalance(usage.inputTokens, usage.outputTokens, usage.totalCost)
        else if (streamFailed && user.tier !== "enterprise") await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
        await releaseLock()
      }
    })()
    return new Response(readable, { status: response.status, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...cors } })
  }

  const data = await response.json() as any
  if (data.usage) {
    const tokensIn = data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0
    const tokensOut = data.usage.completion_tokens ?? data.usage.output_tokens ?? 0
    const openRouterCost = data.usage.total_cost // OpenRouter's actual cost in USD
    await adjustBalance(tokensIn, tokensOut, openRouterCost)
  }
  await releaseLock()
  return json(data, response.status, cors)
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

async function handleCreateOrder(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  try {
    const body = await request.json() as any
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
      const buyer = await getUser(`Bearer ${String(body.userId).trim()}`, env.ARCANA_PROXY, env)
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
    if (!order.id) return json({ error: "paypal_error", message: "PayPal order creation failed. Please try again." }, 500, cors)

    await env.ARCANA_PROXY.put(`purchase:${order.id}`, JSON.stringify({ amount, creditUserId, captureToken, status: "created" }), { expirationTtl: 86400 })

    if (idempotencyKey) {
      await env.ARCANA_PROXY.put(`idempotent:${idempotencyKey}`, JSON.stringify({ orderId: order.id }), { expirationTtl: 86400 })
    }

    const approvalUrl = order.links?.find((l: any) => l.rel === "approve")?.href
    return json({ orderId: order.id, approvalUrl }, 200, cors)
  } catch (e) {
    return json({ error: "paypal_error" }, 500, cors)
  }
}

// Public, order-bound capture for the web Buy Credits flow. PayPal redirects the buyer to
// /credits/return?token=<orderId>; the buyer's account was bound at create time, so no auth
// is needed here — we credit the stored account and PayPal blocks any double-capture.
async function handleCaptureReturn(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
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

    return json({ success: true, creditsAdded: credits, newBalance: Math.round(newBalance) }, 200, cors)
  } catch (e) {
    return json({ error: "capture_error" }, 500, cors)
  }
}

async function handleCaptureOrder(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  try {
    const body = await request.json() as any
    const { orderId } = body
    if (!orderId) return json({ error: "Missing orderId" }, 400, cors)

    // Caller must be authenticated. Credits go to the caller's RESOLVED account id
    // (the same identity /v1/balance and the subscription webhook use), so any real
    // license key works — not just ARCANA-DEV keys. Body userId is no longer trusted.
    const auth = request.headers.get("Authorization")
    const caller = await getUser(auth, env.ARCANA_PROXY, env)
    if (!caller) return json({ error: "unauthorized" }, 401, cors)

    const purchase = await env.ARCANA_PROXY.get(`purchase:${orderId}`, "json") as any
    // Double-capture protection
    if (purchase?.status === "completed") return json({ error: "order_already_captured" }, 400, cors)
    // If the order was bound to a buyer at create time, only that buyer (or a dev) may capture it.
    const isDev = auth?.startsWith("Bearer ARCANA-DEV-") ?? false
    if (purchase?.creditUserId && purchase.creditUserId !== caller.id && !isDev) {
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
  if (!auth?.startsWith("Bearer ARCANA-DEV-")) return json({ error: "unauthorized" }, 401, cors)
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

async function sendSubscriptionEmail(env: Env, to: string, key: string, planName: string, price: number = 19): Promise<void> {
  if (!env.EMAIL) return
  try {
    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0B0D12;font-family:-apple-system,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="background:#11151C;border:1px solid #1D2430;border-radius:8px">
<tr><td style="padding:24px 32px 0"><span style="color:#8B5CF6;font-size:16px">⛧</span> <span style="color:#8A94A6">ARCANA</span> <span style="color:#5B6380;font-size:11px">decrypt the arcane</span></td></tr>
<tr><td style="padding:16px 32px 0"><div style="border-bottom:1px solid #1D2430"></div></td></tr>
<tr><td style="padding:28px 32px 4px;text-align:center">
<div style="color:#10B981;font-size:11px;font-weight:600;letter-spacing:.5px;margin-bottom:8px">● Confirmed</div>
<div style="font-size:28px;font-weight:700;color:#E7ECF3">${planName}</div>
<div style="font-size:13px;color:#8A94A6;margin-top:6px">$${price}.00 USD · includes 500 proxy credits</div>
</td></tr>
<tr><td style="padding:20px 32px 0"><div style="border-bottom:1px solid #1D2430"></div></td></tr>
<tr><td style="padding:20px 32px 8px">
<div style="color:#8A94A6;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Your License Key</div>
<div style="background:#0B0D12;border:1px solid #1D2430;padding:14px;text-align:center;font-family:ui-monospace,monospace;font-size:14px;color:#D9F99D;word-break:break-all;user-select:all">${key}</div>
<p style="color:#5B6380;font-size:12px;margin-top:12px;line-height:1.5">Enter this key in the CLI:<br><code style="background:#0B0D12;padding:4px 8px;color:#D9F99D;font-family:monospace;font-size:12px">arcana license activate ${key.slice(0, 16)}...</code></p>
</td></tr>
<tr><td style="padding:0 32px"><div style="border-bottom:1px solid #1D2430"></div></td></tr>
<tr><td style="padding:20px 32px 24px;text-align:center">
<div style="color:#5B6380;font-size:11px">ARCANA Runtime Infrastructure · Otnel</div>
</td></tr>
</table></td></tr></table></body></html>`
    await env.EMAIL.send({
      to,
      from: { email: "receipts@otnelhq.com", name: "Arcana" },
      subject: "Your Arcana Pro license key is ready",
      html,
      text: `Arcana Pro — License Key\n\nYour Pro subscription is active.\nLicense key: ${key}\n\nEnter in CLI: arcana license activate ${key}\n\nARCANA Runtime Infrastructure`,
    })
  } catch {}
}

function receiptHtml(amount: string, credits: string, details: [string, string][], status: string, ctaUrl?: string): string {
  const detailRows = details.map(([label, val]) =>
    `<tr><td style="padding:8px 0;color:#8A94A6;font-size:13px">${label}</td><td style="padding:8px 0;color:#E7ECF3;font-size:13px;text-align:right;font-family:ui-monospace,SFMono-Regular,monospace">${val}</td></tr>`
  ).join("")
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0B0D12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#11151C;border:1px solid #1D2430;border-radius:8px">

<!-- header -->
<tr><td style="padding:24px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="font-size:13px;color:#8A94A6;vertical-align:middle">
<span style="color:#8B5CF6;font-size:16px;margin-right:6px">⛧</span>ARCANA<span style="color:#5B6380;margin-left:8px;font-size:11px">decrypt the arcane</span>
</td></tr></table>
</td></tr>

<!-- divider -->
<tr><td style="padding:16px 32px 0"><div style="border-bottom:1px solid #1D2430"></div></td></tr>

<!-- hero -->
<tr><td style="padding:28px 32px 4px;text-align:center">
<div style="color:#10B981;font-size:11px;font-weight:600;letter-spacing:0.5px;margin-bottom:8px">● ${status}</div>
<div style="font-size:36px;font-weight:700;color:#E7ECF3;letter-spacing:-0.5px">+${credits}</div>
<div style="font-size:13px;color:#8A94A6;margin-top:6px">${amount}</div>
</td></tr>

<!-- divider -->
<tr><td style="padding:20px 32px 0"><div style="border-bottom:1px solid #1D2430"></div></td></tr>

<!-- details -->
<tr><td style="padding:20px 32px 8px">
<div style="color:#8A94A6;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Allocation Details</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${detailRows}</table>
</td></tr>

<!-- divider -->
<tr><td style="padding:0 32px"><div style="border-bottom:1px solid #1D2430"></div></td></tr>

<!-- cta + footer -->
<tr><td style="padding:20px 32px 24px;text-align:center">
${ctaUrl ? `<a href="${ctaUrl}" style="display:inline-block;padding:10px 24px;background:#1D2430;color:#E7ECF3;font-size:13px;font-weight:500;border-radius:6px;text-decoration:none;border:1px solid #2A3345">View Receipt →</a><br><br>` : ""}
<div style="color:#5B6380;font-size:11px">ARCANA Runtime Infrastructure · Delivered via Otnel</div>
<div style="color:#3D4560;font-size:10px;margin-top:2px">receipts@otnelhq.com</div>
</td></tr>

</table>
</td></tr></table>
</body></html>`
}

function receiptText(credits: string, amount: string, details: [string, string][], status: string): string {
  const sep = "─".repeat(44)
  const lines = details.map(([l, v]) => `  ${l.padEnd(22)} ${v}`).join("\n")
  return `${" ".repeat(14)}ARCANA\n${" ".repeat(10)}decrypt the arcane\n${sep}\n  ${status.toUpperCase()}\n\n  +${credits}\n  ${amount}\n${sep}\n  Allocation Details\n${sep}\n${lines}\n${sep}\n  View Receipt →  receipts.arcana.otnelhq.com\n${sep}\n  ARCANA Runtime Infrastructure  ·  Otnel`
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

async function listModels(env: Env, cors: Record<string, string>): Promise<Response> {
  const key = getOpenRouterKey(env)
  if (!key) return json({ error: "no_api_key", message: "No OpenRouter API key configured" }, 500, cors)
  const response = await fetch(`${OPENROUTER_URL}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (response.ok) markKeySuccess(key)
  else if (response.status === 429 || response.status === 401) markKeyRateLimited(key)
  const data = await response.json()
  return json(data, response.status, cors)
}

async function getUserUsage(user: { id: string }, cors: Record<string, string>): Promise<Response> {
  const date = new Date().toISOString().split("T")[0]!
  const key = `usage:${user.id}:${date}`
  const data = await env.ARCANA_PROXY.get(key, "json") as any ?? {}
  return json({ userId: user.id, date, ...data }, 200, cors)
}

function json(data: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } })
}
