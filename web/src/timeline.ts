import type { Actor, TaskEvent } from './types';
import { gbp } from './format';

export interface LogRow {
  key: string;
  ms: number;
  tool: string;
  target: string;
  result: string;
  dur: number | null;
  status: string;
  actor: Actor;
  pending: boolean;
}

/** Action log: tool events merged by call_id, plus the human/machine moments that belong in a log. */
export function logRows(evs: TaskEvent[]): LogRow[] {
  const rows: LogRow[] = [];
  const byCall = new Map<string, LogRow>();
  for (const e of evs) {
    if (e.kind === 'tool') {
      const k = e.call_id || `e${e.id}`;
      const ex = byCall.get(k);
      if (ex) {
        ex.result = e.result ?? ex.result;
        ex.dur = e.duration_ms ?? ex.dur;
        ex.status = e.status || ex.status;
        ex.pending = e.status === 'pending';
        if (e.target) ex.target = e.target;
        continue;
      }
      const r: LogRow = { key: k, ms: e.ms, tool: e.tool || 'tool', target: e.target || '', result: e.result ?? '', dur: e.duration_ms ?? null, status: e.status || 'ok', actor: e.actor, pending: e.status === 'pending' };
      byCall.set(k, r);
      rows.push(r);
      continue;
    }
    const base = { key: `e${e.id}`, ms: e.ms, dur: null, status: 'ok', pending: false };
    switch (e.kind) {
      case 'brief': rows.push({ ...base, tool: `${e.channel || 'web'}.recv`, target: `"${e.text || ''}"`, result: 'brief', actor: 'you' }); break;
      case 'ask': rows.push({ ...base, tool: 'ask.you', target: `"${e.question || ''}"`, result: 'waiting', actor: 'you' }); break;
      case 'approval': rows.push({ ...base, tool: 'approval', target: `${gbp(e.amount_p)} · ${e.merchant || ''}`, result: e.auto ? 'auto' : 'asked you', actor: e.auto ? 'agent' : 'you' }); break;
      case 'answer': rows.push({ ...base, tool: 'answer', target: e.label || e.answer || '', result: e.by === 'auto' ? 'auto' : 'you', actor: 'you' }); break;
      case 'control': rows.push({ ...base, tool: e.state === 'taken' ? 'control.take' : 'control.release', target: e.note || (e.state === 'taken' ? 'you have the machine' : 'agent resumes'), result: e.state === 'taken' ? 'paused' : 'ok', actor: 'you' }); break;
      case 'memory.write': rows.push({ ...base, tool: 'memory.write', target: e.text || '', result: e.op || 'add', actor: 'memory' }); break;
      case 'machine': rows.push({ ...base, tool: 'machine', target: e.text || '', result: '', actor: 'machine' }); break;
      case 'message': rows.push({ ...base, tool: 'message.send', target: `"${e.text || ''}"`, result: 'sent', actor: 'agent' }); break;
      case 'done': rows.push({ ...base, tool: 'finish', target: e.summary || '', result: e.outcome || 'done', actor: 'agent' }); break;
      case 'failed': rows.push({ ...base, tool: 'failed', target: e.error || '', result: 'error', status: 'error', actor: 'machine' }); break;
    }
  }
  return rows;
}

export type StepState = 'done' | 'active' | 'failed' | 'pending';
export interface StepRow { id: string; text: string; state: StepState; ms: number | null; doneMs: number | null; history: { ms: number; state: StepState; text: string }[] }

export function steps(evs: TaskEvent[]): StepRow[] {
  const map = new Map<string, StepRow>();
  const realOrder: string[] = [];
  const pendOrder: string[] = [];
  for (const e of evs) {
    if (e.kind !== 'step') continue;
    const id = e.step_id || `s${e.id}`;
    const st = (['done', 'active', 'failed', 'pending'].includes(e.state || '') ? e.state : 'active') as StepState;
    let r = map.get(id);
    if (!r) { r = { id, text: e.text || '', state: st, ms: null, doneMs: null, history: [] }; map.set(id, r); }
    r.history.push({ ms: e.ms, state: st, text: e.text || r.text });
    if (e.text) r.text = e.text;
    r.state = st;
    if (st !== 'pending' && r.ms == null) { r.ms = e.ms; realOrder.push(id); }
    if (st === 'done' || st === 'failed') r.doneMs = e.ms;
    if (st === 'pending' && !pendOrder.includes(id)) pendOrder.push(id);
  }
  const out = realOrder.map((id) => map.get(id)!);
  pendOrder.filter((id) => !realOrder.includes(id)).forEach((id) => out.push(map.get(id)!));
  return out;
}

/** Step state as of a replay cursor: 'after' when it had not started yet. */
export function stepAt(s: StepRow, ms: number): StepState | 'after' {
  let st: StepState | null = null;
  for (const h of s.history) if (h.ms <= ms) st = h.state;
  if (!st || st === 'pending') return s.ms == null ? 'pending' : 'after';
  return st;
}
export function stepTextAt(s: StepRow, ms: number | null): string {
  if (ms == null) return s.text;
  let t = s.history[0]?.text || s.text;
  for (const h of s.history) if (h.ms <= ms) t = h.text;
  return t;
}

export interface Moment {
  key: string;
  ms: number;
  kind: string;
  actor: Actor | 'term';
  label: string;
  detail?: string;
  artifact?: string;
  url?: string | null;
  ev: TaskEvent;
}

export function moments(evs: TaskEvent[]): Moment[] {
  const out: Moment[] = [];
  for (const e of evs) {
    const b = { key: `m${e.id}`, ms: e.ms, kind: e.kind, ev: e };
    switch (e.kind) {
      case 'brief': out.push({ ...b, actor: 'you', label: 'Brief', detail: e.text }); break;
      case 'memory.recall': out.push({ ...b, actor: 'memory', label: `Recalled ${e.hits?.length ?? 0}`, detail: e.query }); break;
      case 'machine': out.push({ ...b, actor: 'machine', label: 'Machine', detail: e.text }); break;
      case 'keyframe': out.push({ ...b, actor: 'browser', label: e.title || 'Keyframe', artifact: e.artifact, url: e.url }); break;
      case 'ask': out.push({ ...b, actor: 'you', label: 'Asked you', detail: e.question }); break;
      case 'approval': if (!e.auto) out.push({ ...b, actor: 'you', label: 'Approval', detail: `${gbp(e.amount_p)} to ${e.merchant}` }); break;
      case 'answer': out.push({ ...b, actor: 'you', label: e.by === 'auto' ? 'Auto-approved' : 'You answered', detail: e.label || e.answer }); break;
      case 'control': out.push({ ...b, actor: 'you', label: e.state === 'taken' ? 'You took control' : 'Handed back', detail: e.note }); break;
      case 'done': out.push({ ...b, actor: 'agent', label: 'Done', detail: e.summary, artifact: e.receipt_artifact || undefined }); break;
      case 'failed': out.push({ ...b, actor: 'machine', label: 'Failed', detail: e.error }); break;
    }
  }
  // runs without a browser (coding, shell work) get their finished steps and
  // failing commands as moments, so the strip still tells the story
  if (!evs.some((e) => e.kind === 'keyframe')) {
    for (const e of evs) {
      if (e.kind === 'step' && e.state === 'done') out.push({ key: `s${e.id}`, ms: e.ms, kind: 'step', actor: 'term', label: 'Step', detail: e.text, ev: e });
      else if (e.kind === 'tool' && e.status === 'error') out.push({ key: `x${e.id}`, ms: e.ms, kind: 'error', actor: 'machine', label: e.tool || 'Error', detail: `${e.target} → ${e.result}`, ev: e });
    }
  }
  out.sort((a, b) => a.ms - b.ms || a.ev.id - b.ev.id);
  // a done event that repeats the last keyframe's receipt adds nothing
  return out.filter((m, i) => !(m.kind === 'done' && m.artifact && out[i - 1]?.artifact === m.artifact));
}

export function urlAt(evs: TaskEvent[], ms: number | null): string | null {
  let u: string | null = null;
  for (const e of evs) {
    if (ms != null && e.ms > ms) break;
    if (e.kind === 'keyframe' && e.url) u = e.url;
    else if (e.kind === 'tool' && e.tool === 'browser.navigate' && e.target && /^[a-z]+:\/\//.test(e.target)) u = e.target;
  }
  return u;
}

export function lastOf(evs: TaskEvent[], kind: string, ms: number | null = null): TaskEvent | undefined {
  for (let i = evs.length - 1; i >= 0; i--) { const e = evs[i]; if (e.kind === kind && (ms == null || e.ms <= ms)) return e; }
  return undefined;
}

export function usesBrowser(evs: TaskEvent[]): boolean {
  return evs.some((e) => e.kind === 'keyframe' || (e.kind === 'tool' && (e.tool || '').startsWith('browser.')));
}
export function usesTerminal(evs: TaskEvent[]): boolean {
  return evs.some((e) => e.kind === 'tool' && (e.tool === 'shell' || (e.tool || '').startsWith('git') || (e.tool || '').startsWith('gh.')));
}
