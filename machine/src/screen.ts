import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./util.js";

type FrameSink = (data: string, w: number, h: number) => void;

/**
 * The machine's whole screen (an X display): what the live view, replays and receipts show.
 * Agents work on it with their own tools; Familiar only watches it (ffmpeg x11grab) and relays
 * take-control input (xdotool). It also keeps one Chrome open, maximised, on the persistent
 * profile so logins survive between runs. No Playwright, no CDP.
 */
export class Screen {
  onFrame: FrameSink | null = null;
  private ffmpeg: ChildProcess | null = null;
  private chrome: ChildProcess | null = null;
  private last: Buffer | null = null;
  private fps = 1;
  private stopped = false;
  readonly width: number;
  readonly height: number;

  constructor(
    private display: string,
    private profileDir: string,
  ) {
    const [w, h] = (process.env.FAMILIAR_SCREEN ?? "1440x960").split("x").map(Number);
    this.width = w || 1440;
    this.height = h || 960;
  }

  async start() {
    this.startChrome();
    this.capture();
  }

  /** One Chrome on the persistent profile, maximised; restarted if it's closed. */
  private startChrome() {
    if (this.stopped || process.env.FAMILIAR_NO_CHROME) return;
    const bin = process.env.CHROME_PATH || "chromium";
    fs.mkdirSync(this.profileDir, { recursive: true });
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) fs.rmSync(path.join(this.profileDir, lock), { force: true });
    this.chrome = spawn(bin, [`--user-data-dir=${this.profileDir}`, "--start-maximized", "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--disable-dev-shm-usage", "about:blank"], {
      env: { ...process.env, DISPLAY: this.display },
      stdio: "ignore",
    });
    log("info", `chrome on ${this.display}: ${bin}`);
    this.chrome.on("exit", (code) => {
      this.chrome = null;
      if (this.stopped) return;
      log("info", `chrome exited (${code}); reopening in 5s`);
      setTimeout(() => this.startChrome(), 5000);
    });
  }

  /** Stream the display as JPEG frames. */
  private capture() {
    if (this.stopped) return;
    const args = ["-loglevel", "error", "-f", "x11grab", "-draw_mouse", "1", "-framerate", String(this.fps), "-video_size", `${this.width}x${this.height}`, "-i", this.display, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "7", "-"];
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.ffmpeg = ff;
    let buf = Buffer.alloc(0);
    ff.stdout!.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) {
          buf = Buffer.alloc(0);
          return;
        }
        const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end < 0) {
          buf = buf.subarray(start);
          return;
        }
        const frame = buf.subarray(start, end + 2);
        buf = buf.subarray(end + 2);
        this.last = Buffer.from(frame);
        this.onFrame?.(this.last.toString("base64"), this.width, this.height);
      }
    });
    ff.stderr!.on("data", (d) => log("debug", `ffmpeg: ${String(d).trim()}`));
    ff.on("exit", () => {
      if (this.ffmpeg === ff) this.ffmpeg = null;
      if (!this.stopped && !ff.killed) setTimeout(() => this.capture(), 2000);
    });
  }

  /** "full" while someone is watching closely or driving, "tile" otherwise. */
  setRate(rate: "full" | "tile") {
    const fps = rate === "full" ? 4 : 1;
    if (fps === this.fps) return;
    this.fps = fps;
    const ff = this.ffmpeg;
    this.ffmpeg = null;
    if (ff) {
      ff.kill("SIGKILL");
      this.capture();
    }
  }

  /** The current screen, for receipts and replay keyframes. */
  async screenshot(): Promise<{ jpeg: Buffer; url: string; title: string }> {
    const title = await this.activeWindowTitle();
    if (this.last) return { jpeg: this.last, url: "", title };
    const jpeg = await new Promise<Buffer>((resolve, reject) =>
      execFile("ffmpeg", ["-loglevel", "error", "-f", "x11grab", "-video_size", `${this.width}x${this.height}`, "-i", this.display, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
    );
    return { jpeg, url: "", title };
  }

  private activeWindowTitle(): Promise<string> {
    return new Promise((resolve) =>
      execFile("xdotool", ["getactivewindow", "getwindowname"], { env: { ...process.env, DISPLAY: this.display }, timeout: 2000 }, (err, out) => resolve(err ? "" : String(out).trim())),
    );
  }

  /** Take-control input from the live view: x,y are screen pixels. */
  async input(inp: any) {
    const env = { ...process.env, DISPLAY: this.display };
    const run = (args: string[]) => new Promise<void>((resolve) => execFile("xdotool", args, { env, timeout: 5000 }, () => resolve()));
    if (inp.kind === "key") {
      if (inp.action === "type" && inp.text) await run(["type", "--delay", "8", String(inp.text)]);
      else if (inp.key) await run(["key", xKey(String(inp.key))]);
      return;
    }
    if (inp.kind === "mouse") {
      const x = String(Math.round(Number(inp.x))), y = String(Math.round(Number(inp.y)));
      const button = inp.button === "right" ? "3" : inp.button === "middle" ? "2" : "1";
      switch (inp.action) {
        case "move": return run(["mousemove", x, y]);
        case "down": return run(["mousemove", x, y, "mousedown", button]);
        case "up": return run(["mousemove", x, y, "mouseup", button]);
        case "click": return run(["mousemove", x, y, "click", button]);
        case "wheel": return run(["mousemove", x, y, "click", Number(inp.dy) > 0 ? "5" : "4"]);
      }
    }
  }

  async close() {
    this.stopped = true;
    this.ffmpeg?.kill("SIGKILL");
    this.chrome?.kill("SIGTERM");
  }
}

/** Browser key names (from the live view) to X keysyms. */
function xKey(key: string): string {
  const map: Record<string, string> = { Enter: "Return", Backspace: "BackSpace", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Escape", " ": "space", PageUp: "Prior", PageDown: "Next" };
  return key.split("+").map((k) => map[k] ?? (k === "Control" ? "ctrl" : k === "Meta" ? "super" : k)).join("+");
}
