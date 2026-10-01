// Shapes from docs/protocol.md. Fields the UI does not strictly need are
// optional so a slightly different server still renders.

export type TaskStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type Executor = 'claude' | 'codex' | 'scripted';
export type Actor = 'you' | 'memory' | 'machine' | 'agent' | 'browser';

export interface Task {
  id: string;
  num: number;
  title: string;
  brief: string;
  status: TaskStatus;
  executor: Executor | string;
  machine_id: string | null;
  source: 'telegram' | 'web' | 'schedule' | string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  now: string | null;
  waiting_for?: string | null;
  step: number;
  steps_estimate: number | null;
  spend_p: number;
  tokens: number;
  time_cap_s: number | null;
  control: 'you' | null;
  outcome: 'success' | 'partial' | 'failed' | null;
  summary: string | null;
  receipt_artifact: string | null;
  last_frame_artifact: string | null;
}

export interface MemoryHit { id: number; score: number; text: string; kind?: string; source?: string }

export interface TaskEvent {
  id: number;
  task_id: string;
  at: string;
  ms: number;
  actor: Actor;
  kind: string;
  // kind-specific
  text?: string;
  channel?: string;
  state?: string;
  step_id?: string;
  tool?: string;
  target?: string;
  result?: string | null;
  duration_ms?: number | null;
  status?: 'ok' | 'error' | 'pending' | string;
  call_id?: string;
  artifact?: string;
  url?: string | null;
  title?: string;
  query?: string;
  hits?: MemoryHit[];
  op?: 'add' | 'supersede' | 'forget' | string;
  claim_kind?: string;
  claim_id?: number;
  question_id?: string;
  question?: string;
  options?: { id: string; label: string }[];
  amount_p?: number;
  merchant?: string;
  description?: string;
  auto?: boolean;
  answer?: string;
  label?: string;
  by?: string;
  note?: string;
  outcome?: string;
  summary?: string;
  receipt_artifact?: string | null;
  error?: string;
  action?: string;      // keyframe: what just happened ("Clicked “Billing”")
  steps?: string[];     // plan: the steps expected after step `after`
  after?: number;
}

export interface NeedsOption { id: string; label: string; style?: 'primary' | 'quiet' | string }
export interface NeedsYou {
  id: string;
  task_id: string;
  task_num: number;
  task_title: string;
  kind: 'approval' | 'question';
  title: string;
  detail?: string;
  options: NeedsOption[];
  allow_text?: boolean;
  created_at: string;
}

export interface MachineStats { cpu_pct: number; mem_gb: number; net_mbs: number; uptime_s: number }
export interface Machine {
  id: string;
  name: string;
  backend: 'local' | 'docker' | 'cloudflare' | 'ssh' | string;
  status: 'online' | 'busy' | 'offline' | 'sleeping' | string;
  parent: string | null;
  specs: { cpu: number; mem_gb: number; disk_gb: number };
  stats: MachineStats;
  task_id: string | null;
  has_desktop: boolean;
  desktop_url: string | null;
  last_backup_at: string | null;
  installs: string[];
}

export interface Activity { kind: 'search' | 'fetch' | 'run' | 'start' | 'memory' | string; label: string; detail: string }
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  channel: 'telegram' | 'web' | string;
  task_id: string | null;
  at: string;
  activity?: Activity[];
}

export type ClaimKind = 'fact' | 'preference' | 'rule' | 'procedure' | 'account' | 'subscription' | 'person' | 'episode';
export interface Claim {
  id: number;
  kind: ClaimKind | string;
  text: string;
  subject: string | null;
  confidence: number;
  salience: number;
  state: 'active' | 'superseded' | 'disputed' | 'forgotten' | string;
  source: { task_id?: string; message_id?: string; label?: string } | null;
  created_at: string;
  superseded_by: number | null;
}

export interface Stats {
  spend_today_p: number;
  tokens_today: number;
  memory_nodes: number;
  runs_today: number;
  runs_done_today: number;
  working: number;
  waiting: number;
}

export interface Settings {
  approval_threshold_p: number;
  default_executor: Executor | string;
  no_ask_merchants: string[];
  coordinator?: string;
  embedder?: string;
  telegram?: string;
  backends?: string[];
}

export interface Device { name: string; host: string; dns: string; os: string; online: boolean; ssh: boolean }
export interface FullState {
  devices?: Device[];
  tasks: Task[];
  machines: Machine[];
  needs_you: NeedsYou[];
  messages: Message[];
  stats: Stats;
  settings: Settings;
}

export interface SearchResult {
  type: 'task' | 'event' | 'claim' | 'message' | 'keyframe';
  id: string;
  task_id?: string;
  text: string;
  score: number;
  at: string;
  artifact?: string;
}

export interface ReplayFrame { ms: number; artifact: string }

export type ServerMsg =
  | { type: 'hello'; state: FullState }
  | { type: 'task'; task: Task }
  | { type: 'event'; event: TaskEvent }
  | { type: 'machine'; machine: Machine }
  | { type: 'machine.removed'; id: string }
  | { type: 'needs_you'; items: NeedsYou[] }
  | { type: 'message'; message: Message }
  | { type: 'typing'; on: boolean }
  | { type: 'draft'; turn: string; delta?: string; reset?: boolean; done?: boolean }
  | { type: 'activity'; turn: string; item: Activity }
  | { type: 'devices'; devices: Device[] }
  | { type: 'frame'; task_id: string; machine_id?: string; data: string; w: number; h: number }
  | { type: 'terminal'; task_id: string; data: string }
  | { type: 'stats'; stats: Stats };

export type InputMsg =
  | { kind: 'mouse'; action: 'move' | 'down' | 'up' | 'click' | 'wheel'; x: number; y: number; button?: 'left' | 'right' | 'middle'; dx?: number; dy?: number }
  | { kind: 'key'; action: 'press' | 'type'; key?: string; text?: string }
  | { kind: 'terminal'; data: string }
  | { kind: 'navigate'; url: string };
