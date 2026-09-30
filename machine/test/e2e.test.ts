import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeServer, type Msg } from "./fake-server.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/test
const dist = path.resolve(here, "..");
const MAIN = path.join(dist, "main.js");
const FAKE_CLAUDE = path.join(here, "fake-claude.js");
const FAKE_CODEX = path.join(here, "fake-codex.js");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentd-test-"));
const claudeState = path.join(home, "..", `${path.basename(home)}-claude-state`);
const codexPath = path.join(home, "..", `${path.basename(home)}-codex`); // exists only during the codex test
const server = new FakeServer({ token: "secret" });
let proc: ChildProcess;
let logs = "";

function isJpeg(b64: string) {
  return typeof b64 === "string" && b64.startsWith("/9j/");
}

function assertToolPairs(events: any[]) {
  const pending = events.filter((e) => e.kind === "tool" && e.status === "pending");
  assert.ok(pending.length > 0, "expected tool events");
  for (const p of pending) {
    const done = events.find((e) => e.kind === "tool" && e.call_id === p.call_id && e.status !== "pending");
    assert.ok(done, `tool ${p.tool} ${p.call_id} never completed`);
    assert.equal(typeof done.duration_ms, "number");
  }
}

describe("agentd end to end (fake server, scripted executor at 10x)", () => {
  before(async () => {
    await server.start();
    fs.writeFileSync(claudeState, "ok");
    fs.chmodSync(FAKE_CLAUDE, 0o755);
    const env = { ...process.env, FAMILIAR_SCRIPT_SPEED: "10", FAMILIAR_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_STATE: claudeState, FAMILIAR_CODEX_BIN: codexPath, FAMILIAR_LOG: "info" };
    delete (env as any).DISPLAY;
    proc = spawn(process.execPath, [MAIN, "--server", server.url, "--token", "secret", "--id", "m_test", "--name", "test", "--backend", "local", "--home", home], { env, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr!.on("data", (d) => (logs += d));
    proc.stdout!.on("data", (d) => (logs += d));
    await server.waitFor((m) => m.type === "hello", 60_000).catch((e) => {
      throw new Error(`${e.message}\n--- agentd logs ---\n${logs}`);
    });
  });

  after(async () => {
    if (proc.exitCode === null) {
      server.send({ type: "shutdown" });
      await new Promise((r) => {
        const t = setTimeout(() => (proc.kill("SIGKILL"), r(null)), 8000);
        proc.on("exit", () => (clearTimeout(t), r(null)));
      });
    }
    await server.stop();
    if (process.env.KEEP_TEST_HOME) console.log("home:", home);
    else fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(claudeState, { force: true });
    fs.rmSync(codexPath, { force: true });
  });

  it("says hello with specs and executors", async () => {
    const hello = server.messages.find((m) => m.type === "hello")!;
    assert.equal(hello.id, "m_test");
    assert.equal(hello.backend, "local");
    assert.ok(hello.specs.cpu > 0);
    assert.ok(hello.executors.includes("scripted"));
    assert.ok(hello.executors.includes("claude"));
    assert.ok(!hello.executors.includes("codex"));
    assert.equal(hello.has_desktop, false);
    await server.waitFor((m) => m.type === "stats", 5000);
    const stats = server.messages.find((m) => m.type === "stats")!.stats;
    for (const k of ["cpu_pct", "mem_gb", "net_mbs", "uptime_s"]) assert.equal(typeof stats[k], "number");
  });

  it("cancels the Polyform subscription (scenario a)", async () => {
    server.send({ type: "subscribe", task_id: "t_cancel", rate: "full" });
    const done = await server.runTask("t_cancel", "cancel my polyform sub");
    assert.equal(done.type, "task.done", JSON.stringify(done));
    assert.equal(done.outcome, "success");
    assert.match(done.summary, /Cancelled your Polyform Creator plan/);
    assert.ok(isJpeg(done.receipt_image), "receipt image");
    const ev = server.events("t_cancel");
    const kinds = new Set(ev.map((e) => e.kind));
    for (const k of ["step", "tool", "keyframe", "memory.recall", "memory.write"]) assert.ok(kinds.has(k), `missing ${k}`);
    assertToolPairs(ev);
    const tools = ev.filter((e) => e.kind === "tool" && e.status === "ok").map((e) => e.tool);
    for (const t of ["browser.navigate", "browser.click", "browser.snapshot", "browser.wait_for", "browser.screenshot"]) assert.ok(tools.includes(t), `missing ${t}`);
    const clicks = ev.filter((e) => e.kind === "tool" && e.tool === "browser.click" && e.status === "ok");
    assert.ok(clicks.some((c) => /No thanks|e\d+/.test(c.target)), "declined the retention offer");
    const keyframes = ev.filter((e) => e.kind === "keyframe");
    assert.ok(keyframes.length >= 5);
    for (const k of keyframes) {
      assert.ok(isJpeg(k.image));
      assert.match(k.url, /^http:\/\/polyform\.localhost:\d+/);
    }
    // steps: active then done with the same id
    const s1 = ev.filter((e) => e.kind === "step" && e.step_id === "s1").map((e) => e.state);
    assert.deepEqual(s1, ["active", "done"]);
    const writes = ev.filter((e) => e.kind === "memory.write");
    assert.ok(writes.some((w) => w.claim_kind === "procedure" && /How to cancel Polyform/.test(w.text)));
    assert.ok(writes.some((w) => w.claim_kind === "subscription" && /ends \d{1,2} \w{3} \d{4}/.test(w.text)));
    assert.ok(writes.every((w) => typeof w.claim_id === "number"));
    const recall = ev.find((e) => e.kind === "memory.recall");
    assert.equal(recall.hits.length, 2);
    const ups = server.forTask("t_cancel").filter((m) => m.type === "task.update");
    assert.ok(ups.some((u) => u.steps_estimate === 7 && typeof u.step === "number" && u.now));
    assert.ok(ups.some((u) => /cancelled/.test(u.waiting_for ?? "")), "waiting_for text");
    const frames = server.forTask("t_cancel").filter((m) => m.type === "frame");
    assert.ok(frames.length >= 3, `expected live frames, got ${frames.length}`);
    assert.ok(frames.every((f) => isJpeg(f.data) && f.w > 0 && f.h > 0));
    const full = frames.filter((f) => f.w === 1280 && f.h === 800).length;
    assert.ok(full >= frames.length / 2, `most frames should be 1280x800: ${frames.map((f) => `${f.w}x${f.h}`).join(" ")}`);
    const skill = fs.readFileSync(path.join(home, "skills", "cancel-polyform.md"), "utf8");
    assert.match(skill, /No thanks, cancel subscription/);
  });

  it("pays after approval (scenario b)", async () => {
    server.opts.approval = "approve";
    const done = await server.runTask("t_pay", "buy the studio lighting kit on polyform");
    assert.equal(done.outcome, "success", JSON.stringify(done));
    assert.match(done.summary, /Paid £142\.40 to Polyform/);
    const approval = server.forTask("t_pay").find((m) => m.type === "approval")!;
    assert.equal(approval.amount_p, 14240);
    assert.equal(approval.merchant, "Polyform");
    assertToolPairs(server.events("t_pay"));
    const spend = server.forTask("t_pay").filter((m) => m.type === "spend");
    assert.deepEqual(spend.map((m) => m.amount_p), [14240]);
  });

  it("books and pays for a train after approval (scenario b, rail)", async () => {
    const done = await server.runTask("t_rail", "book me the train to edinburgh and pay for it");
    assert.equal(done.outcome, "success", JSON.stringify(done));
    assert.match(done.summary, /Paid £142\.40 to Northline Rail/);
    assert.ok(isJpeg(done.receipt_image));
    const approval = server.forTask("t_rail").find((m) => m.type === "approval")!;
    assert.equal(approval.amount_p, 14240);
    assert.match(approval.description, /Edinburgh/);
    const kf = server.events("t_rail").filter((e) => e.kind === "keyframe");
    assert.ok(kf.some((k) => /^http:\/\/northline\.localhost:\d+\/checkout\/complete/.test(k.url)));
    assert.equal(server.forTask("t_rail").filter((m) => m.type === "spend").length, 1);
  });

  it("holds when the approval is held (scenario b)", async () => {
    server.opts.approval = "hold";
    const done = await server.runTask("t_hold", "pay for the polyform order");
    assert.equal(done.outcome, "partial");
    assert.match(done.summary, /nothing was charged/);
    assert.equal(server.forTask("t_hold").filter((m) => m.type === "spend").length, 0);
    const clicks = server.events("t_hold").filter((e) => e.kind === "tool" && e.tool === "browser.click");
    assert.ok(!clicks.some((c) => /Pay/.test(c.target)), "must not click pay");
    server.opts.approval = "approve";
  });

  it("installs software in the visible terminal (scenario c)", async () => {
    server.opts.askChoice = 1; // "4.6"
    const done = await server.runTask("t_install", "install blender");
    server.opts.askChoice = 0;
    assert.equal(done.outcome, "success", JSON.stringify(done));
    assert.match(done.summary, /Blender 4\.6/);
    const ask = server.forTask("t_install").find((m) => m.type === "ask")!;
    assert.deepEqual(
      ask.options.map((o: any) => o.label),
      ["4.5 LTS", "4.6"],
    );
    assert.equal(ask.allow_text, true);
    const term = server
      .forTask("t_install")
      .filter((m) => m.type === "terminal")
      .map((m) => m.data)
      .join("");
    assert.match(term, /blender --version/);
    assert.match(term, /Blender 4\.6\.0/);
    assert.doesNotMatch(term, /\x1b\]777;fam/, "markers are stripped from the viewer stream");
    assert.equal(fs.readFileSync(path.join(home, "opt", "blender", "VERSION"), "utf8").trim(), "blender 4.6");
    const installs = await server.waitFor((m) => m.type === "installs" && m.installs.some((i: string) => /blender 4\.6/.test(i)), 5000);
    assert.ok(installs);
    const shells = server.events("t_install").filter((e) => e.kind === "tool" && e.tool === "shell" && e.status === "ok");
    assert.ok(shells.length >= 4);
    assert.ok(shells.every((s) => /^exit 0/.test(s.result)));
  });

  it("does a generic run with real shell commands (scenario d)", async () => {
    const done = await server.runTask("t_generic", "what's up with this machine?");
    assert.equal(done.outcome, "success", JSON.stringify(done));
    const shells = server.events("t_generic").filter((e) => e.kind === "tool" && e.tool === "shell" && e.status !== "pending");
    assert.deepEqual(
      shells.map((s) => s.target),
      ["uname -a", "df -h ~", "ls ~"],
    );
    const term = server
      .forTask("t_generic")
      .filter((m) => m.type === "terminal")
      .map((m) => m.data)
      .join("");
    assert.match(term, /Linux/);
  });

  it("pauses while the user holds control and notes the hand-back", async () => {
    const from = server.messages.length;
    server.send({ type: "task.start", task_id: "t_ctl", brief: "look around", executor: "scripted", context: {}, time_cap_s: 600 });
    await server.waitFor((m) => m.type === "event" && m.task_id === "t_ctl" && m.event.kind === "tool", 30_000, from);
    server.send({ type: "control", task_id: "t_ctl", state: "taken" });
    await new Promise((r) => setTimeout(r, 400));
    const mark = server.messages.length;
    server.send({ type: "input", task_id: "t_ctl", input: { kind: "terminal", data: "echo typed-by-ryan\r" } });
    await new Promise((r) => setTimeout(r, 1500));
    const during = server.messages.slice(mark).filter((m) => m.type === "event" && m.task_id === "t_ctl");
    assert.equal(during.length, 0, `no events while control is taken: ${JSON.stringify(during.map((d) => d.event.kind + ":" + (d.event.tool ?? d.event.text)))}`);
    const typed = server.messages.slice(mark).filter((m) => m.type === "terminal").map((m) => m.data).join("");
    assert.match(typed, /typed-by-ryan/);
    server.send({ type: "control", task_id: "t_ctl", state: "released", note: "closed a popup" });
    const done = await server.runTask("t_ctl_wait", "noop").catch(() => null); // busy → immediate failure, proves one task at a time
    assert.equal(done?.type, "task.failed");
    const fin = await server.waitFor((m) => (m.type === "task.done" || m.type === "task.failed") && m.task_id === "t_ctl", 60_000, from);
    assert.equal(fin.type, "task.done");
    const handback = server.events("t_ctl").find((e) => e.kind === "step" && /took control and handed back: closed a popup/.test(e.text));
    assert.ok(handback);
  });

  it("cancels a running task", async () => {
    const from = server.messages.length;
    server.send({ type: "task.start", task_id: "t_x", brief: "cancel my polyform subscription", executor: "scripted", context: {}, time_cap_s: 600 });
    await server.waitFor((m) => m.type === "event" && m.task_id === "t_x" && m.event.kind === "tool", 30_000, from);
    server.send({ type: "task.cancel", task_id: "t_x" });
    const fin = await server.waitFor((m) => (m.type === "task.done" || m.type === "task.failed") && m.task_id === "t_x", 20_000, from);
    assert.equal(fin.type, "task.failed");
    assert.equal(fin.cancelled, true);
  });

  it("enforces the time cap", async () => {
    const done = await server.runTask("t_cap", "install slowthing", "scripted", 30_000, { time_cap_s: 0.3 });
    assert.equal(done.type, "task.failed");
    assert.match(done.error, /time cap/);
  });

  it("runs the claude executor through the familiar MCP server", async () => {
    fs.writeFileSync(claudeState, "ok");
    const done = await server.runTask("t_claude", "look around and open polyform", "claude");
    assert.equal(done.type, "task.done", JSON.stringify(done) + "\n" + logs.slice(-3000));
    assert.equal(done.outcome, "success");
    assert.match(done.summary, /Fake Claude/);
    const ev = server.events("t_claude");
    assertToolPairs(ev);
    const shell = ev.find((e) => e.kind === "tool" && e.tool === "shell" && e.status === "ok");
    assert.match(shell.result, /exit 0/);
    assert.ok(ev.some((e) => e.kind === "tool" && e.tool === "file.read" && e.target === "/etc/hostname" && e.status === "ok"));
    assert.ok(ev.some((e) => e.kind === "keyframe"));
    assert.ok(ev.some((e) => e.kind === "message" && /look around/.test(e.text)));
    assert.ok(ev.some((e) => e.kind === "step" && e.text === "Open Polyform"));
    const toks = server.forTask("t_claude").filter((m) => m.type === "task.update" && m.tokens);
    assert.ok(toks.length > 0 && toks[toks.length - 1].tokens >= 9000);
    const term = server.forTask("t_claude").filter((m) => m.type === "terminal").map((m) => m.data).join("");
    assert.match(term, /hello-from-claude/);
  });

  it("reports a clean failure when claude is not signed in", async () => {
    fs.writeFileSync(claudeState, "loggedout");
    const done = await server.runTask("t_claude_auth", "anything", "claude");
    assert.equal(done.type, "task.failed");
    assert.match(done.error, /isn't signed in/);
    fs.writeFileSync(claudeState, "badtoken");
    const done2 = await server.runTask("t_claude_auth2", "anything", "claude");
    assert.equal(done2.type, "task.failed");
    assert.match(done2.error, /isn't signed in/);
  });

  it("runs the codex executor through the familiar MCP server", async () => {
    fs.chmodSync(FAKE_CODEX, 0o755);
    fs.symlinkSync(FAKE_CODEX, codexPath); // symlink so its imports resolve from machine/node_modules
    try {
      const done = await server.runTask("t_codex_ok", "check the machine", "codex");
      assert.equal(done.type, "task.done", JSON.stringify(done) + "\n" + logs.slice(-3000));
      assert.equal(done.outcome, "success");
      assert.match(done.summary, /All good/);
      const ev = server.events("t_codex_ok");
      assertToolPairs(ev);
      assert.equal(ev.filter((e) => e.kind === "tool" && e.tool === "shell" && e.status === "pending").length, 2, "familiar shell recorded once + codex's own command");
      assert.ok(ev.some((e) => e.kind === "tool" && e.target === "bash -lc ls" && e.status === "ok"));
      assert.ok(ev.some((e) => e.kind === "step" && e.text === "Check the machine"));
      assert.ok(ev.some((e) => e.kind === "message" && /All good/.test(e.text)));
      const toks = server.forTask("t_codex_ok").filter((m) => m.type === "task.update" && m.tokens);
      assert.equal(toks.at(-1)?.tokens, 8600);
    } finally {
      fs.rmSync(codexPath, { force: true });
    }
  });

  it("reports a clean failure when codex is missing", async () => {
    const done = await server.runTask("t_codex", "anything", "codex");
    assert.equal(done.type, "task.failed");
    assert.match(done.error, /Codex CLI is not installed/);
  });

  it("serves the MCP stdio server: list tools, shell, browser_navigate", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(dist, "mcp.js")], env: { ...process.env, FAMILIAR_HOME: home } as Record<string, string> }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const n of ["shell", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_wait_for", "browser_screenshot", "memory_search", "memory_note", "ask_user", "request_approval", "step", "finish"]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    const sh: any = await client.callTool({ name: "shell", arguments: { command: "echo mcp-$((20+22))" } });
    assert.equal(sh.isError, false);
    assert.match(sh.content[0].text, /mcp-42/);
    assert.match(sh.content[0].text, /\[exit code: 0\]/);
    const bad: any = await client.callTool({ name: "shell", arguments: { command: "false" } });
    assert.match(bad.content[0].text, /exit code: 1/);
    const nav: any = await client.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${server.port}/page` } });
    assert.equal(nav.isError, false, JSON.stringify(nav));
    assert.match(nav.content[0].text, /Fake page/);
    const snap: any = await client.callTool({ name: "browser_snapshot", arguments: {} });
    assert.match(snap.content[0].text, /button "Press me" \[ref=e\d+\]/);
    const shot: any = await client.callTool({ name: "browser_screenshot", arguments: {} });
    assert.equal(shot.content[1].type, "image");
    await client.close();
  });

  it("reconnects after the server drops the socket", async () => {
    const helloCount = server.messages.filter((m: Msg) => m.type === "hello").length;
    server.socket?.terminate();
    await server.waitFor(() => server.messages.filter((m: Msg) => m.type === "hello").length > helloCount, 15_000);
  });
});
