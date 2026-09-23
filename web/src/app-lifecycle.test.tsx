// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";

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
// Graphics initialization is independent of the React effect lifecycle under test.
vi.mock("./gpu", () => ({}));

class WorkspaceSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() {
    this.onclose?.();
  }
}
afterEach(async () => {
  await act(async () => mounted.root?.unmount());
  mounted.root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});
it.each(["promise", "legacy"] as const)(
  "renders chat updates and unmounts with %s-returning scrollIntoView",
  async (mode) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", WorkspaceSocket);
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(
      () =>
        (mode === "promise"
          ? Promise.resolve({ interrupted: false })
          : undefined) as unknown as void,
    );
    const state = {
      devices: [
        { id: "local", name: "This machine", target: null, status: "online" },
      ],
      sessions: [],
      chats: [
        { id: "chat", name: "Workspace", created_at: "2026-09-22T22:00:00Z" },
      ],
      events: [
        {
          id: 1,
          kind: "message.assistant",
          scope: "chat",
          time: "2026-09-22T22:00:00Z",
          payload: { text: "Your workspace is ready." },
        },
      ],
      live: [],
      running: [],
      event_count: 1,
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
      expect(document.body.textContent).toContain("Your workspace is ready.");
      expect(document.body.textContent).not.toContain("Something went wrong");
    });
    // This exercises the cleanup React calls after the effect has already run.
    await act(async () => {
      mounted.root!.unmount();
    });
    mounted.root = undefined;
  },
);
