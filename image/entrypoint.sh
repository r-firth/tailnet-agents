#!/bin/bash
# Familiar machine entrypoint: starts the desktop stack (Xvfb + Openbox + x11vnc + noVNC)
# and then agentd, which dials out to the Familiar server.
#
# Env (all optional except the server/token/id):
#   FAMILIAR_SERVER, FAMILIAR_MACHINE_TOKEN, FAMILIAR_MACHINE_ID, FAMILIAR_MACHINE_NAME, FAMILIAR_BACKEND
#   FAMILIAR_DESKTOP=0          headless: no X, no VNC (Chrome runs headless)
#   FAMILIAR_SCREEN=1440x960    virtual screen size
#   FAMILIAR_VNC_PASSWORD       protect the VNC/noVNC view with a password
#   FAMILIAR_NOVNC_PORT=6080    container port for noVNC
#   FAMILIAR_DESKTOP_URL        URL reported to the server for the desktop view
#                               (default http://localhost:<novnc port>/vnc.html?...; the server should
#                               map the container port to the published host port)
set -euo pipefail

export HOME="${HOME:-/home/agent}"
export FAMILIAR_HOME="${FAMILIAR_HOME:-$HOME}"
mkdir -p "$FAMILIAR_HOME"
pids=()

cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

if [ "${FAMILIAR_DESKTOP:-1}" != "0" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  n="${DISPLAY#:}"; n="${n%%.*}"
  rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}" 2>/dev/null || true
  Xvfb "$DISPLAY" -screen 0 "${FAMILIAR_SCREEN:-1440x960}x24" -nolisten tcp -dpi 96 >/tmp/xvfb.log 2>&1 &
  pids+=($!)
  for _ in $(seq 1 100); do [ -S "/tmp/.X11-unix/X${n}" ] && break; sleep 0.1; done
  if [ ! -S "/tmp/.X11-unix/X${n}" ]; then
    echo "entrypoint: Xvfb did not start; continuing headless" >&2
    cat /tmp/xvfb.log >&2 || true
    unset DISPLAY
  else
    xsetroot -solid '#1d2230' 2>/dev/null || true
    openbox >/tmp/openbox.log 2>&1 &
    pids+=($!)
    vnc_auth=(-nopw)
    if [ -n "${FAMILIAR_VNC_PASSWORD:-}" ]; then
      mkdir -p "$HOME/.vnc"
      x11vnc -storepasswd "$FAMILIAR_VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1
      vnc_auth=(-rfbauth "$HOME/.vnc/passwd")
    fi
    x11vnc -display "$DISPLAY" -forever -shared -rfbport "${FAMILIAR_RFB_PORT:-5900}" -localhost -noxdamage -quiet "${vnc_auth[@]}" >/tmp/x11vnc.log 2>&1 &
    pids+=($!)
    port="${FAMILIAR_NOVNC_PORT:-6080}"
    websockify --web /usr/share/novnc "$port" "localhost:${FAMILIAR_RFB_PORT:-5900}" >/tmp/novnc.log 2>&1 &
    pids+=($!)
    export FAMILIAR_DESKTOP_URL="${FAMILIAR_DESKTOP_URL:-http://localhost:${port}/vnc.html?autoconnect=1&resize=scale}"
  fi
else
  unset DISPLAY
fi

# Not exec: keep this shell as the parent so the desktop processes are cleaned up with agentd.
node /opt/agentd/dist/main.js --home "$FAMILIAR_HOME" --backend "${FAMILIAR_BACKEND:-docker}" "$@" &
agentd=$!
trap 'kill -TERM $agentd 2>/dev/null; wait $agentd; cleanup' TERM INT
wait $agentd
