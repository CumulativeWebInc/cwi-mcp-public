#!/usr/bin/env node
/**
 * test-unit.mjs — unit tests for src/server.mjs (no network, no processes).
 * Covers: validation framework, error taxonomy, conflict rules, tool listing.
 */
import { runTool, listTools, validateArgs, CwiError, E } from '../src/server.mjs';

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

// ---- validation ----
check('validateArgs accepts valid args', (() => { validateArgs('t', { q: { type: 'string', required: true, maxLen: 5 } }, { q: 'hi' }); return true; })());
await expectCwiError('validateArgs rejects missing required', async () => validateArgs('t', { q: { type: 'string', required: true } }, {}), 'cwi.invalid_params');
await expectCwiError('validateArgs rejects unknown field', async () => validateArgs('t', { q: { type: 'string' } }, { q: 'x', zzz: 1 }), 'cwi.invalid_params');
await expectCwiError('validateArgs rejects overlong string', async () => validateArgs('t', { q: { type: 'string', maxLen: 3 } }, { q: 'toolong' }), 'cwi.invalid_params');
await expectCwiError('validateArgs rejects non-object args', async () => validateArgs('t', {}, 'nope'), 'cwi.invalid_params');
await expectCwiError('validateArgs rejects array args', async () => validateArgs('t', {}, []), 'cwi.invalid_params');
await expectCwiError('validateArgs rejects bad enum', async () => validateArgs('t', { s: { type: 'string', enum: ['a','b'] } }, { s: 'z' }), 'cwi.invalid_params');
await expectCwiError('validateArgs rejects bad pattern', async () => validateArgs('t', { id: { type: 'string', pattern: /^[a-z]+$/ } }, { id: 'ABC1' }), 'cwi.invalid_params');
await expectCwiError('validateArgs rejects bad integer', async () => validateArgs('t', { n: { type: 'integer', min: 1, max: 5 } }, { n: 9 }), 'cwi.invalid_params');

// ---- tool listing: versioned names, all read-only ----
const tools = listTools();
check('12 tools listed', tools.length === 12, `got ${tools.length}`);
check('all tool names versioned (_v1)', tools.every((t) => /_v1$/.test(t.name)));
check('all tools carry scope annotations', tools.every((t) => t.annotations && t.annotations.scope));
check('no write/mutating scopes', tools.every((t) => !/write|mutat|delete|create/.test(t.annotations.scope)));
check('unique tool names', new Set(tools.map((t) => t.name)).size === tools.length);

// ---- catalog tools ----
const search = await runTool('catalog_search_v1', { query: 'diabolique' });
check('catalog_search finds Diabolique', search.total_hits >= 1 && search.tracks[0].title === 'Diabolique');
check('verified ISRC exposed on verified record', search.tracks[0].isrc === 'QZ8EF2666377');

const searchGolden = await runTool('catalog_search_v1', { query: 'golden diamond' });
check('conflicted record hides ISRC value', searchGolden.tracks[0].isrc === null && !!searchGolden.tracks[0].isrc_warning);

await expectCwiError('catalog_search rejects empty query', async () => runTool('catalog_search_v1', { query: '' }), 'cwi.invalid_params');
await expectCwiError('catalog_search rejects over-limit', async () => runTool('catalog_search_v1', { query: 'x', limit: 500 }), 'cwi.invalid_params');
await expectCwiError('catalog_search rejects unknown field', async () => runTool('catalog_search_v1', { query: 'x', evil: 1 }), 'cwi.invalid_params');

const track = await runTool('catalog_track_get_v1', { track_id: 'that-boy-hi-hat-golden-diamond' });
check('conflicted track detail never authoritative', track.isrc === null && track.isrc_conflict_detail.authoritative_value === null && !!track.isrc_conflict_detail.warning);
await expectCwiError('catalog_track_get 404 on unknown id', async () => runTool('catalog_track_get_v1', { track_id: 'no-such-track' }), 'cwi.not_found');
await expectCwiError('catalog_track_get rejects bad track_id format', async () => runTool('catalog_track_get_v1', { track_id: '../../../etc/passwd' }), 'cwi.invalid_params');

const isrcHit = await runTool('catalog_isrc_lookup_v1', { isrc: 'QZ8EF2666377' });
check('ISRC lookup returns verified track', isrcHit.status === 'verified' && isrcHit.track.title === 'Diabolique');
const isrcConflict = await runTool('catalog_isrc_lookup_v1', { isrc: 'QZK6J2376416' });
check('conflicted ISRC returns conflicted status, no value', isrcConflict.status === 'conflicted' && isrcConflict.authoritative_value === null && isrcConflict.tracks.length >= 1);
await expectCwiError('ISRC lookup 404 on unknown code', async () => runTool('catalog_isrc_lookup_v1', { isrc: 'USRC19999999' }), 'cwi.not_found');
await expectCwiError('ISRC lookup rejects malformed code', async () => runTool('catalog_isrc_lookup_v1', { isrc: 'not-an-isrc!!' }), 'cwi.invalid_params');

const stats = await runTool('catalog_stats_v1', {});
check('catalog stats: 52 records', stats.record_count === 52);
check('catalog stats: 8 silver / 44 bronze', stats.summary.silver === 8 && stats.summary.bronze === 44);
check('catalog stats: 2 conflicted', stats.summary.isrc_conflicted === 2);

// ---- games tools ----
const games = await runTool('games_list_v1', {});
check('games_list returns 3 games', games.games.length === 3);
check('games_list slugs correct', games.games.map((g) => g.slug).sort().join(',') === 'cover-pieces,crown-climb,word-signal');
check('game play URLs are https', games.games.every((g) => g.url.startsWith('https://')));
const game = await runTool('game_get_v1', { slug: 'crown-climb' });
check('game_get returns detail + URL', game.name.includes('Crown Climb') && game.url.startsWith('https://'));
await expectCwiError('game_get rejects unknown slug', async () => runTool('game_get_v1', { slug: 'nope' }), 'cwi.invalid_params');

// ---- unknown tool ----
await expectCwiError('unknown tool -> cwi.invalid_params', async () => runTool('does_not_exist_v9', {}), 'cwi.invalid_params');

// ---- error taxonomy shape ----
const e = E.notFound('human message here', { track_id: 'x' });
check('CwiError carries code/http/detail', e.code === 'cwi.not_found' && e.http === 404 && e.detail.track_id === 'x' && !('stack' in JSON.parse(JSON.stringify(e))));
check('CwiError message human-readable', /human message/.test(e.message));

// ---- needledrop (local vendored verifier) ----
const nd = await runTool('needledrop_verify_v1', {});
check('needledrop_verify returns ok bool + messages', typeof nd.ok === 'boolean' && Array.isArray(nd.messages));

// ---- trust verdict: insufficient evidence must not score ----
const verdict = await runTool('trust_verdict_v1', {
  input: { engine_version: '1.0.0', subject: { agent_id: 'x' }, context: 'unit test', observed_at: '2026-09-24T00:00:00Z', signals: { erc8004: [], needle_drop: [], first_spin: [] } },
});
check('trust_verdict empty evidence never scores (null)', verdict.score === null && ['insufficient-data', 'unknown-context', 'evidence-disputed'].includes(verdict.status), `got ${verdict.status}`);

console.log(`\nunit: ${passed} passed, ${failed} failed`);
if (fails.length) { console.log('failed:', fails.join(', ')); process.exit(1); }
