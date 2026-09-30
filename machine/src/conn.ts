import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log } from "./util.js";

/** Messages that are fine to drop while disconnected (live-only). */
const EPHEMERAL = new Set(["frame", "stats", "terminal"]);
const MAX_QUEUE = 5000;

/**
 * Outbound WebSocket to the Familiar server with exponential backoff.
 * Durable messages (events, task updates, asks...) are queued while offline and flushed on reconnect.
 */
export class Connection extends EventEmitter {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private attempt = 0;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private url: string,
    private hello: () => object,
  ) {
    super();
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start() {
    this.closed = false;
    this.open();
  }

  private open() {
    if (this.closed) return;
    const safeUrl = this.url.replace(/token=[^&]*/, "token=***");
    log("info", `connecting to ${safeUrl}`);
    const ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: 10_000 });
    this.ws = ws;
    let alive = true;
    let ping: NodeJS.Timeout | null = null;
    ws.on("open", () => {
      this.attempt = 0;
      log("info", "connected");
      ws.send(JSON.stringify(this.hello()));
      const pending = this.queue;
      this.queue = [];
      for (const m of pending) ws.send(m);
      ping = setInterval(() => {
        if (!alive) {
          log("warn", "server stopped answering pings; reconnecting");
          ws.terminate();
          return;
        }
        alive = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }, 20_000);
      this.emit("open");
    });
    ws.on("pong", () => (alive = true));
    ws.on("message", (data) => {
      alive = true;
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        log("warn", "ignoring non-JSON message");
        return;
      }
      if (msg && typeof msg.type === "string") this.emit("message", msg);
    });
    ws.on("unexpected-response", (_req, res) => {
      log("warn", `server refused the connection: HTTP ${res.statusCode}`);
    });
    ws.on("error", (err) => log("warn", `socket error: ${err.message}`));
    ws.on("close", (code) => {
      if (ping) clearInterval(ping);
      if (this.ws === ws) this.ws = null;
      this.emit("close");
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
      this.attempt = Math.min(this.attempt + 1, 8);
      log("info", `disconnected (${code}); retrying in ${Math.round(delay)}ms`);
      this.timer = setTimeout(() => this.open(), delay);
    });
  }

  send(msg: { type: string; [k: string]: unknown }) {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Drop live frames when the socket is backed up rather than growing memory.
      if (msg.type === "frame" && this.ws.bufferedAmount > 4 * 1024 * 1024) return;
      this.ws.send(s);
      return;
    }
    if (EPHEMERAL.has(msg.type)) return;
    this.queue.push(s);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    if (!ws) return;
    // Give queued sends a moment to flush.
    const start = Date.now();
    while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close(1000, "bye");
  }
}
