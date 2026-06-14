-- Add Google Ads response columns (server-to-server uploadClickConversions)
ALTER TABLE purchase_log ADD COLUMN google_ads_status_code INTEGER;
ALTER TABLE purchase_log ADD COLUMN google_ads_response_ok INTEGER DEFAULT 0;
ALTER TABLE purchase_log ADD COLUMN google_ads_response_body TEXT;
