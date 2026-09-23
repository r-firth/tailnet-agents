// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import MemoryViewer, { memoryParams } from "./MemoryViewer";
vi.mock("./gpu", () => ({ mountSignal: () => () => {} }));
vi.mock("./MemoryGraph", () => ({
  MemoryGraph: () => <canvas aria-label="Graph" />,
}));
let root: Root, client: QueryClient;
const requests: { url: string; signal?: AbortSignal; method?: string }[] = [];
const node = {
  id: 7,
  label: "Event",
  kind: "message.assistant",
  category: "message",
  title: "Coordinator",
  scope: "closed-chat",
  scope_name: "Archived renderer",
  excerpt: "The renderer is stable.",
  vectors: 1,
  run_id: 4,
  time: "2026-09-23T12:00:00Z",
};
const scene = {
  nodes: [node],
  edges: [],
  stats: { nodes: 1, edges: 0, vectors: 1, runs: 1 },
  next_offset: null,
};
async function settle(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
    assertion();
  });
}
async function mount(slow = false, progressive = false) {
  let semanticCalls = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests.length = 0;
  window.history.replaceState(
    null,
    "",
    progressive ? "/memory?q=related&mode=hybrid" : "/memory",
  );
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({
      url,
      signal: init.signal as AbortSignal,
      method: init.method,
    });
    if (url.includes("/search?")) {
      const q = new URL(url, "http://localhost").searchParams.get("q");
      if (progressive) {
        const pending = ++semanticCalls === 1;
        return Response.json({
          hits: [
            {
              ...node,
              excerpt: pending ? "Text match first" : "Qwen found related work",
            },
          ],
          total: 1,
          next_offset: null,
          elapsed_ms: 1,
          semantic: !pending,
          semantic_pending: pending,
        });
      }
      if (slow && q === "slow")
        await new Promise((resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
          setTimeout(resolve, 500);
        });
      return Response.json({
        hits:
          q === "missing"
            ? []
            : [
                {
                  ...node,
                  excerpt: q === "slow" ? "Stale response" : node.excerpt,
                },
              ],
        total: q === "missing" ? 0 : 1,
        next_offset: null,
        elapsed_ms: 1,
      });
    }
    if (url.includes("/graph?")) return Response.json(scene);
    if (url.includes("/element/node/7"))
      return Response.json({
        ...node,
        properties: { kind: node.kind },
        vector: Array(384).fill(0.1),
        neighbors: [],
      });
    if (url.includes("/runs/4"))
      return Response.json({
        id: 4,
        name: "Archived renderer",
        prompt: "Investigate renderer",
        status: "Complete",
        time: node.time,
        events: [
          {
            id: 7,
            kind: node.kind,
            time: node.time,
            payload: { text: node.excerpt },
          },
        ],
        total: 1,
        offset: 0,
        next_offset: null,
        previous_offset: null,
        previous_run: null,
        next_run: null,
      });
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  const rootRoute = createRootRoute({ component: MemoryViewer });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/memory",
    validateSearch: (s) => s,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([route]) });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await settle(() =>
    expect(document.querySelector(".memory-result")).not.toBeNull(),
  );
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
  });
}
async function type(value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="Search memory"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("opens the selected source in a closed run, exposes its embedding, and never reopens a session", async () => {
  await mount();
  await click(document.querySelector(".memory-result"));
  await settle(() =>
    expect(document.querySelector(".memory-vector-map")?.children.length).toBe(
      384,
    ),
  );
  await click(
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "View source run ",
    ) || null,
  );
  await settle(() =>
    expect(
      document.querySelector(".memory-run-event.is-source")?.textContent,
    ).toContain("The renderer is stable."),
  );
  expect(requests.some((r) => r.url.includes("/runs/4?anchor=7"))).toBe(true);
  expect(requests.every((r) => !r.method || r.method === "GET")).toBe(true);
  expect(window.location.search).toContain("run=4");
  await click(document.querySelector('[aria-label="Close source run"]'));
  await settle(() =>
    expect(document.querySelector(".memory-graph-panel")).not.toBeNull(),
  );
});
it("cancels stale searches and shows a clear empty result", async () => {
  await mount(true);
  await type("slow");
  await settle(() =>
    expect(requests.some((r) => r.url.includes("q=slow"))).toBe(true),
  );
  await type("missing");
  await settle(() =>
    expect(document.querySelector(".memory-results")?.textContent).toContain(
      "No matching records.",
    ),
  );
  expect(requests.find((r) => r.url.includes("q=slow"))?.signal?.aborted).toBe(
    true,
  );
  expect(document.querySelector(".memory-results")?.textContent).not.toContain(
    "Stale response",
  );
});

it("accepts real zero-valued Vecgra IDs without turning missing parameters into zero", () => {
  expect(memoryParams({ node: 0, edge: 0, focus: 0 })).toMatchObject({
    node: 0,
    edge: 0,
    focus: 0,
  });
  expect(memoryParams({})).toMatchObject({
    node: undefined,
    edge: undefined,
    focus: undefined,
  });
  expect(
    memoryParams({ node: -1, edge: "junk", focus: null }).node,
  ).toBeUndefined();
});

it("replaces provisional text matches when the pending semantic search completes", async () => {
  await mount(false, true);
  expect(document.querySelector(".memory-results")?.textContent).toContain(
    "Text match first",
  );
  await settle(() =>
    expect(document.querySelector(".memory-results")?.textContent).toContain(
      "Qwen found related work",
    ),
  );
  const completed = requests.filter((r) => r.url.includes("/search?")).length;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 650));
  });
  expect(requests.filter((r) => r.url.includes("/search?")).length).toBe(
    completed,
  );
});
