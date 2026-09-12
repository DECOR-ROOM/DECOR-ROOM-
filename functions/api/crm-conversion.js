// POST /api/crm-conversion
//
// Sends the CRM funnel conversions queued in crm-db.lead_conversions —
// Lead_qualificado, Lead_orcado (value = quote_value), Lead_ganho (value =
// sale_value) and Lead_desqualificado, queued when a lead reaches that stage in
// decorroom-crm. The CRM only enqueues; this project sends, because it holds the
// Google Ads + Meta Pixel credentials and the visitor's session (gclid, fbc/fbp,
// IP, user agent) that make the match.
//
//   Google Ads -> offline conversion through the Data Manager API
//                 (datamanager.googleapis.com/v1/events:ingest) on the UPLOAD_CLICKS
//                 action with the same name as the event. Needs the gclid of the
//                 site visit (lead.gclid, or the session behind web_ref). The
//                 action is SECONDARY (not in "Conversões") — a signal for
//                 reporting/audiences, never a bidding goal.
//                 Why not ConversionUploadService.uploadClickConversions: Google
//                 closed it to new integrations (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_
//                 FEATURE, seen 11/09/2026). The Data Manager API needs an OAuth
//                 token with the `datamanager` scope — GOOGLE_DM_REFRESH_TOKEN,
//                 minted by scripts/autorizar-google-datamanager.mjs in the
//                 decorroom-crm repo (not here: this repo root is public). Until it
//                 exists, Google rows wait in the queue without burning attempts.
//   Meta       -> Conversions API on META_PIXEL_ID, action_source
//                 system_generated, matched by hashed phone + session ids.
//
// Called by the CRM right after the stage change ({ lead_id }) and by the CRM
// monitor cron every few minutes ({}), which retries whatever is still pending.
//
// Auth: header `x-crm-secret: <env.CRM_EVENT_SECRET>` (same value set on the
// decorroom-crm project).

const DEFAULT_API_VERSION = 'v22';
const GRAPH_VERSION = 'v25.0';
const MAX_ATTEMPTS = 15;
const WAIT_FOR_SETUP_MS = 6 * 3600_000;

// Which lead column carries the value of each funnel event. Keep in sync with
// EVENT_VALUE_FIELD in the CRM's functions/lib/taxonomy.js.
const EVENT_VALUE_FIELD = { Lead_orcado: 'quote_value', Lead_ganho: 'sale_value' };
const DM_SETUP = 'Aguardando autorização do Google para a Data Manager API (GOOGLE_DM_REFRESH_TOKEN) — sai sozinho depois de autorizar';
function eventValue(event, lead) {
  const v = Number(lead?.[EVENT_VALUE_FIELD[event]] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

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
  // { retry_waiting: true } makes rows parked for setup eligible right away —
  // used once the Data Manager token has just been configured.
  if (body.retry_waiting === true && !test) {
    await env.CRMDB.prepare(`UPDATE lead_conversions SET next_attempt_at = NULL WHERE status = 'pendente'`).run();
  }

  const where = test ? [] : [`status = 'pendente'`, `(next_attempt_at IS NULL OR next_attempt_at <= ?)`];
  const params = test ? [] : [now];
  if (leadId) { where.push('lead_id = ?'); params.push(leadId); }
  const rows = (await env.CRMDB.prepare(
    `SELECT * FROM lead_conversions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id LIMIT 20`,
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
          : row.platform === 'google_audience'
            ? await google.addToAudience(lead)
            : row.platform === 'meta'
              ? await sendMeta(env, row.event, lead, session, metaTestCode)
              : { status: 'falhou', detail: `plataforma desconhecida: ${row.platform}` };
      } catch (e) {
        res = { status: 'pendente', detail: `erro: ${e.message || e}` };
      }
    }
    if (test) { out.push({ id: row.id, platform: row.platform, event: row.event, ...res }); continue; }
    // A setup problem (missing token, API disabled) isn't the conversion's fault:
    // park it without counting the attempt, so it goes out once setup is done.
    const attempts = (row.attempts || 0) + (res.setup ? 0 : 1);
    if (res.status === 'pendente' && attempts >= MAX_ATTEMPTS) res.status = 'falhou';
    const next = res.status === 'pendente' ? now + (res.setup ? WAIT_FOR_SETUP_MS : (res.retryInMs || backoff(attempts))) : null;
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
// Google Ads — offline conversion via the Data Manager API
// -----------------------------------------------------------------------------

class GoogleAds {
  constructor(env, { validateOnly = false } = {}) {
    this.env = env;
    this.validateOnly = validateOnly;
    this.version = env.GOOGLE_ADS_API_VERSION || DEFAULT_API_VERSION;
    this.customerId = String(env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/\D/g, '');
    this.loginId = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/\D/g, '');
    this.adsHeaders = null;
    this.dmToken = null;
    this.actions = {};
  }

  // Data Manager API token (datamanager scope). Separate from the adwords
  // credentials above because Google requires its own consent for this scope.
  async dm() {
    if (this.dmToken) return this.dmToken;
    const env = this.env;
    this.dmToken = await accessToken(
      env.GOOGLE_DM_CLIENT_ID || env.GOOGLE_ADS_CLIENT_ID,
      env.GOOGLE_DM_CLIENT_SECRET || env.GOOGLE_ADS_CLIENT_SECRET,
      env.GOOGLE_DM_REFRESH_TOKEN,
    );
    return this.dmToken;
  }

  // Where the data lands: the Google Ads account, plus which product inside it
  // (a conversion action id, or a user list id for Customer Match).
  destination(productDestinationId) {
    const d = {
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: this.customerId },
      productDestinationId,
    };
    if (this.loginId) d.loginAccount = { accountType: 'GOOGLE_ADS', accountId: this.loginId };
    return d;
  }

  // Reads a Data Manager response the same way everywhere: 401/403 is a setup
  // problem (parks without burning an attempt), 429/5xx retries, the rest fails.
  async readDm(resp, okDetail) {
    const text = await resp.text();
    let data = {};
    try { data = JSON.parse(text); } catch (_) { /* keep {} */ }
    if (resp.ok) return { status: 'enviado', detail: okDetail(data) };
    const msg = data.error?.message || text.slice(0, 250);
    if (resp.status === 401 || resp.status === 403) {
      return { status: 'pendente', setup: true, detail: `Google recusou a credencial (${resp.status}): ${msg}`.slice(0, 450) };
    }
    const retry = resp.status === 429 || resp.status >= 500;
    return { status: retry ? 'pendente' : 'falhou', detail: `HTTP ${resp.status}: ${msg}`.slice(0, 450) };
  }

  // Customer Match: put the lead's phone in the list that the campaigns exclude.
  // Matches by phone, so it works for leads with no gclid too — which is most of
  // them. The list only actually blocks impressions once Google matches enough
  // members (~1.000); below that it sits inert, by Google's rule, not ours.
  async addToAudience(lead) {
    const env = this.env;
    const list = String(env.GOOGLE_ADS_EXCLUSION_LIST_ID || '').replace(/\D/g, '');
    if (!list) return { status: 'ignorado', detail: 'GOOGLE_ADS_EXCLUSION_LIST_ID não configurada' };
    if (!env.GOOGLE_DM_REFRESH_TOKEN) return { status: 'pendente', setup: true, detail: DM_SETUP };

    const e164 = toE164(lead.phone, env.DEFAULT_COUNTRY_CODE);
    if (!e164) return { status: 'ignorado', detail: 'Lead sem telefone para o Google casar' };

    const resp = await fetch('https://datamanager.googleapis.com/v1/audienceMembers:ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.dm()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destinations: [this.destination(list)],
        audienceMembers: [{ userData: { userIdentifiers: [{ phoneNumber: await sha256Hex(e164, false) }] } }],
        consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' },
        termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' },
        encoding: 'HEX',
        validateOnly: this.validateOnly,
      }),
    });
    return this.readDm(resp, (d) => `Entrou no público de exclusão (requestId ${d.requestId || '?'})${this.validateOnly ? ' (validação)' : ''}`);
  }

  // Google Ads API (adwords scope — the credentials the hourly sync already uses).
  async ads() {
    if (this.adsHeaders) return this.adsHeaders;
    const env = this.env;
    const missing = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET',
      'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`env ausente: ${missing.join(', ')}`);
    const token = await accessToken(env.GOOGLE_ADS_CLIENT_ID, env.GOOGLE_ADS_CLIENT_SECRET, env.GOOGLE_ADS_REFRESH_TOKEN);
    this.adsHeaders = { Authorization: `Bearer ${token}`, 'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN, 'Content-Type': 'application/json' };
    if (this.loginId) this.adsHeaders['login-customer-id'] = this.loginId;
    return this.adsHeaders;
  }

  // Conversion action id, looked up by name (= event name). Override with
  // GOOGLE_ADS_ACTION_<EVENT> (e.g. GOOGLE_ADS_ACTION_LEAD_DESQUALIFICADO) to skip it.
  async actionId(name) {
    if (name in this.actions) return this.actions[name];
    const override = this.env[`GOOGLE_ADS_ACTION_${String(name).toUpperCase()}`];
    if (override) return (this.actions[name] = String(override));
    const safe = String(name).replace(/'/g, '');
    const resp = await fetch(`https://googleads.googleapis.com/${this.version}/customers/${this.customerId}/googleAds:search`, {
      method: 'POST', headers: await this.ads(),
      body: JSON.stringify({ query: `SELECT conversion_action.id FROM conversion_action WHERE conversion_action.name = '${safe}' AND conversion_action.status = 'ENABLED' AND conversion_action.type = 'UPLOAD_CLICKS' LIMIT 1` }),
    });
    if (!resp.ok) throw new Error(`Google Ads ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    return (this.actions[name] = data.results?.[0]?.conversionAction?.id ? String(data.results[0].conversionAction.id) : null);
  }

  async upload(event, lead, session) {
    const gclid = lead.gclid || session?.gclid || '';
    if (!gclid) return { status: 'ignorado', detail: 'Lead sem gclid (não veio de clique no Google Ads pelo site)' };

    const env = this.env;
    if (!env.GOOGLE_DM_REFRESH_TOKEN) return { status: 'pendente', setup: true, detail: DM_SETUP };

    const action = await this.actionId(event);
    if (!action) return { status: 'falhou', detail: `Ação de conversão "${event}" (UPLOAD_CLICKS, ativa) não existe no Google Ads` };

    const ev = {
      adIdentifiers: { gclid },
      eventTimestamp: brIso(Date.now()),
      conversionValue: eventValue(event, lead),
      currency: 'BRL',
      transactionId: `crm-${lead.id}-${event}`, // Google dedupes a resend of the same id
      eventSource: 'OTHER',
    };
    const e164 = toE164(lead.phone, env.DEFAULT_COUNTRY_CODE);
    if (e164) ev.userData = { userIdentifiers: [{ phoneNumber: await sha256Hex(e164, false) }] };

    const resp = await fetch('https://datamanager.googleapis.com/v1/events:ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.dm()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinations: [this.destination(action)], encoding: 'HEX', events: [ev], validateOnly: this.validateOnly }),
    });
    return this.readDm(resp, (d) => `Data Manager requestId ${d.requestId || '?'}${this.validateOnly ? ' (validação)' : ''}`);
  }
}

async function accessToken(clientId, clientSecret, refreshToken) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(`OAuth ${resp.status}: ${data.error || ''} ${data.error_description || ''}`.trim());
  return data.access_token;
}

// ISO 8601 in São Paulo time (no DST since 2019), the account's time zone.
function brIso(ms) {
  const d = new Date(ms - 3 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}-03:00`;
}

// Google wants E.164 ("+5547999999999") before hashing.
function toE164(ph, countryCode) {
  const digits = normalizePhone(ph, countryCode);
  return digits ? `+${digits}` : '';
}

// -----------------------------------------------------------------------------
// Meta — Conversions API
// -----------------------------------------------------------------------------

async function sendMeta(env, event, lead, session, testEventCode = null) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) return { status: 'falhou', detail: 'META_PIXEL_ID / META_ACCESS_TOKEN ausentes' };

  // Same normalization as tracker.js so the hashes match the site's events.
  const userData = {};
  const ph = normalizePhone(lead.phone, env.DEFAULT_COUNTRY_CODE);
  if (ph) userData.ph = [await sha256Hex(ph)];
  if (session?.external_id) userData.external_id = [await sha256Hex(session.external_id)];
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
      custom_data: {
        lead_stage: lead.stage,
        lead_origin: lead.origin || null,
        value: eventValue(event, lead),
        currency: env.META_CURRENCY || 'BRL',
      },
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

// SHA-256 hex. Meta hashes the lowercased/trimmed value (tracker.js does the
// same); Google gets the E.164 phone as is.
async function sha256Hex(value, lower = true) {
  const v = lower ? String(value).toLowerCase().trim() : String(value).trim();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
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
