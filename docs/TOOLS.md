# What each agent can use

Taken from the code and launch flags as of commit 7416722 (1 Oct 2026). Paths are in the repo.

## 1. The coordinator (the chat you talk to)

**Launch** (`crates/familiar-server/src/coordinator.rs`, `claude_turn`): `claude -p` with `--model claude-opus-5-5`, `--effort medium`, `--append-system-prompt` (Claude Code's own prompt plus Familiar's), `--output-format stream-json`, `--no-session-persistence`, `--strict-mcp-config` (none of your other MCP servers).

**Claude Code built-ins:** `--tools "WebSearch,WebFetch"`, so only **WebSearch** and **WebFetch** are on. Everything else (Bash, Read, Write, Edit, Glob, Grep, Task, computer use) is off.

**Familiar's MCP server `familiar`** (HTTP, `/api/mcp` on the server):

| Tool | What it does |
| --- | --- |
| `start_task` | Start a run on errands (optionally `executor`, and `device` to work on a tailnet machine over SSH) |
| `read_task` | Read a run in detail: brief, steps, notes, what each tool call saw |
| `recall` | Search everything recorded: chats, run results, page text, command output, facts |
| `remember` / `forget` | Pin or drop a keyed fact |
| `cancel_task` | Cancel a run |
| `answer_question` | Answer a run's question or approval for you |
| `schedule` | Run something later or repeatedly |
| `kill` | Stop every run and machine |

## 2. Runs (the executor on errands)

Both executors get the same **Familiar MCP server `familiar`** (stdio, `machine/src/mcp.ts`, defined in `machine/src/tooldefs.ts`):

| Tool | What it does |
| --- | --- |
| `shell` | Types a command into errands' visible terminal (what you see in the Terminal tab) |
| `browser_navigate` | Open a URL in errands' Chrome |
| `browser_snapshot` | Read the page as an accessibility tree with refs |
| `browser_click` / `browser_type` / `browser_press` | Click / type / press by ref (Playwright locators) |
| `browser_wait_for` | Wait for text to appear |
| `browser_screenshot` | Screenshot of the page, returned to the model as an image |
| `computer` | **Familiar's own tool, not Claude's or Codex's native computer use.** Screenshot, then click / double / right click / move / type / key / scroll **by pixel coordinates** on errands' Chrome page (1280x800), via Playwright's mouse and keyboard. Returns a fresh screenshot after each action. |
| `memory_search` / `memory_note` | Search memory / save a fact or procedure |
| `ask_user` | Ask you a question and wait |
| `request_approval` | Ask before paying more than your line |
| `step` | Show progress in the Desk |
| `finish` | End the run with the answer and a one-line summary |

### Claude Code runs (`machine/src/executors/claude.ts`)

`claude -p --output-format stream-json --verbose --append-system-prompt <Familiar guidance> --strict-mcp-config --mcp-config <familiar> --disallowedTools Bash --permission-mode bypassPermissions --model claude-opus-5-5`, run in errands' home folder. Effort is Claude Code's default (not set).

- **Off:** `Bash`, so commands go through the visible `shell` tool instead.
- **On** (everything else, no prompts): Read, Write, Edit, MultiEdit, Glob, Grep, NotebookEdit, **WebSearch**, **WebFetch**, Task (subagents), TodoWrite. These act on errands' home folder directly. (As root it's an explicit allow-list: mcp__familiar, Read, Write, Edit, MultiEdit, Glob, Grep, WebFetch, WebSearch, TodoWrite.)
- **Not available:** Claude in Chrome (`--chrome` isn't passed, and it needs the extension in a visible Chrome) and native computer use.

### Codex runs (`machine/src/executors/codex.ts`)

`codex --search exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C <errands home>` plus the `familiar` MCP server; model from `FAMILIAR_CODEX_MODEL` or Codex's default.

- **On:** Codex's own shell (runs commands directly on the Mac in errands' home, **not** in the visible terminal; the prompt asks it to prefer `shell`), apply_patch file edits, **live web search** (`--search`), viewing images, plan updates. No sandbox and no approvals.
- **Not used:** Codex's `browser_use` and `computer_use`. Its browser use drives its own in-app browser (or an external browser it's paired with), and its computer use on macOS drives the real screen, which here would be your Mac's desktop, not errands.

## 3. Native computer use instead, and what it would take

`computer` gives the model the same loop as native computer use (look at a screenshot, act by coordinates), but Familiar implements it and it only sees the Chrome page, not a desktop. Using the agents' own capabilities instead:

- **Claude's native computer use** is an API tool (the `computer` tool type on the Messages API). Claude Code doesn't offer it headless. It would need a small Familiar executor on the Agent SDK or API that runs Claude with that tool against a real display: the Docker backend already has one (Xvfb + fluxbox + noVNC, `image/Dockerfile`), so the steps are switch errands to Docker, then add that executor. That works for any desktop app, not just Chrome.
- **Claude in Chrome**: run errands' Chrome headed (on that same virtual display), install the Claude extension in its profile, sign the extension in once, and pass `--chrome`. Then Claude drives the browser with its own tools.
- **Codex computer use**: needs a desktop Codex can see. On this Mac that's your actual screen (it would take over your mouse); on the Docker backend it would need Codex's Linux support for computer use, which I haven't confirmed.
