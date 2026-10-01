# Turn it on

Everything below was built and checked overnight on 30 Sep 2026. The offline demo and the
end-to-end test run with no secrets; the real pieces need your accounts.

## 1. Try the demo (5 minutes, no keys)

Needs Rust (rustup; the toolchain pins itself) and Node 22.

```sh
./scripts/setup.sh
./scripts/demo.sh            # http://127.0.0.1:4400
```

Type into the Desk's composer (or press C):
- `cancel my polyform sub`: watch the live browser, then scrub the replay
- `book me the train to edinburgh and pay for it`: approve £142.40 in the "needs you" strip
- `install blender on my machine`: answer the question; the install lands on the persistent machine
- `remember that …`, `what do you know about polyform`, ⌘K to search everything

Polyform and Northline Rail are fictional sites served by the machine itself.

## 2. Make it yours

`cp .env.example .env`, then:

1. **Coordinator and executor on your Claude subscription.** Have Claude Code installed and logged
   in (`claude auth login`) as the user that runs Familiar. That's it: with `claude` on PATH the
   coordinator uses it through MCP, and tasks run Claude Code on the machine. For Codex tasks,
   `codex login` too, then say "use codex" in a message.
2. **OpenRouter key** (in craig_v6's `.env`): set `OPENROUTER_API_KEY`. That switches memory to
   `google/gemini-embedding-2` (existing memory re-embeds automatically), and turns on voice-note
   transcription and fact extraction after each task.
3. **Telegram:** create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`. Message the bot once;
   it replies with your user id. Put that in `TELEGRAM_ALLOWED_USERS` and restart.
4. `./scripts/start.sh`

## 3. Log in to sites once

Your machine's Chrome profile persists (`data/machines/errands/home` with the local backend).
Message "open meshy.ai and wait while I log in", then press **Take control** (T) on that run,
log in inside the live view, and release. Every later run on that machine, and every fork of it,
is signed in.

## 4. Where to run it

- **Now:** your Mac or the home server. The local backend runs the machine as a process with
  headless Chrome; you watch it through the live view.
- **With a full desktop:** build the image (`docker build -f image/Dockerfile -t familiar-machine:latest .`)
  and set `FAMILIAR_MACHINE_BACKEND=docker`. The Desktop tab then shows the machine's whole
  screen through noVNC. Installs live in the `familiar-errands-home` volume and survive rebuilds.
- **From your phone (tailnet only, not public):** on the host run
  `tailscale serve --bg --http=4400 http://127.0.0.1:4400`, then open `http://<machine>:4400` from
  any of your devices (or `--https=4400` for `https://<machine>.<tailnet>.ts.net:4400`, which the
  Desk needs to install as an app). The setting survives restarts and reboots. Set
  `FAMILIAR_TAILSCALE_USERS` to your Tailscale login so only you get in, with no token to type, and
  `FAMILIAR_PUBLIC_URL` to the URL (Telegram gets "Watch live" buttons). Or set `FAMILIAR_TOKEN` and
  open `/?token=…` once per device.
- **Cloudflare runners:** `cloudflare/` has the Worker. It needs an account: `npm i`,
  `npx wrangler r2 bucket create familiar-machines`, `npx wrangler secret put RUNNER_TOKEN`,
  `npx wrangler deploy`, then set `FAMILIAR_MACHINE_BACKEND=cloudflare`, `FAMILIAR_CF_WORKER_URL`,
  `FAMILIAR_CF_TOKEN` and a `wss://` `FAMILIAR_PUBLIC_WS_URL` the sandbox can reach.
- **Your own box over Tailscale:** install agentd there (`machine/`, `npm ci && npm run build`) and
  set `FAMILIAR_MACHINE_BACKEND=ssh`, `FAMILIAR_SSH_HOST`, `FAMILIAR_PUBLIC_WS_URL`.

## What's verified and what isn't

Verified here:
- `node scripts/e2e.mjs` passes, using a fake Telegram, the real server, a real agentd and real
  Chromium. It covers memory from Telegram, an errand with receipt, replay, a self-editing status
  message and a photo, an approval over £100 by Telegram button, a question answered on the web,
  the terminal log, installs, backups, search, take control, cancel, and a restart with nothing lost.
- A real Claude Code run did the Polyform cancel end to end in 32 s. It used the browser tool,
  wrote a procedure and a claim to memory, and saved a receipt.
- The coordinator on Claude Code (MCP tools) remembered a fact with a stable key and answered from
  memory.
- The Docker machine: live desktop over noVNC, and an install that survived recreating the container.
- `cargo test`, `cd machine && npm test` (16/16), `cd web && npm run typecheck`.

Not verified (no account or key here):
- The **Cloudflare Worker** is written against the Sandbox SDK but never deployed.
- **gemini-embedding-2 image input:** the request shape is OpenAI-compatible and unconfirmed. If
  OpenRouter rejects it, keyframes fall back to embedding their caption; check the server log for
  "image embedding failed".
- The OpenRouter model ids `anthropic/claude-opus-5.5` and `google/gemini-3.8-flash` (voice).
  Both can be changed in `.env`.
- **Codex as executor:** flags were checked against the CLI, but it hasn't done a real run.
- **Real Telegram:** only the fake Bot API was tested; the calls are standard Bot API.

Known gaps for v1.1:
- Vecgra doesn't stream commits to R2 yet, so the coordinator needs a machine with a disk (see the
  spec).
- There's no continuous video. Replay is ~1 fps frames plus a keyframe for every browser action.
- The Desktop tab is noVNC in an iframe. It's view and control, but it isn't WebRTC.
- A fork's changes are thrown away. Installs and logins always wait for the personal machine
  instead of running on a fork.
