# Threat model — cwi-mcp-public

Every exposed tool is a prompt-injection and abuse vector the moment it's
public. This file documents, per tool, what an attacker or a manipulated
client can do, and what mitigates it. Last reviewed: 2026-09-24.

## Global mitigations (apply to all tools)

1. **Bearer token auth on every `POST /mcp`** — constant-time comparison;
   no anonymous calls. Token is a deployment secret, never in repo/logs.
2. **Read-only by design** — there are no mutating tools; a compromised or
   manipulated client cannot change CWI state through this server.
3. **Strict input validation** — types, max lengths (query 120 chars, track_id
   80, limit ≤ 50), enums, regex patterns; unknown fields rejected. No
   injection surface into shell commands (no shell used anywhere — `spawnSync`
   with argv arrays only).
4. **Timeouts** — 20s per tool handler, 30s per HTTP request, 12s per upstream
   fetch. Slowloris/resource-exhaustion is bounded.
5. **Rate limits** — 120 req/min/IP with 429 + Retry-After. (Not a DDoS
   shield — the host's edge handles that.)
6. **No secret/stack leakage** — errors carry stable `cwi.*` codes and safe
   detail only; unexpected exceptions are logged server-side (one line, no
   secret) and returned as sanitized `cwi.internal`.
7. **Prompt-injection posture** — tool outputs are data, never instructions.
   The catalog conflict rule is the sharpest example: the server will not
   present a disputed ISRC as fact, so a manipulated client cannot launder a
   false authoritative ISRC through CWI's server.

## Per-tool analysis

### `catalog_search_v1` (catalog:read)
- **Abuse:** scraping the whole index via paged queries. **Mitigation:** rate
  limit; the index is public CWI data anyway — exposure is intended.
- **Injection:** query is substring-matched in-process; no query language, no
  eval, no regex built from input. Max 120 chars.

### `catalog_track_get_v1` (catalog:read)
- **Abuse:** track_id pattern `^[a-z0-9][a-z0-9-]{1,80}$` blocks path traversal
  and null bytes; lookup is an in-memory array scan, no filesystem access.

### `catalog_isrc_lookup_v1` (catalog:read)
- **Abuse:** ISRC as a trust signal. **Mitigation:** format-validated
  (ISRC pattern), and conflicted codes return `status: "conflicted"` with
  candidates — never a chosen value. An attacker cannot get this server to
  bless a disputed ISRC.

### `catalog_stats_v1`, `games_list_v1`, `game_get_v1` (catalog:read / games:read)
- **Abuse:** negligible — static data, enum-validated slug. Play URLs are
  fixed https links from the published content.json, not caller-supplied
  (no open-redirect).

### `ledger_*_v1` (ledger:read)
- **Abuse:** reads CWI's *public* gear-ledger repo (same data anyone can fetch
  from GitHub). No private state is exposed. Upstream fetch failures degrade to
  `503 cwi.upstream_unavailable` — the server never hangs or leaks the
  upstream error body.

### `trust_verdict_v1` (trust:score)
- **Abuse:** expensive compute / engine probing. **Mitigation:** 30s
  `spawnSync` timeout, argv-array invocation (no shell), input must be a JSON
  object. The engine is deterministic and evidence-bound: it returns
  `insufficient-data`/`unknown-context` with `score: null` rather than
  inventing scores, so it cannot be coaxed into laundering a false trust score.
- **Data:** caller-supplied evidence is processed in-memory and never stored
  or forwarded. Nothing leaves the server.

### `needledrop_verify_v1` (trust:verify)
- **Abuse:** the v0.x precedent accepted an arbitrary `file` path — a
  path-traversal vector on a public server. **Hardened:** the public server
  verifies the *vendored example ledger only*; the `file` parameter was
  removed. Verify-only, no signing, no sealing.

## Residual risks (accepted, monitored)

- The Bearer token is a shared secret: anyone holding it can call the tools
  within rate limits. Rotation = redeploy with a new `MCP_TOKEN`.
- Rate limit is per-IP, not per-token — a distributed caller can exceed the
  nominal budget. Acceptable: all tools are cheap reads.
- Upstream GitHub availability bounds the ledger tools; catalog/game tools
  are fully local and unaffected.
