-- 0009_keyword_stats.sql  (decorroom-db)
-- Desempenho por palavra-chave do Google Ads, populado por /api/sync/google-ads.
-- O dashboard lê esta tabela para o painel "Palavras-chave (Google · top 10)".
-- Chave de upsert: (date, campaign_id, ad_group_id, keyword, match_type).
-- Colunas-chave são NOT NULL DEFAULT '' para o ON CONFLICT funcionar (SQLite trata
-- NULLs como distintos em índices UNIQUE).

CREATE TABLE IF NOT EXISTS keyword_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  campaign_id TEXT NOT NULL DEFAULT '',
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT '',
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_keyword_stats
  ON keyword_stats(date, campaign_id, ad_group_id, keyword, match_type);
CREATE INDEX IF NOT EXISTS ix_keyword_stats_date ON keyword_stats(date);
