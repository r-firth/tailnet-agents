#!/usr/bin/env node
/**
 * Stand-in for the `claude` CLI used by tests. `claude auth status` reports login state from
 * $FAKE_CLAUDE_STATE ("loggedout" | anything else). `claude -p … --mcp-config <json>` reads the
 * prompt from stdin, connects to the familiar MCP server exactly as Claude Code would, drives a few
 * tools, and prints Claude-Code-shaped stream-json.
 */
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const state = process.env.FAKE_CLAUDE_STATE ? fs.readFileSync(process.env.FAKE_CLAUDE_STATE, "utf8").trim() : "ok";
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

if (argv[0] === "auth" && argv[1] === "status") {
  out({ loggedIn: state !== "loggedout" && state !== "badtoken", authMethod: "claude.ai" });
  process.exit(state === "loggedout" ? 1 : 0);
}

const prompt = fs.readFileSync(0, "utf8");
const session = "sess_fake";

if (state === "badtoken") {
  out({ type: "system", subtype: "init", session_id: session, mcp_servers: [] });
  out({ type: "assistant", message: { id: "m0", content: [{ type: "text", text: "Invalid API key · Please run /login" }] }, error: "authentication_failed" });
  out({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" });
  process.exit(1);
}

const cfgIdx = argv.indexOf("--mcp-config");
const cfg = JSON.parse(argv[cfgIdx + 1]).mcpServers.familiar;
const client = new Client({ name: "fake-claude", version: "0" });
await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env } as Record<string, string> }));
out({ type: "system", subtype: "init", session_id: session, mcp_servers: [{ name: "familiar", status: "connected" }] });

let n = 0;
async function use(name: string, input: Record<string, unknown>) {
  const id = `toolu_${++n}`;
  out({ type: "assistant", message: { id: `msg_${n}`, content: [{ type: "tool_use", id, name: `mcp__familiar__${name}`, input }], usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 } } });
  const r: any = await client.callTool({ name, arguments: input });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: r.content, is_error: !!r.isError }] } });
  return r;
}

out({ type: "assistant", message: { id: "msg_0", content: [{ type: "text", text: "I'll look around the machine first." }], usage: { input_tokens: 900, output_tokens: 20 } } });
await use("step", { text: "Look around the machine", steps_estimate: 2 });
await use("shell", { command: "echo hello-from-claude && pwd" });
// a built-in (non-familiar) tool, as Claude Code would report it
out({ type: "assistant", message: { id: "msg_r", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/etc/hostname" } }], usage: { input_tokens: 10, output_tokens: 5 } } });
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "box\n" }] } });
const origin = /runs at (http:\/\/polyform\.localhost:\d+)/.exec(prompt)?.[1];
await use("step", { text: "Open Polyform" });
await use("browser_navigate", { url: `${origin}/` });
const snap: any = await use("browser_snapshot", {});
if (!String(snap.content?.[0]?.text).includes("[ref=")) throw new Error("snapshot has no refs");
await use("finish", { outcome: "success", summary: "Fake Claude looked around and opened Polyform." });
out({ type: "result", subtype: "success", is_error: false, result: "Done.", usage: { input_tokens: 9000, output_tokens: 400, cache_creation_input_tokens: 100 } });
await client.close();
process.exit(0);
