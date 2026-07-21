#!/usr/bin/env node
// scripts/doc-sync-check.mjs
//
// Verifies that the strings the proxy doc claims are actually present in the
// proxy source. Exits 0 if every claim is verified, 1 on the first miss.
//
// Scope: the proxy's runtime source (src/index.ts, src/warm.ts, src/container.ts,
// wrangler.jsonc, wrangler.warm.jsonc). The check is intentionally conservative
// — it only verifies the strings the doc explicitly cites, not every plausible
// reference. Adding a new constant or env var to the source should add a line to
// CLAIMS below in the same commit; otherwise CI (when wired) will fail.
//
// Run: `node scripts/doc-sync-check.mjs`
//      or `npm run docs:check` (added in this commit)

import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")

const SRC = [
  "src/index.ts",
  "src/warm.ts",
  "src/container.ts",
  "src/types.ts",
]
const CONFIG = ["wrangler.jsonc", "wrangler.warm.jsonc"]

const sources = new Map()
for (const f of [...SRC, ...CONFIG]) {
  const p = join(root, f)
  if (existsSync(p)) sources.set(f, readFileSync(p, "utf8"))
}

let failures = 0
let passes = 0
function check(label, file, needle, opts = {}) {
  const hay = sources.get(file)
  if (!hay) {
    console.error(`MISS SOURCE  ${label}  -> ${file}`)
    failures++
    return
  }
  if (hay.includes(needle)) {
    if (!opts.quiet) console.log(`  ok        ${label}`)
    passes++
  } else {
    console.error(`FAIL        ${label}`)
    console.error(`            expected in: ${file}`)
    console.error(`            needle:      ${JSON.stringify(needle)}`)
    failures++
  }
}

console.log("doc-sync-check: verifying that docs/providers-free-usage-deploy.md claims are present in source")
console.log("")

// --- Endpoint paths claimed in the endpoint table ---
const paths = [
  "/v1/chat/completions",
  "/v1/embeddings",
  "/v1/models",
  "/v1/usage",
  "/v1/balance",
  "/v1/sessions",
  "/v1/purchases",
  "/v1/profile",
  "/v1/free-usage/sessions/current",
  "/v1/send-receipt",
  "/v1/auth/resolve-email",
  "/v1/identity/validate-email",
  "/v1/trial/start",
  "/v1/pay/create-order",
  "/v1/pay/capture-order",
  "/v1/pay/capture-return",
  "/v1/pay/webhook",
  "/v1/pay/setup-plans",
  "/v1/pay/create-sub",
  "/v1/pay/sub-status",
  "/v1/admin/providers",
  "/v1/health",
]
console.log("Endpoints:")
for (const p of paths) check(`/v1 endpoint "${p}"`, "src/index.ts", p)

// --- Env var names claimed in the deploy section ---
const envVars = [
  "OPENROUTER_KEY", "OPENROUTER_KEYS",
  "AIHUBMIX_KEY", "AIHUBMIX_KEYS",
  "CLOUDFLARE_KEY", "CLOUDFLARE_KEYS", "CLOUDFLARE_ACCOUNT_ID",
  "OMNIRoute_KEY", "OMNIRoute_KEYS",
  "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_SANDBOX", "PAYPAL_WEBHOOK_ID",
  "ARCANA_ADMIN_KEY", "ARCANA_ADMIN_KEYS",
  "ARCANA_PROXY", "ARCANA_LICENSE", "ARCANA_PROXY_ANALYTICS",
  "EMAIL", "TRIAL_ENABLED", "MERCHANT_ID",
  "OMNIRoute_WARM", "OMNIRoute_WARM_QUEUE",
]
console.log("\nEnv / binding names:")
for (const v of envVars) check(`binding/env "${v}"`, "src/index.ts", v)

// --- Free-tier constants claimed in the limits table ---
const constants = [
  "FREE_SESSION_TURN_LIMIT",
  "FREE_SESSION_DURATION_MS",
  "FREE_SESSION_RESET_MS",
  "FREE_TURN_PROVIDER_CALL_LIMIT",
  "FREE_MAX_INPUT_TOKENS",
  "FREE_MAX_OUTPUT_TOKENS",
  "FREE_PROVIDER_ATTEMPT_LIMIT",
  "FREE_WEEKLY_TOKEN_AGGREGATE",
  "FREE_IP_RATE_LIMIT",
  "FREE_USER_RATE_LIMIT",
]
console.log("\nFree-tier constants:")
for (const c of constants) check(`constant "${c}"`, "src/index.ts", c)

// --- Rejection codes claimed in the rejection table ---
// free_turn_limit_reached and free_weekly_token_limit_reached were retired:
// turns are now a soft display threshold and tokens are unlimited. The only
// remaining terminal reject is free_session_expired (the 60-minute window).
const rejectionCodes = [
  "free_session_expired",
  "free_session_conversation_mismatch",
  "free_turn_budget_reached",
]
console.log("\nFree-tier rejection codes (free_turn_limit_reached / free_weekly_token_limit_reached retired — turns soft, tokens unlimited; free_weekly_cooldown never emitted):")
for (const c of rejectionCodes) check(`rejection code "${c}"`, "src/index.ts", c)

// --- Response headers claimed in the headers table ---
const responseHeaders = [
  "X-Arcana-Free-State",
  "X-Arcana-Free-Used",
  "X-Arcana-Free-Remaining",
  "X-Arcana-Free-Limit",
  "X-Arcana-Free-Expires-At",
  "X-Arcana-Free-Reset-At",
  "X-Arcana-Free-Tokens-Used",
  "X-Arcana-Free-Tokens-Limit",
  "X-Arcana-Free-Tokens-Remaining",
  "X-Provider",
  "X-RateLimit-Remaining",
]
console.log("\nResponse headers:")
for (const h of responseHeaders) check(`response header "${h}"`, "src/index.ts", h)

// --- Request headers claimed in the CORS note ---
const requestHeaders = [
  "X-Arcana-Request",
  "X-Arcana-Turn",
  "X-Arcana-Turn-Id",
  "X-Arcana-Session",
  "X-Arcana-Session-Id",
]
console.log("\nRequest headers (CORS allowlist):")
for (const h of requestHeaders) check(`request header "${h}"`, "src/index.ts", h)

// --- Provider prefixes claimed in the routing section ---
const providerPrefixes = ["or/", "omni/", "aihub/", "aihubmix/", "cf/", "cloudflare/"]
console.log("\nProvider prefix resolution:")
for (const p of providerPrefixes) check(`prefix "${p}"`, "src/index.ts", `startsWith("${p}")`)

// --- Provider names ---
const providerNames = ["openrouter", "omniroute", "aihubmix", "cloudflare"]
console.log("\nProvider names in Provider union / admin guard:")
for (const p of providerNames) check(`provider "${p}"`, "src/index.ts", `"${p}"`)

// --- Upstream URLs ---
const upstreamUrls = [
  "https://openrouter.ai/api",
  "https://aihubmix.com",
  "https://api.inferera.com",
  "https://api.cloudflare.com/client/v4/accounts/",
]
console.log("\nUpstream URLs:")
for (const u of upstreamUrls) check(`upstream "${u}"`, "src/index.ts", u)

// --- wrangler config: vars and bindings ---
const wranglerBindings = [
  "ARCANA_PROXY", "ARCANA_LICENSE", "ARCANA_PROXY_ANALYTICS",
  "OMNIRoute_WARM", "OMNIRoute_WARM_QUEUE",
  "OMNIRoute", "OmniRouteContainer",
]
console.log("\nwrangler.jsonc bindings:")
for (const b of wranglerBindings) check(`binding "${b}"`, "wrangler.jsonc", b)

// --- Summary ---
console.log("")
console.log(`doc-sync-check: ${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.error("")
  console.error("Some doc claims are not present in the source. Either:")
  console.error("  1. The doc is wrong — fix docs/providers-free-usage-deploy.md")
  console.error("  2. The source is wrong — fix the source, then update the doc in the same commit")
  console.error("  3. The doc references something the source has under a different name — add")
  console.error("     a note in the comment above the check() call explaining the divergence")
  process.exit(1)
}
process.exit(0)