#!/usr/bin/env node
/**
 * server-http.mjs — Streamable-HTTP (stateless) front-end for cwi-mcp-public.
 *
 * Public surface for Meta Muse custom connectors (and Charm-voice reach).
 *
 * AUTH: every POST /mcp call requires `Authorization: Bearer <token>`.
 * Token comes from env MCP_TOKEN (set as a secret, never committed).
 * Missing/invalid token -> 401 with cwi.unauthorized. No token -> no tools.
 * Public (no auth): GET /health, GET / (info page), GET /docs (docs page).
 *
 * Production hardening:
 *   - 1 MB body cap; bodies streamed with hard cutoff
 *   - per-IP rate limit: 120 req/min (429 cwi.rate_limited) — keyed by client
 *     IP, the strictest posture against scraping floods
 *   - per-request HTTP timeout (default 30s) so slow upstreams can't
 *     accumulate connections; stale sockets destroyed
 *   - no stack traces, no secrets, no internal paths in any response
 *   - security headers: nosniff, deny framing, no-referrer
 *   - single-message requests only (no batches)
 *   - SSE framing supported for clients that only accept text/event-stream
 *
 *   PORT=7860 BIND=0.0.0.0 MCP_TOKEN=<secret> node server-http.mjs
 */

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { handleMessage, listTools, SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSION } from './server.mjs';

const PORT = parseInt(process.env.PORT || '7860', 10);
const BIND = process.env.BIND || '0.0.0.0';
const MAX_BODY = 1_000_000; // 1 MB
const RATE_PER_MIN = parseInt(process.env.RATE_PER_MIN || '120', 10);
const REQ_TIMEOUT_MS = parseInt(process.env.REQ_TIMEOUT_MS || '30000', 10);

const TOKEN = process.env.MCP_TOKEN || '';
const TOKEN_HASH = TOKEN ? createHash('sha256').update(TOKEN).digest() : null;
if (!TOKEN) {
  console.error('FATAL: MCP_TOKEN is not set — refusing to serve without token auth.');
  process.exit(1);
}

// --- rate limiter: RATE_PER_MIN per 60s window, keyed by client IP ------------
const hits = new Map(); // key -> [timestamps]
function rateLimited(key) {
  const now = Date.now();
  const window = hits.get(key) || [];
  const fresh = window.filter((t) => now - t < 60_000);
  fresh.push(now);
  hits.set(key, fresh);
  if (hits.size > 50_000) hits.clear();
  return fresh.length > RATE_PER_MIN;
}

// --- helpers ----------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return;
      size += c.length;
      if (size > MAX_BODY) {
        rejected = true;
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!rejected) reject(e); });
  });
}

function bearerOk(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  const provided = h.slice(7);
  if (!provided || provided.length > 256) return false;
  const hash = createHash('sha256').update(provided).digest();
  return hash.length === TOKEN_HASH.length && timingSafeEqual(hash, TOKEN_HASH);
}

function secHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

function jsonRpcError(id, code, message, cwiCode) {
  const error = { code, message };
  if (cwiCode) error.data = { code: cwiCode };
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function sendJson(res, status, obj, sse) {
  if (sse) {
    const body = `data: ${JSON.stringify(obj)}\n\n`;
    res.writeHead(status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...secHeaders() });
    res.end(body);
  } else {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...secHeaders() });
    res.end(body);
  }
}

const INFO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${SERVER_NAME}</title></head>
<body style="font-family:system-ui;max-width:680px;margin:40px auto;padding:0 16px">
<h1>${SERVER_NAME} <small>v${SERVER_VERSION}</small></h1>
<p>Cumulative Web Inc's public MCP server over streamable HTTP (MCP protocol ${PROTOCOL_VERSION}).</p>
<ul>
<li><b>MCP endpoint:</b> <code>POST /mcp</code> — JSON-RPC 2.0, Bearer token required</li>
<li><b>Tools (${listTools().length}, all versioned, all read-only):</b> ${listTools().map((t) => `<code>${t.name}</code>`).join(' ')}</li>
<li><b>Docs:</b> <a href="/docs">/docs</a> &nbsp; <b>Health:</b> <a href="/health">/health</a></li>
</ul>
<p>For Meta Muse: register this page's <code>/mcp</code> URL as a custom connector, with the Bearer token from CWI.</p>
<p>Auth note: every <code>/mcp</code> call requires <code>Authorization: Bearer &lt;token&gt;</code>. No token, no tools.</p>
<p style="font-size:12px;color:#555">© 2026 Cumulative Web Inc™. All rights reserved.</p>
</body></html>`;

// --- server -----------------------------------------------------------------
const server = createServer(async (req, res) => {
  // Hard request timeout: slow clients/upstreams can't pile up sockets.
  req.setTimeout(REQ_TIMEOUT_MS, () => { req.destroy(); });
  res.setTimeout(REQ_TIMEOUT_MS, () => { res.destroy(); });

  const ip = req.socket.remoteAddress || 'unknown';
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...secHeaders() });
    res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, tools: listTools().length }));
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...secHeaders() });
    res.end(INFO_HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/docs') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...secHeaders() });
    res.end(DOCS_HTML);
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json', ...secHeaders() });
    res.end(JSON.stringify({ error: { code: 'cwi.not_found', message: 'not found' } }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST', ...secHeaders() });
    res.end(JSON.stringify({ error: { code: 'cwi.method_not_allowed', message: 'use POST /mcp' } }));
    return;
  }

  // ---- auth gate: every /mcp call, no exceptions ----
  if (!bearerOk(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...secHeaders() });
    res.end(JSON.stringify({
      error: {
        code: 'cwi.unauthorized',
        message: 'missing or invalid Bearer token — this MCP server requires Authorization: Bearer <token> on every call',
      },
    }));
    return;
  }

  // ---- rate limit (client IP) ----
  const rlKey = `${ip}`;
  if (rateLimited(rlKey)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60', ...secHeaders() });
    res.end(JSON.stringify({
      error: { code: 'cwi.rate_limited', message: `rate limited: ${RATE_PER_MIN} requests/min — retry after 60s` },
    }));
    return;
  }

  let msg;
  try {
    const raw = await readBody(req);
    msg = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...secHeaders() });
    res.end(JSON.stringify(jsonRpcError(null, -32700, 'parse error: body must be JSON (max 1 MB)', 'cwi.parse_error')));
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...secHeaders() });
    res.end(JSON.stringify(jsonRpcError(null, -32600, 'invalid request: single JSON-RPC object only (no batches)', 'cwi.invalid_request')));
    return;
  }

  const accept = req.headers.accept || '';
  const sse = !accept.includes('application/json') && accept.includes('text/event-stream');

  try {
    const out = await handleMessage(msg);
    if (out === null) {
      res.writeHead(202, { ...secHeaders() });
      res.end();
      return;
    }
    sendJson(res, 200, out, sse);
  } catch {
    // Sanitized: no stack, no internals.
    res.writeHead(500, { 'Content-Type': 'application/json', ...secHeaders() });
    res.end(JSON.stringify(jsonRpcError(msg.id, -32603, 'internal error', 'cwi.internal')));
  }
});

// --- public docs page (no auth) ---------------------------------------------
const toolRows = listTools()
  .map((t) => `<tr><td><code>${t.name}</code></td><td><code>${t.annotations.scope}</code></td><td>${t.description}</td></tr>`)
  .join('\n');

const DOCS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${SERVER_NAME} — docs</title></head>
<body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5">
<h1>${SERVER_NAME} <small>v${SERVER_VERSION}</small> — API docs</h1>
<p>Cumulative Web Inc's public MCP server. All tools are <b>read-only</b> and <b>versioned</b> (version in the tool name, e.g. <code>_v1</code>). There are no mutating tools by design.</p>
<h2>Auth</h2>
<p>Every <code>POST /mcp</code> call requires <code>Authorization: Bearer &lt;token&gt;</code>. No token → <code>401 cwi.unauthorized</code>. Rate limit: ${RATE_PER_MIN} req/min per IP (429 with <code>Retry-After: 60</code>).</p>
<h2>Error taxonomy</h2>
<ul>
<li><code>cwi.unauthorized</code> (401) — missing/invalid Bearer token</li>
<li><code>cwi.invalid_params</code> (400) — argument failed validation; <code>detail.problems</code> lists each field error</li>
<li><code>cwi.not_found</code> (404) — track_id / task_id / slug not in the index</li>
<li><code>cwi.conflicted_isrc</code> — ISRC appears in conflicting reports; result carries candidates, never an authoritative value</li>
<li><code>cwi.upstream_unavailable</code> (503) — Gear Ledger GitHub fetch failed; retry shortly</li>
<li><code>cwi.timeout</code> (504) — tool exceeded its execution budget</li>
<li><code>cwi.internal</code> (500) — sanitized; no stack traces are ever returned</li>
</ul>
<h2>ISRC conflict rule</h2>
<p>2 of 52 catalog records have conflicted ISRCs (Golden Diamond, Shaka Zulu); 4 have no verified ISRC. Conflicted/unverified ISRCs are <b>never presented as authoritative</b>: search results show <code>isrc: null</code> with an <code>isrc_warning</code>, and <code>catalog_isrc_lookup_v1</code> returns <code>status: "conflicted"</code> with candidates and sources.</p>
<h2>Tools</h2>
<table border="1" cellpadding="6" cellspacing="0"><tr><th>tool</th><th>scope</th><th>description</th></tr>
${toolRows}
</table>
<h2>Threat model</h2>
<p>See <code>THREAT-MODEL.md</code> in the project for the per-tool threat analysis. Summary: every tool is an abuse/prompt-injection vector; mitigations are token auth, read-only scope, strict validation, timeouts, rate limits, no secret or stack leakage, and vendored-example-only verification for needledrop (no arbitrary file paths).</p>
<p><a href="/">home</a> · <a href="/health">health</a> · CWI public catalog data — Cumulative Web Inc™</p>
<p style="font-size:12px;color:#555">© 2026 Cumulative Web Inc. All rights reserved. Cumulative Web Inc™, CWI™, CWI Connector™, Cover Pieces™, Crown Climb™, Word Signal™ are trademarks of Cumulative Web Inc.</p>
</body></html>`;

server.listen(PORT, BIND, () => {
  console.error(`${SERVER_NAME} v${SERVER_VERSION} listening on ${BIND}:${PORT} (POST /mcp, Bearer auth required)`);
});
