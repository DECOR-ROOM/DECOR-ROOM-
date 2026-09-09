-- Conversões no nível de campanha.
--
-- Até aqui o painel derivava o total de conversões somando a tabela de
-- palavras-chave — que vem com LIMIT 15 e só cobre conversão atribuída a
-- keyword. Subcontava. Campanha é o nível certo pra "quantas pessoas vieram
-- dos anúncios".
ALTER TABLE ad_spend ADD COLUMN conversions REAL NOT NULL DEFAULT 0;
