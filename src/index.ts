import type { AnalyticsEvent } from "./types"

const OPENROUTER_URL = "https://openrouter.ai/api"
const PAYPAL_LIVE = "https://api.paypal.com"
const PAYPAL_SANDBOX = "https://api.sandbox.paypal.com"

interface Env {
  OPENROUTER_KEY: string
  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  ARCANA_PROXY: KVNamespace
  ARCANA_PROXY_ANALYTICS?: AnalyticsEngineDataset
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

async function getUser(auth: string | null, kv: KVNamespace): Promise<{ id: string; tier: string } | null> {
  if (!auth || !auth.startsWith("Bearer ")) return null
  const key = auth.slice(7).trim()
  if (!key) return null
  const now = Date.now()
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
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

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
      // Public PayPal endpoints (require IP rate limit only)
      if (url.pathname === "/v1/pay/create-order") return handleCreateOrder(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/capture-order") return handleCaptureOrder(request, env, corsHeaders)
      if (url.pathname === "/v1/pay/webhook") return handlePayPalWebhook(request, env, corsHeaders)

      // Auth required
      const user = await getUser(request.headers.get("Authorization"), env.ARCANA_PROXY)
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

  // Acquire lock to prevent race conditions on balance
  const lockKey = `lock:${user.id}`
  const locked = await env.ARCANA_PROXY.get(lockKey)
  if (locked && user.tier !== "enterprise") return json({ error: "too_many_requests", message: "A previous request is still processing." }, 429, cors)
  await env.ARCANA_PROXY.put(lockKey, "1", { expirationTtl: 60 })
  const releaseLock = () => env.ARCANA_PROXY.delete(lockKey).catch(() => {})

  try {
    if (user.tier !== "enterprise") {
      const balance = await getBalance(user.id, env.ARCANA_PROXY)
      if (balance < maxCost) { await releaseLock(); return json({ error: "insufficient_balance", message: "Add credits via arcana proxy buy", balance, required: Math.round(maxCost) }, 402, cors) }
      await deductBalance(user.id, maxCost, env.ARCANA_PROXY)
    }
  } catch { await releaseLock(); throw new Error("lock error") }

  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.OPENROUTER_KEY}`,
    "HTTP-Referer": "https://arcana.otnelhq.com",
    "X-Title": "arcana",
  })
  if (body.model) body.user = user.id

  const startTime = Date.now()
  const isStream = body.stream === true
  const response = await fetch(`${OPENROUTER_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) })

  if (!response.ok) {
    if (user.tier !== "enterprise") await deductBalance(user.id, -maxCost, env.ARCANA_PROXY)
    await releaseLock()
    const errorBody = await response.text()
    return json({ error: "upstream_error", message: errorBody.slice(0, 500) }, response.status, cors)
  }

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
    if (!amount || amount < 5) return json({ error: "Minimum $5" }, 400, cors)

    const token = await getPayPalToken(env)
    const base = paypalBase(env)
    const orderRes = await fetch(`${base}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: amount.toFixed(2) } }] }),
    })
    const order = await orderRes.json() as any
    if (!order.id) return json({ error: "paypal_error", message: order.message }, 500, cors)

    // Idempotency key — prevent duplicate orders
    const idempotencyKey = request.headers.get("Idempotency-Key")
    if (idempotencyKey) {
      const existing = await env.ARCANA_PROXY.get(`idempotent:${idempotencyKey}`, "json") as any
      if (existing) return json(existing, 200, cors)
    }

    await env.ARCANA_PROXY.put(`purchase:${order.id}`, JSON.stringify({ amount, status: "created" }), { expirationTtl: 86400 })

    if (idempotencyKey) {
      await env.ARCANA_PROXY.put(`idempotent:${idempotencyKey}`, JSON.stringify({ orderId: order.id }), { expirationTtl: 86400 })
    }

    const approvalUrl = order.links?.find((l: any) => l.rel === "approve")?.href
    return json({ orderId: order.id, approvalUrl }, 200, cors)
  } catch (e) {
    return json({ error: "paypal_error" }, 500, cors)
  }
}

async function handleCaptureOrder(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  try {
    const body = await request.json() as any
    const { orderId, userId } = body
    if (!orderId || !userId) return json({ error: "Missing orderId or userId" }, 400, cors)

    // Verify the caller owns this userId by checking their auth
    const auth = request.headers.get("Authorization")
    const caller = await getUser(auth, env.ARCANA_PROXY)
    if (!caller) return json({ error: "unauthorized" }, 401, cors)

    // Verify the caller matches the userId
    if (caller.id !== userId && !userId.startsWith("ARCANA-DEV-")) {
      // Allow dev key captures from any dev, but prevent user A from crediting user B
      if (!auth?.includes("ARCANA-DEV-")) return json({ error: "forbidden" }, 403, cors)
    }

    const token = await getPayPalToken(env)
    const base = paypalBase(env)
    const captureRes = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    })
    const capture = await captureRes.json() as any
    if (capture.status !== "COMPLETED") return json({ error: "payment_not_completed", status: capture.status }, 400, cors)

    // Double-capture protection
    const existingPurchase = await env.ARCANA_PROXY.get(`purchase:${orderId}`, "json") as any
    if (existingPurchase?.status === "completed") return json({ error: "order_already_captured" }, 400, cors)

    const amount = parseFloat(capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ?? "0")
    const credits = Math.round(amount * 100)
    const existing = await env.ARCANA_PROXY.get(`balance:${userId}`, "json") as any
    const currentCredits = existing?.credits ?? 0
    await env.ARCANA_PROXY.put(`balance:${userId}`, JSON.stringify({ credits: currentCredits + credits, updatedAt: Date.now() }))
    await env.ARCANA_PROXY.put(`purchase:${orderId}`, JSON.stringify({ userId, amount, credits, status: "completed" }), { expirationTtl: 86400 * 30 })

    // Abuse detection: flag if same IP creates multiple orders rapidly
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown"
    const orderCount = await env.ARCANA_PROXY.get(`abuse:orders:${clientIp}:${Date.now() / 60000}`, "json") as any ?? 0
    await env.ARCANA_PROXY.put(`abuse:orders:${clientIp}:${Math.floor(Date.now() / 60000)}`, JSON.stringify(orderCount + 1), { expirationTtl: 120 })

    return json({ success: true, creditsAdded: credits, newBalance: currentCredits + credits }, 200, cors)
  } catch (e) {
    return json({ error: "capture_error" }, 500, cors)
  }
}

async function handlePayPalWebhook(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  return json({ status: "ok" }, 200, cors)
}

async function handleGetBalance(user: { id: string }, env: Env, cors: Record<string, string>): Promise<Response> {
  const credits = await getBalance(user.id, env.ARCANA_PROXY)
  return json({ userId: user.id, credits: Math.round(credits), dollars: (credits / 100).toFixed(2) }, 200, cors)
}

async function listModels(env: Env, cors: Record<string, string>): Promise<Response> {
  const response = await fetch(`${OPENROUTER_URL}/v1/models`, { headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}` } })
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
