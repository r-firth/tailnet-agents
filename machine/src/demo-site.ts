import http from "node:http";
import type { AddressInfo } from "node:net";
import { log } from "./util.js";

/**
 * "Polyform" - a fictional 3D-asset SaaS served by agentd itself, used by the scripted executor
 * for the no-credentials demo and the end-to-end tests. Addressed as http://polyform.localhost:<port>
 * (Chromium resolves *.localhost to loopback).
 */

export const SESSION_COOKIE = "pf_session";
export const SESSION_VALUE = "demo-ryan-7f3a";

interface State {
  status: "active" | "cancelling" | "cancelled";
  renewsOn: Date;
  offerDeclined: boolean;
  orders: { id: string; total: string }[];
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).replace(/Sept/, "Sep");
}

const LOGO = `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a45"/><stop offset="1" stop-color="#7c5cff"/></linearGradient></defs><path d="M16 2 29 9.5v13L16 30 3 22.5v-13Z" fill="url(#pg)"/><path d="M16 2 29 9.5 16 17 3 9.5Z" fill="#fff" fill-opacity=".35"/><path d="M16 17v13" stroke="#fff" stroke-opacity=".5" stroke-width="1.2"/></svg>`;

const CSS = `
:root{--ink:#161622;--muted:#6b6b80;--line:#e7e7ef;--bg:#f6f6fa;--card:#fff;--accent:#7c5cff;--accent-2:#ff7a45;--ok:#12805c;--warn:#b54708;--danger:#c4320a}
*{box-sizing:border-box}html,body{margin:0}body{font:15px/1.5 "Inter",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}
a{color:inherit}header.top{display:flex;align-items:center;gap:28px;padding:14px 32px;background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;text-decoration:none;letter-spacing:-.01em}
nav.main{display:flex;gap:6px;flex:1}nav.main a{padding:7px 12px;border-radius:8px;text-decoration:none;color:var(--muted);font-weight:500}
nav.main a:hover,nav.main a.on{background:var(--bg);color:var(--ink)}
.who{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:14px}.avatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#ffb38a,#9b86ff);display:grid;place-items:center;color:#fff;font-weight:700}
main{max-width:1080px;margin:0 auto;padding:32px}h1{font-size:28px;letter-spacing:-.02em;margin:0 0 6px}h2{font-size:18px;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 24px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.tile{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tile .art{height:130px;display:grid;place-items:center}.tile .meta{padding:10px 12px;font-size:13px}.tile .meta b{display:block;font-size:14px}
.btn{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:#fff;border-radius:10px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;color:var(--ink)}
.btn.primary{background:var(--ink);border-color:var(--ink);color:#fff}.btn.accent{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.danger{color:var(--danger);border-color:#f3c7b8}.btn.link{border:none;background:none;color:var(--muted);text-decoration:underline;padding:9px 6px}
.layout{display:grid;grid-template-columns:200px 1fr;gap:28px}.side a{display:block;padding:8px 12px;border-radius:8px;text-decoration:none;color:var(--muted);font-weight:500}
.side a.on{background:#fff;color:var(--ink);border:1px solid var(--line)}
.plan{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}.plan .price{font-size:26px;font-weight:700}.plan .price small{font-size:14px;color:var(--muted);font-weight:500}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:3px 9px;border-radius:99px;background:#e8f6ef;color:var(--ok)}.pill.warn{background:#fff3e6;color:var(--warn)}.pill.grey{background:#eef;color:var(--muted)}
dl.kv{display:grid;grid-template-columns:180px 1fr;gap:10px 16px;margin:0}dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;font-weight:500}
.banner{border-radius:12px;padding:14px 18px;margin-bottom:18px;font-weight:500}.banner.ok{background:#e8f6ef;color:#0b5e43;border:1px solid #bfe6d4}.banner.info{background:#f1eeff;color:#3f2da8;border:1px solid #dcd3ff}
.offer{background:linear-gradient(135deg,#fff5ef,#f3efff);border:1px solid #eadfff;border-radius:16px;padding:28px}.offer .big{font-size:40px;font-weight:800;letter-spacing:-.03em}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}table.items{width:100%;border-collapse:collapse}table.items td{padding:10px 0;border-bottom:1px solid var(--line)}table.items td:last-child{text-align:right}
table.items tr.total td{font-weight:700;font-size:17px;border-bottom:none}input.f{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;width:100%}
label.l{display:block;font-size:13px;color:var(--muted);margin:12px 0 6px}.spinner{width:16px;height:16px;border:2px solid #cfc6ff;border-top-color:var(--accent);border-radius:50%;display:inline-block;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}footer{color:var(--muted);font-size:12px;text-align:center;padding:24px}
`;

const SHAPES = [
  ["Low-poly fox", "#ff9f6e", "M20 70 L50 20 L80 70 Z"],
  ["Sci-fi crate", "#7c9cff", "M25 30 h50 v45 h-50 Z"],
  ["Ceramic vase", "#e8a0c8", "M40 20 h20 c0 20 18 25 18 45 c0 12 -12 15 -28 15 c-16 0 -28 -3 -28 -15 c0 -20 18 -25 18 -45Z"],
  ["Desert rock", "#d4a373", "M15 70 L30 38 L52 30 L78 45 L85 70 Z"],
  ["Street lamp", "#8bd3c7", "M47 20 h6 v55 h-6Z M35 20 h30 v8 h-30Z"],
  ["Toon tree", "#7cc47f", "M50 15 L75 55 H25 Z M46 55 h8 v20 h-8Z"],
  ["Hover bike", "#b69cff", "M18 55 Q50 30 82 55 Q50 66 18 55Z"],
  ["Market stall", "#ffc857", "M20 40 h60 l-6 -14 h-48Z M26 40 h48 v32 h-48Z"],
];

function art(color: string, d: string) {
  return `<svg width="100" height="90" viewBox="0 0 100 90"><ellipse cx="50" cy="80" rx="34" ry="5" fill="#000" opacity=".08"/><path d="${d}" fill="${color}"/><path d="${d}" fill="#fff" opacity=".18" transform="translate(-3,-3) scale(1.0)"/></svg>`;
}

export class DemoSite {
  private server: http.Server;
  port = 0;
  state!: State;

  constructor(private speed = 1) {
    this.reset();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        log("warn", "demo site error", e);
        res.writeHead(500).end("error");
      });
    });
  }

  reset() {
    const renews = new Date();
    renews.setUTCHours(0, 0, 0, 0);
    renews.setUTCDate(renews.getUTCDate() + 14);
    this.state = { status: "active", renewsOn: renews, offerDeclined: false, orders: [] };
  }

  get origin() {
    return `http://polyform.localhost:${this.port}`;
  }

  /** A second fictional brand on the same server (dispatched by Host header): Northline Rail, for booking demos. */
  get railOrigin() {
    return `http://northline.localhost:${this.port}`;
  }

  /** The Friday after next-ish: a plausible travel date. */
  get railDate() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  }

  get endDate() {
    return fmtDate(this.state.renewsOn);
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as AddressInfo).port;
    log("info", `demo site on ${this.origin}`);
  }

  stop() {
    this.server.closeAllConnections?.();
    this.server.close();
  }

  private page(title: string, active: string, body: string, opts: { authed?: boolean; script?: string } = {}) {
    const nav = [
      ["/", "Library"],
      ["/generate", "Generate"],
      ["/pricing", "Pricing"],
      ["/settings", "Settings"],
    ]
      .map(([href, label]) => `<a href="${href}" class="${active === label ? "on" : ""}">${label}</a>`)
      .join("");
    const who = opts.authed === false ? `<a class="btn" href="/login">Log in</a>` : `<div class="who"><span>Ryan</span><div class="avatar">R</div></div>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Polyform</title><style>${CSS}</style></head>
<body><header class="top"><a class="brand" href="/">${LOGO}<span>Polyform</span></a><nav class="main">${nav}</nav>${who}</header>
<main>${body}</main><footer>Polyform is a fictional demo service served by your Familiar machine. Nothing here is real or charged.</footer>${opts.script ? `<script>${opts.script}</script>` : ""}</body></html>`;
  }

  private settingsShell(tab: string, inner: string) {
    const tabs = [
      ["/settings", "Profile"],
      ["/settings/billing", "Billing"],
      ["/settings/api", "API keys"],
    ]
      .map(([h, l]) => `<a href="${h}" class="${l === tab ? "on" : ""}">${l}</a>`)
      .join("");
    return `<h1>Settings</h1><p class="sub">Manage your account, plan and keys.</p><div class="layout"><aside class="side">${tabs}</aside><section>${inner}</section></div>`;
  }

  private billingCard() {
    const s = this.state;
    const end = fmtDate(s.renewsOn);
    if (s.status === "cancelled") {
      return `<div class="banner ok" role="status">Your Creator subscription has been cancelled. You keep Creator features until ${end}; you won't be charged again.</div>
<div class="card"><div class="plan"><div><h2>Creator plan <span class="pill grey">Cancelled</span></h2><div class="price">£16 <small>/ month</small></div></div></div>
<dl class="kv" style="margin-top:18px"><dt>Status</dt><dd id="plan-status">Cancelled — ends ${end}</dd><dt>Access until</dt><dd id="plan-end">${end}</dd><dt>Payment method</dt><dd>Visa •••• 4242</dd><dt>Next charge</dt><dd>None</dd></dl>
<div class="row" style="margin-top:20px"><a class="btn accent" href="/pricing">Resubscribe</a></div></div>`;
    }
    if (s.status === "cancelling") {
      return `<div class="banner info" id="pending" role="status"><span class="spinner"></span>&nbsp; Cancelling your subscription with our payment provider…</div>
<div class="card"><div class="plan"><div><h2>Creator plan <span class="pill warn">Updating</span></h2><div class="price">£16 <small>/ month</small></div></div></div></div>`;
    }
    return `<div class="card"><div class="plan"><div><h2>Creator plan <span class="pill">Active</span></h2><div class="price">£16 <small>/ month</small></div>
<p class="sub" style="margin:6px 0 0">200 generations a month · commercial licence · 4K texture export</p></div><a class="btn" href="/pricing">Change plan</a></div>
<dl class="kv" style="margin-top:18px"><dt>Status</dt><dd id="plan-status">Active — renews ${end}</dd><dt>Next charge</dt><dd>£16.00 on ${end}</dd><dt>Payment method</dt><dd>Visa •••• 4242</dd><dt>Generations used</dt><dd>143 of 200</dd></dl></div>
<div class="card"><h2>Cancel subscription</h2><p class="sub" style="margin-bottom:14px">You'll keep access until the end of the current billing period.</p><a class="btn danger" href="/settings/billing/cancel">Cancel subscription</a></div>`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://polyform.localhost");
    const p = url.pathname;
    if ((req.headers.host ?? "").startsWith("northline.")) return this.handleRail(req, res, url);
    const authed = (req.headers.cookie ?? "").split(/;\s*/).includes(`${SESSION_COOKIE}=${SESSION_VALUE}`);
    const html = (body: string, code = 200) => res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
    const redirect = (to: string) => res.writeHead(303, { location: to }).end();
    const form = async () => new URLSearchParams(await readBody(req));

    if (p === "/favicon.ico") return res.writeHead(204).end();
    if (p === "/__demo/reset" && req.method === "POST") {
      this.reset();
      return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    }
    if (p === "/api/subscription") {
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: this.state.status, ends: this.endDate }));
    }
    if (p === "/login") {
      if (req.method === "POST") {
        res.setHeader("set-cookie", `${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; Max-Age=31536000; SameSite=Lax`);
        return redirect("/");
      }
      return html(
        this.page(
          "Log in",
          "",
          `<div class="card" style="max-width:420px;margin:40px auto"><h1>Welcome back</h1><p class="sub">Log in to your Polyform studio.</p>
<form method="post"><label class="l" for="email">Email</label><input class="f" id="email" name="email" type="email" value="ryan@example.com"><label class="l" for="pw">Password</label><input class="f" id="pw" name="password" type="password">
<div style="margin-top:18px"><button class="btn primary" type="submit">Log in</button></div></form></div>`,
          { authed: false },
        ),
      );
    }
    if (!authed) return redirect("/login");

    if (p === "/" || p === "/library") {
      const tiles = SHAPES.map(([n, c, d], i) => `<div class="tile"><div class="art" style="background:${c}22">${art(c, d)}</div><div class="meta"><b>${n}</b>${["GLB", "FBX", "USDZ", "GLB"][i % 4]} · ${(i * 7 + 3) % 40 + 2}k tris</div></div>`).join("");
      return html(this.page("Library", "Library", `<h1>Welcome back, Ryan</h1><p class="sub">Your library · 8 recent generations</p><div class="grid">${tiles}</div>`));
    }
    if (p === "/generate") {
      return html(this.page("Generate", "Generate", `<h1>Generate</h1><p class="sub">Describe an asset and Polyform builds a game-ready mesh.</p><div class="card"><label class="l" for="prompt">Prompt</label><input class="f" id="prompt" name="prompt" placeholder="a mossy stone well, stylised"><div style="margin-top:14px"><button class="btn accent">Generate</button></div></div>`));
    }
    if (p === "/pricing") {
      const plans = [
        ["Hobby", "£0", "20 generations a month"],
        ["Creator", "£16", "200 generations · commercial licence"],
        ["Studio", "£48", "Unlimited · team seats · priority queue"],
      ]
        .map(([n, pr, d]) => `<div class="card"><h2>${n}</h2><div class="price" style="font-size:26px;font-weight:700">${pr}<small style="font-size:14px;color:var(--muted)"> / month</small></div><p class="sub">${d}</p></div>`)
        .join("");
      return html(this.page("Pricing", "Pricing", `<h1>Pricing</h1><p class="sub">Simple plans for every pipeline.</p><div class="grid" style="grid-template-columns:repeat(3,1fr)">${plans}</div>
<div class="card"><h2>Studio Lighting Kit</h2><p class="sub">HDRI pack plus a one-year commercial seat.</p><a class="btn primary" href="/checkout">Buy now</a></div>`));
    }
    if (p === "/settings") {
      return html(this.page("Settings", "Settings", this.settingsShell("Profile", `<div class="card"><h2>Profile</h2><dl class="kv"><dt>Name</dt><dd>Ryan</dd><dt>Email</dt><dd>ryan@example.com</dd><dt>Studio</dt><dd>Firth Games</dd><dt>Member since</dt><dd>March 2025</dd></dl></div>`)));
    }
    if (p === "/settings/api") {
      return html(this.page("API keys", "Settings", this.settingsShell("API keys", `<div class="card"><h2>API keys</h2><p class="sub">pf_live_••••••••••3kQ9 · created 2 Jun</p></div>`)));
    }
    if (p === "/settings/billing") {
      const script =
        this.state.status === "cancelling"
          ? `(function poll(){fetch('/api/subscription').then(r=>r.json()).then(s=>{if(s.status==='cancelled'){location.replace('/settings/billing')}else setTimeout(poll,300)})})()`
          : undefined;
      return html(this.page("Billing", "Settings", this.settingsShell("Billing", this.billingCard()), { script }));
    }
    if (p === "/settings/billing/cancel") {
      if (req.method === "POST") {
        const f = await form();
        if (f.get("choice") === "accept") return redirect("/settings/billing");
        if (this.state.status === "active") {
          this.state.status = "cancelling";
          this.state.offerDeclined = true;
          setTimeout(() => (this.state.status = "cancelled"), Math.round(1800 / this.speed));
        }
        return redirect("/settings/billing");
      }
      if (this.state.status !== "active") return redirect("/settings/billing");
      return html(
        this.page(
          "Cancel subscription",
          "Settings",
          this.settingsShell(
            "Billing",
            `<div class="offer"><p style="margin:0 0 6px;font-weight:600;color:var(--accent)">Before you go</p><div class="big">50% off for 3 months</div>
<p class="sub" style="margin:8px 0 20px">Stay on Creator for £8/month until ${fmtDate(new Date(this.state.renewsOn.getTime() + 90 * 864e5))}. Your library, textures and licences stay exactly as they are.</p>
<form method="post" class="row"><button class="btn accent" name="choice" value="accept" type="submit">Keep my plan at 50% off</button><button class="btn link" name="choice" value="decline" type="submit">No thanks, cancel subscription</button></form></div>
<div class="card" style="margin-top:18px"><h2>What happens when you cancel</h2><p class="sub" style="margin:0">You keep Creator features until ${fmtDate(this.state.renewsOn)}. After that your account moves to Hobby; nothing is deleted.</p></div>`,
          ),
        ),
      );
    }
    if (p === "/checkout") {
      if (req.method === "POST") {
        const order = `PF-${20931 + this.state.orders.length}`;
        this.state.orders.push({ id: order, total: "£142.40" });
        return redirect(`/checkout/complete?order=${order}`);
      }
      return html(
        this.page(
          "Checkout",
          "Pricing",
          `<h1>Checkout</h1><p class="sub">Review your order.</p><div class="layout" style="grid-template-columns:1fr 340px">
<div class="card"><h2>Order summary</h2><table class="items"><tr><td>Studio Lighting Kit (42 HDRIs)</td><td>£39.00</td></tr><tr><td>Commercial seat, 12 months</td><td>£79.67</td></tr><tr><td>VAT (20%)</td><td>£23.73</td></tr><tr class="total"><td>Total</td><td id="total">£142.40</td></tr></table></div>
<div class="card"><h2>Payment</h2><p class="sub" style="margin-bottom:14px">Visa •••• 4242 · Ryan</p><form method="post"><button class="btn primary" type="submit" style="width:100%;justify-content:center">Pay £142.40</button></form></div></div>`,
        ),
      );
    }
    if (p === "/checkout/complete") {
      const order = url.searchParams.get("order") ?? "PF-20931";
      return html(
        this.page(
          "Order complete",
          "Pricing",
          `<div class="banner ok" role="status">Payment successful — £142.40 charged to Visa •••• 4242.</div><div class="card"><h1>Thanks, Ryan</h1><p class="sub">Order ${order} · Studio Lighting Kit + commercial seat. A receipt is on its way to ryan@example.com.</p><dl class="kv"><dt>Order</dt><dd id="order">${order}</dd><dt>Total</dt><dd>£142.40</dd><dt>Date</dt><dd>${fmtDate(new Date())}</dd></dl></div>`,
        ),
      );
    }
    return html(this.page("Not found", "", `<h1>Page not found</h1><p class="sub"><a href="/">Back to your library</a></p>`), 404);
  }

  private railPage(title: string, body: string) {
    const css = CSS.replace("--accent:#7c5cff", "--accent:#0f766e").replace("--ink:#161622", "--ink:#0b2530");
    const logo = `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="8" fill="#0f766e"/><path d="M8 20 L16 9 L24 20" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M8 24h16" stroke="#9fe3d6" stroke-width="2.5" stroke-linecap="round"/></svg>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Northline Rail</title><style>${css}</style></head>
<body><header class="top"><a class="brand" href="/">${logo}<span>Northline Rail</span></a><nav class="main"><a href="/" class="on">Journeys</a><a href="/">Railcards</a><a href="/">Help</a></nav><div class="who"><span>Ryan</span><div class="avatar" style="background:linear-gradient(135deg,#5eead4,#0f766e)">R</div></div></header>
<main>${body}</main><footer>Northline Rail is a fictional demo operator served by your Familiar machine. Nothing here is real or charged.</footer></body></html>`;
  }

  private journey() {
    return `<table class="items"><tr><td><b>London King's Cross → Edinburgh Waverley</b><br><span class="sub">${this.railDate} · 09:00 → 13:21 · direct · 4h 21m</span></td><td></td></tr>
<tr><td>1 adult · Standard Premium · seat C42 (table, window)</td><td>£118.67</td></tr><tr><td>VAT (20%)</td><td>£23.73</td></tr><tr class="total"><td>Total</td><td id="total">£142.40</td></tr></table>`;
  }

  private async handleRail(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const p = url.pathname;
    const html = (body: string, code = 200) => res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
    if (p === "/favicon.ico") return res.writeHead(204).end();
    if (p === "/") {
      return html(this.railPage("Your journey", `<h1>Your journey</h1><p class="sub">Held for you for 15 minutes.</p><div class="card">${this.journey()}<div class="row" style="margin-top:18px"><a class="btn primary" href="/checkout">Continue to payment</a></div></div>`));
    }
    if (p === "/checkout" && req.method === "POST") {
      await readBody(req);
      const ref = `NLR-${(7342 + this.state.orders.length).toString(36).toUpperCase()}Q`;
      this.state.orders.push({ id: ref, total: "£142.40" });
      return res.writeHead(303, { location: `/checkout/complete?ref=${ref}` }).end();
    }
    if (p === "/checkout") {
      return html(this.railPage("Payment", `<h1>Payment</h1><p class="sub">Check your journey, then pay.</p><div class="layout" style="grid-template-columns:1fr 340px"><div class="card"><h2>Journey</h2>${this.journey()}</div>
<div class="card"><h2>Pay with</h2><p class="sub" style="margin-bottom:14px">Visa •••• 4242 · Ryan</p><form method="post"><button class="btn primary" type="submit" style="width:100%;justify-content:center">Pay £142.40</button></form></div></div>`));
    }
    if (p === "/checkout/complete") {
      const ref = url.searchParams.get("ref") ?? "NLR-5NQ";
      return html(this.railPage("Booking confirmed", `<div class="banner ok" role="status">Booking confirmed — £142.40 charged to Visa •••• 4242.</div><div class="card"><h1>You're going to Edinburgh</h1><p class="sub">${this.railDate} · 09:00 from London King's Cross · coach C, seat 42. Your e-ticket is in the Northline app and on its way to ryan@example.com.</p><dl class="kv"><dt>Booking reference</dt><dd id="ref">${ref}</dd><dt>Total</dt><dd>£142.40</dd></dl></div>`));
    }
    return html(this.railPage("Not found", `<h1>Page not found</h1>`), 404);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
