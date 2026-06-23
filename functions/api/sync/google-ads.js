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
//   GOOGLE_ADS_API_VERSION       e.g. 'v18' (default below); bump if Google deprecates

const DEFAULT_API_VERSION = 'v18';

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
  let status = 'ok', errorMessage = null, spendRows = 0, kwRows = 0;

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
    const keywordRows = await runQuery(apiVersion, customerId, headers,
      `SELECT campaign.id, campaign.name, ad_group.id,
              ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
              segments.date,
              metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
       FROM keyword_view
       WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
         AND ad_group_criterion.status != 'REMOVED'`);
    kwRows = await upsertKeywords(env.DB, keywordRows);
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
    `).bind('google', status, spendRows + kwRows, dateFrom, dateTo, errorMessage, durationMs, runAt).run();
  } catch (_) { /* ignore */ }

  if (status === 'error') {
    return json({ ok: false, error: errorMessage, duration_ms: durationMs }, 500);
  }
  return json({ ok: true, spend_rows: spendRows, keyword_rows: kwRows, duration_ms: durationMs, date_from: dateFrom, date_to: dateTo });
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
  await db.batch(batch);
  return rows.length;
}

async function upsertKeywords(db, rows) {
  if (!db || rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO keyword_stats
      (date, campaign_id, campaign_name, ad_group_id, keyword, match_type, clicks, impressions, cost_cents, conversions, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, campaign_id, ad_group_id, keyword, match_type)
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
    const kw = r.adGroupCriterion?.keyword || {};
    const text = kw.text;
    if (!text) continue; // keyword_view rows always carry a keyword, but be safe
    batch.push(stmt.bind(
      r.segments?.date,
      String(c.id || ''),
      c.name || '',
      String(ag.id || ''),
      text,
      kw.matchType || '',
      toInt(m.clicks),
      toInt(m.impressions),
      microsToCents(m.costMicros),
      Number(m.conversions || 0),
      now,
    ));
  }
  if (batch.length === 0) return 0;
  await db.batch(batch);
  return batch.length;
}

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
