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
    inputSchema: { type: "object", properties: {} },
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
    inputSchema: { type: "object", properties: { text: str("short intent line"), steps_estimate: num("optional: total steps you expect") }, required: ["text"] },
  },
  {
    name: "finish",
    description:
      "End the task. outcome is success|partial|failed. The summary is shown to the user. A screenshot of the current page is attached as the receipt. Optionally include a reusable procedure (skill) you learned.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["success", "partial", "failed"] },
        summary: str("one or two sentences for the user"),
        skill_name: str("optional short name for the learned procedure"),
        procedure: str("optional markdown steps that would let you do this faster next time"),
        spent_gbp: num("money actually charged during this task, in pounds (0 if nothing was paid)"),
      },
      required: ["outcome", "summary"],
    },
  },
];

export const TOOL_GUIDANCE = `You are working on the user's personal Familiar machine. Use ONLY the "familiar" MCP tools for actions:
- Call step("…") with a short intent line before each phase of work, so the user can follow along.
- Use the shell tool for every command (it runs in the terminal the user can watch). The built-in Bash tool is disabled.
- Use browser_* tools for the web: browser_navigate, then browser_snapshot to get refs, then browser_click / browser_type with those refs. Chrome keeps the user's logins.
- Call memory_search first for anything about the user's accounts, preferences or past procedures; call memory_note for durable facts you learn (and kind=procedure for a reusable recipe).
- Ask with ask_user only when a real choice is needed. Before ANY payment, purchase or booking call request_approval and obey the result.
- When done, call finish(outcome, summary). Keep summaries short, specific and honest; say what was verified.`;
