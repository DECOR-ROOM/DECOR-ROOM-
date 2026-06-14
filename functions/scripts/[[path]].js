export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const measurementId = url.searchParams.get('id') || env.GA4_MEASUREMENT_ID;

  if (!measurementId) {
    return new Response('// no measurement id', {
      status: 200,
      headers: { 'Content-Type': 'application/javascript' },
    });
  }

  const gtagUrl = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;

  const cache = caches.default;
  const cacheKey = new Request(gtagUrl, request);
  let response = await cache.match(cacheKey);

  if (!response) {
    try {
      const origin = await fetch(gtagUrl, {
        headers: { 'User-Agent': request.headers.get('User-Agent') || '' },
      });

      if (!origin.ok) {
        return new Response('// fetch failed', {
          status: 200,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }

      const scriptBody = await origin.text();

      response = new Response(scriptBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        },
      });

      context.waitUntil(cache.put(cacheKey, response.clone()));
    } catch (err) {
      return new Response('// proxy error', {
        status: 200,
        headers: { 'Content-Type': 'application/javascript' },
      });
    }
  }

  return response;
}
