#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: bash scripts/start-api.sh

Starts the Nsect API from the repository root using current environment.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required." >&2
  exit 1
fi

# Hosted mode requires ADMIN_KEY. The config owner fail-fasts too, but checking
# here gives a cleaner error before the process starts.
HOSTED=0
if [[ "${NSECT_HOSTED:-}" == "1" || "${NODE_ENV:-}" == "production" ]]; then
  HOSTED=1
fi
if [[ "$HOSTED" == "1" && -z "${ADMIN_KEY:-}" ]]; then
  echo "Error: ADMIN_KEY must be set in hosted mode (NSECT_HOSTED=1 or NODE_ENV=production)." >&2
  exit 1
fi

if [[ "$HOSTED" == "1" ]]; then
  echo "[start-api] Starting Nsect API in HOSTED mode..."
else
  echo "[start-api] Starting Nsect API in LOCAL mode (keyless)..."
fi

cd "$ROOT_DIR"
mkdir -p data

echo "[start-api] Starting Nsect API..."
exec node api.js
