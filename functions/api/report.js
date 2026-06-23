// GET /api/report?key=<DASH_KEY>&days=30
//
// Read-only BI aggregation for /dashboard. Reads TWO D1 databases:
//   env.DB    -> decorroom-db  (web/ads: ad_spend, event_log, sessions)
//   env.CRMDB -> crm-db        (CRM: leads funnel/segments/loss/cities)
// CRMDB is a second binding added on the site Pages project. If it is not bound
// yet, the CRM sections come back empty (crm_bound:false) and the page still renders.

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) return json({ error: 'Unauthorized' }, 401);

  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const sinceMs = Date.now() - days * 86400000;
  const sinceSec = Math.floor(sinceMs / 1000);
  const sinceDate = new Date(sinceMs).toISOString().slice(0, 10);

  const out = { days, crm_bound: !!env.CRMDB };

  // ---- CRM (crm-db) ----
  if (env.CRMDB) {
    try {
      const C = env.CRMDB;
      const w = 'deleted_at IS NULL AND first_seen_at >= ?';
      const [funnel, rev, prod, environ, prop, loss, ufs, cities, totals] = await Promise.all([
        C.prepare(`SELECT stage, COUNT(*) n FROM leads WHERE ${w} GROUP BY stage`).bind(sinceMs).all(),
        C.prepare(`SELECT COALESCE(SUM(CASE WHEN stage='orcado' THEN quote_value END),0) pending,
                          COALESCE(SUM(CASE WHEN stage='ganho'  THEN sale_value  END),0) won
                   FROM leads WHERE ${w}`).bind(sinceMs).first(),
        C.prepare(`SELECT product_interest k, COUNT(*) n,
                          COALESCE(SUM(CASE WHEN stage='ganho' THEN sale_value END),0) won
                   FROM leads WHERE ${w} AND product_interest IS NOT NULL GROUP BY product_interest ORDER BY n DESC`).bind(sinceMs).all(),
        C.prepare(`SELECT environment_type k, COUNT(*) n FROM leads WHERE ${w} AND environment_type IS NOT NULL GROUP BY environment_type ORDER BY n DESC`).bind(sinceMs).all(),
        C.prepare(`SELECT property_type k, COUNT(*) n FROM leads WHERE ${w} AND property_type IS NOT NULL GROUP BY property_type ORDER BY n DESC`).bind(sinceMs).all(),
        C.prepare(`SELECT loss_reason k, COUNT(*) n FROM leads WHERE ${w} AND stage='perdido' AND loss_reason IS NOT NULL GROUP BY loss_reason ORDER BY n DESC`).bind(sinceMs).all(),
        C.prepare(`SELECT uf k, COUNT(*) n FROM leads WHERE ${w} AND uf IS NOT NULL AND uf<>'' GROUP BY uf`).bind(sinceMs).all(),
        C.prepare(`SELECT city k, uf, COUNT(*) n FROM leads WHERE ${w} AND city IS NOT NULL AND city<>'' GROUP BY city, uf ORDER BY n DESC LIMIT 15`).bind(sinceMs).all(),
        C.prepare(`SELECT COUNT(*) total,
                          SUM(CASE WHEN stage='qualificado' THEN 1 ELSE 0 END) qualificados,
                          SUM(CASE WHEN stage='ganho' THEN 1 ELSE 0 END) ganhos
                   FROM leads WHERE ${w}`).bind(sinceMs).first(),
      ]);
      out.crm = {
        funnel: rowsToMap(funnel.results, 'stage', 'n'),
        pending_revenue: rev?.pending || 0,
        won_revenue: rev?.won || 0,
        by_product: prod.results || [],
        by_environment: environ.results || [],
        by_property: prop.results || [],
        loss_reasons: loss.results || [],
        by_uf: ufs.results || [],
        top_cities: cities.results || [],
        total: totals?.total || 0,
        qualified: totals?.qualificados || 0,
        sales: totals?.ganhos || 0,
      };
    } catch (e) {
      out.crm_error = e.message;
    }
  }

  // ---- Web / Ads (decorroom-db) ----
  try {
    const D = env.DB;
    const [spend, webleads, daily, topads] = await Promise.all([
      D.prepare(`SELECT platform, COALESCE(SUM(spend_cents),0) cents FROM ad_spend WHERE date >= ? GROUP BY platform`).bind(sinceDate).all(),
      D.prepare(`SELECT COUNT(*) n FROM event_log WHERE event_name='Lead' AND is_bot=0 AND timestamp >= ?`).bind(sinceSec).first(),
      D.prepare(`SELECT date, COALESCE(SUM(spend_cents),0) cents FROM ad_spend WHERE date >= ? GROUP BY date ORDER BY date`).bind(sinceDate).all(),
      D.prepare(`SELECT ad_name, COALESCE(SUM(spend_cents),0) cents, COALESCE(SUM(impressions),0) impr, COALESCE(SUM(clicks),0) clk
                 FROM ad_spend WHERE date >= ? AND ad_name IS NOT NULL GROUP BY ad_name HAVING SUM(spend_cents)>0 ORDER BY cents DESC LIMIT 10`).bind(sinceDate).all(),
    ]);
    const sm = {}; (spend.results || []).forEach((r) => { sm[r.platform] = r.cents; });
    const metaCents = sm.meta || 0, googleCents = sm.google || 0;
    out.ads = {
      meta_invest: metaCents / 100,
      google_invest: googleCents / 100,
      total_invest: (metaCents + googleCents) / 100,
      web_leads: webleads?.n || 0,
      daily: (daily.results || []).map((d) => ({ date: d.date, invest: d.cents / 100 })),
      top_ads: (topads.results || []).map((a) => ({ name: a.ad_name, invest: a.cents / 100, impr: a.impr, clk: a.clk })),
    };
  } catch (e) {
    out.ads_error = e.message;
  }

  return json(out);
}

function rowsToMap(rows, k, v) {
  const m = {};
  (rows || []).forEach((r) => { m[r[k]] = r[v]; });
  return m;
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw || '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
