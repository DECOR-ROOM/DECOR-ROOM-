// POST /api/sync/meta-ads
//
// Pulls spend, impressions, and clicks from Meta Marketing API v22 for the
// configured ad account and UPSERTs them into the `ad_spend` table. Called
// on a schedule by an external cron (see docs/ad-spend-sync.md). The
// dashboard reads ad_spend directly — it never hits this endpoint in the
// request path.
//
// Auth:     header `x-sync-secret: <env.SYNC_SECRET>` — any request missing
//           or mismatching the secret is rejected 401.
// Body:     { date_from?: 'YYYY-MM-DD', date_to?: 'YYYY-MM-DD' }
//           Defaults to the last 7 days if omitted, which is the right
//           window for hourly cron re-fetches of recent spend.
// Required env:
//   SYNC_SECRET              random string, shared between cron and this endpoint
//   META_ADS_ACCESS_TOKEN    Meta Marketing API user/system token
//   META_ADS_ACCOUNT_ID      Meta ad account ID (e.g. '1234567890' — no 'act_' prefix)
//
// If any required env is missing, returns 200 with skipped:true so the cron
// provider doesn't mark the endpoint as failing — a recipient who hasn't
// configured ad spend sync still wants a healthy ping response.

export async function onRequestPost(context) {
  const { request, env } = context;

  const sentSecret = request.headers.get('x-sync-secret') || '';
  if (!env.SYNC_SECRET || sentSecret !== env.SYNC_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (!env.META_ADS_ACCESS_TOKEN || !env.META_ADS_ACCOUNT_ID) {
    return json({
      ok: true,
      skipped: true,
      reason: 'META_ADS_ACCESS_TOKEN and META_ADS_ACCOUNT_ID must be set to enable sync',
    });
  }

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }

  const { dateFrom, dateTo } = resolveRange(body.date_from, body.date_to);

  const runStartedAt = Date.now();
  let status = 'ok';
  let errorMessage = null;
  let rowsUpserted = 0;

  try {
    const accountId = String(env.META_ADS_ACCOUNT_ID).replace(/^act_/, '');
    const url = `https://graph.facebook.com/v22.0/act_${accountId}/insights` +
      `?fields=campaign_id,campaign_name,spend,impressions,clicks,account_currency,date_start` +
      `&time_range=${encodeURIComponent(JSON.stringify({ since: dateFrom, until: dateTo }))}` +
      `&level=campaign` +
      `&time_increment=1` +
      `&limit=500` +
      `&access_token=${env.META_ADS_ACCESS_TOKEN}`;

    const rows = await fetchAllPages(url);
    rowsUpserted = await upsertAdSpend(env.DB, rows);
  } catch (err) {
    status = 'error';
    errorMessage = err.message || String(err);
  }

  const durationMs = Date.now() - runStartedAt;
  const runAt = Math.floor(Date.now() / 1000);

  // Sync log write always succeeds best-effort; a logging failure shouldn't
  // make the caller think the whole sync failed.
  try {
    await env.DB.prepare(`
      INSERT INTO sync_log (platform, status, rows_upserted, date_from, date_to, error_message, duration_ms, run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('meta', status, rowsUpserted, dateFrom, dateTo, errorMessage, durationMs, runAt).run();
  } catch (_) { /* ignore */ }

  if (status === 'error') {
    return json({ ok: false, error: errorMessage, rows_upserted: rowsUpserted, duration_ms: durationMs }, 500);
  }
  return json({ ok: true, rows_upserted: rowsUpserted, duration_ms: durationMs, date_from: dateFrom, date_to: dateTo });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function fetchAllPages(url) {
  const all = [];
  let next = url;
  let safety = 20; // prevent runaway pagination on buggy responses
  while (next && safety-- > 0) {
    const resp = await fetch(next);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Meta API ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    if (Array.isArray(data.data)) all.push(...data.data);
    next = data.paging?.next || null;
  }
  return all;
}

async function upsertAdSpend(db, rows) {
  if (!db || rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO ad_spend
      (platform, date, campaign_id, campaign_name, ad_id, ad_name, spend_cents, currency, impressions, clicks, synced_at)
    VALUES ('meta', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, date, campaign_id, COALESCE(ad_id, ''))
    DO UPDATE SET
      campaign_name = excluded.campaign_name,
      spend_cents   = excluded.spend_cents,
      currency      = excluded.currency,
      impressions   = excluded.impressions,
      clicks        = excluded.clicks,
      synced_at     = excluded.synced_at
  `);

  const batch = rows.map(r => stmt.bind(
    r.date_start,
    String(r.campaign_id || ''),
    r.campaign_name || '',
    Math.round(parseFloat(r.spend || '0') * 100),
    r.account_currency || 'BRL',
    parseInt(r.impressions || '0', 10) || 0,
    parseInt(r.clicks || '0', 10) || 0,
    now,
  ));

  await db.batch(batch);
  return rows.length;
}

function resolveRange(dateFrom, dateTo) {
  const today = new Date();
  const fallbackFrom = addDays(today, -7);
  const from = isYmd(dateFrom) ? dateFrom : ymd(fallbackFrom);
  const to = isYmd(dateTo) ? dateTo : ymd(today);
  return { dateFrom: from, dateTo: to };
}

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function ymd(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(d, n) {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + n);
  return nd;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
