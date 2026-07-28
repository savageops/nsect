#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${USER:-$(whoami)}"
SERVICE_NAME="nsect-api"
PORT="3000"
ADMIN_KEY="${ADMIN_KEY:-}"
SKIP_BROWSER_INSTALL=0

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy-saas-host.sh --admin-key <value> [options]

Run this on Ubuntu hosts to install and start Nsect as a systemd service.

Options:
  --repo-dir <path>          Repository root path (default: current repo)
  --service-user <user>      Linux user for service (default: current user)
  --service-name <name>      systemd service name (default: nsect-api)
  --port <value>             API port (default: 3000)
  --admin-key <value>        Production admin key (required)
  --skip-browser-install     Skip Puppeteer browser installation
  -h, --help                 Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      REPO_DIR="${2:-}"
      shift 2
      ;;
    --service-user)
      SERVICE_USER="${2:-}"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --admin-key)
      ADMIN_KEY="${2:-}"
      shift 2
      ;;
    --skip-browser-install)
      SKIP_BROWSER_INSTALL=1
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

if [[ -z "$ADMIN_KEY" ]]; then
  echo "Error: --admin-key is required." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "Error: sudo is required for host deployment." >&2
  exit 1
fi

if [[ ! -d "$REPO_DIR" ]]; then
  echo "Error: repo dir not found: $REPO_DIR" >&2
  exit 1
fi

echo "[deploy] Installing system packages..."
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

if ! command -v node >/dev/null 2>&1; then
  echo "[deploy] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

cd "$REPO_DIR"

echo "[deploy] Installing application dependencies..."
npm install
(
  cd packages/mcp
  npm install
)

if [[ "$SKIP_BROWSER_INSTALL" -eq 0 ]]; then
  echo "[deploy] Installing browser binary..."
  npm run install-browser
fi

cat > .env <<EOF
NODE_ENV=production
PORT=${PORT}
ADMIN_KEY=${ADMIN_KEY}
NSECT_API_URL=http://127.0.0.1:${PORT}
NSECT_API_KEY=
EOF

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
echo "[deploy] Writing systemd service: ${SERVICE_FILE}"
sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Nsect API Service
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=ADMIN_KEY=${ADMIN_KEY}
ExecStart=/usr/bin/node ${REPO_DIR}/api.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "[deploy] Enabling and restarting service..."
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo "[deploy] Service status:"
sudo systemctl --no-pager --full status "${SERVICE_NAME}" || true

echo "[deploy] Health check:"
curl -fsS "http://127.0.0.1:${PORT}/health" || true

echo "[deploy] Done."
