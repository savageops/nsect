#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skill_root="$(cd "$script_dir/.." && pwd)"
bundled_binary="$skill_root/assets/bin/nsect-rs.exe"
binary="${NSECT_RS_BIN:-$bundled_binary}"

if [[ ! -f "$binary" ]]; then
  echo "nsect-rs.exe not found. Expected $bundled_binary or set NSECT_RS_BIN." >&2
  exit 1
fi

exec "$binary" "$@"
