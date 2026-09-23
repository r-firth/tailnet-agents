// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { trackViewport } from "./mobile-viewport";

it("keeps the composer above the keyboard and restores the full viewport", () => {
  const viewport = Object.assign(new EventTarget(), {
    height: 844,
    offsetTop: 0,
  });
  const frame = document.createElement("div");
  const input = document.createElement("textarea");
  frame.append(input);
  document.body.append(frame);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const dispose = trackViewport(frame, viewport as VisualViewport);
  try {
    expect(frame.style.getPropertyValue("--app-height")).toBe("844px");
    input.focus();
    viewport.height = 470;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new Event("resize"));
    expect(frame.style.getPropertyValue("--app-height")).toBe("470px");
    expect(frame.dataset.keyboard).toBe("open");
    expect(frame.style.getPropertyValue("--viewport-top")).toBe("12px");
    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    expect(frame.dataset.keyboard).toBe("closed");
    dispose();
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
    expect(frame.style.getPropertyValue("--app-height")).toBe("");
  } finally {
    dispose();
    frame.remove();
    vi.unstubAllGlobals();
  }
});
