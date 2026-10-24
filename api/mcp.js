// OAuth/bearer bridge plus local Garmin Connect performance-metric tools.
// The Personal API MCP remains upstream; these tools use a separate Garmin Connect web session.
import { GarminClient, MemoryTokenStore, Garmin } from 'garminconnect-js';

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const client = new GarminClient({ tokenStore: new MemoryTokenStore() });
let pendingMfa = null;

const localTools = [
  { name: 'garmin_connect_login', description: 'Start Garmin Connect sign-in using private GARMIN_CONNECT_EMAIL and GARMIN_CONNECT_PASSWORD deployment secrets. Session and pending MFA state are memory-only and may be lost between serverless requests.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'garmin_connect_verify_mfa', description: 'Complete a pending Garmin Connect sign-in with the one-time verification code. Pending MFA state is memory-only and may be lost between serverless requests.', inputSchema: { type: 'object', properties: { code: { type: 'string', minLength: 4, maxLength: 12 } }, required: ['code'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'get_vo2_max', description: 'Get latest available running/cycling VO₂ max, one date, or history for an inclusive date range. Dates are YYYY-MM-DD. Latest searches the most recent 90 days.', inputSchema: dateSchema(), annotations: { readOnlyHint: true } },
  { name: 'get_cycling_ftp', description: 'Get latest cycling FTP, a specific date, or FTP history for an inclusive date range. Dates are YYYY-MM-DD. Range history is daily and cycling-specific.', inputSchema: dateSchema(), annotations: { readOnlyHint: true } },
  { name: 'get_training_status', description: 'Get latest available training status, a specific date, or daily status records for an inclusive date range. Dates are YYYY-MM-DD. Latest searches backwards up to 30 days; ranges are capped at 366 days.', inputSchema: dateSchema(), annotations: { readOnlyHint: true } },
];
function dateSchema() {
  const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
  return { type: 'object', properties: { date, from_date: date, to_date: date }, additionalProperties: false };
}
const localNames = new Set(localTools.map(t => t.name));
const today = () => new Date().toISOString().slice(0, 10);
const dateString = d => d.toISOString().slice(0, 10);
function shiftDate(value, days) { const d = new Date(value + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return dateString(d); }
function isRealDate(value) { if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false; const d = new Date(value + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && dateString(d) === value; }
function validateQuery(args = {}) {
  const { date, from_date, to_date } = args;
  if (date && (from_date || to_date)) throw new Error('Use either date or from_date/to_date, not both.');
  if (date) { if (!isRealDate(date)) throw new Error('date must be a real calendar date in YYYY-MM-DD format.'); return { kind: 'date', date }; }
  if (from_date || to_date) {
    if (!from_date || !to_date) throw new Error('Provide both from_date and to_date for a range.');
    if (!isRealDate(from_date) || !isRealDate(to_date)) throw new Error('from_date and to_date must be real calendar dates in YYYY-MM-DD format.');
    if (from_date > to_date) throw new Error('from_date must be on or before to_date.');
    const days = Math.round((Date.parse(to_date + 'T00:00:00Z') - Date.parse(from_date + 'T00:00:00Z')) / 86400000) + 1;
    if (days > 366) throw new Error(`Date range is ${days} days; maximum is 366 days per call.`);
    return { kind: 'range', from: from_date, to: to_date };
  }
  return { kind: 'latest' };
}
function toolResult(id, data, isError = false) {
  return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }], ...(isError ? { isError: true } : {}) } });
}
async function callLocalTool(name, args = {}) {
  if (name === 'garmin_connect_login') {
    const email = process.env.GARMIN_CONNECT_EMAIL?.trim();
    const password = process.env.GARMIN_CONNECT_PASSWORD;
    if (!email || !password) throw new Error('Set GARMIN_CONNECT_EMAIL and GARMIN_CONNECT_PASSWORD as private deployment environment variables.');
    const result = await client.login(email, password);
    if (result.state === 'mfa_required') {
      pendingMfa = result.mfaState;
      return { status: 'mfa_required', message: 'Garmin requires a verification code. Call garmin_connect_verify_mfa. MFA state is memory-only and may be lost if the serverless instance restarts.' };
    }
    pendingMfa = null;
    return { status: 'authenticated', message: 'Garmin Connect login succeeded. Session tokens are held in process memory only.' };
  }
  if (name === 'garmin_connect_verify_mfa') {
    if (typeof args.code !== 'string' || args.code.trim().length < 4 || args.code.trim().length > 12) throw new Error('code must be 4–12 characters.');
    if (!pendingMfa) throw new Error('No pending Garmin MFA login in this runtime instance. Call garmin_connect_login again.');
    await client.resumeLogin(pendingMfa, args.code.trim());
    pendingMfa = null;
    return { status: 'authenticated', message: 'Garmin MFA verification succeeded. Session tokens are held in process memory only.' };
  }
  if (!(await client.loadTokens())) throw new Error('No in-memory Garmin Connect session. Call garmin_connect_login first. Serverless restarts clear the session; no persistent token storage is configured.');
  const garmin = new Garmin(client);
  const query = validateQuery(args);
  if (name === 'get_vo2_max') {
    if (query.kind === 'date') return { mode: 'date', date: query.date, data: await garmin.getMaxMetrics(query.date) };
    if (query.kind === 'range') return { mode: 'range', from_date: query.from, to_date: query.to, data: await garmin.getMaxMetricsRange(query.from, query.to) };
    const to = today(), from = shiftDate(to, -89);
    return { mode: 'latest', searched_from: from, searched_to: to, data: await garmin.getMaxMetricsRange(from, to) };
  }
  if (name === 'get_cycling_ftp') {
    if (query.kind === 'latest') return { mode: 'latest', data: await garmin.getCyclingFtp() };
    if (query.kind === 'date') return { mode: 'date', date: query.date, data: await garmin.getFunctionalThresholdPowerRange(query.date, query.date, 'CYCLING', 'daily') };
    return { mode: 'range', from_date: query.from, to_date: query.to, data: await garmin.getFunctionalThresholdPowerRange(query.from, query.to, 'CYCLING', 'daily') };
  }
  if (name === 'get_training_status') {
    if (query.kind === 'date') return { mode: 'date', date: query.date, data: await garmin.getTrainingStatus(query.date) };
    if (query.kind === 'latest') {
      const to = today();
      for (let offset = 0; offset < 30; offset++) {
        const date = shiftDate(to, -offset), data = await garmin.getTrainingStatus(date);
        if (data != null) return { mode: 'latest', date, data };
      }
      return { mode: 'latest', searched_from: shiftDate(to, -29), searched_to: to, data: null };
    }
    const records = [];
    for (let day = query.from; day <= query.to; day = shiftDate(day, 1)) records.push({ date: day, data: await garmin.getTrainingStatus(day) });
    return { mode: 'range', from_date: query.from, to_date: query.to, records };
  }
  throw new Error('Unknown local tool: ' + name);
}

function rpcError(id, message) {
  return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message } }, { status: 200 });
}

export default async function handler(request) {
  const secret = process.env.URL_SECRET;
  const upstream = process.env.UPSTREAM_URL;
  const token = process.env.MCP_BEARER_TOKEN;
  if (!secret || !upstream || !token) return new Response('Proxy is not configured', { status: 500 });
  // Vercel may expose request.url as a relative path in this function runtime.
  // Resolve it against the forwarded origin (or Host) before reading query params.
  // Vercel's Node.js function handler receives a Node IncomingMessage,
  // whose headers are a plain object rather than a Fetch API Headers instance.
  const header = name => {
    const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  const host = header('x-forwarded-host') || header('host');
  const protocol = header('x-forwarded-proto') || 'https';
  if (!host) return new Response('Unable to determine request host', { status: 400 });
  const url = new URL(request.url, `${protocol}://${host}`);
  const given = url.searchParams.get('s') || '';
  if (!safeEqual(given, secret)) return new Response('Not found', { status: 404 });

  // Only MCP POST requests have JSON-RPC bodies. GET/DELETE are passed through for
  // Streamable HTTP transport compatibility.
  if (request.method !== 'POST') return forward(request, upstream, token);
  const rawBody = await request.text();
  let rpc;
  try { rpc = JSON.parse(rawBody); } catch { return forwardWithBody(request, upstream, token, rawBody); }
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) return forwardWithBody(request, upstream, token, rawBody);

  if (rpc.method === 'tools/list' && rpc.id !== undefined) {
    const response = await forwardWithBody(request, upstream, token, rawBody, true);
    if (!response.ok) return response;
    try {
      const payload = await response.json();
      if (payload?.result?.tools) {
        const upstreamTools = payload.result.tools.filter(tool => !localNames.has(tool.name));
        payload.result.tools = [...upstreamTools, ...localTools];
        return Response.json(payload, { status: response.status, headers: response.headers });
      }
    } catch { /* keep upstream response if it wasn't JSON */ }
    return new Response('Unable to merge MCP tool list; upstream did not return JSON.', { status: 502 });
  }
  if (rpc.method === 'tools/call' && rpc.id !== undefined && localNames.has(rpc.params?.name)) {
    try { return toolResult(rpc.id, await callLocalTool(rpc.params.name, rpc.params.arguments ?? {})); }
    catch (err) { return toolResult(rpc.id, err instanceof Error ? err.message : String(err), true); }
  }
  return forwardWithBody(request, upstream, token, rawBody);
}

async function forward(request, upstream, token) {
  return forwardWithBody(request, upstream, token, undefined);
}
async function forwardWithBody(request, upstream, token, body, jsonAccept = false) {
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.delete('host');
  if (jsonAccept) headers.set('accept', 'application/json');
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const res = await fetch(upstream, { method: request.method, headers, body: hasBody ? (body === undefined ? request.body : body) : undefined, redirect: 'manual' });
  const outHeaders = new Headers(res.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');
  return new Response(res.body, { status: res.status, headers: outHeaders });
}
