"""Opt-in Claude subscription check; no running hub or remote machine is changed."""

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import claude_backend  # noqa: E402
from worker import SCHEMA  # noqa: E402


async def main():
    with tempfile.TemporaryDirectory(prefix="tailnet-claude-smoke-") as cwd:
        sessions = []
        models = []
        replies = []
        original = claude_backend.native.emit

        def emit(kind, **payload):
            if kind == "session":
                sessions.append(payload["native_id"])
                models.append(payload.get("model"))
            if kind == "message":
                replies.append(payload.get("text", ""))
            original(kind, **payload)

        claude_backend.native.emit = emit
        common = dict(
            base="Follow the user's request. Do not change files or run commands.",
            cwd=cwd,
            target=None,
            reverse=None,
            servers={},
            request_input=lambda _: {"choice": "deny"},
            call_tool=lambda *_: {"ok": True, "result": []},
        )
        try:
            await claude_backend.run(
                **common,
                agent=None,
                schema=SCHEMA,
                prompt="Return a decision with text 'Coordinator connected', title 'Claude smoke', and no tools.",
            )
            assert replies == ["Coordinator connected"], (
                "Coordinator reply missing or duplicated"
            )
            await claude_backend.run(
                **common,
                agent={},
                schema=None,
                prompt="Remember the marker copper-otter-731 and acknowledge in one sentence.",
            )
            identity = sessions[-1]
            await claude_backend.run(
                **common,
                agent={"native_id": identity},
                schema=None,
                prompt="What marker did I ask you to remember?",
            )
            assert all(model == "claude-opus-5-5" for model in models), (
                f"Unexpected models: {models}"
            )
            assert sessions[-1] == identity, "Resume changed the native session"
            assert "copper-otter-731" in replies[-1], (
                "Resume lost the remembered marker"
            )
        finally:
            claude_backend.native.emit = original
    print(
        "PASS Claude Opus 5.5 at medium effort: coordinator, native streaming and remembered session resume."
    )


if __name__ == "__main__":
    asyncio.run(main())
