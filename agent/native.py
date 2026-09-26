"""Codex app-server and ACP transports; execution stays on the selected device."""

import json
import os
import queue
import re
import shlex
import subprocess
import threading
import time
import uuid
from collections import deque


def emit(kind, **payload):
    print(json.dumps({"type": kind, **payload}), flush=True)


def launch(provider, target, cwd, reverse=None, arguments=None):
    if provider not in {"codex", "copilot", "claude"}:
        raise ValueError("Unknown agent provider")
    if "\0" in cwd or (cwd and not cwd.startswith("/")):
        raise ValueError("Use an absolute project directory")
    arguments = arguments or (
        ["codex", "-c", 'web_search="live"', "app-server", "--listen", "stdio://"]
        if provider == "codex"
        else ["copilot", "--acp", "--stdio"]
        if provider == "copilot"
        else ["claude"]
    )
    if not target:
        return arguments
    if not re.fullmatch(r"[a-zA-Z0-9._@:\[\]-]{1,253}", target) or target.startswith(
        "-"
    ):
        raise ValueError("Invalid SSH target")
    command = 'export PATH="$PATH:$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin"; '
    command += (
        f"cd {shlex.quote(cwd) if cwd else '$HOME'} && exec {shlex.join(arguments)}"
    )
    ssh = [
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
    ]
    if reverse:
        remote, local = reverse
        ssh += [
            "-o",
            "ExitOnForwardFailure=yes",
            "-R",
            f"127.0.0.1:{remote}:127.0.0.1:{local}",
        ]
    return [*ssh, "--", target, command]


class AcpClient:
    """A single reader dispatches interleaved ACP responses, updates and requests."""

    def __init__(self, command, on_update, on_request):
        env = os.environ.copy()
        for key in ("HUB_TOKEN", "HUB_MCP_TOKEN", "OPENROUTER_API_KEY"):
            env.pop(key, None)
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.update = on_update
        self.request_handler = on_request
        self.sequence = 0
        self.errors = deque(maxlen=20)
        self.reader = threading.Thread(target=self._stderr, daemon=True)
        self.reader.start()
        self.messages = queue.Queue()
        self.output_reader = threading.Thread(target=self._stdout, daemon=True)
        self.output_reader.start()

    def _stdout(self):
        try:
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        except (ValueError, OSError) as error:
            self.messages.put(error)
        finally:
            self.messages.put(None)

    def _stderr(self):
        for line in self.process.stderr:
            self.errors.append(line.strip()[:500])

    def send(self, message):
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
        self.process.stdin.flush()

    def request(self, method, params, timeout=120):
        self.sequence += 1
        identity = self.sequence
        self.send({"id": identity, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            try:
                message = self.messages.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty as error:
                raise TimeoutError(f"Agent timed out during {method}") from error
            if message is None:
                detail = "\n".join(self.errors)[-1500:]
                raise RuntimeError(f"Agent disconnected during {method}. {detail}")
            if isinstance(message, Exception):
                raise RuntimeError(
                    "Agent sent an invalid protocol message"
                ) from message
            if "method" in message:
                if "id" in message:
                    try:
                        result = self.request_handler(
                            message["method"], message.get("params", {})
                        )
                        self.send({"id": message["id"], "result": result})
                    except (ValueError, RuntimeError) as error:
                        self.send(
                            {
                                "id": message["id"],
                                "error": {"code": -32601, "message": str(error)},
                            }
                        )
                elif message["method"] == "session/update":
                    self.update(message.get("params", {}))
                continue
            if message.get("id") == identity:
                if "error" in message:
                    raise RuntimeError(
                        message["error"].get("message", "Agent request failed")
                    )
                return message.get("result", {})

    def close(self):
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.reader.join(timeout=1)
        self.output_reader.join(timeout=1)
        self.process.stdout.close()
        self.process.stderr.close()


def run_acp(command, agent, prompt, servers, request_input):
    loading = True
    text = ""
    identity = str(uuid.uuid4())
    tools = {}
    session_id = agent.get("native_id")

    def update(params):
        nonlocal text, identity
        if loading or params.get("sessionId") != session_id:
            return
        value = params.get("update", {})
        kind = value.get("sessionUpdate")
        if (
            kind == "agent_message_chunk"
            and value.get("content", {}).get("type") == "text"
        ):
            if not text:
                emit("message.started", message_id=identity, text="", source="copilot")
            delta = value["content"]["text"]
            text += delta
            emit("message.delta", message_id=identity, delta=delta, source="copilot")
        elif kind in {"tool_call", "tool_call_update"}:
            # Seal preceding commentary before placing the tool in the chat.
            if text:
                emit("message", message_id=identity, text=text, source="copilot")
                text = ""
                identity = str(uuid.uuid4())
            item = value["toolCallId"]
            call = tools.setdefault(item, {})
            first = not call
            call.update(value)
            receipt = {
                "name": call.get("kind", "tool"),
                "source": "copilot",
                "item_id": item,
                "thread_id": session_id,
                "arguments": {
                    "title": call.get("title"),
                    "input": call.get("rawInput"),
                },
            }
            if first:
                emit("tool.started", **receipt)
            if call.get("status") in {"completed", "failed"}:
                content = call.get("content", [])
                output = "\n".join(
                    part.get("content", {}).get("text", "")
                    for part in content
                    if part.get("type") == "content"
                )
                emit(
                    "tool.result",
                    **receipt,
                    result={
                        "ok": call["status"] == "completed",
                        "result": {**call, "aggregatedOutput": output},
                    },
                )
        elif kind == "session_info_update" and value.get("title"):
            emit("title", name=value["title"])

    def request(method, params):
        if method == "session/request_permission":
            answer = request_input(
                {
                    "title": params.get("toolCall", {}).get(
                        "title", "Agent needs permission"
                    ),
                    "detail": json.dumps(params.get("toolCall", {})),
                    "options": [
                        {"id": option["optionId"], "label": option["name"]}
                        for option in params["options"]
                    ],
                }
            )
            return {"outcome": {"outcome": "selected", "optionId": answer["choice"]}}
        raise ValueError(f"Unsupported ACP client request: {method}")

    client = AcpClient(command, update, request)
    try:
        initialized = client.request(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name": "tailnet-agents", "version": "0.2.0"},
            },
        )
        if initialized.get("protocolVersion") != 1:
            raise RuntimeError("This agent uses an unsupported ACP protocol version")
        capabilities = initialized.get("agentCapabilities", {})
        if servers and not capabilities.get("mcpCapabilities", {}).get("http"):
            raise RuntimeError(
                "This Copilot version cannot connect to workspace tools over HTTP. Update Copilot CLI on this device."
            )
        params = {"cwd": agent["cwd"], "mcpServers": servers}
        if session_id:
            if not capabilities.get("loadSession"):
                raise RuntimeError(
                    "This agent does not support resuming saved sessions. Update its CLI before continuing."
                )
            client.request("session/load", {**params, "sessionId": session_id})
        else:
            session_id = client.request("session/new", params)["sessionId"]
        emit("session", native_id=session_id)
        loading = False
        result = client.request(
            "session/prompt",
            {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]},
            timeout=3600,
        )
        if text:
            emit("message", message_id=identity, text=text, source="copilot")
        if result.get("stopReason") not in {"end_turn", "cancelled"}:
            raise RuntimeError(
                f"Agent stopped: {result.get('stopReason', 'unknown reason')}"
            )
    finally:
        client.close()
