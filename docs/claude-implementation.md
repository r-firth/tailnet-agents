# Claude support handoff

Implemented September 26, 2026. This workspace has no `.git` metadata; changes
were made in place without resetting or replacing the existing checkout.

## Behavior

- Coordinator conversations persist `coordinator_provider` independently of
  device-bound `agent.provider`. Existing conversations default to Codex.
- The picker offers Codex/Claude coordinator backends and Codex/Copilot/Claude
  native sessions. Device discovery includes the user-installed `claude` CLI.
- Claude defaults to `claude-opus-5-5` at explicit `medium` effort. Each execution
  device needs Claude Code 2.1.280 or later; `HUB_CLAUDE_MODEL` can override the model.
- Claude uses the pinned official Agent SDK with the execution device's
  unmodified CLI. Remote CLI stdio travels over SSH; workspace MCP uses a
  loopback reverse forward and the existing scoped, short-lived token.
- Coordinator decisions retain the complete workspace tool loop, including
  delegation. Native sessions cannot start, follow up, or stop delegated agents;
  server restrictions and the MCP listing enforce this independently of provider.
- Saved native session IDs support follow-up/resume on the original device.
  Streaming text, structured coordinator text, tool receipts,
  user questions, cancellation/interrupt, and safe errors are handled.
- Subscription sign-in is checked through the CLI. API authentication environment
  variables are removed, no API fallback is configured, and `--bare` is not used.
  The adapter never reads credential files.

## Changed source files

- `.env.example`, `README.md`: Claude model option, setup, architecture, official
  references and operational limitations.
- `agent/claude_backend.py`: SDK transport, authentication preflight, receipts,
  permissions/input, structured loop, resume and interrupt.
- `agent/native.py`: shared SSH launcher accepts Claude's SDK-generated command.
- `agent/worker.py`: role-aware provider dispatch and truthful provider prompts.
- `agent/tools.json`: Claude delegation description.
- `agent/pyproject.toml`, `agent/uv.lock`: pinned SDK and JSON Schema validation.
- `agent/test_claude.py`: real SDK protocol fixtures, simulated SSH, routing,
  streaming, structured tools, resume, denial, questions, interrupt and safe errors.
- `crates/hub-server/src/conversations.rs`: persisted coordinator backend.
- `crates/hub-server/src/main.rs`: provider validation, remote auth preflight,
  graceful Claude cancellation and lifecycle regression tests.
- `crates/hub-server/src/agent_api.rs`: discovery and consistent restricted MCP list.
- `crates/hub-server/tests/native_sessions.rs`: persistence and role/provider tests.
- `web/src/api.ts`, `web/src/AgentFeatures.tsx`, `web/src/agent-features.css`:
  types, backend picker, native provider choice, labels and responsive layout.
- `web/src/agent-features.test.tsx`: distinct coordinator/native creation payloads.
- `scripts/agent-features-smoke.py`: isolated hub Claude delegation, remote
  Tailscale auth/cancellation, resume and server-side role restriction checks.
- `scripts/claude-smoke.py`: optional live coordinator/native/resume check.
- `docs/claude-implementation.md`: this handoff.

Project dependencies and frontend build artifacts were regenerated during checks.
No production release binary was built, and no running service was restarted.

## Verification

`npm run check` passed in full for this publication:

- Rust formatting and Clippy (`--workspace --all-targets --locked -D warnings`).
- Ruff lint/format, Prettier, Python compilation.
- Python: 30 tests; frontend: 69 tests across 12 files; PWA: 5 tests.
- Rust: 64 tests, including the terminal-close regression.
- Debug hub build, WASM release build, and production frontend build/typecheck.
- Isolated agent-features smoke, including Claude coordinator delegation, remote
  Tailscale sign-in/cancellation, scoped MCP restrictions, resume and revocation.
- Image delivery, discovery, terminal history, Ghostty rendering/geometry and
  Ghostty history integration checks.

Receipt reconciliation follow-up: adjacent text blocks now finalize once per text
run using the original streamed message ID. Text after a tool is held until its
receipt is available, preserving text/tool ordering. Structured JSON buffers and
indices reset at message and block boundaries. Five additional regression tests
cover the reported accumulated-stream reproduction, streamed and nonstreamed
multi-block ordering, successive structured messages, and stale block indices.
Python tests and Ruff lint/format were rerun for this focused change; no deployment
or service restart was performed.

Initial validation found two terminal lifecycle failures. Release validation
fixed recognition of tmux's already-absent target and waited for deferred shell
cleanup in the integration test. Both checks now pass. Missing WASM prerequisites
were installed under `/tmp` with an isolated Rust toolchain; machine-wide Rust
configuration was not changed.

The host's default Node 18 is too old for the existing frontend dependencies.
Checks used a temporary Node 22 installation under `/tmp`, without changing the
machine's Node installation or project manifests.

## Live test and remaining setup

The initial installed CLI was Claude Code 2.1.119. Initial live requests failed with an
invalid OAuth token. The user subsequently authorized a fresh subscription login
through the existing CLI's interactive `/login` flow. Login succeeded, and the
live `scripts/claude-smoke.py` check now passes: structured coordinator response,
native streamed response, and resumption of the same session with its remembered
marker. This verifies the local adapter against authenticated Claude inference;
a live remote session and the deployed hub/UI have not been verified.

The first authenticated run exposed duplicate coordinator text when another
assistant message sealed the structured output before its final result arrived.
The adapter now preserves the structured output's message identity across that
boundary, skips an identical already-sealed result, and applies corrected final
text to the same identity. A regression test and the SDK protocol fixture cover
this sequence; the live smoke script now asserts exactly one coordinator reply.
The corrected live rerun passed, as did all 30 Python tests and Ruff lint/format.

On Claude Code versions before 2.1.126, use `claude /login` and select the Claude
subscription option for manual code entry on a remote/headless machine. The
`claude auth login` command only gained pasted-code support in 2.1.126; the two
earlier login attempts here could not consume a pasted code. The installed CLI
is now 2.1.283 following user-approved update verification. Authenticate on each
intended execution machine as the OS user that
runs the CLI. Remote machines also require a registered SSH destination, an
absolute project path, and permission for loopback SSH reverse forwarding. They
do not require the Python SDK. Account-side subscription limits/billing remain
Anthropic's.

Deployment still requires the normal release build and an explicitly authorized
hub restart. Build prerequisites used for these checks are temporary; install
the documented prerequisites on the eventual build/deployment machine.
Claude defaults to `claude-opus-5-5` at explicit `medium` effort. Optional
`HUB_CLAUDE_MODEL` overrides the model; `HUB_MODEL` remains Codex-only.
See the README's Claude section for the official interface/auth references.

## GitHub publication follow-up

The user requested Opus 5.5 at medium effort and approved updating Claude. The CLI
update command confirmed version 2.1.283, and the live smoke check passed again
with `claude-opus-5-5` reported by all three sessions. Protocol fixtures assert
both the model and `--effort medium`; the smoke test checks the reported model.

GitHub's initial alpha predates the working checkout's native sessions, scoped
MCP, SSH-auth handling, views and notifications. The publication includes these
existing prerequisites alongside Claude support so the remote repository remains
buildable. No environment file, credential, runtime database, log or generated
build output is included. Source changes are staged in a separate Git checkout;
the original workspace and running service are preserved.

The release validation fixes recognize tmux's `no current target` response as an
already-absent terminal, and make the lifecycle smoke test wait for persisted
background cleanup to finish before asserting that tmux shells have exited.

## Permissions and tool UI follow-up

A deployed Claude coordinator confirmed `claude-opus-5-5`, but WebSearch was
rejected before an inline approval appeared. The pinned SDK sets
`permission_prompt_tool_name="stdio"` on an options copy that custom transports
never receive. The device transport now mirrors that setting on its own copy;
the client keeps the original callback options. The local/SSH protocol fixtures
assert the actual permission-routing CLI argument and `bypassPermissions` mode,
and verify tool callbacks allow execution without requesting input. Clarification
questions retain their input flow. Codex uses `never` approvals with
`danger-full-access` for both fresh and resumed sessions.
No user or machine-wide Claude settings are changed.

Claude WebSearch/WebFetch, Bash, Read/Grep/Glob, and Edit/Write/NotebookEdit receipts
now use the shared web, command, and file instruments. Text-block results and
explicit WebSearch source lists render as evidence, unsafe source URLs remain
plain text, and the complete original tool record is retained. Two frontend
regressions cover the provider mappings, evidence, safe links, and declined tools.
An authenticated live coordinator check passed both WebSearch and WebFetch.
