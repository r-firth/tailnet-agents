#!/usr/bin/env python3
"""Read-only public walkthrough, using the real built UI and synthetic events.

Run: agent/.venv/bin/python scripts/demo.py
No Tailnet Agents server, Codex account, SSH connection, .env, or personal database is used.
All commands and rendering progress are illustrative; nothing is executed.
"""

import argparse
import asyncio
import json
import math
import mimetypes
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "web" / "dist"
MEDIA = ROOT / "docs" / "demo"
BASE_TIME = datetime(2026, 9, 24, 19, 42, tzinfo=timezone.utc)
CHAT = "demo-surroundfold"
SHELL = "demo-media-terminal"
PROMPT = "Start processing Orbital episode 1 with SurroundFold on the media server. Keep the original and leave the terminal open."
INPUT = "Orbital.S01E01.mkv"
OUTPUT = "Orbital.S01E01.binaural.mkv"
INSPECT = f'surroundfold "{INPUT}" --list-tracks'
RENDER = f'surroundfold "{INPUT}" --output "{OUTPUT}"'
TRACKS = (
    "audio  stream  codec       language  channels  capability\r\n"
    "    0       1  eac3        eng              6  joc-objects\r\n"
    "    1       2  aac         eng              2  channels\r\n"
)
ANSI_PROMPT = "\x1b[38;2;122;190;155mmedia-server\x1b[0m \x1b[38;2;147;173;196m/media/Orbital\x1b[0m\r\n\x1b[38;2;255;153;95m❯\x1b[0m "


def stamp(seconds=0):
    return (BASE_TIME + timedelta(seconds=seconds)).isoformat()


def event(identifier, kind, payload, scope=CHAT):
    return {
        "id": identifier,
        "kind": kind,
        "scope": scope,
        "time": stamp(identifier % 60),
        "payload": payload,
    }


def tool(identifier, name, arguments, result=None):
    payload = {
        "name": name,
        "arguments": arguments,
        "item_id": f"demo-tool-{identifier}",
    }
    if result is not None:
        payload["result"] = {"ok": True, "result": result}
    return payload


OPEN_ARGS = {
    "name": "SurroundFold · Orbital",
    "device_id": "media-server",
    "cwd": "/media/Orbital",
}
INSPECT_ARGS = {"session_id": SHELL, "text": INSPECT + "\n"}
RENDER_ARGS = {"session_id": SHELL, "text": RENDER + "\n"}
READ_ARGS = {"session_id": SHELL}
REPLY = "Rendering has started on **media-server**. SurroundFold is using the English DD+/Atmos track and writing a separate **binaural FLAC** version.\n\nThe original stays intact. I’ve left the terminal open so you can watch progress."

# Relative playback time, persisted event. The rendered UI handles its usual
# websocket events, streaming text, live instruments, and terminal renderer.
STORY = [
    (0, event(1000, "message.user", {"text": PROMPT})),
    (0.3, event(1001, "agent.started", {})),
    (
        0.7,
        event(
            1002,
            "message.assistant",
            {
                "text": "I’ll check the audio tracks, then start SurroundFold on the media server."
            },
        ),
    ),
    (1.1, event(1003, "tool.started", tool(1, "open_terminal", OPEN_ARGS))),
    (
        3,
        event(
            1004,
            "tool.result",
            tool(
                1,
                "open_terminal",
                OPEN_ARGS,
                {"id": SHELL, "name": OPEN_ARGS["name"], "cwd": OPEN_ARGS["cwd"]},
            ),
        ),
    ),
    (3.1, event(1005, "session.created", {"id": SHELL})),
    (3.4, event(1006, "tool.started", tool(2, "terminal_send", INSPECT_ARGS))),
    (
        4.8,
        event(
            1007,
            "tool.result",
            tool(2, "terminal_send", INSPECT_ARGS, {"output": TRACKS}),
        ),
    ),
    (
        5.3,
        event(
            1008,
            "message.assistant",
            {
                "text": "The source has an English DD+/Atmos track. I’ll render it to a separate file, keeping the original."
            },
        ),
    ),
    (6.1, event(1009, "tool.started", tool(3, "terminal_send", RENDER_ARGS))),
    (
        8,
        event(
            1010,
            "tool.result",
            tool(
                3,
                "terminal_send",
                RENDER_ARGS,
                {"output": "Command sent to the persistent terminal."},
            ),
        ),
    ),
    (8.1, event(1011, "tool.started", tool(4, "terminal_read", READ_ARGS))),
    (
        13,
        event(
            1012,
            "tool.result",
            tool(
                4,
                "terminal_read",
                READ_ARGS,
                {
                    "output": "selected audio 0 (stream 1, eac3, eng, joc-objects)\nrendering binaural track\nrender:   0.8% | 4.72x real-time | ETA 10:31",
                    "running": True,
                },
            ),
        ),
    ),
    (13.1, event(1013, "message.started", {"message_id": "demo-reply"})),
]
for i, word in enumerate(REPLY.split(" ")):
    STORY.append(
        (
            13.2 + i * 0.055,
            event(
                1014 + i,
                "message.delta",
                {"message_id": "demo-reply", "delta": word + " "},
            ),
        )
    )
STORY.extend(
    [
        (
            17,
            event(
                1100, "message.assistant", {"message_id": "demo-reply", "text": REPLY}
            ),
        ),
        (17.1, event(1101, "agent.finished", {})),
    ]
)
TERMINAL = [
    (3, "\x1b[2J\x1b[H" + ANSI_PROMPT),
    (3.6, INSPECT + "\r\n"),
    (4.6, TRACKS + "\r\n" + ANSI_PROMPT),
    (
        6.5,
        'surroundfold "Orbital.S01E01.mkv" \\\r\n  --output "Orbital.S01E01.binaural.mkv"\r\n',
    ),
    (
        7.8,
        "selected audio 0 (stream 1, eac3, eng, joc-objects)\r\nrendering binaural track\r\n\r\n",
    ),
    (12.8, "render:   0.8% | 4.72x real-time | ETA 10:31\r\n"),
    (17.8, "render:   1.6% | 4.76x real-time | ETA 10:21\r\n"),
    (22.8, "render:   2.4% | 4.78x real-time | ETA 10:14\r\n"),
    (27.8, "render:   3.2% | 4.79x real-time | ETA 10:08\r\n"),
]


def archive():
    """An intentionally small synthetic graph, with real provenance-shaped IDs."""
    topics = [
        (
            CHAT,
            "SurroundFold · Orbital",
            "Start SurroundFold on the media server",
            "SurroundFold is rendering the English DD+/Atmos track to binaural FLAC. The original stays intact.",
        ),
        (
            "demo-profile",
            "Binaural preferences",
            "Remember my SurroundFold settings",
            "Use continuous object rendering, image-source distance, and the bundled HRIR. Keep a separate output.",
        ),
        (
            "demo-media",
            "Media server check",
            "Check the media server before tonight",
            "FFmpeg, ffprobe, and SurroundFold are available. The media volume has room for a separate output.",
        ),
        (
            "demo-game",
            "Desktop game build",
            "Check the latest game build",
            "The renderer tests passed. The desktop build is ready for a playtest.",
        ),
        (
            "demo-backup",
            "Library backup",
            "Verify the latest library backup",
            "The backup manifest matches. The media library is ready for tonight’s run.",
        ),
        (
            "demo-network",
            "Device discovery",
            "Find my available machines",
            "Desktop, media-server, and studio are available over Tailscale SSH.",
        ),
    ]
    nodes, edges, runs = [], [], {}
    for group, (scope, title, prompt, answer) in enumerate(topics):
        base = 100 + group * 30
        events = [
            event(base + 1, "message.user", {"text": prompt}, scope),
            event(base + 2, "agent.started", {}, scope),
        ]
        for n in range(4):
            name = ["list_devices", "open_terminal", "terminal_send", "terminal_read"][
                n
            ]
            events.extend(
                [
                    event(
                        base + 3 + n * 2,
                        "tool.started",
                        {"name": name, "arguments": {"device_id": "media-server"}},
                        scope,
                    ),
                    event(
                        base + 4 + n * 2,
                        "tool.result",
                        {
                            "name": name,
                            "result": {"ok": True, "result": {"output": answer}},
                        },
                        scope,
                    ),
                ]
            )
        events.extend(
            [
                event(base + 11, "message.assistant", {"text": answer}, scope),
                event(base + 12, "agent.finished", {}, scope),
            ]
        )
        if group == 0:
            events = [
                e
                for _, e in STORY
                if e["kind"] not in ("message.delta", "message.started")
            ]
        run_id = events[1]["id"]
        nodes.append(
            {
                "id": base,
                "label": "Scope",
                "kind": "scope",
                "category": "scope",
                "title": title,
                "scope": scope,
                "scope_name": title,
                "excerpt": prompt,
                "vectors": 0,
                "time": stamp(),
            }
        )
        for i, e in enumerate(events):
            category = e["kind"].split(".")[0]
            if category not in ("message", "tool", "terminal"):
                category = "system"
            p = e["payload"]
            excerpt = (
                p.get("text")
                or p.get("arguments", {}).get("text")
                or p.get("result", {}).get("result", {}).get("output")
                or p.get("name")
                or e["kind"].replace(".", " ")
            )
            heading = {
                "message.user": "You",
                "message.assistant": "Coordinator",
                "agent.started": "Run started",
                "agent.finished": "Run finished",
            }.get(e["kind"], p.get("name", e["kind"]).replace("_", " ").capitalize())
            nodes.append(
                {
                    "id": e["id"],
                    "label": "Event",
                    "kind": e["kind"],
                    "category": category,
                    "title": heading,
                    "scope": scope,
                    "scope_name": title,
                    "excerpt": str(excerpt),
                    "vectors": int(category in ("message", "tool")),
                    "time": e["time"],
                    "run_id": run_id,
                }
            )
            edges.append(
                {
                    "id": len(edges) + 1,
                    "source": base,
                    "target": e["id"],
                    "label": "HAS_EVENT",
                }
            )
            if i:
                edges.append(
                    {
                        "id": len(edges) + 1,
                        "source": events[i - 1]["id"],
                        "target": e["id"],
                        "label": "NEXT",
                    }
                )
        runs[run_id] = {
            "id": run_id,
            "name": title,
            "prompt": prompt,
            "status": "finished",
            "time": stamp(),
            "events": events,
            "total": len(events),
            "offset": 0,
            "next_offset": None,
            "previous_offset": None,
            "previous_run": None,
            "next_run": None,
        }
    return nodes, edges, runs


class Demo:
    def __init__(self):
        self.started = None
        self.event_sockets = set()
        self.terminal_sockets = set()
        self.sent_events = set()
        self.sent_terminal = set()
        self.nodes, self.edges, self.runs = archive()

    def elapsed(self):
        return 0 if self.started is None else time.monotonic() - self.started

    def state(self):
        elapsed = self.elapsed()
        chats = [
            {
                "id": CHAT,
                "name": "SurroundFold · Orbital",
                "created_at": stamp(),
                "session_ids": [SHELL] if elapsed >= 3 else [],
            }
        ]
        for node in self.nodes:
            if node["label"] == "Scope" and node["scope"] != CHAT:
                chats.append(
                    {
                        "id": node["scope"],
                        "name": node["title"],
                        "created_at": stamp(),
                        "session_ids": [],
                    }
                )
        return {
            "devices": [
                {
                    "id": host,
                    "name": host,
                    "target": host,
                    "status": "online",
                    "source": "tailscale",
                    "os": os,
                    "ssh": "available",
                }
                for host, os in [
                    ("media-server", "linux"),
                    ("desktop", "windows"),
                    ("studio", "macos"),
                ]
            ],
            "discovery": {
                "status": "connected",
                "message": "3 SSH devices available",
                "last_sync": stamp(),
                "count": 3,
            },
            "sessions": [
                {
                    "id": SHELL,
                    "name": OPEN_ARGS["name"],
                    "device_id": "media-server",
                    "cwd": "/media/Orbital",
                    "owner": "agent",
                    "closed": False,
                    "created_at": stamp(),
                }
            ]
            if elapsed >= 3
            else [],
            "chats": chats[:3],
            "events": [e for at, e in STORY if at <= elapsed],
            "live": [SHELL] if elapsed >= 3 else [],
            "running": [CHAT] if 0.3 <= elapsed < 17.1 else [],
            "event_count": len(self.nodes),
            "embedding_status": "ready",
            "model": "codex",
            "public_origin": None,
        }

    def memory(self, path, query):
        if path == "/api/memory/graph":
            focus = int(query["node"][0]) if "node" in query else None
            target = next((n for n in self.nodes if n["id"] == focus), None)
            nodes = [
                n for n in self.nodes if not target or n["scope"] == target["scope"]
            ]
            ids = {n["id"] for n in nodes}
            return {
                "nodes": nodes,
                "edges": [
                    e for e in self.edges if e["source"] in ids and e["target"] in ids
                ],
                "focus": focus,
                "next_offset": None,
                "stats": {
                    "nodes": len(self.nodes),
                    "edges": len(self.edges),
                    "vectors": sum(n["vectors"] for n in self.nodes),
                    "runs": len(self.runs),
                },
                "elapsed_ms": 1,
            }
        if path == "/api/memory/search":
            words = query.get("q", [""])[0].lower().split()
            category = query.get("kind", ["all"])[0]
            hits = [
                n
                for n in self.nodes
                if n["label"] != "Scope"
                and (category == "all" or n["category"] == category)
                and all(
                    word in (n["excerpt"] + n["scope_name"]).lower() for word in words
                )
            ]
            hits.sort(
                key=lambda n: (
                    n["kind"] != "message.assistant",
                    n["scope"] != CHAT,
                    -n["id"],
                )
            )
            return {
                "hits": hits[:30],
                "total": len(hits),
                "next_offset": None,
                "semantic": False,
                "elapsed_ms": 1,
                "warning": "Synthetic demo archive · text search",
            }
        if path.startswith("/api/memory/runs/"):
            return self.runs.get(int(path.rsplit("/", 1)[1]))
        if path.startswith("/api/memory/element/"):
            kind, identifier = path.split("/")[-2:]
            item = next(
                (
                    n
                    for n in (self.nodes if kind == "node" else self.edges)
                    if n["id"] == int(identifier)
                ),
                None,
            )
            if item:
                neighbors = [
                    {
                        "id": e["id"],
                        "node": e["target"]
                        if e["source"] == item["id"]
                        else e["source"],
                        "label": e["label"],
                        "direction": "out" if e["source"] == item["id"] else "in",
                    }
                    for e in self.edges
                    if item["id"] in (e["source"], e["target"])
                ]
                return dict(
                    **item,
                    properties={
                        "text": item.get("excerpt", ""),
                        "scope": item.get("scope", ""),
                        "synthetic": True,
                    },
                    vector=[
                        round(math.sin(i * 1.7 + item["id"]) / 14, 5)
                        for i in range(384)
                    ]
                    if item.get("vectors")
                    else None,
                    neighbors=neighbors,
                    degree=len(neighbors),
                )
        return None

    async def broadcast(self, sockets, value):
        for socket in tuple(sockets):
            try:
                await socket.send(value)
            except ConnectionClosed:
                sockets.discard(socket)

    async def tick(self):
        while True:
            elapsed = self.elapsed()
            for at, e in STORY:
                if at <= elapsed and e["id"] not in self.sent_events:
                    self.sent_events.add(e["id"])
                    await self.broadcast(self.event_sockets, json.dumps(e))
            for i, (at, output) in enumerate(TERMINAL):
                if at <= elapsed and i not in self.sent_terminal:
                    self.sent_terminal.add(i)
                    await self.broadcast(self.terminal_sockets, output.encode())
            await asyncio.sleep(0.03)

    async def socket(self, ws):
        terminal = ws.request.path == f"/api/sessions/{SHELL}/stream"
        sockets = self.terminal_sockets if terminal else self.event_sockets
        sockets.add(ws)
        try:
            if terminal:
                await ws.send(
                    "".join(
                        text for at, text in TERMINAL if at <= self.elapsed()
                    ).encode()
                )
            async for raw in ws:
                # Fit the real emulator to its viewer. Input is deliberately
                # ignored: this stream can never reach a shell or agent.
                try:
                    message = json.loads(raw)
                    if terminal and message.get("type") == "resize":
                        cols = max(10, min(300, int(message["cols"])))
                        rows = max(4, min(150, int(message["rows"])))
                        await ws.send(
                            json.dumps({"type": "geometry", "cols": cols, "rows": rows})
                        )
                except (ValueError, KeyError, TypeError):
                    pass
        finally:
            sockets.discard(ws)

    async def request(self, connection, request):
        url = urlsplit(request.path)
        path, query = unquote(url.path), parse_qs(url.query)
        if request.headers.get("Upgrade", "").lower() == "websocket":
            if path in ("/api/events", f"/api/sessions/{SHELL}/stream"):
                return None
            return response(404, b"Unknown demo stream")
        if path == "/_demo/replay":
            self.started = time.monotonic()
            self.sent_events.clear()
            self.sent_terminal.clear()
            return json_response({"ok": True})
        if path == "/api/state":
            return json_response(self.state())
        if path.startswith("/api/memory/"):
            try:
                result = self.memory(path, query)
            except (ValueError, KeyError):
                result = None
            return (
                json_response(result)
                if result is not None
                else response(404, b"Unknown synthetic record")
            )
        if path == f"/api/sessions/{SHELL}/history":
            return json_response(
                {
                    "text": "".join(
                        text for at, text in TERMINAL if at <= self.elapsed()
                    ),
                    "cols": 80,
                    "rows": 30,
                }
            )
        if path == "/api/search":
            q = query.get("q", [""])[0].lower()
            return json_response(
                {
                    "results": [
                        e
                        for _, e in STORY
                        if e["kind"] == "message.assistant"
                        and q in e["payload"].get("text", "").lower()
                    ],
                    "semantic": False,
                }
            )
        if path.startswith("/api/"):
            return json_response(
                {
                    "error": "This is a read-only demo. No machines or agents are connected."
                },
                403,
            )
        if path in ("/demo", "/demo/"):
            return response(
                200, (MEDIA / "index.html").read_bytes(), "text/html; charset=utf-8"
            )
        if path == "/demo-font.woff2":
            font = next((DIST / "assets").glob("chakra-petch-latin-400-normal-*.woff2"))
            return response(200, font.read_bytes(), "font/woff2")
        if path in (
            "/demo/surroundfold.mp4",
            "/demo/surroundfold.gif",
            "/demo/surroundfold.png",
        ):
            media = MEDIA / Path(path).name
            if media.is_file():
                return response(200, media.read_bytes(), mimetypes.guess_type(media)[0])
        if path in ("/sw.js", "/manifest.webmanifest"):
            return response(404, b"Demo does not install a service worker")
        candidate = (DIST / path.lstrip("/")).resolve()
        if not candidate.is_relative_to(DIST.resolve()):
            return response(404, b"Not found")
        if not candidate.is_file():
            if path not in ("/", "/memory", "/sessions", "/devices", "/activity"):
                return response(404, b"Not found")
            candidate = DIST / "index.html"
        body = candidate.read_bytes()
        if candidate.name == "index.html":
            body = body.replace(
                b"</head>",
                b'<style>.composer textarea{pointer-events:none}.composer textarea::placeholder{color:transparent}.composer:before{content:"Read-only demo / synthetic activity";color:#817c77;font-size:12px;position:absolute;top:14px;left:18px}.composer{position:relative}</style></head>',
            )
        return response(
            200, body, mimetypes.guess_type(candidate)[0] or "application/octet-stream"
        )


def response(status, body, content_type="text/plain; charset=utf-8"):
    return Response(
        status,
        HTTPStatus(status).phrase,
        Headers(
            {
                "Content-Type": content_type,
                "Content-Length": str(len(body)),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            }
        ),
        body,
    )


def json_response(value, status=200):
    return response(status, json.dumps(value).encode(), "application/json")


async def main(port):
    if not (DIST / "index.html").is_file():
        raise SystemExit("Build the frontend first: npm --prefix web run build")
    demo = Demo()
    async with serve(
        demo.socket, "127.0.0.1", port, process_request=demo.request, server_header=None
    ):
        print(
            f"Tailnet Agents · SurroundFold demo: http://127.0.0.1:{port}/demo",
            flush=True,
        )
        print(
            "Synthetic playback only. No commands, API keys, SSH, or personal data.",
            flush=True,
        )
        await demo.tick()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4325)
    try:
        asyncio.run(main(parser.parse_args().port))
    except KeyboardInterrupt:
        pass
