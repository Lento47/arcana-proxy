# Changelog

All notable changes to `arcana-proxy` are documented in this file. The latest
release is at the top; older releases are below. The "Source" column links to
the full commit on `Lento47/arcana-proxy` for traceability.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the proxy follows [Semantic Versioning](https://semver.org/) — the next
release will be tagged `2.x` after the durable-object migration for free-usage
lands. Until then, every commit to `master` is a deployable artifact.

## Unreleased

The five commits listed below are currently on `master` but have not been
tagged as a release. The topmost entry is the new hybrid load-sensing
scheduler and per-user cost tracking delivered 2026-07-22.

### Added — `[hash] feat: hybrid load-sensing scheduler + per-user effort score tracking [bump]`

#### Hybrid load-sensing scheduler

Added a dynamic load factor system that adapts per-turn resource allocation
based on two real-time signals:

- **Provider error rate** (60 % weight) — tracked via circuit breaker failures
  across all upstream providers. When > 50 % of requests fail, the load factor
  rises proportionally.
- **Local request rate** (40 % weight) — per-isolate sliding window of
  free-tier LLM requests relative to `FREE_GLOBAL_SOFT_RPM` (120 req/min).

The load factor (0.0–1.0) is smoothed across four bands with smooth scaling
within each band (no hard breakpoints):

| Band | Threshold | Turn timeout | Output tokens | Model failovers | User RPM |
| --- | --- | --- | --- | --- | --- |
| 🟢 Green | 0.00–0.33 | 30→25 s | 100k→60k | 15→10 | 8→6 |
| 🟡 Yellow | 0.33–0.66 | 25→18 s | 60k→30k | 10→6 | 6→4 |
| 🟠 Orange | 0.66–0.85 | 18→12 s | 30k→15k | 6→4 | 4→3 |
| 🔴 Red | 0.85–1.00 | 12→8 s | 15k→8k | 4→2 | 3→2 |

- **Option A caching** — load factor is cached per-isolate for 60 s. When
  stale, the first request recomputes it and lazily writes the raw factor to
  KV (`free:load_factor`, TTL 120 s) via a fire-and-forget promise — zero
  latency impact on the request path.
- **`X-Arcana-Load-Band: green|yellow|orange|red`** — new response header on
  free-tier chat completions so clients can observe the current system state.
- New exports from `src/free-routing.ts`: `LoadFactorConfig`, `LoadLevelBand`,
  `getLoadLevel()`, `computeLoadConfig()`, `scaleResource()`,
  `recordCircuitActivity()`, `computeLocalErrorRate()`, `invalidateLoadLevelCache()`.
- Circuit breaker wired into load sensing — `recordCircuitFailure` /
  `recordCircuitSuccess` now call `recordCircuitActivity()` to feed the
  error-rate signal.

#### Per-user effort score tracking

Each free user accumulates an "effort score" from completed turns that
persists across sessions and deprioritises heavy users during congestion:

```
effortScore = tokensIn × 0.3 + tokensOut × 0.7 + providerCalls × 10
```

- Stored in KV at `user_cost:<sha256(userId).slice(0,20)>` with 90-day TTL
- Score decays 50 % weekly (half-life model) so it self-corrects over time
- **Light users** (< 1,000 score): no shift → default priority
- **Medium users** (1,000–5,000): +0.08 load shift → tighter budgets
- **Heavy users** (> 5,000): +0.15 load shift → most restrictive treatment
- `FreeTurnAdmission` carries `userId` from `reserveFreeTurn` through to
  `settleFreeTurn` — all 12 call sites automatically accumulate effort
  scores without per-site changes.
- New functions in `src/index.ts`: `readUserEffortScore()`,
  `writeUserEffortScore()`, `effortShift()`.

#### Files changed

| File | Lines added |
| --- | --- |
| `src/free-routing.ts` | ~80 (types, bands, scaling, cache, circuit tracking) |
| `src/index.ts` | ~160 (imports, wiring, effort score, dynamic timeout/failover/budgets) |

#### Product promise preserved

| Guarantee | Status |
| --- | --- |
| 10 turns per session (soft display) | ✅ unchanged |
| 1-hour session window | ✅ unchanged |
| Weekly session reset | ✅ unchanged |
| Free tier: OpenRouter only (no paid routes) | ✅ unchanged |

---

### Added — `e52e00c docs(arcana-proxy): accuracy pass against deployed code`

- `docs/providers-free-usage-deploy.md`: corrected ten inaccuracies against the
  deployed code in `src/index.ts`. The doc is now the verified runtime
  reference; treat it as a strict contract.

  Notable corrections:
  - Endpoint table grew from 11 to 24 entries to match the actual router.
  - `free_weekly_cooldown` removed from the rejection table (the proxy never
    emits it; the gap is called out as a known limit to be closed by the DO
    migration).
  - `Retry-After` is set on burst/concurrency 429s (IP/user RPM, free burst,
    global soft limit, daily limit, lock conflict). Free-session terminal
    rejects stay non-retryable without relying on that header.
  - New "Other response headers" block documents `X-Provider` and
    `X-RateLimit-Remaining` (set on per-day-limit responses, not on free-tier
    rejections).

- `scripts/doc-sync-check.mjs`: a 90-line Node script that greps `src/index.ts`
  for the strings the doc claims (every endpoint path, every env-var name,
  every constant name, every rejection code, every X-Arcana-Free-* header)
  and exits non-zero on the first miss. The script is wired into a `package.json`
  `docs:check` npm script. The CI workflow does not run it yet — see "Future
  work" below.

### Added — `2409b63 docs(arcana-proxy): providers, free-usage, deploy reference`

- `docs/providers-free-usage-deploy.md`: new 397-line reference for the deployed
  proxy. Covers the provider routing model (prefix = explicit, priority list =
  failover), the four providers and their auth, the deploy sequence (secrets,
  vars, `wrangler deploy`, admin priority list, verify), the free-tier throttle
  spec, the response headers, the rejection codes, and seven known limits.

### Fixed — `cee753e fix(arcana-proxy): cloudflare in primary path + free-tier cap corrections`

Five critical/moderate findings from the review of `0b47b50`:

- **C1 (critical):** added the Cloudflare (Workers AI) dispatch branch to
  `proxyOpenRouter` behind the `cf/` and `cloudflare/` prefix. Previously the
  branch only existed in `proxyWithFailover`, so bare-model requests — the
  common case for a priority list where `openrouter` is first — never reached
  cloudflare unless openrouter AND aihubmix both hard-failed. The priority list
  is now correctly documented as a *failover* list; the prefix is the explicit
  way to opt into cloudflare.
- **M1:** reverted `FREE_TURN_PROVIDER_CALL_LIMIT` from `1` back to `2`. The
  `1`-cap was the wrong knob; the correct cap is `FREE_PROVIDER_ATTEMPT_LIMIT = 2`
  (unchanged). A cap of `1` meant a single transient hard 5xx on the first
  provider locked the turn for the rest of the session via
  `free_turn_budget_reached`, even though no useful work happened.
- **M3 (verified, no code change):** the `clampFreeRequestBody` call in the
  `proxyWithFailover` free-tier path was already in `0b47b50`; the review
  misread the indentation on first pass. Re-verified against the actual code.
- **M4:** dropped the empty `"CLOUDFLARE_ACCOUNT_ID": ""` entries from
  `wrangler.jsonc` (top-level + staging). An empty string in a `vars` block
  is a real value, not "unset" — `cloudflareBaseURL` would have returned the
  sentinel URL `_cf_account_missing_` and every cloudflare-routed request
  would 404 at the CF edge. Replaced with a comment pointing deployers at
  `npx wrangler var put CLOUDFLARE_ACCOUNT_ID` and `npx wrangler secret put
  CLOUDFLARE_KEY` *before* adding `cloudflare` to the admin priority list.

### Added — `0b47b50 feat(arcana-proxy): add Cloudflare Workers AI provider + tighten free-tier limits`

Two new features in one commit; the first one was incomplete and was fixed by
`cee753e` above.

#### Provider router

- Added `cloudflare` (Workers AI direct) to the `Provider` union, the
  `isProvider` guard, the admin priority whitelist, and the prefix resolution
  (`cf/<model>` and `cloudflare/<model>`).
- Mirrored the aihubmix key-pool shape: `getCloudflareKey`,
  `markCloudflareKeyRateLimited`, `markCloudflareKeySuccess` with the same
  cooldown / backoff / ejection policy.
- `cloudflareBaseURL(env)` templates
  `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1`
  at request time.
- `listModels` fetches `/v1/models` from the same base, normalises both
  `{ data: [...] }` and `{ result: [...] }` shapes (Cloudflare-native responses
  can return either), and surfaces each id as `cloudflare/<raw_id>`.
- `proxyWithFailover` gained pre-flight, dispatch, catch rate-limit, hard-fail
  rate-limit, and success-mark branches for the new provider.
- `handleAdminSetProviders` rejects priority lists that include `cloudflare`
  when `CLOUDFLARE_KEY(S)` or `CLOUDFLARE_ACCOUNT_ID` are not configured.

#### Free-tier throttle

Five changes to the free-tier code path, targeting a 6× reduction in the
worst-case per-user inference cost at 500 free users/week:

- Per-turn input cap: 32 K → **16 K** raw input tokens.
- Per-turn output cap: 4 K → **2 K** output tokens. Biggest single cost lever.
- Per-turn provider-call cap: 3 → **1** (reverted to 2 by `cee753e`; the
  final cap is 2, matching `FREE_PROVIDER_ATTEMPT_LIMIT`).
- New **weekly token aggregate**: 200,000 combined in+out tokens per
  subject-key, reset anchored to `activated_at + 7d`.
- New `FreeUsageRecord` field `tokensUsed`; new `FreeUsageSnapshot` fields
  `tokensUsed` / `tokensLimit` / `tokensRemaining`; new response headers
  `X-Arcana-Free-Tokens-Used` / `-Limit` / `-Remaining`.
- New rejection code `free_weekly_token_limit_reached` (HTTP 429). Session
  also goes `EXHAUSTED` when `tokensUsed >= aggregate`, even if turns remain
  and the hour has not elapsed.
- `settleFreeTurn` now takes `tokensIn` / `tokensOut` and accumulates the
  combined total on `completed` turns (failed turns do not drain the
  allowance).
- Burst limits (20 req/min IP, 8 req/min user) and session-level caps
  (10 turns, 60 min, 7d) unchanged.

#### Wrangler config

- `wrangler.jsonc` gained comments documenting the Cloudflare account ID and
  secret setup sequence. (The `cee753e` fixup removed the empty
  `CLOUDFLARE_ACCOUNT_ID` defaults that the initial commit had set; see
  "M4" above.)

### Doc

- `docs/free-usage-weekly-session-plan.md` updated with the new throttle spec,
  the weekly aggregate, the new rejection code, the new response headers, and
  the updated authoritative record shape. The spec and the code are now in
  sync on these numbers; the spec remains authoritative for *policy* and the
  code for *behavior*.

---

## Source

| Commit | Subject | Files |
| --- | --- | --- |
| [`[hash]`](https://github.com/Lento47/arcana-proxy/commit/[hash]) | `feat: hybrid load-sensing scheduler + per-user effort score tracking [bump]` | `src/free-routing.ts` (~80), `src/index.ts` (~160) |
| [`e52e00c`](https://github.com/Lento47/arcana-proxy/commit/e52e00c) | `docs(arcana-proxy): accuracy pass against deployed code` | `docs/providers-free-usage-deploy.md` (+62 / −22) |
| [`2409b63`](https://github.com/Lento47/arcana-proxy/commit/2409b63) | `docs(arcana-proxy): providers, free-usage, deploy reference` | `docs/providers-free-usage-deploy.md` (+397) |
| [`cee753e`](https://github.com/Lento47/arcana-proxy/commit/cee753e) | `fix(arcana-proxy): cloudflare in primary path + free-tier cap corrections` | `src/index.ts` (+22 / −9), `wrangler.jsonc` |
| [`0b47b50`](https://github.com/Lento47/arcana-proxy/commit/0b47b50) | `feat(arcana-proxy): add Cloudflare Workers AI provider + tighten free-tier limits` | `src/index.ts` (+767 / −77), `wrangler.jsonc` (+43 / −1) |

## Future work (tracked separately, not part of the unreleased set)

- **(c) Durable Object migration for `free_usage:*`** — the spec calls for a
  SQLite-backed Durable Object per subject key to guarantee atomic reservation
  under concurrent requests. The current implementation uses KV (eventually
  consistent; read-modify-write is not atomic). This is the cause of the
  `free_weekly_cooldown` gap and the pre-turn token count in response
  headers. Will land as a single commit with the DO scaffolding in place and
  the new path gated behind `FREE_USAGE_DO_ENABLED` (default off), followed
  by a separate commit that flips the gate after staging smoke-test.
- **(b) TUI free-usage rendering** — the Arcana TUI does not currently
  consume the proxy's free-usage endpoint or response headers. A new TUI
  plugin will fetch `/v1/free-usage/sessions/current` on session-open and
  listen for the `X-Arcana-Free-*` response headers from chat completions,
  normalizing both into a single shape and publishing to `api.kv`. The
  statusbar, sidebar/context, and prompt will render the snapshot.
- **`scripts/doc-sync-check.mjs` → CI** — the script exists locally; wiring
  it into the deploy workflow so a docs / code drift fails the deploy is
  the next CI step. Tracked as a follow-up to the deploy workflow.