# The Sandbox SDK needs its own base image; the machine layer is the same as
# image/Dockerfile. Keep the SDK version in step with package.json.
FROM docker.io/cloudflare/sandbox:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb fluxbox x11vnc novnc websockify tmux ffmpeg git python3 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex
COPY machine /opt/familiar/machine
RUN cd /opt/familiar/machine && npm ci && npm run build
ENV CHROME_PATH=/usr/bin/chromium
