# DEPLOY.md — public MCP server deployment (LIVE 2026-09-24)

Status: code is green (40 unit + 27 adversarial + 27 integration tests),
repo is public, deploy is **LIVE** since 2026-09-24 ~10:25 EDT — Render free
plan, Oregon, Docker; `https://cwi-mcp-public.onrender.com` — `/health` green,
live-URL E2E pass 9/9 measured green ~10:50 EDT.

> PUSH 2026-09-24: Black gave the rollout tap ("Do it") — the security-hardening
> changes (control-char sanitization, 27-test adversarial suite, ©/™ notices)
> were pushed to main and Render auto-redeployed from the same commit.

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
