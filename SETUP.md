# Decor Room — Guia de implantação (site + tracking + WhatsApp)

Este repositório contém o **site da Decor Room** já com o **stack de tracking KROB**
mesclado (Cloudflare Pages + D1, Meta CAPI + GA4 + Google Ads + dashboard).

> Conversão principal = **clique no WhatsApp** (`wa.me/554730481531`). Não há formulário:
> todo clique em link de WhatsApp dispara um evento **Lead** (Meta + GA4 + Google Ads).

---

## Estrutura do repositório (o que vai pro deploy)

```
index.html            ← landing page (já instrumentada com tracking)
images/               ← imagens WebP
_headers              ← regras de cache (Cloudflare Pages)
functions/            ← Pages Functions: _middleware, tracker, scripts/gtag proxy, api/*
migrations/           ← schema D1 (aplicar com wrangler)
config/               ← config de produtos (sem segredos)
dash/                 ← dashboard em /dash/?key=<DASH_KEY>
wrangler.toml         ← LOCAL/gitignored (só p/ CLI). Não é lido no deploy.
.gitignore            ← exclui as 3 pastas-template KROB e segredos
```

As pastas `paginas-krobcode-2-main/`, `krob-tracking-stack-main/` e
`krob-whatsapp-tracking-v1/` são **referência** e estão no `.gitignore` — **não** vão pro deploy.
O `krob-whatsapp-tracking-v1/` será publicado **à parte** (ver Fase 3).

---

## Valores a preencher (placeholders)

### 1) No `index.html` (`<head>`, objeto `window.DECORROOM_TRACKING`) — IDs públicos do client-side:
| Placeholder | Substituir por |
|---|---|
| `__META_PIXEL_ID__` | Pixel ID numérico da Meta |
| `G-XXXXXXXXXX` | GA4 Measurement ID |
| `AW-XXXXXXXXXX` | Google Ads ID de conversão |
| `XXXXXXXXXXXXXXXX` | Label da conversão "Clique WhatsApp" (Google Ads) |

### 2) No painel Cloudflare Pages (Settings → Environment variables, Production) — segredos do server-side:
| Variável | Obrigatória? | Valor |
|---|---|---|
| `META_PIXEL_ID` | sim | mesmo Pixel ID do item 1 |
| `META_ACCESS_TOKEN` 🔒 | sim | token CAPI (Events Manager) |
| `DASH_KEY` 🔒 | sim | aleatório (`openssl rand -hex 32`) — protege `/dash` e `/api/*` |
| `GA4_MEASUREMENT_ID` | p/ GA4 | mesmo do item 1 |
| `GA4_API_SECRET` 🔒 | p/ GA4 | Measurement Protocol API secret |
| `DEFAULT_COUNTRY_CODE` | recomendado | `55` |
| `TIMEZONE_OFFSET` | recomendado | `-03:00` |
| `META_TEST_EVENT_CODE` | só p/ teste | código do Events Manager → Test Events |
| `META_ADS_ACCESS_TOKEN` 🔒 | p/ dashboard de mídia | system-user token c/ `ads_read` |
| `META_ADS_ACCOUNT_ID` | p/ dashboard de mídia | ID da conta (só dígitos, sem `act_`) |
| `SYNC_SECRET` 🔒 | p/ dashboard de mídia | aleatório — protege `/api/sync/meta-ads` |
| `GOOGLE_ADS_*` | opcional (fase 2b) | credenciais da API (quando o developer token sair) |

> Mudança de env var só vale em **novo deploy** — re-deploye após salvar.

---

## Fase 1 — Publicar o site

1. Criar repositório GitHub privado da Decor Room e subir este conteúdo (raiz).
2. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → selecionar o repo.
   - Build command: *(vazio)*  |  Output directory: `/`
3. Deploy → site em `https://decorroom.pages.dev`.
4. (Quando o domínio for definido) Pages → **Custom domains** → adicionar o domínio + `www`.

## Fase 2 — Ligar o tracking (mesmo projeto)

```bash
npx wrangler@latest login                         # logar na conta da Decor Room
npx wrangler@latest d1 create decorroom-db        # copiar o database_id p/ wrangler.toml
npx wrangler@latest d1 migrations apply decorroom-db --remote
```

No painel: **Settings → Bindings** → adicionar D1 com nome de variável **`DB`** → `decorroom-db`.
Setar as env vars (tabela acima) e **re-deployar**. Preencher os IDs no `index.html` (item 1).

**Dashboard de mídia (CPL/CPA/ROAS Meta):** configurar um cron horário (ex.: cron-job.org)
que faça `POST https://<deploy>/api/sync/meta-ads` com header `x-sync-secret: <SYNC_SECRET>`.
(Investimento do Google Ads ainda não é sincronizado pelo stack — acompanhar no Google Ads/GA4.)

## Fase 3 — Rastreamento de WhatsApp/CTWA (projeto separado)

Publicar `krob-whatsapp-tracking-v1/` como **projeto Pages + D1 próprios** (`decorroom-wa`):
contratar **uazapi**, conectar o número 47 3048-1531, e apontar o webhook para
`https://decorroom-wa.pages.dev/webhook/uazapi` (header `x-webhook-token: <WEBHOOK_SECRET>`).
Usar o **mesmo Pixel/dataset e token CAPI** da Meta para consolidar no Events Manager.
Passo a passo no próprio `krob-whatsapp-tracking-v1/README.md` e `docs/`.

---

## Verificação (resumo)

- Site carrega em `*.pages.dev`; cookies `_krob_sid`/`_fbp`/`_fbc` presentes; linha em `sessions` (D1).
- Events Manager → **Test Events** vê PageView e, ao clicar no WhatsApp, **Lead** (pixel+CAPI deduplicados).
- GA4 Realtime vê `page_view` e `generate_lead`; Google Ads registra a conversão do clique.
- `/dash?key=<DASH_KEY>` lista os Leads com UTMs; `/dashboard`/atribuição mostra CPL após o 1º sync.
