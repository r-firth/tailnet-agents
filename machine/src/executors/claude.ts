import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Host, TaskRun } from "../task.js";
import { callTool } from "../tools.js";
import { TOOL_GUIDANCE } from "../tooldefs.js";
import { log, oneLine, truncate } from "../util.js";
import { buildPrompt, childEnv, ExecutorError, runJsonl, which } from "./common.js";

const EXTRA_DIRS = ["/opt/node22/bin", path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".npm-global/bin"), "/usr/local/bin"];

const ROOT_ALLOWED = ["mcp__familiar", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"];

const AUTH_RE = /authentication_failed|invalid api key|please run \/login|not logged in|oauth token has expired|401|unauthori[sz]ed|no credentials|credit balance is too low/i;
const AUTH_MSG = "Claude Code isn't signed in on this machine. Run `claude auth login` there (or set ANTHROPIC_API_KEY), then retry.";

/** Map a Claude Code built-in tool call to a timeline tool name + target. */
export function describeClaudeTool(name: string, input: any): { tool: string; target: string; actor: string } {
  const i = input ?? {};
  switch (name) {
    case "Read":
      return { tool: "file.read", target: String(i.file_path ?? ""), actor: "machine" };
    case "Write":
      return { tool: "file.write", target: String(i.file_path ?? ""), actor: "machine" };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { tool: "file.edit", target: String(i.file_path ?? i.notebook_path ?? ""), actor: "machine" };
    case "Glob":
      return { tool: "file.glob", target: String(i.pattern ?? ""), actor: "machine" };
    case "Grep":
      return { tool: "file.grep", target: String(i.pattern ?? ""), actor: "machine" };
    case "WebFetch":
      return { tool: "web.fetch", target: String(i.url ?? ""), actor: "browser" };
    case "WebSearch":
      return { tool: "web.search", target: String(i.query ?? ""), actor: "browser" };
    case "TodoWrite":
      return { tool: "plan", target: `${(i.todos ?? []).length} items`, actor: "agent" };
    case "Task":
    case "Agent":
      return { tool: "agent.spawn", target: String(i.description ?? ""), actor: "agent" };
    default:
      return { tool: `claude.${name.replace(/^mcp__/, "").replace(/__/g, ".")}`, target: truncate(JSON.stringify(i), 160), actor: "machine" };
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join(" ");
  return "";
}

/** Normalises Claude Code stream-json into timeline events. Exported for tests. */
export class ClaudeStream {
  private pending = new Map<string, { tool: string; target: string; actor: string; at: number }>();
  private seenMessages = new Map<string, number>();
  tokens = 0;
  final: { ok: boolean; text: string; subtype: string } | null = null;
  errors: string[] = [];
  sessionId: string | null = null;

  constructor(
    private h: Host,
    private t: TaskRun,
  ) {}

  private usageTokens(u: any): number {
    if (!u) return 0;
    return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }

  accept(o: any) {
    const { h, t } = this;
    switch (o?.type) {
      case "system":
        if (o.subtype === "init") {
          this.sessionId = o.session_id ?? null;
          const fam = (o.mcp_servers ?? []).find((s: any) => s.name === "familiar");
          if (fam && fam.status !== "connected") log("warn", `familiar MCP server status: ${fam.status}`);
        }
        break;
      case "assistant": {
        const m = o.message ?? {};
        if (o.error) this.errors.push(String(o.error));
        if (m.id && m.usage) {
          this.seenMessages.set(m.id, this.usageTokens(m.usage));
          const total = [...this.seenMessages.values()].reduce((a, b) => a + b, 0);
          if (total !== this.tokens) {
            this.tokens = total;
            t.tokens = total;
            h.update(t, { tokens: total });
          }
        }
        if (o.parent_tool_use_id) break; // subagent chatter
        for (const b of m.content ?? []) {
          if (b.type === "text" && b.text?.trim()) {
            if (o.error) this.errors.push(b.text);
            else h.event(t, { kind: "message", actor: "agent", text: truncate(b.text.trim(), 2000) });
          } else if (b.type === "tool_use") {
            if (String(b.name).startsWith("mcp__familiar__")) continue; // recorded by agentd itself
            const d = describeClaudeTool(b.name, b.input);
            this.pending.set(b.id, { ...d, at: Date.now() });
            h.event(t, { kind: "tool", actor: d.actor, tool: d.tool, target: truncate(d.target, 200), status: "pending", call_id: b.id });
          }
        }
        break;
      }
      case "user": {
        const content = o.message?.content;
        if (!Array.isArray(content)) break;
        for (const b of content) {
          if (b.type !== "tool_result") continue;
          const p = this.pending.get(b.tool_use_id);
          if (!p) continue;
          this.pending.delete(b.tool_use_id);
          h.event(t, {
            kind: "tool",
            actor: p.actor,
            tool: p.tool,
            target: truncate(p.target, 200),
            status: b.is_error ? "error" : "ok",
            result: oneLine(resultText(b.content), 160),
            duration_ms: Date.now() - p.at,
            call_id: b.tool_use_id,
          });
        }
        break;
      }
      case "result": {
        const total = this.usageTokens(o.usage);
        if (total > this.tokens) {
          this.tokens = total;
          t.tokens = total;
          h.update(t, { tokens: total });
        }
        const text = String(o.result ?? (o.errors ?? []).join("; ") ?? "");
        this.final = { ok: !o.is_error && o.subtype === "success", text, subtype: String(o.subtype ?? "") };
        break;
      }
    }
  }

  failureMessage(stderr: string, code: number | null): string {
    const blob = [...this.errors, this.final?.text ?? "", stderr].join("\n");
    if (AUTH_RE.test(blob)) return AUTH_MSG;
    if (this.final && !this.final.ok) {
      if (this.final.subtype === "error_max_turns") return "Claude Code hit its turn limit before finishing.";
      return `Claude Code stopped: ${oneLine(this.final.text || this.final.subtype, 300)}`;
    }
    const tail = oneLine(stderr.split("\n").filter((l) => l.trim()).slice(-3).join(" "), 300);
    return `Claude Code exited with code ${code}${tail ? `: ${tail}` : ""}`;
  }
}

export function claudeBin(): string | null {
  const env = process.env.FAMILIAR_CLAUDE_BIN;
  if (env) return fs.existsSync(env) ? env : null;
  return which("claude", EXTRA_DIRS);
}

export function checkClaudeAuth(bin: string, env: Record<string, string>) {
  const r = spawnSync(bin, ["auth", "status"], { env, encoding: "utf8", timeout: 20_000 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new ExecutorError("Claude Code is not installed on this machine.");
    return; // can't tell; let the run itself report
  }
  let st: any = null;
  try {
    st = JSON.parse(r.stdout);
  } catch {
    /* older CLI without JSON status */
  }
  if (st && typeof st === "object" && st.loggedIn === false) throw new ExecutorError(AUTH_MSG);
  if (!st && r.status !== 0 && AUTH_RE.test(`${r.stdout}\n${r.stderr}`)) throw new ExecutorError(AUTH_MSG);
}

export async function runClaude(h: Host, t: TaskRun): Promise<void> {
  const bin = claudeBin();
  if (!bin) throw new ExecutorError("Claude Code is not installed on this machine.");
  const env = childEnv(h, t, { IS_SANDBOX: "1", MCP_TOOL_TIMEOUT: "86400000", DISABLE_AUTOUPDATER: "1" });
  checkClaudeAuth(bin, env);

  const mcpConfig = JSON.stringify({
    mcpServers: {
      familiar: {
        type: "stdio",
        command: process.execPath,
        args: [h.mcpScript],
        env: { FAMILIAR_AGENTD_URL: h.bridge.url, FAMILIAR_AGENTD_TOKEN: h.bridge.token, FAMILIAR_TASK_ID: t.id },
      },
    },
  });
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt",
    TOOL_GUIDANCE,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--disallowedTools",
    "Bash",
  ];
  // bypassPermissions is refused when running as root, so there we pre-approve the tools instead.
  if (process.getuid?.() === 0) args.push("--allowedTools", ...ROOT_ALLOWED);
  else args.push("--permission-mode", "bypassPermissions");
  if (process.env.FAMILIAR_CLAUDE_MODEL) args.push("--model", process.env.FAMILIAR_CLAUDE_MODEL);
  const stream = new ClaudeStream(h, t);
  // Prompt goes on stdin: no argv limits, and it can't be swallowed by a variadic flag.
  const res = await runJsonl(bin, args, { cwd: h.cfg.home, env, stdin: buildPrompt(h, t, false), signal: t.signal, onJson: (o) => stream.accept(o) });
  if (t.result) return;
  if (res.code === 0 && stream.final?.ok) {
    await callTool(h, t, "finish", { outcome: "success", summary: truncate(stream.final.text.trim() || "Done.", 1200) });
    return;
  }
  throw new ExecutorError(stream.failureMessage(res.stderr, res.code));
}
