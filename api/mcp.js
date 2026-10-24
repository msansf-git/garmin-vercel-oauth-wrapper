// Tiny proxy: accepts https://<this-app>/<URL_SECRET>/mcp, checks the secret,
// then forwards the request to your garmin-personal-mcp deployment with the
// Authorization: Bearer header added. Needed because Claude's custom connector
// form has no field for a static token.

export const config = { runtime: 'edge' };

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(request) {
  const secret = process.env.URL_SECRET;
  const upstream = process.env.UPSTREAM_URL; // e.g. https://garmin-personal-mcp-mu.vercel.app/mcp
  const token = process.env.MCP_BEARER_TOKEN; // same value as on the main server

  if (!secret || !upstream || !token) {
    return new Response('Proxy is not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const given = url.searchParams.get('s') || '';
  if (!safeEqual(given, secret)) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.delete('host');

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const res = await fetch(upstream, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    duplex: 'half',
    redirect: 'manual',
  });

  const outHeaders = new Headers(res.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');
  return new Response(res.body, { status: res.status, headers: outHeaders });
}
