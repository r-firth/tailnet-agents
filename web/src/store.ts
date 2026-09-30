import { useSyncExternalStore } from 'react';
import { api, ApiError, streamUrl } from './api';
import { pushFrame, pushTerminal, onFirstFrame, hasFrames } from './bus';
import type { FullState, InputMsg, Machine, Message, NeedsYou, ServerMsg, Settings, Stats, Task, TaskEvent } from './types';

export type Overlay = null | 'memory' | 'machines' | 'settings' | 'newtask' | 'kill';

export interface Hist { cpu: number[]; mem: number[]; net: number[] }

export interface AppState {
  conn: 'connecting' | 'online' | 'offline';
  loaded: boolean;
  authError: boolean;
  tasks: Record<string, Task>;
  machines: Record<string, Machine>;
  needs: NeedsYou[];
  messages: Message[];
  typing: boolean;
  stats: Stats;
  settings: Settings;
  events: Record<string, TaskEvent[]>;
  focusId: string | null;
  focusPinned: boolean;
  seek: { taskId: string; ms: number; nonce: number } | null;
  hist: Record<string, Hist>;
  tokenHist: Record<string, number[]>;
  unread: number;
  overlay: Overlay;
  chatOpen: boolean;
  paletteOpen: boolean;
  memoryClaim: number | null;
  toast: { text: string; id: number } | null;
  answered: Record<string, string>; // question_id -> label, optimistic
  framedTick: number;
}

const emptyStats: Stats = { spend_today_p: 0, tokens_today: 0, memory_nodes: 0, runs_today: 0, runs_done_today: 0, working: 0, waiting: 0 };
const emptySettings: Settings = { approval_threshold_p: 10000, default_executor: 'claude', no_ask_merchants: [] };

let state: AppState = {
  conn: 'connecting', loaded: false, authError: false, tasks: {}, machines: {}, needs: [], messages: [], typing: false,
  stats: emptyStats, settings: emptySettings, events: {}, focusId: null, focusPinned: false, seek: null, hist: {}, tokenHist: {},
  unread: 0, overlay: null, chatOpen: false, paletteOpen: false, memoryClaim: null, toast: null, answered: {}, framedTick: 0,
};

const listeners = new Set<() => void>();
let scheduled = false;
function emit() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; listeners.forEach((l) => l()); });
}
export function getState(): AppState { return state; }
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  emit();
}
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function useStore(): AppState { return useSyncExternalStore(subscribe, getState, getState); }

// ------------------------------------------------------------------ derived
export const ACTIVE: Task['status'][] = ['queued', 'starting', 'running', 'waiting'];
export const isActive = (t: Task) => ACTIVE.includes(t.status);

export function activeTasks(s: AppState): Task[] {
  return Object.values(s.tasks).filter(isActive).sort((a, b) => a.num - b.num);
}
export function finishedTasks(s: AppState): Task[] {
  return Object.values(s.tasks).filter((t) => !isActive(t)).sort((a, b) => (b.ended_at || b.created_at).localeCompare(a.ended_at || a.created_at));
}

function pickFocus(s: AppState): string | null {
  const act = activeTasks(s);
  const score = (t: Task) => (t.status === 'running' ? 4 : t.status === 'starting' ? 3 : t.status === 'queued' ? 2 : 1) + (hasFrames(t.id) ? 2 : 0) + (t.control ? 10 : 0);
  if (act.length) return [...act].sort((a, b) => score(b) - score(a) || b.num - a.num)[0].id;
  return finishedTasks(s)[0]?.id ?? null;
}

// ------------------------------------------------------------------ events
const seen = new Map<string, Set<number>>();
function addEvents(taskId: string, evs: TaskEvent[], replace = false) {
  let set = seen.get(taskId);
  if (!set || replace) { set = new Set(); seen.set(taskId, set); }
  const cur = replace ? [] : state.events[taskId] || [];
  const add = evs.filter((e) => !set!.has(e.id));
  if (!add.length && !replace) return;
  add.forEach((e) => set!.add(e.id));
  let next = cur.concat(add);
  if (add.some((e, i) => (i === 0 ? cur.length && e.id < cur[cur.length - 1].id : e.id < add[i - 1].id))) next = next.sort((a, b) => a.id - b.id);
  if (next.length > 4000) next = next.slice(-4000);
  state = { ...state, events: { ...state.events, [taskId]: next } };
}

const loading = new Set<string>();
export async function loadTask(taskId: string): Promise<void> {
  if (loading.has(taskId)) return;
  loading.add(taskId);
  try {
    const r = await api.get<{ task: Task; events: TaskEvent[] }>(`/tasks/${encodeURIComponent(taskId)}`);
    const merged = [...(r.events || []), ...(state.events[taskId] || [])];
    const byId = new Map(merged.map((e) => [e.id, e]));
    seen.delete(taskId);
    addEvents(taskId, [...byId.values()].sort((a, b) => a.id - b.id), true);
    setState((s) => ({ tasks: { ...s.tasks, [taskId]: r.task } }));
  } catch (e) {
    handleErr(e);
  } finally { loading.delete(taskId); }
}

// ------------------------------------------------------------------ apply server state
function pushHist(h: Hist | undefined, m: Machine): Hist {
  const cap = 90;
  const base = h || { cpu: [], mem: [], net: [] };
  const add = (a: number[], v: number) => { const n = a.concat(v); return n.length > cap ? n.slice(-cap) : n; };
  return { cpu: add(base.cpu, m.stats?.cpu_pct ?? 0), mem: add(base.mem, m.stats?.mem_gb ?? 0), net: add(base.net, m.stats?.net_mbs ?? 0) };
}

function applyFull(fs: FullState) {
  const tasks: Record<string, Task> = {};
  (fs.tasks || []).forEach((t) => (tasks[t.id] = t));
  const machines: Record<string, Machine> = {};
  const hist = { ...state.hist };
  (fs.machines || []).forEach((m) => { machines[m.id] = m; hist[m.id] = pushHist(hist[m.id], m); });
  const next: Partial<AppState> = {
    loaded: true, authError: false, tasks, machines, hist,
    needs: fs.needs_you || [], messages: (fs.messages || []).slice().sort((a, b) => a.at.localeCompare(b.at)),
    stats: fs.stats || emptyStats, settings: { ...emptySettings, ...(fs.settings || {}) },
  };
  state = { ...state, ...next };
  ensureFocus();
  emit();
}

function ensureFocus() {
  const f = state.focusId;
  const t = f ? state.tasks[f] : null;
  if (!t || (!state.focusPinned && !isActive(t) && activeTasks(state).length)) {
    const id = pickFocus(state);
    if (id !== f) focus(id, false);
  }
}

export function focus(id: string | null, pinned = true): void {
  if (id === state.focusId) { if (pinned && !state.focusPinned) setState({ focusPinned: true }); return; }
  state = { ...state, focusId: id, focusPinned: pinned && !!id };
  emit();
  sendSubscribe();
  if (id) loadTask(id);
}

function handle(msg: ServerMsg) {
  switch (msg.type) {
    case 'hello': applyFull(msg.state); if (state.focusId) loadTask(state.focusId); break;
    case 'task': {
      const prev = state.tasks[msg.task.id];
      const th = state.tokenHist[msg.task.id] || [];
      const tokenHist = prev && prev.tokens !== msg.task.tokens ? { ...state.tokenHist, [msg.task.id]: th.concat(msg.task.tokens).slice(-60) } : state.tokenHist;
      state = { ...state, tasks: { ...state.tasks, [msg.task.id]: msg.task }, tokenHist };
      if (!prev || (prev && isActive(prev) && !isActive(msg.task))) ensureFocus();
      else if (!state.focusPinned && prev.status !== 'running' && msg.task.status === 'running') {
        // an unpinned desk follows the action: prefer a running run over one that is waiting
        const cur = state.focusId ? state.tasks[state.focusId] : null;
        if (!cur || cur.status !== 'running') { const id = msg.task.id; queueMicrotask(() => focus(id, false)); }
      }
      emit();
      break;
    }
    case 'event': addEvents(msg.event.task_id, [msg.event]); emit(); break;
    case 'machine': state = { ...state, machines: { ...state.machines, [msg.machine.id]: msg.machine }, hist: { ...state.hist, [msg.machine.id]: pushHist(state.hist[msg.machine.id], msg.machine) } }; emit(); break;
    case 'needs_you': {
      const ids = new Set(msg.items.map((n) => n.id));
      const answered = Object.fromEntries(Object.entries(state.answered).filter(([k]) => ids.has(k)));
      setState({ needs: msg.items, answered });
      break;
    }
    case 'message': {
      if (state.messages.some((m) => m.id === msg.message.id)) break;
      const unread = !state.chatOpen && msg.message.role === 'assistant' ? state.unread + 1 : state.unread;
      setState({ messages: state.messages.concat(msg.message).slice(-400), unread });
      if (msg.message.role === 'assistant' && msg.message.task_id && pendingFocusFromChat && msg.message.channel === 'web') {
        pendingFocusFromChat = false;
        const tid = msg.message.task_id;
        setTimeout(() => { if (state.tasks[tid]) focus(tid, true); }, 50);
      }
      break;
    }
    case 'typing': setState({ typing: !!msg.on }); break;
    case 'frame': pushFrame(msg.task_id, msg.data, msg.w, msg.h); break;
    case 'terminal': pushTerminal(msg.task_id, msg.data); break;
    case 'stats': setState({ stats: msg.stats }); break;
  }
}

onFirstFrame(() => {
  setState((s) => ({ framedTick: s.framedTick + 1 }));
  if (!state.focusPinned) {
    const cur = state.focusId ? state.tasks[state.focusId] : null;
    if (cur && !hasFrames(cur.id) && isActive(cur)) ensureFocusForce();
  }
});
function ensureFocusForce() { const id = pickFocus(state); if (id && id !== state.focusId) focus(id, false); }

// ------------------------------------------------------------------ websocket
let ws: WebSocket | null = null;
let backoff = 500;
let retryTimer: number | undefined;

function sendSubscribe() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', task_id: state.focusId }));
}
export function sendInput(taskId: string, input: InputMsg): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', task_id: taskId, input }));
}

function connect() {
  clearTimeout(retryTimer);
  setState({ conn: state.loaded ? (state.conn === 'online' ? 'connecting' : state.conn) : 'connecting' });
  let sock: WebSocket;
  try { sock = new WebSocket(streamUrl()); } catch { scheduleRetry(); return; }
  ws = sock;
  sock.onopen = () => { backoff = 500; setState({ conn: 'online' }); sendSubscribe(); };
  sock.onmessage = (ev) => { try { handle(JSON.parse(ev.data)); } catch (e) { console.warn('bad message', e); } };
  sock.onclose = () => { if (ws === sock) { ws = null; setState({ conn: 'offline', typing: false }); scheduleRetry(); } };
  sock.onerror = () => { try { sock.close(); } catch { /* ignore */ } };
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  const wait = backoff + Math.random() * 300;
  backoff = Math.min(backoff * 1.8, 12000);
  retryTimer = window.setTimeout(async () => {
    // a cheap probe tells auth errors apart from the server being down
    try { await api.get('/state'); } catch (e) { if (e instanceof ApiError && e.status === 401) { setState({ authError: true, conn: 'offline' }); } }
    connect();
  }, wait);
}

function handleErr(e: unknown) {
  if (e instanceof ApiError && e.status === 401) setState({ authError: true });
}

export async function start(): Promise<void> {
  try { applyFull(await api.get<FullState>('/state')); setState({ conn: 'connecting' }); }
  catch (e) { handleErr(e); }
  connect();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !ws) { backoff = 500; connect(); } });
  window.addEventListener('online', () => { if (!ws) { backoff = 500; connect(); } });
}

// ------------------------------------------------------------------ actions
let toastId = 0;
export function toast(text: string): void {
  const id = ++toastId;
  setState({ toast: { text, id } });
  setTimeout(() => { if (state.toast?.id === id) setState({ toast: null }); }, 2600);
}

async function act<T>(p: Promise<T>, ok?: string): Promise<T | undefined> {
  try { const r = await p; if (ok) toast(ok); return r; }
  catch (e) { handleErr(e); toast(`Failed: ${(e as Error).message}`); return undefined; }
}

export async function answer(n: NeedsYou, optionId: string, label: string, text?: string) {
  setState((s) => ({ answered: { ...s.answered, [n.id]: label } }));
  const r = await act(api.post('/answer', { question_id: n.id, answer: optionId, ...(text ? { text } : {}) }));
  if (r === undefined) setState((s) => { const a = { ...s.answered }; delete a[n.id]; return { answered: a }; });
  else toast(`${n.kind === 'approval' ? label : 'Answered'} · run ${n.task_num}`);
}

let pendingFocusFromChat = false;
export async function sendMessage(text: string, executor?: string) {
  pendingFocusFromChat = true;
  const r = await act(api.post<{ message: Message }>('/messages', { text, ...(executor ? { executor } : {}) }));
  if (r?.message && !state.messages.some((m) => m.id === r.message.id)) setState((s) => ({ messages: s.messages.concat(r.message) }));
  return !!r;
}

export async function newTask(brief: string, executor?: string) {
  const r = await act(api.post<{ task: Task }>('/tasks', { brief, ...(executor ? { executor } : {}) }));
  if (r?.task) { setState((s) => ({ tasks: { ...s.tasks, [r.task.id]: r.task } })); focus(r.task.id, true); toast(`Started run ${r.task.num}`); }
}

export async function setControl(t: Task, take: boolean) {
  const r = await act(api.post<{ task: Task }>(`/tasks/${t.id}/control`, { action: take ? 'take' : 'release' }));
  if (r?.task) { setState((s) => ({ tasks: { ...s.tasks, [r.task.id]: r.task } })); toast(take ? `You're driving ${machineName(t.machine_id)}. ${execName(t.executor)} paused.` : `Handed back. ${execName(t.executor)} resumes.`); }
}

export async function cancelTask(t: Task) {
  const r = await act(api.post<{ task: Task }>(`/tasks/${t.id}/cancel`), `Cancelled run ${t.num}`);
  if (r?.task) setState((s) => ({ tasks: { ...s.tasks, [r.task.id]: r.task } }));
}

export async function kill() {
  const r = await act(api.post<{ cancelled: number; machines_stopped: number }>('/kill'));
  if (r) toast(`Kill switch: ${r.cancelled} runs cancelled, ${r.machines_stopped} machines stopped`);
}

export async function saveSettings(p: Partial<Settings>) {
  const r = await act(api.put<Settings>('/settings', p), 'Settings saved');
  if (r) setState((s) => ({ settings: { ...s.settings, ...r } }));
}

export async function machineAction(m: Machine, action: 'backup' | 'stop' | 'fork' | 'start') {
  let r: { machine: Machine } | undefined;
  if (action === 'backup') r = await act(api.post(`/machines/${m.id}/backup`), `Backing up ${m.name}`);
  else if (action === 'stop') r = await act(api.post(`/machines/${m.id}/stop`), `Stopped ${m.name}`);
  else if (action === 'fork') r = await act(api.post('/machines', { fork_of: m.id }), `Forked ${m.name}`);
  else r = await act(api.post('/machines', { backend: m.backend, id: m.id }), `Starting ${m.name}`);
  if (r?.machine) setState((s) => ({ machines: { ...s.machines, [r!.machine.id]: r!.machine } }));
}
export async function startMachine(backend: string) {
  const r = await act(api.post<{ machine: Machine }>('/machines', { backend }), `Starting a ${backend} machine`);
  if (r?.machine) setState((s) => ({ machines: { ...s.machines, [r.machine.id]: r.machine } }));
}

export function seekTo(taskId: string, ms: number) {
  focus(taskId, true);
  setState({ seek: { taskId, ms, nonce: Date.now() } });
}

export function openChat(open = true) { setState({ chatOpen: open, unread: open ? 0 : state.unread, paletteOpen: false }); }
export function openOverlay(o: Overlay, extra: Partial<AppState> = {}) { setState({ overlay: o, paletteOpen: false, ...extra }); }

// ------------------------------------------------------------------ small helpers used across components
export function machineName(id: string | null | undefined): string {
  if (!id) return 'no machine';
  return state.machines[id]?.name || id.replace(/^m_/, '');
}
export function execName(e: string | null | undefined): string {
  return e === 'codex' ? 'Codex' : e === 'scripted' ? 'Scripted' : e === 'claude' ? 'Claude Code' : e ? e : 'Auto';
}
