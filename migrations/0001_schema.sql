-- Migration v1: arcana-proxy D1 schema
-- Rate-limit persistence, effort scores, and free-usage analytics

-- Rate-limit token bucket state (periodic sync from in-memory Maps)
-- Not used on the hot path — D1 latency is too high for per-request checks.
-- The in-memory token bucket remains authoritative; this table provides
-- cross-isolate visibility and post-restart recovery.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,       -- e.g. "free:1.2.3.4", "free:user_sha256", "ip:1.2.3.4"
  tokens REAL NOT NULL DEFAULT 0,    -- current token count (fractional)
  last_refill INTEGER NOT NULL,      -- unix ms of last token refill
  updated_at INTEGER NOT NULL        -- unix ms of last sync
);

-- Per-user effort scores (replaces KV user_cost:* keys)
-- Score = tokensIn * 0.3 + tokensOut * 0.7 + providerCalls * 10
-- Decays 50% weekly (half-life)
CREATE TABLE IF NOT EXISTS effort_scores (
  user_id TEXT PRIMARY KEY,          -- SHA-256 prefix of user id
  score INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  last_active INTEGER NOT NULL,      -- unix ms
  rolling_week_start INTEGER NOT NULL -- unix ms, for weekly decay
);

-- Free-usage analytics events (append-only)
-- Each row = one completed or failed free turn
-- For dashboard queries: daily active users, avg tokens/turn, error rates
CREATE TABLE IF NOT EXISTS free_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,             -- SHA-256 prefix
  free_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  provider_calls INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL        -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_free_usage_user_date
  ON free_usage_events(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_free_usage_status_date
  ON free_usage_events(status, created_at);
