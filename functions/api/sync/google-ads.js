// POST /api/sync/google-ads
//
// Pulls Google Ads performance from the Google Ads API (searchStream / GAQL) for
// the configured customer and UPSERTs:
//   * campaign-level cost/clicks/impressions  -> `ad_spend`     (platform='google')
//   * keyword-level cost/clicks/conversions   -> `keyword_stats`
// Called on a schedule by an external cron (same provider as the Meta sync).
// The dashboard reads both tables directly — it never hits this endpoint.
//
// Auth:  header `x-sync-secret: <env.SYNC_SECRET>` (shared with the Meta sync).
// Body:  { date_from?: 'YYYY-MM-DD', date_to?: 'YYYY-MM-DD' }  (default: last 7 days)
//
// Required env (all must be present, else returns 200 skipped:true so the cron
// provider keeps the job green until credentials are configured):
//   SYNC_SECRET                  shared secret with the cron
//   GOOGLE_ADS_DEVELOPER_TOKEN   developer token (Google Ads API Center)
//   GOOGLE_ADS_CLIENT_ID         OAuth2 client id
//   GOOGLE_ADS_CLIENT_SECRET     OAuth2 client secret
//   GOOGLE_ADS_REFRESH_TOKEN     OAuth2 refresh token (offline access)
//   GOOGLE_ADS_CUSTOMER_ID       account being queried (digits only, no dashes)
// Optional env:
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID MCC/manager id (digits only) — recommended if managed
//   GOOGLE_ADS_API_VERSION       e.g. 'v23' (default below); bump if Google deprecates
//
// Google retires each API version about a year after release, and the REST
// endpoint then answers 404 for it — v18 was the original default here and is
// already gone. Keep this pinned to a version that still answers; set
// GOOGLE_ADS_API_VERSION to override without a code change.

const DEFAULT_API_VERSION = 'v22';

export async function onRequestPost(context) {
  const { request, env } = context;

  const sentSecret = request.headers.get('x-sync-secret') || '';
  if (!env.SYNC_SECRET || sentSecret !== env.SYNC_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const missing = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'].filter((k) => !env[k]);
  if (missing.length) {
    return json({ ok: true, skipped: true, reason: `missing env: ${missing.join(', ')}` });
  }

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const { dateFrom, dateTo } = resolveRange(body.date_from, body.date_to);

  const apiVersion = env.GOOGLE_ADS_API_VERSION || DEFAULT_API_VERSION;
  const customerId = String(env.GOOGLE_ADS_CUSTOMER_ID).replace(/\D/g, '');

  const runStartedAt = Date.now();
  let status = 'ok', errorMessage = null, spendRows = 0, kwRows = 0, shareRows = 0, termRows = 0;

  try {
    const accessToken = await getAccessToken(env);
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'Content-Type': 'application/json',
    };
    const loginId = (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/\D/g, '');
    if (loginId) headers['login-customer-id'] = loginId;

    // --- Campaign spend -> ad_spend (platform='google') ---
    const campaignRows = await runQuery(apiVersion, customerId, headers,
      `SELECT campaign.id, campaign.name, segments.date,
              metrics.cost_micros, metrics.impressions, metrics.clicks
       FROM campaign
       WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'`);
    spendRows = await upsertAdSpend(env.DB, campaignRows);

    // --- Keyword performance -> keyword_stats ---
    // quality_score e as parcelas de impressão só vêm em linhas com veiculação;
    // filtrar por impressions > 0 evita arrastar milhares de keywords zeradas.
    const keywordRows = await runQuery(apiVersion, customerId, headers,
      `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
              ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
              ad_group_criterion.quality_info.quality_score,
              segments.date,
              metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions,
              metrics.search_impression_share, metrics.search_top_impression_share
       FROM keyword_view
       WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
         AND metrics.impressions > 0
         AND ad_group_criterion.status != 'REMOVED'`);
    kwRows = await upsertKeywords(env.DB, keywordRows);

    // --- Disputa de leilão -> campaign_share ---
    // Auction Insights (domínios concorrentes) não existe na API; parcela de
    // impressões e o motivo da perda (classificação x orçamento) existem, e são
    // o que dá pra agir em cima.
    const shareQueryRows = await runQuery(apiVersion, customerId, headers,
      `SELECT campaign.id, campaign.name, segments.date,
              metrics.search_impression_share,
              metrics.search_rank_lost_impression_share,
              metrics.search_budget_lost_impression_share,
              metrics.search_top_impression_share,
              metrics.search_absolute_top_impression_share
       FROM campaign
       WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
         AND campaign.advertising_channel_type = 'SEARCH'`);
    shareRows = await upsertCampaignShare(env.DB, shareQueryRows);

    // --- Termos de busca reais -> search_terms ---
    const termQueryRows = await runQuery(apiVersion, customerId, headers,
      `SELECT campaign.id, campaign.name, ad_group.id,
              search_term_view.search_term, segments.search_term_match_type, segments.date,
              metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
       FROM search_term_view
       WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'`);
    termRows = await upsertSearchTerms(env.DB, termQueryRows);
  } catch (err) {
    status = 'error';
    errorMessage = err.message || String(err);
  }

  const durationMs = Date.now() - runStartedAt;
  const runAt = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`
      INSERT INTO sync_log (platform, status, rows_upserted, date_from, date_to, error_message, duration_ms, run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('google', status, spendRows + kwRows + shareRows + termRows, dateFrom, dateTo, errorMessage, durationMs, runAt).run();
  } catch (_) { /* ignore */ }

  if (status === 'error') {
    return json({ ok: false, error: errorMessage, duration_ms: durationMs }, 500);
  }
  return json({
    ok: true, spend_rows: spendRows, keyword_rows: kwRows, share_rows: shareRows, search_term_rows: termRows,
    duration_ms: durationMs, date_from: dateFrom, date_to: dateTo,
  });
}

// -----------------------------------------------------------------------------
// Google Ads API
// -----------------------------------------------------------------------------

async function getAccessToken(env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`OAuth ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error('OAuth: no access_token in response');
  return data.access_token;
}

// searchStream returns a JSON array of chunks, each with a `results` array.
async function runQuery(apiVersion, customerId, headers, query) {
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:searchStream`;
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query }) });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Google Ads ${resp.status}: ${t.slice(0, 400)}`);
  }
  const chunks = await resp.json();
  const out = [];
  for (const c of Array.isArray(chunks) ? chunks : []) {
    if (Array.isArray(c.results)) out.push(...c.results);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Upserts
// -----------------------------------------------------------------------------

async function upsertAdSpend(db, rows) {
  if (!db || rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO ad_spend
      (platform, date, campaign_id, campaign_name, ad_id, ad_name, spend_cents, currency, impressions, clicks, synced_at)
    VALUES ('google', ?, ?, ?, NULL, NULL, ?, 'BRL', ?, ?, ?)
    ON CONFLICT(platform, date, campaign_id, COALESCE(ad_id, ''))
    DO UPDATE SET
      campaign_name = excluded.campaign_name,
      spend_cents   = excluded.spend_cents,
      impressions   = excluded.impressions,
      clicks        = excluded.clicks,
      synced_at     = excluded.synced_at
  `);
  const batch = rows.map((r) => {
    const m = r.metrics || {}, c = r.campaign || {}, s = r.segments || {};
    return stmt.bind(
      s.date,
      String(c.id || ''),
      c.name || '',
      microsToCents(m.costMicros),
      toInt(m.impressions),
      toInt(m.clicks),
      now,
    );
  });
  await chunkedBatch(db, batch);
  return rows.length;
}

async function upsertKeywords(db, rows) {
  if (!db || rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO keyword_stats
      (date, campaign_id, campaign_name, ad_group_id, ad_group_name, keyword, match_type,
       clicks, impressions, cost_cents, conversions, quality_score, search_is, top_is, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, campaign_id, ad_group_id, keyword, match_type)
    DO UPDATE SET
      campaign_name = excluded.campaign_name,
      ad_group_name = excluded.ad_group_name,
      clicks        = excluded.clicks,
      impressions   = excluded.impressions,
      cost_cents    = excluded.cost_cents,
      conversions   = excluded.conversions,
      quality_score = excluded.quality_score,
      search_is     = excluded.search_is,
      top_is        = excluded.top_is,
      synced_at     = excluded.synced_at
  `);
  const batch = [];
  for (const r of rows) {
    const m = r.metrics || {}, c = r.campaign || {}, ag = r.adGroup || {};
    const crit = r.adGroupCriterion || {};
    const kw = crit.keyword || {};
    const text = kw.text;
    if (!text) continue; // keyword_view rows always carry a keyword, but be safe
    batch.push(stmt.bind(
      r.segments?.date,
      String(c.id || ''),
      c.name || '',
      String(ag.id || ''),
      ag.name || '',
      text,
      kw.matchType || '',
      toInt(m.clicks),
      toInt(m.impressions),
      microsToCents(m.costMicros),
      Number(m.conversions || 0),
      crit.qualityInfo?.qualityScore ?? null,
      numOrNull(m.searchImpressionShare),
      numOrNull(m.searchTopImpressionShare),
      now,
    ));
  }
  if (batch.length === 0) return 0;
  await chunkedBatch(db, batch);
  return batch.length;
}

async function upsertCampaignShare(db, rows) {
  if (!db || rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO campaign_share
      (date, campaign_id, campaign_name, search_is, lost_is_rank, lost_is_budget, top_is, abs_top_is, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, campaign_id)
    DO UPDATE SET
      campaign_name  = excluded.campaign_name,
      search_is      = excluded.search_is,
      lost_is_rank   = excluded.lost_is_rank,
      lost_is_budget = excluded.lost_is_budget,
      top_is         = excluded.top_is,
      abs_top_is     = excluded.abs_top_is,
      synced_at      = excluded.synced_at
  `);
  const batch = rows.map((r) => {
    const m = r.metrics || {}, c = r.campaign || {};
    return stmt.bind(
      r.segments?.date,
      String(c.id || ''),
      c.name || '',
      Number(m.searchImpressionShare || 0),
      Number(m.searchRankLostImpressionShare || 0),
      Number(m.searchBudgetLostImpressionShare || 0),
      Number(m.searchTopImpressionShare || 0),
      Number(m.searchAbsoluteTopImpressionShare || 0),
      now,
    );
  });
  await chunkedBatch(db, batch);
  return batch.length;
}

async function upsertSearchTerms(db, rows) {
  if (!db || rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO search_terms
      (date, campaign_id, campaign_name, ad_group_id, search_term, match_type,
       clicks, impressions, cost_cents, conversions, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, campaign_id, ad_group_id, search_term, match_type)
    DO UPDATE SET
      campaign_name = excluded.campaign_name,
      clicks        = excluded.clicks,
      impressions   = excluded.impressions,
      cost_cents    = excluded.cost_cents,
      conversions   = excluded.conversions,
      synced_at     = excluded.synced_at
  `);
  const batch = [];
  for (const r of rows) {
    const m = r.metrics || {}, c = r.campaign || {}, ag = r.adGroup || {};
    const term = r.searchTermView?.searchTerm;
    if (!term) continue;
    batch.push(stmt.bind(
      r.segments?.date,
      String(c.id || ''),
      c.name || '',
      String(ag.id || ''),
      term,
      r.segments?.searchTermMatchType || '',
      toInt(m.clicks),
      toInt(m.impressions),
      microsToCents(m.costMicros),
      Number(m.conversions || 0),
      now,
    ));
  }
  if (batch.length === 0) return 0;
  await chunkedBatch(db, batch);
  return batch.length;
}

// search_term_view de 7 dias já passa de mil linhas; um único db.batch() desse
// tamanho estoura o limite de statements do D1, então vai em blocos.
async function chunkedBatch(db, stmts, size = 200) {
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch(stmts.slice(i, i + size));
  }
}

function numOrNull(v) { return v == null ? null : Number(v); }

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function microsToCents(micros) { return Math.round((Number(micros || 0) / 1e6) * 100); }
function toInt(v) { return parseInt(v || '0', 10) || 0; }

function resolveRange(dateFrom, dateTo) {
  const today = new Date();
  const fallbackFrom = addDays(today, -7);
  const from = isYmd(dateFrom) ? dateFrom : ymd(fallbackFrom);
  const to = isYmd(dateTo) ? dateTo : ymd(today);
  return { dateFrom: from, dateTo: to };
}
function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function ymd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function addDays(d, n) { const nd = new Date(d); nd.setUTCDate(nd.getUTCDate() + n); return nd; }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
