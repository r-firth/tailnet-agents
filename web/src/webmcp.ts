import { api, type HubState, type Session } from "./api";
type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => Promise<unknown>;
};
type Context = {
  registerTool: (
    tool: Tool,
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};
export function registerHubTools(
  showTerminal: (session: Session) => Promise<void>,
  currentChat: () => string = () => "",
) {
  const context = (document as Document & { modelContext?: Context })
    .modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const tools: Tool[] = [
    {
      name: "get_workspace",
      description:
        "Read registered devices, persistent terminals, and running conversations.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute() {
        const state = await api<HubState>("/state");
        return {
          devices: state.devices,
          sessions: state.sessions,
          running: state.running,
        };
      },
    },
    {
      name: "open_terminal",
      description:
        "Open or reuse the current session's single persistent terminal. With no session selected, creates a session for the terminal. Starts a real shell and keeps the conversation and terminal together.",
      inputSchema: {
        type: "object",
        properties: {
          device_id: { type: "string" },
          name: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["device_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Expected terminal options");
        const p = input as Record<string, unknown>;
        if (
          Object.keys(p).some(
            (k) => !["device_id", "name", "cwd"].includes(k),
          ) ||
          typeof p.device_id !== "string" ||
          !p.device_id ||
          ["name", "cwd"].some(
            (k) => p[k] !== undefined && typeof p[k] !== "string",
          )
        )
          throw new Error("Invalid terminal options");
        const session = await api<Session>("/sessions", {
          ...p,
          chat_id: currentChat() || undefined,
        });
        await showTerminal(session);
        return session;
      },
    },
  ];
  for (const tool of tools) {
    try {
      void Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {
      /* optional browser capability */
    }
  }
  return () => lifecycle.abort();
}
