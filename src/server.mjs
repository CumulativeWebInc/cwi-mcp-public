#!/usr/bin/env node
/**
 * cwi-mcp-public — production-grade public MCP server for CWI services.
 *
 * Exposes (all read-only, all versioned):
 *   - CWI Catalog API: 52-track interop index (8 silver dashboard-verified
 *     ISRCs, 44 bronze; 2 ISRCs conflicted, 4 unverified/missing).
 *     CONFLICT RULE: a conflicted or unverified ISRC is NEVER presented as
 *     authoritative. Conflicted lookups return status "conflicted" plus the
 *     candidate values and their sources — never a single chosen value.
 *   - Games: Cover Pieces, Crown Climb, Word Signal (read-only metadata +
 *     play links from their published content.json; the games themselves are
 *     static web apps — this server holds no game state).
 *   - Agent tools (read-only): Gear Ledger reads, CWI Verdict Engine
 *     (trust_verdict), NEEDLE DROP ledger verification (verify-only).
 *
 * Production hardening vs the v0.x precedent:
 *   - strict per-tool input validation (types, lengths, enums, patterns)
 *   - per-handler execution timeouts (default 20s)
 *   - error taxonomy: stable machine codes (cwi.*), human-readable messages,
 *     never a stack trace or secret in output
 *   - upstream failures (GitHub fetches) degrade to cwi.upstream_unavailable
 *     with retry guidance instead of hanging
 *   - Bearer token auth enforced in the HTTP transport (server-http.mjs);
 *     the stdio transport here is for local/self-hosted use only
 *
 * Zero dependencies: node stdlib only (node >= 18).
 */

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DATA = join(ROOT, 'data');

export const SERVER_NAME = 'cwi-mcp-public';
export const SERVER_VERSION = '1.0.0';
export const PROTOCOL_VERSION = '2024-11-05';

// ------------------------------------------------------------------ config ---
export const HANDLER_TIMEOUT_MS = parseInt(process.env.HANDLER_TIMEOUT_MS || '20000', 10);
export const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '12000', 10);

// ------------------------------------------------------- error taxonomy ----
/**
 * Every outward error carries: code (stable, cwi.*), message (human-readable),
 * http (suggested HTTP status for the transport layer), and detail (safe
 * key/value facts only — no stack traces, no secrets, no internal paths).
 */
export class CwiError extends Error {
  constructor(code, message, { http = 500, detail = undefined } = {}) {
    super(message);
    this.name = 'CwiError';
    this.code = code;
    this.http = http;
    this.detail = detail;
  }
}

export const E = {
  invalidParams: (message, detail) => new CwiError('cwi.invalid_params', message, { http: 400, detail }),
  notFound: (message, detail) => new CwiError('cwi.not_found', message, { http: 404, detail }),
  upstreamUnavailable: (message, detail) => new CwiError('cwi.upstream_unavailable', message, { http: 503, detail }),
  timeout: (message, detail) => new CwiError('cwi.timeout', message, { http: 504, detail }),
  internal: (message, detail) => new CwiError('cwi.internal', message, { http: 500, detail }),
  conflict: (message, detail) => new CwiError('cwi.conflicted_isrc', message, { http: 200, detail }), // see catalog rules
};

// ----------------------------------------------------------- validation -----
/**
 * Minimal strict validator for tool params.
 * field spec: {type, required, enum, maxLen, minLen, pattern, items}
 */
export function validateArgs(toolName, schema, args) {
  const problems = [];
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw E.invalidParams(`tool ${toolName}: arguments must be a JSON object`, { tool: toolName });
  }
  const allowed = Object.keys(schema);
  for (const k of Object.keys(args)) {
    if (!allowed.includes(k)) problems.push(`unknown field "${k}"`);
  }
  for (const [k, spec] of Object.entries(schema)) {
    const v = args[k];
    if (v === undefined || v === null) {
      if (spec.required) problems.push(`missing required field "${k}"`);
      continue;
    }
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') { problems.push(`"${k}" must be a string`); break; }
        if (spec.maxLen && v.length > spec.maxLen) problems.push(`"${k}" exceeds max length ${spec.maxLen}`);
        if (spec.minLen && v.length < spec.minLen) problems.push(`"${k}" shorter than min length ${spec.minLen}`);
        if (spec.pattern && !spec.pattern.test(v)) problems.push(`"${k}" has invalid format`);
        if (spec.enum && !spec.enum.includes(v)) problems.push(`"${k}" must be one of: ${spec.enum.join(', ')}`);
        break;
      case 'integer':
        if (!Number.isInteger(v)) { problems.push(`"${k}" must be an integer`); break; }
        if (spec.min !== undefined && v < spec.min) problems.push(`"${k}" must be >= ${spec.min}`);
        if (spec.max !== undefined && v > spec.max) problems.push(`"${k}" must be <= ${spec.max}`);
        break;
      case 'array':
        if (!Array.isArray(v)) { problems.push(`"${k}" must be an array`); break; }
        if (spec.maxItems && v.length > spec.maxItems) problems.push(`"${k}" exceeds max ${spec.maxItems} items`);
        if (spec.items === 'string' && v.some((x) => typeof x !== 'string')) problems.push(`"${k}" must contain only strings`);
        break;
      case 'object':
        if (typeof v !== 'object' || v === null || Array.isArray(v)) problems.push(`"${k}" must be an object`);
        break;
      default:
        problems.push(`server misconfiguration: unknown type for "${k}"`);
    }
  }
  if (problems.length) throw E.invalidParams(`tool ${toolName}: invalid arguments`, { tool: toolName, problems });
}

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const TRACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,80}$/;

// ------------------------------------------------------------ data layer ---
let catalogCache = null;
function loadCatalog() {
  if (!catalogCache) {
    const raw = readFileSync(join(DATA, 'catalog-index.json'), 'utf8');
    catalogCache = JSON.parse(raw);
  }
  return catalogCache;
}

function summarizeTrack(r) {
  const isrc = r.identity && r.identity.isrc;
  return {
    track_id: r.track_id,
    title: r.identity.title,
    artist: r.identity.artist,
    catalog_id: r.catalog_id,
    isrc_status: isrc ? isrc.status : 'unverified',
    // The ISRC value is exposed ONLY when verified. Conflicted/unverified
    // values are never presented as authoritative.
    isrc: isrc && isrc.status === 'verified' ? isrc.value : null,
    ...(isrc && isrc.status !== 'verified'
      ? { isrc_warning: `ISRC not authoritative (${isrc.status}); see catalog_track_get_v1 for detail` }
      : {}),
  };
}

let gamesCache = null;
function loadGames() {
  if (!gamesCache) {
    gamesCache = [
      { slug: 'cover-pieces', file: 'game-cover-pieces.json' },
      { slug: 'crown-climb', file: 'game-crown-climb.json' },
      { slug: 'word-signal', file: 'game-word-signal.json' },
    ].map(({ slug, file }) => {
      const c = JSON.parse(readFileSync(join(DATA, file), 'utf8'));
      return {
        slug,
        name: c.game.name,
        url: c.game.url,
        theme_tracks: c.game.theme_tracks || [],
        self_contained: !!c.game.self_contained,
        caption: c.caption,
      };
    });
  }
  return gamesCache;
}

// -------------------------------------------------------------- tool defs ---

const LEDGER_PUBLIC_STATE_URL =
  'https://raw.githubusercontent.com/CumulativeWebInc/gear-ledger/main/state.json';
const LEDGER_PUBLIC_SHA_URL =
  'https://api.github.com/repos/CumulativeWebInc/gear-ledger/commits/main';

function fetchText(url, redirects = 3) {
  return import('node:https').then(
    ({ get }) =>
      new Promise((resolve, reject) => {
        const req = get(
          url,
          { headers: { 'User-Agent': 'cwi-mcp-public/1.0.0' } },
          (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
              res.resume();
              resolve(fetchText(res.headers.location, redirects - 1));
              return;
            }
            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`upstream HTTP ${res.statusCode}`));
              return;
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', (err) => reject(err));
        req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('upstream fetch timeout')));
      })
  );
}

const VENDOR = join(ROOT, 'vendor');
const NEEDLE_DROP_LEDGER_PY = join(VENDOR, 'needledrop', 'ledger.py');
const NEEDLE_DROP_EXAMPLE = join(VENDOR, 'needledrop', 'example-ledger.json');
const VERDICT_ENGINE = join(VENDOR, 'cwi-verdict-engine-v1.0.0', 'engine.py');

const catalogSearchSchema = {
  query: { type: 'string', required: true, minLen: 1, maxLen: 120 },
  limit: { type: 'integer', min: 1, max: 50 },
};

const TOOLS = [
  // ------------------------------------------------------------ catalog ----
  {
    name: 'catalog_search_v1',
    version: '1.0.0',
    scope: 'catalog:read',
    description:
      'Search the CWI catalog index by title or artist (case-insensitive substring). Returns track summaries. ISRC values appear only for dashboard-verified records; conflicted/unverified records carry an isrc_warning instead.',
    params: catalogSearchSchema,
    handler: async (args) => {
      const { records } = loadCatalog();
      const q = args.query.toLowerCase();
      const hits = records.filter(
        (r) => r.identity.title.toLowerCase().includes(q) || r.identity.artist.toLowerCase().includes(q)
      );
      const limit = args.limit ?? 10;
      return {
        query: args.query,
        total_hits: hits.length,
        tracks: hits.slice(0, limit).map(summarizeTrack),
        index_version: loadCatalog().index_version,
      };
    },
  },
  {
    name: 'catalog_track_get_v1',
    version: '1.0.0',
    scope: 'catalog:read',
    description:
      'Full detail for one catalog track by track_id. Never presents a conflicted or unverified ISRC as authoritative — those records include the conflict candidates and their sources so the caller can see the discrepancy.',
    params: { track_id: { type: 'string', required: true, pattern: TRACK_ID_PATTERN, maxLen: 80 } },
    handler: async (args) => {
      const { records } = loadCatalog();
      const r = records.find((x) => x.track_id === args.track_id);
      if (!r) throw E.notFound(`no catalog track with track_id "${args.track_id}"`, { track_id: args.track_id });
      const isrc = r.identity.isrc;
      const out = summarizeTrack(r);
      if (isrc && isrc.status !== 'verified') {
        out.isrc_conflict_detail = {
          status: isrc.status,
          authoritative_value: null,
          source_note: isrc.source || null,
          warning:
            'This ISRC is NOT authoritative. Do not publish, license, or register with this value; confirm with the distributor dashboard.',
        };
      } else if (isrc) {
        out.isrc_source_note = isrc.source || null;
      }
      return out;
    },
  },
  {
    name: 'catalog_isrc_lookup_v1',
    version: '1.0.0',
    scope: 'catalog:read',
    description:
      'Look up a track by ISRC code (12 chars, e.g. QZ8EF2666377). Verified matches return the track. If the ISRC is disputed/conflicted in the index, returns status "conflicted" with candidates and sources — never a chosen value. Unknown codes return cwi.not_found.',
    params: { isrc: { type: 'string', required: true, pattern: /^[A-Za-z0-9]{12}$/, maxLen: 12 } },
    handler: async (args) => {
      const code = args.isrc.toUpperCase();
      if (!ISRC_PATTERN.test(code)) {
        throw E.invalidParams('isrc must match the ISRC format: 2 letters + 3 alphanumerics + 7 digits', { isrc: args.isrc });
      }
      const { records } = loadCatalog();
      const direct = records.filter((r) => r.identity.isrc && r.identity.isrc.value === code);
      if (direct.length) {
        return { status: 'verified', track: summarizeTrack(direct[0]) };
      }
      // Conflicted candidates: check whether this code appears anywhere in a
      // conflict's source note (candidates listed there).
      const conflicted = records.filter((r) => {
        const s = r.identity.isrc;
        return s && s.status === 'conflicted' && s.source && s.source.toUpperCase().includes(code);
      });
      if (conflicted.length) {
        return {
          status: 'conflicted',
          message: `ISRC ${code} appears among conflicting reports — no authoritative value exists.`,
          authoritative_value: null,
          tracks: conflicted.map((r) => ({
            track_id: r.track_id,
            title: r.identity.title,
            conflict_note: r.identity.isrc.source,
          })),
          warning: 'Do not publish, license, or register with this value; confirm with the distributor dashboard.',
        };
      }
      throw E.notFound(`no catalog record references ISRC ${code}`, { isrc: code });
    },
  },
  {
    name: 'catalog_stats_v1',
    version: '1.0.0',
    scope: 'catalog:read',
    description: 'Catalog index statistics: record counts, silver/bronze split, ISRC verification breakdown.',
    params: {},
    handler: async () => {
      const idx = loadCatalog();
      return {
        index_version: idx.index_version,
        generated: idx.generated,
        record_count: idx.record_count,
        summary: idx.summary,
      };
    },
  },
  // -------------------------------------------------------------- games ----
  {
    name: 'games_list_v1',
    version: '1.0.0',
    scope: 'games:read',
    description:
      'List the three CWI web games: Cover Pieces, Crown Climb, Word Signal — names, slugs, and play URLs. The games are static web apps; this tool exposes metadata only and holds no game state or scores.',
    params: {},
    handler: async () => ({ games: loadGames().map((g) => ({ slug: g.slug, name: g.name, url: g.url })) }),
  },
  {
    name: 'game_get_v1',
    version: '1.0.0',
    scope: 'games:read',
    description: 'Detail for one CWI web game by slug (cover-pieces, crown-climb, word-signal): play URL, theme tracks, description.',
    params: { slug: { type: 'string', required: true, enum: ['cover-pieces', 'crown-climb', 'word-signal'] } },
    handler: async (args) => {
      const g = loadGames().find((x) => x.slug === args.slug);
      if (!g) throw E.notFound(`unknown game slug "${args.slug}"`, { slug: args.slug });
      return g;
    },
  },
  // ------------------------------------------------------------- agents ----
  {
    name: 'ledger_state_version_v1',
    version: '1.0.0',
    scope: 'ledger:read',
    description: 'Read-only: Gear Ledger version summary (version number, updated_at, repo sha, task count, agent count). Reads CWI\'s public gear-ledger repo; no auth, read-only.',
    params: {},
    handler: async () => {
      const { doc, sha, source } = await readStateSource();
      return {
        version: doc.version, updated_at: doc.updated_at, sha,
        read_source: source,
        tasks: (doc.tasks || []).length,
        agents: (doc.agents || []).length,
      };
    },
  },
  {
    name: 'ledger_agents_v1',
    version: '1.0.0',
    scope: 'ledger:read',
    description: 'Read-only: Gear Ledger agents with their latest presence heartbeat merged in. Reads the public gear-ledger repo; no auth, read-only.',
    params: {},
    handler: async () => {
      const doc = await readDoc();
      const presence = doc.presence || {};
      return (doc.agents || []).map((a) => {
        const p = presence[a.agent_id] || presence[`agent:${a.agent_id}`] || null;
        return {
          agent_id: a.agent_id, public_name: a.public_name, handle: a.handle,
          department: a.department, role: a.role, status: a.status,
          presence: p ? { status: p.status, at: p.at, current_task_id: p.current_task_id, note: p.note } : null,
        };
      });
    },
  },
  {
    name: 'ledger_tasks_v1',
    version: '1.0.0',
    scope: 'ledger:read',
    description: 'Read-only: Gear Ledger task summaries. Optional state filter.',
    params: { state: { type: 'string', enum: ['created', 'assigned', 'in_progress', 'delivered', 'verified', 'cancelled', 'failed'] } },
    handler: async (args) => {
      const doc = await readDoc();
      let tasks = doc.tasks || [];
      if (args.state) tasks = tasks.filter((t) => t.state === args.state);
      return tasks.map((t) => ({
        task_id: t.task_id, type: t.type, title: t.title, state: t.state,
        assigned_to: t.assigned_to, priority: t.priority, created_by: t.created_by, created_at: t.created_at,
      }));
    },
  },
  {
    name: 'ledger_task_get_v1',
    version: '1.0.0',
    scope: 'ledger:read',
    description: 'Read-only: full detail of one Gear Ledger task by task_id (including state history and artifacts).',
    params: { task_id: { type: 'string', required: true, minLen: 1, maxLen: 120 } },
    handler: async (args) => {
      const doc = await readDoc();
      const t = (doc.tasks || []).find((x) => x.task_id === args.task_id);
      if (!t) throw E.notFound(`ledger task not found: ${args.task_id}`, { task_id: args.task_id });
      return t;
    },
  },
  {
    name: 'trust_verdict_v1',
    version: '1.0.0',
    scope: 'trust:score',
    description:
      'Score agent trust with the CWI Verdict Engine v1.0.0 (deterministic, evidence-bound). Pass input as the engine input object. The engine NEVER invents a score: insufficient evidence yields status "insufficient-data" (score null). Inputs must be real, citable evidence. Runs locally with a timeout; no data leaves the server.',
    params: { input: { type: 'object', required: true } },
    handler: async (args) => {
      if (!existsSync(VERDICT_ENGINE)) {
        throw E.internal('trust_verdict engine not vendored on this server', {});
      }
      const r = spawnSync('python3', [VERDICT_ENGINE], {
        input: JSON.stringify(args.input), encoding: 'utf8', timeout: 30000,
      });
      if (r.error) throw E.internal(`verdict engine failed to execute`, {});
      let parsed;
      try { parsed = JSON.parse(r.stdout); }
      catch { throw E.internal('verdict engine returned non-JSON output', {}); }
      return parsed;
    },
  },
  {
    name: 'needledrop_verify_v1',
    version: '1.0.0',
    scope: 'trust:verify',
    description:
      'Verify-only: check hash-chain integrity of a NEEDLE DROP placement ledger (cwi-needledrop/v1). Verifies the vendored example ledger; no signing, no sealing — verification only. Supplying arbitrary file paths is not supported on the public server (path-traversal hardening).',
    params: {},
    handler: async () => {
      if (!existsSync(NEEDLE_DROP_LEDGER_PY)) {
        throw E.internal('NEEDLE DROP verifier not vendored on this server', {});
      }
      const r = spawnSync('python3', [NEEDLE_DROP_LEDGER_PY, 'verify', '--file', NEEDLE_DROP_EXAMPLE], {
        encoding: 'utf8', timeout: 30000,
      });
      if (r.error) throw E.internal('NEEDLE DROP verifier failed to execute', {});
      const out = (r.stdout || '').trim();
      const ok = r.status === 0 && out.startsWith('OK');
      return { ok, ledger: 'vendored example ledger (cwi-needledrop/v1)', messages: out.replace(/^(OK|FAIL):\s*/, '').split('; ').filter(Boolean) };
    },
  },
];

// ------------------------------------------------------- ledger helpers ----
async function readStateSource() {
  try {
    const [stateText, shaText] = await Promise.all([
      fetchText(LEDGER_PUBLIC_STATE_URL),
      fetchText(LEDGER_PUBLIC_SHA_URL).catch(() => null),
    ]);
    const doc = JSON.parse(stateText);
    let sha = null;
    if (shaText) { try { sha = JSON.parse(shaText).sha || null; } catch { /* null */ } }
    return { doc, sha, source: 'public' };
  } catch (err) {
    throw E.upstreamUnavailable(
      'Gear Ledger upstream is unreachable right now; retry shortly.',
      { upstream: 'raw.githubusercontent.com' }
    );
  }
}

async function readDoc() {
  return (await readStateSource()).doc;
}

// ------------------------------------------------------------- dispatch ----
// Per-tool scope gating is enforced at the HTTP layer via the tool's `scope`
// field; every tool here is read-only (no mutating tools exist by design).

const SCOPES = {
  'catalog:read': 'CWI catalog index (read-only)',
  'games:read': 'CWI games metadata (read-only)',
  'ledger:read': 'Gear Ledger state (read-only)',
  'trust:score': 'CWI Verdict Engine scoring (compute-only, no state)',
  'trust:verify': 'NEEDLE DROP ledger verification (verify-only)',
};

/**
 * Run one tool call with input validation + execution timeout.
 * Returns the raw result; throws CwiError on any failure.
 */
export async function runTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw E.invalidParams(`unknown tool "${name}"`, { tool: name });
  validateArgs(name, tool.params, args || {});
  return await withTimeout(
    tool.handler(args || {}),
    HANDLER_TIMEOUT_MS,
    `tool ${name} exceeded ${HANDLER_TIMEOUT_MS}ms`
  );
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(E.timeout(message, {})), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: schemaToJsonSchema(t.name, t.params),
    annotations: { version: t.version, scope: t.scope, readOnlyHint: true },
  }));
}

function schemaToJsonSchema(name, params) {
  const properties = {};
  const required = [];
  for (const [k, spec] of Object.entries(params)) {
    const p = {};
    if (spec.type === 'string') {
      p.type = 'string';
      if (spec.maxLen) p.maxLength = spec.maxLen;
      if (spec.minLen) p.minLength = spec.minLen;
      if (spec.enum) p.enum = spec.enum;
    } else if (spec.type === 'integer') {
      p.type = 'integer';
      if (spec.min !== undefined) p.minimum = spec.min;
      if (spec.max !== undefined) p.maximum = spec.max;
    } else if (spec.type === 'array') {
      p.type = 'array';
      if (spec.maxItems) p.maxItems = spec.maxItems;
      if (spec.items === 'string') p.items = { type: 'string' };
    } else if (spec.type === 'object') {
      p.type = 'object';
    }
    if (spec.required) required.push(k);
    properties[k] = p;
  }
  const out = { type: 'object', properties, additionalProperties: false };
  if (required.length) out.required = required;
  return out;
}

// ------------------------------------------------------- JSON-RPC layer ----
const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

function ok(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }

function fail(id, code, message, cwiCode = undefined, detail = undefined) {
  const e = { code, message };
  if (cwiCode) e.data = { code: cwiCode, ...(detail ? { detail } : {}) };
  return JSON.stringify({ jsonrpc: '2.0', id, error: e });
}

function textResult(payload) { return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }; }
function textError(code, message, detail) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...(detail ? { detail } : {}) } }, null, 2) }],
    isError: true,
  };
}

/** Programmatic entry: resolves to the parsed JSON-RPC response, or null for notifications. */
export async function handleMessage(msg) {
  const line = await dispatch(msg);
  return line === null ? null : JSON.parse(line);
}

async function dispatch(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(msg && msg.id !== undefined ? msg.id : null, ERR.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request', 'cwi.invalid_request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const respond = (line) => (isNotification ? null : line);

  switch (msg.method) {
    case 'initialize':
      return respond(ok(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }));
    case 'tools/list':
      return respond(ok(msg.id, { tools: listTools() }));
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (typeof name !== 'string' || !name) {
        return respond(ok(msg.id, textError('cwi.invalid_params', 'tools/call requires params.name (string)')));
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return respond(ok(msg.id, textError('cwi.invalid_params', 'tools/call requires params.arguments (object)')));
      }
      try {
        return respond(ok(msg.id, textResult(await runTool(name, args))));
      } catch (err) {
        if (err instanceof CwiError) {
          return respond(ok(msg.id, textError(err.code, err.message, err.detail)));
        }
        // Sanitized: never leak stack traces or internals outward.
        console.error(`[internal] tools/call ${name}: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
        return respond(ok(msg.id, textError('cwi.internal', 'internal error while running tool', { tool: name })));
      }
    }
    case 'ping':
      return respond(ok(msg.id, {}));
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return respond(fail(msg.id, ERR.METHOD_NOT_FOUND, `method not found: ${msg.method}`, 'cwi.method_not_found'));
  }
}

async function serve() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); }
    catch {
      process.stdout.write(fail(null, ERR.PARSE, 'parse error: one JSON object per line', 'cwi.parse_error') + '\n');
      continue;
    }
    try {
      const out = await dispatch(msg);
      if (out !== null) process.stdout.write(out + '\n');
    } catch {
      if (msg.id !== undefined && msg.id !== null) {
        process.stdout.write(fail(msg.id, ERR.INTERNAL, 'internal error', 'cwi.internal') + '\n');
      }
    }
  }
}

const invokedAsScript = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedAsScript) serve();
