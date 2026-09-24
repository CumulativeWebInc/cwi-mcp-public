# Changelog — cwi-mcp-public

All notable changes, newest first. Tool names carry versions (`_v1`); breaking
changes to a tool's contract ship as a new versioned name (`_v2`), never a
silent change to `_v1`.

## [1.0.0] — 2026-09-24

First public release. Production-hardened from the v0.x demo precedent
(`~/workspace/cwi-mcp-server-public`): the bridge there had no auth, no input
validation, no per-handler timeouts, unversioned tool names, and no error
taxonomy — all addressed here.

### Added
- 12 versioned read-only MCP tools (names carry `_v1`; scope annotations):
  - Catalog: `catalog_search_v1`, `catalog_track_get_v1`, `catalog_isrc_lookup_v1`, `catalog_stats_v1`
  - Games: `games_list_v1`, `game_get_v1` (Cover Pieces, Crown Climb, Word Signal)
  - Agents: `ledger_state_version_v1`, `ledger_agents_v1`, `ledger_tasks_v1`, `ledger_task_get_v1`, `trust_verdict_v1`, `needledrop_verify_v1`
- Bearer token auth on every `POST /mcp` call (constant-time compare; server refuses to start without `MCP_TOKEN`)
- Error taxonomy: stable `cwi.*` codes, human-readable messages, never a stack trace or secret in output
- ISRC conflict rule enforced in code: conflicted/unverified ISRCs never presented as authoritative (2 conflicted, 4 unverified of 52 records)
- Input validation on every tool: types, lengths, enums, patterns, unknown-field rejection
- Per-handler execution timeout (default 20s) → `cwi.timeout`; per-request HTTP timeout (30s); upstream fetch timeout (12s)
- Rate limiting: 120 req/min/IP → `429 cwi.rate_limited` with `Retry-After: 60`
- 1 MB body cap; single-message requests only (batches rejected); SSE framing for event-stream clients
- Graceful degradation: Gear Ledger GitHub fetch failures → `503 cwi.upstream_unavailable` with retry guidance
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
- Public docs: `GET /docs` page + `README.md` + `THREAT-MODEL.md`; info page at `GET /`; health at `GET /health`
- Tests: 40 unit + 27 integration, all green (measured latency catalog_search_v1: p50 ~15ms, p95 ~30–170ms localhost, n=30)

### Deliberately excluded
- No mutating tools (no writes anywhere — by design)
- `needledrop_verify_v1` verifies the vendored example ledger only; arbitrary `file` paths from the v0.x precedent are disabled on the public server (path-traversal hardening)
- No stdio transport on the public deployment (HTTP only; stdio remains for local use)
