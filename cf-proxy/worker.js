const ORIGIN = 'https://radical-movies.fly.dev';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Add a per-request timestamp to the origin URL so CF never serves a cached subrequest
    const sep = url.search ? '&' : '?';
    const target = ORIGIN + url.pathname + url.search + sep + '_t=' + Date.now();

    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.set('host', 'radical-movies.fly.dev');
    fwdHeaders.set('x-forwarded-for', request.headers.get('cf-connecting-ip') || '');

    try {
      const resp = await fetch(target, {
        method: request.method,
        headers: fwdHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
        cf: { cacheEverything: false, cacheTtl: 0 },
      });

      const resHeaders = new Headers(resp.headers);
      resHeaders.set('Cache-Control', 'no-store');
      resHeaders.set('Cloudflare-CDN-Cache-Control', 'no-store');

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, { status: 502 });
    }
  }
};
