<p align="center">
  <img src="web/public/icons/hub-512.png" width="128" alt="Tailnet Agents logo">
</p>

<h1 align="center">Tailnet Agents</h1>

<p align="center">
  A personal workspace for your agents, machines, and memory.<br>
  Self-hosted, connected over Tailscale, and built to show its work.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="docs/self-hosting.md">Self-hosting</a> ·
  <a href="#mobile">Mobile</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Development</a>
</p>

<p align="center">
  <a href="docs/demo/surroundfold.mp4">
    <img src="docs/demo/surroundfold.gif" alt="Tailnet Agents starts a SurroundFold render on a media server, shows the terminal, and follows the work through its memory graph." width="1280">
  </a>
</p>

<p align="center">
  <a href="docs/demo/surroundfold.mp4">Watch the 35-second demo</a> ·
  <a href="docs/demo/README.md">Try the walkthrough locally</a><br>
  <sub>Actual Tailnet Agents UI. Scripted SurroundFold workflow with synthetic media, devices, and activity.</sub>
</p>

## What is Tailnet Agents?

Tailnet Agents brings a built-in Codex agent, your SSH devices, and persistent terminals
into one browser workspace. Run it on a home server, open it from your laptop
or phone, and ask it to work across your machines.

Each session has its own conversation and, when needed, one terminal. Watch the
agent work, inspect its commands and results in the chat, or take control of
the shell yourself. Closing a session stops its agent and terminal; closing a
browser leaves the work running.

Conversations, tool calls, and terminal output are recorded in Vecgra. Search
past work by meaning or exact text, explore the memory graph, and jump from a
result back to the session that produced it.

## Highlights

- A Codex SDK coordinator with streaming replies, native tools, and live web search
- Automatic discovery of Tailscale SSH devices using their short connection names
- One persistent, Ghostty-powered terminal per session, with scrollback while watching
- Commands, diffs, sources, screenshots, and generated images directly in the chat
- Qwen semantic search and an interactive Vecgra graph of your work
- A mobile interface that installs as a standalone PWA
- Copper accents, pixel hardware, and dithered animations tied to real agent activity

Tailnet Agents is an early alpha. Agents installed on a device can run in its
terminal today; native ACP sessions and agent installation are planned.

## Install

Tailnet Agents’ server runs on macOS or Linux. Remote shell hosts need SSH and tmux;
Windows devices can expose an SSH endpoint through WSL.

Install these prerequisites before running setup:

- Node.js 24+ and npm
- Rust through rustup; the toolchain is pinned in `rust-toolchain.toml`
- Python 3.12+ and uv
- tmux 3.x
- Codex CLI, authenticated with `codex login`

Clone the repository, then run setup:

```sh
git clone https://github.com/r-firth/tailnet-agents.git
cd tailnet-agents
./scripts/setup.sh
cp .env.example .env
npm run build
./scripts/start.sh
```

Open **http://127.0.0.1:4318**. Setup installs project dependencies and the
pinned WASM build tooling. Add `OPENROUTER_API_KEY` to `.env` for semantic
memory: Tailnet Agents uses Qwen3-Embedding-8B through OpenRouter for both indexing and
search queries. Without a key, exact text search and the graph remain available.

For access from other devices, follow the [self-hosting guide](docs/self-hosting.md).
It covers private Tailscale HTTPS, authentication, SSH setup, and backups.

## See the work

Ask the coordinator to use a device, or open a terminal in the current session.
Its actions appear inline, with expandable commands, output, exit status,
file changes, and web sources. Native Codex tools run on the Tailnet Agents host; Tailnet Agents
terminals provide visible, persistent work on local or remote machines.

Use **Take control** to type in the terminal. You can scroll back while the
agent owns it, and the most recently focused viewer sets its dimensions.
**Stop agent** cancels the turn; **Close session** also ends its terminal.
Closed conversations remain searchable without restarting their shells.

## Memory

Press **Cmd/Ctrl+K** to search, or open **Memory** to navigate Vecgra's nodes
and directed relationships. Switch between network and sequence arrangements,
inspect recorded events, and open the source session from a search result.
The graph and text index stay on the Tailnet Agents server. Embedding requests send the
indexed text and search queries to OpenRouter; returned vectors are stored in
Vecgra. See [embedding configuration](docs/self-hosting.md#semantic-memory).

## Mobile

Open your workspace’s HTTPS address on a phone connected to Tailscale, then choose
**Install Tailnet Agents** in the sidebar. Android Chrome also offers installation from
its browser menu; on iPhone or iPad, use **Share → Add to Home Screen**.

The installed app keeps the same pixel styling, with touch controls and separate
Chat and Terminal views. Live work requires a connection to an awake Tailnet Agents host.
See [mobile installation](docs/self-hosting.md#mobile-installation) for details.

## Development

```sh
npm run dev       # UI on :4317, API on :4318
npm run check     # Tests, builds, and isolated integration checks
```

The frontend uses React, TypeScript, and Vite. Rust/Axum serves the API, streams
events, and owns terminal connections; a Python worker hosts the Codex SDK.
Rust/wgpu supplies the WebGPU activity instruments, with matching Canvas 2D
rendering when WebGPU is unavailable.

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and fixtures, and
[Architecture](docs/architecture.md) for persistence and runtime boundaries.

## License

A project-wide license has not been selected yet. Vendored Vecgra retains its
[Apache 2.0 license](vendor/vecgra/LICENSE), and bundled Nerd Fonts retain their
[license](web/public/fonts/NERD-FONTS-LICENSE) and
[attribution](web/public/fonts/NERD-FONTS-README.md).
