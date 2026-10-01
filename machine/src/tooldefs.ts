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
      "Run a bash command in the machine's real terminal, which the user watches live and can type into. Use it for every command (your own shell tool is turned off). Returns the output and exit code. The shell is persistent: cd and exported variables carry over. Avoid interactive programs; pass -y style flags.",
    inputSchema: { type: "object", properties: { command: str("bash command line (may be multi-line)"), timeout_s: num("seconds before Ctrl-C (default 120, max 1800)") }, required: ["command"] },
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

export const TOOL_GUIDANCE = `You are working on the user's personal Familiar machine, a computer with its own screen that the user watches live.
- Run every command with the familiar shell tool: it types into the machine's real terminal, which the user watches live (your own shell tool is off). Otherwise use your own native tools: file tools, web search and fetch, and your browser or computer-use tools when you have them.
- Whatever you're working in (a browser window, an app) should be maximised and in focus, so the user can follow along on the screen.
- Chrome on this machine keeps the user's logins. Use it rather than starting fresh browsers or profiles.
- Call step("…") with a short intent line before each phase of work, so the user can follow along. On the first step, pass next: [...] with the steps you expect after it, and again whenever the plan changes.
- Look before you act, and check before claiming: before saying an account is or isn't signed in, open it and look. Never hand back to the user for something you could do yourself; hand back only for their passwords, 2FA codes or a decision.
- Call memory_search first for anything about the user's accounts, preferences or past procedures; call memory_note for durable facts you learn (and kind=procedure for a reusable recipe).
- Ask with ask_user only when a real choice is needed. Before ANY payment, purchase or booking call request_approval and obey the result.
- When done, call finish(outcome, answer, summary). answer is what the user reads as your reply: give them the actual result they asked for, not how you got it. Plain text you write outside tools is not sent to the user.`;
