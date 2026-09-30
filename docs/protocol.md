# Familiar protocol

Three processes talk to each other:

```
 Telegram ──┐
            ├── familiar-server (Rust, :4400) ── vecgra memory.vg (single writer)
 Web Desk ──┘        ▲  REST + WS /api/stream
                     │
                     └── WS /api/machines/connect  ◄── agentd (Node, inside each machine)
                                                        Chrome · PTY terminal · executor (claude | codex | scripted)
```

All JSON. Times are RFC 3339 strings (`at`) plus, for timeline events, `ms` = milliseconds since the task started.
Money is always GBP pence as an integer (`spend_p`, `amount_p`) to avoid float drift; the UI formats it.

## Shared objects

### Task
```json
{
  "id": "t_01J…", "num": 214, "title": "Cancel my Meshy sub", "brief": "cancel my meshy sub",
  "status": "queued|starting|running|waiting|done|failed|cancelled",
  "executor": "claude|codex|scripted", "machine_id": "m_errands", "source": "telegram|web|schedule",
  "created_at": "…", "started_at": "…|null", "ended_at": "…|null",
  "now": "Confirm, then verify the plan now ends 14 Oct",      // current intent line
  "waiting_for": "text \"cancelled\"" ,                          // optional, short
  "step": 8, "steps_estimate": 12,
  "spend_p": 0, "tokens": 38000, "time_cap_s": 3600,
  "control": null,                    // or "you" while the user holds the control lock
  "outcome": "success|partial|failed|null", "summary": "…|null",
  "receipt_artifact": "a_…|null",     // screenshot proving the outcome
  "last_frame_artifact": "a_…|null"   // latest keyframe for tiles when not live
}
```

### Event (timeline)
```json
{ "id": 1042, "task_id": "t_…", "at": "…", "ms": 66000,
  "actor": "you|memory|machine|agent|browser",
  "kind": "…", "…kind specific fields…" }
```
Kinds:
| kind | fields | actor |
|---|---|---|
| `brief` | `text`, `channel` | you |
| `step` | `text`, `state: active|done|failed` (a later `step` event with the same `step_id` updates it), `step_id` | agent |
| `tool` | `tool` (e.g. `browser.click`, `shell`, `memory.search`), `target`, `result`, `duration_ms`, `status: ok|error|pending`, `call_id` (a later event with the same `call_id` completes it) | browser / machine / memory |
| `keyframe` | `artifact` (id), `url`, `title` | browser |
| `memory.recall` | `query`, `hits: [{id, score, text, kind, source}]` | memory |
| `memory.write` | `op: add|supersede|forget`, `text`, `claim_kind`, `claim_id` | memory |
| `ask` | `question_id`, `question`, `options: [{id,label}]` | agent |
| `approval` | `question_id`, `amount_p`, `merchant`, `description`, `auto: bool` (auto-approved under threshold) | agent |
| `answer` | `question_id`, `answer`, `label`, `by: you|auto` | you |
| `control` | `state: taken|released`, `note` | you |
| `message` | `text` (agent → user message mid-task) | agent |
| `machine` | `text` (restore, checkpoint, backup, fork) | machine |
| `done` | `outcome`, `summary`, `receipt_artifact` | agent |
| `failed` | `error` | machine |

Terminal bytes are NOT timeline events; they are kept per task as a raw log (see `/api/tasks/:id/terminal`).

### NeedsYou
```json
{ "id": "q_…", "task_id": "t_…", "task_num": 4, "task_title": "LNER train",
  "kind": "approval|question",
  "title": "Pay £142.40 to LNER", "detail": "£42.40 over your £100 line · London Kings Cross → Edinburgh",
  "options": [{"id":"approve","label":"Approve","style":"primary"},{"id":"hold","label":"Hold"},{"id":"approve_always","label":"Approve and never ask for LNER","style":"quiet"}],
  "allow_text": false, "created_at": "…" }
```
Questions have their own options and `allow_text: true`.

### Machine
```json
{ "id": "m_errands", "name": "errands", "backend": "local|docker|cloudflare|ssh",
  "status": "online|busy|offline|sleeping", "parent": null,            // parent machine id for forks
  "specs": {"cpu": 4, "mem_gb": 12, "disk_gb": 20},
  "stats": {"cpu_pct": 38, "mem_gb": 5.1, "net_mbs": 2.4, "uptime_s": 68},
  "task_id": "t_…|null", "has_desktop": false, "desktop_url": null,
  "last_backup_at": "…|null", "installs": ["blender 4.5 (/opt/blender)"] }
```

### Message (conversation with the coordinator)
```json
{ "id": "msg_…", "role": "user|assistant", "text": "…", "channel": "telegram|web", "task_id": null, "at": "…" }
```

### Claim (memory)
```json
{ "id": 812, "kind": "fact|preference|rule|procedure|account|subscription|person|episode",
  "text": "Pro plan £16/mo on Visa 4242", "subject": "meshy",
  "confidence": 0.9, "salience": 0.6, "state": "active|superseded|disputed|forgotten",
  "source": {"task_id": "t_…", "message_id": "msg_…", "label": "Ryan, 3 Sep"},
  "created_at": "…", "superseded_by": null }
```

## REST (server, prefix `/api`)
Auth: if `FAMILIAR_TOKEN` is set, every request needs `Authorization: Bearer <token>` or cookie `familiar_token` (the UI stores it after `/?token=…`). Loopback without a token is open.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/state` | | `{tasks, machines, needs_you, messages (last 50), stats, settings}` |
| GET | `/tasks/:id` | | `{task, events}` |
| GET | `/tasks/:id/terminal` | | raw terminal bytes (text/plain) |
| GET | `/tasks/:id/frames` | | `[{ms, artifact}]` replay frames (≈1 fps while running) |
| GET | `/artifacts/:id` | | image bytes (jpeg/png) |
| POST | `/messages` | `{text, executor?}` | `{message}`; the reply arrives on the stream |
| POST | `/answer` | `{question_id, answer, text?}` | `{ok}` |
| POST | `/tasks` | `{brief, executor?}` | `{task}` (skip the coordinator, start directly) |
| POST | `/tasks/:id/cancel` | | `{task}` |
| POST | `/tasks/:id/control` | `{action: "take"|"release", note?}` | `{task}` |
| POST | `/kill` | | `{cancelled, machines_stopped}` |
| GET | `/memory` | `q?, kind?, state?` | `{claims, stats: {nodes, edges, vectors, claims}}` |
| GET | `/memory/:id` | | `{claim, evidence: [Event|Message], history: [Claim]}` ("why") |
| POST | `/memory/:id/forget` | | `{claim}` |
| POST | `/memory/:id/correct` | `{text}` | `{claim}` (new claim superseding the old) |
| GET | `/search` | `q` | `{results: [{type: "task|event|claim|message|keyframe", id, task_id?, text, score, at, artifact?}]}` |
| POST | `/machines/:id/backup` | | `{machine}` |
| POST | `/machines/:id/stop` | | `{machine}` |
| POST | `/machines` | `{backend?, fork_of?}` | `{machine}` (start one) |
| GET/PUT | `/settings` | `{approval_threshold_p, default_executor, no_ask_merchants[]}` | settings |

`stats` = `{spend_today_p, tokens_today, memory_nodes, runs_today, runs_done_today, working, waiting}`.
`settings` also carries read-only status: `{coordinator: "openrouter:<model>|mock", embedder: "gemini-embedding-2|hash", telegram: "polling|off", backends: [...]}`.

## Stream: `GET /api/stream` (WebSocket)

Server → client:
- `{type:"hello", state}` (same as `/state`)
- `{type:"task", task}` — upsert
- `{type:"event", event}`
- `{type:"machine", machine}` — upsert
- `{type:"needs_you", items}` — full list each time
- `{type:"message", message}`
- `{type:"typing", on: bool}` — coordinator is thinking
- `{type:"frame", task_id, machine_id, data, w, h}` — base64 JPEG of the live browser. Full rate for the subscribed task, ~1 fps for the rest (tiles).
- `{type:"terminal", task_id, data}` — raw terminal bytes (utf-8 text, may contain ANSI) for the subscribed task only
- `{type:"stats", stats}`

Client → server:
- `{type:"subscribe", task_id}` — the focused task
- `{type:"input", task_id, input}` — only honoured while the user holds control. `input` is one of
  - `{kind:"mouse", action:"move|down|up|click|wheel", x, y, button?, dx?, dy?}` (x,y in frame pixels)
  - `{kind:"key", action:"press|type", key?, text?}`
  - `{kind:"terminal", data}` (terminal keystrokes)
  - `{kind:"navigate", url}`

## Machine protocol: `GET /api/machines/connect?token=<MACHINE_TOKEN>&id=<machine id>` (WebSocket)

agentd dials out, so the same protocol works for local processes, Docker, Cloudflare sandboxes and boxes on the tailnet.

agentd → server:
- `{type:"hello", id, name, backend, specs, has_desktop, desktop_url, executors: ["claude","codex","scripted"], version}`
- `{type:"event", task_id, event}` — `event` is an Event without `id/task_id/at/ms` (the server stamps them). Keyframes carry `image` (base64 jpeg) instead of `artifact`; the server stores it and replaces it with an artifact id.
- `{type:"frame", task_id, data, w, h}` — screencast frame
- `{type:"terminal", task_id, data}`
- `{type:"task.update", task_id, now?, waiting_for?, step?, steps_estimate?, tokens?}`
- `{type:"task.done", task_id, outcome, summary, receipt_image?}`
- `{type:"task.failed", task_id, error}`
- `{type:"ask", task_id, question_id, question, options, allow_text}` → waits for `answer`
- `{type:"approval", task_id, question_id, amount_p, merchant, description}` → waits for `answer` (server may answer immediately when under threshold)
- `{type:"memory", req_id, op:"search|note|packet", query?, text?, kind?, subject?}` → `memory.result`
- `{type:"stats", stats}`
- `{type:"installs", installs: [..]}`

server → agentd:
- `{type:"task.start", task_id, brief, executor, context: {memory: [..claims..], procedures: [..]}, time_cap_s}`
- `{type:"task.cancel", task_id}`
- `{type:"answer", question_id, answer, label, text?}`
- `{type:"memory.result", req_id, ok, result}`
- `{type:"control", task_id, state: "taken|released", note?}` — while taken the executor pauses at its next tool call
- `{type:"input", task_id, input}` — as in the stream
- `{type:"subscribe", task_id, rate: "full|tile"}` — frame rate hint
- `{type:"backup"}` / `{type:"shutdown"}`

## Executor tools (MCP server `familiar`, provided by agentd to Claude Code / Codex)
`shell(command, timeout_s?)` runs in the visible terminal and returns output + exit code ·
`browser_navigate(url)` · `browser_snapshot()` (accessibility tree, refs) · `browser_click(ref|text)` ·
`browser_type(ref|text, value, submit?)` · `browser_press(key)` · `browser_wait_for(text, timeout_s?)` ·
`browser_screenshot()` · `memory_search(query)` · `memory_note(text, kind, subject)` ·
`ask_user(question, options[])` · `request_approval(amount_gbp, merchant, description)` ·
`step(text)` (intent line) · `finish(outcome, summary)` (takes the receipt screenshot).
