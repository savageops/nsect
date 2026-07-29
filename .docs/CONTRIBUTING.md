# Contributing to Nsect

Thanks for helping build Nsect.

This project is designed around one shared engine contract that powers CLI, API, and MCP usage. Contributions should preserve that parity and keep changes clean, testable, and production-safe.

## Ground Rules

- Keep changes atomic with minimal blast radius.
- Avoid duplicate or parallel implementations.
- Prefer contract-first updates over ad-hoc workarounds.
- Keep behavior deterministic with explicit error codes.

## Local Setup

```bash
bash scripts/bootstrap.sh --install-browser
```

Manual equivalent:

```bash
npm install
cd packages/mcp && npm install && cd ../..
npm run install-browser
```

## Where To Make Changes

- Request normalization: `server/core/request.js`
- Search engine fallback: `server/core/search.js`
- Engine runtime: `server/core/engine.js`
- API routes and auth: `server/routes/*`, `server/middleware/*`, `server/db/keys.js`
- MCP tool contracts: `packages/mcp/index.js`, `packages/mcp/api-client.js`
- CLI wrapper: `nsect-engine.js`

## Validation Matrix (Required)

Run before opening a PR:

```bash
npm test
npm run test:mcp
```

If you change scripts, validate usage/help:

```bash
bash scripts/<script-name>.sh --help
```

If you change API behavior, also run:

```bash
npm run test:routes
npm run test:integration
```

## PR Expectations

Every PR should include:

- clear problem statement and scope
- why this approach was chosen
- tests added/updated for behavior changes
- docs updates when user-facing behavior changes

## Documentation Parity

When behavior changes, update relevant docs:

- `README.md`
- `ONBOARDING.md`
- `DEPLOYMENT-SAAS.md`
- `.docs/api-reference.md`
- `.docs/architecture.md`
- `.docs/production-readiness.md`

## Definition of Done

- all required tests pass
- no contract drift between CLI/API/MCP
- no duplicate core logic introduced
- docs reflect the shipped behavior
