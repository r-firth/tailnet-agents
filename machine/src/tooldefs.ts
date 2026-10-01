/** Executor tool definitions (protocol.md "Executor tools"), shared by the MCP server and agentd. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

export const TOOLS: ToolDef[] = [
  {
    name: "shell",
    description:
      "Run a bash command in the machine's visible terminal (the user can watch it). Returns the output and exit code. The shell is persistent: cd and exported variables carry over. Avoid interactive programs; pass -y style flags.",
    inputSchema: { type: "object", properties: { command: str("bash command line (may be multi-line)"), timeout_s: num("seconds before Ctrl-C (default 120, max 1800)") }, required: ["command"] },
  },
  {
    name: "browser_navigate",
    description: "Open a URL in the machine's Chrome (persistent profile, so existing logins apply). Returns the page title.",
    inputSchema: { type: "object", properties: { url: str("absolute URL") }, required: ["url"] },
  },
  {
    name: "browser_snapshot",
    description: "Compact accessibility tree of the current page. Interactive elements carry refs like [ref=e12] that browser_click / browser_type accept. Take a fresh snapshot after the page changes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click an element by snapshot ref (e.g. \"e12\") or by its visible text / accessible name.",
    inputSchema: { type: "object", properties: { ref: str("ref from browser_snapshot"), text: str("visible text or accessible name, used when no ref is given") } },
  },
  {
    name: "browser_type",
    description: "Fill a text field (by ref, label, or placeholder) with a value; optionally press Enter.",
    inputSchema: { type: "object", properties: { ref: str("ref from browser_snapshot"), text: str("label/placeholder of the field, used when no ref is given"), value: str("text to enter"), submit: { type: "boolean", description: "press Enter afterwards" } }, required: ["value"] },
  },
  {
    name: "browser_press",
    description: "Press a key or chord in the page, e.g. Enter, Escape, Tab, Control+A.",
    inputSchema: { type: "object", properties: { key: str("key name") }, required: ["key"] },
  },
  {
    name: "browser_wait_for",
    description: "Wait until the given text is visible on the page (case-insensitive substring).",
    inputSchema: { type: "object", properties: { text: str("text to wait for"), timeout_s: num("default 30") }, required: ["text"] },
  },
  {
    name: "browser_screenshot",
    description: "Screenshot of the current page (also recorded on the task timeline).",
    inputSchema: { type: "object", properties: { caption: str("optional: what the screenshot shows, a few words, e.g. 'Receipt'") } },
  },
  {
    name: "computer",
    description:
      "Look at and operate the machine's Chrome the way a person does: by sight. The screen is the 1280x800 page. 'screenshot' shows it; left_click/double_click/right_click/move at x,y; type text; key presses a key or chord (e.g. Enter, Escape, Control+a); scroll at x,y by dy (and dx) pixels. Every action returns a fresh screenshot so you can see what happened. Use it whenever a page is visual, a ref click fails or times out, something covers the page (cookie banners, popups, sign-in choosers), or you're not sure what's on screen.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["screenshot", "left_click", "double_click", "right_click", "move", "type", "key", "scroll"] },
        x: num("x in page pixels (0-1279)"),
        y: num("y in page pixels (0-799)"),
        text: str("for type: the text; for key: the key or chord"),
        dx: num("for scroll: horizontal pixels"),
        dy: num("for scroll: vertical pixels, positive scrolls down"),
      },
      required: ["action"],
    },
  },
  {
    name: "memory_search",
    description: "Search the user's long-term memory (facts, preferences, accounts, subscriptions, procedures from earlier runs). Do this before starting unfamiliar work.",
    inputSchema: { type: "object", properties: { query: str("what to look for") }, required: ["query"] },
  },
  {
    name: "memory_note",
    description:
      "Record something worth remembering. kind is one of fact|preference|rule|procedure|account|subscription|person|episode. Use kind=procedure for a reusable 'How to …' recipe; it is also saved as a skill on this machine.",
    inputSchema: { type: "object", properties: { text: str("the claim, one or two sentences"), kind: str("claim kind"), subject: str("short subject key, e.g. 'polyform'") }, required: ["text", "kind"] },
  },
  {
    name: "ask_user",
    description: "Ask the user a question and wait for their answer. Offer 2-4 short options; they may also reply in free text.",
    inputSchema: { type: "object", properties: { question: str("the question"), options: { type: "array", items: { type: "string" }, description: "short option labels" } }, required: ["question"] },
  },
  {
    name: "request_approval",
    description:
      "REQUIRED before any payment, purchase, booking or other spend. Returns approve / hold. Under the user's threshold it is approved automatically; above it the user decides. Never pay without an 'approve' result.",
    inputSchema: { type: "object", properties: { amount_gbp: num("amount in pounds, e.g. 142.40"), merchant: str("who is paid"), description: str("what for") }, required: ["amount_gbp", "merchant", "description"] },
  },
  {
    name: "step",
    description: "Announce the intent of your next few actions in one short line (shown to the user as the current step), e.g. 'Open billing settings'.",
    inputSchema: {
      type: "object",
      properties: {
        text: str("short intent line"),
        next: { type: "array", items: { type: "string" }, description: "optional: the steps you expect after this one, short intent lines. Shown as the plan ahead; send it again whenever the plan changes." },
        steps_estimate: num("optional: total steps you expect (implied by next)"),
      },
      required: ["text"],
    },
  },
  {
    name: "finish",
    description:
      "End the task. outcome is success|partial|failed. `answer` is posted to the user in chat as your reply, so put the actual result there (the list, numbers, links, what was bought), not a description of how you got it. `summary` is one line for the run's log. A screenshot of the current page is attached as the receipt. Optionally include a reusable procedure (skill) you learned.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["success", "partial", "failed"] },
        answer: str("the result itself, as the user asked for it, in short markdown (e.g. the 10 repos with links). Required whenever the task asked for information."),
        summary: str("one line: what happened and what was verified"),
        skill_name: str("optional short name for the learned procedure"),
        procedure: str("optional markdown steps that would let you do this faster next time"),
        spent_gbp: num("money actually charged during this task, in pounds (0 if nothing was paid)"),
      },
      required: ["outcome", "summary"],
    },
  },
];

export const TOOL_GUIDANCE = `You are working on the user's personal Familiar machine. Use ONLY the "familiar" MCP tools for actions:
- Call step("…") with a short intent line before each phase of work, so the user can follow along. On the first step, pass next: [...] with the steps you expect after it, and again whenever the plan changes.
- Use the shell tool for every command (it runs in the terminal the user can watch). The built-in Bash tool is disabled.
- To look something up (what a project is, news, prices, docs), use native web search and fetch (WebSearch/WebFetch in Claude Code, web search in Codex) and cite links. Use the browser when you need a real page, a login or to act on a site.
- Look before you act. When a page is visual, a click by ref fails or times out, or something might be covering it, take a screenshot with computer and click what you see by its coordinates. Never hand back to the user for something on screen you could click or type yourself; hand back only for their passwords, 2FA codes or a decision.
- Before saying an account is or isn't signed in, check: open the site and look (screenshot), don't assume from memory.
- Use browser_* tools for the web: browser_navigate, then browser_snapshot to get refs, then browser_click / browser_type with those refs. Chrome keeps the user's logins.
- Call memory_search first for anything about the user's accounts, preferences or past procedures; call memory_note for durable facts you learn (and kind=procedure for a reusable recipe).
- Ask with ask_user only when a real choice is needed. Before ANY payment, purchase or booking call request_approval and obey the result.
- When done, call finish(outcome, answer, summary). answer is what the user reads as your reply: give them the actual result they asked for, not how you got it. Plain text you write outside tools is not sent to the user.`;
