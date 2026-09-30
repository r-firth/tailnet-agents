#!/usr/bin/env bash
# Offline demo: built-in coordinator rules, the scripted executor driving a real
# Chromium against a local demo site, local hash embeddings. Separate data dir.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x target/release/familiar ] || ./scripts/setup.sh
export FAMILIAR_DATA_DIR="${FAMILIAR_DATA_DIR:-data-demo}"
export FAMILIAR_COORDINATOR="${FAMILIAR_COORDINATOR:-mock}"
export FAMILIAR_EMBEDDER="${FAMILIAR_EMBEDDER:-hash}"
export FAMILIAR_DEFAULT_EXECUTOR="${FAMILIAR_DEFAULT_EXECUTOR:-scripted}"
echo "Familiar demo on http://127.0.0.1:${FAMILIAR_PORT:-4400}  — try: \"cancel my polyform sub\""
exec target/release/familiar --demo --env /dev/null "$@"
