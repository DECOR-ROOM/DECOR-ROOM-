CREATE TABLE IF NOT EXISTS checkout_sessions (
    trk TEXT PRIMARY KEY,
    session_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    external_id TEXT,
    fbp TEXT,
    fbc TEXT,
    gclid TEXT,
    gbraid TEXT,
    wbraid TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    event_source_url TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_created ON checkout_sessions(created_at);
