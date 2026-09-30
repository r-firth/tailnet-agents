#!/usr/bin/env node
/**
 * Stand-in for the `codex` CLI used by tests. `codex login status` succeeds. `codex exec --json … -`
 * parses the `-c mcp_servers.familiar.*` overrides exactly as agentd passes them (TOML values),
 * connects to the familiar MCP server, drives a few tools and prints `codex exec --json` JSONL.
 */
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
if (argv[0] === "login" && argv[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (argv[0] !== "exec" || !argv.includes("--json") || !argv.includes("--dangerously-bypass-approvals-and-sandbox") || argv.at(-1) !== "-") {
  console.error("fake codex: unexpected args " + JSON.stringify(argv));
  process.exit(2);
}
const cfg: Record<string, string> = {};
argv.forEach((a, i) => {
  if (a === "-c") {
    const [k, ...v] = argv[i + 1].split("=");
    cfg[k] = v.join("=");
  }
});
// Minimal TOML: basic strings, arrays of strings, inline tables of strings.
const tomlToJson = (v: string) => v.replace(/([{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/g, '$1"$2":');
const command = JSON.parse(cfg["mcp_servers.familiar.command"]);
const args = JSON.parse(cfg["mcp_servers.familiar.args"]);
const env = JSON.parse(tomlToJson(cfg["mcp_servers.familiar.env"]));
const prompt = fs.readFileSync(0, "utf8");
if (!prompt.includes("# Task")) throw new Error("prompt missing");

const client = new Client({ name: "fake-codex", version: "0" });
await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } as Record<string, string> }));
out({ type: "thread.started", thread_id: "thr_fake" });
out({ type: "turn.started" });
out({ type: "error", message: "Reconnecting... 1/5 (transient)" });
out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } });
await client.callTool({ name: "step", arguments: { text: "Check the machine" } });
out({ type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: "familiar", tool: "shell", status: "in_progress" } });
const r: any = await client.callTool({ name: "shell", arguments: { command: "echo hello-from-codex" } });
out({ type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "familiar", tool: "shell", status: "completed", result: r } });
out({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "bash -lc ls", aggregated_output: "", status: "in_progress" } });
out({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "bash -lc ls", aggregated_output: "opt\nskills\n", exit_code: 0, status: "completed" } });
out({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: "All good: the machine answers." } });
out({ type: "turn.completed", usage: { input_tokens: 12000, cached_input_tokens: 4000, output_tokens: 600 } });
await client.close();
process.exit(0);
