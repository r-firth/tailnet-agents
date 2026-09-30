import { randomBytes } from "node:crypto";

export const VERSION = "0.1.0";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AbortedError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "AbortedError";
  }
}

export function abortError(signal: AbortSignal): AbortedError {
  const r = signal.reason;
  return r instanceof AbortedError ? r : new AbortedError(typeof r === "string" ? r : "cancelled");
}

export function id(prefix = ""): string {
  return prefix + randomBytes(6).toString("hex");
}

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.FAMILIAR_LOG ?? "info"] ?? 20;

export function log(level: "debug" | "info" | "warn" | "error", ...args: unknown[]) {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const parts = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a)));
  process.stderr.write(`[agentd ${new Date().toISOString()} ${level}] ${parts.join(" ")}\n`);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\r/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export function oneLine(s: string, n = 160): string {
  return truncate(s.replace(/\s+/g, " ").trim(), n);
}

/** Wait for a promise or an abort signal, whichever comes first. */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "skill";
}
