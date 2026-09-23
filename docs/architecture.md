# Architecture

Tailnet Agents runs on one host and connects to other devices through SSH. The browser is
a viewer and controller; persistent work belongs to the server and tmux.

| Layer                     | Role                                                           |
| ------------------------- | -------------------------------------------------------------- |
| React + TypeScript + Vite | Chat, devices, terminals, memory, and mobile PWA               |
| TanStack Router / Query   | Navigation and browser state                                   |
| Rust + Axum               | HTTP API, WebSockets, action execution, and terminal ownership |
| Codex Python SDK          | Coordinator with the host's Codex login and native tools       |
| Vecgra                    | Durable event graph, text index, and semantic memory           |
| tmux + SSH                | Persistent shells on local and remote devices                  |
| Ghostty WASM              | Terminal emulation through ghostty-web; Canvas 2D rendering    |
| Rust + wgpu               | Browser WebGPU activity instruments, with Canvas 2D fallback   |

## Sessions and terminals

Each conversation owns at most one open terminal. Repeated opens reuse it;
selecting a conversation selects its terminal. Agent list/read/input operations
are scoped to that owner. A different device requires a new conversation or an
SSH connection from the existing shell.

Closing a conversation stops its agent and terminal. If a remote shutdown
fails, the conversation remains open with a retry action. History remains in
Vecgra, and reopening it does not restart the shell. A close interrupted by a
Tailnet Agents restart resumes on startup. Legacy extra or standalone terminals receive
their own conversations during migration without stopping their shells.

The most recently opened or focused viewer controls terminal dimensions. Older
viewers follow that grid; automatic reconnects do not claim it. Each viewer can
read a private, colored snapshot of up to 10,000 scrollback lines while output
continues. Watching does not send input or enter shared tmux copy mode.

## Agent and event flow

The coordinator keeps Codex's native tools and instructions, enables live web
search, and adds Tailnet Agents’ device, terminal, memory, and image tools. Skills, apps,
and MCP integrations come from the host's Codex configuration and depend on
authentication and runtime support. Native shell and file tools run on the Tailnet Agents
host, with `data/workspace/` as the persistent starting directory.

The worker uses the SDK's low-level client to request raw tool receipts.
Assistant text, tool starts, output deltas, and completed results stream to Rust
and are committed to Vecgra. Raw tool-call receipts preserve output that may
be absent from command events; raw messages and reasoning are ignored.

Tailnet Agents tool requests are structured decisions executed by Rust. During generation,
only the user-facing text field enters the visible reply. Final messages
reconcile the streamed draft by identity, and stale HTTP snapshots cannot
overwrite newer WebSocket chunks. Completed messages are indexed for search.

Actions appear in the conversation with commands, output, diffs, web sources,
and full receipts. The host enforces terminal input ownership. Cancelling an
agent stops its process group; terminal processes belong to tmux separately.
The coordinator runs with host filesystem/network access and Codex's automatic
approval review, so use an account and host appropriate for that access.

## Images

Native image tool blocks appear inline. `show_image` can publish a local or SSH
file using its path, optional device ID, and caption. Images are validated,
copied into `data/artifacts/`, and served through the authenticated API using
opaque IDs. PNG, JPEG, GIF, and WebP are supported up to 25 MB / 64 megapixels.
Copies remain available when the source is removed or its device disconnects.

## Persistence

- `data/history.vg` holds events, scope relationships, ordering edges, tool
  receipts, terminal output, and embedding vectors.
- `data/artifacts/` holds content-addressed image originals. Source paths,
  dimensions, captions, and device provenance are recorded in their events.
- `data/workspace/` is the coordinator's persistent host working directory.
- Each shell host spools output to
  `~/.local/state/hub/terminals/<session-id>.log`. An importer records byte
  offsets in Vecgra and catches up after a disconnect.
- `tmux -L hub` owns shells independently of browsers and Tailnet Agents restarts. A device
  reboot ends those processes; retained logs are not a running shell.

`HUB_DATA_DIR` relocates the private directory. Vecgra commits transactions
synchronously; embedding requests are asynchronous. Exact text retrieval remains
available during indexing and provider outages. No automatic retention
or encryption at rest is implemented. See [backups](self-hosting.md#data-and-backups).

The Vecgra engine is vendored from source revision
`01ef6843c6b9bcba7a38e7560b616e3376bbe229`, under its
[original license](../vendor/vecgra/LICENSE), so Tailnet Agents builds independently of a
sibling checkout.

## Embeddings

A Rust HTTP client calls [OpenRouter's embeddings endpoint](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request)
with [Qwen3-Embedding-8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B). Both indexing and queries use 384 dimensions, preserving
the existing database schema. Query text uses the same retrieval instruction as
Vecgra's Qwen adapter; indexed documents do not receive that prefix.

The endpoint, model, dimensions, and query instruction are recorded in an
`EmbeddingConfig` node. Before changing profiles, Tailnet Agents makes a compact snapshot
beside `history.vg`, then atomically removes incompatible vectors and updates
the marker. IDs, event payloads, graph edges, and attachments are retained.
Only events missing vectors are reindexed, so partial work survives a restart.
Old MiniLM vectors are never searched with Qwen queries.

Indexing deduplicates text within bounded batches and commits each batch in one
transaction. Query embeddings use a separate request path and a 64-entry cache;
they do not wait behind background batches. Browser searches return text
matches after a 150 ms budget, then refresh while Qwen finishes. Each query has
one shared provider request, even if a browser disconnects or its wait expires.
At most eight distinct queries run concurrently, each with a 15-second deadline.
Completed vectors are cached; failures are briefly cached to avoid retry storms.
Agent memory searches await that same result instead of returning early. Retries are bounded and restricted to transport failures, rate
limits, timeouts, and server errors. Response ordering, model identity, vector
sizes, and values are validated before storage. Provider error bodies and API
keys are not written to event logs.

The API exposes `embedding_model`, `embedding_dimensions`, and
`embedding_status` (`indexing`, `ready`, or `unavailable`, after startup).
Remote embeddings require `OPENROUTER_API_KEY`; there is no fallback to a
different embedding model. Indexed text and queries leave the host for
OpenRouter. The database and exact text search remain local.

## Memory graph

Memory exposes Vecgra's nodes, directed relationships, event properties, and
embeddings. Network layout groups related contexts; Sequence follows stored
`NEXT` links. Layout runs in a worker and transitions between arrangements are
animated. Pixel traces indicate relationship direction, not agent activity.

Graph fetches are bounded to 156 overview nodes or 100 events per scope page;
results and history are paginated. Text search uses a rebuildable trigram index,
with Qwen semantic matches when embeddings are available. Results open their
source conversation without restarting its work. Selection and search can be
deep-linked. The server currently keeps its event index in memory, so very large
archives still need more bounded projections.

## Rendering and mobile

The terminal uses ghostty-web 0.4.0: Ghostty's terminal core compiled to WASM,
with Canvas 2D rendering. It does not embed Ghostty's native Metal renderer.
The runtime loads when the first terminal opens. IBM Plex Mono is paired with
a self-hosted Nerd Fonts Symbols Mono fallback.

Activity graphics use Rust/wgpu 30 compiled to WASM. Six ordered-dither
instruments represent searches, commands, edits, connections, memory, and
thinking. Matching Canvas 2D effects work over ordinary HTTP. Both render at
the browser's display cadence, pause when hidden or offscreen, and respect
reduced motion. Idle conversations allocate no animation surface.

Controls and text remain HTML. Oxanium, Chakra Petch, and IBM Plex Mono are
self-hosted, alongside the pixel mark and hardware artwork. Mobile uses bottom
navigation, separate chat/terminal views, keyboard-aware sizing, and a terminal
touch-key strip. The PWA service worker caches only an offline connection screen.

## Current scope

Installed agents can run in terminals. Native ACP adapters, agent bootstrap,
and richer remote-device capabilities remain future work. There is no Tailnet Agents
endpoint daemon to install on each device.

WebMCP-capable browsers can optionally expose workspace-read and terminal-open
tools through the same authenticated API; other browsers ignore registration.
