// POST /api/crm-conversion
//
// Sends the CRM funnel conversions queued in crm-db.lead_conversions (today:
// Lead_desqualificado, queued when a lead moves to the "Desqualificado" stage
// in decorroom-crm). The CRM only enqueues; this project sends, because it holds
// the Google Ads + Meta Pixel credentials and the visitor's session (gclid,
// fbc/fbp, IP, user agent) that make the match.
//
//   Google Ads -> offline click conversion (uploadClickConversions) on the
//                 action with the same name as the event. Needs the gclid of
//                 the site visit (lead.gclid, or the session behind web_ref).
//                 The action is SECONDARY (not in "Conversões") — it's a signal
//                 for reporting/audiences, never a bidding goal.
//   Meta       -> Conversions API on META_PIXEL_ID, action_source
//                 system_generated, matched by hashed phone + session ids.
//
// Called by the CRM right after the stage change ({ lead_id }) and by the CRM
// monitor cron every few minutes ({}), which retries whatever is still pending
// (e.g. Google refuses uploads for a conversion action created < 6 h ago, and
// clicks < 6 h old: TOO_RECENT_*).
//
// Auth: header `x-crm-secret: <env.CRM_EVENT_SECRET>` (same value set on the
// decorroom-crm project).

const DEFAULT_API_VERSION = 'v22';
const GRAPH_VERSION = 'v25.0';
const MAX_ATTEMPTS = 15;
const RETRYABLE_GOOGLE = /TOO_RECENT_CONVERSION_ACTION|TOO_RECENT_EVENT|CLICK_NOT_FOUND|CONCURRENT_MODIFICATION|INTERNAL_ERROR|TRANSIENT_ERROR/;

export async function onRequestPost({ request, env }) {
  const sent = request.headers.get('x-crm-secret') || '';
  if (!env.CRM_EVENT_SECRET || sent !== env.CRM_EVENT_SECRET) return json({ error: 'Unauthorized' }, 401);
  if (!env.CRMDB) return json({ error: 'CRMDB binding ausente' }, 500);

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const leadId = Number(body.lead_id) || null;
  const now = Date.now();

  // Test mode ({ lead_id, test: true, test_event_code? }): runs that lead's rows
  // whatever their status, with Google validateOnly and Meta test_event_code,
  // and writes nothing back. For checking credentials/action/match end to end
  // without sending a real conversion.
  const test = body.test === true;
  if (test && !leadId) return json({ error: 'test exige lead_id' }, 400);

  const where = test ? [] : [`status = 'pendente'`, `(next_attempt_at IS NULL OR next_attempt_at <= ?)`];
  const params = test ? [] : [now];
  if (leadId) { where.push('lead_id = ?'); params.push(leadId); }
  const rows = (await env.CRMDB.prepare(
    `SELECT * FROM lead_conversions WHERE ${where.join(' AND ')} ORDER BY id LIMIT 20`,
  ).bind(...params).all()).results || [];

  const google = new GoogleAds(env, { validateOnly: test });
  const metaTestCode = test ? String(body.test_event_code || 'TEST_CRM') : null;
  const out = [];
  for (const row of rows) {
    const lead = await env.CRMDB.prepare('SELECT * FROM leads WHERE id = ?').bind(row.lead_id).first();
    let res;
    if (!lead) {
      res = { status: 'falhou', detail: 'lead não existe mais' };
    } else {
      const session = lead.web_ref && env.DB
        ? await env.DB.prepare('SELECT * FROM sessions WHERE session_id = ?').bind(lead.web_ref).first()
        : null;
      try {
        res = row.platform === 'google'
          ? await google.upload(row.event, lead, session)
          : row.platform === 'meta'
            ? await sendMeta(env, row.event, lead, session, metaTestCode)
            : { status: 'falhou', detail: `plataforma desconhecida: ${row.platform}` };
      } catch (e) {
        res = { status: 'pendente', detail: `erro: ${e.message || e}` };
      }
    }
    if (test) { out.push({ id: row.id, platform: row.platform, event: row.event, ...res }); continue; }
    const attempts = (row.attempts || 0) + 1;
    if (res.status === 'pendente' && attempts >= MAX_ATTEMPTS) res.status = 'falhou';
    const next = res.status === 'pendente' ? now + (res.retryInMs || backoff(attempts)) : null;
    await env.CRMDB.prepare(`
      UPDATE lead_conversions
      SET status = ?, detail = ?, attempts = ?, next_attempt_at = ?, updated_at = ?,
          sent_at = CASE WHEN ? = 'enviado' THEN ? ELSE sent_at END
      WHERE id = ?
    `).bind(res.status, truncate(res.detail, 500), attempts, next, now, res.status, now, row.id).run();
    out.push({ id: row.id, lead_id: row.lead_id, platform: row.platform, event: row.event, status: res.status, detail: res.detail });
  }
  return json({ ok: true, test, processed: out.length, results: out });
}

// 5 min, 10, 20, 40, 80 … capped at 6 h.
function backoff(attempts) { return Math.min(6 * 3600_000, 5 * 60_000 * 2 ** (attempts - 1)); }

// -----------------------------------------------------------------------------
// Google Ads — offline click conversion
// -----------------------------------------------------------------------------

class GoogleAds {
  constructor(env, { validateOnly = false } = {}) {
    this.env = env;
    this.validateOnly = validateOnly;
    this.version = env.GOOGLE_ADS_API_VERSION || DEFAULT_API_VERSION;
    this.customerId = String(env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/\D/g, '');
    this.headers = null;
    this.actions = {};
  }

  async auth() {
    if (this.headers) return this.headers;
    const env = this.env;
    const missing = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET',
      'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`env ausente: ${missing.join(', ')}`);
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
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) throw new Error(`OAuth ${resp.status}`);
    this.headers = {
      Authorization: `Bearer ${data.access_token}`,
      'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'Content-Type': 'application/json',
    };
    const loginId = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/\D/g, '');
    if (loginId) this.headers['login-customer-id'] = loginId;
    return this.headers;
  }

  // Conversion action resource name, looked up by name (= event name).
  async action(name) {
    if (name in this.actions) return this.actions[name];
    const headers = await this.auth();
    const safe = String(name).replace(/'/g, '');
    const resp = await fetch(`https://googleads.googleapis.com/${this.version}/customers/${this.customerId}/googleAds:search`, {
      method: 'POST', headers,
      body: JSON.stringify({ query: `SELECT conversion_action.resource_name FROM conversion_action WHERE conversion_action.name = '${safe}' AND conversion_action.status = 'ENABLED' LIMIT 1` }),
    });
    if (!resp.ok) throw new Error(`Google Ads ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    this.actions[name] = data.results?.[0]?.conversionAction?.resourceName || null;
    return this.actions[name];
  }

  async upload(event, lead, session) {
    const gclid = lead.gclid || session?.gclid || '';
    if (!gclid) return { status: 'ignorado', detail: 'Lead sem gclid (não veio de clique no Google Ads pelo site)' };
    const action = await this.action(event);
    if (!action) return { status: 'falhou', detail: `Ação de conversão "${event}" não existe (ou não está ativa) no Google Ads` };

    const resp = await fetch(`https://googleads.googleapis.com/${this.version}/customers/${this.customerId}:uploadClickConversions`, {
      method: 'POST',
      headers: await this.auth(),
      body: JSON.stringify({
        conversions: [{
          gclid,
          conversionAction: action,
          conversionDateTime: brDateTime(Date.now()),
          conversionValue: 0,
          currencyCode: 'BRL',
          orderId: `crm-${lead.id}-${event}`, // Google dedupes a re-upload of the same order
        }],
        partialFailure: true,
        validateOnly: this.validateOnly,
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const retry = resp.status === 429 || resp.status >= 500;
      return { status: retry ? 'pendente' : 'falhou', detail: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
    }
    let data = {};
    try { data = JSON.parse(text); } catch (_) { /* keep {} */ }
    const pf = data.partialFailureError;
    if (pf && (pf.code || pf.message)) {
      const blob = JSON.stringify(pf);
      const code = (blob.match(/"conversionUploadError"\s*:\s*"([A-Z_]+)"/) || blob.match(/"[a-zA-Z]+Error"\s*:\s*"([A-Z_]+)"/) || [])[1] || '';
      if (RETRYABLE_GOOGLE.test(blob)) {
        return { status: 'pendente', detail: `Google pediu para tentar mais tarde (${code || 'recente'})`, retryInMs: 60 * 60_000 };
      }
      return { status: 'falhou', detail: `${code || 'erro'}: ${String(pf.message || '').slice(0, 250)}` };
    }
    return { status: 'enviado', detail: `gclid ${gclid.slice(0, 12)}…` };
  }
}

// "yyyy-mm-dd hh:mm:ss-03:00" in São Paulo time (no DST since 2019), which is
// the account's time zone.
function brDateTime(ms) {
  const d = new Date(ms - 3 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}-03:00`;
}

// -----------------------------------------------------------------------------
// Meta — Conversions API
// -----------------------------------------------------------------------------

async function sendMeta(env, event, lead, session, testEventCode = null) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) return { status: 'falhou', detail: 'META_PIXEL_ID / META_ACCESS_TOKEN ausentes' };

  // Same normalization as tracker.js so the hashes match the site's events.
  const userData = {};
  const ph = normalizePhone(lead.phone, env.DEFAULT_COUNTRY_CODE);
  if (ph) userData.ph = [await sha256(ph)];
  if (session?.external_id) userData.external_id = [await sha256(session.external_id)];
  if (session?.fbp) userData.fbp = session.fbp;
  if (session?.fbc) userData.fbc = session.fbc;
  if (session?.ip_address) userData.client_ip_address = session.ip_address;
  if (session?.user_agent) userData.client_user_agent = session.user_agent;
  if (!Object.keys(userData).length) return { status: 'ignorado', detail: 'Lead sem telefone nem sessão para a Meta casar' };

  const payload = {
    data: [{
      event_name: event,
      event_time: Math.floor(Date.now() / 1000),
      event_id: `crm-${lead.id}-${event}`, // stable: a retry is deduplicated by Meta
      action_source: 'system_generated',
      user_data: userData,
      custom_data: { lead_stage: lead.stage, lead_origin: lead.origin || null },
    }],
  };
  const testCode = testEventCode || env.META_TEST_EVENT_CODE;
  if (testCode) payload.test_event_code = testCode;

  const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  if (resp.ok) return { status: 'enviado', detail: text.slice(0, 200) };
  const retry = resp.status === 429 || resp.status >= 500;
  return { status: retry ? 'pendente' : 'falhou', detail: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
}

async function sha256(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value).toLowerCase().trim()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizePhone(ph, countryCode) {
  if (!ph) return '';
  const cc = String(countryCode || '55');
  const digits = String(ph).replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  if (digits.startsWith(cc) && digits.length >= cc.length + 8 && digits.length <= cc.length + 11) return digits;
  if (digits.length >= 8 && digits.length <= 11) return cc + digits;
  return digits;
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) : s; }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
