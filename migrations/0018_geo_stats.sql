-- Desempenho por cidade (Google Ads · geographic_view).
--
-- Substitui o campo `city` do CRM como fonte do mapa: aquele é digitado à mão na
-- ficha do lead e estava preenchido em 1 de 54 leads. Este vem da própria
-- plataforma, completo e sem trabalho manual.
CREATE TABLE IF NOT EXISTS geo_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  city_id TEXT NOT NULL,        -- geo target constant do Google
  city_name TEXT NOT NULL,      -- resolvido no sync; casado com o IBGE no painel
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_geo_stats ON geo_stats(date, city_id);
CREATE INDEX IF NOT EXISTS ix_geo_stats_date ON geo_stats(date);
