import { useEffect, useRef } from "react";
import { type LayoutMode, type MemoryScene } from "./memory-graph";
import {
  mountMemoryGraph,
  type GraphControls,
  type Selection,
} from "./memory-renderer";
export type { Selection } from "./memory-renderer";
export function MemoryGraph({
  scene,
  selected,
  onSelect,
  onFocus,
  fitKey,
  zoom,
  layout = "network",
  trace = true,
}: {
  scene: MemoryScene;
  selected?: Selection;
  onSelect: (s: Selection) => void;
  onFocus: (id: number) => void;
  fitKey: number;
  zoom: number;
  layout?: LayoutMode;
  trace?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    renderer = useRef<GraphControls | undefined>(undefined);
  const callbacks = useRef({ onSelect, onFocus });
  callbacks.current = { onSelect, onFocus };
  useEffect(() => {
    const controls = mountMemoryGraph(canvas.current!, {
      onSelect: (s) => callbacks.current.onSelect(s),
      onFocus: (id) => callbacks.current.onFocus(id),
    });
    renderer.current = controls;
    return () => {
      controls.dispose();
      renderer.current = undefined;
    };
  }, []);
  useEffect(() => {
    renderer.current?.setScene(scene, layout);
  }, [scene, layout]);
  useEffect(() => {
    renderer.current?.select(selected);
  }, [selected?.kind, selected?.id]);
  useEffect(() => {
    renderer.current?.fit();
  }, [fitKey]);
  useEffect(() => {
    renderer.current?.trace(trace);
  }, [trace]);
  const previousZoom = useRef(zoom);
  useEffect(() => {
    if (zoom !== previousZoom.current)
      renderer.current?.zoom(Math.pow(1.3, zoom - previousZoom.current));
    previousZoom.current = zoom;
  }, [zoom]);
  return (
    <canvas
      ref={canvas}
      className="memory-canvas"
      tabIndex={0}
      role="img"
      aria-label={`Memory graph: ${scene.nodes.length} nodes and ${scene.edges.length} relationships. ${layout === "sequence" ? "Sequence" : "Network"} layout. Drag to pan or move nodes; scroll to zoom. Arrow keys pan, plus and minus zoom, zero fits. Select records in the results list for keyboard inspection.`}
    />
  );
}
