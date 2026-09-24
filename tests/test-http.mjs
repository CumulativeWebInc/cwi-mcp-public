#!/usr/bin/env node
/**
 * test-http.mjs — integration tests against the real HTTP transport.
 * Spawns server-http.mjs on 127.0.0.1 with a throwaway MCP_TOKEN, then:
 *   - health/info/docs endpoints (public, no auth)
 *   - 401 without token, 401 with wrong token
 *   - full MCP handshake: initialize -> tools/list -> tools/call (real handlers)
 *   - conflict-rule enforcement over the wire
 *   - validation errors, not-found, method-not-allowed, oversize body
 *   - rate limiting (temporarily lowered via RATE_PER_MIN env)
 *   - latency measurement (p50/p95 over catalog_search_v1)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'server-http.mjs');
const PORT = 18771;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `test-token-${Date.now()}`;
const AUTH = { Authorization: `Bearer ${TOKEN}` };

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; fails.push(name); console.log(`  FAIL ${name} ${extra}`); }
}

async function post(body, headers = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, text, json };
}
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const toolResult = (json) => JSON.parse(json.result.content[0].text);

async function waitForHealth(child) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
}

async function main() {
  const child = spawn('node', [SRC], {
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', MCP_TOKEN: TOKEN, RATE_PER_MIN: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (e) => { console.error('spawn error', e); process.exit(1); });
  try {
    await waitForHealth(child);

    // ---- public endpoints ----
    let r = await fetch(`${BASE}/health`);
    check('GET /health 200 + ok:true', r.ok && (await r.json()).ok === true);
    r = await fetch(`${BASE}/`);
    check('GET / info page 200', r.ok && (await r.text()).includes('cwi-mcp-public'));
    r = await fetch(`${BASE}/docs`);
    check('GET /docs 200', r.ok && (await r.text()).includes('Error taxonomy'));

    // ---- auth gate ----
    r = await post(rpc(1, 'initialize'));
    check('no token -> 401 cwi.unauthorized', r.status === 401 && r.json.error.code === 'cwi.unauthorized');
    r = await post(rpc(1, 'initialize'), { Authorization: 'Bearer wrong-token' });
    check('wrong token -> 401 cwi.unauthorized', r.status === 401 && r.json.error.code === 'cwi.unauthorized');
    check('401 message is human-readable', /token/i.test(r.json.error.message));

    // ---- MCP handshake (authenticated) ----
    r = await post(rpc(1, 'initialize'), AUTH);
    check('initialize ok', r.json.result.serverInfo.name === 'cwi-mcp-public' && r.json.result.protocolVersion === '2024-11-05');
    r = await post(rpc(2, 'tools/list'), AUTH);
    check('tools/list returns 12 versioned tools', r.json.result.tools.length === 12 && r.json.result.tools.every((t) => /_v1$/.test(t.name)));

    // ---- real tool calls ----
    r = await post(rpc(3, 'tools/call', { name: 'catalog_search_v1', arguments: { query: 'shaka' } }), AUTH);
    let tr = toolResult(r.json);
    check('catalog_search over HTTP finds Shaka Zulu', tr.tracks.some((t) => t.title === 'Shaka Zulu'));
    check('conflicted ISRC hidden over HTTP', tr.tracks.every((t) => t.title !== 'Shaka Zulu' || t.isrc === null));

    r = await post(rpc(4, 'tools/call', { name: 'catalog_isrc_lookup_v1', arguments: { isrc: 'QZK6J2376416' } }), AUTH);
    tr = toolResult(r.json);
    check('conflicted ISRC over HTTP -> conflicted, no value', tr.status === 'conflicted' && tr.authoritative_value === null);

    r = await post(rpc(5, 'tools/call', { name: 'games_list_v1', arguments: {} }), AUTH);
    check('games_list over HTTP', toolResult(r.json).games.length === 3);

    r = await post(rpc(6, 'tools/call', { name: 'ledger_state_version_v1', arguments: {} }), AUTH);
    tr = toolResult(r.json);
    check('ledger_state_version over HTTP (upstream)', typeof tr.tasks === 'number' && tr.read_source === 'public', JSON.stringify(tr).slice(0, 200));

    // ---- error taxonomy over the wire ----
    r = await post(rpc(7, 'tools/call', { name: 'catalog_track_get_v1', arguments: { track_id: 'nope-missing' } }), AUTH);
    tr = toolResult(r.json);
    check('not-found surfaces cwi.not_found', r.json.result.isError === true && tr.error.code === 'cwi.not_found');

    r = await post(rpc(8, 'tools/call', { name: 'catalog_search_v1', arguments: { query: '' } }), AUTH);
    tr = toolResult(r.json);
    check('invalid args surface cwi.invalid_params + problems', r.json.result.isError === true && tr.error.code === 'cwi.invalid_params' && Array.isArray(tr.error.detail.problems));

    r = await post(rpc(9, 'tools/call', { name: 'no_such_tool_v1', arguments: {} }), AUTH);
    check('unknown tool -> isError', r.json.result.isError === true);

    r = await post(rpc(10, 'frobnicate/method'), AUTH);
    check('unknown method -> -32601', r.json.error && r.json.error.code === -32601);

    r = await fetch(`${BASE}/mcp`, { method: 'GET', headers: AUTH });
    check('GET /mcp -> 405', r.status === 405);

    r = await post('not json at all {{{', AUTH);
    check('malformed body -> 400 parse error', r.status === 400 && r.json.error.code === -32700);

    // oversize body: server destroys the socket (no response) — either way it must not hang or leak
    const big = 'x'.repeat(1_100_000);
    let oversizeOk = false;
    try {
      r = await post(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping', extra: big }), AUTH);
      oversizeOk = r.status === 400 || r.text === '';
    } catch { oversizeOk = true; } // connection reset = rejected, also acceptable
    check('oversize body rejected (no hang, no leak)', oversizeOk);
    // server must still be alive after the socket destroy
    r = await post(rpc(11, 'ping'), AUTH);
    check('server survives oversize-body socket destroy', r.json.result !== undefined);

    // batch rejected
    r = await post([rpc(12, 'ping')], AUTH);
    check('batch array rejected (400)', r.status === 400);

    // SSE framing
    const sseRes = await fetch(`${BASE}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...AUTH },
      body: JSON.stringify(rpc(13, 'ping')),
    });
    const sseText = await sseRes.text();
    check('SSE framing when accepted', sseText.startsWith('data:'));

    // notification -> 202
    const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, AUTH);
    check('notification -> 202', n.status === 202);

    // ---- latency measurement: catalog_search_v1 over HTTP ----
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      await post(rpc(100 + i, 'tools/call', { name: 'catalog_search_v1', arguments: { query: 'zone' } }), AUTH);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.log(`  latency catalog_search_v1: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms (n=30, localhost)`);
    check('p95 latency under 500ms', p95 < 500, `p95=${p95.toFixed(1)}ms`);

    // ---- rate limit (separate server instance, low limit) ----
    child.kill('SIGTERM');
  } finally {
    child.kill('SIGTERM');
  }

  // rate-limit check on a fresh low-limit instance
  const PORT2 = 18772;
  const child2 = spawn('node', [SRC], {
    env: { ...process.env, PORT: String(PORT2), BIND: '127.0.0.1', MCP_TOKEN: TOKEN, RATE_PER_MIN: '3' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const BASE2 = `http://127.0.0.1:${PORT2}`;
    for (let i = 0; i < 60; i++) {
      try { const rr = await fetch(`${BASE2}/health`); if (rr.ok) break; } catch { /* */ }
      await new Promise((r3) => setTimeout(r3, 200));
    }
    let saw429 = false;
    for (let i = 0; i < 6; i++) {
      const rr = await fetch(`${BASE2}/mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify(rpc(i, 'ping')),
      });
      if (rr.status === 429) {
        saw429 = true;
        const body = await rr.json();
        check('429 carries cwi.rate_limited + Retry-After', body.error.code === 'cwi.rate_limited' && rr.headers.get('retry-after') === '60');
        break;
      }
    }
    check('rate limit enforced', saw429);
  } finally {
    child2.kill('SIGTERM');
  }

  console.log(`\nintegration: ${passed} passed, ${failed} failed`);
  if (fails.length) { console.log('failed:', fails.join(', ')); process.exit(1); }
}

main().catch((e) => { console.error('harness error:', e.message); process.exit(1); });
