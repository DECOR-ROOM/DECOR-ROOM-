// GET /api/report?key=<DASH_KEY>&days=30  (or &from=YYYY-MM-DD&to=YYYY-MM-DD)
//
// Read-only BI aggregation for /dashboard. Reads TWO D1 databases:
//   env.DB    -> decorroom-db  (web/ads: ad_spend, event_log, sessions)
//   env.CRMDB -> crm-db        (CRM: leads funnel/segments/loss/cities/origin)

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) return json({ error: 'Unauthorized' }, 401);

  // ---- date range ----
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  let fromMs, toMs, fromDate, toDate;
  if (from && to) {
    fromDate = from; toDate = to;
    fromMs = Date.parse(from + 'T00:00:00Z'); toMs = Date.parse(to + 'T23:59:59Z');
  } else {
    const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
    toMs = Date.now(); fromMs = toMs - days * 86400000;
    fromDate = iso(fromMs); toDate = iso(toMs);
  }
  const fromSec = Math.floor(fromMs / 1000), toSec = Math.floor(toMs / 1000);
  const out = { from: fromDate, to: toDate, crm_bound: !!env.CRMDB };

  // ---- CRM (crm-db) ----
  if (env.CRMDB) {
    try {
      const C = env.CRMDB;
      const w = 'deleted_at IS NULL AND first_seen_at BETWEEN ? AND ?';
      const P = [fromMs, toMs];
      const [funnel, rev, prod, environ, prop, loss, ufs, cities, totals, leadRows, dailyLeads] = await Promise.all([
        C.prepare(`SELECT stage, COUNT(*) n FROM leads WHERE ${w} GROUP BY stage`).bind(...P).all(),
        C.prepare(`SELECT COALESCE(SUM(CASE WHEN stage='orcado' THEN quote_value END),0) pending,
                          COALESCE(SUM(CASE WHEN stage='ganho'  THEN sale_value  END),0) won FROM leads WHERE ${w}`).bind(...P).first(),
        C.prepare(`SELECT product_interest k, COUNT(*) n, COALESCE(SUM(CASE WHEN stage='ganho' THEN sale_value END),0) won FROM leads WHERE ${w} AND product_interest IS NOT NULL GROUP BY product_interest ORDER BY n DESC`).bind(...P).all(),
        C.prepare(`SELECT environment_type k, COUNT(*) n FROM leads WHERE ${w} AND environment_type IS NOT NULL GROUP BY environment_type ORDER BY n DESC`).bind(...P).all(),
        C.prepare(`SELECT property_type k, COUNT(*) n FROM leads WHERE ${w} AND property_type IS NOT NULL GROUP BY property_type ORDER BY n DESC`).bind(...P).all(),
        C.prepare(`SELECT loss_reason k, COUNT(*) n FROM leads WHERE ${w} AND stage='perdido' AND loss_reason IS NOT NULL GROUP BY loss_reason ORDER BY n DESC`).bind(...P).all(),
        C.prepare(`SELECT uf k, COUNT(*) n FROM leads WHERE ${w} AND uf IS NOT NULL AND uf<>'' GROUP BY uf`).bind(...P).all(),
        C.prepare(`SELECT city k, uf, COUNT(*) n FROM leads WHERE ${w} AND city IS NOT NULL AND city<>'' GROUP BY city, uf ORDER BY n DESC LIMIT 15`).bind(...P).all(),
        C.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN stage='qualificado' THEN 1 ELSE 0 END) qualificados, SUM(CASE WHEN stage='ganho' THEN 1 ELSE 0 END) ganhos FROM leads WHERE ${w}`).bind(...P).first(),
        // lead-level rows so we can resolve web_ref -> real channel (cross-DB, in JS)
        C.prepare(`SELECT COALESCE(origin,'desconhecido') origin, web_ref, stage, sale_value FROM leads WHERE ${w}`).bind(...P).all(),
        C.prepare(`SELECT strftime('%Y-%m-%d', first_seen_at/1000, 'unixepoch') d, COUNT(*) n FROM leads WHERE ${w} GROUP BY d`).bind(...P).all(),
      ]);

      // --- Attribution: resolve web_ref -> decorroom-db sessions (gclid/fbclid/UTMs) ---
      const leads = leadRows.results || [];
      const refs = [...new Set(leads.filter((l) => l.web_ref).map((l) => l.web_ref))];
      let sessMap = {}, resolved = 0;
      try { sessMap = await loadSessions(env.DB, refs); } catch (_) { sessMap = {}; }
      const oc = {}, revBy = {};
      for (const l of leads) {
        let eff = l.origin || 'desconhecido';
        if (l.web_ref) {
          const ch = resolveChannel(sessMap[l.web_ref]);
          if (ch) { eff = ch; resolved++; }            // paid/organic signal beats stored origin
        }
        oc[eff] = (oc[eff] || 0) + 1;
        if (l.stage === 'ganho') {
          const v = l.sale_value || 0;
          (revBy[eff] = revBy[eff] || { k: eff, won: 0, n: 0 }).won += v;
          revBy[eff].n += 1;
        }
      }
      out.crm = {
        funnel: rowsToMap(funnel.results, 'stage', 'n'),
        pending_revenue: rev?.pending || 0, won_revenue: rev?.won || 0,
        by_product: prod.results || [], by_environment: environ.results || [], by_property: prop.results || [],
        loss_reasons: loss.results || [], by_uf: ufs.results || [], top_cities: cities.results || [],
        total: totals?.total || 0, qualified: totals?.qualificados || 0, sales: totals?.ganhos || 0,
        leads_meta: oc.meta || 0, leads_google: oc.google || 0,
        by_origin: Object.entries(oc).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n),
        revenue_by_origin: Object.values(revBy).sort((a, b) => b.won - a.won),
        attribution_resolved: resolved, web_refs_seen: refs.length,
        daily_leads: (dailyLeads.results || []).reduce((m, r) => { m[r.d] = r.n; return m; }, {}),
      };
    } catch (e) { out.crm_error = e.message; }
  }

  // ---- Web / Ads (decorroom-db) ----
  try {
    const D = env.DB;
    const [spend, webleads, sess, daily, topads, kw] = await Promise.all([
      D.prepare(`SELECT platform, COALESCE(SUM(spend_cents),0) cents, COALESCE(SUM(clicks),0) clk, COALESCE(SUM(impressions),0) impr FROM ad_spend WHERE date BETWEEN ? AND ? GROUP BY platform`).bind(fromDate, toDate).all(),
      D.prepare(`SELECT COUNT(*) n FROM event_log WHERE event_name='Lead' AND is_bot=0 AND timestamp BETWEEN ? AND ?`).bind(fromSec, toSec).first(),
      D.prepare(`SELECT COUNT(*) n FROM sessions WHERE created_at BETWEEN ? AND ?`).bind(fromSec, toSec).first(),
      D.prepare(`SELECT date, COALESCE(SUM(spend_cents),0) cents FROM ad_spend WHERE date BETWEEN ? AND ? GROUP BY date ORDER BY date`).bind(fromDate, toDate).all(),
      D.prepare(`SELECT ad_name, COALESCE(SUM(spend_cents),0) cents, COALESCE(SUM(impressions),0) impr, COALESCE(SUM(clicks),0) clk FROM ad_spend WHERE date BETWEEN ? AND ? AND ad_name IS NOT NULL GROUP BY ad_name HAVING SUM(spend_cents)>0 ORDER BY cents DESC LIMIT 10`).bind(fromDate, toDate).all(),
      D.prepare(`SELECT keyword, COALESCE(SUM(cost_cents),0) cost, COALESCE(SUM(clicks),0) clk, COALESCE(SUM(conversions),0) conv FROM keyword_stats WHERE date BETWEEN ? AND ? GROUP BY keyword HAVING SUM(cost_cents)>0 OR SUM(clicks)>0 ORDER BY cost DESC LIMIT 10`).bind(fromDate, toDate).all(),
    ]);
    const sm = {}, clk = {}; (spend.results || []).forEach((r) => { sm[r.platform] = r.cents; clk[r.platform] = r.clk; });
    const metaCents = sm.meta || 0, googleCents = sm.google || 0;
    out.ads = {
      meta_invest: metaCents / 100, google_invest: googleCents / 100, total_invest: (metaCents + googleCents) / 100,
      meta_clicks: clk.meta || 0, google_clicks: clk.google || 0,
      web_leads: webleads?.n || 0, lp_views: sess?.n || 0,
      daily: (daily.results || []).map((d) => ({ date: d.date, invest: d.cents / 100 })),
      top_ads: (topads.results || []).map((a) => ({ name: a.ad_name, invest: a.cents / 100, impr: a.impr, clk: a.clk })),
      // leads = Google-tracked conversions (WhatsApp clicks); cpl = cost / leads.
      keywords: (kw.results || []).map((r) => {
        const leads = Math.round(r.conv || 0);
        return { kw: r.keyword, leads, clicks: r.clk, cost: r.cost / 100, cpl: leads > 0 ? (r.cost / 100) / leads : 0 };
      }),
    };
  } catch (e) { out.ads_error = e.message; }

  // ---- Source health ----
  // Every panel above renders zeros both when a source is genuinely empty and
  // when it stopped feeding. Without this block the dashboard can't tell the
  // two apart, so an integration can die unnoticed for weeks. Freshness is
  // deliberately period-independent: it answers "is this source still alive?",
  // not "what happened in the selected range".
  out.health = await collectHealth(env);

  return json(out, 200, { 'Cache-Control': 'no-store' });
}

// Last-write timestamp (unix seconds) per source, plus the outcome of the most
// recent ad-spend sync run. Never throws: a source that errors reports null.
async function collectHealth(env) {
  const h = {};
  await Promise.all([
    one(env.DB, `SELECT MAX(created_at) v FROM sessions`, (v) => { h.last_session = v; }),
    one(env.DB, `SELECT MAX(timestamp) v FROM event_log WHERE event_name='Lead' AND is_bot=0`, (v) => { h.last_web_lead = v; }),
    one(env.DB, `SELECT MAX(date) v FROM ad_spend WHERE platform='meta'`, (v) => { h.last_spend_meta = v; }),
    one(env.DB, `SELECT MAX(date) v FROM ad_spend WHERE platform='google'`, (v) => { h.last_spend_google = v; }),
    one(env.DB, `SELECT MAX(date) v FROM keyword_stats`, (v) => { h.last_keyword_stats = v; }),
    one(env.CRMDB, `SELECT MAX(first_seen_at) v FROM leads WHERE deleted_at IS NULL`, (v) => { h.last_crm_lead = v ? Math.floor(v / 1000) : null; }),
    one(env.CRMDB, `SELECT MAX(received_at) v FROM webhook_events`, (v) => { h.last_whatsapp_event = v ? Math.floor(v / 1000) : null; }),
    (async () => {
      try {
        const r = await env.DB.prepare(`
          SELECT platform, status, rows_upserted, error_message, run_at FROM sync_log
          WHERE id IN (SELECT MAX(id) FROM sync_log GROUP BY platform)
        `).all();
        h.syncs = (r.results || []).reduce((m, s) => {
          m[s.platform] = { status: s.status, rows: s.rows_upserted, error: s.error_message, run_at: s.run_at };
          return m;
        }, {});
      } catch (_) { h.syncs = {}; }
    })(),
  ]);
  return h;
}

async function one(db, sql, set) {
  if (!db) return set(null);
  try { const r = await db.prepare(sql).first(); set(r ? r.v : null); }
  catch (_) { set(null); }
}

// Cross-DB lookup: web_ref (= _krob_sid) -> sessions row (gclid/fbclid/UTMs).
// Chunked to stay under D1's bound-parameter limit.
async function loadSessions(DB, refs) {
  const map = {};
  for (let i = 0; i < refs.length; i += 40) {
    const chunk = refs.slice(i, i + 40);
    const ph = chunk.map(() => '?').join(',');
    const r = await DB.prepare(
      `SELECT session_id, gclid, fbclid, fbc, utm_source, utm_medium FROM sessions WHERE session_id IN (${ph})`
    ).bind(...chunk).all();
    (r.results || []).forEach((s) => { map[s.session_id] = s; });
  }
  return map;
}

// Map a web session to a marketing channel. Returns null when there's no signal
// (then the lead keeps its stored origin, e.g. 'site').
function resolveChannel(s) {
  if (!s) return null;
  const src = (s.utm_source || '').toLowerCase();
  const med = (s.utm_medium || '').toLowerCase();
  const paid = med.includes('cpc') || med.includes('ppc') || med.includes('paid');
  if (s.gclid || (src.includes('google') && paid) || src.includes('adwords')) return 'google';
  if (s.fbclid || s.fbc || src.includes('facebook') || src.includes('instagram') || src === 'ig' || src === 'fb' || src.includes('meta')) return 'meta';
  if (src || med) return 'organico'; // tagged but non-paid (organic/social/referral/email)
  return null;
}

function rowsToMap(rows, k, v) { const m = {}; (rows || []).forEach((r) => { m[r[k]] = r[v]; }); return m; }
function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra },
  });
}
function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw || '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
