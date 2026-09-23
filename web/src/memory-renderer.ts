import {
  layoutGraph,
  nodeColor,
  zoomCamera,
  type Camera,
  type LayoutMode,
  type MemoryScene,
  type Point,
  type MemoryEdge,
} from "./memory-graph";
export type Selection = { kind: "node" | "edge"; id: number };
export type GraphControls = {
  setScene: (scene: MemoryScene, mode: LayoutMode) => void;
  select: (s?: Selection) => void;
  fit: () => void;
  zoom: (factor: number) => void;
  trace: (enabled: boolean) => void;
  dispose: () => void;
};
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function along(a: Point, b: Point, bend: number, t: number): Point {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l = Math.hypot(dx, dy) || 1;
  return {
    x: mix(a.x, b.x, t) - (dy / l) * bend * 2 * t * (1 - t),
    y: mix(a.y, b.y, t) + (dx / l) * bend * 2 * t * (1 - t),
  };
}
/** Canvas owns presentation only. Every rendered edge is a stored Vecgra relationship. */
export function mountMemoryGraph(
  el: HTMLCanvasElement,
  callbacks: {
    onSelect: (s: Selection) => void;
    onFocus: (id: number) => void;
  },
): GraphControls {
  const ctx = el.getContext("2d");
  if (!ctx) throw new Error("Memory graph needs a canvas context");
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = media.matches,
    disposed = false,
    visible = true,
    trace = true,
    width = 0,
    height = 0,
    frame = 0,
    generation = 0;
  let scene: MemoryScene | undefined,
    mode: LayoutMode = "network",
    selection: Selection | undefined,
    hover: Selection | undefined;
  let points = new Map<number, Point>(),
    target = new Map<number, Point>(),
    origins = new Map<number, Point>(),
    born = new Set<number>();
  let layoutAt = -Infinity,
    camera: Camera = { x: 0, y: 0, scale: 1 },
    cameraFrom: Camera | undefined,
    cameraTo: Camera | undefined,
    cameraAt = 0,
    cameraDuration = 500;
  let attentionAt = 0;
  const widths = new Map<string, number>();
  function textWidth(text: string) {
    const key = ctx!.font + text;
    let width = widths.get(key);
    if (width === undefined) {
      width = ctx!.measureText(text).width;
      widths.set(key, width);
    }
    return width;
  }
  let worker: Worker | undefined;
  let pending:
    { generation: number; scene: MemoryScene; mode: LayoutMode } | undefined;
  const onWorker = (
    event: MessageEvent<{ generation: number; points: [number, Point][] }>,
  ) => {
    if (!disposed && pending && event.data.generation === generation)
      apply(pending.scene, pending.mode, new Map(event.data.points));
  };
  try {
    worker = new Worker(new URL("./memory-layout.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = onWorker;
    worker.onerror = () => {
      worker?.terminate();
      worker = undefined;
      if (pending && !disposed)
        apply(
          pending.scene,
          pending.mode,
          layoutGraph(pending.scene, pending.mode),
        );
    };
  } catch {
    /* Browser policy may block workers; bounded scenes also support a synchronous solve. */
  }
  function canDraw() {
    return !disposed && visible && !document.hidden && width > 0 && height > 0;
  }
  function request() {
    if (!frame && canDraw()) frame = requestAnimationFrame(paint);
  }
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }
  function apply(
    next: MemoryScene,
    nextMode: LayoutMode,
    positions: Map<number, Point>,
  ) {
    pending = undefined;
    el.setAttribute("aria-busy", "false");
    const now = performance.now();
    advance(now);
    const previous = points;
    scene = next;
    widths.clear();
    mode = nextMode;
    target = positions;
    origins = new Map();
    born = new Set();
    const roots = new Map(
      next.nodes.filter((n) => n.label === "Scope").map((n) => [n.scope, n.id]),
    );
    for (const n of next.nodes) {
      const p = positions.get(n.id)!;
      let start = previous.get(n.id);
      if (!start) {
        born.add(n.id);
        const root = roots.get(n.scope);
        start =
          root !== undefined
            ? previous.get(root) || positions.get(root)
            : undefined;
      }
      origins.set(
        n.id,
        start ? { ...start } : { x: p.x * 0.85, y: p.y * 0.85 },
      );
    }
    points = new Map([...origins].map(([id, p]) => [id, { ...p }]));
    layoutAt = now;
    if (reduced) {
      points = new Map([...target].map(([id, p]) => [id, { ...p }]));
      origins.clear();
      born.clear();
    }
    fit();
    request();
  }
  function advance(now: number) {
    if (origins.size) {
      const t = reduced ? 1 : ease((now - layoutAt) / 760);
      for (const [id, p] of target) {
        const from = origins.get(id);
        if (from)
          points.set(id, { x: mix(from.x, p.x, t), y: mix(from.y, p.y, t) });
      }
      if (t === 1) {
        origins.clear();
        born.clear();
      }
    }
    if (cameraTo && cameraFrom) {
      const t = reduced ? 1 : ease((now - cameraAt) / cameraDuration);
      camera = {
        x: mix(cameraFrom.x, cameraTo.x, t),
        y: mix(cameraFrom.y, cameraTo.y, t),
        scale: mix(cameraFrom.scale, cameraTo.scale, t),
      };
      if (t === 1) {
        cameraFrom = undefined;
        cameraTo = undefined;
      }
    }
  }
  function moveCamera(next: Camera, duration = 450) {
    advance(performance.now());
    if (reduced) {
      camera = next;
      cameraFrom = undefined;
      cameraTo = undefined;
    } else {
      cameraFrom = { ...camera };
      cameraTo = next;
      cameraAt = performance.now();
      cameraDuration = duration;
    }
    request();
  }
  function fit() {
    if (!target.size || !width || !height) return;
    const ps = [...target.values()],
      minX = Math.min(...ps.map((p) => p.x)),
      maxX = Math.max(...ps.map((p) => p.x)),
      minY = Math.min(...ps.map((p) => p.y)),
      maxY = Math.max(...ps.map((p) => p.y));
    // Labels stay screen-sized while the graph scales. Reserve screen-space
    // margins so overview labels cannot disappear beyond the canvas edge.
    const insetX = Math.min(65, width * 0.15),
      top = 52,
      bottom = 48;
    const scale = Math.min(
      2,
      (width - insetX * 2) / Math.max(1, maxX - minX),
      (height - top - bottom) / Math.max(1, maxY - minY),
    );
    const next = {
      scale,
      x: width / 2 - ((minX + maxX) / 2) * scale,
      y: top + (height - top - bottom) / 2 - ((minY + maxY) / 2) * scale,
    };
    if (!Number.isFinite(next.scale) || next.scale <= 0) return;
    if (camera.scale === 1 && camera.x === 0 && camera.y === 0) {
      camera = { ...next };
    }
    moveCamera(next, 650);
  }
  const project = (p: Point) => ({
    x: p.x * camera.scale + camera.x,
    y: p.y * camera.scale + camera.y,
  });
  const bendFor = (e: MemoryEdge) =>
    mode === "sequence"
      ? 0
      : e.label === "NEXT"
        ? Math.min(18, 8 * camera.scale) * (e.id % 2 ? 1 : -1)
        : 0;
  function paint(now: number) {
    frame = 0;
    if (!canDraw() || !scene) return;
    advance(now);
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (
      el.width !== Math.round(width * ratio) ||
      el.height !== Math.round(height * ratio)
    ) {
      el.width = Math.round(width * ratio);
      el.height = Math.round(height * ratio);
    }
    ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx!.clearRect(0, 0, width, height);
    const projected = new Map([...points].map(([id, p]) => [id, project(p)]));
    const active = hover || selection,
      chosenEdge =
        active?.kind === "edge"
          ? scene.edges.find((e) => e.id === active.id)
          : undefined;
    const chosen = new Set(
      chosenEdge
        ? [chosenEdge.source, chosenEdge.target]
        : active?.kind === "node"
          ? [active.id]
          : [],
    );
    const neighbors = new Set<number>();
    for (const e of scene.edges)
      if (chosen.has(e.source) || chosen.has(e.target)) {
        neighbors.add(e.source);
        neighbors.add(e.target);
      }
    const reveal = reduced ? 1 : ease((now - layoutAt) / 650),
      attention = reduced ? 1 : ease((now - attentionAt) / 220);
    const flowing = trace && !reduced;
    let animatedEdges = 0;
    for (const e of scene.edges) {
      const a = projected.get(e.source),
        b = projected.get(e.target);
      if (!a || !b) continue;
      if (
        (a.x < -30 && b.x < -30) ||
        (a.x > width + 30 && b.x > width + 30) ||
        (a.y < -30 && b.y < -30) ||
        (a.y > height + 30 && b.y > height + 30)
      )
        continue;
      const related = chosen.has(e.source) || chosen.has(e.target),
        isNext = e.label === "NEXT",
        bend = bendFor(e);
      const color = related
        ? isNext
          ? "#b8d7be"
          : "#eab17b"
        : isNext
          ? "#7eab95"
          : "#716049";
      ctx!.strokeStyle = color;
      ctx!.globalAlpha =
        (related
          ? 0.8
          : active
            ? mix(isNext ? 0.37 : 0.16, 0.1, attention)
            : isNext
              ? 0.4
              : 0.16) * reveal;
      ctx!.lineWidth = related ? 1.1 : 0.75;
      const middle = along(a, b, bend, 0.5),
        control = {
          x: middle.x * 2 - (a.x + b.x) / 2,
          y: middle.y * 2 - (a.y + b.y) / 2,
        };
      ctx!.beginPath();
      ctx!.moveTo(a.x, a.y);
      ctx!.quadraticCurveTo(control.x, control.y, b.x, b.y);
      ctx!.stroke();
      if (related) {
        const end = along(a, b, bend, 0.91),
          before = along(a, b, bend, 0.85),
          angle = Math.atan2(end.y - before.y, end.x - before.x);
        ctx!.beginPath();
        ctx!.moveTo(
          end.x - Math.cos(angle - 0.5) * 5,
          end.y - Math.sin(angle - 0.5) * 5,
        );
        ctx!.lineTo(end.x, end.y);
        ctx!.lineTo(
          end.x - Math.cos(angle + 0.5) * 5,
          end.y - Math.sin(angle + 0.5) * 5,
        );
        ctx!.stroke();
      }
      if (flowing && (related || (!active && isNext))) {
        animatedEdges++;
        const phase =
          (now / (related ? 2100 : 4200) + ((e.id * 0.61803398875) % 1)) % 1;
        for (let trail = 3; trail >= 0; trail--) {
          const t = phase - trail * 0.013;
          if (t < 0.03 || t > 0.95) continue;
          const q = along(a, b, bend, t);
          ctx!.fillStyle = related ? "#ffc18a" : "#a6c4ac";
          ctx!.globalAlpha = (related ? 0.95 : 0.65) * (1 - trail / 4) * reveal;
          const size = trail === 0 ? (related ? 3 : 2) : 1.5;
          ctx!.fillRect(
            Math.round(q.x - size / 2),
            Math.round(q.y - size / 2),
            size,
            size,
          );
        }
      }
      if (chosenEdge?.id === e.id) {
        ctx!.font = '10px "IBM Plex Mono"';
        ctx!.globalAlpha = 1;
        const text = e.label,
          tw = textWidth(text);
        ctx!.fillStyle = "#141415";
        ctx!.fillRect(middle.x - tw / 2 - 5, middle.y - 18, tw + 10, 16);
        ctx!.fillStyle = "#edbe8c";
        ctx!.textAlign = "center";
        ctx!.fillText(text, middle.x, middle.y - 6);
        ctx!.textAlign = "left";
      }
    }
    const labels: {
      text: string;
      p: Point;
      scope: boolean;
      chosen: boolean;
      count: number;
      width: number;
    }[] = [];
    const groupCounts = new Map<string, number>();
    for (const n of scene.nodes)
      if (n.label !== "Scope")
        groupCounts.set(n.scope, (groupCounts.get(n.scope) || 0) + 1);
    const scopeWidths = new Map<string, number>();
    const roots = new Map(
      scene.nodes
        .filter((n) => n.label === "Scope")
        .map((n) => [n.scope, n.id]),
    );
    for (const n of scene.nodes) {
      const p = projected.get(n.id)!;
      const root = roots.get(n.scope);
      if (root !== undefined) {
        const rp = projected.get(root)!;
        scopeWidths.set(
          n.scope,
          Math.max(scopeWidths.get(n.scope) || 0, Math.abs(p.x - rp.x) * 2),
        );
      }
    }
    for (const n of scene.nodes) {
      const p = projected.get(n.id);
      if (
        !p ||
        p.x < -100 ||
        p.x > width + 100 ||
        p.y < -50 ||
        p.y > height + 50
      )
        continue;
      const selected = chosen.has(n.id),
        related = neighbors.has(n.id),
        scope = n.label === "Scope",
        r = scope ? 7 : 3.5;
      const opacity =
        (active && !selected && !related ? mix(1, 0.32, attention) : 1) *
        (born.has(n.id) ? reveal : 1);
      if (selected) {
        ctx!.fillStyle = "#e9a36b";
        // A moving ordered-dither rim identifies the record being traced.
        const phase = flowing ? now * 0.0012 : 0;
        for (let x = -24; x <= 24; x += 4)
          for (let y = -24; y <= 24; y += 4) {
            const distance = Math.hypot(x, y);
            if (distance > 14 && distance < 24 && (x + y) % 8 === 0) {
              const sweep = (Math.cos(Math.atan2(y, x) - phase) + 1) / 2;
              ctx!.globalAlpha =
                ((24 - distance) / 15) * (flowing ? 0.2 + sweep * 0.7 : 0.55);
              ctx!.fillRect(Math.round(p.x + x), Math.round(p.y + y), 1.5, 1.5);
            }
          }
        ctx!.globalAlpha = 0.95;
        ctx!.strokeStyle = "#edb77d";
        ctx!.lineWidth = 1;
        const corner = 13 + (flowing ? Math.sin(now * 0.002) * 1.5 : 0),
          length = 5;
        ctx!.beginPath();
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ]) {
          ctx!.moveTo(p.x + sx * corner, p.y + sy * (corner - length));
          ctx!.lineTo(p.x + sx * corner, p.y + sy * corner);
          ctx!.lineTo(p.x + sx * (corner - length), p.y + sy * corner);
        }
        ctx!.stroke();
      }
      ctx!.globalAlpha = opacity;
      ctx!.fillStyle = nodeColor(n.category);
      if (scope) {
        ctx!.beginPath();
        ctx!.moveTo(p.x, p.y - r);
        ctx!.lineTo(p.x + r, p.y);
        ctx!.lineTo(p.x, p.y + r);
        ctx!.lineTo(p.x - r, p.y);
        ctx!.closePath();
        ctx!.fill();
        ctx!.fillStyle = "#141415";
        ctx!.fillRect(p.x - 2, p.y - 2, 4, 4);
      } else {
        const size = r * 2 * (born.has(n.id) ? Math.max(0.2, reveal) : 1);
        ctx!.fillRect(
          Math.round(p.x - size / 2),
          Math.round(p.y - size / 2),
          size,
          size,
        );
        if (n.vectors) {
          ctx!.fillStyle = "#141415";
          ctx!.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
        }
      }
      if (scope || selected || (camera.scale > 1.8 && related))
        labels.push({
          text: scope ? n.title : `${n.title} · #${n.id}`,
          p,
          scope,
          chosen: selected,
          count: groupCounts.get(n.scope) || 0,
          width: selected
            ? 230
            : scope
              ? Math.max(
                  80,
                  Math.min(205, (scopeWidths.get(n.scope) || 110) + 20),
                )
              : 180,
        });
    }
    // Labels are painted last, outside the event field, so nodes cannot obscure them.
    const occupied: { x: number; y: number; w: number; h: number }[] = [];
    labels.sort(
      (a, b) =>
        Number(b.chosen) - Number(a.chosen) ||
        Number(b.scope) - Number(a.scope),
    );
    for (const label of labels) {
      const { p, scope } = label;
      ctx!.font = scope ? '500 12px "Chakra Petch"' : '10px "IBM Plex Mono"';
      let text = label.text;
      while (text.length > 4 && textWidth(text) > label.width)
        text = text.slice(0, -2).replace(/…$/, "") + "…";
      const w = textWidth(text) + 10,
        x = p.x - w / 2,
        y = scope ? p.y - 41 : p.y + 17;
      if (
        !label.chosen &&
        occupied.some(
          (r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + 17 > r.y,
        )
      )
        continue;
      occupied.push({ x, y, w, h: 17 });
      ctx!.globalAlpha = 1;
      ctx!.fillStyle = "#141415";
      ctx!.fillRect(x, y, w, 17);
      ctx!.fillStyle = label.chosen ? "#ffd1a0" : "#cfc2ad";
      ctx!.textAlign = "center";
      ctx!.fillText(text, p.x, y + 12);
      if (scope && !active) {
        ctx!.font = '9px "IBM Plex Mono"';
        ctx!.fillStyle = "#8f826d";
        ctx!.fillText(`${label.count} in view`, p.x, p.y - 14);
      }
    }
    ctx!.textAlign = "left";
    ctx!.globalAlpha = 1;
    if (
      !reduced &&
      (origins.size ||
        cameraTo ||
        now - attentionAt < 220 ||
        (flowing && (animatedEdges || chosen.size)))
    )
      request();
  }
  function position(e: PointerEvent | WheelEvent | MouseEvent) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function hit(p: Point, touch = false): Selection | undefined {
    if (!scene) return;
    let nearest: Selection | undefined,
      best = touch ? 22 : 15;
    for (const n of scene.nodes) {
      const value = points.get(n.id);
      if (!value) continue;
      const v = project(value),
        d = Math.hypot(p.x - v.x, p.y - v.y);
      if (d < Math.min(best, touch ? 22 : n.label === "Scope" ? 15 : 11)) {
        best = d;
        nearest = { kind: "node", id: n.id };
      }
    }
    if (nearest) return nearest;
    best = touch ? 9 : 5;
    for (const e of scene.edges) {
      const ap = points.get(e.source),
        bp = points.get(e.target);
      if (!ap || !bp) continue;
      const a = project(ap),
        b = project(bp),
        bend = bendFor(e);
      let prev = a;
      for (let i = 1; i <= 12; i++) {
        const next = along(a, b, bend, i / 12),
          dx = next.x - prev.x,
          dy = next.y - prev.y,
          t = Math.max(
            0,
            Math.min(
              1,
              ((p.x - prev.x) * dx + (p.y - prev.y) * dy) /
                (dx * dx + dy * dy || 1),
            ),
          ),
          d = Math.hypot(p.x - prev.x - t * dx, p.y - prev.y - t * dy);
        if (d < best) {
          best = d;
          nearest = { kind: "edge", id: e.id };
        }
        prev = next;
      }
    }
    return nearest;
  }
  let drag:
    | { start: Point; last: Point; target?: Selection; moved: boolean }
    | undefined;
  const pointers = new Map<number, Point>();
  let pinch = 0;
  function cancelCamera() {
    advance(performance.now());
    cameraFrom = undefined;
    cameraTo = undefined;
  }
  function down(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType !== "touch") return;
    cancelCamera();
    const p = position(e);
    pointers.set(e.pointerId, p);
    el.setPointerCapture(e.pointerId);
    drag = {
      start: p,
      last: p,
      target: hit(p, e.pointerType === "touch"),
      moved: false,
    };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
    el.focus({ preventScroll: true });
  }
  function move(e: PointerEvent) {
    const p = position(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()],
        distance = Math.hypot(a.x - b.x, a.y - b.y);
      camera = zoomCamera(
        camera,
        { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        (camera.scale * distance) / (pinch || distance),
      );
      pinch = distance;
      if (drag) drag.moved = true;
      request();
      return;
    }
    if (drag && pointers.has(e.pointerId)) {
      drag.moved ||= Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4;
      if (drag.moved) {
        if (drag.target?.kind === "node") {
          const id = drag.target.id,
            point = points.get(id)!;
          point.x += (p.x - drag.last.x) / camera.scale;
          point.y += (p.y - drag.last.y) / camera.scale;
          target.set(id, { ...point });
          origins.delete(id);
        } else {
          camera.x += p.x - drag.last.x;
          camera.y += p.y - drag.last.y;
        }
        request();
      }
      drag.last = p;
    } else {
      const next = hit(p);
      if (next?.id !== hover?.id || next?.kind !== hover?.kind) {
        hover = next;
        attentionAt = performance.now();
        el.style.cursor = next ? "pointer" : "grab";
        request();
      }
    }
  }
  function up(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (drag && !drag.moved && drag.target) callbacks.onSelect(drag.target);
    drag = undefined;
    pinch = 0;
  }
  function cancel(e: PointerEvent) {
    pointers.delete(e.pointerId);
    drag = undefined;
    pinch = 0;
  }
  function leave() {
    hover = undefined;
    attentionAt = performance.now();
    request();
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    const start = cameraTo || camera;
    moveCamera(
      zoomCamera(
        start,
        position(e),
        start.scale * Math.exp(-e.deltaY * 0.0015),
      ),
      140,
    );
  }
  function double(e: MouseEvent) {
    const s = hit(position(e));
    if (s?.kind === "node") callbacks.onFocus(s.id);
  }
  function zoom(factor: number) {
    const start = cameraTo || camera;
    moveCamera(
      zoomCamera(start, { x: width / 2, y: height / 2 }, start.scale * factor),
    );
  }
  function key(e: KeyboardEvent) {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "+",
        "=",
        "-",
        "0",
        "Enter",
      ].includes(e.key)
    )
      return;
    e.preventDefault();
    if (e.key === "0") fit();
    else if (["+", "=", "-"].includes(e.key)) zoom(e.key === "-" ? 0.8 : 1.25);
    else if (e.key === "Enter" && selection?.kind === "node")
      callbacks.onFocus(selection.id);
    else {
      const start = cameraTo || camera;
      moveCamera(
        {
          ...start,
          x:
            start.x +
            (e.key === "ArrowLeft" ? 45 : e.key === "ArrowRight" ? -45 : 0),
          y:
            start.y +
            (e.key === "ArrowUp" ? 45 : e.key === "ArrowDown" ? -45 : 0),
        },
        170,
      );
    }
  }
  function visibility() {
    if (canDraw()) request();
    else stop();
  }
  function motion() {
    reduced = media.matches;
    if (reduced) {
      advance(Infinity);
      attentionAt = -Infinity;
    }
    request();
  }
  const resize = new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    width = r.width;
    height = r.height;
    if (width && height) {
      fit();
      request();
    } else stop();
  });
  resize.observe(el);
  const intersection =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          visible = entries[0]?.isIntersecting ?? true;
          visibility();
        });
  intersection?.observe(el);
  document.addEventListener("visibilitychange", visibility);
  media.addEventListener("change", motion);
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", leave);
  el.addEventListener("wheel", wheel, { passive: false });
  el.addEventListener("dblclick", double);
  el.addEventListener("keydown", key);
  return {
    setScene(next, nextMode) {
      if (disposed) return;
      if (
        !pending &&
        scene &&
        mode === nextMode &&
        scene.nodes.length === next.nodes.length &&
        scene.edges.length === next.edges.length &&
        next.nodes.every(
          (n, i) =>
            n.id === scene!.nodes[i].id &&
            n.scope === scene!.nodes[i].scope &&
            n.label === scene!.nodes[i].label,
        ) &&
        next.edges.every((e, i) => {
          const old = scene!.edges[i];
          return (
            e.id === old.id &&
            e.source === old.source &&
            e.target === old.target &&
            e.label === old.label
          );
        })
      ) {
        scene = next;
        request();
        return;
      }
      const job = { generation: ++generation, scene: next, mode: nextMode };
      pending = job;
      el.setAttribute("aria-busy", "true");
      if (worker) worker.postMessage(job);
      else apply(next, nextMode, layoutGraph(next, nextMode));
    },
    select(s) {
      if (selection?.kind === s?.kind && selection?.id === s?.id) return;
      selection = s;
      attentionAt = performance.now();
      request();
    },
    fit,
    zoom,
    trace(enabled) {
      trace = enabled;
      request();
    },
    dispose() {
      disposed = true;
      stop();
      worker?.terminate();
      resize.disconnect();
      intersection?.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      media.removeEventListener("change", motion);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("dblclick", double);
      el.removeEventListener("keydown", key);
    },
  };
}
