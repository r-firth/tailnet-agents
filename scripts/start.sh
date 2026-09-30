#!/usr/bin/env bash
# Run Familiar with your .env. Open http://127.0.0.1:4400
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x target/release/familiar ] || ./scripts/setup.sh
exec target/release/familiar "$@"
