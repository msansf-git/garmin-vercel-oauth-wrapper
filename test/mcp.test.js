import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PersistentTokenStore,
  callLocalTool,
  client,
  decryptJson,
  encryptJson,
  handleFetch,
  localTools,
  mergeToolListResponse,
  parseJsonRpcResponse,
  validateQuery,
} from '../api/mcp.js';

const envKeys = [
  'GARMIN_SESSION_ENCRYPTION_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'GARMIN_CONNECT_EMAIL',
  'GARMIN_CONNECT_PASSWORD',
  'URL_SECRET',
  'UPSTREAM_URL',
  'MCP_BEARER_TOKEN',
];
function saveEnv() {
  return Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
}
function restoreEnv(saved) {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}
function mockRedis() {
  const data = new Map();
  const commands = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    const command = JSON.parse(options.body);
    commands.push(command);
    const [op, key, value, expiryMode, expirySeconds] = command;
    let result = null;
    if (op === 'GET') result = data.has(key) ? data.get(key) : null;
    if (op === 'SET') {
      data.set(key, value);
      result = 'OK';
      if (expiryMode === 'EX') commands.push(['TTL', key, expirySeconds]);
    }
    if (op === 'DEL') result = data.delete(key) ? 1 : 0;
    return Response.json({ result });
  };
  return { data, commands, restore: () => { globalThis.fetch = originalFetch; } };
}

test('encrypted session JSON round-trips and rejects tampering', () => {
  const saved = saveEnv();
  process.env.GARMIN_SESSION_ENCRYPTION_KEY = 'test-only-key-long-enough-to-hash-123';
  try {
    const tokens = { oauth1: { token: 'secret-token' }, expires_at: 123456789, refresh_token_expires_at: 987654321 };
    const encrypted = encryptJson(tokens);
    assert.equal(encrypted.includes('secret-token'), false);
    assert.deepEqual(decryptJson(encrypted), tokens);
    const envelope = JSON.parse(encrypted);
    envelope.data = Buffer.from('tampered').toString('base64');
    assert.throws(() => decryptJson(JSON.stringify(envelope)));
  } finally {
    restoreEnv(saved);
  }
});

test('PersistentTokenStore saves, loads, and clears the complete token object', async () => {
  const saved = saveEnv();
  const redis = mockRedis();
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.GARMIN_SESSION_ENCRYPTION_KEY = 'test-only-key-long-enough-to-hash-123';
  try {
    const store = new PersistentTokenStore();
    const tokens = { oauth1: { token: 'private' }, expires_at: 111, refresh_token_expires_at: 222 };
    await store.save(tokens);
    assert.deepEqual(await store.load(), tokens);
    await store.clear();
    assert.equal(await store.load(), null);
    assert.ok(redis.commands.some(command => command[0] === 'DEL'));
  } finally {
    redis.restore();
    restoreEnv(saved);
  }
});

test('storage HTTP errors are surfaced without exposing response bodies', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = async () => new Response('sensitive backend details', { status: 503 });
  try {
    await assert.rejects(() => new PersistentTokenStore().load(), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('login stores MFA state encrypted with a 600-second Redis TTL', async () => {
  const saved = saveEnv();
  const redis = mockRedis();
  const originalLogin = client.login;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.GARMIN_SESSION_ENCRYPTION_KEY = 'test-only-key-long-enough-to-hash-123';
  process.env.GARMIN_CONNECT_EMAIL = 'athlete@example.test';
  process.env.GARMIN_CONNECT_PASSWORD = 'test-password';
  client.login = async () => ({ state: 'mfa_required', mfaState: { cookies: { session: 'sensitive-cookie' } } });
  try {
    const result = await callLocalTool('garmin_connect_login');
    assert.equal(result.status, 'mfa_required');
    const mfaSet = redis.commands.find(command => command[0] === 'SET' && command[1].endsWith('pending-mfa:v1'));
    assert.ok(mfaSet);
    assert.equal(mfaSet[3], 'EX');
    assert.equal(mfaSet[4], '600');
    assert.equal(mfaSet[2].includes('sensitive-cookie'), false);
  } finally {
    client.login = originalLogin;
    redis.restore();
    restoreEnv(saved);
  }
});

test('expired or missing MFA state gives a clear retry instruction', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = async () => Response.json({ result: null });
  try {
    await assert.rejects(
      () => callLocalTool('garmin_connect_verify_mfa', { code: '123456' }),
      /No pending Garmin MFA login.*Call garmin_connect_login again/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('date validation accepts valid dates and rejects invalid or oversized ranges', () => {
  assert.deepEqual(validateQuery({ date: '2026-10-24' }), { kind: 'date', date: '2026-10-24' });
  assert.throws(() => validateQuery({ date: '2026-02-30' }), /real calendar date/);
  assert.throws(() => validateQuery({ from_date: '2026-01-01' }), /Provide both/);
  assert.throws(() => validateQuery({ from_date: '2026-02-01', to_date: '2026-01-01' }), /on or before/);
  assert.throws(() => validateQuery({ from_date: '2025-01-01', to_date: '2026-01-02' }), /maximum is 366/);
});

test('login and MFA tool annotations correctly describe authentication side effects', () => {
  for (const name of ['garmin_connect_login', 'garmin_connect_verify_mfa']) {
    const tool = localTools.find(item => item.name === name);
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  assert.equal(localTools.find(item => item.name === 'get_vo2_max').annotations.readOnlyHint, true);
});

test('SSE JSON-RPC parsing and merged tools return valid JSON content type', async () => {
  const payload = { jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'upstream_tool' }, { name: 'get_vo2_max' }] } };
  const sse = 'event: message\ndata: ' + JSON.stringify(payload) + '\n\n';
  assert.deepEqual(parseJsonRpcResponse(sse), payload);
  const upstream = new Response(sse, { headers: { 'content-type': 'text/event-stream', 'content-length': '999' } });
  const response = mergeToolListResponse(payload, upstream, [{ name: 'get_vo2_max' }, { name: 'get_cycling_ftp' }], new Set(['get_vo2_max', 'get_cycling_ftp']));
  assert.equal(response.headers.get('content-type').includes('application/json'), true);
  assert.equal(response.headers.get('content-length'), null);
  const body = await response.json();
  assert.deepEqual(body.result.tools.map(tool => tool.name), ['upstream_tool', 'get_vo2_max', 'get_cycling_ftp']);
});

test('non-local MCP requests are forwarded upstream with bearer auth', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  process.env.URL_SECRET = 'test-path-secret';
  process.env.UPSTREAM_URL = 'https://personal.example.test/mcp';
  process.env.MCP_BEARER_TOKEN = 'test-upstream-bearer';
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url, options };
    return Response.json({ jsonrpc: '2.0', id: 3, result: { ok: true } });
  };
  try {
    const response = await handleFetch(new Request('https://wrapper.example.test/api/mcp?s=test-path-secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    }));
    assert.equal(response.status, 200);
    assert.equal(forwarded.url, 'https://personal.example.test/mcp');
    assert.equal(new Headers(forwarded.options.headers).get('authorization'), 'Bearer test-upstream-bearer');
    assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 3, result: { ok: true } });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});
