# Familiar

A personal agent you message on Telegram or the web. It does real errands and coding on its own
persistent computer, remembers everything in one [Vecgra](https://github.com/r-firth/vecgra) graph,
and lets you watch every click, keystroke and command live, scrub back through it, or take control.

```
 Telegram ──┐                                        ┌── agentd on "errands" (your persistent machine)
            ├── familiar (Rust, always on) ──────────┤     Chrome (persistent profile) · terminal · Claude Code / Codex
 Web Desk ──┘   coordinator · Vecgra memory.vg       └── forks for parallel work · Docker · Cloudflare · your box over Tailscale
```

## Try it

```sh
./scripts/setup.sh          # builds agentd, the web UI and the server
./scripts/demo.sh           # offline demo, no keys: http://127.0.0.1:4400
```

In the demo, type **cancel my polyform sub**, **book me the train to edinburgh and pay for it**
(asks you to approve £142.40, over the £100 line) or **install blender on my machine** (asks
a question). A scripted executor drives a real Chromium against a local demo site, so the live
view, keyframes, replay, terminal, approvals, memory and search are all real.

For real work: `cp .env.example .env`, fill in what you have, then `./scripts/start.sh`.
With Claude Code installed and logged in, the coordinator runs on your Claude subscription and
the default executor is Claude Code. See [TURN-ON.md](TURN-ON.md).

## What's in the box

| Part | What it does |
|---|---|
| `crates/familiar-server` | Axum server: API + WebSocket stream, the coordinator (Claude Code over MCP, an OpenRouter model, or built-in rules), tasks, approvals, questions, Telegram, schedules, machine launcher, and all state in one Vecgra file |
| `machine/` | `agentd`, the daemon inside every machine: persistent Chrome with CDP screencast and take-control input, a visible terminal, the `familiar` MCP tools, and the Claude Code / Codex / scripted executors |
| `web/` | The Desk: needs-you strip, one focused run with live browser / terminal / desktop and replay, every other run as a live tile, memory, machines, ⌘K search |
| `image/` | The machine image (Xvfb desktop, noVNC, Chrome, Claude Code, Codex, agentd) |
| `cloudflare/` | Sandbox SDK Worker: one sandbox per machine, home directory restored from and saved to R2 |
| `scripts/e2e.mjs` | End-to-end check with a fake Telegram and the scripted executor |
| `scripts/screens.mjs` | Screenshots of the Desk against the real demo server, light and dark, desktop and phone |

## How it works

- **One coordinator** owns the conversation. It answers from memory when it can, remembers what
  you tell it, and starts tasks for hands-on work. Tools: `start_task`, `remember`, `recall`,
  `forget`, `cancel_task`, `answer_question`, `schedule`, `kill` (also served at `/api/mcp`).
- **Tasks** run on your personal machine, whose home directory (Chrome profile, `~/opt` installs,
  skills) persists and is backed up after every task. When it's busy, a fork of it starts with the
  same installs and logins and is thrown away afterwards.
- **Everything is a timeline** in Vecgra: steps, tool calls, browser actions with keyframes,
  memory reads and writes, questions, answers, control changes. Replay frames are recorded at
  ~1 fps; the terminal is logged byte for byte.
- **Memory** is a typed graph: claims (fact, preference, rule, account, subscription, person,
  procedure, episode) linked `ABOUT` subjects, `SUPPORTED_BY` the event or message that proves
  them, `SUPERSEDES` older versions (a fact is never overwritten), `LEARNED_FROM` tasks.
  Keyframes are embedded as images, so you can search what the agent saw.
  Embeddings: `google/gemini-embedding-2` via OpenRouter at 3,072 dims, or a local hashed
  embedding when there's no key (switching re-embeds).
- **Guardrails** are light: payments over £100 (configurable) wait for you, with "approve and
  never ask for this merchant"; a kill switch in Telegram (`/kill`) and the web.

Protocol details: [docs/protocol.md](docs/protocol.md).

## Development

```sh
cargo test                          # server
(cd machine && npm test)            # agentd
(cd web && npm run typecheck)       # UI
node scripts/e2e.mjs                # everything, end to end, offline
```
