import { SESSION_COOKIE, SESSION_VALUE } from "../demo-site.js";
import type { Host, TaskRun } from "../task.js";
import { callTool, type ToolResult } from "../tools.js";
import { AbortedError } from "../util.js";

/**
 * Deterministic demo executor. It drives the same tool implementations as Claude Code / Codex
 * (real Chrome, real terminal, real memory/ask/approval round trips) with realistic pacing.
 * FAMILIAR_SCRIPT_SPEED scales the pauses (tests use 10).
 */
export type Scenario = "cancel" | "pay" | "install" | "generic";

export function pickScenario(brief: string): Scenario {
  const b = brief.toLowerCase();
  if (/\b(cancel|unsubscribe)\b/.test(b)) return "cancel";
  if (/\b(pay|book|buy|purchase|checkout)\b/.test(b)) return "pay";
  if (/\binstall\b/.test(b)) return "install";
  return "generic";
}

class Run {
  constructor(
    private h: Host,
    private t: TaskRun,
  ) {}

  async tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const r = await callTool(this.h, this.t, name, args);
    return r;
  }

  /** Like tool() but a failure aborts the scenario with a failed finish. */
  async must(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const r = await this.tool(name, args);
    if (!r.ok) throw new ScenarioError(`${name} failed: ${r.text}`);
    return r;
  }

  pause(ms: number) {
    return this.h.pause(this.t, ms);
  }

  async step(text: string, steps?: number) {
    await this.pause(450);
    await this.tool("step", { text, ...(steps ? { steps_estimate: steps } : {}) });
    await this.pause(350);
  }

  /** Click by the ref a snapshot gave the element with this label, like a model would. */
  async clickLabelled(tree: string, label: string) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`- (?:link|button) "${esc}" \\[ref=(e\\d+)\\]`).exec(tree);
    return this.must("browser_click", m ? { ref: m[1] } : { text: label });
  }

  async loginCookie() {
    await this.h.browser.addCookies([{ name: SESSION_COOKIE, value: SESSION_VALUE, url: this.h.demo.origin }]);
  }
}

class ScenarioError extends Error {}

export async function runScripted(h: Host, t: TaskRun): Promise<void> {
  const r = new Run(h, t);
  const scenario = pickScenario(t.brief);
  try {
    switch (scenario) {
      case "cancel":
        return await cancel(h, t, r);
      case "pay":
        return await pay(h, t, r);
      case "install":
        return await install(h, t, r);
      default:
        return await generic(h, t, r);
    }
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    const msg = (e as Error).message;
    if (!t.result) await callTool(h, t, "finish", { outcome: "failed", summary: `Stopped: ${msg}` });
  }
}

async function cancel(h: Host, t: TaskRun, r: Run) {
  h.demo.reset();
  await r.loginCookie();
  const origin = h.demo.origin;

  await r.step("Check what I already know about this subscription", 7);
  await r.tool("memory_search", { query: "polyform subscription cancel procedure" });
  await r.pause(600);

  await r.step("Open Polyform billing settings");
  await r.must("browser_navigate", { url: `${origin}/` });
  await r.pause(700);
  await r.must("browser_click", { text: "Settings" });
  await r.pause(500);
  await r.must("browser_click", { text: "Billing" });
  await r.pause(600);
  const billing = await r.must("browser_snapshot");

  await r.step("Start the cancellation");
  await r.clickLabelled(billing.text, "Cancel subscription");
  await r.pause(1200);

  await r.step("Decline the retention offer (50% off for 3 months)");
  const offer = await r.must("browser_snapshot");
  await r.pause(500);
  await r.clickLabelled(offer.text, "No thanks, cancel subscription");

  await r.step('Confirm, then wait for "cancelled"');
  await r.must("browser_wait_for", { text: "cancelled", timeout_s: 30 });
  await r.pause(500);

  const expected = h.demo.endDate;
  await r.step(`Verify the plan now ends ${expected}`);
  const after = await r.must("browser_snapshot");
  const m = /Cancelled — ends ([0-9]{1,2} [A-Za-z]{3,4} [0-9]{4})/.exec(after.text);
  const end = m?.[1];
  await r.pause(500);
  if (!end) {
    await r.tool("browser_screenshot");
    await r.tool("finish", { outcome: "partial", summary: "Polyform shows the subscription as cancelled, but I couldn't read the plan end date. Worth a quick look." });
    return;
  }

  await r.step("Remember how this went");
  const procedure = [
    "1. Open Polyform → Settings → Billing (already logged in via the saved Chrome profile).",
    '2. Click "Cancel subscription".',
    '3. A retention offer appears (50% off for 3 months): click "No thanks, cancel subscription".',
    '4. Wait for the billing page to say "cancelled" (takes a couple of seconds).',
    '5. Verify the plan card reads "Cancelled — ends <date>".',
  ].join("\n");
  await r.tool("memory_note", {
    kind: "procedure",
    subject: "polyform",
    text: `How to cancel Polyform: Settings → Billing → Cancel subscription → decline the 50%-off retention offer ("No thanks, cancel subscription") → wait for "cancelled" → check the end date on the plan card.`,
  });
  await r.pause(400);
  await r.tool("memory_note", { kind: "subscription", subject: "polyform", text: `Polyform Creator plan (£16/month) is cancelled; access ends ${end} and there are no further charges.` });
  await r.pause(400);
  await r.tool("browser_screenshot");
  await r.tool("finish", {
    outcome: "success",
    summary: `Cancelled your Polyform Creator plan (£16/month). I declined the 50%-off retention offer; you keep access until ${end} and won't be charged again.`,
    skill_name: "cancel-polyform",
    procedure,
  });
}

async function pay(h: Host, t: TaskRun, r: Run) {
  h.demo.reset();
  await r.loginCookie();
  const rail = /\b(train|rail|ticket|trip|travel|edinburgh|journey)\b/i.test(t.brief);
  const shop = rail
    ? {
        merchant: "Northline Rail",
        open: "Open the held Northline journey",
        start: `${h.demo.railOrigin}/`,
        next: "Continue to payment",
        description: `London King's Cross → Edinburgh Waverley, ${h.demo.railDate} 09:00, 1 adult, Standard Premium`,
        confirm: "Booking confirmed",
        refRe: /NLR-[0-9A-Z]+/,
        what: `the ${h.demo.railDate} 09:00 London King's Cross → Edinburgh Waverley train (Standard Premium, seat C42)`,
        subject: "northline",
      }
    : {
        merchant: "Polyform",
        open: "Open the Polyform checkout",
        start: `${h.demo.origin}/pricing`,
        next: "Buy now",
        description: "Studio Lighting Kit + 12-month commercial seat (Visa •••• 4242)",
        confirm: "Payment successful",
        refRe: /PF-\d+/,
        what: "the Polyform Studio Lighting Kit + 12-month commercial seat",
        subject: "polyform",
      };

  await r.step(shop.open, 5);
  await r.must("browser_navigate", { url: shop.start });
  await r.pause(700);
  await r.must("browser_click", { text: shop.next });
  await r.pause(600);

  await r.step("Check the total");
  const snap = await r.must("browser_snapshot");
  const total = /Total\s*\n?.*?£([0-9]+\.[0-9]{2})/s.exec(snap.text)?.[1] ?? "142.40";
  await r.pause(600);

  await r.step(`Get approval to pay £${total} to ${shop.merchant}`);
  const approval = await r.must("request_approval", { amount_gbp: Number(total), merchant: shop.merchant, description: shop.description });
  if (approval.data?.answer !== "approve") {
    await r.step("Hold: leave it unpaid");
    await r.pause(400);
    await r.tool("finish", { outcome: "partial", summary: `Held at checkout — nothing was charged. ${shop.what[0].toUpperCase()}${shop.what.slice(1)} for £${total} is ready if you want it later.` });
    return;
  }

  await r.step(`Pay £${total} with Visa •••• 4242`);
  await r.clickLabelled(snap.text, `Pay £${total}`);
  await r.must("browser_wait_for", { text: shop.confirm, timeout_s: 30 });
  h.spend(t, Math.round(Number(total) * 100));
  await r.pause(500);

  await r.step("Check the receipt");
  const done = await r.must("browser_snapshot");
  const ref = shop.refRe.exec(done.text)?.[0] ?? "unknown";
  await r.tool("memory_note", { kind: "episode", subject: shop.subject, text: `Paid £${total} to ${shop.merchant} for ${shop.what} (ref ${ref}) on Visa 4242.` });
  await r.tool("browser_screenshot");
  await r.tool("finish", { outcome: "success", summary: `Paid £${total} to ${shop.merchant} for ${shop.what}. Reference ${ref}; the confirmation is on its way to ryan@example.com.` });
}

async function install(h: Host, t: TaskRun, r: Run) {
  const raw = /install\s+(?:the\s+|a\s+|an\s+|me\s+)?([a-z0-9][a-z0-9._+-]*)/i.exec(t.brief)?.[1] ?? "tool";
  const name = raw.toLowerCase().replace(/[^a-z0-9._+-]/g, "").slice(0, 32) || "tool";
  const Name = name[0].toUpperCase() + name.slice(1);
  const s = (secs: number) => (secs / h.cfg.scriptSpeed).toFixed(3);

  await r.step("Check the machine and what's already installed", 5);
  await r.must("shell", { command: `uname -m && ls ~/opt 2>/dev/null | grep -v '^bin$' || echo "(nothing in ~/opt yet)"` });
  await r.pause(400);
  await r.must("shell", { command: `df -h ~ | tail -1` });
  await r.pause(500);

  await r.step(`Ask which ${Name} release to install`);
  const ans = await r.must("ask_user", { question: `${Name} 4.5 LTS or 4.6? 4.5 LTS gets fixes for two years; 4.6 has the newest features.`, options: ["4.5 LTS", "4.6"] });
  const label = String(ans.data?.label ?? "4.5 LTS");
  const lts = !/4\.6/.test(label);
  const version = lts ? "4.5.3" : "4.6.0";
  const human = lts ? "4.5 LTS" : "4.6";
  const archive = `${name}-${version}-linux-x64.tar.xz`;

  await r.step(`Download ${Name} ${human}`);
  await r.must("shell", {
    command: [
      `mkdir -p ~/.cache/familiar && cd ~/.cache/familiar`,
      `echo "Fetching https://downloads.example.org/${name}/${archive}"`,
      `for p in 6 17 29 41 55 68 79 91 100; do printf '\\r  %3d%%  [%-25s]  %3d MB' $p "$(printf '%*s' $((p/4)) '' | tr ' ' '#')" $((p*312/100)); sleep ${s(0.3)}; done; echo`,
      `echo "saved ${archive} (312 MB), sha256 OK"`,
    ].join("\n"),
    timeout_s: 120,
  });
  await r.pause(400);

  await r.step(`Unpack into ~/opt/${name}`);
  await r.must("shell", {
    command: [
      `mkdir -p ~/opt/${name}/bin ~/opt/${name}/lib ~/opt/bin && cd ~/opt/${name}`,
      `for f in lib/core.so lib/render.so lib/python3.11.zip share/icons share/locale; do echo "  x ${name}-${version}/$f"; sleep ${s(0.12)}; done`,
      `printf '%s\\n' "${name} ${human}" > VERSION`,
      `printf '#!/bin/sh\\necho "${Name} ${version} (${lts ? "LTS" : "stable"}) - installed by Familiar"\\n' > bin/${name}`,
      `chmod +x bin/${name} && ln -sf ~/opt/${name}/bin/${name} ~/opt/bin/${name}`,
      `echo "installed to $PWD"`,
    ].join("\n"),
  });
  await r.pause(400);

  await r.step("Verify the install");
  const v = await r.must("shell", { command: `${name} --version && ls ~/opt/${name}` });
  h.refreshInstalls();
  await r.tool("memory_note", { kind: "fact", subject: name, text: `${Name} ${human} (${version}) is installed at ~/opt/${name} on the ${h.cfg.name} machine.` });
  const first = String(v.data?.output ?? "").split("\n")[0];
  await r.tool("finish", { outcome: "success", summary: `Installed ${Name} ${human} at ~/opt/${name} (${first.trim() || version}). It's on the PATH as \`${name}\`.` });
}

async function generic(h: Host, t: TaskRun, r: Run) {
  await r.loginCookie();
  await r.step("Check memory for anything relevant", 4);
  await r.tool("memory_search", { query: t.brief.slice(0, 200) });
  await r.pause(500);

  await r.step("Look over the machine");
  const u = await r.must("shell", { command: "uname -a" });
  await r.pause(300);
  const df = await r.must("shell", { command: "df -h ~" });
  await r.pause(300);
  await r.must("shell", { command: "ls ~" });
  await r.pause(400);

  await r.step("Check the browser works");
  await r.must("browser_navigate", { url: `${h.demo.origin}/` });
  await r.pause(800);

  await r.step("Summarise");
  const kernel = String(u.data?.output ?? "").trim().split(/\s+/).slice(0, 3).join(" ");
  const cols = String(df.data?.output ?? "").trim().split("\n").pop()?.trim().split(/\s+/) ?? [];
  const free = cols[3] ?? "?";
  await r.pause(400);
  await r.tool("finish", {
    outcome: "success",
    summary: `Scripted demo run for "${t.brief.slice(0, 80)}": the machine is healthy (${kernel}), ${free} free in the home directory, and Chrome is working. Pick the claude or codex executor for real work.`,
  });
}
