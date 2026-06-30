const ORIGIN = 'http://66.226.145.153.nip.io';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const sep = url.search ? '&' : '?';
    const target = ORIGIN + url.pathname + url.search + sep + '_t=' + Date.now();

    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.set('host', '66.226.145.153.nip.io');
    fwdHeaders.set('x-forwarded-for', request.headers.get('cf-connecting-ip') || '');
    // Remove headers that might cause Cloudflare to re-route the subrequest
    fwdHeaders.delete('cf-connecting-ip');
    fwdHeaders.delete('cf-ipcountry');
    fwdHeaders.delete('cf-ray');
    fwdHeaders.delete('cf-visitor');

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
      return new Response(`Proxy error: ${err.message}\nTarget: ${target}`, { status: 502 });
    }
  }
};
