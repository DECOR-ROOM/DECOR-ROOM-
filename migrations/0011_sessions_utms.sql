-- Track sessions UTM columns in migrations.
-- Already exist in prod (added out-of-band); this migration ensures new
-- environments get them when bootstrapping from migrations alone.
ALTER TABLE sessions ADD COLUMN utm_source TEXT;
ALTER TABLE sessions ADD COLUMN utm_medium TEXT;
ALTER TABLE sessions ADD COLUMN utm_campaign TEXT;
ALTER TABLE sessions ADD COLUMN utm_content TEXT;
ALTER TABLE sessions ADD COLUMN utm_term TEXT;
