"""Opt-in real Codex/tool/Vecgra check; uses the signed-in account and a disposable Hub."""

import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"

    def api(path, payload=None):
        req = urllib.request.Request(
            base + "/api" + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)

    def wait_for(fn, timeout):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            try:
                result = fn()
                if result:
                    return result
            except OSError:
                pass
            time.sleep(0.5)
        raise AssertionError("Agent smoke check timed out")

    with tempfile.TemporaryDirectory(prefix="hub-agent-smoke-") as data:
        env = {
            **os.environ,
            "HUB_ROOT": str(ROOT),
            "HUB_DATA_DIR": data,
            "HUB_PORT": str(port),
            "HUB_BIND": "127.0.0.1",
            "HUB_DISCOVERY": "off",
            "HUB_TOKEN": "",
            "HUB_ALLOWED_HOSTS": "",
            "HUB_PUBLIC_ORIGIN": base,
        }

        def start():
            child = subprocess.Popen(
                [str(ROOT / "target/debug/hub-server")],
                cwd=ROOT,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            wait_for(lambda: api("/state"), 20)
            return child

        def stop(child):
            child.send_signal(signal.SIGINT)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

        child = start()
        try:
            chat = api("/chats", {})["id"]
            api(
                f"/chats/{chat}/messages",
                {
                    "text": (
                        "Integration check. Do only these three things: use native web search to find the official "
                        "Python asyncio documentation; use your native shell to run exactly "
                        "printf HUB_EARLY_OUTPUT; sleep 1; printf HUB_NATIVE_TOOLS_OK; sleep 1; printf HUB_STREAM_DONE "
                        "as a single command (the pauses exercise live output); "
                        "and use the Hub list_devices tool. Do not open terminals, change files, send messages to "
                        "anyone, or use other integrations. Finish with the printed marker, the number of Hub devices, "
                        "and a clickable Markdown link to the documentation you actually found."
                    )
                },
            )
            state = wait_for(
                lambda: (
                    (s if chat not in s["running"] else None)
                    if (s := api("/state"))
                    else None
                ),
                180,
            )
            events = [e for e in state["events"] if e["scope"] == chat]
            errors = [e["payload"] for e in events if e["kind"] == "agent.error"]
            assert not errors, errors
            named = next(c for c in state["chats"] if c["id"] == chat)
            assert named["title_generated"] and named["name"] != "New conversation", (
                named
            )
            assert any(e["kind"] == "chat.renamed" for e in events), (
                "Automatic title was not persisted"
            )
            print("Automatic title:", named["name"], flush=True)
            receipts = [e["payload"] for e in events if e["kind"] == "tool.result"]
            print("Observed tools:", [p["name"] for p in receipts], flush=True)
            assert any(
                p["name"] == "web_search" and p["result"]["ok"] for p in receipts
            ), "Native web search receipt missing"
            assert any(
                p["name"] == "command_execution"
                and p["result"]["ok"]
                and "HUB_NATIVE_TOOLS_OK"
                in p["result"]["result"].get("aggregatedOutput", "")
                for p in receipts
            ), "Native command output missing"
            output_events = [e for e in events if e["kind"] == "tool.output"]
            assert any(
                "HUB_NATIVE_TOOLS_OK" in e["payload"]["delta"] for e in output_events
            ), "Live command output missing"
            for output in output_events:
                result = next(
                    e
                    for e in events
                    if e["kind"] == "tool.result"
                    and e["payload"].get("item_id") == output["payload"]["item_id"]
                )
                assert output["id"] < result["id"], (
                    "Output only arrived after completion"
                )
            assert any(
                p["name"] == "list_devices" and p["result"]["ok"] for p in receipts
            ), "Hub tool receipt missing"
            assert any(
                p.get("native_receipt")
                and "HUB_EARLY_OUTPUT" in p["result"]["result"].get("output", "")
                for p in receipts
            ), "The tool response seen by the agent was not preserved"
            answers = [
                e["payload"]["text"] for e in events if e["kind"] == "message.assistant"
            ]
            assert answers and "https://docs.python.org/" in answers[-1], answers
            deltas = [e for e in events if e["kind"] == "message.delta"]
            assert deltas, "SDK text did not stream through the server"
            for message_id in {e["payload"]["message_id"] for e in deltas}:
                chunks = [e for e in deltas if e["payload"]["message_id"] == message_id]
                final = next(
                    e
                    for e in events
                    if e["kind"] == "message.assistant"
                    and e["payload"].get("message_id") == message_id
                )
                assert chunks[0]["id"] < final["id"], (
                    "Text arrived only after completion"
                )
                assert (
                    "".join(e["payload"]["delta"] for e in chunks)
                    == final["payload"]["text"]
                ), "Stream differs from the final response"
            print(
                f"PASS: {len(deltas)} live text chunks, reconciled to their final messages",
                flush=True,
            )
            durable_kinds = {
                "tool.result",
                "tool.output",
                "message.started",
                "message.delta",
                "message.assistant",
            }
            receipt_ids = {e["id"] for e in events if e["kind"] in durable_kinds}
            stop(child)
            child = start()
            assert (
                next(c for c in api("/state")["chats"] if c["id"] == chat)["name"]
                == named["name"]
            )
            restored = {
                e["id"] for e in api("/state")["events"] if e["kind"] in durable_kinds
            }
            assert receipt_ids <= restored, "Tool receipts did not survive restart"
            print(
                "PASS: native web + shell + Hub tools, linked answer, durable receipts",
                flush=True,
            )
        finally:
            stop(child)


if __name__ == "__main__":
    main()
