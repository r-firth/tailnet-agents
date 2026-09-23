export type ActivityKind =
  "thinking" | "web" | "command" | "files" | "connection" | "memory" | "flow";

/** Classify declared tools, never infer activity from generated prose. */
export function activityKind(name: string): ActivityKind {
  switch (name) {
    case "web_search":
      return "web";
    case "command_execution":
    case "terminal_send":
    case "terminal_read":
    case "terminal_interrupt":
      return "command";
    case "file_change":
      return "files";
    case "open_terminal":
    case "list_devices":
    case "list_terminals":
      return "connection";
    case "search_memory":
      return "memory";
    default:
      return "thinking";
  }
}

// Shared with the WGSL uniform's mode numbers.
export const activityModes: Record<ActivityKind, number> = {
  thinking: 0,
  web: 1,
  command: 2,
  files: 3,
  connection: 4,
  memory: 5,
  flow: 6,
};
