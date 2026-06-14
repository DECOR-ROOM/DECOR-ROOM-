export async function onRequestGet(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  // Simple auth via query param
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const eventFilter = url.searchParams.get('event') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  try {
    let query = `
      SELECT
        rowid, session_id, event_name, event_id, timestamp,
        browser, os, is_mobile,
        pixel_was_blocked, fbp_source, fbc_source, fbclid_source,
        is_bot, bot_reason,
        sent_to_meta, meta_response_ok,
        has_email, raw_email,
        meta_response_body
      FROM event_log
    `;
    const bindings = [];

    if (eventFilter) {
      query += ` WHERE event_name = ?`;
      bindings.push(eventFilter);
    }

    query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    bindings.push(limit, offset);

    const { results } = await env.DB.prepare(query).bind(...bindings).all();

    // Also get summary counts
    const summary = await env.DB.prepare(`
      SELECT
        event_name,
        COUNT(*) as total,
        SUM(CASE WHEN meta_response_ok = 1 THEN 1 ELSE 0 END) as meta_ok,
        SUM(CASE WHEN meta_response_ok = 0 THEN 1 ELSE 0 END) as meta_fail,
        SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) as bots
      FROM event_log
      WHERE event_name = 'Lead'
      GROUP BY event_name
    `).all();

    // Recovery stats — what WOULD have been lost without server-side
    const recovery = await env.DB.prepare(`
      SELECT
        COUNT(*) as total_events,
        SUM(CASE WHEN is_bot = 0 THEN 1 ELSE 0 END) as real_events,
        SUM(CASE WHEN pixel_was_blocked = 1 AND is_bot = 0 THEN 1 ELSE 0 END) as adblock_recovered,
        SUM(CASE WHEN fbp_source = 'middleware_http' AND is_bot = 0 THEN 1 ELSE 0 END) as itp_recovered,
        SUM(CASE WHEN fbp_source = 'pixel_js' AND is_bot = 0 THEN 1 ELSE 0 END) as fbp_from_pixel,
        SUM(CASE WHEN fbp_source = 'middleware_http' AND is_bot = 0 THEN 1 ELSE 0 END) as fbp_from_middleware,
        SUM(CASE WHEN fbp_source = 'tracker_http' AND is_bot = 0 THEN 1 ELSE 0 END) as fbp_from_session,
        SUM(CASE WHEN fbp_source = 'none' AND is_bot = 0 THEN 1 ELSE 0 END) as fbp_none,
        SUM(CASE WHEN fbc_source = 'middleware_http' AND is_bot = 0 THEN 1 ELSE 0 END) as fbc_from_middleware,
        SUM(CASE WHEN fbclid_source = 'server_middleware' AND is_bot = 0 THEN 1 ELSE 0 END) as fbclid_from_server
      FROM event_log
      WHERE event_name = 'Lead'
    `).first();

    // Per-browser breakdown for ITP insight
    const browserBreakdown = await env.DB.prepare(`
      SELECT
        browser,
        COUNT(*) as total,
        SUM(CASE WHEN pixel_was_blocked = 1 THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN fbp_source = 'middleware_http' THEN 1 ELSE 0 END) as itp_recovered
      FROM event_log
      WHERE event_name = 'Lead' AND is_bot = 0
      GROUP BY browser
      ORDER BY total DESC
    `).all();

    return new Response(JSON.stringify({
      events: results,
      summary: summary.results,
      recovery: recovery || {},
      browsers: browserBreakdown.results,
    }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
