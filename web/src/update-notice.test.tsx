// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UpdateNotice } from "./UpdateNotice";

let root: Root;
const reload = vi.fn();
const fetchBuild = vi.fn();
async function render(canReload = true, buildId = "loaded-build") {
  await act(async () => {
    root.render(
      <UpdateNotice
        buildId={buildId}
        canReload={canReload}
        onReload={reload}
      />,
    );
  });
}
async function focus() {
  await act(async () => window.dispatchEvent(new Event("focus")));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchBuild);
  fetchBuild.mockResolvedValue(Response.json({ build_id: "loaded-build" }));
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("detects a deployment on return and only reloads explicitly after a draft is finished", async () => {
  await render(false);
  expect(document.body.textContent).toBe("");
  fetchBuild.mockResolvedValue(Response.json({ build_id: "new-build" }));
  await focus();
  expect(document.body.textContent).toContain("Update ready");
  expect(document.body.textContent).toContain("Finish your draft");
  expect(document.querySelector("button")?.disabled).toBe(true);
  expect(reload).not.toHaveBeenCalled();
  await render();
  expect(document.querySelector("button")?.disabled).toBe(false);
  await act(async () => document.querySelector("button")!.click());
  expect(reload).toHaveBeenCalledOnce();
  expect(fetchBuild).toHaveBeenCalledWith(
    "/build.json",
    expect.objectContaining({
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }),
  );
});

it("ignores unavailable or malformed manifests and retries later", async () => {
  fetchBuild.mockRejectedValueOnce(new Error("Offline"));
  await render();
  for (const response of [
    new Response("not found", { status: 404 }),
    new Response("<html>SPA fallback</html>"),
    Response.json({ build_id: "" }),
    Response.json({ build_id: 123 }),
    Response.json({}),
  ]) {
    fetchBuild.mockResolvedValueOnce(response);
    await focus();
    expect(document.body.textContent).toBe("");
  }
  fetchBuild.mockResolvedValueOnce(Response.json({ build_id: "new-build" }));
  await focus();
  expect(document.body.textContent).toContain("Update ready");
  expect(reload).not.toHaveBeenCalled();
});

it("checks while visible and removes its timer and listeners on unmount", async () => {
  vi.useFakeTimers();
  await render();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetchBuild).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetchBuild).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetchBuild).toHaveBeenCalledTimes(3);
  await act(async () => root.render(null));
  await focus();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetchBuild).toHaveBeenCalledTimes(3);
});

it("leaves development builds to Vite HMR", async () => {
  await render(true, "");
  await focus();
  expect(fetchBuild).not.toHaveBeenCalled();
});
