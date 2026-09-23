# Development

Run [setup](README.md#install) first. It installs dependencies from the npm and
uv lockfiles, adds the WASM target, and installs the pinned wasm-bindgen CLI.
Rust is pinned in `rust-toolchain.toml`; tmux and Codex must be available on PATH.

## Local workflow

```sh
npm run dev
```

The Vite UI listens on `127.0.0.1:4317` and proxies `/api` and WebSockets to the
Rust backend on `127.0.0.1:4318`. The development launcher loads `.env` and builds
the GPU module. Stop a production instance on that port before starting it.

```sh
npm run build     # WASM, production UI, release server
npm run check     # Formatting, tests, builds, integration checks
npm run format    # Rust, frontend, and Python formatting
```

`npm run check` runs Clippy, Ruff and formatting checks, then covers Rust boundaries and persistence, shader validation,
frontend lifecycle and activity behavior, Python worker events, PWA caching,
API authentication, terminal ownership, SSH discovery, image delivery, and
Ghostty output/scrollback. Embedding tests use a local HTTP fixture; the default
suite clears the OpenRouter key and never makes paid embedding requests.
Migration tests verify backups, graph identities, model isolation, and restart
resumption. Provider tests cover query instructions, response validation,
retries, credential-safe errors, caching, and concurrent search/indexing.
Integration scripts create temporary databases and
test terminals, then clean them up. They require tmux and do not send requests
to the live coordinator. GitHub Actions runs the same suite on macOS and Linux.
Browser visual checks are separate.

An opt-in test uses your authenticated Codex account:

```sh
agent/.venv/bin/python scripts/agent-smoke.py
```

It starts a disposable Tailnet Agents and checks native web search, streamed command
output, receipts, Tailnet Agents tool calls, and persistence after restart. It uses account
capacity and is not part of the default suite.

## Visual assets

The synthetic activity fixture is at `/design-review.html` on the development
server. It exercises real components without loading conversations or devices.
Follow the [visual direction](docs/design/workstation-finish.md).

To regenerate PWA icons from `web/src/assets/mark.svg`:

```sh
agent/.venv/bin/python scripts/build-app-icons.py
```

Keep screenshots or recordings used in documentation synthetic; real workspace
captures may reveal chat content, terminal output, hostnames, or local paths.

## Memory performance

Create an isolated synthetic archive; the fixture refuses to overwrite one:

```sh
cargo run -p hub-server --example memory_fixture -- /tmp/hub-memory-fixture 10000
HUB_DATA_DIR=/tmp/hub-memory-fixture HUB_PORT=4323 HUB_DISCOVERY=off ./target/debug/hub-server
```

In another shell:

```sh
python3 scripts/memory-bench.py http://127.0.0.1:4323
python3 scripts/memory-smoke.py http://127.0.0.1:4323
node scripts/memory-layout-bench.mjs http://127.0.0.1:4323
```

Retrieval benchmarks report warmed local HTTP p50/p95/max including JSON
parsing; they do not measure model inference. Layout benchmarks measure solver
CPU time, not browser frame rate. Use the normal integration suite to verify
the provider-to-index retrieval path. A live Qwen check requires an explicitly
configured OpenRouter key; fixture vectors do not measure model quality.

## Before publishing changes

Review `git status --short` and the staged diff. `.env` variants, `data/`,
databases, logs, build output, dependencies, and common key files are ignored.
That does not cover private material copied into arbitrary source files.
Never force-add runtime data, credentials, terminal exports, or real-user images.

Run `npm run check` before a release. Keep the dependency lockfiles and bundled
third-party licenses with the source. Tailnet Agents’ own project-wide license has not
yet been selected.
