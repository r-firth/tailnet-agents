import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "./tools.js";
import { log } from "./util.js";

export type BridgeHandler = (taskId: string | null, name: string, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Loopback HTTP endpoint the stdio MCP server (dist/mcp.js) forwards tool calls to.
 * Calls may block for a long time (ask_user, approvals, control lock), so there is no request timeout.
 */
export class Bridge {
  readonly token = randomBytes(18).toString("hex");
  private server: http.Server;
  url = "";

  constructor(private handler: BridgeHandler) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    this.server.keepAliveTimeout = 5_000;
  }

  async start(home: string) {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    const file = path.join(home, ".familiar", "bridge.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: this.url, token: this.token, pid: process.pid }), { mode: 0o600 });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const reply = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${this.token}`) return reply(401, { error: "unauthorized" });
    if (req.method !== "POST" || req.url !== "/call") return reply(404, { error: "not found" });
    let body = "";
    for await (const c of req) body += c;
    let msg: { task_id?: string; name?: string; arguments?: Record<string, unknown> };
    try {
      msg = JSON.parse(body);
    } catch {
      return reply(400, { error: "bad json" });
    }
    try {
      const r = await this.handler(msg.task_id ?? null, String(msg.name ?? ""), msg.arguments ?? {});
      reply(200, r);
    } catch (e) {
      log("debug", "bridge call failed", (e as Error).message);
      reply(200, { ok: false, text: `The task was stopped (${(e as Error).message}). Stop working now.` } satisfies ToolResult);
    }
  }

  stop() {
    this.server.closeAllConnections?.();
    this.server.close();
  }
}
