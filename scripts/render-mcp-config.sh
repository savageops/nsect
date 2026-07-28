#!/usr/bin/env bash
set -euo pipefail

API_URL="${NSECT_API_URL:-}"
API_KEY="${NSECT_API_KEY:-}"
ENTRY_PATH="./packages/mcp/index.js"

usage() {
  cat <<'EOF'
Usage: bash scripts/render-mcp-config.sh [options]

Options:
  --api-url <url>        Hosted Nsect API URL
  --api-key <key>        Nsect API key
  --entry-path <path>    Path to MCP server index.js (default: ./packages/mcp/index.js)
  -h, --help             Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      API_URL="${2:-}"
      shift 2
      ;;
    --api-key)
      API_KEY="${2:-}"
      shift 2
      ;;
    --entry-path)
      ENTRY_PATH="${2:-}"
      shift 2
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

if [[ -z "$API_URL" || -z "$API_KEY" ]]; then
  echo "Error: --api-url and --api-key are required." >&2
  exit 1
fi

node -e '
const [entryPath, apiUrl, apiKey] = process.argv.slice(1);
const config = {
  mcpServers: {
    nsect: {
      command: "node",
      args: [entryPath],
      env: {
        NSECT_API_URL: apiUrl,
        NSECT_API_KEY: apiKey
      }
    }
  }
};
console.log(JSON.stringify(config, null, 2));
' "$ENTRY_PATH" "$API_URL" "$API_KEY"
