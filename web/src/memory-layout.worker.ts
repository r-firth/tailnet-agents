import { layoutGraph, type LayoutMode, type MemoryScene } from "./memory-graph";
self.onmessage = (
  event: MessageEvent<{
    generation: number;
    scene: MemoryScene;
    mode: LayoutMode;
  }>,
) => {
  const { generation, scene, mode } = event.data;
  self.postMessage({ generation, points: [...layoutGraph(scene, mode)] });
};
