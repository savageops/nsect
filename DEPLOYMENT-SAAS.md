# Nsect SaaS Hosting and Deployment Guide

## Deployment Model

Nsect is designed as:

- one hosted API service for extraction (`/api/engine`)
- one hosted API service for YouTube transcript extraction (`/api/youtube/transcript`)
- many consumer API keys (per user/team/workspace)
- optional MCP clients running anywhere that call your hosted API

Recommended pattern:

1. Host API centrally (DigitalOcean VM or container platform)
2. Generate customer API keys via `/api/keys/create`
3. Distribute API key + API URL to customers
4. Customers wire those into MCP config locally

## Required Environment

- `PORT`
- `ADMIN_KEY`
- `NODE_ENV=production` (recommended for hosted environments)
- `NSECT_INVIDIOUS_INSTANCES` (optional CSV override)
- `NSECT_PIPED_INSTANCES` (optional CSV override)
- `NSECT_YTDLP_COMMANDS` (optional CSV command fallback list)

For MCP clients:

- `NSECT_API_URL`
- `NSECT_API_KEY`

## Hosting Option A: Ubuntu VM + systemd (Recommended Baseline)

Run on the host after cloning the repo:

```bash
bash scripts/deploy-saas-host.sh \
  --repo-dir /opt/nsect \
  --admin-key "replace-with-strong-secret" \
  --port 3000 \
  --service-user "$USER"
```

This script:

- installs dependencies
- installs Puppeteer browser binary
- writes `.env`
- creates `nsect-api.service`
- enables and starts service

After deploy:

```bash
curl http://127.0.0.1:3000/health
```

## Hosting Option B: Existing Node Fleet

If you already have process supervision:

1. Run `bash scripts/bootstrap.sh --install-browser`
2. Set env (`ADMIN_KEY`, `PORT`, `NODE_ENV=production`)
3. Start with `node api.js`
4. Put behind HTTPS reverse proxy

## Connectivity Checklist

Use:

```bash
bash scripts/smoke-test.sh --base-url https://api.yourdomain.com --api-key sk_xxx
```

Ensure:

- `/health` is reachable publicly or from intended clients
- `/api/engine` works with valid key (`x-api-key` or `Authorization: Bearer`)
- `/api/youtube/transcript` works for a known public video ID
- invalid key returns `403`
- rate-limited key returns `429`
- search cooldown responses return `429` with `retryAfter` messaging

## MCP Connectivity

Generate config:

```bash
bash scripts/render-mcp-config.sh \
  --api-url https://api.yourdomain.com \
  --api-key sk_xxx
```

Insert output into your MCP client config.

## SaaS Operations

### Key Management

- Create key per customer/integration
- Set rate limit based on plan tier
- Set `searchCooldownSeconds` (minimum `6`) based on anti-abuse policy
- Revoke compromised keys immediately
- Rotate keys during customer offboarding

### Security

- Never use default `ADMIN_KEY` in production
- Store admin secret in your secret manager
- Terminate TLS at reverse proxy/load balancer
- Restrict admin routes to trusted IP ranges when possible

### Reliability

- Monitor health endpoint and process restarts
- Alert on elevated 5xx/502/503 rates
- Track key usage and rate-limit events
- Track transcript adapter success distribution by method (`nsect_native`, `nsect_signal`, `invidious`, `piped`, `yt_dlp`)
- Back up `data/keys.sqlite` (plus WAL/SHM sidecar files when present) if using local storage

## Notes for True Multi-Node SaaS

Current key storage is SQLite-backed (`data/keys.sqlite`).
For horizontal scale, move key state to shared storage (managed SQL/Redis/document DB) and keep contract parity with current key validation behavior.
