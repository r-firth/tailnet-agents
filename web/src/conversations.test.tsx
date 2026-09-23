// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { HubState } from "./api";
const mounted = vi.hoisted(() => ({ root: undefined as Root | undefined }));
vi.mock("react-dom/client", async (original) => {
  const actual = await original<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      mounted.root = actual.createRoot(...args);
      return mounted.root;
    },
  };
});
vi.mock("./gpu", () => ({ mountSignal: () => () => {} }));
vi.mock("./terminal-session", () => ({ mountTerminal: () => () => {} }));
class Socket {
  static latest: Socket;
  onmessage?: (event: { data: string }) => void;
  constructor() {
    Socket.latest = this;
  }
  close() {}
}
const date = "2026-09-23T02:00:00Z";
async function mount(failClose = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", Socket);
  window.history.replaceState(null, "", "/");
  const state: HubState = {
    devices: [{ id: "local", name: "Desktop", target: null, status: "online" }],
    chats: [
      {
        id: "game",
        name: "Game build",
        created_at: date,
        session_ids: ["build"],
        closed: false,
      },
      {
        id: "research",
        name: "Travel research",
        created_at: date,
        session_ids: ["research-shell"],
        closed: false,
      },
    ],
    sessions: ["build", "logs", "research-shell", "standalone"].map((id) => ({
      id,
      name: id,
      device_id: "local",
      created_at: date,
      cwd: "",
      closed: false,
      owner: "agent",
    })),
    events: [],
    running: [],
    live: [],
    event_count: 0,
    embedding_status: "ready",
    model: "test",
  };
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      requests.push(url);
      const [, id, action] = url.match(/\/chats\/([^/]+)\/(\w+)/) || [];
      if (action === "close") {
        if (failClose)
          return Response.json(
            {
              error:
                "Could not stop Logs: device unreachable. Retry closing the session.",
            },
            { status: 400 },
          );
        const chat = state.chats.find((c) => c.id === id)!;
        chat.closed = true;
        state.sessions.forEach((s) => {
          if (chat.session_ids?.includes(s.id)) s.closed = true;
        });
        return Response.json({ ok: true, closed_terminals: chat.session_ids });
      }
      if (action === "reopen")
        state.chats.find((c) => c.id === id)!.closed = false;
      if (action === "terminals")
        state.chats
          .find((c) => c.id === id)!
          .session_ids!.push(JSON.parse(init.body as string).session_id);
    }
    return Response.json(state);
  });
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("./main");
  });
  await settle(() =>
    expect(document.querySelector(".chat-list")?.textContent).toContain(
      "Game build",
    ),
  );
  return { state, requests };
}
async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    check();
  });
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
}
afterEach(async () => {
  await act(async () => mounted.root?.unmount());
  mounted.root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.replaceChildren();
});
it("binds the work pane to the selected conversation without a terminal picker", async () => {
  await mount();
  expect(
    document.querySelector('select[aria-label="Conversation terminal"]'),
  ).toBeNull();
  expect(document.querySelector(".terminal-header strong")?.textContent).toBe(
    "build",
  );
  await click(
    document.querySelector('.chat-list button[title="Travel research"]'),
  );
  await settle(() =>
    expect(document.querySelector(".terminal-header strong")?.textContent).toBe(
      "research-shell",
    ),
  );
  expect(document.querySelector(".conversation-header h1")?.textContent).toBe(
    "Travel research",
  );
  await click(document.querySelector('.chat-list button[title="Game build"]'));
  await settle(() =>
    expect(document.querySelector(".terminal-header strong")?.textContent).toBe(
      "build",
    ),
  );
});
it("animates a running sidebar session even when another conversation is selected, and removes it on completion", async () => {
  await mount();
  const row = () =>
    document
      .querySelector('button[title="Travel research"]')!
      .closest(".chat-row")!;
  expect(row().querySelector("canvas")).toBeNull();
  await act(async () =>
    Socket.latest.onmessage?.({
      data: JSON.stringify({
        id: 1,
        kind: "agent.started",
        scope: "research",
        time: date,
        payload: {},
      }),
    }),
  );
  await settle(() =>
    expect(row().querySelector("canvas[data-hub-gpu]")).not.toBeNull(),
  );
  expect(document.querySelector(".chat-row.selected canvas")).toBeNull();
  await act(async () =>
    Socket.latest.onmessage?.({
      data: JSON.stringify({
        id: 2,
        kind: "agent.finished",
        scope: "research",
        time: date,
        payload: {},
      }),
    }),
  );
  await settle(() => expect(row().querySelector("canvas")).toBeNull());
});
it("closes a session and its terminals in one click, and reopens only its history", async () => {
  const { state, requests } = await mount();
  await click(document.querySelector('button[aria-label="Close Game build"]'));
  await settle(() =>
    expect(document.querySelector(".chat-list")?.textContent).not.toContain(
      "Game build",
    ),
  );
  expect(requests).toContain("/api/chats/game/close");
  expect(
    state.sessions.filter((s) => s.id === "build").every((s) => s.closed),
  ).toBe(true);
  expect(document.querySelector(".toast")?.textContent).toContain(
    "terminals stopped",
  );
  expect(document.querySelector(".toast")?.textContent).not.toContain(
    "keep running",
  );
  expect(state.sessions.find((s) => s.id === "research-shell")?.closed).toBe(
    false,
  );
  expect(document.querySelector(".conversation-header h1")?.textContent).toBe(
    "Travel research",
  );
  await click(document.querySelector('.topbar a[href="/sessions"]'));
  await settle(() =>
    expect(
      document.querySelector('button[aria-label="Reopen Game build"]'),
    ).not.toBeNull(),
  );
  await click(document.querySelector('button[aria-label="Reopen Game build"]'));
  await settle(() =>
    expect(document.querySelector(".chat-list")?.textContent).toContain(
      "Game build",
    ),
  );
  expect(requests).toContain("/api/chats/game/reopen");
  expect(
    state.sessions.filter((s) => s.id === "build").every((s) => s.closed),
  ).toBe(true);
});
it("never borrows another session's terminal when the selected session has none", async () => {
  const { state } = await mount();
  state.chats[1].session_ids = [];
  await click(
    document.querySelector('.chat-list button[title="Travel research"]'),
  );
  await settle(() =>
    expect(document.querySelector(".terminal-header")).toBeNull(),
  );
  expect(document.querySelector(".empty-terminal")?.textContent).toContain(
    "No terminal open",
  );
  expect(
    document.querySelector('select[aria-label="Conversation terminal"]'),
  ).toBeNull();
  await click(document.querySelector('button[aria-label="Close Game build"]'));
  await click(
    document.querySelector('button[aria-label="Close Travel research"]'),
  );
  await settle(() =>
    expect(document.querySelector(".conversation-header h1")?.textContent).toBe(
      "New conversation",
    ),
  );
  expect(document.querySelector(".terminal-header")).toBeNull();
});

it("keeps a session visible and reports the error if a terminal cannot be stopped", async () => {
  await mount(true);
  await click(document.querySelector('button[aria-label="Close Game build"]'));
  await settle(() =>
    expect(document.querySelector(".toast")?.textContent).toContain(
      "device unreachable",
    ),
  );
  expect(document.querySelector(".chat-list")?.textContent).toContain(
    "Game build",
  );
  expect(
    (
      document.querySelector(
        'button[aria-label="Close Game build"]',
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
