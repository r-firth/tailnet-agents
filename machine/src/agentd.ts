import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge.js";
import { Browser } from "./browser.js";
import { Screen } from "./screen.js";
import { type Config, connectUrl } from "./config.js";
import { Connection } from "./conn.js";
import { DemoSite, SESSION_COOKIE, SESSION_VALUE } from "./demo-site.js";
import { claudeBin, runClaude } from "./executors/claude.js";
import { codexBin, runCodex } from "./executors/codex.js";
import { ExecutorError } from "./executors/common.js";
import { runScripted } from "./executors/scripted.js";
import { scanInstalls, specs, Stats } from "./stats.js";
import { type Answer, type Host, TaskRun } from "./task.js";
import { Terminal } from "./terminal.js";
import { callTool, closeStep, type ToolResult } from "./tools.js";
import { AbortedError, id, log, raceAbort, sleep, slug, VERSION } from "./util.js";

type Msg = { type: string; [k: string]: any };

export class Agentd implements Host {
  readonly conn: Connection;
  readonly browser: Browser;
  readonly screen: Screen | null;
  readonly terminal: Terminal;
  readonly demo: DemoSite;
  readonly bridge: { url: string; token: string } = { url: "", token: "" };
  readonly mcpScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp.js");
  private bridgeSrv: Bridge;
  private stats = new Stats();
  task: TaskRun | null = null;
  private control = { taken: false, note: "", waiters: [] as Array<() => void>, buffer: [] as Msg[], seq: 0 };
  private answers = new Map<string, { taskId: string; resolve: (a: Answer) => void }>();
  private memReqs = new Map<string, (r: { ok: boolean; result: any }) => void>();
  private installs: string[] = [];
  private subscription: { taskId: string | null; rate: "full" | "tile" } = { taskId: null, rate: "tile" };
  private timers: NodeJS.Timeout[] = [];
  private termBuf = "";
  private termTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(readonly cfg: Config) {
    this.conn = new Connection(connectUrl(cfg), () => this.hello());
    this.browser = new Browser(path.join(cfg.home, ".config", "familiar-chrome"));
    // With a display, agents use the real screen and their own tools; Playwright's browser is only for the scripted demo.
    this.screen = process.env.DISPLAY && !process.env.FAMILIAR_PLAYWRIGHT ? new Screen(process.env.DISPLAY, path.join(cfg.home, ".config", "familiar-chrome")) : null;
    this.terminal = new Terminal(cfg.home, cfg.name);
    this.demo = new DemoSite(cfg.scriptSpeed);
    this.bridgeSrv = new Bridge((taskId, name, args) => this.bridgeCall(taskId, name, args));
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    for (const d of ["", "skills", "opt", ".familiar", ".config"]) fs.mkdirSync(path.join(this.cfg.home, d), { recursive: true });
    await this.demo.start();
    await this.bridgeSrv.start(this.cfg.home);
    Object.assign(this.bridge, { url: this.bridgeSrv.url, token: this.bridgeSrv.token });
    this.terminal.onOutput((d) => this.onTerminal(d));
    await this.terminal.start().catch((e) => log("error", "terminal failed to start", e));
    const sink = (data: string, w: number, h: number) => {
      const t = this.task;
      if (t) this.conn.send({ type: "frame", task_id: t.id, data, w, h });
    };
    if (this.screen) {
      this.screen.onFrame = sink;
      await this.screen.start().catch((e) => log("error", "screen capture failed to start", e));
    } else {
      this.browser.onFrame = sink;
      await this.browser.start().catch((e) => log("error", "browser failed to start (will retry on first use)", e));
    }
    await this.demoLogin();
    this.installs = scanInstalls(this.cfg.home);
    this.conn.on("message", (m: Msg) => void this.onMessage(m).catch((e) => log("error", `handling ${m.type} failed`, e)));
    this.conn.on("open", () => this.onOpen());
    this.conn.start();
    this.timers.push(setInterval(() => this.conn.connected && this.conn.send({ type: "stats", stats: this.stats.sample() }), 2000));
    this.timers.push(setInterval(() => this.refreshInstalls(), 15_000));
  }

  private hello(): Msg {
    const executors = ["scripted"];
    if (claudeBin()) executors.unshift("claude");
    if (codexBin()) executors.splice(executors.length - 1, 0, "codex");
    return {
      type: "hello",
      id: this.cfg.id,
      name: this.cfg.name,
      backend: this.cfg.backend,
      specs: specs(this.cfg.home),
      has_desktop: this.cfg.hasDesktop,
      desktop_url: this.cfg.desktopUrl,
      executors,
      version: VERSION,
      task_id: this.task?.id ?? null,
      installs: this.installs,
    };
  }

  private onOpen() {
    this.conn.send({ type: "installs", installs: this.installs });
    const t = this.task;
    if (t) this.update(t, { now: t.activeStep?.text ?? "Working", step: t.stepNo, tokens: t.tokens });
  }

  async shutdown(code = 0) {
    if (this.stopping) return;
    this.stopping = true;
    log("info", "shutting down");
    const t = this.task;
    if (t) {
      t.cancel("shutdown");
      for (let i = 0; i < 50 && this.task; i++) await sleep(100);
    }
    for (const timer of this.timers) clearInterval(timer);
    await this.conn.close();
    await this.browser.close();
    await this.screen?.close();
    this.terminal.kill();
    this.bridgeSrv.stop();
    this.demo.stop();
    process.exit(code);
  }

  // ---------------------------------------------------------------- server messages

  private async onMessage(m: Msg) {
    switch (m.type) {
      case "task.start":
        return this.runTask(m);
      case "task.cancel":
        if (this.task && (!m.task_id || m.task_id === this.task.id)) this.task.cancel("cancelled");
        return;
      case "answer": {
        const p = this.answers.get(m.question_id);
        if (p) {
          this.answers.delete(m.question_id);
          p.resolve({ answer: String(m.answer ?? ""), label: m.label, text: m.text });
        }
        return;
      }
      case "memory.result": {
        const r = this.memReqs.get(m.req_id);
        if (r) {
          this.memReqs.delete(m.req_id);
          r({ ok: m.ok !== false, result: m.result });
        }
        return;
      }
      case "control":
        return this.onControl(m);
      case "input":
        return this.onInput(m);
      case "subscribe": {
        const rate = m.rate === "full" || m.rate === "tile" ? m.rate : m.task_id && m.task_id === this.task?.id ? "full" : "tile";
        this.subscription = { taskId: m.task_id ?? null, rate };
        this.applyRate();
        return;
      }
      case "backup":
        return this.backup();
      case "shutdown":
        return this.shutdown(0);
      default:
        log("debug", `ignoring message ${m.type}`);
    }
  }

  private applyRate() {
    const t = this.task;
    const s = this.subscription;
    const rate = this.control.taken ? "full" : t && (s.taskId === t.id || s.taskId === null) ? s.rate : "tile";
    (this.screen ?? this.browser).setRate(rate);
  }

  // ---------------------------------------------------------------- tasks

  private async runTask(m: Msg) {
    const taskId = String(m.task_id ?? "");
    if (!taskId) return;
    if (this.task) {
      this.conn.send({ type: "task.failed", task_id: taskId, error: `Machine ${this.cfg.name} is busy with another task.` });
      return;
    }
    const executor = String(m.executor || "scripted");
    const cap = Number(m.time_cap_s) > 0 ? Number(m.time_cap_s) : this.cfg.defaultTimeCapS;
    const task = new TaskRun(taskId, String(m.brief ?? ""), executor, m.context ?? {}, cap);
    this.task = task;
    this.applyRate();
    log("info", `task ${taskId} started (${executor}): ${task.brief.slice(0, 120)}`);
    const capTimer = setTimeout(() => task.cancel("time cap"), cap * 1000);
    this.update(task, { now: "Getting started", step: 0 });
    await this.demoLogin();
    try {
      if (executor === "scripted") await runScripted(this, task);
      else if (executor === "claude") await runClaude(this, task);
      else if (executor === "codex") await runCodex(this, task);
      else throw new ExecutorError(`Unknown executor "${executor}".`);
      if (task.signal.aborted) throw task.signal.reason;
      if (!task.result) task.result = { outcome: "partial", summary: "The executor stopped without reporting a result." };
      this.finishTask(task);
    } catch (e) {
      const reason = task.signal.aborted ? (task.signal.reason as AbortedError)?.reason ?? "cancelled" : null;
      closeStep(this, task, "failed");
      this.flushControlBuffer();
      if (reason === "time cap") {
        this.conn.send({ type: "task.failed", task_id: task.id, error: `Stopped at the ${Math.round(cap / 60)}-minute time cap.` });
      } else if (reason) {
        this.conn.send({ type: "task.failed", task_id: task.id, error: reason === "shutdown" ? "The machine shut down." : "Cancelled.", cancelled: reason === "cancelled" });
      } else if (e instanceof ExecutorError) {
        this.conn.send({ type: "task.failed", task_id: task.id, error: e.message });
      } else {
        log("error", `task ${task.id} crashed`, e);
        this.conn.send({ type: "task.failed", task_id: task.id, error: `agentd error: ${(e as Error)?.message ?? String(e)}` });
      }
      log("info", `task ${task.id} ended: ${reason ?? (e as Error)?.message}`);
    } finally {
      clearTimeout(capTimer);
      for (const [qid, p] of this.answers) if (p.taskId === task.id) this.answers.delete(qid);
      if (this.control.taken) {
        this.control.taken = false;
        this.control.waiters.splice(0).forEach((w) => w());
      }
      this.flushControlBuffer();
      this.task = null;
      this.applyRate();
      this.refreshInstalls();
    }
  }

  /** The demo sites count as "already logged in" (a saved session cookie), whatever the executor. */
  private async demoLogin() {
    if (this.screen) return; // the scripted demo uses Playwright's browser, which a screen machine doesn't run
    await this.browser.addCookies([{ name: SESSION_COOKIE, value: SESSION_VALUE, url: this.demo.origin }]).catch(() => {});
  }

  private finishTask(task: TaskRun) {
    const r = task.result!;
    closeStep(this, task, r.outcome === "failed" ? "failed" : "done");
    this.flushControlBuffer();
    try {
      this.writeSkills(task);
    } catch (e) {
      log("warn", "could not write skills", e);
    }
    this.conn.send({ type: "task.done", task_id: task.id, outcome: r.outcome, summary: r.summary, ...(r.answer ? { answer: r.answer } : {}), ...(r.receipt ? { receipt_image: r.receipt.toString("base64") } : {}) });
    log("info", `task ${task.id} done: ${r.outcome} — ${r.summary}`);
  }

  private writeSkills(task: TaskRun) {
    const r = task.result!;
    const dir = path.join(this.cfg.home, "skills");
    const write = (name: string, title: string, body: string) => {
      const file = path.join(dir, `${slug(name)}.md`);
      const doc = `---\nname: ${slug(name)}\nlearned_from: ${task.id}\nupdated: ${new Date().toISOString()}\n---\n# ${title}\n\n${body.trim()}\n`;
      fs.writeFileSync(file, doc);
      log("info", `saved skill ${file}`);
    };
    if (r.procedure) {
      const notes = task.procedures.map((p) => `> ${p.text}`).join("\n");
      write(r.skillName || task.procedures[0]?.subject || task.brief, r.skillName ? r.skillName.replace(/-/g, " ") : task.brief, `${r.summary}\n\n## Procedure\n${r.procedure}${notes ? `\n\n## Notes\n${notes}` : ""}`);
      return;
    }
    for (const p of task.procedures) {
      const m = /^how to ([^:]+):/i.exec(p.text);
      const name = m ? m[1] : p.subject || task.brief;
      write(name, m ? `How to ${m[1]}` : name, p.text);
    }
  }

  private bridgeCall(taskId: string | null, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    let t = this.task;
    if (taskId && t && taskId !== t.id) return Promise.resolve({ ok: false, text: "This task is no longer running on this machine. Stop now." });
    if (taskId && !t) return Promise.resolve({ ok: false, text: "This task is no longer running on this machine. Stop now." });
    if (!t) t = new TaskRun("adhoc", "", "mcp", {}, 3600); // tool calls with no task (debugging, tests): nothing is reported
    return callTool(this, t, name, args);
  }

  // ---------------------------------------------------------------- Host implementation

  send(msg: Msg) {
    this.conn.send(msg);
  }

  event(task: TaskRun, ev: Record<string, unknown>) {
    if (task.id === "adhoc") return;
    const msg = { type: "event", task_id: task.id, event: ev };
    if (this.control.taken && this.task === task) this.control.buffer.push(msg);
    else this.conn.send(msg);
  }

  update(task: TaskRun, fields: Record<string, unknown>) {
    if (task.id === "adhoc") return;
    this.conn.send({ type: "task.update", task_id: task.id, ...fields });
  }

  gate(task: TaskRun): Promise<void> {
    if (!this.control.taken || task !== this.task) return Promise.resolve();
    return raceAbort(new Promise<void>((resolve) => this.control.waiters.push(resolve)), task.signal);
  }

  async memory(task: TaskRun, op: "search" | "note" | "packet", fields: Record<string, unknown>) {
    const req_id = id("r_");
    const p = new Promise<{ ok: boolean; result: any }>((resolve) => {
      this.memReqs.set(req_id, resolve);
      setTimeout(() => {
        if (this.memReqs.delete(req_id)) resolve({ ok: false, result: null });
      }, 20_000);
    });
    this.conn.send({ type: "memory", req_id, op, task_id: task.id === "adhoc" ? null : task.id, ...fields });
    return raceAbort(p, task.signal);
  }

  private waitAnswer(task: TaskRun, qid: string): Promise<Answer> {
    const p = new Promise<Answer>((resolve) => this.answers.set(qid, { taskId: task.id, resolve }));
    return raceAbort(p, task.signal).finally(() => this.answers.delete(qid));
  }

  async ask(task: TaskRun, question: string, options: { id: string; label: string }[], allowText: boolean): Promise<Answer> {
    const question_id = id("q_");
    this.update(task, { waiting_for: "your answer" });
    const p = this.waitAnswer(task, question_id);
    this.conn.send({ type: "ask", task_id: task.id, question_id, question, options, allow_text: allowText });
    try {
      return await p;
    } finally {
      if (!task.signal.aborted) this.update(task, { waiting_for: null });
    }
  }

  async approval(task: TaskRun, amountP: number, merchant: string, description: string): Promise<Answer> {
    const question_id = id("q_");
    this.update(task, { waiting_for: `approval: £${(amountP / 100).toFixed(2)} to ${merchant}` });
    const p = this.waitAnswer(task, question_id);
    this.conn.send({ type: "approval", task_id: task.id, question_id, amount_p: amountP, merchant, description });
    try {
      return await p;
    } finally {
      if (!task.signal.aborted) this.update(task, { waiting_for: null });
    }
  }

  refreshInstalls() {
    const now = scanInstalls(this.cfg.home);
    if (JSON.stringify(now) !== JSON.stringify(this.installs)) {
      this.installs = now;
      this.conn.send({ type: "installs", installs: now });
    }
  }

  spend(task: TaskRun, amountP: number) {
    if (task.id === "adhoc" || !(amountP > 0)) return;
    task.spentP += amountP;
    this.conn.send({ type: "spend", task_id: task.id, amount_p: amountP });
  }

  pause(task: TaskRun, ms: number) {
    return sleep(ms / this.cfg.scriptSpeed, task.signal);
  }

  // ---------------------------------------------------------------- control lock & input

  private onControl(m: Msg) {
    const t = this.task;
    if (!t || (m.task_id && m.task_id !== t.id)) return;
    if (m.state === "taken") {
      this.control.taken = true;
      this.control.note = String(m.note ?? "");
      log("info", `control taken on ${t.id}`);
    } else if (m.state === "released" && this.control.taken) {
      this.control.taken = false;
      const note = String(m.note ?? "").trim();
      const text = `${this.cfg.ownerName} took control and handed back${note ? `: ${note}` : ""}`;
      this.conn.send({ type: "event", task_id: t.id, event: { kind: "step", actor: "agent", text, state: "done", step_id: `ctl${++this.control.seq}` } });
      this.flushControlBuffer();
      this.control.waiters.splice(0).forEach((w) => w());
      log("info", `control released on ${t.id}`);
    }
    this.applyRate();
  }

  private flushControlBuffer() {
    for (const msg of this.control.buffer.splice(0)) this.conn.send(msg);
  }

  private async onInput(m: Msg) {
    const t = this.task;
    const allowed = t ? this.control.taken && (!m.task_id || m.task_id === t.id) : true;
    if (!allowed || !m.input) return;
    const input = m.input;
    if (input.kind === "terminal") {
      if (typeof input.data === "string") this.terminal.write(input.data);
      return;
    }
    if (input.kind === "resize" && input.cols && input.rows) {
      this.terminal.resize(Number(input.cols), Number(input.rows));
      return;
    }
    await (this.screen ?? this.browser).input(input).catch((e: Error) => log("warn", "input failed", e.message));
  }

  private onTerminal(d: string) {
    this.termBuf += d;
    if (this.termTimer) return;
    this.termTimer = setTimeout(() => {
      this.termTimer = null;
      const data = this.termBuf;
      this.termBuf = "";
      if (data) this.conn.send({ type: "terminal", task_id: this.task?.id ?? null, data });
    }, 30);
  }

  // ---------------------------------------------------------------- backup

  private backup() {
    const dir = path.join(this.cfg.home, ".familiar", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `home-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
    const excludes = ["./.familiar/backups", "./.cache", "./.config/familiar-chrome/Default/Cache", "./.config/familiar-chrome/Default/Code Cache", "./.config/familiar-chrome/Default/Service Worker/CacheStorage"];
    execFile("tar", ["czf", file, ...excludes.map((e) => `--exclude=${e}`), "-C", this.cfg.home, "."], { timeout: 600_000 }, (err) => {
      let bytes = 0;
      try {
        bytes = fs.statSync(file).size;
      } catch {
        /* failed */
      }
      // tar exits 1 when files change while reading (Chrome); the archive is still usable.
      const ok = !err || ((err as any).code === 1 && bytes > 0);
      this.conn.send({ type: "backup.done", ok, path: file, bytes, at: new Date().toISOString(), ...(ok ? {} : { error: err?.message }) });
      const old = fs.readdirSync(dir).filter((f) => f.startsWith("home-")).sort().slice(0, -3);
      for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    });
  }
}
