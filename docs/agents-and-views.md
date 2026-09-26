# Agents, views and notifications

Start a session with the **+** button and choose Coordinator, Codex, Copilot or Claude. Coordinator conversations offer Codex or Claude as their backend. A native session runs on the selected device, in the selected project directory, using that device’s existing agent installation and sign-in. The picker checks availability over the same short SSH target used by terminals. It does not install software.

The coordinator can also delegate naturally: “Use Codex on desktop to work on my game.” It has `start_agent`, `list_agents`, `read_agent`, `send_agent` and `stop_agent`. Delegated sessions appear in the sidebar and link from their tool result in the parent chat. Each retains its own conversation and terminal ownership. Stopping a turn preserves its provider session for the next message; closing the app’s session also closes its linked terminal.

Codex uses its [native app-server protocol](https://developers.openai.com/codex/app-server), including streaming messages, tool events and persisted thread IDs. Copilot uses [ACP over stdio](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server). Remote Copilot requires SSH reverse forwarding to loopback for workspace tools. The bridge token is scoped to that conversation and revoked when the turn ends. No workspace-wide token is sent to a remote device. Copilot needs an ACP release advertising session loading and HTTP MCP support.

Claude uses the official Agent SDK over the selected device's authenticated CLI, with SSH stdio and a loopback reverse forward for remote workspace tools. It defaults to Opus 5.5 at medium effort and requires Claude Code 2.1.280 or later for that model. See [Claude setup](../README.md#claude-sessions). Native sessions cannot delegate regardless of provider; that capability belongs to the coordinator role.

These adapters create and resume sessions started in Tailnet Agents. Importing arbitrary sessions previously started in other clients is not part of this release. The current transport expects a POSIX SSH shell on remote machines; native Windows shells need a separate transport adapter.

When a workspace SSH tool encounters a [Tailscale SSH check](https://tailscale.com/docs/features/tailscale-ssh#configure-tailscale-ssh-with-check-mode), it displays **Sign in with Tailscale** in the conversation. Complete that sign-in yourself; the original connection waits for up to 15 minutes and continues automatically after approval. Cancel, Stop, or closing the session cancels the attempt. Other sessions remain usable. The coordinator treats this as reauthentication, not an offline device or a reason to try another SSH route. Background probes do not open sign-in prompts; initiate the operation from a conversation when authentication is needed.

## Custom views in chat

Any agent can call `show_ui`; the coordinator, Codex, Copilot and Claude share the same contract. A view can be a progress display, comparison, diagram, interactive form, timeline or another task-specific interface. It is saved in Vecgra alongside the conversation and restored when you return.

```json
{
  "view_id": "job",
  "title": "Build progress",
  "html": "<strong id='progress'></strong>",
  "css": "strong { color: var(--accent); font-size: 32px; }",
  "script": "tailnet.onData(d => document.getElementById('progress').textContent = d.progress + '%')",
  "data": { "progress": 40 },
  "actions": [
    { "id": "inspect", "label": "Inspect output", "prompt": "Inspect the current build output." }
  ]
}
```

Update the same view with just `{ "view_id": "job", "data": { "progress": 85 } }`. Data updates preserve the existing document and its local state. Code changes replace its document. Expanding a view keeps the same iframe.

The document receives `window.tailnet`:

- `data`: the latest supplied JSON.
- `onData(callback)`: immediately calls back with current data, then on updates; returns an unsubscribe function.
- `action(id, data)`: asks the host to run one of the declared actions. It displays an explicit **Run action** control outside the generated document. Clicking that control sends the declared instruction and selected data to this session’s agent. Stale revisions and unknown actions are rejected.

Views run in opaque-origin iframes with scripts enabled, without same-origin access, popups, forms or top-level navigation. CSP blocks fetches, external scripts and ordinary external media loads. They cannot access the parent’s DOM, cookies or authenticated API. This is an application isolation boundary, not a promise that browser-hosted untrusted JavaScript can never consume excessive resources or navigate its own frame.

Views are **instruments inside the app**, not separately branded websites. The host supplies the same theme tokens and embedded Chakra Petch, Oxanium and IBM Plex Mono fonts as the surrounding interface. Buttons, fields, headings, tables and progress bars are styled automatically. Do not reset `body`/`:root`, invent a palette, or add a wordmark, navigation, landing-page hero, gradients or large decorative padding. Custom CSS should describe the task's layout and graphics. An explicit user request for a different visual treatment takes precedence.

Use these supplied primitives:

| Class | Purpose |
| --- | --- |
| `tn-stack` | Vertical layout with a 16px gap |
| `tn-row`, `tn-toolbar` | Wrapping rows; row distributes items, toolbar groups controls |
| `tn-grid` | Responsive columns that collapse on narrow screens |
| `tn-panel` | Flat graphite surface with a fine border |
| `tn-label`, `tn-muted`, `tn-mono` | Technical label, secondary text, monospace text |
| `tn-readout` | Oxanium numeric readout with tabular figures |
| `tn-primary` | Copper-accented button |
| `tn-status` | Compact status; `data-state="working"` or `"done"` selects semantic colour |

Theme variables are `--background`, `--surface`, `--raised`, `--border`, `--text`, `--muted`, `--accent` and `--green`; `--display` and `--mono` are font stacks. Use the same tokens for SVG/canvas colours (read them with `getComputedStyle(document.documentElement)` when drawing). Start with useful content and controls, typically within 200–400px, and check phone widths. HTML, SVG and canvas remain available for bespoke diagrams, charts and interactions.

Use crisp copper dithering where it communicates activity. Animate with `requestAnimationFrame`; stop when idle or hidden and respect reduced motion. See [the asset-pipeline example](examples/job-view.json) for a complete reusable view. The kit is a design contract, not a CSS sanitizer: arbitrary view code still runs inside the existing sandbox.


Limits: HTML 128 KB, CSS and JavaScript 64 KB each, data 128 KB, up to 12 actions. Action data is limited to 16 KB. The host displays action data as untrusted content to the receiving agent.

## Memory

All agents can search shared memory with `search_memory` and inspect the source via `read_memory_run` using a returned run ID. Native tool activity, input requests, answers, views and actions remain in the same event history. Private push subscriptions and bridge credentials are kept out of that history.

## Phone notifications

Open the sidebar’s **Notifications** control in the HTTPS app, enable notifications on that device, then send a test. On iOS/iPadOS, first install the app to the Home Screen. Browser permission must be granted on the phone itself.

Completion, failure and input requests can trigger push. A browser actively watching that session is suppressed independently of other subscribed devices. Tapping opens the exact conversation. Notifications contain a generic status, not command output or messages.

Web Push uses the browser’s push service, so it can arrive when the app is closed. The server needs outbound HTTPS to that service. Tailscale is still needed to open the private app. Supported endpoints include Google FCM, Mozilla, Apple and Windows push services.

VAPID keys, subscriptions and a bounded retry queue live in `data/push.json` with owner-only permissions. Keep this file with private runtime data when moving the server. Expired subscriptions are removed; transient delivery failures retry with backoff. A process crash immediately after delivery can cause a repeat attempt; notification tags replace the previous notification for the same session.

## Validation

`npm run check` includes protocol fixtures, native-session/API lifecycle checks, view isolation/action tests, actual Web Push encryption/decryption, and notification deep-link tests. `HUB_LIVE_CODEX_TEST=1 agent/.venv/bin/python scripts/agent-features-smoke.py` additionally runs a disposable native Codex session, creates a view, and verifies context survives resuming.

For a generation-to-render design check, run `HUB_UI_REVIEW_DIR=/tmp/tailnet-ui-review agent/.venv/bin/python scripts/agent-features-smoke.py`. This asks a real coordinator for a focus timer without styling hints and saves the actual result for desktop/mobile browser inspection. It does not claim that successful generation alone is a visual pass.
