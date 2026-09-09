# Sync de Google Ads (investimento + palavras-chave)

Endpoint: `POST https://www.decorroomsc.com.br/api/sync/google-ads`
Auth: header `x-sync-secret: <SYNC_SECRET>` (o mesmo secret do sync da Meta).

Popula, no banco `decorroom-db`:
- **`ad_spend`** (platform `google`) — custo/cliques/impressões por campanha/dia → alimenta os KPIs
  *Investimento Google*, *Cliques Google*, CPL/CPA/ROAS e o gráfico diário.
- **`keyword_stats`** — custo/cliques/conversões por palavra-chave/dia → alimenta o painel
  *Palavras-chave (Google · top 10)*. `leads` = conversões rastreadas pelo Google (clique no
  WhatsApp); `CPL` = custo ÷ conversões.

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

Resposta saudável: `{"ok":true,"spend_rows":N,"keyword_rows":M,...}`.
Se vier `{"skipped":true,...}`, o `reason` diz qual env var está faltando.

## Conferir se está entrando

O painel tem o bloco **Saúde das fontes** no topo: *Investimento Google* e *Palavras-chave* ficam
verdes enquanto houver escrita nas últimas 48h. Pelo banco:

```bash
npx wrangler@latest d1 execute decorroom-db --remote --command \
  "SELECT platform, MAX(date) ultimo, COUNT(*) linhas FROM ad_spend GROUP BY platform"
npx wrangler@latest d1 execute decorroom-db --remote --command \
  "SELECT platform, status, rows_upserted, error_message, datetime(run_at,'unixepoch') FROM sync_log ORDER BY id DESC LIMIT 5"
```

## Backfill manual

Aplicado em 09/09/2026 para a janela **06/06 → 09/09/2026**: 256 linhas em `ad_spend`
(R$ 6.001,93 · 1.692 cliques) e 1.521 linhas em `keyword_stats`. O upsert é idempotente — rodar de
novo sobre a mesma janela apenas atualiza. Para repetir, o caminho mais simples é chamar o próprio
endpoint com a janela desejada:

```bash
curl -X POST https://www.decorroomsc.com.br/api/sync/google-ads \
  -H "x-sync-secret: <SYNC_SECRET>" -H "Content-Type: application/json" \
  -d '{"date_from":"2026-06-06","date_to":"2026-09-09"}'
```
