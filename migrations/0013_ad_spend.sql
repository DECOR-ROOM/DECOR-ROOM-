-- Ad spend data synced from Meta Marketing API (and later Google Ads API).
-- One row per (platform, date, campaign_id). Refreshed periodically by an
-- external cron hitting /api/sync/meta-ads. Dashboard reads from this table
-- directly; the sync and the dashboard never talk in real time.
CREATE TABLE IF NOT EXISTS ad_spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,            -- 'meta' | 'google' (google = future)
    date TEXT NOT NULL,                -- 'YYYY-MM-DD' in the ad account's TZ
    campaign_id TEXT NOT NULL,
    campaign_name TEXT,
    ad_id TEXT,                        -- nullable; Meta returns at campaign level first
    ad_name TEXT,
    spend_cents INTEGER NOT NULL,      -- store as integer cents to avoid float drift
    currency TEXT NOT NULL DEFAULT 'BRL',
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    synced_at INTEGER NOT NULL         -- unix seconds
);

-- One unique row per platform/date/campaign/ad so sync can UPSERT safely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_spend_unique
    ON ad_spend(platform, date, campaign_id, COALESCE(ad_id, ''));

CREATE INDEX IF NOT EXISTS idx_ad_spend_date ON ad_spend(date);
CREATE INDEX IF NOT EXISTS idx_ad_spend_platform_date ON ad_spend(platform, date);
