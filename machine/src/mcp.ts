#!/usr/bin/env node
/**
 * `familiar` stdio MCP server for Claude Code / Codex. Every tool call is forwarded to the running
 * agentd over loopback HTTP, which executes it (visible terminal, shared Chrome, memory, asks) and
 * records it on the task timeline.
 *
 * Env: FAMILIAR_AGENTD_URL + FAMILIAR_AGENTD_TOKEN (or FAMILIAR_HOME to read <home>/.familiar/bridge.json),
 *      FAMILIAR_TASK_ID (the task the calls belong to).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tooldefs.js";
import { VERSION } from "./util.js";

function bridge(): { url: string; token: string } {
  if (process.env.FAMILIAR_AGENTD_URL && process.env.FAMILIAR_AGENTD_TOKEN) {
    return { url: process.env.FAMILIAR_AGENTD_URL, token: process.env.FAMILIAR_AGENTD_TOKEN };
  }
  const home = process.env.FAMILIAR_HOME || path.join(os.homedir(), ".familiar-machine");
  const j = JSON.parse(fs.readFileSync(path.join(home, ".familiar", "bridge.json"), "utf8"));
  return { url: j.url, token: j.token };
}

function post(body: unknown): Promise<any> {
  const b = bridge();
  const u = new URL("/call", b.url);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // node:http rather than fetch: calls may legitimately block for hours (asks, approvals, control lock).
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${b.token}`, "content-length": Buffer.byteLength(data) } },
      (res) => {
        let s = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (s += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(s));
          } catch {
            reject(new Error(`agentd returned HTTP ${res.statusCode}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const server = new Server({ name: "familiar", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    const r = await post({ task_id: process.env.FAMILIAR_TASK_ID || null, name, arguments: args });
    const content: any[] = [{ type: "text", text: String(r.text ?? "") }];
    if (r.image) content.push({ type: "image", data: r.image, mimeType: "image/jpeg" });
    return { content, isError: !r.ok };
  } catch (e) {
    return { content: [{ type: "text", text: `agentd is unreachable: ${(e as Error).message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
