import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { abortError, log, raceAbort } from "./util.js";

export const VIEWPORT = { width: 1280, height: 800 };

export function findChrome(): string | undefined {
  const candidates: (string | undefined)[] = [process.env.CHROME_PATH];
  try {
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync("/opt/pw-browsers")) process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
    candidates.push(chromium.executablePath());
  } catch {
    /* no bundled revision */
  }
  candidates.push("/opt/pw-browsers/chromium");
  if (fs.existsSync("/opt/pw-browsers")) {
    for (const d of fs.readdirSync("/opt/pw-browsers").filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      candidates.push(path.join("/opt/pw-browsers", d, "chrome-linux", "chrome"));
    }
  }
  // macOS installs.
  candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      candidates.push(execFileSync("which", [name], { encoding: "utf8" }).trim() || undefined);
    } catch {
      /* not on PATH */
    }
  }
  return candidates.find((c) => !!c && fs.existsSync(c));
}

/** Reads width/height from a JPEG's SOF marker. */
export function jpegSize(buf: Buffer): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

export type FrameSink = (data: string, w: number, h: number) => void;

/** In-page accessibility-ish snapshot: interactive elements get stable refs (data-fam-ref) usable by click/type. */
const SNAPSHOT_FN = `(() => {
  const MAX = 350; let n = 0; const out = [];
  document.querySelectorAll('[data-fam-ref]').forEach(e => e.removeAttribute('data-fam-ref'));
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = el => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const roleOf = el => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (['submit','button','reset','image'].includes(ty)) return 'button'; if (ty === 'checkbox') return 'checkbox'; if (ty === 'radio') return 'radio'; if (ty === 'hidden') return null; return 'textbox'; }
    if (t === 'textarea') return 'textbox'; if (t === 'select') return 'combobox';
    if (/^h[1-6]$/.test(t)) return 'heading'; if (t === 'img') return 'img';
    return null; };
  const INTERACTIVE = new Set(['link','button','textbox','checkbox','radio','combobox','tab','menuitem','switch','option','searchbox']);
  const nameOf = el => { const l = el.getAttribute('aria-label'); if (l) return clean(l);
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    if (el.tagName === 'INPUT' && ['submit','button'].includes(el.type)) return clean(el.value);
    return clean(el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.value || ''); };
  const walk = (el, depth) => {
    if (n >= MAX) return;
    for (const c of el.childNodes) {
      if (n >= MAX) return;
      if (c.nodeType === 3) { const t = clean(c.textContent); if (t.length > 1 && el.children.length > 0) { out.push('  '.repeat(depth) + '- text: ' + t.slice(0, 160)); n++; } continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toLowerCase();
      if (['script','style','noscript','template','svg','head'].includes(tag)) continue;
      if (!visible(c)) continue;
      const role = roleOf(c);
      if (role && INTERACTIVE.has(role)) {
        const ref = 'e' + (++n); c.setAttribute('data-fam-ref', ref);
        let line = '  '.repeat(depth) + '- ' + role + ' "' + nameOf(c).slice(0, 80) + '" [ref=' + ref + ']';
        if (role === 'textbox' || role === 'combobox') { const v = c.value; if (v) line += ' value="' + String(v).slice(0, 60) + '"'; }
        if (role === 'checkbox' || role === 'radio') line += c.checked ? ' [checked]' : '';
        if (c.disabled) line += ' [disabled]';
        out.push(line); continue;
      }
      if (role === 'heading') { out.push('  '.repeat(depth) + '- heading "' + clean(c.innerText).slice(0, 120) + '" [level=' + c.tagName[1] + ']'); n++; continue; }
      if (role === 'img') { const a = clean(c.getAttribute('alt')); if (a) { out.push('  '.repeat(depth) + '- img "' + a.slice(0, 80) + '"'); n++; } continue; }
      const leaf = c.children.length === 0;
      if (leaf) { const t = clean(c.innerText); if (t) { out.push('  '.repeat(depth) + '- text: ' + t.slice(0, 200)); n++; } continue; }
      const landmark = ['nav','main','header','footer','form','aside','section','table','dialog'].includes(tag) || c.getAttribute('role') === 'dialog';
      if (landmark) { out.push('  '.repeat(depth) + '- ' + (c.getAttribute('role') || tag) + ':'); walk(c, depth + 1); }
      else walk(c, depth);
    }
  };
  walk(document.body, 0);
  if (n >= MAX) out.push('- … (truncated)');
  return out.join('\\n');
})()`;

export class Browser {
  context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private lastFrameAt = 0;
  private frameScale = 1;
  rate: "full" | "tile" = "tile";
  headless = true;
  onFrame: FrameSink | null = null;
  private starting: Promise<void> | null = null;

  constructor(private profileDir: string) {}

  start(): Promise<void> {
    if (!this.starting) this.starting = this.launch().catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  private async launch() {
    fs.mkdirSync(this.profileDir, { recursive: true });
    // A crashed Chrome leaves singleton locks that block the next launch.
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        fs.rmSync(path.join(this.profileDir, f), { force: true });
      } catch {
        /* ignore */
      }
    }
    const executablePath = findChrome();
    if (!executablePath) throw new Error("No Chrome/Chromium found (set CHROME_PATH)");
    this.headless = !process.env.DISPLAY;
    log("info", `launching chromium ${this.headless ? "headless" : "headful on " + process.env.DISPLAY}: ${executablePath}`);
    // No viewport emulation: the real window is sized so its content area is exactly 1280x800. Emulating a
    // viewport larger than the window makes CDP screencast frames come out cropped/odd-sized (esp. headless).
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath,
      headless: this.headless,
      viewport: null,
      ignoreDefaultArgs: ["--enable-automation"], // no "controlled by automated test software" bar in the desktop view
      locale: "en-GB",
      env: { ...process.env, GOOGLE_API_KEY: "no", GOOGLE_DEFAULT_CLIENT_ID: "no", GOOGLE_DEFAULT_CLIENT_SECRET: "no" } as Record<string, string>,
      timezoneId: process.env.TZ || "Europe/London",
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",
        "--test-type", // no "unsupported command-line flag" infobar in the desktop view
        "--disable-dev-shm-usage",
        "--disable-component-update",
        "--password-store=basic",
        "--force-device-scale-factor=1",
        "--window-position=0,0",
        `--window-size=${VIEWPORT.width},${VIEWPORT.height + 139}`,
      ],
    });
    this.context.on("page", (p) => {
      void this.follow(p);
    });
    this.context.on("close", () => {
      log("warn", "browser closed");
      this.context = null;
      this.page = null;
      this.cdp = null;
      this.starting = null;
    });
    const first = this.context.pages()[0] ?? (await this.context.newPage());
    await this.follow(first);
    await this.fitWindow(first).catch((e) => log("warn", "could not size the browser window", e.message));
  }

  /** Resize the OS window so the page's content area is exactly VIEWPORT. */
  private async fitWindow(p: Page) {
    const [w0, h0] = (await p.evaluate("[innerWidth, innerHeight]")) as [number, number];
    if (w0 === VIEWPORT.width && h0 === VIEWPORT.height) return;
    const cdp = await this.context!.newCDPSession(p);
    try {
      for (let i = 0; i < 3; i++) {
        const [iw, ih] = (await p.evaluate("[innerWidth, innerHeight]")) as [number, number];
        if (iw === VIEWPORT.width && ih === VIEWPORT.height) return;
        const { windowId, bounds } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number; bounds: { width: number; height: number } };
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } } as any).catch(() => {});
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: bounds.width + VIEWPORT.width - iw, height: bounds.height + VIEWPORT.height - ih } } as any);
        await p.waitForTimeout(150);
      }
      log("warn", `browser content area is ${await p.evaluate("innerWidth + 'x' + innerHeight")}, wanted ${VIEWPORT.width}x${VIEWPORT.height}`);
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  /** Make `p` the active page: screencast follows it. */
  private async follow(p: Page) {
    if (this.page === p) return;
    const old = this.cdp;
    this.page = p;
    this.cdp = null;
    // Info bars (e.g. crash-restore) come and go and change the content height; keep it at VIEWPORT.
    p.on("load", () => void this.fitWindow(p).catch(() => {}));
    p.on("close", () => {
      if (this.page !== p) return;
      const rest = this.context?.pages().filter((x) => x !== p && !x.isClosed()) ?? [];
      this.page = null;
      if (rest.length) void this.follow(rest[rest.length - 1]);
    });
    if (old) {
      old.send("Page.stopScreencast").catch(() => {});
      old.detach().catch(() => {});
    }
    try {
      const cdp = await this.context!.newCDPSession(p);
      this.cdp = cdp;
      cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { deviceWidth: number } }) => {
        cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
        if (this.cdp !== cdp) return;
        this.pushFrame(f.data, f.metadata?.deviceWidth);
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 });
    } catch (e) {
      log("warn", "screencast failed", (e as Error).message);
    }
  }

  private pushFrame(data: string, deviceWidth?: number) {
    const now = Date.now();
    const minGap = this.rate === "full" ? 80 : 950;
    if (now - this.lastFrameAt < minGap) return;
    this.lastFrameAt = now;
    const size = jpegSize(Buffer.from(data.slice(0, 4096), "base64")) ?? { w: VIEWPORT.width, h: VIEWPORT.height };
    if (deviceWidth) this.frameScale = deviceWidth / size.w;
    this.onFrame?.(data, size.w, size.h);
  }

  setRate(rate: "full" | "tile") {
    this.rate = rate;
    this.lastFrameAt = 0;
  }

  async activePage(): Promise<Page> {
    await this.start();
    if (!this.page || this.page.isClosed()) {
      const p = this.context!.pages().find((x) => !x.isClosed()) ?? (await this.context!.newPage());
      await this.follow(p);
    }
    return this.page!;
  }

  async navigate(url: string, signal?: AbortSignal) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    const p = await this.activePage();
    const resp = await raceAbort(p.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }), signal ?? new AbortController().signal);
    await p.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
    await this.fitWindow(p).catch(() => {});
    return { url: p.url(), title: await p.title().catch(() => ""), status: resp?.status() ?? null };
  }

  async snapshot() {
    const p = await this.activePage();
    const tree = (await p.evaluate(SNAPSHOT_FN)) as string;
    this.refLabels.clear();
    for (const m of tree.matchAll(/- (\S+) "([^"]*)" \[ref=(e\d+)\]/g)) this.refLabels.set(m[3], `${m[1]} "${m[2].slice(0, 50)}"`);
    return { url: p.url(), title: await p.title().catch(() => ""), tree };
  }

  /** Human-readable target for the action log: `e12` → `button "Cancel subscription"`. */
  describe(target: string): string {
    const ref = /^\[?(?:ref=)?(e\d+)\]?$/.exec(target.trim());
    return (ref && this.refLabels.get(ref[1])) || target;
  }
  private refLabels = new Map<string, string>();

  private async resolve(target: string, kind: "click" | "type"): Promise<Locator> {
    const p = await this.activePage();
    const t = target.trim();
    const ref = /^\[?(?:ref=)?(e\d+)\]?$/.exec(t);
    if (ref) {
      const l = p.locator(`[data-fam-ref="${ref[1]}"]`);
      if ((await l.count()) > 0) return l.first();
      throw new Error(`ref ${ref[1]} not found; take a new browser_snapshot`);
    }
    const tries: Locator[] =
      kind === "type"
        ? [p.getByLabel(t, { exact: true }), p.getByLabel(t), p.getByPlaceholder(t), p.getByRole("textbox", { name: t }), p.locator(t.startsWith("#") || t.startsWith(".") || t.includes("[") ? t : "#__none__")]
        : [
            p.getByRole("button", { name: t, exact: true }),
            p.getByRole("link", { name: t, exact: true }),
            p.getByRole("button", { name: t }),
            p.getByRole("link", { name: t }),
            p.getByRole("tab", { name: t }),
            p.getByLabel(t),
            p.getByText(t, { exact: true }),
            p.getByText(t),
          ];
    for (const l of tries) {
      try {
        const count = await l.count();
        for (let i = 0; i < Math.min(count, 5); i++) {
          const c = l.nth(i);
          if (await c.isVisible()) return c;
        }
      } catch {
        /* bad selector; try next */
      }
    }
    throw new Error(`nothing visible matches "${t}"`);
  }

  async click(target: string) {
    const l = await this.resolve(target, "click");
    const label = ((await l.innerText().catch(() => "")) || (await l.getAttribute("aria-label").catch(() => "")) || target).trim().slice(0, 80);
    const p = await this.activePage();
    await l.click({ timeout: 10_000 });
    await p.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await p.waitForTimeout(150);
    return { clicked: label, url: p.url(), title: await p.title().catch(() => "") };
  }

  async type(target: string, value: string, submit = false) {
    const l = await this.resolve(target, "type");
    await l.fill(value, { timeout: 10_000 });
    const p = await this.activePage();
    if (submit) {
      await l.press("Enter");
      await p.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    }
    return { typed: value.length, url: p.url(), title: await p.title().catch(() => "") };
  }

  async press(key: string) {
    const p = await this.activePage();
    await p.keyboard.press(key);
    await p.waitForTimeout(100);
    return { pressed: key, url: p.url() };
  }

  async waitFor(text: string, timeoutMs: number, signal?: AbortSignal) {
    const p = await this.activePage();
    const started = Date.now();
    const deadline = started + timeoutMs;
    // Poll so navigations/reloads in between don't break the wait.
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError(signal);
      const found = await p
        .getByText(text)
        .first()
        .isVisible()
        .catch(() => false);
      if (found) return { found: true, waited_ms: Date.now() - started, url: p.url(), title: await p.title().catch(() => "") };
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`text "${text}" did not appear within ${Math.round(timeoutMs / 1000)}s`);
  }

  async screenshot(): Promise<{ jpeg: Buffer; url: string; title: string }> {
    const p = await this.activePage();
    const jpeg = await p.screenshot({ type: "jpeg", quality: 82, timeout: 15_000 });
    return { jpeg, url: p.url(), title: await p.title().catch(() => "") };
  }

  /** Remote take-control input from the viewer. x,y are frame pixels. */
  async input(inp: any) {
    const p = await this.activePage();
    if (inp.kind === "navigate" && inp.url) {
      await this.navigate(String(inp.url)).catch((e) => log("warn", "navigate input failed", e.message));
      return;
    }
    if (inp.kind === "key") {
      if (inp.action === "type" && inp.text) await p.keyboard.type(String(inp.text));
      else if (inp.key) await p.keyboard.press(String(inp.key));
      return;
    }
    if (inp.kind === "mouse" && this.cdp) {
      const x = Number(inp.x) * this.frameScale;
      const y = Number(inp.y) * this.frameScale;
      const button = inp.button === "right" ? "right" : inp.button === "middle" ? "middle" : "left";
      const send = (type: string, extra: object = {}) => this.cdp!.send("Input.dispatchMouseEvent", { type, x, y, ...extra } as any);
      switch (inp.action) {
        case "move":
          await send("mouseMoved");
          break;
        case "down":
          await send("mousePressed", { button, clickCount: 1 });
          break;
        case "up":
          await send("mouseReleased", { button, clickCount: 1 });
          break;
        case "click":
          await send("mouseMoved");
          await send("mousePressed", { button, clickCount: 1 });
          await send("mouseReleased", { button, clickCount: 1 });
          break;
        case "wheel":
          await send("mouseWheel", { deltaX: Number(inp.dx ?? 0), deltaY: Number(inp.dy ?? 0) });
          break;
      }
    }
  }

  async addCookies(cookies: Parameters<BrowserContext["addCookies"]>[0]) {
    await this.start();
    await this.context!.addCookies(cookies);
  }

  async close() {
    const c = this.context;
    this.context = null;
    this.starting = null;
    await c?.close().catch(() => {});
  }
}
