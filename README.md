# cwi-mcp-public — public MCP server for CWI services

Cumulative Web Inc's public [MCP](https://modelcontextprotocol.io) server over **streamable HTTP**, for Meta Muse custom connectors (and Charm-voice reach). Zero dependencies — node stdlib only.

## Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `POST /mcp` | Bearer token | JSON-RPC 2.0 MCP (stateless; no session id) |
| `GET /health` | none | `{"ok":true, ...}` health check |
| `GET /` | none | human-readable info page |
| `GET /docs` | none | API docs page |

## Quick start (local)

```bash
MCP_TOKEN=$(openssl rand -hex 32) PORT=7860 node src/server-http.mjs
curl -s localhost:7860/health
curl -s -H "Authorization: Bearer $MCP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' localhost:7860/mcp
```

## Tools (all versioned, all read-only)

**CWI Catalog API** (`catalog:read`) — 52-track interop index, `index_version 1.0.0`
generated 2026-09-19: 8 silver (distributor-dashboard-verified ISRCs), 44 bronze
(Deezer-sourced). 2 ISRCs conflicted (Golden Diamond, Shaka Zulu), 4 missing.

- `catalog_search_v1` — search by title/artist substring
- `catalog_track_get_v1` — full record by `track_id`
- `catalog_isrc_lookup_v1` — lookup by 12-char ISRC
- `catalog_stats_v1` — index statistics

**Games** (`games:read`) — Cover Pieces, Crown Climb, Word Signal: metadata + play
links only (the games are static web apps; the server holds no game state).

- `games_list_v1`, `game_get_v1`

**Agent tools** (`ledger:read`, `trust:score`, `trust:verify`) — Gear Ledger reads
from CWI's public gear-ledger repo, CWI Verdict Engine v1.0.0 (compute-only),
NEEDLE DROP ledger verification (verify-only, vendored example ledger).

- `ledger_state_version_v1`, `ledger_agents_v1`, `ledger_tasks_v1`, `ledger_task_get_v1`
- `trust_verdict_v1`, `needledrop_verify_v1`

There are **no mutating tools** — by design, not by policy.

## ISRC conflict rule

Conflicted or unverified ISRCs are **never presented as authoritative**:
`catalog_search_v1` returns `isrc: null` + `isrc_warning`; `catalog_track_get_v1`
adds `isrc_conflict_detail` with `authoritative_value: null`; and
`catalog_isrc_lookup_v1` returns `status: "conflicted"` with the candidates and
their sources. Do not publish, license, or register with a conflicted value.

## Auth

Every `POST /mcp` call requires `Authorization: Bearer <token>`. Missing or
wrong token → `401 {"error":{"code":"cwi.unauthorized", ...}}`. The token is set
via the `MCP_TOKEN` env var (a deployment secret — never committed). The server
refuses to start without it.

## Error taxonomy

| code | HTTP | meaning |
|---|---|---|
| `cwi.unauthorized` | 401 | missing/invalid Bearer token |
| `cwi.invalid_params` | 400 | argument validation failed; `detail.problems` lists each field error |
| `cwi.parse_error` | 400 | body not JSON / too large |
| `cwi.not_found` | 404 | track_id / task_id / ISRC / slug not in the index |
| `cwi.method_not_allowed` | 405 | only POST /mcp |
| `cwi.conflicted_isrc` | 200* | ISRC appears in conflicting reports — result carries candidates, never a chosen value |
| `cwi.rate_limited` | 429 | over 120 req/min; `Retry-After: 60` |
| `cwi.upstream_unavailable` | 503 | Gear Ledger GitHub fetch failed; retry shortly |
| `cwi.timeout` | 504 | tool exceeded its execution budget |
| `cwi.internal` | 500 | sanitized — stack traces are never returned |

\* conflicted ISRC is a *data answer*, not a transport failure, so it returns
inside a normal tool result.

## Threat model

See `THREAT-MODEL.md` for the per-tool analysis. Summary: every tool is an
abuse/prompt-injection vector; mitigations are Bearer token auth, read-only
scope, strict input validation, per-handler timeouts, rate limits, no secret or
stack-trace leakage, and vendored-example-only verification (no arbitrary file
paths on the public server).

## Tests

```bash
node tests/test-unit.mjs   # 40 unit tests (validation, taxonomy, conflict rules)
node tests/test-http.mjs   # 27 integration tests (real server, auth, wire errors, latency, rate limit)
```

## Changelog

See `CHANGELOG.md`.

## License

MIT — see `LICENSE`.
