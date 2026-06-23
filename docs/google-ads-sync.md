# Sync de Google Ads (investimento + palavras-chave)

Endpoint: `POST https://decorroomsc.com.br/api/sync/google-ads`
Auth: header `x-sync-secret: <SYNC_SECRET>` (o mesmo secret do sync da Meta).

Popula, no banco `decorroom-db`:
- **`ad_spend`** (platform `google`) — custo/cliques/impressões por campanha/dia → alimenta os KPIs
  *Investimento Google*, *Cliques Google*, CPL/CPA/ROAS e o gráfico diário.
- **`keyword_stats`** — custo/cliques/conversões por palavra-chave/dia → alimenta o painel
  *Palavras-chave (Google · top 10)*. `leads` = conversões rastreadas pelo Google (clique no
  WhatsApp); `CPL` = custo ÷ conversões.

## Variáveis de ambiente (Cloudflare Pages → projeto `decor-room` → Settings → Environment variables)

| Variável | Onde obter |
|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads → Ferramentas → **API Center** (requer aprovação do token) |
| `GOOGLE_ADS_CLIENT_ID` | Google Cloud Console → APIs e Serviços → Credenciais → OAuth 2.0 |
| `GOOGLE_ADS_CLIENT_SECRET` | idem (mesma credencial OAuth) |
| `GOOGLE_ADS_REFRESH_TOKEN` | gerado no fluxo OAuth offline (OAuth Playground ou script) com escopo `https://www.googleapis.com/auth/adwords` |
| `GOOGLE_ADS_CUSTOMER_ID` | ID da conta Google Ads que será consultada (só dígitos, sem traços) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | *(opcional)* ID da MCC/conta gerente, se a conta for gerenciada (só dígitos) |
| `GOOGLE_ADS_API_VERSION` | *(opcional)* ex.: `v18`. Só ajustar se o Google depreciar a versão padrão. |

> Enquanto faltar qualquer uma das 5 obrigatórias, o endpoint responde `200 {skipped:true}` —
> assim o cron não acusa falha. Quando todas estiverem setadas, ele passa a popular os dados.

## Agendar o cron (cron-job.org, junto com o da Meta)

1. **Create cronjob** → URL: `https://decorroomsc.com.br/api/sync/google-ads`
2. Schedule: **a cada 1 hora** (minuto 30, pra não coincidir com o da Meta).
3. **Advanced → Request method: POST**
4. **Headers:**
   - `x-sync-secret` = `<SYNC_SECRET>`
   - `Content-Type` = `application/json`
5. **Body:** vazio (usa os últimos 7 dias). → Salvar → **Run now**.

Resposta saudável: `{"ok":true,"spend_rows":N,"keyword_rows":M,...}` (ou `{skipped:true}` se faltar env).
