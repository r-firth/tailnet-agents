// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Event, HubState } from "./api";

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
class WorkspaceSocket {
  static latest: WorkspaceSocket;
  onmessage?: () => void;
  constructor() {
    WorkspaceSocket.latest = this;
  }
  close() {}
}
const event = (id: number, kind: string, payload: Event["payload"]): Event => ({
  id,
  kind,
  payload,
  scope: "chat",
  time: "2026-09-23T02:00:00Z",
});
const identity = {
  name: "command_execution",
  source: "codex",
  item_id: "cmd-1",
  thread_id: "thread",
  turn_id: "turn",
};
const command = { command: "printf 'evidence\\n'", cwd: "/workspace/game" };
const finished = event(5, "tool.result", {
  ...identity,
  arguments: command,
  result: {
    ok: true,
    result: {
      type: "commandExecution",
      ...command,
      status: "completed",
      exitCode: 0,
      durationMs: 32,
      aggregatedOutput: "evidence\n",
    },
  },
});

async function mount(events: Event[], running = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", WorkspaceSocket);
  const state: HubState = {
    devices: [],
    sessions: [],
    chats: [
      { id: "chat", name: "Workspace", created_at: event(0, "", {}).time },
    ],
    events,
    running: running ? ["chat"] : [],
    live: [],
    event_count: events.length,
    embedding_status: "ready",
    model: "test",
  };
  vi.stubGlobal("fetch", async () => Response.json(state));
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("./main");
  });
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector(".conversation-body")?.textContent).toContain(
      "Check the game",
    );
  });
  return state;
}
const user = event(1, "message.user", { text: "Check the game" });
it("shows a native image once when the enclosing tool receipt repeats it", async () => {
  const { chatEntries } = await import("./ToolActivity");
  const image = { id: "picture" };
  const identity = { source: "codex", thread_id: "t", turn_id: "turn" };
  const native = event(2, "tool.result", {
    ...identity,
    item_id: "image",
    name: "image_generation",
    images: [image],
  });
  const wrapper = event(3, "tool.result", {
    ...identity,
    item_id: "exec",
    name: "exec",
    native_receipt: true,
    images: [image],
  });
  const entries = chatEntries([native, wrapper]);
  expect(
    entries.flatMap((entry) => entry.action?.end?.payload.images || []),
  ).toHaveLength(1);
  expect(wrapper.payload.images).toHaveLength(1); // Keep the original evidence intact.
  const next = {
    ...wrapper,
    id: 4,
    payload: { ...wrapper.payload, turn_id: "another-turn" },
  };
  expect(
    chatEntries([native, next]).flatMap(
      (entry) => entry.action?.end?.payload.images || [],
    ),
  ).toHaveLength(2);
});
it("surfaces tool images outside collapsed receipts and offers the original file", async () => {
  const image = {
    id: `${"a".repeat(64)}.png`,
    url: `/api/artifacts/${"a".repeat(64)}.png`,
    mime_type: "image/png",
    name: "desktop.png",
    caption: "Desktop screenshot",
    width: 1920,
    height: 1080,
    bytes: 42000,
  };
  await mount([
    user,
    event(2, "tool.result", {
      name: "show_image",
      arguments: { path: "/tmp/desktop.png" },
      result: { ok: true, result: { images: [image] } },
      images: [image],
    }),
  ]);
  const preview = document.querySelector<HTMLImageElement>(
    '.conversation-body img[alt="Desktop screenshot"]',
  );
  expect(
    preview,
    "Image should be visible without expanding a tool receipt",
  ).not.toBeNull();
  expect(preview!.closest("details")).toBeNull();
  expect(preview!.getAttribute("src")).toBe(image.url);
  expect(preview!.width).toBe(1920);
  const download = document.querySelector<HTMLAnchorElement>(
    'a[download="desktop.png"]',
  );
  expect(download?.getAttribute("href")).toBe(image.url);
  await act(async () => {
    preview!.closest("button")!.click();
  });
  expect(document.querySelector("dialog[open] img")?.getAttribute("src")).toBe(
    image.url,
  );
  await act(async () => {
    document
      .querySelector<HTMLButtonElement>('[aria-label="Close image"]')!
      .click();
  });
  expect(document.querySelector("dialog")).toBeNull();
});
afterEach(async () => {
  await act(async () => mounted.root?.unmount());
  mounted.root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.replaceChildren();
});

it("makes the command and its output inspectable in chat with one expansion", async () => {
  await mount([
    user,
    event(2, "tool.started", { ...identity, arguments: command }),
    finished,
  ]);
  const chat = document.querySelector(".conversation-body")!;
  const row = [...chat.querySelectorAll("details")].find((d) =>
    d.querySelector(":scope > summary")?.textContent?.includes("printf"),
  );
  expect(
    row,
    "Command must be visible in the chat summary, not hidden inside JSON",
  ).toBeDefined();
  expect(row!.parentElement?.closest("details")).toBeNull();
  await act(async () => {
    row!.querySelector("summary")!.click();
  });
  expect(row!.open).toBe(true);
  expect(row!.textContent).toContain("/workspace/game");
  expect(
    [...row!.querySelectorAll("pre")].some(
      (p) => p.textContent === "evidence\n",
    ),
  ).toBe(true);
  expect(row!.textContent).toContain("Exit 0");
});

it("updates one live action in place and retains an opened output on completion", async () => {
  const state = await mount(
    [
      user,
      event(2, "tool.started", { ...identity, arguments: command }),
      event(3, "tool.output", { ...identity, delta: "evidence\n" }),
    ],
    true,
  );
  const chat = document.querySelector(".conversation-body")!;
  const row = [...chat.querySelectorAll("details")].find((d) =>
    d.querySelector(":scope > summary")?.textContent?.includes("printf"),
  );
  expect(row, "A command must appear before it finishes").toBeDefined();
  await act(async () => {
    row!.querySelector("summary")!.click();
  });
  expect(row!.textContent).toContain("evidence");
  state.events.push(finished, event(6, "agent.finished", {}));
  state.running = [];
  await act(async () => WorkspaceSocket.latest.onmessage?.());
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(row!.textContent).toContain("Exit 0");
  });
  expect(row!.isConnected && row!.open).toBe(true);
  expect(
    [...chat.querySelectorAll("summary")].filter((s) =>
      s.textContent?.includes("printf"),
    ),
  ).toHaveLength(1);
  expect(
    [...row!.querySelectorAll("pre")].some(
      (p) => p.textContent === "evidence\n",
    ),
  ).toBe(true);
});

it("shows web sources, file diffs and failed actions as readable evidence", async () => {
  await mount([
    user,
    event(2, "tool.result", {
      name: "web_search",
      source: "codex",
      arguments: { query: "engine docs" },
      result: {
        ok: true,
        result: {
          type: "webSearch",
          query: "engine docs",
          results: [
            {
              url: "https://example.com/docs",
              title: "Engine documentation",
              snippet: "Renderer reference",
            },
          ],
        },
      },
    }),
    event(3, "tool.result", {
      name: "file_change",
      source: "codex",
      result: {
        ok: true,
        result: {
          type: "fileChange",
          changes: [
            {
              path: "/game/render.ts",
              kind: { type: "update" },
              diff: "-old\n+new",
            },
          ],
        },
      },
    }),
    event(4, "tool.result", {
      ...identity,
      arguments: command,
      result: {
        ok: false,
        result: {
          ...command,
          exitCode: 2,
          aggregatedOutput: "permission denied",
        },
      },
    }),
  ]);
  const chat = document.querySelector(".conversation-body")!;
  const link = chat.querySelector('a[href="https://example.com/docs"]');
  expect(link?.textContent).toContain("Engine documentation");
  expect(chat.textContent).toContain("/game/render.ts");
  expect(
    [...chat.querySelectorAll("pre")].some(
      (p) => p.textContent === "-old\n+new",
    ),
  ).toBe(true);
  expect(chat.textContent).toContain("Exit 2");
  expect(
    [...chat.querySelectorAll("pre")].some(
      (p) => p.textContent === "permission denied",
    ),
  ).toBe(true);
});

it("refreshes live output during a continuous stream of workspace events", async () => {
  const state = await mount(
    [user, event(2, "tool.started", { ...identity, arguments: command })],
    true,
  );
  state.events.push(
    event(3, "tool.output", { ...identity, delta: "stream is still running" }),
  );
  const stream = setInterval(() => WorkspaceSocket.latest.onmessage?.(), 20);
  try {
    await vi.waitFor(
      async () => {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 50));
        });
        expect(
          document.querySelector(".conversation-body")?.textContent,
        ).toContain("stream is still running");
      },
      { timeout: 650 },
    );
  } finally {
    clearInterval(stream);
  }
});

it("pairs legacy Hub calls and does not leave stopped actions looking active", async () => {
  const args = { session_id: "closed-shell", text: "pwd\n" };
  await mount([
    user,
    event(2, "tool.started", { name: "terminal_send", arguments: args }),
    event(3, "tool.result", {
      name: "terminal_send",
      arguments: args,
      result: { ok: true, result: { sent: true } },
    }),
    event(4, "tool.started", { ...identity, arguments: command }),
    event(5, "agent.stopped", { text: "Stopped by you" }),
  ]);
  const chat = document.querySelector(".conversation-body")!;
  expect(
    [...chat.querySelectorAll("summary")].filter((s) =>
      s.textContent?.includes("pwd"),
    ),
  ).toHaveLength(1);
  expect(chat.textContent).toContain("No result recorded");
  expect(chat.textContent).not.toContain("Running a command");
});

it("shows the exact tool response without declaring an unknown outcome successful", async () => {
  await mount([
    user,
    event(2, "tool.result", {
      name: "exec",
      source: "codex",
      native_receipt: true,
      arguments: {
        code: "text(await tools.exec_command({cmd: 'printf early; sleep 2; printf late'}));",
      },
      result: {
        ok: null,
        result: {
          output: "earlylate",
          content: [{ type: "input_text", text: "earlylate" }],
        },
      },
    }),
  ]);
  const action = document.querySelector(".conversation-body .chat-action")!;
  expect(action.querySelector("summary")?.textContent).toContain("Returned");
  expect(action.textContent).not.toContain("Failed");
  expect(
    [...action.querySelectorAll("pre")].some(
      (p) => p.textContent === "earlylate",
    ),
  ).toBe(true);
  expect(
    [...action.querySelectorAll("pre")].some((p) =>
      p.textContent?.startsWith("text(await tools.exec_command"),
    ),
  ).toBe(true);
});

it("animates a live tool, then settles the same inspectable row when it finishes", async () => {
  const state = await mount(
    [user, event(2, "tool.started", { ...identity, arguments: command })],
    true,
  );
  const row = document.querySelector<HTMLDetailsElement>(".chat-action")!;
  expect(row.querySelector("canvas")).not.toBeNull();
  await act(async () => row.querySelector("summary")!.click());
  state.events.push(finished);
  WorkspaceSocket.latest.onmessage?.();
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(row.querySelector("canvas")).toBeNull();
    expect(row.textContent).toContain("evidence");
  });
  expect(row.isConnected && row.open).toBe(true);
});

it("streams a single assistant message over the socket and reconciles its final text", async () => {
  await mount([user], true);
  const send = async (e: Event) => {
    await act(async () => {
      (WorkspaceSocket.latest.onmessage as Function)?.({
        data: JSON.stringify(e),
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  };
  await send(event(2, "message.started", { message_id: "answer", text: "" }));
  await send(
    event(3, "message.delta", { message_id: "answer", delta: "Looking at " }),
  );
  const row = document.querySelector(".message.is-streaming")!;
  expect(row).not.toBeNull();
  expect(row.textContent).toContain("Looking at");
  await send(
    event(4, "message.delta", {
      message_id: "answer",
      delta: "the **desktop**.",
    }),
  );
  expect(row.querySelector("strong")?.textContent).toBe("Coordinator");
  expect(row.textContent).toContain("Looking at the desktop.");
  await send(
    event(5, "message.assistant", {
      message_id: "answer",
      text: "Checked the **desktop**.",
    }),
  );
  expect(row.isConnected).toBe(true);
  expect(row.classList.contains("is-streaming")).toBe(false);
  expect(row.textContent).toContain("Checked the desktop.");
  expect(document.querySelectorAll(".message:not(.user-message)")).toHaveLength(
    1,
  );
  // The socket-only text must survive a later stale HTTP snapshot.
  WorkspaceSocket.latest.onmessage?.();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160));
  });
  expect(row.textContent).toContain("Checked the desktop.");
});

it("restores an interrupted streamed reply from durable events without a running indicator", async () => {
  await mount([
    user,
    event(2, "message.started", { message_id: "interrupted", text: "" }),
    event(3, "message.delta", {
      message_id: "interrupted",
      delta: "Here is the partial reply",
    }),
    event(4, "agent.stopped", { text: "Stopped by you" }),
  ]);
  const chat = document.querySelector(".conversation-body")!;
  expect(chat.textContent).toContain("Here is the partial reply");
  expect(chat.querySelector(".is-streaming")).toBeNull();
});

it("renders Claude web, shell and file receipts with native instruments", async () => {
  const receipts = [
    {
      name: "WebSearch",
      arguments: { query: "Claude SDK docs" },
      output: [
        {
          type: "text",
          text: 'Search evidence\nLinks: [{"title":"Official docs","url":"https://example.com/docs"},{"title":"Unsafe","url":"javascript:alert(1)"}]',
        },
      ],
      label: "Web search",
      kind: "web",
    },
    {
      name: "Bash",
      arguments: { command: "printf hello" },
      output: "hello",
      label: "Command",
      kind: "command",
    },
    {
      name: "Read",
      arguments: { file_path: "/project/README.md" },
      output: "File contents",
      label: "Read file",
      kind: "files",
    },
    {
      name: "Edit",
      arguments: {
        file_path: "/project/a.py",
        old_string: "old",
        new_string: "new",
      },
      output: "Updated",
      label: "File changes",
      kind: "files",
    },
    {
      name: "WebFetch",
      arguments: { url: "https://example.com" },
      output: "Fetched page",
      label: "Web search",
      kind: "web",
    },
  ];
  await mount([
    event(0, "message.user", { text: "Check the game" }),
    ...receipts.flatMap((r, i) => {
      const payload = {
        source: "claude",
        item_id: `claude-${i}`,
        name: r.name,
        arguments: r.arguments,
      };
      return [
        event(i * 2 + 1, "tool.started", payload),
        event(i * 2 + 2, "tool.result", {
          ...payload,
          result: { ok: true, result: { output: r.output } },
        }),
      ];
    }),
  ]);
  expect(
    document.querySelector(".chat-action-sources a")?.getAttribute("href"),
  ).toBe("https://example.com/docs");
  expect(document.querySelectorAll(".chat-action-sources a")).toHaveLength(1);
  const cards = document.querySelectorAll(".chat-action");
  expect(cards).toHaveLength(receipts.length);
  receipts.forEach((receipt, i) => {
    expect(cards[i].getAttribute("data-tool-kind")).toBe(receipt.kind);
    expect(cards[i].querySelector(".chat-action-label")?.textContent).toContain(
      receipt.label,
    );
    expect(cards[i].textContent).toContain(
      typeof receipt.output === "string" ? receipt.output : "Search evidence",
    );
    expect(
      cards[i].querySelector(".chat-action-record")?.textContent,
    ).toContain(receipt.name);
  });
});

it("shows a declined Claude tool as failed rather than a successful action", async () => {
  await mount([
    event(0, "message.user", { text: "Check the game" }),
    event(1, "tool.result", {
      source: "claude",
      item_id: "denied",
      name: "WebSearch",
      arguments: { query: "test" },
      result: { ok: false, result: { output: "Permission declined" } },
    }),
  ]);
  expect(
    document.querySelector(".chat-action.is-failed")?.textContent,
  ).toContain("Permission declined");
  expect(document.querySelector(".chat-action-status")?.textContent).toContain(
    "Failed",
  );
});
