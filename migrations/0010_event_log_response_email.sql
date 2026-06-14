-- Track event_log debug columns in migrations.
-- Already exist in prod (added out-of-band); this migration ensures new
-- environments get them when bootstrapping from migrations alone.
ALTER TABLE event_log ADD COLUMN meta_response_body TEXT DEFAULT '';
ALTER TABLE event_log ADD COLUMN raw_email TEXT DEFAULT '';
