<p align="center">
  <img src="web/public/icons/hub-512.png" width="96" alt="Tailnet Agents logo">
</p>

<h1 align="center">Tailnet Agents</h1>

<p align="center">
  A self-hosted browser workspace for running coding agents and terminals on your
  own machines over Tailscale, with a searchable record of the work.
</p>

![Tailnet Agents demo: a coordinator is asked to start a SurroundFold render on a media server. It opens a terminal on that device, inspects the audio tracks, starts the render and reports back while the terminal stays visible. The Memory view then finds the run, and its source record opens.](https://github.com/r-firth/tailnet-agents/releases/download/v0.1.0-alpha.2/tailnet-agents-demo.gif)

<sub>Actual UI running the isolated demo with synthetic devices and data. See [docs/demo](docs/demo/README.md).</sub>

## What it does

- **Coordinator chat.** Each session has a coordinator (Codex or Claude) that can
  use your SSH devices, run commands in a visible terminal and delegate to agents.
- **Native agent sessions.** Start Codex, Copilot or Claude directly on a chosen
  device and project directory, using that device's existing installation and sign-in.
- **One persistent terminal per session.** Watch the agent type, scroll back, or
  choose **Take control** and use the shell yourself.
- **Inspectable results.** Commands, output, exit status, diffs, sources and images
  appear inline in the chat.
- **Memory.** Conversations, tool calls and terminal output are recorded in Vecgra.
  Search by text or meaning (**Cmd/Ctrl+K**), browse the graph, and open the run
  that produced a result.
- **Phone access.** An installable PWA with push notifications for finished work
  and input requests.

Tailnet Agents is an early alpha.

## How it works

The server runs on one host (for example a home server) and you open it in a
browser. Tailscale SSH devices are discovered automatically by short name;
terminals are tmux sessions on those devices. The coordinator runs on the host.
Native sessions run on the selected device, reached over SSH.

A Rust/Axum server serves the API, streams events and owns terminal connections.
A Python worker hosts the provider SDKs. The React/TypeScript frontend uses a
Ghostty terminal renderer. Vecgra stores memory on the host. See
[Architecture](docs/architecture.md).

Agents run without per-tool approval prompts: Codex uses approval policy `never`
with full access, and Claude uses `bypassPermissions`. Only register machines you
are comfortable letting them operate.

## Requirements

- macOS or Linux for the server
- Node.js 24+ and npm
- Rust through rustup; the toolchain is pinned in `rust-toolchain.toml`
- Python 3.12+ and uv
- tmux 3.x
- Codex CLI, authenticated with `codex login`

Remote devices need SSH and tmux. Windows devices can expose an SSH endpoint
through WSL.

## Install and run

```sh
git clone https://github.com/r-firth/tailnet-agents.git
cd tailnet-agents
./scripts/setup.sh
cp .env.example .env
npm run build
./scripts/start.sh
```

Open **http://127.0.0.1:4318**. Setup installs project dependencies and the
pinned WASM build tooling.

- **Semantic search:** add `OPENROUTER_API_KEY` to `.env`. Indexed text and search
  queries are sent to OpenRouter for Qwen3-Embedding-8B embeddings. Without a key,
  text search and the graph still work. See [semantic memory](docs/self-hosting.md#semantic-memory).
- **Other devices and phones:** follow the [self-hosting guide](docs/self-hosting.md)
  for Tailscale HTTPS, authentication, SSH setup, running as a service, PWA
  installation and backups.
- **Claude:** install Claude Code 2.1.280 or later on each execution machine and
  run `claude auth login` there with a Claude subscription. The server must run as
  the same user with `claude` on PATH. Remote devices must permit loopback SSH
  reverse forwarding. See [Claude sessions](docs/agents-and-views.md#claude-sessions).

## Use

1. Choose **New session**, then Coordinator or a native agent, device and project.
2. Ask for the work, for example: "Check disk usage on media-server."
3. Follow the tool calls in the chat and the output in the session terminal.
   **Stop agent** cancels the turn. **Close session** also ends its terminal.
   Closing the browser leaves work running.
4. Open **Memory** or press **Cmd/Ctrl+K** to find earlier work and its source run.

More detail: [agents, custom views and notifications](docs/agents-and-views.md).

## Development

```sh
npm run dev       # UI on :4317, API on :4318
npm run check     # Tests, builds, and isolated integration checks
npm run demo      # Read-only demo with synthetic data on :4325
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

A project-wide license has not been selected yet. Vendored Vecgra retains its
[Apache 2.0 license](vendor/vecgra/LICENSE), and bundled Nerd Fonts retain their
[license](web/public/fonts/NERD-FONTS-LICENSE) and
[attribution](web/public/fonts/NERD-FONTS-README.md).
