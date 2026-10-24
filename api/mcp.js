// OAuth/bearer bridge plus local Garmin Connect performance-metric tools.
// The Personal API MCP remains upstream; these tools use a separate Garmin Connect web session.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { GarminClient, Garmin } from 'garminconnect-js';

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Vercel Marketplace's native Upstash integration supplies the REST URL/token.
// Tokens and MFA state are encrypted before they leave this function.
const storageScope = process.env.VERCEL_ENV === 'production' ? 'production' :
  (process.env.VERCEL_ENV === 'preview' ? 'preview' : 'development');
const tokenKey = `garmin-connect:${storageScope}:tokens:v1`;
const mfaKey = `garmin-connect:${storageScope}:pending-mfa:v1`;

function encryptionKey() {
  const secret = process.env.GARMIN_SESSION_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new Error('GARMIN_SESSION_ENCRYPTION_KEY must be configured as a private Vercel environment variable with at least 32 characters.');
  return createHash('sha256').update(secret, 'utf8').digest();
}
function assertPersistentStoreConfigured() {
  if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) || !(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)) {
    throw new Error('Persistent session storage is not configured. Add the Vercel-managed Upstash Redis integration and enable it for this deployment environment.');
  }
  encryptionKey();
}
function encryptJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}
function decryptJson(value) {
  const envelope = JSON.parse(value);
  if (envelope?.v !== 1 || !envelope.iv || !envelope.tag || !envelope.data) throw new Error('Stored Garmin session has an invalid encrypted envelope.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}
async function redisCommand(...command) {
  const endpoint = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  if (!endpoint || !token) throw new Error('Persistent session storage is not configured. In Vercel, add the native Upstash Redis storage integration and enable it for this deployment environment.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Persistent session storage request failed (HTTP ${response.status}).`);
  const result = await response.json();
  if (result.error) throw new Error('Persistent session storage returned an error.');
  return result.result;
}
class PersistentTokenStore {
  async load() {
    const value = await redisCommand('GET', tokenKey);
    return value ? decryptJson(value) : null;
  }
  async save(tokens) {
    await redisCommand('SET', tokenKey, encryptJson(tokens));
  }
  async clear() {
    await redisCommand('DEL', tokenKey);
  }
}
const client = new GarminClient({ tokenStore: new PersistentTokenStore() });

const localTools = [
  { name: 'garmin_connect_login', description: 'Start Garmin Connect sign-in using private GARMIN_CONNECT_EMAIL and GARMIN_CONNECT_PASSWORD deployment secrets. Encrypted session tokens and pending MFA state are stored persistently for this Vercel environment.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'garmin_connect_verify_mfa', description: 'Complete a pending Garmin Connect sign-in with the one-time verification code. The encrypted pending MFA state is stored persistently for up to 10 minutes.', inputSchema: { type: 'object', properties: { code: { type: 'string', minLength: 4, maxLength: 12 } }, required: ['code'], additionalProperties: false }, annotations: { readOnlyHint: true } },
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
function isRealDate(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const d = new Date(value + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && dateString(d) === value; }
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
    assertPersistentStoreConfigured();
    const email = process.env.GARMIN_CONNECT_EMAIL?.trim();
    const password = process.env.GARMIN_CONNECT_PASSWORD;
    if (!email || !password) {
      const missing = [!email && 'GARMIN_CONNECT_EMAIL', !password && 'GARMIN_CONNECT_PASSWORD'].filter(Boolean);
      throw new Error(`Missing runtime environment variable(s): ${missing.join(', ')}. Configure them for this deployment's environment and redeploy.`);
    }
    const result = await client.login(email, password);
    if (result.state === 'mfa_required') {
      await redisCommand('SET', mfaKey, encryptJson(result.mfaState), 'EX', '600');
      return { status: 'mfa_required', message: 'Garmin requires a verification code. Call garmin_connect_verify_mfa within 10 minutes. The pending challenge is encrypted and stored for this Vercel environment.' };
    }
    await redisCommand('DEL', mfaKey);
    return { status: 'authenticated', message: 'Garmin Connect login succeeded. Encrypted session tokens are stored persistently for this Vercel environment.' };
  }
  if (name === 'garmin_connect_verify_mfa') {
    if (typeof args.code !== 'string' || args.code.trim().length < 4 || args.code.trim().length > 12) throw new Error('code must be 4–12 characters.');
    const storedMfa = await redisCommand('GET', mfaKey);
    if (!storedMfa) throw new Error('No pending Garmin MFA login was found (it may have expired after 10 minutes). Call garmin_connect_login again.');
    await client.resumeLogin(decryptJson(storedMfa), args.code.trim());
    await redisCommand('DEL', mfaKey);
    return { status: 'authenticated', message: 'Garmin MFA verification succeeded. Encrypted session tokens are stored persistently for this Vercel environment.' };
  }
  if (!(await client.loadTokens())) throw new Error('No saved Garmin Connect session. Call garmin_connect_login first; if Garmin requires MFA, complete garmin_connect_verify_mfa.');
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

async function handleFetch(request) {
  const secret = process.env.URL_SECRET;
  const upstream = process.env.UPSTREAM_URL;
  const token = process.env.MCP_BEARER_TOKEN;
  if (!secret || !upstream || !token) return new Response('Proxy is not configured', { status: 500 });
  // The Node.js adapter below always constructs an absolute Web Request URL.
  // Use that URL directly; Host headers are not guaranteed to be forwarded by Vercel.
  const url = new URL(request.url);
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
      const responseText = await response.text();
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        // Some Streamable HTTP servers return the JSON-RPC message in an SSE data event.
        const dataLine = responseText.split(/\r?\n/).find(line => line.startsWith('data:'));
        if (dataLine) payload = JSON.parse(dataLine.slice(5).trim());
      }
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
  // MCP Streamable HTTP servers may require text/event-stream to be accepted,
  // even when the caller prefers JSON. Accept both response representations.
  headers.set('accept', jsonAccept
    ? 'application/json, text/event-stream'
    : (headers.get('accept') ? `${headers.get('accept')}, text/event-stream` : 'application/json, text/event-stream'));
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const res = await fetch(upstream, { method: request.method, headers, body: hasBody ? (body === undefined ? request.body : body) : undefined, redirect: 'manual' });
  const outHeaders = new Headers(res.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');
  return new Response(res.body, { status: res.status, headers: outHeaders });
}


// Vercel Node.js Functions use (req, res), not a Fetch-style default export.
// Adapt the incoming Node request to a Web Request and write the Web Response
// explicitly so Vercel does not ignore the returned response.
export default async function handler(req, res) {
  try {
    const header = name => {
      const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    };
    // Some Vercel Node runtimes omit Host/forwarded-host on the request;
    // use Vercel's deployment hostname as a safe fallback for relative URLs.
    const host = header('x-forwarded-host') || header('host') ||
      process.env.VERCEL_URL || process.env.VERCEL_BRANCH_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const protocol = header('x-forwarded-proto') || 'https';
    let url;
    try {
      url = new URL(req.url || '/');
    } catch {
      if (!host) {
        res.statusCode = 400;
        res.end('Unable to determine request host; configure VERCEL_URL or send a Host header.');
        return;
      }
      url = new URL(req.url || '/', `${protocol}://${host}`);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers || {})) {
      if (Array.isArray(value)) value.forEach(v => headers.append(name, v));
      else if (value !== undefined) headers.set(name, String(value));
    }
    let body;
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks);
    }
    const request = new Request(url, {
      method: req.method || 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const response = await handleFetch(request);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('MCP proxy handler failed:', error);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Internal Server Error');
  }
}
