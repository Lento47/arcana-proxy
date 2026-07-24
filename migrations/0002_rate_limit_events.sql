-- Migration v2: rate-limit event tracking
-- Logs every 429 response for monitoring and alerting

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,                      -- NULL for unauthenticated (IP-only) limits
  client_ip TEXT NOT NULL,
  limit_type TEXT NOT NULL CHECK(limit_type IN (
    'ip_burst', 'user_burst', 'free_ip_burst', 'free_user_burst',
    'free_global_soft', 'daily_limit', 'free_session_expired'
  )),
  tier TEXT,                         -- user tier at time of limit (free/pro/team/enterprise)
  created_at INTEGER NOT NULL        -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_rle_type_time
  ON rate_limit_events(limit_type, created_at);

CREATE INDEX IF NOT EXISTS idx_rle_user_time
  ON rate_limit_events(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_rle_ip_time
  ON rate_limit_events(client_ip, created_at);
