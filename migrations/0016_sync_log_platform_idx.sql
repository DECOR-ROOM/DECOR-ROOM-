-- The dashboard's health panel reads the latest sync_log row per platform on
-- every load. Without this index that MAX(id)/GROUP BY scans the whole table,
-- which already holds ~7k rows and grows by one per cron tick.
CREATE INDEX IF NOT EXISTS ix_sync_log_platform_id ON sync_log(platform, id DESC);
