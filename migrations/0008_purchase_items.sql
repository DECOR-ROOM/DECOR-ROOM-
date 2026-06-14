-- Track purchase_items table in migrations.
-- Already exists in prod (created out-of-band); IF NOT EXISTS makes this a
-- no-op against prod but functional for bootstrapping new environments.
CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    transaction_id TEXT,
    product_id TEXT NOT NULL,
    product_name TEXT,
    value REAL NOT NULL,
    currency TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    utm_source TEXT,
    utm_campaign TEXT,
    utm_medium TEXT,
    utm_content TEXT,
    utm_term TEXT,
    FOREIGN KEY (purchase_id) REFERENCES purchase_log(id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_items(product_id, created_at);
