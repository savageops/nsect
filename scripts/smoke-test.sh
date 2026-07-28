#!/usr/bin/env bash
set -euo pipefail

BASE_URL="http://localhost:3000"
API_KEY="${NSECT_API_KEY:-}"
RUN_ENGINE=1

usage() {
  cat <<'EOF'
Usage: bash scripts/smoke-test.sh [options]

Options:
  --base-url <url>       API base URL (default: http://localhost:3000)
  --api-key <key>        API key used for authenticated engine test
  --skip-engine          Only check /health
  -h, --help             Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --api-key)
      API_KEY="${2:-}"
      shift 2
      ;;
    --skip-engine)
      RUN_ENGINE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required." >&2
  exit 1
fi

echo "[smoke] Checking health endpoint..."
curl -fsS "${BASE_URL}/health" >/dev/null
echo "[smoke] /health OK"

if [[ "$RUN_ENGINE" -eq 1 ]]; then
  if [[ -z "$API_KEY" ]]; then
    echo "Error: --api-key is required unless --skip-engine is used." >&2
    exit 1
  fi

  echo "[smoke] Checking authenticated engine endpoint..."
  curl -fsS -X POST "${BASE_URL}/api/engine" \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${API_KEY}" \
    -d '{"url":"https://example.com","format":"text","timeout":20}' >/dev/null
  echo "[smoke] /api/engine OK"
fi

echo "[smoke] All checks passed."
