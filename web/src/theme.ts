import { useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
const KEY = 'familiar.theme';

function readMode(): ThemeMode {
  try { const v = localStorage.getItem(KEY); if (v === 'light' || v === 'dark' || v === 'system') return v; } catch { /* private mode */ }
  return 'system';
}
const mq = () => matchMedia('(prefers-color-scheme: light)');
export function resolved(mode: ThemeMode): 'light' | 'dark' { return mode === 'system' ? (mq().matches ? 'light' : 'dark') : mode; }

let mode: ThemeMode = readMode();
const subs = new Set<() => void>();
export function applyTheme(): void {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme; else root.dataset.theme = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved(mode) === 'light' ? '#f3f1ec' : '#100f0e');
}
export function setMode(m: ThemeMode): void {
  mode = m;
  try { localStorage.setItem(KEY, m); } catch { /* ignore */ }
  applyTheme();
  subs.forEach((f) => f());
}
export function cycleTheme(): ThemeMode {
  const order: ThemeMode[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(mode) + 1) % 3];
  setMode(next);
  return next;
}
export function useTheme(): { mode: ThemeMode; resolved: 'light' | 'dark' } {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    subs.add(f);
    const m = mq(); m.addEventListener('change', f);
    return () => { subs.delete(f); m.removeEventListener('change', f); };
  }, []);
  return { mode, resolved: resolved(mode) };
}
