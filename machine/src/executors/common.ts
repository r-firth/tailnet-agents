import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Host, TaskRun } from "../task.js";
import { TOOL_GUIDANCE } from "../tooldefs.js";
import { AbortedError, abortError, log, truncate } from "../util.js";

/** A failure that is safe and useful to show the user as-is. */
export class ExecutorError extends Error {}

export function which(name: string, extra: string[] = []): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...extra];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

export function childEnv(h: Host, t: TaskRun, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "FAMILIAR_MACHINE_TOKEN" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_ENTRYPOINT")) continue;
    env[k] = v;
  }
  return {
    ...env,
    FAMILIAR_AGENTD_URL: h.bridge.url,
    FAMILIAR_AGENTD_TOKEN: h.bridge.token,
    FAMILIAR_TASK_ID: t.id,
    FAMILIAR_HOME: h.cfg.home,
    ...extra,
  };
}

function claimText(c: unknown): string {
  if (typeof c === "string") return c;
  const o = c as { kind?: string; text?: string; subject?: string; name?: string };
  return `${o.kind ? `[${o.kind}] ` : ""}${o.text ?? o.name ?? JSON.stringify(c)}`;
}

export function localSkills(home: string): { name: string; body: string }[] {
  const dir = path.join(home, "skills");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .slice(0, 20)
      .map((f) => ({ name: f.replace(/\.md$/, ""), body: fs.readFileSync(path.join(dir, f), "utf8") }));
  } catch {
    return [];
  }
}

/** The task prompt: brief + memory context + procedures + local skills + environment notes. */
export function buildPrompt(h: Host, t: TaskRun, includeGuidance: boolean): string {
  const parts: string[] = [];
  if (includeGuidance) parts.push(TOOL_GUIDANCE, "");
  parts.push(`# Task\n${t.brief.trim()}`);
  const mem = (t.context.memory ?? []).slice(0, 30);
  if (mem.length) parts.push(`# What you already know about the user (from memory)\n${mem.map((c) => `- ${truncate(claimText(c), 400)}`).join("\n")}`);
  const procs = (t.context.procedures ?? []).slice(0, 10);
  if (procs.length) parts.push(`# Procedures that worked before\n${procs.map((c) => `- ${truncate(claimText(c), 1200)}`).join("\n")}`);
  const skills = localSkills(h.cfg.home).slice(0, 6);
  if (skills.length) parts.push(`# Skills saved on this machine\n${skills.map((s) => `## ${s.name}\n${truncate(s.body, 1500)}`).join("\n\n")}`);
  parts.push(
    `# Environment\n- Machine "${h.cfg.name}" (${h.cfg.backend}${h.cfg.backend === "local" ? `: a process on ${h.cfg.ownerName}'s own computer, not a cloud VM` : ""}); home directory ${h.cfg.home}; installs go in ~/opt/<name>/ with a VERSION file.\n` +
      `- Chrome has a persistent profile, so sites the user logged into stay logged in.\n` +
      `- ${h.cfg.ownerName} can watch the browser and terminal live and may take control; tool calls pause until control is handed back.\n` +
      `- A fictional demo SaaS called Polyform runs at ${h.demo.origin} (used for demos).\n` +
      `- Time cap: ${Math.round(t.timeCapS / 60)} minutes.`,
  );
  return parts.join("\n\n");
}

export interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Spawn a CLI that prints JSON lines; kill it (TERM then KILL) when the task aborts. */
export function runJsonl(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin?: string; signal: AbortSignal; onJson: (obj: any) => void; onText?: (line: string) => void },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(abortError(opts.signal));
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stderr = "";
    let buf = "";
    let killTimer: NodeJS.Timeout | null = null;
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 3000);
    };
    const onAbort = () => kill();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e: NodeJS.ErrnoException) => {
      opts.signal.removeEventListener("abort", onAbort);
      reject(e.code === "ENOENT" ? new ExecutorError(`${/codex/i.test(bin) ? "Codex CLI" : /claude/i.test(bin) ? "Claude Code" : path.basename(bin)} is not installed on this machine.`) : e);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          opts.onText?.(line);
          continue;
        }
        try {
          opts.onJson(obj);
        } catch (e) {
          log("warn", "executor event handler failed", e);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");
    child.on("close", (code, sig) => {
      opts.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (opts.signal.aborted) return reject(abortError(opts.signal));
      resolve({ code, signal: sig, stderr });
    });
  });
}

export function assertNotAborted(t: TaskRun) {
  if (t.signal.aborted) throw abortError(t.signal) ?? new AbortedError("cancelled");
}
