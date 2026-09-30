#!/usr/bin/env node
// Familiar dev mock server. Implements docs/protocol.md on :4400 with a
// simulated fleet: real headless-Chromium pages streamed as JPEG frames, a
// coding run with a live ANSI terminal, an approval over the £100 line, a
// question with free-text allowed, finished runs from earlier today, a memory
// graph with supersede chains, search, machines and settings.
//
//   node dev/mock-server.mjs            # port 4400
//   MOCK_EMPTY=1 node dev/mock-server.mjs   # fresh install, no runs yet
//   MOCK_SPEED=2 ...                     # everything twice as fast
//   FAMILIAR_TOKEN=secret ...            # require auth like the real server
//
// POST /api/_mock/reset restarts the scenario (handy for screenshots).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as sites from './sites.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist');
const PORT = +(process.env.PORT || 4400);
const TOKEN = process.env.FAMILIAR_TOKEN || '';
const SPEED = +(process.env.MOCK_SPEED || 1);
const EMPTY = !!process.env.MOCK_EMPTY;
const VW = 1024, VH = 576;

let chromium = null;
for (const p of [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  if (!p) continue;
  try { chromium = (await import(p)).chromium; if (chromium) break; } catch {}
}
if (!chromium) console.warn('[mock] playwright not found: browser runs will have no frames');

// ------------------------------------------------------------------ utils
const rid = (p) => p + crypto.randomBytes(6).toString('hex');
const iso = (d = Date.now()) => new Date(d).toISOString();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ABORT = Symbol('abort');

// ------------------------------------------------------------------ state
let GEN = 0;
let S; // world
let browser = null;
const artifacts = new Map(); // id -> {buf, type}
const clients = new Set(); // {ws, sub}
let evSeq = 1000;

function freshWorld() {
  return {
    tasks: new Map(), events: new Map(), terminal: new Map(), frames: new Map(),
    machines: new Map(), needs: [], messages: [], claims: [], nextNum: 210,
    pages: new Map(), // task_id -> {page, html, state, data}
    runs: new Map(),  // task_id -> Run
    answers: new Map(), // question_id -> resolve fn
    tokenBase: 1_184_000, spendBase: 1299,
    settings: {
      approval_threshold_p: 10000, default_executor: 'claude', no_ask_merchants: ['Tesco', 'TfL', 'Amazon'],
      coordinator: 'mock', embedder: 'hash', telegram: 'off', backends: ['local', 'docker', 'cloudflare', 'ssh'],
    },
    spawnIdx: 0,
  };
}

function storeArtifact(buf, type = 'image/jpeg') { const id = rid('a_'); artifacts.set(id, { buf, type }); return id; }

function broadcast(msg, filter) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.ws.readyState === 1 && (!filter || filter(c))) c.ws.send(s);
}

function taskOut(t) { const { _internal, ...rest } = t; return rest; }
function pushTask(t) { broadcast({ type: 'task', task: taskOut(t) }); }
function pushMachine(m) { broadcast({ type: 'machine', machine: m }); }
function pushNeeds() { broadcast({ type: 'needs_you', items: S.needs }); }
function pushStats() { broadcast({ type: 'stats', stats: stats() }); }

function stats() {
  const tasks = [...S.tasks.values()];
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const today = tasks.filter((t) => Date.parse(t.created_at) >= day.getTime() - 12 * 3600e3);
  return {
    spend_today_p: S.spendBase + tasks.reduce((a, t) => a + t.spend_p, 0),
    tokens_today: S.tokenBase + tasks.reduce((a, t) => a + t.tokens, 0),
    memory_nodes: 18204 + S.claims.length * 3,
    runs_today: today.length,
    runs_done_today: today.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status)).length,
    working: tasks.filter((t) => t.status === 'running' || t.status === 'starting').length,
    waiting: tasks.filter((t) => t.status === 'waiting').length,
  };
}

function stateOut() {
  return {
    tasks: [...S.tasks.values()].map(taskOut), machines: [...S.machines.values()], needs_you: S.needs,
    messages: S.messages.slice(-50), stats: stats(), settings: S.settings,
  };
}

function addEvent(task, kind, fields = {}, actor = 'agent', atMs) {
  const start = Date.parse(task.started_at || task.created_at);
  const at = atMs ?? Date.now();
  const ev = { id: evSeq++, task_id: task.id, at: iso(at), ms: Math.max(0, at - start), actor, kind, ...fields };
  if (!S.events.has(task.id)) S.events.set(task.id, []);
  S.events.get(task.id).push(ev);
  broadcast({ type: 'event', event: ev });
  return ev;
}

function termWrite(task, data) {
  S.terminal.set(task.id, (S.terminal.get(task.id) || '') + data);
  broadcast({ type: 'terminal', task_id: task.id, data }, (c) => c.sub === task.id);
}

function newTask(o) {
  const num = o.num ?? S.nextNum++;
  if (o.num && o.num >= S.nextNum) S.nextNum = o.num + 1;
  const t = {
    id: rid('t_'), num, title: o.title, brief: o.brief, status: o.status || 'queued', executor: o.executor || 'claude',
    machine_id: o.machine_id || null, source: o.source || 'web', created_at: iso(o.created ?? Date.now()),
    started_at: o.started != null ? iso(o.started) : null, ended_at: null, now: o.now || 'Reading the brief',
    waiting_for: null, step: 0, steps_estimate: o.steps_estimate || 8, spend_p: 0, tokens: o.tokens || 0,
    time_cap_s: o.time_cap_s || 3600, control: null, outcome: null, summary: null, receipt_artifact: null, last_frame_artifact: null,
  };
  S.tasks.set(t.id, t);
  S.events.set(t.id, []);
  S.terminal.set(t.id, '');
  S.frames.set(t.id, []);
  return t;
}

function setMachineTask(mid, tid) {
  const m = S.machines.get(mid); if (!m) return;
  m.task_id = tid; m.status = tid ? 'busy' : 'online'; pushMachine(m);
}

// ------------------------------------------------------------------ browser pages
async function ensureBrowser() {
  if (browser || !chromium) return browser;
  try { browser = await chromium.launch({ args: ['--disable-gpu', '--font-render-hinting=none'] }); }
  catch (e) { console.warn('[mock] could not launch chromium:', e.message); chromium = null; }
  return browser;
}

async function openSite(task, html, state, data) {
  const b = await ensureBrowser(); if (!b) return null;
  const page = await b.newPage({ viewport: { width: VW, height: VH } });
  await page.setContent(html);
  const entry = { page, html, state, data, tick: 0, last: null };
  S.pages.set(task.id, entry);
  if (state) await show(task, state, data);
  return entry;
}

async function show(task, state, data) {
  const e = S.pages.get(task.id); if (!e) return;
  e.state = state; e.data = data;
  try { await e.page.evaluate(([s, d]) => window.show(s, d), [state, data ?? null]); } catch {}
}
async function focusEl(task, sel, label, dashed, who) {
  const e = S.pages.get(task.id); if (!e || task.control) return;
  try { await e.page.evaluate(([a, b, c, d]) => window.__fam.focus(a, b, c, d), [sel, label, !!dashed, who || (task.executor === 'codex' ? 'Codex' : 'Claude')]); } catch {}
}
async function shot(task, quality = 78) {
  const e = S.pages.get(task.id); if (!e) return null;
  try { return await e.page.screenshot({ type: 'jpeg', quality }); } catch { return null; }
}
async function closeSite(task) {
  const e = S.pages.get(task.id); if (!e) return;
  S.pages.delete(task.id);
  try { await e.page.close(); } catch {}
}

// screencast loop: 2 fps for subscribed, ~1 fps for tiles, replay frames at 1 fps
let frameTick = 0;
async function frameLoop() {
  for (;;) {
    await delay(500);
    frameTick++;
    if (!clients.size && frameTick % 4) continue;
    for (const [tid, e] of S.pages) {
      const t = S.tasks.get(tid); if (!t) continue;
      const live = ['running', 'waiting', 'starting'].includes(t.status);
      if (!live) continue;
      const subscribed = [...clients].some((c) => c.sub === tid);
      const tileTick = frameTick % 2 === 0;
      if (!subscribed && !tileTick) continue;
      const buf = await shot(t, 72); if (!buf) continue;
      const data = buf.toString('base64');
      const msg = { type: 'frame', task_id: tid, machine_id: t.machine_id, data, w: VW, h: VH };
      broadcast(msg, (c) => c.sub === tid || tileTick);
      // replay frames: 1 fps while running, every 5 s while waiting
      const every = t.status === 'waiting' ? 10 : 2;
      if (frameTick % every === 0) {
        const arr = S.frames.get(tid);
        const ms = Date.now() - Date.parse(t.started_at || t.created_at);
        arr.push({ ms, artifact: storeArtifact(buf) });
        if (arr.length > 1200) { const old = arr.splice(0, 200); old.forEach((f) => artifacts.delete(f.artifact)); }
      }
    }
  }
}

// ------------------------------------------------------------------ runs
class Run {
  constructor(task) { this.t = task; this.gen = GEN; this.stepN = 0; S.runs.set(task.id, this); }
  get alive() { return this.gen === GEN && !this.cancelled && S.tasks.get(this.t.id) === this.t; }
  async sleep(ms) {
    let left = ms / SPEED;
    while (left > 0) {
      if (!this.alive) throw ABORT;
      await delay(100);
      if (!this.t.control) left -= 100;
    }
    if (!this.alive) throw ABORT;
  }
  upd(f) { Object.assign(this.t, f); pushTask(this.t); }
  ev(kind, f, actor) { return addEvent(this.t, kind, f, actor); }
  step(text, sid, state = 'active') {
    if (state === 'active') { this.stepN++; this.upd({ step: this.stepN, now: text }); }
    return this.ev('step', { text, state, step_id: sid }, 'agent');
  }
  done(sid, text) { this.ev('step', { text, state: 'done', step_id: sid }, 'agent'); }
  plan(items) { items.forEach(([sid, text]) => this.ev('step', { text, state: 'pending', step_id: sid }, 'agent')); }
  async tool(tool, target, actor, dur, result, status = 'ok') {
    const call_id = rid('c_');
    this.ev('tool', { tool, target, result: null, duration_ms: null, status: 'pending', call_id }, actor);
    await this.sleep(dur);
    this.ev('tool', { tool, target, result, duration_ms: Math.round(dur), status, call_id }, actor);
    this.upd({ tokens: this.t.tokens + Math.round(rand(300, 1600)) });
  }
  async keyframe(title, url) {
    const buf = await shot(this.t, 82); if (!buf) return;
    const a = storeArtifact(buf);
    this.t.last_frame_artifact = a; pushTask(this.t);
    this.ev('keyframe', { artifact: a, url, title }, 'browser');
    return a;
  }
  term(s) { termWrite(this.t, s); }
  async ask(question, options, allow_text = true, title) {
    const qid = rid('q_');
    this.ev('ask', { question_id: qid, question, options }, 'agent');
    S.needs.push({ id: qid, task_id: this.t.id, task_num: this.t.num, task_title: this.t.title, kind: 'question',
      title: title || question, detail: `${this.t.num} · ${machineName(this.t.machine_id)} · ${this.t.now}`,
      options: options.map((o) => ({ ...o })), allow_text, created_at: iso() });
    pushNeeds();
    this.upd({ status: 'waiting', waiting_for: 'your answer' });
    const ans = await this.waitAnswer(qid);
    this.upd({ status: 'running', waiting_for: null });
    return ans;
  }
  async approval(amount_p, merchant, description, detail) {
    const qid = rid('q_');
    const s = S.settings;
    const auto = amount_p <= s.approval_threshold_p || s.no_ask_merchants.some((m) => m.toLowerCase() === merchant.toLowerCase());
    this.ev('approval', { question_id: qid, amount_p, merchant, description, auto }, 'agent');
    if (auto) { this.ev('answer', { question_id: qid, answer: 'approve', label: 'Approved automatically', by: 'auto' }, 'you'); return 'approve'; }
    const over = amount_p - s.approval_threshold_p;
    S.needs.push({ id: qid, task_id: this.t.id, task_num: this.t.num, task_title: this.t.title, kind: 'approval',
      title: `Pay ${gbp(amount_p)} to ${merchant}`, detail: `${gbp(over)} over your ${gbp(s.approval_threshold_p, true)} line · ${detail || description}`,
      options: [{ id: 'approve', label: 'Approve', style: 'primary' }, { id: 'hold', label: 'Hold' }, { id: 'approve_always', label: `Approve and never ask for ${merchant}`, style: 'quiet' }],
      allow_text: false, created_at: iso(), amount_p, merchant });
    pushNeeds();
    this.upd({ status: 'waiting', waiting_for: `approval for ${gbp(amount_p)}` });
    for (;;) {
      const a = await this.waitAnswer(qid);
      if (a.answer === 'hold') {
        const n = { id: qid, task_id: this.t.id, task_num: this.t.num, task_title: this.t.title, kind: 'approval',
          title: `Held: ${gbp(amount_p)} to ${merchant}`, detail: `Run ${this.t.num} waits · the basket stays as it is`,
          options: [{ id: 'approve', label: 'Approve now', style: 'primary' }, { id: 'cancel', label: 'Cancel run' }], allow_text: false, created_at: iso() };
        S.needs.push(n); pushNeeds();
        this.upd({ waiting_for: 'held by you', now: `Held by you. ${description} stays in the basket` });
        continue;
      }
      if (a.answer === 'cancel') { cancelTask(this.t, 'Cancelled from the held approval'); throw ABORT; }
      if (a.answer === 'approve_always') {
        S.settings.no_ask_merchants.push(merchant);
        addClaim({ kind: 'rule', text: `Never ask before paying ${merchant}`, subject: merchant.toLowerCase(), confidence: 1, salience: 0.7, source: { task_id: this.t.id, label: 'Ryan, just now' } });
        this.ev('memory.write', { op: 'add', text: `RULE never ask for ${merchant}`, claim_kind: 'rule', claim_id: S.claims.at(-1).id, status: 'written' }, 'memory');
        broadcast({ type: 'hello', state: stateOut() });
      }
      this.upd({ status: 'running', waiting_for: null });
      return a.answer;
    }
  }
  waitAnswer(qid) {
    return new Promise((resolve, reject) => {
      S.answers.set(qid, resolve);
      const chk = setInterval(() => { if (!this.alive) { clearInterval(chk); S.answers.delete(qid); reject(ABORT); } }, 300);
      const orig = resolve;
      S.answers.set(qid, (a) => { clearInterval(chk); orig(a); });
    });
  }
  async finish(outcome, summary, receiptTitle) {
    let receipt = null;
    const buf = await shot(this.t, 85);
    if (buf) receipt = storeArtifact(buf);
    if (receipt && receiptTitle) this.ev('keyframe', { artifact: receipt, url: S.pages.get(this.t.id)?.url || null, title: receiptTitle }, 'browser');
    this.ev('done', { outcome, summary, receipt_artifact: receipt }, 'agent');
    this.upd({ status: outcome === 'failed' ? 'failed' : 'done', outcome, summary, receipt_artifact: receipt, last_frame_artifact: receipt || this.t.last_frame_artifact, ended_at: iso(), now: summary, waiting_for: null });
    setMachineTask(this.t.machine_id, null);
    S.runs.delete(this.t.id);
    pushStats();
  }
}

function machineName(id) { return S.machines.get(id)?.name || id; }
function gbp(p, short) { const v = p / 100; return '£' + (short && v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)); }

function cancelTask(t, why = 'Cancelled by you') {
  const r = S.runs.get(t.id); if (r) r.cancelled = true;
  S.runs.delete(t.id);
  S.needs = S.needs.filter((n) => n.task_id !== t.id); pushNeeds();
  addEvent(t, 'machine', { text: `${why}. The machine keeps its state for a backup.` }, 'machine');
  Object.assign(t, { status: 'cancelled', ended_at: iso(), control: null, waiting_for: null, now: why, outcome: null });
  pushTask(t);
  setMachineTask(t.machine_id, null);
  pushStats();
}

function run(task, fn) {
  const r = new Run(task);
  fn(r).catch((e) => { if (e !== ABORT) console.error('[mock] run error', e); });
  return r;
}

// ------------------------------------------------------------------ memory
let claimSeq = 800;
function addClaim(c) {
  const claim = { id: claimSeq++, state: 'active', superseded_by: null, created_at: iso(c.at ?? Date.now()), confidence: 0.8, salience: 0.5, ...c };
  delete claim.at;
  S.claims.push(claim); return claim;
}
function supersede(oldId, c) {
  const old = S.claims.find((x) => x.id === oldId);
  const n = addClaim(c);
  if (old) { old.state = 'superseded'; old.superseded_by = n.id; }
  return n;
}
function seedMemory(ids) {
  const H = 3600e3, D = 24 * H, now = Date.now();
  const ryan = (d) => ({ label: `Ryan, ${d}` });
  const C = (kind, subject, text, confidence, salience, source, ago) => addClaim({ kind, subject, text, confidence, salience, source, at: now - ago });
  const meshyOld = C('subscription', 'meshy', 'Meshy Pro plan, £16/month, renews monthly', 0.72, 0.4, { label: 'Gmail receipt, 14 Jun' }, 108 * D);
  S.meshyPlan = supersede(meshyOld.id, { kind: 'subscription', subject: 'meshy', text: 'Meshy Pro £16/mo on Visa 4242, renews 14 Oct', confidence: 0.91, salience: 0.6, source: { label: 'Gmail receipt, 14 Sep' }, at: now - 16 * D }).id;
  C('account', 'meshy', 'Meshy login is via Google (ryanfirth12@gmail.com)', 0.88, 0.5, { label: 'Run 187, 2 Sep' }, 28 * D);
  S.retentionRule = C('rule', 'subscriptions', 'Cancel means cancel: always decline retention offers', 1, 0.9, ryan('3 Sep'), 27 * D).id;
  C('episode', 'meshy', 'No prior attempts to cancel Meshy', 0.52, 0.2, { label: 'history scan' }, 20 * D);
  const card = C('fact', 'payments', 'Default card is Visa ending 4242, expires 08/28', 0.95, 0.8, ryan('11 Aug'), 50 * D);
  C('rule', 'payments', 'Ask before paying more than £100', 1, 1, ryan('1 Aug'), 60 * D);
  C('preference', 'trains', 'Prefers window seats, forward facing', 0.89, 0.6, ryan('Jul'), 80 * D);
  C('preference', 'trains', 'Take the 08:00 LNER when going to Edinburgh; avoid changes', 0.77, 0.5, { label: 'Runs 140, 162' }, 40 * D);
  C('person', 'sam', 'Sam lives in Edinburgh (Leith, EH6)', 0.93, 0.7, ryan('May'), 140 * D);
  C('fact', 'calendar', 'Edinburgh trip with Sam, 17–19 Oct', 0.84, 0.7, { label: 'Google Calendar' }, 6 * D);
  C('fact', 'studio', 'Studio is the Windows PC with the RTX 4090, reachable over Tailscale', 0.95, 0.6, { label: 'Machine setup, 12 Jul' }, 80 * D);
  C('preference', 'software', 'Pin LTS releases for client work', 0.71, 0.5, ryan('2025'), 300 * D);
  C('procedure', 'hetzner', 'HOW-TO download Hetzner invoices: console › Billing › Invoices, save PDFs to Drive/Finance/YYYY-MM, forward to accounts@', 0.9, 0.5, { label: 'Run 188' }, 30 * D);
  C('account', 'hetzner', 'Hetzner Cloud account, project "vecgra-prod", invoices monthly on the 1st', 0.9, 0.4, { label: 'Run 188' }, 30 * D);
  C('fact', 'vecgra', 'vecgra recall target is 0.90 at k=10', 0.82, 0.6, { label: 'README spec' }, 45 * D);
  C('episode', 'vecgra', 'CI flaked on graph tests in August (fixed by pinning numpy)', 0.64, 0.3, { label: 'Run 171' }, 50 * D);
  C('procedure', 'vecgra', 'Run the suite with `pytest -q -n 4`; benchmarks with `make bench`', 0.8, 0.4, { label: 'Run 171' }, 50 * D);
  C('subscription', 'spotify', 'Spotify Family £19.99/mo, renews on the 3rd', 0.9, 0.4, { label: 'Gmail receipt' }, 27 * D);
  C('subscription', 'github', 'GitHub Pro $4/mo, billed to Visa 4242', 0.86, 0.3, { label: 'Gmail receipt' }, 20 * D);
  const oldGym = C('subscription', 'gym', 'PureGym Leith £24.99/mo', 0.8, 0.3, { label: 'Bank statement, Jun' }, 100 * D);
  const gym = supersede(oldGym.id, { kind: 'subscription', subject: 'gym', text: 'PureGym cancelled, last payment 1 Aug', confidence: 0.92, salience: 0.3, source: { label: 'Run 176, 1 Aug' }, at: now - 60 * D });
  void gym;
  C('person', 'mum', "Mum's birthday is 12 Nov; likes Kew Gardens gift cards", 0.8, 0.6, ryan('last year'), 330 * D);
  C('preference', 'food', 'Vegetarian; no mushrooms', 0.95, 0.7, ryan('Jan'), 260 * D);
  C('rule', 'email', 'Never send email on my behalf without showing me the draft', 1, 0.9, ryan('1 Aug'), 60 * D);
  C('account', 'lner', 'LNER account ryanfirth12@gmail.com, saved Visa 4242', 0.9, 0.4, { label: 'Run 162' }, 40 * D);
  C('fact', 'home', 'Home address: Leith, Edinburgh EH6 (full address in vault)', 0.97, 0.8, ryan('Jan'), 260 * D);
  C('procedure', 'royalmail', 'Track Royal Mail items at royalmail.com/track-your-item with the RM…GB number', 0.8, 0.3, { label: 'Run 150' }, 70 * D);
  C('fact', 'dentist', 'Dentist: Leith Walk Dental, check-ups every 6 months, last one 14 Apr', 0.85, 0.4, { label: 'Gmail' }, 160 * D);
  const disputed = C('fact', 'passport', 'Passport expires March 2027', 0.55, 0.5, { label: 'Photo, 2024' }, 400 * D);
  disputed.state = 'disputed';
  C('preference', 'shopping', 'Prefers buying from John Lewis over Amazon for electronics', 0.66, 0.4, ryan('Jun'), 110 * D);
  C('episode', 'errands', 'Restored errands from snapshot 2026-09-28 21:40, 14 signed-in sites', 0.99, 0.2, { label: 'machine' }, 2 * D);
  const f = C('fact', 'wifi', 'Studio Wi-Fi password', 0.9, 0.2, ryan('Mar'), 200 * D); f.state = 'forgotten';
  void card; void ids;
}

// ------------------------------------------------------------------ machines
function seedMachines() {
  const H = 3600e3, now = Date.now();
  const M = (o) => S.machines.set(o.id, { parent: null, task_id: null, has_desktop: false, desktop_url: null, last_backup_at: null, installs: [], ...o });
  M({ id: 'm_errands', name: 'errands', backend: 'cloudflare', status: 'online', specs: { cpu: 4, mem_gb: 12, disk_gb: 20 }, stats: { cpu_pct: 4, mem_gb: 1.8, net_mbs: 0.1, uptime_s: 68 }, last_backup_at: iso(now - 26 * H), installs: ['chrome 141 (/opt/google/chrome)', 'agentd 0.4.2', 'ffmpeg 7.1'] });
  M({ id: 'm_studio', name: 'studio', backend: 'ssh', status: 'online', specs: { cpu: 16, mem_gb: 64, disk_gb: 2000 }, stats: { cpu_pct: 4, mem_gb: 9.8, net_mbs: 0.2, uptime_s: 6 * 86400 + 4 * 3600 }, has_desktop: true, desktop_url: '/api/_mock/desktop/studio', last_backup_at: iso(now - 15 * H), installs: ['blender 4.2 LTS (C:\\Program Files\\Blender Foundation)', 'cuda 12.6', 'python 3.12', 'agentd 0.4.2'] });
  M({ id: 'm_code', name: 'code', backend: 'cloudflare', status: 'online', specs: { cpu: 8, mem_gb: 16, disk_gb: 40 }, stats: { cpu_pct: 12, mem_gb: 3.1, net_mbs: 0.3, uptime_s: 740 }, last_backup_at: iso(now - 3 * H), installs: ['python 3.12', 'uv 0.8', 'gh 2.61', 'codex 0.38', 'claude-code 2.4'] });
  M({ id: 'm_booker', name: 'booker', backend: 'docker', status: 'online', specs: { cpu: 2, mem_gb: 4, disk_gb: 10 }, stats: { cpu_pct: 3, mem_gb: 1.2, net_mbs: 0.0, uptime_s: 190 }, parent: 'm_errands', last_backup_at: iso(now - 26 * H), installs: ['chrome 141', 'agentd 0.4.2'] });
  M({ id: 'm_archive', name: 'archive', backend: 'local', status: 'sleeping', specs: { cpu: 2, mem_gb: 2, disk_gb: 500 }, stats: { cpu_pct: 0, mem_gb: 0, net_mbs: 0, uptime_s: 0 }, last_backup_at: iso(now - 50 * H), installs: ['restic 0.17'] });
}

let statTick = 0;
async function machineLoop() {
  for (;;) {
    await delay(2000);
    statTick++;
    for (const m of S.machines.values()) {
      if (m.status === 'offline' || m.status === 'sleeping') { m.stats = { cpu_pct: 0, mem_gb: 0, net_mbs: 0, uptime_s: 0 }; continue; }
      const t = m.task_id ? S.tasks.get(m.task_id) : null;
      const busy = t && t.status === 'running' && !t.control;
      const s = m.stats;
      const target = busy ? (m.id === 'm_code' ? 72 : m.id === 'm_studio' ? 45 : 38) : t && t.control ? 8 : 4;
      s.cpu_pct = Math.round(clamp(s.cpu_pct + (target - s.cpu_pct) * 0.35 + rand(-9, 9), 1, 99));
      const mt = busy ? m.specs.mem_gb * 0.45 : m.specs.mem_gb * 0.16;
      s.mem_gb = +clamp(s.mem_gb + (mt - s.mem_gb) * 0.2 + rand(-0.15, 0.15), 0.3, m.specs.mem_gb).toFixed(1);
      s.net_mbs = +clamp(busy ? s.net_mbs * 0.5 + rand(0.4, 3.2) : s.net_mbs * 0.4 + rand(0, 0.15), 0, 40).toFixed(1);
      s.uptime_s += 2;
      pushMachine(m);
      if (busy) { t.tokens += Math.round(rand(80, 700) * SPEED); }
    }
    for (const t of S.tasks.values()) if (t.status === 'running' && statTick % 2 === 0) pushTask(t);
    if (statTick % 3 === 0) pushStats();
  }
}

// ------------------------------------------------------------------ scenarios
const ANSI = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', m: '\x1b[35m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const agentdBanner = (name, t) => `${ANSI.d}agentd 0.4.2 · ${name} · task ${t.num} · executor ${t.executor}${ANSI.x}\r\n${ANSI.d}chrome 141 headful on :99 · cdp 127.0.0.1:9222${ANSI.x}\r\n`;

function scenarioMeshy() {
  const now = Date.now();
  const t = newTask({ num: 214, title: 'Cancel my Meshy sub', brief: 'cancel my meshy sub', status: 'starting', executor: 'claude', machine_id: 'm_errands', source: 'telegram', created: now - 1500, started: now - 1200, steps_estimate: 12, time_cap_s: 900, tokens: 2100, now: 'Read the brief: which subscription, and what cancel means to you' });
  setMachineTask('m_errands', t.id);
  S.messages.push({ id: rid('msg_'), role: 'user', text: 'cancel my meshy sub', channel: 'telegram', task_id: null, at: iso(now - 1600) });
  run(t, async (r) => {
    r.ev('brief', { text: 'cancel my meshy sub', channel: 'telegram' }, 'you');
    r.step('Brief received via Telegram', 's1'); r.upd({ status: 'running' });
    await r.sleep(1200); r.done('s1', 'Brief received via Telegram');
    r.plan([['s2', 'Recall how your Meshy account works'], ['s3', 'Wake errands with its signed-in Chrome'], ['s4', 'Open Meshy billing'], ['s5', 'Cancel the Pro plan'], ['s6', 'Verify the plan ends 14 Oct'], ['s7', 'Save the how-to to memory'], ['s8', 'Report on Telegram with proof']]);
    r.step('Check memory for how your Meshy account works', 's2');
    await r.tool('memory.search', '"meshy account" k=8', 'memory', 900, '4 hits (.91 .88 .84 .52)');
    r.ev('memory.recall', { query: 'meshy account', hits: [
      { id: S.meshyPlan, score: 0.91, text: 'Pro plan £16/mo on Visa 4242, renews 14 Oct', kind: 'subscription', source: 'Gmail, 14 Sep' },
      { id: 802, score: 0.88, text: 'Login via Google', kind: 'account', source: 'Run 187' },
      { id: S.retentionRule, score: 0.84, text: 'Rule: cancel means cancel, skip offers', kind: 'rule', source: 'Ryan, 3 Sep' },
      { id: 803, score: 0.52, text: 'No prior cancel attempts', kind: 'episode', source: 'history' }] }, 'memory');
    r.done('s2', 'Recalled 4 memories');
    r.step('Wake errands so the signed-in Chrome is ready', 's3');
    r.term(agentdBanner('errands', t));
    await r.tool('machine.restore', 'errands@snap-0928-2140', 'machine', 2800, 'ready');
    r.ev('machine', { text: 'Restored errands from snapshot 2026-09-28 21:40 in 2.8 s · 14 signed-in sites' }, 'machine');
    r.term(`${ANSI.d}restored snapshot snap-0928-2140 (2.8 s) · chrome profile ok · 14 cookies jars${ANSI.x}\r\n`);
    await openSite(t, sites.meshy, 'dash');
    r.done('s3', 'Restored errands from snapshot');
    r.step('Find billing from the Meshy workspace', 's4');
    await r.tool('browser.navigate', 'https://meshy.ai/workspace', 'browser', 1320, '200');
    S.pages.get(t.id) && (S.pages.get(t.id).url = 'https://meshy.ai/workspace');
    await r.keyframe('Meshy · My assets', 'https://meshy.ai/workspace');
    await r.sleep(3000);
    await r.tool('browser.snapshot', 'a11y tree', 'browser', 210, '412 nodes');
    await focusEl(t, '#nav-settings', 'next: Settings › Billing', true);
    await r.sleep(3500);
    await focusEl(t, '#nav-settings', 'click · link "Settings"');
    await r.tool('browser.click', 'link[name=Settings]', 'browser', 640, 'nav');
    await show(t, 'billing'); S.pages.get(t.id).url = 'https://meshy.ai/settings/billing';
    await r.keyframe('Meshy · Billing', 'https://meshy.ai/settings/billing');
    r.done('s4', 'Opened Settings › Billing');
    r.step('Read the plan, then find the cancel control', 's5');
    await focusEl(t, '#plan', 'reading: plan', true);
    await r.tool('browser.snapshot', 'region "Current plan"', 'browser', 180, 'Pro £16/mo, renews 14 Oct');
    await r.sleep(4000);
    await focusEl(t, '#cancel', 'click · button "Cancel subscription"');
    await r.sleep(2500);
    await r.tool('browser.click', 'button[name="Cancel subscription"]', 'browser', 180, 'dialog');
    await show(t, 'offer');
    await r.keyframe('Meshy · Retention offer', 'https://meshy.ai/settings/billing');
    r.upd({ now: 'Skip the offer: cancel means cancel' });
    await r.tool('memory.get', 'rule:retention-offers', 'memory', 12, '"just cancel"');
    await focusEl(t, '#nothanks', 'click · "No thanks, cancel"');
    await r.sleep(3000);
    await r.tool('browser.click', 'button[name="No thanks, cancel"]', 'browser', 150, 'ok');
    await show(t, 'confirm');
    await r.keyframe('Meshy · Cancelling', 'https://meshy.ai/settings/billing');
    r.upd({ now: 'Confirm, then verify the plan now ends 14 Oct', waiting_for: 'text "cancelled"' });
    await focusEl(t, '#wait', 'wait_for · text~"cancelled"', true);
    await r.tool('browser.wait_for', 'text~"cancelled"', 'browser', 26000, 'found');
    await show(t, 'cancelled');
    r.upd({ waiting_for: null });
    await r.keyframe('Meshy · Subscription cancelled', 'https://meshy.ai/settings/billing');
    r.done('s5', 'Cancelled Pro, declined the 50% offer');
    r.step('Verify the plan now ends 14 Oct', 's6');
    await focusEl(t, '#ends', 'verify · ends 14 Oct', true);
    await r.tool('browser.snapshot', 'region "Current plan"', 'browser', 160, 'Ends 14 Oct · will not renew');
    await r.sleep(3000);
    r.done('s6', 'Verified: Pro ends 14 Oct, will not renew');
    r.step('Save the how-to to memory', 's7');
    const c1 = supersede(S.meshyPlan, { kind: 'subscription', subject: 'meshy', text: 'Meshy Pro cancelled; active until 14 Oct, then Free', confidence: 0.97, salience: 0.5, source: { task_id: t.id, label: `Run ${t.num}, today` } });
    r.ev('memory.write', { op: 'supersede', text: 'PLAN pro: renews → ends 14 Oct', claim_kind: 'subscription', claim_id: c1.id, status: 'written' }, 'memory');
    const c2 = addClaim({ kind: 'procedure', subject: 'meshy', text: 'HOW-TO cancel Meshy: Settings › Billing › Cancel subscription › "No thanks, cancel"', confidence: 0.9, salience: 0.4, source: { task_id: t.id, label: `Run ${t.num}, today` } });
    r.ev('memory.write', { op: 'add', text: 'HOW-TO cancel meshy (5 steps)', claim_kind: 'procedure', claim_id: c2.id, status: 'written' }, 'memory');
    await r.tool('memory.note', 'procedure: cancel meshy', 'memory', 40, 'ok');
    const c3 = addClaim({ kind: 'rule', subject: 'meshy', text: 'WATCH: no Meshy charge on 14 Oct', confidence: 0.9, salience: 0.6, source: { task_id: t.id, label: `Run ${t.num}, today` } });
    r.ev('memory.write', { op: 'add', text: 'WATCH no charge on 14 Oct', claim_kind: 'rule', claim_id: c3.id, status: 'written' }, 'memory');
    r.done('s7', 'Saved how-to, plan change and a 14 Oct watcher');
    r.step('Report on Telegram with proof', 's8');
    const text = 'Cancelled Meshy Pro. It stays active until 14 Oct, then drops to Free. Declined the 50% offer, per your rule. Receipt attached.';
    r.ev('message', { text }, 'agent');
    S.messages.push({ id: rid('msg_'), role: 'assistant', text, channel: 'telegram', task_id: t.id, at: iso() });
    broadcast({ type: 'message', message: S.messages.at(-1) });
    await r.sleep(1200);
    r.done('s8', 'Reported on Telegram with the receipt');
    await r.finish('success', 'Meshy Pro cancelled; active until 14 Oct, no retention offer taken.', 'Receipt · Meshy subscription cancelled');
    await delay(12000 / SPEED);
    await closeSite(t);
    if (r.gen === GEN) spawnNext();
  });
  return t;
}

function scenarioBlender() {
  const now = Date.now(); const ago = 5 * 60e3 + 14e3;
  const t = newTask({ num: 215, title: 'Install Blender on studio', brief: 'install blender on the studio pc', status: 'running', executor: 'claude', machine_id: 'm_studio', source: 'telegram', created: now - ago - 900, started: now - ago, steps_estimate: 7, tokens: 22100, now: 'Asked you: 4.5 LTS or 4.6?' });
  setMachineTask('m_studio', t.id);
  S.messages.push({ id: rid('msg_'), role: 'user', text: 'install blender on the studio pc', channel: 'telegram', task_id: null, at: iso(now - ago - 1000) });
  S.messages.push({ id: rid('msg_'), role: 'assistant', text: 'Installing Blender on studio (run 215). I\'ll check it sees the 4090.', channel: 'telegram', task_id: t.id, at: iso(now - ago - 500) });
  const at = (s) => now - ago + s * 1000;
  const E = (kind, f, actor, s) => addEvent(t, kind, f, actor, at(s));
  E('brief', { text: 'install blender on the studio pc', channel: 'telegram' }, 'you', 0.4);
  E('step', { text: 'Woke studio over Tailscale', state: 'done', step_id: 'b1' }, 'agent', 6);
  E('tool', { tool: 'machine.connect', target: 'studio via tailscale', result: 'ok', duration_ms: 420, status: 'ok', call_id: 'cb1' }, 'machine', 6);
  E('memory.recall', { query: 'studio blender', hits: [{ id: 811, score: 0.86, text: 'Studio is the Windows PC with the 4090', kind: 'fact', source: 'Machine setup' }, { id: 812, score: 0.71, text: 'Pin LTS for client work', kind: 'preference', source: 'Ryan, 2025' }] }, 'memory', 9);
  E('tool', { tool: 'memory.search', target: '"studio blender" k=8', result: '2 hits (.86 .71)', duration_ms: 44, status: 'ok', call_id: 'cb2' }, 'memory', 9);
  E('step', { text: 'Fetched blender.org release list', state: 'done', step_id: 'b2' }, 'agent', 41);
  E('tool', { tool: 'browser.navigate', target: 'https://www.blender.org/download', result: '200', duration_ms: 980, status: 'ok', call_id: 'cb3' }, 'browser', 41);
  E('tool', { tool: 'shell', target: 'winget show BlenderFoundation.Blender', result: '4.5.3 LTS, 4.6.0', duration_ms: 2310, status: 'ok', call_id: 'cb4' }, 'machine', 70);
  E('step', { text: 'Launched the installer', state: 'done', step_id: 'b3' }, 'agent', 112);
  E('tool', { tool: 'desktop.launch', target: 'blender-setup.msi', result: 'window', duration_ms: 3100, status: 'ok', call_id: 'cb5' }, 'machine', 112);
  E('tool', { tool: 'desktop.snapshot', target: 'Blender Setup', result: '2 options', duration_ms: 160, status: 'ok', call_id: 'cb6' }, 'machine', 140);
  E('step', { text: 'Asked you: 4.5 LTS or 4.6?', state: 'active', step_id: 'b4' }, 'agent', 141);
  ['Install the chosen version', 'Check it launches and sees the RTX 4090', 'Report on Telegram'].forEach((x, i) => E('step', { text: x, state: 'pending', step_id: 'b' + (5 + i) }, 'agent', 141));
  t.step = 4;
  S.terminal.set(t.id, agentdBanner('studio', t).replace('chrome 141 headful on :99 · cdp 127.0.0.1:9222', 'desktop session 1 · 2560×1440 · RTX 4090') +
    `PS C:\\Users\\ryan> winget show BlenderFoundation.Blender --versions\r\n${ANSI.d}Found Blender [BlenderFoundation.Blender]${ANSI.x}\r\nVersion\r\n-------\r\n4.6.0\r\n4.5.3\r\n4.2.9\r\nPS C:\\Users\\ryan> Start-Process .\\Downloads\\blender-setup.msi\r\n`);
  run(t, async (r) => {
    await openSite(t, sites.blender, 'pick');
    const kf = await shot(t, 80);
    if (kf) { const a = storeArtifact(kf); t.last_frame_artifact = a; addEvent(t, 'keyframe', { artifact: a, url: 'desktop://studio/Blender Setup', title: 'Blender Setup · choose a version' }, 'browser', at(140)); }
    r.stepN = 4;
    const qa = await r.ask('Blender: 4.5 LTS or 4.6?', [{ id: '4.5', label: '4.5 LTS' }, { id: '4.6', label: '4.6' }], true);
    const v = qa.answer === '4.6' ? '4.6' : '4.5';
    const label = v === '4.6' ? '4.6' : '4.5 LTS';
    r.done('b4', qa.text ? `You said: “${qa.text}”` : `You answered ${label}`);
    r.step(`Installing Blender ${label}, then check it sees the 4090`, 'b5');
    await focusEl(t, v === '4.6' ? '#o46' : '#o45', `select · ${label}`);
    await r.tool('desktop.click', `radio "Blender ${label}" + Next`, 'machine', 900, 'installing');
    const files = ['blender.exe', 'python311.dll', 'datafiles/studiolights', 'scripts/addons_core', 'cycles/lib/kernel_cuda.fatbin', 'blender.crt'];
    for (let p = 0; p <= 100; p += 6) {
      await show(t, 'install', { v: label, short: v, pct: Math.min(100, p), file: files[Math.floor(p / 18)] });
      await r.sleep(1500);
    }
    await show(t, 'install', { v: label, short: v, pct: 100 });
    await r.keyframe(`Blender Setup · ${label} installed`, 'desktop://studio/Blender Setup');
    r.done('b5', `Installed Blender ${label}`);
    r.step('Check it launches and sees the RTX 4090', 'b6');
    r.term(`PS C:\\Users\\ryan> & "C:\\Program Files\\Blender Foundation\\Blender ${v}\\blender.exe" -b --python-expr "import bpy;print(bpy.app.version_string, [d.name for d in bpy.context.preferences.addons['cycles'].preferences.get_devices_for_type('OPTIX')])"\r\n`);
    await r.tool('shell', `blender -b --python-expr "…devices"`, 'machine', 5200, 'OPTIX: RTX 4090');
    r.term(`${v === '4.6' ? '4.6.0' : '4.5.3 LTS'} ['NVIDIA GeForce RTX 4090']\r\n${ANSI.g}Blender quit${ANSI.x}\r\nPS C:\\Users\\ryan> `);
    r.done('b6', 'Launches headless and sees the RTX 4090 via OptiX');
    r.step('Report on Telegram', 'b7');
    const text = `Blender ${label} is installed on studio and renders on the RTX 4090 (OptiX).`;
    r.ev('message', { text }, 'agent');
    S.messages.push({ id: rid('msg_'), role: 'assistant', text, channel: 'telegram', task_id: t.id, at: iso() }); broadcast({ type: 'message', message: S.messages.at(-1) });
    const m = S.machines.get('m_studio'); m.installs = [`blender ${v === '4.6' ? '4.6.0' : '4.5.3 LTS'} (C:\\Program Files\\Blender Foundation\\Blender ${v})`, ...m.installs.filter((x) => !x.startsWith('blender'))]; pushMachine(m);
    r.done('b7', 'Reported on Telegram');
    await r.finish('success', text, `Blender ${label} installed`);
  });
  return t;
}

function scenarioLner() {
  const now = Date.now(); const ago = 2 * 60e3 + 51e3;
  const t = newTask({ num: 216, title: 'LNER train to Edinburgh', brief: 'book me the 8am LNER to Edinburgh on Friday 17th, window seat', status: 'running', executor: 'claude', machine_id: 'm_booker', source: 'web', created: now - ago - 700, started: now - ago, steps_estimate: 7, tokens: 17400, now: 'Waiting for your approval to pay £142.40' });
  setMachineTask('m_booker', t.id);
  S.messages.push({ id: rid('msg_'), role: 'user', text: 'book me the 8am LNER to Edinburgh on Friday 17th, window seat', channel: 'web', task_id: null, at: iso(now - ago - 800) });
  S.messages.push({ id: rid('msg_'), role: 'assistant', text: 'Booking the 08:00 Kings Cross → Edinburgh on Fri 17 Oct (run 216). I\'ll ask before paying if it\'s over £100.', channel: 'web', task_id: t.id, at: iso(now - ago - 600) });
  const at = (s) => now - ago + s * 1000;
  const E = (kind, f, actor, s) => addEvent(t, kind, f, actor, at(s));
  E('brief', { text: t.brief, channel: 'web' }, 'you', 0.3);
  E('memory.recall', { query: 'lner train edinburgh', hits: [{ id: 806, score: 0.89, text: 'Prefers window seats, forward facing', kind: 'preference', source: 'Ryan, Jul' }, { id: 809, score: 0.77, text: 'Edinburgh trip with Sam, 17–19 Oct', kind: 'fact', source: 'Calendar' }, { id: 823, score: 0.74, text: 'LNER account, saved Visa 4242', kind: 'account', source: 'Run 162' }] }, 'memory', 3);
  E('tool', { tool: 'memory.search', target: '"lner train edinburgh" k=8', result: '3 hits (.89 .77 .74)', duration_ms: 51, status: 'ok', call_id: 'cl0' }, 'memory', 3);
  E('step', { text: 'Searched Kings Cross → Edinburgh, Fri 17 Oct', state: 'done', step_id: 'l1' }, 'agent', 22);
  E('tool', { tool: 'browser.navigate', target: 'https://www.lner.co.uk', result: '200', duration_ms: 1100, status: 'ok', call_id: 'cl1' }, 'browser', 22);
  E('tool', { tool: 'browser.type', target: 'input[name=from] "Kings Cross"', result: 'ok', duration_ms: 380, status: 'ok', call_id: 'cl2' }, 'browser', 30);
  E('step', { text: 'Picked 08:00 direct, window seat 42A', state: 'done', step_id: 'l2' }, 'agent', 70);
  E('tool', { tool: 'browser.click', target: 'seat[42A]', result: 'selected', duration_ms: 220, status: 'ok', call_id: 'cl3' }, 'browser', 70);
  E('step', { text: 'Filled checkout with Visa 4242', state: 'done', step_id: 'l3' }, 'agent', 122);
  E('tool', { tool: 'browser.fill', target: 'card: Visa 4242', result: 'ok', duration_ms: 310, status: 'ok', call_id: 'cl4' }, 'browser', 122);
  E('tool', { tool: 'guard.spend', target: '£142.40 > £100', result: 'ask', duration_ms: null, status: 'ok', call_id: 'cl5' }, 'agent', 151);
  E('step', { text: 'Ask you to approve £142.40 (over £100)', state: 'active', step_id: 'l4' }, 'agent', 151);
  ['Pay and save the tickets', 'Send tickets on Telegram', 'Add the trip to your calendar'].forEach((x, i) => E('step', { text: x, state: 'pending', step_id: 'l' + (5 + i) }, 'agent', 151));
  t.step = 4;
  S.terminal.set(t.id, agentdBanner('booker', t));
  run(t, async (r) => {
    await openSite(t, sites.lner, 'review'); S.pages.get(t.id).url = 'https://www.lner.co.uk/buy-tickets/checkout';
    const kf = await shot(t, 80);
    if (kf) { const a = storeArtifact(kf); t.last_frame_artifact = a; addEvent(t, 'keyframe', { artifact: a, url: 'https://www.lner.co.uk/buy-tickets/checkout', title: 'LNER · Review and pay' }, 'browser', at(150)); }
    await focusEl(t, '#pay', 'held: over £100, asking Ryan', true);
    r.stepN = 4;
    const a = await r.approval(14240, 'LNER', 'Seat 42A', 'London Kings Cross → Edinburgh · Fri 17 Oct 08:00 · Seat 42A · Visa 4242');
    r.done('l4', a === 'approve_always' ? 'You approved £142.40 and said never ask for LNER' : 'You approved £142.40');
    r.step('Paying £142.40, then tickets to Telegram', 'l5');
    await focusEl(t, '#pay', 'click · "Pay £142.40"');
    await r.sleep(1500);
    await r.tool('browser.click', 'button[name="Pay £142.40"]', 'browser', 300, 'processing');
    await show(t, 'processing');
    await r.tool('browser.wait_for', 'text~"Booking confirmed"', 'browser', 6000, 'found');
    await show(t, 'done'); S.pages.get(t.id).url = 'https://www.lner.co.uk/buy-tickets/confirmation';
    r.upd({ spend_p: 14240 });
    await r.keyframe('LNER · Booking confirmed LNER7Q2K9', 'https://www.lner.co.uk/buy-tickets/confirmation');
    r.done('l5', 'Paid £142.40 · booking LNER7Q2K9');
    r.step('Send tickets on Telegram', 'l6');
    await r.tool('telegram.send', 'e-ticket LNER7Q2K9.pdf', 'agent', 800, 'sent');
    r.done('l6', 'Sent the e-ticket on Telegram');
    r.step('Add the trip to your calendar', 'l7');
    await r.tool('calendar.add', 'Fri 17 Oct 08:00 KGX → EDB', 'agent', 700, 'ok');
    r.done('l7', 'Added to your calendar');
    const text = 'Booked: 08:00 Kings Cross → Edinburgh, Fri 17 Oct, coach C seat 42A. £142.40 on Visa 4242. Ref LNER7Q2K9.';
    S.messages.push({ id: rid('msg_'), role: 'assistant', text, channel: 'web', task_id: t.id, at: iso() }); broadcast({ type: 'message', message: S.messages.at(-1) });
    await r.finish('success', text, 'Receipt · LNER booking confirmed');
  });
  return t;
}

function scenarioCode() {
  const now = Date.now(); const ago = 12 * 60e3 + 40e3;
  const t = newTask({ num: 217, title: 'Fix vecgra CI', brief: 'CI is red on vecgra main (run 18842). Fix it and open a PR.', status: 'running', executor: 'codex', machine_id: 'm_code', source: 'schedule', created: now - ago - 400, started: now - ago, steps_estimate: 7, tokens: 164000, time_cap_s: 3600, now: 'Restore ef_search=64 and prove recall is back above 0.90' });
  setMachineTask('m_code', t.id);
  const at = (s) => now - ago + s * 1000;
  const E = (kind, f, actor, s) => addEvent(t, kind, f, actor, at(s));
  E('brief', { text: t.brief, channel: 'github' }, 'you', 0.2);
  E('step', { text: 'Pulled failing run 18842', state: 'done', step_id: 'c1' }, 'agent', 12);
  E('tool', { tool: 'gh.run.view', target: '18842 --log-failed', result: '2 failed', duration_ms: 840, status: 'ok', call_id: 'cc1' }, 'machine', 12);
  E('memory.recall', { query: 'vecgra ci tests', hits: [{ id: 815, score: 0.82, text: 'vecgra recall target is 0.90 at k=10', kind: 'fact', source: 'README spec' }, { id: 816, score: 0.64, text: 'CI flaked on graph tests in August', kind: 'episode', source: 'Run 171' }, { id: 817, score: 0.61, text: 'Run the suite with pytest -q -n 4', kind: 'procedure', source: 'Run 171' }] }, 'memory', 20);
  E('step', { text: 'Reproduced 2 failures locally', state: 'done', step_id: 'c2' }, 'agent', 185);
  E('tool', { tool: 'shell', target: 'pytest -q -n 4', result: '2 failed, 318 passed', duration_ms: 41200, status: 'error', call_id: 'cc2' }, 'machine', 185);
  E('step', { text: 'Found ef_search regression in 3c9e1a', state: 'done', step_id: 'c3' }, 'agent', 468);
  E('tool', { tool: 'git.blame', target: 'vecgra/index/hnsw.py:88', result: '3c9e1a', duration_ms: 90, status: 'ok', call_id: 'cc3' }, 'machine', 468);
  E('step', { text: 'Patched and added a regression test', state: 'done', step_id: 'c4' }, 'agent', 631);
  E('tool', { tool: 'fs.edit', target: 'hnsw.py, test_hnsw.py', result: '+14 −2', duration_ms: 35, status: 'ok', call_id: 'cc4' }, 'machine', 631);
  E('tool', { tool: 'shell', target: 'pytest tests/test_hnsw.py -q', result: '20 passed', duration_ms: 6800, status: 'ok', call_id: 'cc5' }, 'machine', 700);
  E('step', { text: 'Re-running the full test suite', state: 'active', step_id: 'c5' }, 'agent', 722);
  ['Push fix branch and open a PR', 'Report on Telegram'].forEach((x, i) => E('step', { text: x, state: 'pending', step_id: 'c' + (6 + i) }, 'agent', 722));
  t.step = 5;
  const P = `${ANSI.g}ryan@code${ANSI.x}:${ANSI.c}~/vecgra${ANSI.x} (${ANSI.m}fix/ci-recall${ANSI.x})$ `;
  S.terminal.set(t.id, agentdBanner('code', t).replace(/chrome.*\r\n/, 'tmux 3.5 · codex 0.38 · ~/vecgra\r\n') +
    `${P}gh run view 18842 --log-failed | tail -6\r\n` +
    `test (3.12) ${ANSI.r}FAILED${ANSI.x} tests/test_hnsw.py::test_recall_at_10 - AssertionError: recall 0.871 < 0.90\r\n` +
    `test (3.12) ${ANSI.r}FAILED${ANSI.x} tests/test_graph.py::test_edge_merge_idempotent\r\n` +
    `test (3.12) ${ANSI.r}2 failed${ANSI.x}, ${ANSI.g}318 passed${ANSI.x} in 41.2s\r\n` +
    `${P}git log --oneline -3 -- vecgra/index/hnsw.py\r\n${ANSI.y}3c9e1a2${ANSI.x} perf: cheaper default search params\r\n${ANSI.y}a81f0d4${ANSI.x} hnsw: neighbour pruning heuristic\r\n${ANSI.y}77b2c10${ANSI.x} index: persist entry point\r\n` +
    `${P}git diff 3c9e1a2^ 3c9e1a2 -- vecgra/index/hnsw.py | head -8\r\n${ANSI.b}@@ -85,7 +85,7 @@ class HNSW:${ANSI.x}\r\n     def __init__(self, dim, m=16, ef_construction=200,\r\n${ANSI.r}-                 ef_search=64):${ANSI.x}\r\n${ANSI.g}+                 ef_search=16):${ANSI.x}\r\n` +
    `${ANSI.m}codex${ANSI.x} ef_search default dropped 64 → 16 in 3c9e1a; recall@10 falls to 0.871\r\n${ANSI.m}codex${ANSI.x} patch: restore ef_search=64, add regression test for the default\r\n` +
    `${P}pytest tests/test_hnsw.py -q\r\n${ANSI.g}....................${ANSI.x}                                             [100%]\r\n${ANSI.g}20 passed${ANSI.x} in 6.80s\r\n`);
  run(t, async (r) => {
    r.stepN = 5;
    const tests = ['test_graph.py', 'test_hnsw.py', 'test_index_io.py', 'test_merge.py', 'test_query.py', 'test_store.py', 'test_vectors.py', 'test_wal.py'];
    r.term(`${P}pytest -q -n 4\r\n${ANSI.d}bringing up nodes...${ANSI.x}\r\n`);
    const call = rid('c_');
    r.ev('tool', { tool: 'shell', target: 'pytest -q -n 4', result: null, duration_ms: null, status: 'pending', call_id: call }, 'machine');
    let dots = 0;
    for (const f of tests) {
      const n = 20 + Math.floor(Math.random() * 30);
      let line = '';
      for (let i = 0; i < n; i++) { line += '.'; dots++; if (i % 6 === 5) { r.term(`${ANSI.g}${line}${ANSI.x}`); line = ''; await r.sleep(rand(250, 700)); } }
      r.term(`${ANSI.g}${line}${ANSI.x}`);
      r.term(`${' '.repeat(Math.max(1, 58 - (dots % 58)))}${ANSI.d}[${String(Math.round((tests.indexOf(f) + 1) / tests.length * 100)).padStart(3)}%]${ANSI.x}\r\n`);
      await r.sleep(800);
    }
    r.term(`${ANSI.g}${ANSI.b}320 passed${ANSI.x}${ANSI.g} in 43.18s${ANSI.x}\r\n`);
    r.ev('tool', { tool: 'shell', target: 'pytest -q -n 4', result: '320 passed', duration_ms: 43180, status: 'ok', call_id: call }, 'machine');
    r.done('c5', 'Full suite green: 320 passed');
    r.step('Check recall@10 on the benchmark set', 'c5b');
    r.term(`${P}make bench K=10\r\n`);
    await r.sleep(2500);
    r.term(`dataset       n       recall@10  qps\r\nsift-128      1.0M    ${ANSI.g}0.947${ANSI.x}      8,412\r\nglove-100     1.2M    ${ANSI.g}0.921${ANSI.x}      6,905\r\n`);
    await r.tool('shell', 'make bench K=10', 'machine', 1800, 'recall .947 / .921');
    r.done('c5b', 'Recall back to 0.947 / 0.921 (target 0.90)');
    r.step('Push fix branch and open a PR', 'c6');
    r.term(`${P}git push -u origin fix/ci-recall\r\n${ANSI.d}Enumerating objects: 11, done.\r\nWriting objects: 100% (6/6), 1.21 KiB | 1.21 MiB/s, done.${ANSI.x}\r\n`);
    await r.tool('git.push', 'origin fix/ci-recall', 'machine', 1600, 'ok');
    r.term(`${P}gh pr create --fill --label ci\r\n${ANSI.c}https://github.com/ryanfirth/vecgra/pull/231${ANSI.x}\r\n`);
    await r.tool('gh.pr.create', 'fix/ci-recall → main', 'machine', 2100, '#231');
    r.done('c6', 'Opened PR #231');
    r.step('Report on Telegram', 'c7');
    const text = 'vecgra CI is green on fix/ci-recall: ef_search default was dropped to 16 in 3c9e1a. Restored 64, added a regression test. PR #231.';
    S.messages.push({ id: rid('msg_'), role: 'assistant', text, channel: 'telegram', task_id: t.id, at: iso() }); broadcast({ type: 'message', message: S.messages.at(-1) });
    r.done('c7', 'Reported on Telegram');
    r.term(`${P}`);
    await r.finish('success', 'CI fixed: restored ef_search=64, regression test added, PR #231 open.');
  });
  return t;
}

async function seedDone() {
  const now = Date.now(); const H = 3600e3;
  const defs = [
    { num: 210, title: 'Weekly backup of studio', brief: 'weekly: back up studio projects', executor: 'scripted', machine_id: 'm_studio', source: 'schedule', ago: 15.2 * H, dur: 38 * 60e3 + 12e3, site: sites.receipts.backup, outcome: 'success', summary: '612 GB checked, 18.4 GiB new data, snapshot 9ac14d52 saved; pruned 1 old snapshot.', title2: 'restic · snapshot 9ac14d52 saved', url: 'term://studio/restic', tokens: 0, steps: ['Checked the repository', 'Backed up D:\\Projects and D:\\Assets', 'Pruned snapshots older than 8 weeks'] },
    { num: 211, title: 'Hetzner invoices for September', brief: 'download my hetzner invoices for september', executor: 'claude', machine_id: 'm_errands', source: 'telegram', ago: 9.1 * H, dur: 2 * 60e3 + 41e3, site: sites.receipts.hetzner, outcome: 'success', summary: 'Downloaded 2 September invoices (€48.37), saved to Drive › Finance › 2026-09 and forwarded to accounts@.', title2: 'Hetzner · Invoices downloaded', url: 'https://console.hetzner.cloud/billing/invoices', tokens: 31200, steps: ['Recalled the Hetzner how-to', 'Opened Billing › Invoices', 'Downloaded 2 PDFs', 'Saved to Drive and forwarded to accounts@'] },
    { num: 212, title: "Did Sam's parcel arrive?", brief: "check if sam's parcel arrived RM482291057GB", executor: 'claude', machine_id: 'm_errands', source: 'telegram', ago: 6.4 * H, dur: 58e3, site: sites.receipts.royalmail, outcome: 'success', summary: 'Delivered 30 Sep at 11:42, signed for by SAM.', title2: 'Royal Mail · Delivered', url: 'https://www.royalmail.com/track-your-item#/tracking-results/RM482291057GB', tokens: 9800, steps: ['Opened Royal Mail tracking', 'Read the latest status'] },
    { num: 213, title: 'Book a dentist check-up', brief: 'book me a dentist check up next week, mornings', executor: 'claude', machine_id: 'm_errands', source: 'web', ago: 3.3 * H, dur: 4 * 60e3 + 5e3, site: sites.receipts.dentist, outcome: 'partial', summary: 'No morning slots next week. Held Tue 21 Oct 09:40 until 18:00 tomorrow; confirm to book.', title2: 'Leith Walk Dental · 09:40 held', url: 'https://leithwalkdental.co.uk/book', tokens: 41800, steps: ['Opened Leith Walk Dental booking', 'Checked next week: no morning slots', 'Held Tue 21 Oct 09:40', 'Asked you to confirm on Telegram'] },
  ];
  for (const d of defs) {
    const start = now - d.ago;
    const t = newTask({ num: d.num, title: d.title, brief: d.brief, status: 'done', executor: d.executor, machine_id: d.machine_id, source: d.source, created: start - 1200, started: start, tokens: d.tokens, steps_estimate: d.steps.length });
    const E = (kind, f, actor, ms) => addEvent(t, kind, f, actor, start + ms);
    E('brief', { text: d.brief, channel: d.source }, 'you', 300);
    const n = d.steps.length;
    d.steps.forEach((s, i) => {
      const ms = ((i + 1) / (n + 1)) * d.dur;
      E('step', { text: s, state: 'done', step_id: 'd' + i }, 'agent', ms);
      E('tool', { tool: i === 0 ? 'browser.navigate' : i === n - 1 ? 'memory.note' : 'browser.click', target: i === 0 ? d.url : s.toLowerCase(), result: 'ok', duration_ms: Math.round(rand(80, 1400)), status: 'ok', call_id: rid('c_') }, i === n - 1 ? 'memory' : 'browser', ms + 400);
    });
    let a = null;
    if (browser) {
      const page = await browser.newPage({ viewport: { width: VW, height: VH } });
      await page.setContent(d.site);
      const buf = await page.screenshot({ type: 'jpeg', quality: 85 });
      await page.close();
      a = storeArtifact(buf);
      E('keyframe', { artifact: a, url: d.url, title: d.title2 }, 'browser', d.dur - 2000);
      S.frames.get(t.id).push({ ms: d.dur - 2000, artifact: a });
    }
    E('done', { outcome: d.outcome, summary: d.summary, receipt_artifact: a }, 'agent', d.dur);
    Object.assign(t, { outcome: d.outcome, summary: d.summary, receipt_artifact: a, last_frame_artifact: a, ended_at: iso(start + d.dur), now: d.summary, step: n });
    S.terminal.set(t.id, agentdBanner(machineName(d.machine_id), t) + `${ANSI.d}run finished · ${d.outcome}${ANSI.x}\r\n`);
    if (d.spend) t.spend_p = d.spend;
    S.messages.push({ id: rid('msg_'), role: 'user', text: d.brief, channel: d.source === 'web' ? 'web' : 'telegram', task_id: null, at: iso(start - 1500) });
    S.messages.push({ id: rid('msg_'), role: 'assistant', text: d.summary, channel: d.source === 'web' ? 'web' : 'telegram', task_id: t.id, at: iso(start + d.dur + 1000) });
  }
}

// generic follow-up runs so the desk stays alive
const GENERIC = [
  { brief: 'find a 27" 4K monitor under £300 with USB-C', title: '27" 4K monitor under £300', q: '27 inch 4k monitor usb-c under £300 review', results: [['rtings.com › monitor › reviews', 'The 5 Best 4K Monitors Under £300 - Autumn 2026', 'We tested 38 monitors. The Dell S2725QC is our pick for USB-C with 65 W charging…'], ['johnlewis.com › dell-s2725qc', 'Dell S2725QC 27" 4K USB-C Monitor, £279', '4.6 ★ (212) · Free delivery · In stock at Edinburgh St James'], ['reddit.com › r/monitors', 'S2725QC vs LG 27UP650 for a MacBook?', '"The Dell has USB-C power delivery, the LG does not…"']], title3: 'Dell S2725QC review: the USB-C one to get', by: 'rtings.com · updated 12 Sep 2026', body: '<p>The Dell S2725QC is a 27-inch 4K IPS monitor with a USB-C port that delivers 65 W, so one cable charges and drives a laptop.</p><table><tr><th>Model</th><th>Price</th><th>USB-C</th><th>Score</th></tr><tr><td>Dell S2725QC</td><td>£279</td><td>65 W</td><td>8.1</td></tr><tr><td>LG 27UP650</td><td>£249</td><td>None</td><td>7.6</td></tr><tr><td>ASUS PA279CRV</td><td>£329</td><td>96 W</td><td>8.4</td></tr></table>', summary: 'Best fit: Dell S2725QC, £279 at John Lewis (65 W USB-C, 8.1/10 on rtings). LG 27UP650 is £249 but has no USB-C.' },
  { brief: 'when does the leith sainsburys close on sunday', title: 'Sainsbury\'s Leith Sunday hours', q: 'sainsburys leith opening hours sunday', results: [['stores.sainsburys.co.uk › leith', 'Sainsbury\'s Leith Superstore · Opening times', 'Sunday 09:00 – 18:00 · Mon–Sat 07:00 – 22:00'], ['google.com › maps', 'Sainsbury\'s, Leith Walk, Edinburgh EH6', '4.1 ★ · Supermarket'], ['sainsburys.co.uk › help', 'Store opening times over holidays', 'Check your local store for changes…']], title3: 'Sainsbury\'s Leith Superstore', by: 'stores.sainsburys.co.uk', body: '<table><tr><th>Day</th><th>Hours</th></tr><tr><td>Monday – Saturday</td><td>07:00 – 22:00</td></tr><tr><td>Sunday</td><td>09:00 – 18:00</td></tr></table><p>Browsing from 09:00, tills open 10:00 – 16:00 by law, click and collect 09:00 – 18:00.</p>', summary: 'Sainsbury\'s Leith closes at 18:00 on Sunday (opens 09:00, tills from 10:00).' },
];

function spawnNext(brief, executor, source = 'telegram') {
  const g = brief ? { ...GENERIC[S.spawnIdx++ % GENERIC.length], brief, title: titleOf(brief) } : GENERIC[S.spawnIdx++ % GENERIC.length];
  let m = [...S.machines.values()].find((x) => x.status === 'online' && !x.task_id && x.backend !== 'ssh' && x.id !== 'm_code');
  const t = newTask({ title: g.title, brief: g.brief, status: 'queued', executor: executor || S.settings.default_executor, machine_id: m?.id || null, source, created: Date.now(), steps_estimate: 5, now: 'Picking a machine' });
  pushTask(t);
  if (!brief) { S.messages.push({ id: rid('msg_'), role: 'user', text: g.brief, channel: 'telegram', task_id: null, at: iso() }); broadcast({ type: 'message', message: S.messages.at(-1) }); }
  run(t, async (r) => {
    if (!m) {
      await r.sleep(800);
      m = forkMachine('m_errands');
      r.upd({ machine_id: m.id });
      r.ev('machine', { text: `No free machine: forked errands → ${m.name} from its last snapshot` }, 'machine');
      await r.sleep(2500);
    }
    setMachineTask(m.id, t.id);
    r.upd({ status: 'starting', machine_id: m.id, started_at: iso(), now: `Waking ${m.name}` });
    r.ev('brief', { text: g.brief, channel: source }, 'you');
    r.term(agentdBanner(m.name, t));
    await r.sleep(1800);
    r.upd({ status: 'running' });
    r.plan([['g2', 'Search the web'], ['g3', 'Read the best source'], ['g4', 'Report back']]);
    r.step('Check memory for anything relevant', 'g1');
    await r.tool('memory.search', `"${g.title.toLowerCase()}" k=8`, 'memory', 700, '1 hit (.58)');
    r.ev('memory.recall', { query: g.title.toLowerCase(), hits: [{ id: 828, score: 0.58, text: 'Prefers buying from John Lewis over Amazon for electronics', kind: 'preference', source: 'Ryan, Jun' }] }, 'memory');
    r.done('g1', 'Recalled 1 memory');
    r.step('Search the web', 'g2');
    await openSite(t, sites.generic, 'results', { q: g.q, results: [] });
    await r.tool('browser.navigate', `https://search.example/?q=${encodeURIComponent(g.q)}`, 'browser', 900, '200');
    await show(t, 'results', { q: g.q, results: g.results }); S.pages.get(t.id).url = `https://search.example/?q=${encodeURIComponent(g.q)}`;
    await r.keyframe(`Search · ${g.q}`, S.pages.get(t.id).url);
    await r.sleep(3500);
    await focusEl(t, '#r0', 'read · result 1', true);
    await r.tool('browser.snapshot', 'results list', 'browser', 190, '3 results');
    await r.sleep(3000);
    r.done('g2', 'Searched: 3 useful results');
    r.step('Read the best source', 'g3');
    await focusEl(t, '#r0 a', 'click · result 1');
    await r.sleep(1500);
    await r.tool('browser.click', 'link "' + g.results[0][1].slice(0, 32) + '…"', 'browser', 420, 'nav');
    await show(t, 'article', { q: g.q, title: g.title3, by: g.by, body: g.body }); S.pages.get(t.id).url = 'https://' + g.results[0][0].split(' ')[0];
    await r.keyframe(g.title3, S.pages.get(t.id).url);
    await focusEl(t, '#art', 'reading', true);
    await r.tool('browser.snapshot', 'article', 'browser', 260, '1,204 words');
    await r.sleep(6000);
    r.done('g3', 'Read ' + g.results[0][0].split(' ')[0]);
    r.step('Report back', 'g4');
    r.ev('message', { text: g.summary }, 'agent');
    S.messages.push({ id: rid('msg_'), role: 'assistant', text: g.summary, channel: source === 'web' ? 'web' : 'telegram', task_id: t.id, at: iso() }); broadcast({ type: 'message', message: S.messages.at(-1) });
    r.done('g4', 'Reported back');
    await r.finish('success', g.summary);
    await delay(8000 / SPEED); await closeSite(t);
    if (!brief && r.gen === GEN) { await delay(40000 / SPEED); if (r.gen === GEN) spawnNext(); }
  });
  return t;
}

let forkN = 2;
function forkMachine(of) {
  const p = S.machines.get(of);
  const m = { ...structuredClone(p), id: rid('m_'), name: `${p.name}-${forkN++}`, backend: 'docker', parent: of, status: 'online', task_id: null, stats: { cpu_pct: 20, mem_gb: 0.9, net_mbs: 1, uptime_s: 0 }, last_backup_at: null };
  S.machines.set(m.id, m); pushMachine(m); return m;
}

function titleOf(brief) {
  let s = brief.trim().replace(/\s+/g, ' ').replace(/^(please|can you|could you|pls)\s+/i, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > 44 ? s.slice(0, 42).replace(/\s\S*$/, '') + '…' : s;
}

// ------------------------------------------------------------------ boot / reset
async function boot() {
  GEN++;
  for (const e of S?.pages?.values?.() || []) { try { await e.page.close(); } catch {} }
  S = freshWorld();
  seedMachines();
  seedMemory();
  if (!EMPTY) {
    await ensureBrowser();
    await seedDone();
    scenarioCode();
    scenarioLner();
    scenarioBlender();
    scenarioMeshy();
  }
  S.messages.sort((a, b) => a.at.localeCompare(b.at));
  broadcast({ type: 'hello', state: stateOut() });
}

// ------------------------------------------------------------------ HTTP
function authed(req, url) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  if (h === `Bearer ${TOKEN}`) return true;
  const ck = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('familiar_token='));
  if (ck && decodeURIComponent(ck.split('=')[1]) === TOKEN) return true;
  return url.searchParams.get('token') === TOKEN;
}

function body(req) {
  return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } }); });
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }

function searchAll(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const score = (text) => { const s = (text || '').toLowerCase(); const hit = terms.filter((t) => s.includes(t)).length; return hit ? hit / terms.length : 0; };
  const out = [];
  for (const t of S.tasks.values()) { const sc = score(`${t.num} ${t.title} ${t.brief} ${t.summary || ''}`); if (sc) out.push({ type: 'task', id: t.id, task_id: t.id, text: `${t.title}${t.summary ? ' · ' + t.summary : ''}`, score: sc + 0.2, at: t.created_at }); }
  for (const [, evs] of S.events) for (const e of evs) {
    if (e.kind === 'keyframe') { const sc = score(`${e.title} ${e.url}`); if (sc) out.push({ type: 'keyframe', id: String(e.id), task_id: e.task_id, text: e.title + (e.url ? ' · ' + e.url : ''), score: sc + 0.1, at: e.at, artifact: e.artifact }); continue; }
    if (e.kind === 'tool' && e.status === 'pending') continue;
    const txt = e.text || e.question || e.description || e.summary || e.query || (e.tool ? `${e.tool} ${e.target} → ${e.result}` : '');
    const sc = score(txt); if (sc) out.push({ type: 'event', id: String(e.id), task_id: e.task_id, text: txt, score: sc, at: e.at });
  }
  for (const c of S.claims) { if (c.state === 'forgotten') continue; const sc = score(`${c.subject} ${c.text}`); if (sc) out.push({ type: 'claim', id: String(c.id), text: c.text, score: sc + 0.15, at: c.created_at }); }
  for (const m of S.messages) { const sc = score(m.text); if (sc) out.push({ type: 'message', id: m.id, task_id: m.task_id || undefined, text: m.text, score: sc, at: m.at }); }
  out.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  return out.slice(0, 40);
}

async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const m = req.method;
  let mm;
  if (m === 'GET' && p === '/state') return json(res, 200, stateOut());
  if (m === 'POST' && p === '/_mock/reset') { await boot(); return json(res, 200, { ok: true }); }
  if (m === 'GET' && (mm = p.match(/^\/_mock\/desktop\/(\w+)$/))) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(sites.desktopPage(mm[1])); }
  if (m === 'GET' && p === '/_mock/desktop-frame') {
    const t = [...S.tasks.values()].find((x) => x.machine_id === 'm_studio' && S.pages.has(x.id));
    const e = t && S.pages.get(t.id);
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(sites.blender.replace('show(\'pick\');', e ? `show(${JSON.stringify(e.state)},${JSON.stringify(e.data || null)});setTimeout(()=>location.reload(),3000);` : "show('pick');"));
  }
  if (m === 'GET' && (mm = p.match(/^\/tasks\/([\w-]+)$/))) { const t = S.tasks.get(mm[1]); if (!t) return json(res, 404, { error: 'not found' }); return json(res, 200, { task: taskOut(t), events: S.events.get(t.id) || [] }); }
  if (m === 'GET' && (mm = p.match(/^\/tasks\/([\w-]+)\/terminal$/))) { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(S.terminal.get(mm[1]) || ''); }
  if (m === 'GET' && (mm = p.match(/^\/tasks\/([\w-]+)\/frames$/))) return json(res, 200, S.frames.get(mm[1]) || []);
  if (m === 'GET' && (mm = p.match(/^\/artifacts\/([\w-]+)$/))) { const a = artifacts.get(mm[1]); if (!a) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': a.type, 'cache-control': 'public, max-age=31536000, immutable' }); return res.end(a.buf); }
  if (m === 'POST' && p === '/messages') {
    const b = await body(req);
    const text = String(b.text || '').trim(); if (!text) return json(res, 400, { error: 'text required' });
    const msg = { id: rid('msg_'), role: 'user', text, channel: 'web', task_id: null, at: iso() };
    S.messages.push(msg); broadcast({ type: 'message', message: msg });
    json(res, 200, { message: msg });
    broadcast({ type: 'typing', on: true });
    await delay(1400);
    const q = /^(what|when|where|who|how|which|do i|did i|is|are)\b|\?$/i.test(text);
    let reply;
    if (q) {
      const hits = searchAll(text).filter((h) => h.type === 'claim').slice(0, 2);
      reply = { text: hits.length ? `From memory: ${hits.map((h) => h.text).join('; ')}.` : "I don't have that in memory yet. Want me to look it up? Say “look it up” and I'll start a run.", task_id: null };
    } else {
      const t = spawnNext(text, b.executor || null, 'web');
      reply = { text: `On it: run ${t.num} · ${t.title}. ${t.machine_id ? `Using ${machineName(t.machine_id)}.` : 'Forking a machine for it.'} I'll ask before spending over ${gbp(S.settings.approval_threshold_p, true)}.`, task_id: t.id };
    }
    broadcast({ type: 'typing', on: false });
    const am = { id: rid('msg_'), role: 'assistant', text: reply.text, channel: 'web', task_id: reply.task_id, at: iso() };
    S.messages.push(am); broadcast({ type: 'message', message: am });
    return;
  }
  if (m === 'POST' && p === '/answer') {
    const b = await body(req);
    const n = S.needs.find((x) => x.id === b.question_id);
    if (!n) return json(res, 404, { error: 'no such question' });
    const opt = n.options.find((o) => o.id === b.answer);
    const label = opt?.label || (b.text ? `“${b.text}”` : b.answer);
    S.needs = S.needs.filter((x) => x.id !== b.question_id); pushNeeds();
    const t = S.tasks.get(n.task_id);
    if (t) addEvent(t, 'answer', { question_id: n.id, answer: b.answer, label, by: 'you', text: b.text || undefined }, 'you');
    const fn = S.answers.get(n.id); S.answers.delete(n.id);
    fn?.({ answer: b.answer, text: b.text });
    pushStats();
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/tasks') { const b = await body(req); if (!b.brief) return json(res, 400, { error: 'brief required' }); const t = spawnNext(String(b.brief), b.executor, 'web'); return json(res, 200, { task: taskOut(t) }); }
  if (m === 'POST' && (mm = p.match(/^\/tasks\/([\w-]+)\/cancel$/))) { const t = S.tasks.get(mm[1]); if (!t) return json(res, 404, {}); if (!['done', 'failed', 'cancelled'].includes(t.status)) cancelTask(t); return json(res, 200, { task: taskOut(t) }); }
  if (m === 'POST' && (mm = p.match(/^\/tasks\/([\w-]+)\/control$/))) {
    const t = S.tasks.get(mm[1]); if (!t) return json(res, 404, {});
    const b = await body(req);
    if (b.action === 'take' && !t.control) {
      t.control = 'you'; addEvent(t, 'control', { state: 'taken', note: b.note || `you have ${machineName(t.machine_id)}` }, 'you');
      const e = S.pages.get(t.id); if (e) { try { await e.page.evaluate(() => window.__fam.clear()); } catch {} }
    } else if (b.action === 'release' && t.control) {
      t.control = null; addEvent(t, 'control', { state: 'released', note: b.note || `${t.executor === 'codex' ? 'Codex' : 'Claude'} resumes` }, 'you');
      const e = S.pages.get(t.id);
      if (e && e.navigated) { try { await e.page.setContent(e.html); await show(t, e.state, e.data); } catch {} e.navigated = false; }
    }
    pushTask(t); return json(res, 200, { task: taskOut(t) });
  }
  if (m === 'POST' && p === '/kill') {
    let cancelled = 0, stopped = 0;
    for (const t of S.tasks.values()) if (!['done', 'failed', 'cancelled'].includes(t.status)) { cancelTask(t, 'Stopped by the kill switch'); cancelled++; }
    for (const mc of S.machines.values()) if (mc.status !== 'offline' && mc.status !== 'sleeping') { mc.status = 'offline'; mc.task_id = null; pushMachine(mc); stopped++; }
    return json(res, 200, { cancelled, machines_stopped: stopped });
  }
  if (m === 'GET' && p === '/memory') {
    const q = (url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const kind = url.searchParams.get('kind'); const state = url.searchParams.get('state');
    const claims = S.claims.filter((c) => (!kind || c.kind === kind) && (!state || c.state === state) && q.every((w) => `${c.subject} ${c.text} ${c.source?.label || ''}`.toLowerCase().includes(w)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return json(res, 200, { claims, stats: { nodes: 18204 + S.claims.length * 3, edges: 52877 + S.claims.length * 7, vectors: 18190 + S.claims.length, claims: S.claims.length } });
  }
  if (m === 'GET' && (mm = p.match(/^\/memory\/(\d+)$/))) {
    const c = S.claims.find((x) => x.id === +mm[1]); if (!c) return json(res, 404, {});
    const history = [];
    let prev = S.claims.find((x) => x.superseded_by === c.id);
    while (prev) { history.push(prev); const pid = prev.id; prev = S.claims.find((x) => x.superseded_by === pid); }
    let next = c.superseded_by ? S.claims.find((x) => x.id === c.superseded_by) : null;
    const newer = []; while (next) { newer.push(next); next = next.superseded_by ? S.claims.find((x) => x.id === next.superseded_by) : null; }
    const evidence = [];
    const words = c.subject ? [c.subject] : [];
    for (const [, evs] of S.events) for (const e of evs) {
      if ((e.kind === 'memory.write' && e.claim_id === c.id) || (e.kind === 'memory.recall' && e.hits?.some((h) => h.id === c.id))) evidence.push(e);
    }
    for (const msg of S.messages) if (words.some((w) => msg.text.toLowerCase().includes(w))) evidence.push(msg);
    return json(res, 200, { claim: c, evidence: evidence.slice(-8), history: [...newer.reverse(), ...history] });
  }
  if (m === 'POST' && (mm = p.match(/^\/memory\/(\d+)\/forget$/))) { const c = S.claims.find((x) => x.id === +mm[1]); if (!c) return json(res, 404, {}); c.state = 'forgotten'; return json(res, 200, { claim: c }); }
  if (m === 'POST' && (mm = p.match(/^\/memory\/(\d+)\/correct$/))) {
    const b = await body(req); const c = S.claims.find((x) => x.id === +mm[1]); if (!c || !b.text) return json(res, 400, {});
    const n = supersede(c.id, { kind: c.kind, subject: c.subject, text: String(b.text), confidence: 1, salience: c.salience, source: { label: 'Ryan, correction just now' } });
    return json(res, 200, { claim: n });
  }
  if (m === 'GET' && p === '/search') return json(res, 200, { results: searchAll(url.searchParams.get('q') || '') });
  if (m === 'POST' && (mm = p.match(/^\/machines\/([\w-]+)\/backup$/))) {
    const mc = S.machines.get(mm[1]); if (!mc) return json(res, 404, {});
    const prev = mc.status; mc.status = 'busy'; pushMachine(mc);
    setTimeout(() => { mc.status = mc.task_id ? 'busy' : prev === 'busy' ? 'online' : prev; mc.last_backup_at = iso(); pushMachine(mc); const t = mc.task_id && S.tasks.get(mc.task_id); if (t) addEvent(t, 'machine', { text: `Backed up ${mc.name}` }, 'machine'); }, 2500 / SPEED);
    return json(res, 200, { machine: mc });
  }
  if (m === 'POST' && (mm = p.match(/^\/machines\/([\w-]+)\/stop$/))) {
    const mc = S.machines.get(mm[1]); if (!mc) return json(res, 404, {});
    const t = mc.task_id && S.tasks.get(mc.task_id); if (t && !['done', 'failed', 'cancelled'].includes(t.status)) cancelTask(t, `Stopped with ${mc.name}`);
    mc.status = 'sleeping'; mc.task_id = null; pushMachine(mc); return json(res, 200, { machine: mc });
  }
  if (m === 'POST' && p === '/machines') {
    const b = await body(req);
    let mc;
    if (b.fork_of && S.machines.get(b.fork_of)) mc = forkMachine(b.fork_of);
    else if (b.id && S.machines.get(b.id)) { mc = S.machines.get(b.id); mc.status = 'online'; mc.stats.uptime_s = 0; pushMachine(mc); }
    else { mc = { id: rid('m_'), name: `box-${forkN++}`, backend: b.backend || 'docker', status: 'online', parent: null, specs: { cpu: 2, mem_gb: 4, disk_gb: 20 }, stats: { cpu_pct: 10, mem_gb: 0.6, net_mbs: 0.2, uptime_s: 0 }, task_id: null, has_desktop: false, desktop_url: null, last_backup_at: null, installs: ['agentd 0.4.2', 'chrome 141'] }; S.machines.set(mc.id, mc); pushMachine(mc); }
    return json(res, 200, { machine: mc });
  }
  if (p === '/settings' && m === 'GET') return json(res, 200, S.settings);
  if (p === '/settings' && m === 'PUT') {
    const b = await body(req);
    for (const k of ['approval_threshold_p', 'default_executor', 'no_ask_merchants']) if (b[k] !== undefined) S.settings[k] = b[k];
    broadcast({ type: 'hello', state: stateOut() });
    return json(res, 200, S.settings);
  }
  json(res, 404, { error: 'not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(req, res, url) {
  if (!fs.existsSync(DIST)) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Familiar mock API on :' + PORT + '. Run `npm run dev` for the Desk (or `npm run build` to serve dist/ here).'); }
  let f = path.join(DIST, decodeURIComponent(url.pathname));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  if (!url.pathname.startsWith('/api/_mock/desktop') && !authed(req, url)) return json(res, 401, { error: 'unauthorised' });
  try { await handleApi(req, res, url); } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: String(e) }); }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/api/stream' || !authed(req, url)) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => {
    const c = { ws, sub: null, shell: '' };
    clients.add(c);
    ws.send(JSON.stringify({ type: 'hello', state: stateOut() }));
    ws.on('close', () => clients.delete(c));
    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'subscribe') { c.sub = msg.task_id || null; return; }
      if (msg.type === 'input') {
        const t = S.tasks.get(msg.task_id); if (!t || t.control !== 'you') return;
        const i = msg.input || {}; const e = S.pages.get(t.id);
        try {
          if (i.kind === 'mouse' && e) {
            if (i.action === 'move') { await e.page.mouse.move(i.x, i.y); await e.page.evaluate(([x, y]) => window.__fam?.you(x, y), [i.x, i.y]); }
            else if (i.action === 'down') await e.page.mouse.down({ button: i.button || 'left' });
            else if (i.action === 'up') await e.page.mouse.up({ button: i.button || 'left' });
            else if (i.action === 'click') { await e.page.mouse.click(i.x, i.y, { button: i.button || 'left' }); await e.page.evaluate(([x, y]) => window.__fam?.you(x, y), [i.x, i.y]); }
            else if (i.action === 'wheel') await e.page.mouse.wheel(i.dx || 0, i.dy || 0);
          } else if (i.kind === 'key' && e) {
            if (i.action === 'type' && i.text) await e.page.keyboard.type(i.text);
            else if (i.key) await e.page.keyboard.press(i.key);
          } else if (i.kind === 'navigate' && e) {
            e.navigated = true; e.url = i.url;
            await e.page.goto(i.url, { timeout: 8000 }).catch(async () => { await e.page.setContent(sites.generic); await e.page.evaluate((u) => window.show('results', { q: u, results: [['offline', 'This mock machine has no internet', 'The page you asked for would load here on a real machine.']] }), i.url); });
            addEvent(t, 'tool', { tool: 'browser.navigate', target: i.url, result: 'by you', duration_ms: null, status: 'ok', call_id: rid('c_') }, 'you');
          } else if (i.kind === 'terminal') {
            // tiny fake shell so typing feels real
            let out = '';
            for (const ch of String(i.data || '')) {
              if (ch === '\r') { const cmd = c.shell.trim(); c.shell = ''; out += '\r\n' + (cmd ? fakeShell(cmd) : '') + '\x1b[32mryan@' + machineName(t.machine_id) + '\x1b[0m$ '; }
              else if (ch === '\x7f') { if (c.shell) { c.shell = c.shell.slice(0, -1); out += '\b \b'; } }
              else if (ch >= ' ') { c.shell += ch; out += ch; }
            }
            if (out) termWrite(t, out);
          }
        } catch (err) { console.warn('[mock] input', err.message); }
      }
    });
  });
});

function fakeShell(cmd) {
  if (cmd === 'ls') return 'README.md  pyproject.toml  tests  vecgra\r\n';
  if (cmd.startsWith('git status')) return 'On branch fix/ci-recall\r\nnothing to commit, working tree clean\r\n';
  if (cmd === 'whoami') return 'ryan\r\n';
  if (cmd === 'uptime') return ' 21:14:02 up 12 min,  1 user,  load average: 1.42, 1.10, 0.66\r\n';
  return `${cmd.split(' ')[0]}: (mock machine) ran ok\r\n`;
}

await boot();
frameLoop();
machineLoop();
server.listen(PORT, '127.0.0.1', () => console.log(`[mock] Familiar mock server on http://127.0.0.1:${PORT}  (${EMPTY ? 'empty' : 'demo'} scenario, speed ×${SPEED}${TOKEN ? ', token required' : ''})`));
