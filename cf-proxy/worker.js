// Fetch via a non-CF hostname to avoid Cloudflare error 1003 on direct-IP access
const ORIGIN = 'http://adrian-bingo.bnr.la';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = ORIGIN + url.pathname + url.search;

    const fwdHeaders = new Headers();
    fwdHeaders.set('host', '66.226.145.153');

    const pass = ['accept','accept-encoding','accept-language','user-agent',
                  'content-type','range','cookie'];
    for (const h of pass) {
      const v = request.headers.get(h);
      if (v) fwdHeaders.set(h, v);
    }

    const upgrade = request.headers.get('upgrade');
    if (upgrade) {
      fwdHeaders.set('upgrade', upgrade);
      fwdHeaders.set('connection', request.headers.get('connection') || 'upgrade');
    }

    try {
      const resp = await fetch(target, {
        method: request.method,
        headers: fwdHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
      });
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, { status: 502 });
    }
  }
};
