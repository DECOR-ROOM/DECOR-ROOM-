-- Separa Search de Performance Max.
--
-- A PMax da Decor Room existe só pra dar fluxo às campanhas de pesquisa; os
-- números que o cliente acompanha são os de Search. Sem esta coluna não dá pra
-- separar: `ad_spend` e `geo_stats` vinham misturando os dois, e a PMax distorce
-- pesado (30d até 09/09: 472 cliques a R$ 0,57 contra 211 a R$ 8,29 na Search).
--
-- keyword_stats e search_terms NÃO precisam da coluna: vêm de keyword_view e
-- search_term_view, que só existem para campanhas de pesquisa. campaign_share já
-- filtra advertising_channel_type = 'SEARCH' na própria consulta.
ALTER TABLE ad_spend  ADD COLUMN channel TEXT;
ALTER TABLE geo_stats ADD COLUMN channel TEXT;
CREATE INDEX IF NOT EXISTS ix_ad_spend_channel  ON ad_spend(channel, date);
CREATE INDEX IF NOT EXISTS ix_geo_stats_channel ON geo_stats(channel, date);
