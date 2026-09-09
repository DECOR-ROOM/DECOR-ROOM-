-- Com o canal na tabela, a chave única muda: o geographic_view devolve uma linha
-- por (dia, cidade, canal), então a mesma cidade aparece no mesmo dia uma vez
-- para Search e outra para PMax. A chave antiga (dia, cidade) colapsava as duas.
--
-- As linhas antigas são totais somados entre canais, incompatíveis com o novo
-- formato — vão fora e entram de novo pelo backfill.
DELETE FROM geo_stats;
DROP INDEX IF EXISTS ux_geo_stats;
CREATE UNIQUE INDEX ux_geo_stats ON geo_stats(date, city_id, COALESCE(channel, ''));
