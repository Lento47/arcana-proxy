// src/free-config.ts
//
// Single source of truth for free-tier product limits.
// All proxy components (routing, Durable Object state tracking, rate limiting)
// import from here so that limits never drift across files.
//
// These are product/plan constants: session duration, turn limits, token
// aggregates, daily request ceilings.  Implementation-specific constants
// (failover backoff, key pool cooldown, EWMA parameters) stay in their
// respective modules.

/** Soft display threshold only — never hard-rejects. */
export const FREE_SESSION_TURN_LIMIT = 10

/** Hard stop: the only real cap on a free session. */
export const FREE_SESSION_DURATION_MS = 60 * 60 * 1000

/** 7-day rolling window: after this time from session start, a new session may begin. */
export const FREE_SESSION_RESET_MS = 7 * 24 * 60 * 60 * 1000

/** Unlimited in practice; display ceiling only. */
export const FREE_WEEKLY_TOKEN_AGGREGATE = 1_000_000_000

/** Per-turn time budget: proxy retries models/providers until this window expires. */
export const FREE_TURN_MAX_DURATION_MS = 60_000

/** Soft daily request ceiling for free tier — prevents scripted abuse without binding real usage. */
export const FREE_DAILY_LIMIT = 5000
