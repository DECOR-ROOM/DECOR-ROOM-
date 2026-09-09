# Sync de Google Ads (investimento, leilão, palavras-chave e termos de busca)

Endpoint: `POST https://www.decorroomsc.com.br/api/sync/google-ads`
Auth: header `x-sync-secret: <SYNC_SECRET>`.

Popula, no banco `decorroom-db`:
- **`ad_spend`** (platform `google`) — custo/cliques/impressões por campanha/dia → KPIs de
  investimento, cliques, CPC, CTR e o gráfico diário.
- **`keyword_stats`** — por palavra-chave/dia: custo, cliques, impressões, conversões,
  **índice de qualidade** e parcelas de impressão → painel *Palavras-chave que mais performaram*.
- **`campaign_share`** — por campanha/dia: parcela de impressões, perda por classificação,
  perda por orçamento, topo e topo absoluto → painel *Disputa de leilão*.
- **`search_terms`** — o termo que a pessoa realmente digitou → painel *Termos de busca reais*
  (o que converteu × o que gastou sem converter).

> **Auction Insights não existe na Google Ads API.** O relatório com os domínios concorrentes é
> exclusivo da interface do Google Ads. O que a API entrega — e o que estas tabelas guardam — é a
> substância acionável da disputa: quanto do leilão a conta leva e por que perde o resto. Perda por
> **classificação** se resolve com relevância (anúncio, página, índice de qualidade); perda por
> **orçamento** se resolve com dinheiro. Só a segunda.

## Versão da API — atenção

O Google aposenta cada versão da API cerca de um ano após o lançamento, e a partir daí o endpoint
REST responde **404**. O padrão no código (`DEFAULT_API_VERSION`, em `functions/api/sync/google-ads.js`)
esteve fixado em `v18` até 09/09/2026, já fora do ar — o sync teria falhado mesmo com as credenciais
certas. Hoje o padrão é **`v22`**.

Como conferir quais versões ainda respondem, sem depender de release notes:

```bash
for V in v22 v23 v24; do
  printf "%s -> " "$V"
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    "https://googleads.googleapis.com/$V/customers/1086468452/googleAds:searchStream" \
    -H "Authorization: Bearer <access_token>" -H "developer-token: <dev_token>" \
    -H "login-customer-id: 3378698997" -H "Content-Type: application/json" \
    -d '{"query":"SELECT campaign.id FROM campaign LIMIT 1"}'
done
```

`200` = viva, `404` = aposentada. Para trocar sem mexer no código, basta setar a env var
`GOOGLE_ADS_API_VERSION` no projeto Pages.

## Variáveis de ambiente (Cloudflare Pages → projeto `decor-room` → Settings → Environment variables)

Configuradas em **09/09/2026** (antes disso nunca existiram, e o endpoint respondia
`200 {skipped:true}` — por isso o painel mostrava investimento R$ 0):

| Variável | Valor / origem |
|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | token da MCC (Google Ads → Ferramentas → API Center) |
| `GOOGLE_ADS_CLIENT_ID` | OAuth client do `~/.google-ads-mcp/adc.json` |
| `GOOGLE_ADS_CLIENT_SECRET` | idem |
| `GOOGLE_ADS_REFRESH_TOKEN` | idem — **é da MCC**, enxerga as 10 contas da agência |
| `GOOGLE_ADS_CUSTOMER_ID` | `1086468452` (Decor Room) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | `3378698997` (MCC) |
| `GOOGLE_ADS_API_VERSION` | *(não setada — usa o padrão `v22`)* |

> O refresh token guardado aqui é de nível MCC: quem tiver acesso a este projeto Cloudflare tem
> leitura de todas as contas da agência, não só da Decor Room. Se um dia quiser reduzir esse escopo,
> gere um OAuth client separado com acesso apenas à conta 1086468452 e troque as três credenciais.

> Mudança de env var só vale em **novo deploy** — re-deploye após salvar.

## Agendar o cron — PENDENTE

Existe cron para a Meta (roda a cada ~15 min desde 23/06/2026), mas **nunca existiu para o Google**:
a tabela `sync_log` não tem uma única linha com `platform='google'`. Sem esse passo o endpoint
continua correto e nunca é chamado, e os dados só avançam por backfill manual.

No cron-job.org, ao lado do job da Meta:

1. **Create cronjob** → URL: `https://www.decorroomsc.com.br/api/sync/google-ads`
2. Schedule: **a cada 1 hora** (minuto 30, pra não coincidir com o da Meta).
3. **Advanced → Request method: POST**
4. **Headers:**
   - `x-sync-secret` = `<SYNC_SECRET>` (o mesmo já usado no job da Meta)
   - `Content-Type` = `application/json`
5. **Body:** vazio (usa os últimos 7 dias). → Salvar → **Run now**.

Resposta saudável: `{"ok":true,"spend_rows":N,"keyword_rows":M,"share_rows":S,"search_term_rows":T,...}`.
Se vier `{"skipped":true,...}`, o `reason` diz qual env var está faltando.

> A janela padrão de 7 dias já traz ~1.500 linhas de `search_term_view`. Os upserts vão em blocos de
> 200 (`chunkedBatch`) porque um `db.batch()` único desse tamanho estoura o limite do D1.

## Conferir se está entrando

O painel tem o bloco **Saúde das fontes** no topo: *Investimento Google*, *Palavras-chave*,
*Disputa de leilão* e *Termos de busca* ficam verdes enquanto houver escrita nas últimas 48h.
Pelo banco:

```bash
npx wrangler@latest d1 execute decorroom-db --remote --command \
  "SELECT 'ad_spend' t, MAX(date) ultimo, COUNT(*) n FROM ad_spend WHERE platform='google'
   UNION ALL SELECT 'keyword_stats', MAX(date), COUNT(*) FROM keyword_stats
   UNION ALL SELECT 'campaign_share', MAX(date), COUNT(*) FROM campaign_share
   UNION ALL SELECT 'search_terms', MAX(date), COUNT(*) FROM search_terms"
npx wrangler@latest d1 execute decorroom-db --remote --command \
  "SELECT platform, status, rows_upserted, error_message, datetime(run_at,'unixepoch') FROM sync_log ORDER BY id DESC LIMIT 5"
```

## Backfill manual

Aplicado em 09/09/2026 para a janela **06/06 → 09/09/2026**: `ad_spend` 256 linhas
(R$ 6.001,93 · 1.692 cliques), `keyword_stats` 1.522, `campaign_share` 190, `search_terms` 3.151.
O upsert é idempotente — rodar de novo sobre a mesma janela apenas atualiza. Para repetir, o
caminho mais simples é chamar o próprio endpoint com a janela desejada:

```bash
curl -X POST https://www.decorroomsc.com.br/api/sync/google-ads \
  -H "x-sync-secret: <SYNC_SECRET>" -H "Content-Type: application/json" \
  -d '{"date_from":"2026-06-06","date_to":"2026-09-09"}'
```
