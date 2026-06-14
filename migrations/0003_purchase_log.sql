CREATE TABLE IF NOT EXISTS purchase_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trk TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_time INTEGER NOT NULL,

    -- Raw PII (for validation only)
    raw_email TEXT,
    raw_name TEXT,
    raw_phone TEXT,

    -- Hashed PII (exactly what was sent to Meta)
    hashed_em TEXT,
    hashed_fn TEXT,
    hashed_ln TEXT,
    hashed_ph TEXT,
    hashed_external_id TEXT,

    -- Navigation data from checkout_sessions (sent to Meta as user_data)
    client_ip_address TEXT,
    client_user_agent TEXT,
    fbp TEXT,
    fbc TEXT,

    -- Purchase data (sent as custom_data)
    value REAL,
    currency TEXT,
    transaction_id TEXT,

    -- Event metadata
    event_source_url TEXT,
    action_source TEXT DEFAULT 'website',

    -- Meta CAPI response
    meta_status_code INTEGER,
    meta_response_ok INTEGER DEFAULT 0,
    meta_response_body TEXT,

    -- GA4 MP response
    ga4_status_code INTEGER,
    ga4_response_ok INTEGER DEFAULT 0,

    -- Google Ads data (from checkout_sessions)
    gclid TEXT,
    gbraid TEXT,
    wbraid TEXT,

    -- UTMs (from checkout_sessions)
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,

    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_log_trk ON purchase_log(trk);
CREATE INDEX IF NOT EXISTS idx_purchase_log_created ON purchase_log(created_at);
CREATE INDEX IF NOT EXISTS idx_purchase_log_event_id ON purchase_log(event_id);
