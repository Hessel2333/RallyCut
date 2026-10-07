#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="$HOME/.cargo/bin:$HOME/.local/node-v24.15.0/bin:/opt/homebrew/bin:$PATH"
MODE="${1:-run}"
case "$MODE" in
  run|--verify|--debug|--logs|--telemetry) ;;
  *) echo "Usage: $0 [--verify|--debug|--logs|--telemetry]" >&2; exit 2 ;;
esac
pkill -x rallycut >/dev/null 2>&1 || true
if [[ ! -d node_modules ]]; then npm ci; fi
npm run tauri build -- --bundles app -- --locked
APP_BUNDLE="$ROOT_DIR/src-tauri/target/release/bundle/macos/RallyCut.app"
case "$MODE" in
  --debug) lldb -- "$APP_BUNDLE/Contents/MacOS/rallycut" ;;
  --logs)
    open -n "$APP_BUNDLE"
    /usr/bin/log stream --info --style compact --predicate 'process == "rallycut"' ;;
  --telemetry)
    open -n "$APP_BUNDLE"
    /usr/bin/log stream --info --style compact --predicate 'subsystem == "local.rallycut.desktop"' ;;
  --verify)
    open -n "$APP_BUNDLE"
    sleep 3
    pgrep -x rallycut ;;
  *) open -n "$APP_BUNDLE" ;;
esac
