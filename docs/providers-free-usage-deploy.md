---
aliases: [arcana-proxy, providers, free-usage, cloudflare, workers-ai, aihubmix, omniroute]
tags: [arcana, proxy, providers, free-tier, cloudflare, workers-ai]
date: 2026-07-19
status: shipped
---

# arcana-proxy — providers, free-usage, deploy

> Reference for the deployed proxy (Cloudflare Worker at `proxy.arcana.otnelhq.com`).
> Source of truth for the runtime: `L:\PROJECTS\arcana-proxy\src\index.ts`. Spec for the
> free-usage behavior: `L:\PROJECTS\arcana\docs\free-usage-weekly-session-plan.md`.
> If they disagree, the code is authoritative for behavior, the spec is authoritative for policy.

## What this is

`arcana-proxy` is a Cloudflare Worker that fronts multiple LLM providers behind one OpenAI-compatible
endpoint. It does authentication, per-user rate limiting, free-usage enforcement, provider failover,
and Analytics-Engine logging. The container for OmniRoute (a self-hosted LiteLLM) is owned by a
separate Worker (`arcana-omniroute-warm`, defined by `wrangler.warm.jsonc`) and reached via a service
binding.

Endpoints:

| Path | Method | Purpose |
| --- | --- | --- |
| `/v1/chat/completions` | POST | OpenAI-compatible chat completions |
| `/v1/embeddings` | POST | OpenAI-compatible embeddings (same dispatch path as chat) |
| `/v1/models` | GET | Merged model catalog across all configured providers |
| `/v1/usage` | GET | Caller's daily usage counters |
| `/v1/balance` | GET | Caller's credit balance |
| `/v1/sessions` | GET | Caller's session history (paginated) |
| `/v1/sessions/<id>` | GET | Single session detail (UUID in path) |
| `/v1/memory` | GET, PUT/POST, DELETE | Personal cloud memory facts (CLI sync + web) |
| `/v1/memory/<key>` | DELETE | Delete one memory fact by key |
| `/v1/purchases` | GET | Caller's purchase history |
| `/v1/profile` | GET, PUT | Caller's profile |
| `/v1/free-usage/sessions/current` | GET | Authoritative free-tier status for the calling user |
| `/v1/send-receipt` | POST | Send a test receipt email (admin only, uses `EMAIL` binding) |
| `/v1/auth/resolve-email` | GET | Reverse-lookup a license key/sub id by email |
| `/v1/identity/validate-email` | GET | Validate an email is a known subscriber |
| `/v1/trial/start` | POST | Start a 14-day Pro trial (one per IP, gated by `TRIAL_ENABLED=true`) |
| `/v1/pay/create-order` | POST | PayPal order create (credit purchase) |
| `/v1/pay/capture-order` | POST | CLI flow: capture a PayPal order |
| `/v1/pay/capture-return` | GET, POST | Web flow: capture a PayPal order after redirect |
| `/v1/pay/webhook` | POST | PayPal webhook (verified with `PAYPAL_WEBHOOK_ID`) |
| `/v1/pay/setup-plans` | POST | Admin: create the PayPal product + plans |
| `/v1/pay/create-sub` | POST | Admin: create a PayPal subscription |
| `/v1/pay/sub-status` | GET | Admin: check a subscription's status |
| `/v1/admin/providers` | GET | Admin: read the active provider priority list |
| `/v1/admin/providers` | PUT | Admin: set the provider priority list |
| `/v1/health` | GET | Liveness probe |

CORS preflight (OPTIONS) is allowed on all paths. The `Access-Control-Allow-Headers` whitelist
includes: `Content-Type, Authorization, X-Arcana-Request, X-Arcana-Turn, X-Arcana-Turn-Id,
X-Arcana-Session, X-Arcana-Session-Id`. The `X-Arcana-Turn-Id` / `X-Arcana-Turn` / `X-Arcana-Request`
headers carry the per-turn idempotency key consumed by the free-tier reservation; the
`X-Arcana-Session` / `X-Arcana-Session-Id` headers carry the conversation key for free-session
binding.

## Provider routing model — read this first

The proxy has two different "which provider do I send this to" mechanisms. They are not the same
thing, and conflating them is the single most common source of confusion.

1. **Provider prefix — explicit routing.** The model name in the request body can be prefixed to
   force a specific provider:
   - `or/<model>` → OpenRouter
   - `omni/<model>` → OmniRoute
   - `aihub/<model>` or `aihubmix/<model>` → AIHubMix (Inferera fallback on hard fail)
   - `cf/<model>` or `cloudflare/<model>` → Cloudflare Workers AI

   This is the **primary** way to route a request. If the request has one of these prefixes, only
   the named provider is used; the priority list is ignored for that request.

2. **Provider priority list — failover.** When the model name has no prefix, the request is routed
   through the providers in the order they appear in the priority list. The first provider whose
   pre-flight passes is tried; if it returns a hard 5xx, 429, or 401, the next provider is tried;
   any 4xx other than 401 is treated as a client bug and returned as-is without failover.

   The priority list is stored in the `ARCANA_PROXY` KV namespace under the key `provider:priority`
   and is set via `PUT /v1/admin/providers`. The admin handler validates every entry against a
   whitelist (`openrouter | omniroute | aihubmix | cloudflare`) and rejects the request if any
   provider in the list is not configured.

**Implication:** putting `cloudflare` in the priority list does not make Workers AI the default
upstream for bare model names — `openrouter` is still tried first. It only means that if openrouter
hard-fails, the next attempt will be cloudflare. To actually use Workers AI for a given request,
use the `cf/` or `cloudflare/` prefix.

This is the right model. The priority list is a *resilience* mechanism (a flaky model on one provider
shouldn't take down the user), and the prefix is a *routing* mechanism (the caller wants this
specific provider). Mixing them — using the priority list as a "default order" — leads to silent
behavior changes when providers are added or removed, and to a priority list that's hard to reason
about. The current model is explicit on both axes.

## Providers

| Provider | Auth | Default upstream | Fallback | Notes |
| --- | --- | --- | --- | --- |
| `openrouter` | `OPENROUTER_KEY` or `OPENROUTER_KEYS` (rotating pool) | `https://openrouter.ai/api` | — | First in default priority list. Bearer auth. |
| `aihubmix` | `AIHUBMIX_KEY` or `AIHUBMIX_KEYS` (rotating pool) | `https://aihubmix.com` | `https://api.inferera.com` (on hard 5xx from primary) | Bearer auth. |
| `cloudflare` | `CLOUDFLARE_KEY` or `CLOUDFLARE_KEYS` (rotating pool) | `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1` | — | Bearer auth. Rotating tokens do not help with upstream rate limits (CF rate-limits per-account, not per-token). |
| `omniroute` | `OMNIRoute_KEY` or `OMNIRoute_KEYS` (rotating pool) | Service binding to `arcana-omniroute-warm` Worker | — | The container is owned by the warm Worker; the proxy reaches it via a service-binding RPC named `omFetch`. The container is not addressable from the proxy directly. |

**Other response headers worth knowing:**

- `X-Provider`: set on successful chat-completion responses; value is the provider that actually served the request (e.g. `openrouter`, `aihubmix`, `cloudflare`, `omniroute`). Useful for debugging which provider answered when a request fell through the failover chain.
- `X-RateLimit-Remaining`: set on responses from the per-day limit check (the `checkDailyLimit` path). Value is the integer turns/days remaining for the calling user on the current calendar day. Not set on free-tier responses (those use the `X-Arcana-Free-*` family).

Key pool behavior (mirrored across all four providers):

- Tokens are rotated round-robin, with cooldown on 429 and 401 responses.
- Cooldown starts at 30 seconds and backs off exponentially (30s, 60s, 120s, 240s) up to a 5-minute
  hard cap after 3 consecutive failures.
- A key that hits `KEY_MAX_FAILURES` (3) is ejected for 5 minutes regardless of cooldown timing.

## Deploy

The proxy ships as a single Cloudflare Worker. Two pre-deploy steps and a `wrangler deploy`.

### 1. Secrets (per provider)

```powershell
cd L:\PROJECTS\arcana-proxy

# OpenRouter — pick one
npx wrangler secret put OPENROUTER_KEY
# or for rotation:
npx wrangler secret put OPENROUTER_KEYS     # comma-separated

# AIHubMix — pick one
npx wrangler secret put AIHUBMIX_KEY
# or for rotation:
npx wrangler secret put AIHUBMIX_KEYS

# Cloudflare Workers AI — pick one. The token needs the "Workers AI: Read" permission.
npx wrangler secret put CLOUDFLARE_KEY
# or for rotation:
npx wrangler secret put CLOUDFLARE_KEYS

# OmniRoute (only if you intend to use the OmniRoute container)
npx wrangler secret put OMNIRoute_KEY
# or for rotation:
npx wrangler secret put OMNIRoute_KEYS
```

### 2. Public vars

```powershell
# Cloudflare account ID — public identifier, lives in `vars` not secrets.
# Find it in the Cloudflare dashboard URL or via `wrangler whoami`.
npx wrangler var put CLOUDFLARE_ACCOUNT_ID
# Type your 32-char hex account ID at the prompt.
```

> **Order matters.** Set `CLOUDFLARE_ACCOUNT_ID` and the Cloudflare key *before* adding
> `"cloudflare"` to the admin priority list. The admin handler will reject the list if either is
> missing, and an unconfigured list results in 404s at the CF edge when cloudflare is in the
> failover chain.

### 3. Deploy

```powershell
npx wrangler deploy
# or for staging (shares the same KV namespace as production — see wrangler.jsonc warning):
npx wrangler deploy --env staging
```

### 4. Set the priority list (optional — only if you want failover)

The default priority list is `["openrouter"]` if no list is in KV. Bare model names will route
to OpenRouter only. To add failover:

```powershell
$headers = @{
  Authorization  = "Bearer <ARCANA_ADMIN_KEY>"
  "Content-Type" = "application/json"
}

Invoke-RestMethod -Method Put `
  -Uri "https://proxy.arcana.otnelhq.com/v1/admin/providers" `
  -Headers $headers `
  -Body '{"priority":["openrouter","aihubmix","cloudflare","omniroute"]}'
```

Read the current list:

```powershell
Invoke-RestMethod -Method Get `
  -Uri "https://proxy.arcana.otnelhq.com/v1/admin/providers" `
  -Headers $headers
```

### 5. Verify

```powershell
# Models (should include prefixed entries for each configured provider)
Invoke-RestMethod -Method Get `
  -Uri "https://proxy.arcana.otnelhq.com/v1/models" `
  -Headers $headers

# Chat completion against a specific provider via prefix
$body = @{
  model    = "cf/@cf/meta/llama-3.1-70b-instruct"
  messages = @(@{ role = "user"; content = "Hello" })
  stream   = $false
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri "https://proxy.arcana.otnelhq.com/v1/chat/completions" `
  -Headers @{ Authorization = "Bearer <ARCANA_PROXY_KEY>"; "Content-Type" = "application/json" } `
  -Body $body
```

## Free-tier throttle

Free users (`tier === "free"`) are subject to the following limits. The spec lives in
`L:\PROJECTS\arcana\docs\free-usage-weekly-session-plan.md`; this is the runtime contract.

| Limit | Value | Where it lives | Rejection code |
| --- | --- | --- | --- |
| Sessions per reset period | 1 | `FREE_SESSION_RESET_MS` (7 days, anchored to `activated_at`) | _not enforced_ (see note above) |
| Session duration | 60 minutes | `FREE_SESSION_DURATION_MS` | `free_session_expired` |
| Turn allowance | 10 turns | `FREE_SESSION_TURN_LIMIT` | `free_turn_limit_reached` |
| Per-turn input cap | 16,384 raw input tokens | `FREE_MAX_INPUT_TOKENS` | `free_turn_budget_reached` |
| Per-turn output cap | 2,048 output tokens | `FREE_MAX_OUTPUT_TOKENS` (clamped via `clampFreeRequestBody`) | — (silent) |
| Per-turn provider calls | 2 (original + one failover on hard 5xx/429) | `FREE_TURN_PROVIDER_CALL_LIMIT` | `free_turn_budget_reached` |
| Per-provider failover attempts | 2 (only when not forced via prefix) | `FREE_PROVIDER_ATTEMPT_LIMIT` | — |
| Burst limit (IP) | 20 req/min | `FREE_IP_RATE_LIMIT` | `rate_limited` |
| Burst limit (user) | 8 req/min | `FREE_USER_RATE_LIMIT` | `rate_limited` |
| Weekly token aggregate | 200,000 combined in+out tokens per subject-key | `FREE_WEEKLY_TOKEN_AGGREGATE` | `free_weekly_token_limit_reached` |

The weekly reset anchor is `activated_at` (the timestamp of the first admitted free turn), not
`resetAt` of the prior record. Exhausting turns early does not move the reset forward. The
`tokensUsed` counter is updated only on `completed` turn settlements — a failed turn does not
drain the weekly allowance.

### Free-usage response headers

The proxy emits the following response headers on every chat-completion response to a free user
(headers are absent for paid users, which is intentional — paid users have no per-week aggregate
to surface):

| Header | Meaning |
| --- | --- |
| `X-Arcana-Free-State` | One of `eligible`, `active`, `exhausted`, `expired` |
| `X-Arcana-Free-Used` | Turns used in the current weekly session |
| `X-Arcana-Free-Remaining` | Turns remaining (`max(0, 10 - used)`) |
| `X-Arcana-Free-Limit` | Total turns per session (10) |
| `X-Arcana-Free-Expires-At` | ISO 8601; when the 1-hour active window ends |
| `X-Arcana-Free-Reset-At` | ISO 8601; when the 7-day reset fires |
| `X-Arcana-Free-Tokens-Used` | Combined in+out tokens settled across this weekly record |
| `X-Arcana-Free-Tokens-Limit` | 200,000 |
| `X-Arcana-Free-Tokens-Remaining` | `max(0, 200000 - tokensUsed)` |

**Note on token count freshness:** the token counters in the response headers reflect the
*pre-turn* snapshot from `reserveFreeTurn`. The `settleFreeTurn` that increments `tokensUsed`
runs in `ctx.waitUntil` (fire-and-forget) and writes the updated value to KV, which is eventually
consistent. The next request that hits `reserveFreeTurn` will see the updated count. A client that
only reads headers (and never makes a second request) will see the count from before the current
turn.

### Rejection codes

All free-tier rejections return HTTP 429. The response body includes `error` (the stable code),
`message` (human-readable), and `freeUsage` (the full snapshot — same shape as the response
headers, plus `used` and `remaining` integer fields).

| Code | Meaning |
| --- | --- |
| `free_turn_limit_reached` | All ten turns were admitted. |
| `free_session_expired` | The one-hour active window ended. |
| `free_session_conversation_mismatch` | Another conversation tried to use the active allowance. |
| `free_turn_budget_reached` | One turn exceeded its per-turn provider-call, input, or output ceiling. |
| `free_weekly_token_limit_reached` | The user's weekly combined in+out token allowance is used up. |

> **Note on `free_weekly_cooldown`:** the spec documents this code for the case where a free user
> in their 7-day cooldown window is admitted by the proxy (the proxy sees no record and acts as
> if they are eligible). The proxy **does not** emit this code today — it has no way to detect
> the cooldown state without a Durable Object. This is a known gap that the DO migration will
> close. Until then, a free user who somehow gets through (e.g. by hitting a different turn-id
> for a previously-exhausted conversation) will be admitted but immediately re-`exhausted` on
> the very next turn. UX impact: minor. Security impact: none.

The free-tier spec calls for these errors to be treated as **terminal** on the client side — no
automatic retry. The `Retry-After` header is **not currently set** by the proxy for any of these
codes; the spec lists it as a future addition alongside the DO migration.

### Bypass behavior

Paid users (`tier` is `pro`, `team`, or `enterprise`) bypass the free-tier code path entirely.
Their cost is debited from the `balance:<userId>` KV key. The 50 req/min IP and 25 req/min user
burst limits still apply. Enterprise is uncapped at the cost layer.

The free-tier code path runs only when `tier === "free"`. Trial users (created via
`/v1/trial/start`) get `tier: "pro"` and pay normally.

## Known limits and caveats

These are real, current, and worth knowing before you ship.

1. **Free-usage authoritative store is KV, not a Durable Object.** The free-usage spec explicitly
   calls for a SQLite-backed Durable Object per subject key to guarantee atomic reservation under
   concurrent requests. The current implementation uses the `ARCANA_PROXY` KV namespace under
   the key `free_usage:<sha256("free:" + userId).slice(0,40)>`. KV is eventually consistent and
   read-modify-write is not atomic — two concurrent `reserveFreeTurn` calls for the same subject
   can both read `turnsUsed=9` and both write `turnsUsed=10`, admitting 11 turns instead of 10.
   The DO migration is tracked separately. Two related gaps fall out of this:
   - `free_weekly_cooldown` is documented in the spec but **not emitted** by the proxy — without
     a DO, the proxy has no way to detect the cooldown state (it sees "no record" and admits).
   - Token accumulation is best-effort: the `settleFreeTurn` write goes through `ctx.waitUntil`
     and is not atomic with the response.

2. **The per-turn input cap is enforced against a `content.length / 4` estimate**, not a real
   tokenizer. A free user with 30K characters of markdown English will be rejected (estimated
   ~7.5K tokens, but the check fires at 16K characters); a free user with 10K characters of dense
   emoji will be admitted (estimated 2.5K tokens, real token count likely much higher). This is
   the same approximation the per-user cost estimation uses, and tightening it requires
   client-side tokenization, which is a separate change.

3. **`ctx.waitUntil` settlement means token counts in response headers are pre-turn.** A client
   that polls headers-only will see a frozen count until the next chat request fires. The
   authoritative `GET /v1/free-usage/sessions/current` endpoint always reads the post-settle
   value, modulo KV eventual consistency (typically <1s).

4. **The Cloudflare `cf/<model>` prefix requires the model id to be a valid Workers AI model id.**
   Workers AI returns 404 on unknown models; the proxy surfaces this as a 404 to the client.
   `GET /v1/models` lists the live Workers AI catalog with the `cloudflare/` prefix — use that as
   the source of truth for valid IDs. Note: the catalog includes image and embedding models, not
   just chat; those will fail at `/v1/chat/completions` and the error message from Workers AI will
   be forwarded (sanitized — see the security note in the README).

5. **Rotating Cloudflare tokens does not help with upstream 429s.** Cloudflare rate-limits
   Workers AI per-account, not per-token. The `markCloudflareKeyRateLimited` cooldown logic in the
   proxy is correct (it'll mark all tokens in the pool rate-limited), but it's a no-op against
   the upstream — the cooldown is local to the proxy's view of the world. Use a single token
   unless you have a separate reason to rotate (e.g. the secret was leaked).

6. **The staging environment shares the production KV namespace.** See the warning in
   `wrangler.jsonc`. Staging writes (admin priority list changes, free-usage records, sessions,
   purchases) will collide with production data unless you use a `staging:` key prefix. The
   current code does not, so don't deploy to staging against a live production system without
   coordinating with whoever's watching production.

7. **The OmniRoute container is owned by `arcana-omniroute-warm`.** If that Worker is not deployed
   (or the `OMNIRoute_WARM` service binding is missing from the proxy's `wrangler.jsonc`), the
   `omniroute` entry in the priority list is silently skipped — bare-model requests will route to
   the next provider, and explicit `omni/<model>` requests will 503. There is no runtime warning
   for this; the pre-flight check in `proxyWithFailover` only checks the binding when `omniroute`
   is the *only* provider in `attemptOrder`.

## Endpoint reference

### `GET /v1/models`

Returns the merged model catalog across all configured providers. Model IDs are prefixed:
`or/`, `omni/`, `aihubmix/`, `cloudflare/` (matching the request-side prefix scheme). Provider
fetch errors are surfaced in a separate `errors` array, but a successful fetch from any provider
results in a 200 with whatever was retrieved.

### `GET /v1/free-usage/sessions/current`

Returns the authoritative free-tier snapshot for the calling user. Paid users get
`{ state: "licensed", ... }`. Free users get the full snapshot, including the three token fields
introduced in `cee753e`. Same response shape as the rejection bodies.

### `PUT /v1/admin/providers`

Sets the provider priority list. Body: `{ "priority": ["openrouter", "aihubmix", "cloudflare", "omniroute"] }`.
Whitelist-validated against the `Provider` union. Rejects with 400 if any entry in the list is
not configured (missing key, missing account ID, missing service binding). The list is stored
in KV with a 1-hour TTL (cache bust for stale isolates).

### `GET /v1/admin/providers`

Returns the current priority list, the container-binding status, and the per-provider configured
status (which secrets/vars are present).

## Source map

| File | Purpose |
| --- | --- |
| `src/index.ts` | The whole proxy Worker (router, auth, providers, free-tier, admin). Single file by design. ~110 KB / ~3,400 lines. |
| `src/index.ts` — `proxyOpenRouter` | Direct-path chat completion: handles the `or/`, `cf/`, `cloudflare/` prefixes (cloudflare since `cee753e`); bypasses the priority list. |
| `src/index.ts` — `proxyWithFailover` | Multi-provider dispatch: walks the priority list, handles `omni/`, `aihub/`, `aihubmix/` prefixes, applies free-tier limits to the failover path. |
| `src/container.ts` | `OmniRouteContainer` class (owned by the warm Worker; re-exported here so the binding has a class to reference). |
| `src/warm.ts` | The `arcana-omniroute-warm` Worker: container startup, warm-up queue consumer, service-binding RPC. |
| `src/types.ts` | Shared types (`UserInfo`, `AnalyticsEvent`). |
| `wrangler.jsonc` | Proxy Worker config (KV, Analytics Engine, service bindings, queues). |
| `wrangler.warm.jsonc` | Warm Worker config (container, durable objects, queue consumer). |
| `container/Dockerfile` | OmniRoute (LiteLLM) image. |

## Related

- `L:\PROJECTS\arcana\docs\free-usage-weekly-session-plan.md` — free-usage spec (authoritative for policy).
- `L:\PROJECTS\arcana\docs\architecture\arcana-breaking-change-map.md` — Arcana-native runtime contract.
- `L:\PROJECTS\arcana\.vault\phase2-providers.md` — historical context on the provider router.
- `L:\PROJECTS\arcana-proxy\.github\workflows\deploy.yml` — CI deploy: triggers on push to `master`, runs `npx wrangler deploy` with `secrets.CLOUDFLARE_API_TOKEN`. Manual `workflow_dispatch` is also wired.