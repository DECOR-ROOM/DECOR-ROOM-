-- Painéis de disputa de leilão e de termos de busca (Google Ads).
--
-- Auction Insights (domínios concorrentes) NÃO existe na Google Ads API — só na
-- interface. O que a API dá, e o que estas tabelas guardam, é a substância da
-- disputa: quanto do leilão a conta ganha, quanto perde por classificação e
-- quanto perde por orçamento.

-- Parcela de impressões por campanha/dia.
CREATE TABLE IF NOT EXISTS campaign_share (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  search_is REAL NOT NULL DEFAULT 0,       -- parcela de impressões de pesquisa
  lost_is_rank REAL NOT NULL DEFAULT 0,    -- perdida por classificação do anúncio
  lost_is_budget REAL NOT NULL DEFAULT 0,  -- perdida por orçamento
  top_is REAL NOT NULL DEFAULT 0,          -- parcela no topo
  abs_top_is REAL NOT NULL DEFAULT 0,      -- parcela no topo absoluto
  synced_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_share ON campaign_share(date, campaign_id);
CREATE INDEX IF NOT EXISTS ix_campaign_share_date ON campaign_share(date);

-- Termos de busca reais (o que a pessoa digitou), distinto da palavra-chave comprada.
CREATE TABLE IF NOT EXISTS search_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  campaign_id TEXT NOT NULL DEFAULT '',
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL DEFAULT '',
  search_term TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT '',
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_search_terms ON search_terms(date, campaign_id, ad_group_id, search_term, match_type);
CREATE INDEX IF NOT EXISTS ix_search_terms_date ON search_terms(date);

-- Qualidade e disputa por palavra-chave. Colunas novas em keyword_stats — o
-- índice de qualidade é o que explica CPC alto sem posição, então vale junto.
ALTER TABLE keyword_stats ADD COLUMN ad_group_name TEXT;
ALTER TABLE keyword_stats ADD COLUMN quality_score INTEGER;
ALTER TABLE keyword_stats ADD COLUMN search_is REAL;
ALTER TABLE keyword_stats ADD COLUMN top_is REAL;
