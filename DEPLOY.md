# DEPLOY.md — staging the public MCP server (Black's tap)

Status: code is green (40 unit + 27 integration tests), repo is pushed, deploy
is **staged, not live** — it needs Black's one tap below. No $0 public-HTTPS
path exists that needs zero new accounts (Hugging Face Docker Spaces now
requires PRO — verified 2026-09-24 with a live 402).

## What Black taps (one time, ~5 minutes)

1. **Create a Render account** at https://render.com (free — GitHub sign-in works).
2. In Render: **New + → Web Service** → connect the GitHub repo
   `CumulativeWebInc/cwi-mcp-public`.
3. Render reads `render.yaml` automatically: Docker runtime, **free plan**,
   health check `/health`.
4. **Set the secret:** in the service's Environment tab, add `MCP_TOKEN` —
   paste the Bearer token value (it lives at `~/.config/cwi-mcp-public/token`
   on the CWI machine; KingCode hands it to you — it is never in the repo).
5. Deploy. When the build finishes, Render gives a public HTTPS URL like
   `https://cwi-mcp-public.onrender.com`.
6. Verify: open `https://cwi-mcp-public.onrender.com/health` → `{"ok":true,...}`.

## Wiring it to Muse

In Muse: add a **custom connector** with URL
`https://cwi-mcp-public.onrender.com/mcp` and the Bearer token from step 4.
All 12 tools (`catalog_search_v1`, `game_get_v1`, …) become available to Muse —
and through Muse, to Charm voice users.

## Notes

- Free Render services sleep after inactivity; first request after sleep takes
  ~30s. The `/health` check wakes it.
- Token rotation = paste a new `MCP_TOKEN` value in Render and redeploy; give
  the new value to Muse's connector config.
- Nothing here touches cumulativeweb.com (DNS + HTTPS still pending — off-limits).
- HF Spaces deploy script (`bin/deploy-hf-space`) is kept as a fallback: it
  becomes viable the moment a PRO-or-equivalent free Docker path exists.
