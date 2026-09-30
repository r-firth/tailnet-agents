import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Host, TaskRun } from "../task.js";
import { callTool } from "../tools.js";
import { oneLine, truncate } from "../util.js";
import { buildPrompt, childEnv, ExecutorError, runJsonl, which } from "./common.js";

const EXTRA_DIRS = ["/opt/node22/bin", path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".npm-global/bin"), "/usr/local/bin"];
const AUTH_RE = /not logged in|login required|unauthori[sz]ed|401|invalid api key|refresh token|please log ?in/i;
const AUTH_MSG = "Codex isn't signed in on this machine. Run `codex login` there (or set OPENAI_API_KEY), then retry.";

const toml = (s: string) => JSON.stringify(s); // JSON strings are valid TOML basic strings

/** Normalises `codex exec --json` JSONL (and the older {msg:{…}} shape) into timeline events. */
export class CodexStream {
  private pending = new Map<string, { tool: string; target: string; actor: string; at: number }>();
  tokens = 0;
  lastMessage = "";
  error: string | null = null;
  completed = false;

  constructor(
    private h: Host,
    private t: TaskRun,
  ) {}

  private start(key: string, tool: string, target: string, actor: string) {
    if (this.pending.has(key)) return;
    this.pending.set(key, { tool, target, actor, at: Date.now() });
    this.h.event(this.t, { kind: "tool", actor, tool, target: truncate(target, 200), status: "pending", call_id: key });
  }

  private end(key: string, ok: boolean, result: string, fallback?: { tool: string; target: string; actor: string }) {
    const p = this.pending.get(key) ?? (fallback ? { ...fallback, at: Date.now() } : undefined);
    if (!p) return;
    this.pending.delete(key);
    this.h.event(this.t, { kind: "tool", actor: p.actor, tool: p.tool, target: truncate(p.target, 200), status: ok ? "ok" : "error", result: oneLine(result, 160), duration_ms: Date.now() - p.at, call_id: key });
  }

  private addTokens(u: any) {
    if (!u) return;
    this.tokens += (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0) + (u.output_tokens ?? 0);
    this.t.tokens = this.tokens;
    this.h.update(this.t, { tokens: this.tokens });
  }

  private describe(item: any): { tool: string; target: string; actor: string } | null {
    switch (item.type) {
      case "command_execution":
        return { tool: "shell", target: String(item.command ?? ""), actor: "machine" };
      case "file_change":
        return { tool: "file.edit", target: (item.changes ?? []).map((c: any) => c.path).join(", "), actor: "machine" };
      case "web_search":
        return { tool: "web.search", target: String(item.query ?? ""), actor: "browser" };
      case "mcp_tool_call":
        if (item.server === "familiar") return null; // recorded by agentd itself
        return { tool: `${item.server}.${item.tool}`, target: truncate(JSON.stringify(item.arguments ?? {}), 160), actor: "machine" };
      default:
        return null;
    }
  }

  accept(o: any) {
    if (o?.msg && typeof o.msg === "object") return this.acceptLegacy(o.msg, o.id);
    switch (o?.type) {
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = o.item ?? {};
        if (item.type === "agent_message" && o.type === "item.completed" && item.text?.trim()) {
          this.lastMessage = item.text.trim();
          this.h.event(this.t, { kind: "message", actor: "agent", text: truncate(this.lastMessage, 2000) });
          return;
        }
        if (item.type === "error" && item.message) {
          this.h.event(this.t, { kind: "message", actor: "agent", text: truncate(`Codex: ${item.message}`, 500) });
          return;
        }
        const d = this.describe(item);
        if (!d) return;
        const key = String(item.id ?? `${d.tool}:${d.target}`);
        if (o.type !== "item.completed") this.start(key, d.tool, d.target, d.actor);
        else {
          const ok = item.status !== "failed" && item.status !== "declined" && (item.exit_code === undefined || item.exit_code === null || item.exit_code === 0) && !item.error;
          const result =
            item.type === "command_execution"
              ? `exit ${item.exit_code ?? "?"} · ${String(item.aggregated_output ?? "").trim().split("\n").pop() ?? ""}`
              : item.error?.message ?? (item.status || "done");
          this.end(key, ok, result, d);
        }
        return;
      }
      case "turn.completed":
        this.addTokens(o.usage);
        this.completed = true;
        return;
      case "turn.failed":
        this.error = String(o.error?.message ?? "turn failed");
        return;
      case "error":
        this.error = String(o.message ?? "error");
        return;
    }
  }

  private acceptLegacy(m: any, id: string) {
    switch (m.type) {
      case "agent_message":
        if (m.message?.trim()) {
          this.lastMessage = m.message.trim();
          this.h.event(this.t, { kind: "message", actor: "agent", text: truncate(this.lastMessage, 2000) });
        }
        return;
      case "exec_command_begin":
        this.start(String(m.call_id ?? id), "shell", Array.isArray(m.command) ? m.command.join(" ") : String(m.command ?? ""), "machine");
        return;
      case "exec_command_end":
        this.end(String(m.call_id ?? id), m.exit_code === 0, `exit ${m.exit_code} · ${String(m.stdout ?? m.aggregated_output ?? "").trim().split("\n").pop() ?? ""}`);
        return;
      case "token_count":
        if (m.info?.total_token_usage) {
          const u = m.info.total_token_usage;
          this.tokens = (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0) + (u.output_tokens ?? 0);
          this.t.tokens = this.tokens;
          this.h.update(this.t, { tokens: this.tokens });
        }
        return;
      case "task_complete":
        this.completed = true;
        if (m.last_agent_message) this.lastMessage = m.last_agent_message;
        return;
      case "error":
        this.error = String(m.message ?? "error");
        return;
    }
  }
}

export function codexBin(): string | null {
  const env = process.env.FAMILIAR_CODEX_BIN;
  if (env) return fs.existsSync(env) ? env : null;
  return which("codex", EXTRA_DIRS);
}

export async function runCodex(h: Host, t: TaskRun): Promise<void> {
  const bin = codexBin();
  if (!bin) throw new ExecutorError("Codex CLI is not installed on this machine (npm i -g @openai/codex).");
  const env = childEnv(h, t);
  const st = spawnSync(bin, ["login", "status"], { env, encoding: "utf8", timeout: 20_000 });
  if (!st.error && st.status !== 0 && !process.env.OPENAI_API_KEY) throw new ExecutorError(AUTH_MSG);

  const mcpEnv = `{FAMILIAR_AGENTD_URL=${toml(h.bridge.url)},FAMILIAR_AGENTD_TOKEN=${toml(h.bridge.token)},FAMILIAR_TASK_ID=${toml(t.id)}}`;
  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-C",
    h.cfg.home,
    "-c",
    `mcp_servers.familiar.command=${toml(process.execPath)}`,
    "-c",
    `mcp_servers.familiar.args=[${toml(h.mcpScript)}]`,
    "-c",
    `mcp_servers.familiar.env=${mcpEnv}`,
    "-c",
    "mcp_servers.familiar.startup_timeout_sec=30",
    "-c",
    "mcp_servers.familiar.tool_timeout_sec=86400",
  ];
  if (process.env.FAMILIAR_CODEX_MODEL) args.push("-m", process.env.FAMILIAR_CODEX_MODEL);
  args.push("-"); // prompt from stdin
  const stream = new CodexStream(h, t);
  const res = await runJsonl(bin, args, { cwd: h.cfg.home, env, stdin: buildPrompt(h, t, true), signal: t.signal, onJson: (o) => stream.accept(o) });
  if (t.result) return;
  if (res.code === 0 && !stream.error) {
    await callTool(h, t, "finish", { outcome: stream.completed ? "success" : "partial", summary: truncate(stream.lastMessage || "Done.", 1200) });
    return;
  }
  const blob = `${stream.error ?? ""}\n${res.stderr}`;
  if (AUTH_RE.test(blob)) throw new ExecutorError(AUTH_MSG);
  const tail = oneLine(stream.error ?? res.stderr.split("\n").filter((l) => l.trim()).slice(-3).join(" "), 300);
  throw new ExecutorError(`Codex exited with code ${res.code}${tail ? `: ${tail}` : ""}`);
}
