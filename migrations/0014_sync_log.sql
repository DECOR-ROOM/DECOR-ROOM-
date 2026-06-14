-- Sync run log. Every call to /api/sync/meta-ads (and later /api/sync/google-ads)
-- writes one row here so the dashboard can show 'last synced at' and surface
-- failures without having to tail Cloudflare Worker logs.
CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,            -- 'meta' | 'google'
    status TEXT NOT NULL,              -- 'ok' | 'error'
    rows_upserted INTEGER DEFAULT 0,
    date_from TEXT,                    -- 'YYYY-MM-DD'
    date_to TEXT,                      -- 'YYYY-MM-DD'
    error_message TEXT,
    duration_ms INTEGER,
    run_at INTEGER NOT NULL            -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_sync_log_platform_run_at
    ON sync_log(platform, run_at DESC);
