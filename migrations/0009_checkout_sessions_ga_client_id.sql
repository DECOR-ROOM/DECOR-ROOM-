-- Track checkout_sessions.ga_client_id in migrations.
-- Already exists in prod (added out-of-band); this migration ensures new
-- environments get the column when bootstrapping from migrations alone.
ALTER TABLE checkout_sessions ADD COLUMN ga_client_id TEXT DEFAULT '';
