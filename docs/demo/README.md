# SurroundFold walkthrough

[Watch the video](surroundfold.mp4) · [Animated preview](surroundfold.gif) ·
[Still image](surroundfold.png)

The 35-second walkthrough shows Tailnet Agents starting a SurroundFold job on a media
server, leaving its terminal open, and finding the resulting activity in Memory.
It uses the actual built React interface, Ghostty terminal renderer, streaming
chat, activity animations, and graph viewer.

The episode **Orbital**, devices, conversation, terminal output, graph records,
and embedding vectors are synthetic. The commands and text progress format
follow SurroundFold's CLI. Playback starts a separate-output binaural render;
it ends while the render is still underway. It does not demonstrate a completed
media conversion or make claims about rendering speed.

## Replay locally

After the normal project setup and frontend build:

```sh
npm run demo
```

Open **http://127.0.0.1:4325/demo**. The walkthrough starts automatically.
**Replay** restarts the scene; the chapter buttons open the memory graph and
source run. You can inspect nodes, follow relationships, and search the sample
archive. Search in this fixture uses text matching; no embedding API is called.

To build only what the demo needs from a fresh checkout:

```sh
./scripts/setup.sh
npm --prefix web run build
npm run demo
```

The demo binds to loopback on a separate port. It does not read `.env`, open
the personal Vecgra database, contact SSH hosts, execute commands, or invoke
Codex. Terminal input is ignored. Creating sessions, sending messages, and other
workspace mutations are unavailable. The production server can continue running
alongside it. Stop the demo with **Ctrl+C**.

Override the port with `npm run demo -- --port 4326`.

## Updating the recording

The story and synthetic API are in [`scripts/demo.py`](../../scripts/demo.py).
The small chapter player is [`index.html`](index.html). They are kept outside
the production frontend; there is no demo switch or fixture data in the app
bundle.

The current recording captures the 1280 × 720 browser viewport at 24 frames per
second. It has four consecutive shots: the workflow (22 seconds), the memory
overview (5 seconds), a selected result (4 seconds), and its source run
(4 seconds). The GIF uses 12 frames per second for a smaller README asset.

When re-recording, use this isolated demo origin and keep the synthetic-data
label visible. Do not record the personal workspace. Replace the MP4, GIF,
and PNG together, and check both the terminal text and the chapter transitions.
