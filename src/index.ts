import type { AnalyticsEvent } from "./types"

const OPENROUTER_URL = "https://openrouter.ai/api"

interface Env {
  OPENROUTER_KEY: string
  ARCANA_PROXY: KVNamespace
  ARCANA_PROXY_ANALYTICS?: AnalyticsEngineDataset
}

// In-memory rate limits — resets on Worker restart
const rateLimits = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 25
const RATE_WINDOW = 60000

// Cached licenses from KV — refreshed every 5 min
let licenseCache: Map<string, UserInfo> | null = null
let licenseCacheTime = 0
const LICENSE_CACHE_TTL = 300000

async function getUser(auth: string | null, kv: KVNamespace): Promise<{ id: string; tier: string } | null> {
  if (!auth || !auth.startsWith("Bearer ")) return null
  const key = auth.slice(7).trim()
  if (!key) return null

  const now = Date.now()
  if (!licenseCache || now - licenseCacheTime > LICENSE_CACHE_TTL) {
    licenseCache = new Map()
    licenseCacheTime = now
  }

  let user = licenseCache.get(key)
  if (user) return user

  const raw = await kv.get(`license:${key}`, "json") as { id: string; tier: string } | null
  if (raw) {
    licenseCache.set(key, raw)
    return raw
  }

  // Check for dev key
  if (key.startsWith("ARCANA-DEV-")) {
    user = { id: "dev-user", tier: "enterprise" }
    licenseCache.set(key, user)
    return user
  }

  return null
}

function checkRateLimit(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const entry = rateLimits.get(userId)
  if (!entry || now > entry.resetAt) {
    rateLimits.set(userId, { count: 1, resetAt: now + RATE_WINDOW })
    return { allowed: true, remaining: RATE_LIMIT - 1 }
  }
  if (entry.count >= RATE_LIMIT) return { allowed: false, remaining: 0 }
  entry.count++
  return { allowed: true, remaining: RATE_LIMIT - entry.count }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

    try {
      // Auth
      const user = await getUser(request.headers.get("Authorization"), env.ARCANA_PROXY)
      if (!user) return json({ error: "unauthorized", message: "Invalid or missing API key. Get one at https://arcana.otnelhq.com" }, 401, corsHeaders)

      // Rate limit
      const rl = checkRateLimit(user.id)
      if (!rl.allowed) return json({ error: "rate_limited", message: "25 requests per minute max", remaining: 0 }, 429, corsHeaders)

      // Route
      switch (url.pathname) {
        case "/v1/chat/completions":
        case "/v1/embeddings":
          return proxyOpenRouter(request, env, user, corsHeaders, url.pathname)

        case "/v1/models":
          return listModels(env, corsHeaders)

        case "/v1/usage":
          return getUserUsage(user, corsHeaders)

        case "/v1/health":
          return json({ status: "ok", service: "arcana-proxy", user: user.id, tier: user.tier }, 200, corsHeaders)

        default:
          return json({ error: "not_found" }, 404, corsHeaders)
      }
    } catch (e) {
      return json({ error: "internal_error", message: String(e) }, 500, corsHeaders)
    }
  },
}

async function proxyOpenRouter(request: Request, env: Env, user: { id: string; tier: string }, cors: Record<string, string>, path: string): Promise<Response> {
  const body = await request.json() as any
  if (!body.model) return json({ error: "model_required" }, 400, cors)

  // Enrich request with OpenRouter-specific headers
  const headers = new Headers({
    "Content-Type": "application/json",
    "Authorization": `Bearer ${env.OPENROUTER_KEY}`,
    "HTTP-Referer": "https://arcana.otnelhq.com",
    "X-Title": "arcana",
  })

  // Append user ID for tracking
  if (body.model) body.user = user.id

  const startTime = Date.now()
  const isStream = body.stream === true

  const response = await fetch(`${OPENROUTER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    return json({ error: "upstream_error", message: errorBody.slice(0, 500) }, response.status, cors)
  }

  if (isStream && response.body) {
    // Track usage after stream ends
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullResponse = ""

    ;(async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          fullResponse += chunk
          await writer.write(value)
        }
      } catch {} finally {
        await writer.close()
        // Log usage asynchronously — doesn't block the response
        const usage = extractUsage(fullResponse, body.model)
        if (usage) logUsage(env, user, body.model, usage, Date.now() - startTime)
      }
    })()

    return new Response(readable, {
      status: response.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...cors,
      },
    })
  }

  // Non-streaming — parse response and add usage tracking
  const data = await response.json() as any
  if (data.usage) {
    const usage = {
      inputTokens: data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0,
      outputTokens: data.usage.completion_tokens ?? data.usage.output_tokens ?? 0,
    }
    logUsage(env, user, body.model, usage, Date.now() - startTime)
  }

  return json(data, response.status, cors)
}

function extractUsage(responseText: string, model: string): { inputTokens: number; outputTokens: number } | null {
  try {
    const lines = responseText.split("\n").filter((l) => l.startsWith("data: "))
    const last = lines[lines.length - 1]
    if (!last || last === "data: [DONE]") return null
    const parsed = JSON.parse(last.slice(6))
    if (parsed.usage) {
      return {
        inputTokens: parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? 0,
        outputTokens: parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? 0,
      }
    }
    return null
  } catch { return null }
}

async function logUsage(env: Env, user: { id: string; tier: string }, model: string, usage: { inputTokens: number; outputTokens: number }, duration: number) {
  try {
    // Analytics Engine (primary)
    if (env.ARCANA_PROXY_ANALYTICS) {
      env.ARCANA_PROXY_ANALYTICS.writeDataPoint({
        blobs: [user.id, model, user.tier],
        doubles: [usage.inputTokens, usage.outputTokens, duration],
      })
    }

    // KV fallback (daily aggregation)
    const date = new Date().toISOString().split("T")[0]!
    const key = `usage:${user.id}:${date}`
    const current = await env.ARCANA_PROXY.get(key, "json") as any ?? {}
    current.tokensIn = (current.tokensIn ?? 0) + usage.inputTokens
    current.tokensOut = (current.tokensOut ?? 0) + usage.outputTokens
    current.requests = (current.requests ?? 0) + 1
    await env.ARCANA_PROXY.put(key, JSON.stringify(current), { expirationTtl: 86400 * 31 })
  } catch {} // best-effort
}

async function listModels(env: Env, cors: Record<string, string>): Promise<Response> {
  const response = await fetch(`${OPENROUTER_URL}/v1/models`, {
    headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}` },
  })
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
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}
