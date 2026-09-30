// High-rate data that should not re-render React: live frames and terminal bytes.

export interface Frame { src: string; w: number; h: number; at: number }

const frames = new Map<string, Frame>();
const frameSubs = new Map<string, Set<(f: Frame) => void>>();
const everFramed = new Set<string>();

export function pushFrame(taskId: string, data: string, w: number, h: number): void {
  const f: Frame = { src: `data:image/jpeg;base64,${data}`, w, h, at: Date.now() };
  frames.set(taskId, f);
  const first = !everFramed.has(taskId);
  everFramed.add(taskId);
  frameSubs.get(taskId)?.forEach((fn) => fn(f));
  if (first) firstFrameSubs.forEach((fn) => fn(taskId));
}
export const getFrame = (taskId: string) => frames.get(taskId);
export const hasFrames = (taskId: string) => everFramed.has(taskId);
export function onFrame(taskId: string, fn: (f: Frame) => void): () => void {
  let s = frameSubs.get(taskId);
  if (!s) frameSubs.set(taskId, (s = new Set()));
  s.add(fn);
  return () => { s!.delete(fn); };
}
const firstFrameSubs = new Set<(taskId: string) => void>();
export function onFirstFrame(fn: (taskId: string) => void): () => void {
  firstFrameSubs.add(fn);
  return () => { firstFrameSubs.delete(fn); };
}

const termSubs = new Map<string, Set<(d: string) => void>>();
export function pushTerminal(taskId: string, data: string): void {
  termSubs.get(taskId)?.forEach((fn) => fn(data));
}
export function onTerminal(taskId: string, fn: (d: string) => void): () => void {
  let s = termSubs.get(taskId);
  if (!s) termSubs.set(taskId, (s = new Set()));
  s.add(fn);
  return () => { s!.delete(fn); };
}
