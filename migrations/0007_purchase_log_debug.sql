-- Persist the exact JSON bodies POSTed to Meta CAPI, GA4 MP, and Google Ads.
-- Without these, /dash cannot show "what we sent" — only responses were stored.
ALTER TABLE purchase_log ADD COLUMN meta_payload_sent TEXT;
ALTER TABLE purchase_log ADD COLUMN ga4_payload_sent TEXT;
ALTER TABLE purchase_log ADD COLUMN google_ads_payload_sent TEXT;

-- GA4 only logged status + ok flag. Add response body to match Meta + Google Ads.
ALTER TABLE purchase_log ADD COLUMN ga4_response_body TEXT;
