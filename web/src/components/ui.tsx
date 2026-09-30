import { useEffect, useState, type ReactNode } from 'react';
import type { NeedsYou, Task } from '../types';

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

export type PillKind = 'live' | 'running' | 'wait' | 'approval' | 'driving' | 'held' | 'ok' | 'partial' | 'bad' | 'queued' | 'replay';

export function runState(t: Task, needs: NeedsYou[], focused = false): { cls: PillKind; label: string; short: string } {
  if (t.control === 'you' && (t.status === 'running' || t.status === 'waiting' || t.status === 'starting')) return { cls: 'driving', label: "You're driving", short: 'Driving' };
  switch (t.status) {
    case 'waiting': {
      const n = needs.find((x) => x.task_id === t.id);
      if (n?.kind === 'approval') return n.title.startsWith('Held') ? { cls: 'held', label: 'Held by you', short: 'Held' } : { cls: 'approval', label: 'Needs approval', short: 'Approval' };
      if (n) return { cls: 'wait', label: 'Waiting on you', short: 'Asked you' };
      return { cls: 'wait', label: 'Waiting', short: 'Waiting' };
    }
    case 'running': return focused ? { cls: 'live', label: 'Live', short: 'Live' } : { cls: 'running', label: 'Running', short: 'Running' };
    case 'starting': return { cls: 'queued', label: 'Starting', short: 'Starting' };
    case 'queued': return { cls: 'queued', label: 'Queued', short: 'Queued' };
    case 'done': return t.outcome === 'partial' ? { cls: 'partial', label: 'Partly done', short: 'Partial' } : t.outcome === 'failed' ? { cls: 'bad', label: 'Failed', short: 'Failed' } : { cls: 'ok', label: 'Done', short: 'Done' };
    case 'failed': return { cls: 'bad', label: 'Failed', short: 'Failed' };
    case 'cancelled': return { cls: 'held', label: 'Cancelled', short: 'Cancelled' };
  }
  return { cls: 'queued', label: t.status, short: t.status };
}

export function Pill({ kind, children }: { kind: PillKind; children: ReactNode }) {
  return <span className={`pill ${kind}`}><span className="dot" />{children}</span>;
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;
export const Rid = ({ n }: { n: number | string }) => <span className="rid">{n}</span>;

export function Spark({ data, w = 80, h = 14, color = 'var(--muted)', max }: { data: number[]; w?: number; h?: number; color?: string; max?: number }) {
  const n = data.length;
  if (n < 2) return <svg width={w} height={h} aria-hidden="true" className="spark" />;
  const hi = max ?? Math.max(1e-6, ...data);
  const pts = data.map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(h - 1 - (Math.min(v, hi) / hi) * (h - 2)).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Bar({ pct, color }: { pct: number; color?: string }) {
  return <span className="bar"><span style={{ width: `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`, ...(color ? { background: color } : {}) }} /></span>;
}

export const actorClass = (a: string) => (a === 'browser' || a === 'agent' ? 'browser' : a);
