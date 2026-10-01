# Familiar machine image: agentd + Chromium + a full desktop (Xvfb, Openbox, x11vnc, noVNC)
# + Claude Code and Codex CLIs.
#
# Build from the repository root:
#   docker build -f image/Dockerfile -t familiar-machine:latest .
#
# Behind a TLS-intercepting proxy, pass the proxy and its CA as a build secret (never baked in):
#   docker build --network host \
#     --build-arg HTTPS_PROXY=$HTTPS_PROXY --build-arg HTTP_PROXY=$HTTP_PROXY --build-arg NO_PROXY=$NO_PROXY \
#     --secret id=build_ca,src=/path/to/ca-bundle.crt \
#     -f image/Dockerfile -t familiar-machine:latest .
#
# Run (this is what familiar-server's docker backend does):
#   docker run -d --name familiar-errands --add-host host.docker.internal:host-gateway --shm-size 1g \
#     -v familiar-errands-home:/home/agent \
#     -e FAMILIAR_SERVER=ws://host.docker.internal:4400 -e FAMILIAR_MACHINE_TOKEN=... \
#     -e FAMILIAR_MACHINE_ID=m_errands -e FAMILIAR_MACHINE_NAME=errands -e FAMILIAR_BACKEND=docker \
#     -P familiar-machine:latest
#
# The images come from Google's Docker Hub mirror; docker.io/library/node:22-bookworm(-slim) are identical.

ARG BUILD_IMAGE=mirror.gcr.io/library/node:22-bookworm
ARG RUNTIME_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim

# ---------------------------------------------------------------- build agentd
# The full node image has python3/make/g++ for node-pty's native build.
FROM ${BUILD_IMAGE} AS build
WORKDIR /src/machine
COPY machine/package.json machine/package-lock.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund
COPY machine/tsconfig.json machine/tsconfig.test.json ./
COPY machine/src ./src
COPY machine/test ./test
RUN npm run build && npm prune --omit=dev --no-audit --no-fund \
    && node -e "require('node-pty')" && echo "node-pty OK"

# ---------------------------------------------------------------- runtime
FROM ${RUNTIME_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=secret,id=build_ca,required=false \
    set -eux; \
    if [ -s /run/secrets/build_ca ]; then \
      echo 'Acquire::https::CAInfo "/run/secrets/build_ca";' > /etc/apt/apt.conf.d/99build-ca; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      xvfb x11vnc novnc websockify openbox x11-xserver-utils xterm xdotool \
      tini procps ca-certificates curl git python3 ffmpeg less nano unzip xz-utils bsdutils locales; \
    sed -i 's/^# *en_GB.UTF-8/en_GB.UTF-8/' /etc/locale.gen && locale-gen; \
    rm -f /etc/apt/apt.conf.d/99build-ca; \
    rm -rf /var/lib/apt/lists/*

# Agent CLIs (executors). Sign in once per machine: `claude auth login`, `codex login`
# (their credentials live under /home/agent, i.e. in the persistent volume).
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex \
    && npm cache clean --force

# Non-root user; its home is the machine's persistent state (Chrome profile, ~/opt, skills, CLI logins).
RUN useradd --create-home --home-dir /home/agent --uid 1001 --shell /bin/bash agent \
    && mkdir -p /home/agent/opt /home/agent/skills /home/agent/.config \
    && chown -R agent:agent /home/agent

COPY --from=build /src/machine/package.json /opt/agentd/package.json
COPY --from=build /src/machine/node_modules /opt/agentd/node_modules
COPY --from=build /src/machine/dist /opt/agentd/dist
COPY image/entrypoint.sh /opt/agentd/entrypoint.sh
RUN chmod 755 /opt/agentd/entrypoint.sh && ln -s /opt/agentd/dist/main.js /usr/local/bin/agentd

ENV LANG=en_GB.UTF-8 \
    TZ=Europe/London \
    CHROME_PATH=/usr/bin/chromium \
    FAMILIAR_HOME=/home/agent \
    FAMILIAR_BACKEND=docker \
    DISABLE_AUTOUPDATER=1

USER agent
WORKDIR /home/agent
VOLUME ["/home/agent"]
# 6080 = noVNC (full desktop view); VNC itself (5900) stays inside the container.
EXPOSE 6080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD pgrep -f /opt/agentd/dist/main.js >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/agentd/entrypoint.sh"]
