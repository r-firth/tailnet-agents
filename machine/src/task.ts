import type { Browser } from "./browser.js";
import type { Config } from "./config.js";
import type { Terminal } from "./terminal.js";
import type { DemoSite } from "./demo-site.js";
import { AbortedError } from "./util.js";

export interface Answer {
  answer: string;
  label?: string;
  text?: string;
}

export interface TaskContext {
  memory?: Array<{ id?: number | string; kind?: string; text?: string; subject?: string } | string>;
  procedures?: Array<{ id?: number | string; text?: string; subject?: string; name?: string } | string>;
  [k: string]: unknown;
}

export interface TaskResult {
  outcome: "success" | "partial" | "failed";
  summary: string;
  receipt?: Buffer;
  skillName?: string;
  procedure?: string;
}

export class TaskRun {
  readonly abort = new AbortController();
  stepNo = 0;
  stepsEstimate: number | undefined;
  activeStep: { id: string; text: string } | null = null;
  result: TaskResult | null = null;
  procedures: { text: string; subject?: string }[] = [];
  tokens = 0;
  spentP = 0;
  lastScreenshot: Buffer | null = null;
  readonly startedAt = Date.now();

  constructor(
    readonly id: string,
    readonly brief: string,
    readonly executor: string,
    readonly context: TaskContext,
    readonly timeCapS: number,
  ) {}

  get signal() {
    return this.abort.signal;
  }

  cancel(reason: string) {
    if (!this.abort.signal.aborted) this.abort.abort(new AbortedError(reason));
  }
}

/** What executors and tools can use from agentd. */
export interface Host {
  cfg: Config;
  browser: Browser;
  terminal: Terminal;
  demo: DemoSite;
  bridge: { url: string; token: string };
  mcpScript: string;
  send(msg: { type: string; [k: string]: unknown }): void;
  event(task: TaskRun, ev: Record<string, unknown>): void;
  update(task: TaskRun, fields: Record<string, unknown>): void;
  /** Resolves when the user does not hold the control lock. */
  gate(task: TaskRun): Promise<void>;
  memory(task: TaskRun, op: "search" | "note" | "packet", fields: Record<string, unknown>): Promise<{ ok: boolean; result: any }>;
  ask(task: TaskRun, question: string, options: { id: string; label: string }[], allowText: boolean): Promise<Answer>;
  approval(task: TaskRun, amountP: number, merchant: string, description: string): Promise<Answer>;
  refreshInstalls(): void;
  /** Money actually spent (after a payment went through). */
  spend(task: TaskRun, amountP: number): void;
  pause(task: TaskRun, ms: number): Promise<void>;
}
