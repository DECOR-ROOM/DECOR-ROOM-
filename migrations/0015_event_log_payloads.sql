-- Capture the outgoing Meta/GA4 payloads and responses for every Lead event,
-- matching what purchase_log already stores for purchases. Enables the
-- dashboard Details modal to show exactly what was sent and received, so
-- the recipient can debug PII hashing, Advanced Matching, and dedup without
-- leaving /dash.
ALTER TABLE event_log ADD COLUMN meta_status_code INTEGER DEFAULT 0;
ALTER TABLE event_log ADD COLUMN meta_payload_sent TEXT;
ALTER TABLE event_log ADD COLUMN ga4_status_code INTEGER DEFAULT 0;
ALTER TABLE event_log ADD COLUMN ga4_response_body TEXT;
ALTER TABLE event_log ADD COLUMN ga4_payload_sent TEXT;
