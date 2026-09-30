# Contract notes (web Desk ↔ familiar-server)

The Desk implements `docs/protocol.md` as written. Everything below is either a
place where the UI is deliberately tolerant, or a small proposed addition. None
of them block the UI: without the additions it degrades gracefully.

## Proposed additions

1. **Planned steps: `step.state = "pending"`.**
   The Steps panel shows done / active / pending. The contract only has
   `active|done|failed`, so the plan ahead is invisible. Proposal: the agent may
   emit `{kind:"step", state:"pending", step_id, text}` for planned steps; a later
   event with the same `step_id` makes it active/done. The UI orders steps by when
   they first became non-pending, then lists still-pending ones. Without this,
   only started steps show (plus "of ~N" from `steps_estimate`).

2. **`memory.write.status: "queued" | "written"`.**
   The Memory panel distinguishes writes queued until the run finishes from
   writes already saved. If absent, the UI treats the write as written.

3. **Held approvals: `NeedsYou.state: "held"`.**
   When Ryan presses Hold, the run keeps waiting. The mock re-issues the NeedsYou
   item with title `Held: £142.40 to LNER` and options `Approve now` / `Cancel run`
   (answer ids `approve` / `cancel`). The UI currently detects "held" from the
   title prefix `Held` (fragile); an explicit `state` field would be better.

4. **Search results carry `ms`.**
   For `event` and `keyframe` results the UI needs the offset into the run to jump
   the replay there. It computes `at - task.started_at` today; an explicit `ms`
   would be exact.

5. **Start a stopped machine.**
   The Machines view has Start on sleeping/offline machines. It sends
   `POST /api/machines {backend, id}` (id of the existing machine). Suggest either
   honouring `id` there or adding `POST /api/machines/:id/start`.

6. **A cancelled run's timeline event.**
   There is no `cancelled` event kind. The mock emits a `machine` event
   ("Cancelled by you…") and sets `status:"cancelled"`. Either is fine for the UI;
   a dedicated kind would read better in the action log.

## Added since

- **`plan` events.** `{kind:"plan", steps:[…], after:N}` lists the steps the agent
  expects after step N (the executor's `step` tool takes an optional `next`). The
  Steps panel shows the latest plan's remaining items as pending. This replaces
  proposal 1 above.
- **`keyframe.action`.** What just happened, in words ("Clicked “Billing”"). The
  filmstrip labels keyframes with it, falling back to the step at that moment.

## Behaviour the UI relies on

- **Artifact auth by cookie.** `<img src="/api/artifacts/:id">` cannot send a
  bearer header, so `/api/artifacts/*` (and `/frames`, `/terminal`) must accept the
  `familiar_token` cookie. The UI stores the cookie from `/?token=…` and strips the
  token from the URL. WebSocket passes `?token=`.
- **Free-text answers.** When a question has `allow_text` and Ryan types instead of
  pressing an option, the UI posts `{question_id, answer:"text", text}`.
- **Answer label.** Echo the chosen option's `label` in the `answer` event so the
  log reads "answer · 4.5 LTS · you".
- **`task` upserts while running** (every ~2 s is plenty) keep elapsed, tokens and
  the per-run token sparkline moving. Tokens are sparklined client-side from
  successive `task.tokens` values.
- **Frames.** `frame` at full rate for the subscribed task and ~1 fps for others;
  tiles fall back to `last_frame_artifact`. The live view maps pointer positions to
  frame pixels using the frame's natural `w`×`h`, so `input.mouse.x/y` are in the
  same pixel space as the JPEG.
- **Replay.** `GET /tasks/:id/frames` sorted by `ms` ascending. The UI prefers a
  keyframe when the cursor is within 1.5 s of it, else the nearest earlier replay
  frame.
- **Tool completion.** A later `tool` event with the same `call_id` replaces
  `result`, `duration_ms`, `status`; `status:"error"` renders red. A pending call
  shows as "running…" and drives the NOW sub-line and the status bar under the
  live view.
- **Assistant message → run.** When the coordinator starts a run in reply to a web
  message, set the reply's `task_id`; the Desk then focuses that run.
- **`desktop_url`** is shown in an `<iframe>`, so it must allow framing by the Desk
  origin (no `X-Frame-Options: DENY`, `frame-ancestors` permitting it).
- **Unknown values are fine.** `source`, `brief.channel`, `executor`, backend names
  and event kinds the UI does not know are shown as plain text or ignored.
- **Settings.** `PUT /settings` may send any subset of
  `{approval_threshold_p, default_executor, no_ask_merchants}`; the UI merges the
  returned object.
