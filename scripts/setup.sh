#!/usr/bin/env bash
# Build everything: the machine daemon, the Desk web UI and the server.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cargo >/dev/null || { echo "Install Rust first: https://rustup.rs"; exit 1; }
command -v node >/dev/null || { echo "Install Node 22+ first"; exit 1; }
echo "→ machine daemon (agentd)"
(cd machine && npm install --no-audit --no-fund && npm run build)
echo "→ web UI"
(cd web && npm install --no-audit --no-fund && npm run build)
echo "→ server"
cargo build --release
[ -f .env ] || cp .env.example .env
echo
echo "Done. Start with ./scripts/start.sh (or ./scripts/demo.sh for the offline demo)."
