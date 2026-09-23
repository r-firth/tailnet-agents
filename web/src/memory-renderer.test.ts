// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { mountMemoryGraph, type GraphControls } from "./memory-renderer";
import { layoutGraph, type MemoryScene } from "./memory-graph";
const scene: MemoryScene = {
  nodes: [
    {
      id: 0,
      scope: "a",
      scope_name: "Context",
      label: "Scope",
      kind: "scope",
      category: "scope",
      title: "Context",
      excerpt: "",
      vectors: 0,
    },
    ...Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      scope: "a",
      scope_name: "Context",
      label: "Event",
      kind: "message.user",
      category: "message",
      title: "Event",
      excerpt: "",
      vectors: 0,
    })),
  ],
  edges: [
    { id: 0, source: 0, target: 1, label: "HAS_EVENT" },
    { id: 1, source: 1, target: 2, label: "NEXT" },
    { id: 2, source: 2, target: 3, label: "NEXT" },
  ],
  stats: { nodes: 4, edges: 3, vectors: 0, runs: 1 },
  next_offset: null,
  elapsed_ms: 0,
};
let controls: GraphControls | undefined;
afterEach(() => {
  controls?.dispose();
  controls = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function mount(worker?: unknown) {
  let now = 0,
    next = 0,
    hidden = false,
    draws = 0,
    resize = () => {};
  const frames = new Map<number, FrameRequestCallback>(),
    pixels: number[][] = [],
    labels: string[] = [];
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("devicePixelRatio", 1);
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++next, cb);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "Worker",
    worker ||
      class {
        constructor() {
          throw new Error("Worker unavailable");
        }
      },
  );
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {
        resize();
      }
      disconnect() {}
    },
  );
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    width: 700,
    height: 500,
    left: 0,
    top: 0,
  } as DOMRect);
  const context = {
    globalAlpha: 1,
    font: "",
    setTransform() {},
    clearRect() {
      pixels.length = 0;
      labels.length = 0;
      draws++;
    },
    fillRect(x: number, y: number, w: number, h: number) {
      pixels.push([x, y, w, h, this.globalAlpha]);
    },
    fillText(text: string) {
      labels.push(text);
    },
    measureText(text: string) {
      return { width: text.length * 6 };
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    stroke() {},
    closePath() {},
    fill() {},
  };
  vi.spyOn(canvas, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  controls = mountMemoryGraph(canvas, { onSelect() {}, onFocus() {} });
  return {
    canvas,
    media,
    pixels,
    labels,
    frames,
    controls,
    draws: () => draws,
    step(time: number) {
      now = time;
      const queue = [...frames.values()];
      frames.clear();
      queue.forEach((cb) => cb(time));
    },
    hidden(value: boolean) {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}
it("renders moving direction traces on each display frame, including 120Hz", () => {
  const h = mount();
  h.controls.setScene(scene, "network");
  h.step(1000);
  const initial = JSON.stringify(h.pixels),
    before = h.draws();
  for (const time of [1008.33, 1016.66, 1024.99, 1033.32, 1041.65, 1049.98])
    h.step(time);
  expect(h.draws() - before).toBe(6);
  h.step(1600);
  expect(JSON.stringify(h.pixels)).not.toEqual(initial);
  h.controls.dispose();
  expect(h.frames.size).toBe(0);
});
it("stops when paused, hidden, or reduced motion is requested, and resumes without a backlog", () => {
  const h = mount();
  h.controls.setScene(scene, "network");
  h.step(1000);
  h.controls.trace(false);
  h.step(1100);
  expect(h.frames.size).toBe(0);
  const pixels = JSON.stringify(h.pixels);
  h.step(2000);
  expect(JSON.stringify(h.pixels)).toBe(pixels);
  h.controls.trace(true);
  h.step(2100);
  expect(h.frames.size).toBe(1);
  h.hidden(true);
  expect(h.frames.size).toBe(0);
  const count = h.draws();
  h.step(10000);
  expect(h.draws()).toBe(count);
  h.hidden(false);
  h.step(10008);
  expect(h.draws()).toBe(count + 1);
  expect(h.frames.size).toBe(1);
  h.media.matches = true;
  h.media.dispatchEvent(new Event("change"));
  h.step(10100);
  expect(h.frames.size).toBe(0);
  h.controls.setScene(scene, "sequence");
  h.step(10200);
  expect(h.pixels.length).toBeGreaterThan(0);
  expect(h.frames.size).toBe(0);
});
it("rejects a stale worker layout when newer context has already arrived", () => {
  let receiver: ((e: MessageEvent) => void) | null = null;
  const jobs: any[] = [];
  class Worker {
    set onmessage(cb: (e: MessageEvent) => void) {
      receiver = cb;
    }
    postMessage(job: unknown) {
      jobs.push(job);
    }
    terminate() {}
  }
  const h = mount(Worker);
  h.controls.setScene(scene, "network");
  const latest = {
    ...scene,
    nodes: scene.nodes.map((n) => ({ ...n, title: "Latest context" })),
  };
  h.controls.setScene(latest, "sequence");
  receiver!({
    data: {
      generation: jobs[1].generation,
      points: [...layoutGraph(latest, "sequence")],
    },
  } as MessageEvent);
  h.step(1000);
  expect(h.labels).toContain("Latest context");
  receiver!({
    data: { generation: jobs[0].generation, points: [...layoutGraph(scene)] },
  } as MessageEvent);
  h.step(1100);
  expect(h.labels).toContain("Latest context");
  expect(h.labels).not.toContain("Context");
});
it("preserves the camera on metadata-only refreshes", () => {
  const h = mount();
  h.controls.trace(false);
  h.controls.setScene(scene, "network");
  h.step(1000);
  h.canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
  h.step(2000);
  const positions = h.pixels
    .filter((p) => p[2] === 7)
    .map((p) => p.slice(0, 2));
  h.controls.setScene(
    { ...scene, stats: { ...scene.stats, vectors: 1 } },
    "network",
  );
  h.step(3000);
  expect(h.pixels.filter((p) => p[2] === 7).map((p) => p.slice(0, 2))).toEqual(
    positions,
  );
});
