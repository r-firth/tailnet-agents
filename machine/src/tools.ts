import type { Host, TaskRun } from "./task.js";
import { AbortedError, id, oneLine, truncate } from "./util.js";

export interface ToolResult {
  ok: boolean;
  text: string;
  /** base64 jpeg for MCP image content */
  image?: string;
  data?: Record<string, unknown>;
}

type Args = Record<string, any>;

const ok = (text: string, data?: Record<string, unknown>, image?: string): ToolResult => ({ ok: true, text, data, image });
const err = (text: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, text, data });

/** Normalise the server's memory.search result into timeline hits. */
export function normaliseHits(result: any): Array<{ id: unknown; score: number; text: string; kind: string; source: unknown }> {
  const arr: any[] = Array.isArray(result) ? result : result?.hits ?? result?.claims ?? result?.results ?? [];
  return arr.slice(0, 10).map((h: any) => {
    const c = h?.claim ?? h;
    return {
      id: c?.id ?? null,
      score: typeof h?.score === "number" ? Math.round(h.score * 1000) / 1000 : 0,
      text: String(c?.text ?? (typeof h === "string" ? h : "")),
      kind: String(c?.kind ?? "fact"),
      source: c?.source ?? null,
    };
  });
}

function toolActor(tool: string) {
  if (tool.startsWith("browser.")) return "browser";
  if (tool.startsWith("memory.")) return "memory";
  return "machine";
}

/** Emit a pending tool event, run fn, then complete the event with ok/error. */
async function recorded<T>(
  host: Host,
  task: TaskRun,
  tool: string,
  target: string,
  fn: () => Promise<T>,
  describe: (v: T) => { result: string; status?: "ok" | "error"; content?: string },
): Promise<T> {
  const call_id = id("c_");
  const actor = toolActor(tool);
  const started = Date.now();
  host.event(task, { kind: "tool", actor, tool, target, status: "pending", call_id });
  try {
    const v = await fn();
    const d = describe(v);
    // content (page text, command output) goes to memory; result is the one-line label.
    host.event(task, { kind: "tool", actor, tool, target, status: d.status ?? "ok", result: d.result, ...(d.content?.trim() ? { content: truncate(d.content, 12_000) } : {}), duration_ms: Date.now() - started, call_id });
    return v;
  } catch (e) {
    const msg = e instanceof AbortedError ? "cancelled" : (e as Error).message.split("\n")[0];
    host.event(task, { kind: "tool", actor, tool, target, status: "error", result: truncate(msg, 300), duration_ms: Date.now() - started, call_id });
    throw e;
  }
}

/** A screenshot on the timeline; `action` says what just happened, in words the filmstrip can show. */
async function keyframe(host: Host, task: TaskRun, action?: string) {
  try {
    const shot = await host.browser.screenshot();
    task.lastScreenshot = shot.jpeg;
    host.event(task, { kind: "keyframe", actor: "browser", image: shot.jpeg.toString("base64"), url: shot.url, title: shot.title, ...(action ? { action } : {}) });
    return shot;
  } catch {
    return null;
  }
}

export function startStep(host: Host, task: TaskRun, text: string, stepsEstimate?: number, next?: string[]) {
  closeStep(host, task, "done");
  task.stepNo += 1;
  if (next) stepsEstimate = task.stepNo + next.length;
  if (stepsEstimate && stepsEstimate > 0) task.stepsEstimate = Math.max(Math.round(stepsEstimate), task.stepNo);
  else if (task.stepsEstimate !== undefined && task.stepNo > task.stepsEstimate) task.stepsEstimate = task.stepNo;
  const step_id = `s${task.stepNo}`;
  task.activeStep = { id: step_id, text };
  host.event(task, { kind: "step", actor: "agent", text, state: "active", step_id });
  // The plan ahead replaces any earlier one; `after` is the step it was made at.
  if (next) host.event(task, { kind: "plan", actor: "agent", steps: next, after: task.stepNo });
  host.update(task, { now: text, step: task.stepNo, ...(task.stepsEstimate ? { steps_estimate: task.stepsEstimate } : {}) });
}

export function closeStep(host: Host, task: TaskRun, state: "done" | "failed") {
  if (!task.activeStep) return;
  host.event(task, { kind: "step", actor: "agent", text: task.activeStep.text, state, step_id: task.activeStep.id });
  task.activeStep = null;
}

function targetOf(a: Args): string {
  return String(a.ref ?? a.text ?? a.target ?? a.selector ?? "").trim();
}

/**
 * Execute one executor tool on behalf of a task. Shared by the scripted executor and the MCP bridge,
 * so Claude Code / Codex runs produce exactly the same timeline as the demo.
 */
export async function callTool(host: Host, task: TaskRun, name: string, a: Args = {}): Promise<ToolResult> {
  await host.gate(task);
  if (task.signal.aborted) throw new AbortedError("cancelled");
  if (task.result && name !== "finish") return err("The task is already finished.");
  const b = host.browser;
  try {
    switch (name) {
      case "step": {
        const text = oneLine(String(a.text ?? ""), 140);
        if (!text) return err("text is required");
        const next = Array.isArray(a.next) ? a.next.map((x) => oneLine(String(x), 140)).filter(Boolean).slice(0, 12) : undefined;
        startStep(host, task, text, Number(a.steps_estimate) || undefined, next);
        return ok("noted");
      }
      case "shell": {
        const command = String(a.command ?? "");
        if (!command.trim()) return err("command is required");
        const timeout = Math.min(1800, Math.max(1, Number(a.timeout_s) || 120)) * 1000;
        const r = await recorded(
          host,
          task,
          "shell",
          oneLine(command, 200),
          () => host.terminal.run(command, timeout, task.signal),
          (r) => {
            const last = r.output.split("\n").filter((l) => l.trim()).pop() ?? "";
            const head = r.timed_out ? `timed out after ${timeout / 1000}s` : `exit ${r.exit_code}`;
            return { result: truncate(last ? `${head} · ${oneLine(last, 120)}` : head, 200), status: r.exit_code === 0 && !r.timed_out ? "ok" : "error", content: r.output };
          },
        );
        const text = `${r.output}\n[exit code: ${r.exit_code ?? "none"}${r.timed_out ? ", timed out and interrupted" : ""}]`;
        return { ok: r.exit_code === 0 && !r.timed_out, text, data: { output: r.output, exit_code: r.exit_code, timed_out: r.timed_out } };
      }
      case "browser_navigate": {
        const url = String(a.url ?? "");
        if (!url) return err("url is required");
        const r = await recorded(host, task, "browser.navigate", url, () => b.navigate(url, task.signal), (r) => ({ result: r.title || r.url }));
        await keyframe(host, task, `Opened ${shortTitle(r.title) || hostOf(r.url)}`);
        return ok(`Opened ${r.url} — "${r.title}"${r.status && r.status >= 400 ? ` (HTTP ${r.status})` : ""}`, r);
      }
      case "browser_snapshot": {
        const r = await recorded(host, task, "browser.snapshot", "page", () => b.snapshot(), (r) => ({ result: `${(r.tree.match(/\[ref=/g) ?? []).length} refs · ${r.title}`, content: `${r.title}\n${r.url}\n${r.tree.replace(/ \[ref=[^\]]*\]/g, "")}` }));
        return ok(`Page: ${r.title}\nURL: ${r.url}\n${r.tree}`, { url: r.url, title: r.title });
      }
      case "browser_click": {
        const t = targetOf(a);
        if (!t) return err("ref or text is required");
        const r = await recorded(host, task, "browser.click", b.describe(t), () => b.click(t), (r) => ({ result: r.title ? `→ ${r.title}` : "clicked" }));
        await keyframe(host, task, `Clicked “${truncate(String(r.clicked ?? t), 32)}”`);
        return ok(`Clicked "${r.clicked}". Now on ${r.url} — "${r.title}"`, r);
      }
      case "browser_type": {
        const t = targetOf(a);
        const value = String(a.value ?? "");
        if (!t) return err("ref or text is required");
        const secret = /pass|secret|token|card|cvc|cvv/i.test(t);
        const shown = secret ? "•".repeat(Math.min(value.length, 8)) : truncate(value, 60);
        const r = await recorded(host, task, "browser.type", `${b.describe(t)} ← "${shown}"`, () => b.type(t, value, !!a.submit), () => ({ result: a.submit ? "typed and submitted" : "typed" }));
        await keyframe(host, task, a.submit ? `Typed and sent “${secret ? "•••" : truncate(value, 24)}”` : `Typed “${secret ? "•••" : truncate(value, 24)}”`);
        return ok(`Typed into ${t}${a.submit ? " and pressed Enter" : ""}. Now on ${r.url}`, r);
      }
      case "browser_press": {
        const key = String(a.key ?? "");
        if (!key) return err("key is required");
        await recorded(host, task, "browser.press", key, () => b.press(key), () => ({ result: "pressed" }));
        await keyframe(host, task, `Pressed ${key}`);
        return ok(`Pressed ${key}`);
      }
      case "browser_wait_for": {
        const text = String(a.text ?? "");
        if (!text) return err("text is required");
        const timeout = Math.min(600, Math.max(1, Number(a.timeout_s) || 30)) * 1000;
        host.update(task, { waiting_for: `text "${truncate(text, 40)}"` });
        try {
          const r = await recorded(host, task, "browser.wait_for", `text "${text}"`, () => b.waitFor(text, timeout, task.signal), (r) => ({ result: `appeared after ${(r.waited_ms / 1000).toFixed(1)}s` }));
          await keyframe(host, task, `“${truncate(text, 28)}” appeared`);
          return ok(`"${text}" is visible on ${r.url}`, r);
        } finally {
          host.update(task, { waiting_for: null });
        }
      }
      case "computer": {
        const action = String(a.action ?? "screenshot");
        const x = Math.round(Number(a.x)), y = Math.round(Number(a.y));
        const hasXY = Number.isFinite(x) && Number.isFinite(y);
        const target = action === "type" ? `"${oneLine(String(a.text ?? ""), 60)}"` : action === "key" ? String(a.text ?? "") : hasXY ? `${x},${y}` : "page";
        const shot = await recorded(host, task, `computer.${action}`, target, async () => {
          const p = await b.activePage();
          if (action !== "screenshot" && action !== "type" && action !== "key" && !hasXY) throw new Error(`${action} needs x and y`);
          switch (action) {
            case "left_click": await p.mouse.click(x, y); break;
            case "double_click": await p.mouse.dblclick(x, y); break;
            case "right_click": await p.mouse.click(x, y, { button: "right" }); break;
            case "move": await p.mouse.move(x, y); break;
            case "type": await p.keyboard.type(String(a.text ?? ""), { delay: 15 }); break;
            case "key": await p.keyboard.press(String(a.text ?? "Enter")); break;
            case "scroll": await p.mouse.move(x, y); await p.mouse.wheel(Number(a.dx) || 0, Number(a.dy) || 0); break;
          }
          if (action !== "screenshot" && action !== "move") await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
          await p.waitForTimeout(action === "screenshot" ? 0 : 400);
          return b.screenshot();
        }, (s) => ({ result: s.title || s.url }));
        const image = shot.jpeg.toString("base64");
        task.lastScreenshot = shot.jpeg;
        if (action !== "screenshot" && action !== "move") host.event(task, { kind: "keyframe", actor: "browser", image, url: shot.url, title: shot.title, action: `${action.replace("_", " ")} ${target}` });
        return ok(`${action} done. Now on ${shot.url} — "${shot.title}". Screenshot attached (1280x800).`, { url: shot.url, title: shot.title }, image);
      }
      case "browser_screenshot": {
        const shot = await recorded(host, task, "browser.screenshot", "page", () => b.screenshot(), (s) => ({ result: s.title || s.url }));
        task.lastScreenshot = shot.jpeg;
        const image = shot.jpeg.toString("base64");
        host.event(task, { kind: "keyframe", actor: "browser", image, url: shot.url, title: shot.title, action: String(a.caption ?? "") || "Screenshot" });
        return ok(`Screenshot of ${shot.url} — "${shot.title}"`, { url: shot.url, title: shot.title }, image);
      }
      case "memory_search": {
        const query = String(a.query ?? "");
        const r = await host.memory(task, "search", { query });
        const hits = r.ok ? normaliseHits(r.result) : [];
        host.event(task, { kind: "memory.recall", actor: "memory", query, hits });
        if (!r.ok) return ok("Memory is unavailable right now; continue without it.", { hits: [] });
        if (!hits.length) return ok(`No memories match "${query}".`, { hits });
        return ok(hits.map((h) => `- [${h.kind}] ${h.text} (id ${h.id}, score ${h.score})`).join("\n"), { hits });
      }
      case "memory_note": {
        const text = String(a.text ?? "").trim();
        const kind = String(a.kind ?? "fact");
        const subject = a.subject ? String(a.subject) : undefined;
        if (!text) return err("text is required");
        const r = await host.memory(task, "note", { text, kind, subject });
        const claim = r.result?.claim ?? r.result ?? {};
        const op = claim?.superseded_id || r.result?.op === "supersede" ? "supersede" : "add";
        host.event(task, { kind: "memory.write", actor: "memory", op, text, claim_kind: kind, claim_id: claim?.id ?? null });
        if (kind === "procedure") task.procedures.push({ text, subject });
        return r.ok ? ok(`Noted (${kind}).`, { claim_id: claim?.id ?? null }) : ok("Memory is unavailable; the note was kept on this machine only.");
      }
      case "ask_user": {
        const question = String(a.question ?? "").trim();
        if (!question) return err("question is required");
        const opts: string[] = Array.isArray(a.options) ? a.options.map((o: unknown) => String(typeof o === "object" && o ? (o as any).label ?? (o as any).id : o)) : [];
        const options = opts.slice(0, 6).map((label, i) => ({ id: `o${i + 1}`, label }));
        const ans = await host.ask(task, question, options, true);
        const label = ans.text || ans.label || options.find((o) => o.id === ans.answer)?.label || ans.answer;
        return ok(`The user answered: ${label}`, { answer: ans.answer, label });
      }
      case "request_approval": {
        const amount = Number(a.amount_gbp);
        if (!Number.isFinite(amount) || amount < 0) return err("amount_gbp must be a number");
        const amountP = Math.round(amount * 100);
        const merchant = String(a.merchant ?? "unknown");
        const description = String(a.description ?? "");
        const ans = await host.approval(task, amountP, merchant, description);
        const approved = /^approve/.test(ans.answer);
        const verdict = approved ? "approve" : "hold";
        return ok(
          approved
            ? `Approved: you may pay £${(amountP / 100).toFixed(2)} to ${merchant}.`
            : `Not approved (${ans.label || ans.answer}${ans.text ? `: ${ans.text}` : ""}). Do NOT pay; stop and report.`,
          { answer: verdict, raw: ans.answer },
        );
      }
      case "finish": {
        const outcome = (["success", "partial", "failed"].includes(a.outcome) ? a.outcome : "success") as "success" | "partial" | "failed";
        const summary = String(a.summary ?? "").trim() || "Done.";
        let receipt: Buffer | undefined;
        try {
          const shot = await host.browser.screenshot();
          if (shot.url && shot.url !== "about:blank") receipt = shot.jpeg;
        } catch {
          /* no browser page */
        }
        const spent = Math.round(Number(a.spent_gbp) * 100);
        if (spent > task.spentP) host.spend(task, spent - task.spentP);
        closeStep(host, task, outcome === "failed" ? "failed" : "done");
        const answer = String(a.answer ?? "").trim() || undefined;
        task.result = { outcome, summary, answer, receipt, skillName: a.skill_name ? String(a.skill_name) : undefined, procedure: a.procedure ? String(a.procedure) : undefined };
        return ok("Task finished. Stop now; do not call further tools.");
      }
      default:
        return err(`Unknown tool ${name}`);
    }
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    return err(`${name} failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** "Billing · Polyform" → "Billing"; page titles lead with the page and end with the site. */
function shortTitle(title: string | undefined): string {
  return truncate(String(title ?? "").split(/\s+[·|–—-]\s+/)[0].trim(), 36);
}
function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}
