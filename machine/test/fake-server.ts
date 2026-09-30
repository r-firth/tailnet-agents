/**
 * A tiny stand-in for familiar-server's machine endpoint. It speaks the server side of the
 * machine protocol (docs/protocol.md), records everything agentd sends, and auto-answers
 * memory requests, asks and approvals.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type Msg = { type: string; [k: string]: any };

export interface FakeOptions {
  token?: string;
  /** answer for ask messages: option index (0-based) */
  askChoice?: number;
  /** answer id for approvals */
  approval?: "approve" | "hold" | "approve_always";
  /** don't answer asks/approvals automatically */
  manualAnswers?: boolean;
}

export class FakeServer {
  readonly messages: Msg[] = [];
  readonly memoryNotes: Msg[] = [];
  private http: http.Server;
  private wss: WebSocketServer;
  socket: WebSocket | null = null;
  port = 0;
  private waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  private claimSeq = 800;

  constructor(public opts: FakeOptions = {}) {
    this.http = http.createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Fake page</title><h1>Hello from the fake server</h1><button>Press me</button>");
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, sock, head) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname !== "/api/machines/connect" || u.searchParams.get("token") !== (this.opts.token ?? "secret")) {
        sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        sock.destroy();
        return;
      }
      this.wss.handleUpgrade(req, sock, head, (ws) => this.onSocket(ws));
    });
  }

  async start() {
    await new Promise<void>((r) => this.http.listen(0, "127.0.0.1", () => r()));
    this.port = (this.http.address() as AddressInfo).port;
  }

  get url() {
    return `ws://127.0.0.1:${this.port}`;
  }

  private onSocket(ws: WebSocket) {
    this.socket = ws;
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString()) as Msg;
      this.messages.push(m);
      this.autoReply(m);
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
  }

  private autoReply(m: Msg) {
    if (m.type === "memory") {
      let result: unknown;
      if (m.op === "search") {
        result = {
          hits: [
            { id: 812, score: 0.82, text: "Polyform Creator plan £16/mo on Visa 4242", kind: "subscription", source: { label: "Ryan, 3 Sep" } },
            { id: 640, score: 0.41, text: "Ryan prefers to decline retention offers", kind: "preference", source: null },
          ],
        };
      } else if (m.op === "note") {
        this.memoryNotes.push(m);
        result = { claim: { id: ++this.claimSeq, kind: m.kind, text: m.text, subject: m.subject } };
      } else result = { text: "" };
      this.send({ type: "memory.result", req_id: m.req_id, ok: true, result });
    }
    if (this.opts.manualAnswers) return;
    if (m.type === "ask") {
      const opt = m.options[this.opts.askChoice ?? 0] ?? m.options[0];
      setTimeout(() => this.send({ type: "answer", question_id: m.question_id, answer: opt.id, label: opt.label }), 50);
    }
    if (m.type === "approval") {
      const a = this.opts.approval ?? "approve";
      setTimeout(() => this.send({ type: "answer", question_id: m.question_id, answer: a, label: a === "hold" ? "Hold" : "Approve" }), 50);
    }
  }

  send(m: Msg) {
    this.socket?.send(JSON.stringify(m));
  }

  waitFor(pred: (m: Msg) => boolean, timeoutMs = 60_000, fromIndex = 0): Promise<Msg> {
    const existing = this.messages.slice(fromIndex).find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (m: Msg) => (clearTimeout(t), resolve(m)) };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timed out waiting for message; last: ${JSON.stringify(this.messages.slice(-3).map((x) => ({ ...x, data: x.data ? "…" : undefined, event: x.event ? { ...x.event, image: undefined } : undefined })))}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** All messages for a task. */
  forTask(taskId: string) {
    return this.messages.filter((m) => m.task_id === taskId);
  }

  events(taskId: string) {
    return this.forTask(taskId)
      .filter((m) => m.type === "event")
      .map((m) => m.event);
  }

  async runTask(taskId: string, brief: string, executor = "scripted", timeoutMs = 90_000, extra: Record<string, unknown> = {}) {
    const from = this.messages.length;
    this.send({ type: "task.start", task_id: taskId, brief, executor, context: { memory: [], procedures: [] }, time_cap_s: 600, ...extra });
    return this.waitFor((m) => (m.type === "task.done" || m.type === "task.failed") && m.task_id === taskId, timeoutMs, from);
  }

  async stop() {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    this.http.closeAllConnections();
    await new Promise((r) => this.http.close(() => r(null)));
  }
}
