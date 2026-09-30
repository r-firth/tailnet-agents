#!/usr/bin/env node
// End-to-end check with no secrets: a fake Telegram Bot API, the real server,
// a real agentd machine (local backend) and the scripted executor driving a
// real Chromium against the demo site.
//
//   node scripts/e2e.mjs            (builds nothing; run `make build` first)
//
// Exits non-zero on the first failed expectation.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const port = 4455;
const tgPort = 4456;
const base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'familiar-e2e-'));
const RYAN = 424242;
const log = (...a) => console.log('·', ...a);
let failures = 0;
const expect = (cond, what) => {
  if (cond) console.log('  ✓', what);
  else { console.log('  ✗', what); failures++; }
};

// ---------- fake Telegram ----------
const tg = { updates: [], sent: [], edits: [], photos: [], callbacks: [], nextId: 100, updateId: 1 };
const tgServer = http.createServer((req, res) => {
  const method = req.url.split('/').pop().split('?')[0];
  let body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(body);
    let json = {};
    try { json = JSON.parse(raw.toString() || '{}'); } catch { /* multipart */ }
    const ok = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
    switch (method) {
      case 'getUpdates': {
        const offset = json.offset || 0;
        const deadline = Date.now() + 1000;
        while (!tg.updates.some((u) => u.update_id >= offset) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        // Like Telegram: asking with an offset confirms (drops) everything before it.
        tg.updates = tg.updates.filter((u) => u.update_id >= offset);
        return ok(tg.updates);
      }
      case 'sendMessage': { const m = { message_id: tg.nextId++, chat: { id: json.chat_id }, text: json.text, reply_markup: json.reply_markup }; tg.sent.push(m); return ok(m); }
      case 'editMessageText': tg.edits.push(json); return ok(true);
      case 'editMessageReplyMarkup': return ok(true);
      case 'sendPhoto': tg.photos.push({ bytes: raw.length }); return ok({ message_id: tg.nextId++ });
      case 'answerCallbackQuery': tg.callbacks.push(json); return ok(true);
      case 'sendChatAction': return ok(true);
      default: return ok(true);
    }
  });
});
const tgSay = (text) => tg.updates.push({ update_id: tg.updateId++, message: { message_id: tg.nextId++, from: { id: RYAN }, chat: { id: RYAN, type: 'private' }, text } });
const tgPress = (data) => tg.updates.push({ update_id: tg.updateId++, callback_query: { id: String(tg.nextId++), from: { id: RYAN }, data } });

// ---------- helpers ----------
const api = async (p, opts = {}) => {
  const r = await fetch(base + p, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
};
const until = async (what, fn, ms = 90000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const state = () => api('/api/state');
const taskByTitle = async (re) => (await state()).tasks.find((t) => re.test(t.title));

let server;
const startServer = () => {
  server = spawn(path.join(root, 'target/debug/familiar'), ['--env', '/nonexistent'], {
    cwd: root,
    env: {
      ...process.env,
      FAMILIAR_PORT: String(port),
      FAMILIAR_DATA_DIR: dataDir,
      FAMILIAR_DEMO: '1',
      FAMILIAR_COORDINATOR: 'mock',
      FAMILIAR_EMBEDDER: 'hash',
      OPENROUTER_API_KEY: '',
      FAMILIAR_SCRIPT_SPEED: process.env.FAMILIAR_SCRIPT_SPEED || '6',
      TELEGRAM_BOT_TOKEN: 'TEST',
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
      TELEGRAM_ALLOWED_USERS: String(RYAN),
      FAMILIAR_MACHINE_NAME: 'errands',
    },
    stdio: ['ignore', fs.openSync(path.join(dataDir, 'server.log'), 'a'), fs.openSync(path.join(dataDir, 'server.log'), 'a')],
  });
};

async function main() {
  await new Promise((r) => tgServer.listen(tgPort, '127.0.0.1', r));
  startServer();
  await until('server', () => fetch(base + '/api/health').then((r) => r.ok).catch(() => false), 20000);
  log('server up, data in', dataDir);
  await until('personal machine online', async () => (await state()).machines.some((m) => m.id === 'm_errands' && m.status === 'online'), 60000);
  log('machine errands online');

  // 1. Memory from Telegram.
  tgSay('remember that my Polyform plan is Pro at £16 a month on Visa 4242');
  await until('memory reply', () => tg.sent.some((m) => /remember/i.test(m.text)));
  expect((await api('/api/memory')).claims.some((c) => /Polyform plan is Pro/.test(c.text)), 'Telegram "remember that…" becomes a claim');

  // 2. Errand from Telegram, runs to completion with receipt.
  tgSay('cancel my polyform sub');
  const cancel = await until('cancel task', () => taskByTitle(/polyform/i));
  log(`task #${cancel.num} ${cancel.title}`);
  await until('cancel task done', async () => ['done', 'failed'].includes((await api(`/api/tasks/${cancel.id}`)).task.status), 180000);
  const detail = await api(`/api/tasks/${cancel.id}`);
  expect(detail.task.status === 'done', `task finished as done (${detail.task.status}: ${detail.task.summary})`);
  expect(detail.events.some((e) => e.kind === 'keyframe' && e.artifact), 'keyframes stored as artifacts');
  expect(detail.events.some((e) => e.kind === 'tool' && /browser\./.test(e.tool)), 'browser actions logged');
  expect(detail.events.some((e) => e.kind === 'memory.recall'), 'memory recalled at start');
  expect(!!detail.task.receipt_artifact, 'receipt screenshot saved');
  const receipt = await fetch(`${base}/api/artifacts/${detail.task.receipt_artifact}`);
  expect(receipt.ok && (await receipt.arrayBuffer()).byteLength > 5000, 'receipt image served');
  expect((await api(`/api/tasks/${cancel.id}/frames`)).length > 0, 'replay frames recorded');
  await until('telegram status edits', () => tg.edits.some((e) => /✅/.test(e.text)), 20000).catch(() => {});
  expect(tg.edits.some((e) => /✅/.test(e.text)), 'Telegram status message edited to done');
  expect(tg.photos.length > 0, 'Telegram receipt photo sent');
  await until('learned memory', async () => (await api('/api/memory')).claims.some((c) => c.kind === 'procedure'), 20000).catch(() => {});
  const mem = (await api('/api/memory')).claims;
  expect(mem.some((c) => c.kind === 'procedure'), 'procedure learned');
  expect(mem.some((c) => c.kind === 'episode'), 'episode written');
  const withSupersede = mem.find((c) => c.supersedes);
  log(withSupersede ? `supersession: ${withSupersede.text}` : 'no supersession this run');

  // 3. Approval over £100 from Telegram buttons.
  tgSay('book me the train to edinburgh and pay for it');
  const book = await until('booking task', () => taskByTitle(/train|edinburgh|book/i));
  const approval = await until('approval asked', async () => (await state()).needs_you.find((n) => n.kind === 'approval' && n.task_id === book.id), 120000);
  expect(/Pay £/.test(approval.title), `approval asked: ${approval.title}`);
  const tgAsk = await until('telegram approval buttons', () => tg.sent.find((m) => m.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data?.startsWith(`a|${approval.id}|`))));
  expect(!!tgAsk, 'Telegram approval has buttons');
  tgPress(`a|${approval.id}|approve`);
  await until('booking done', async () => ['done', 'failed'].includes((await api(`/api/tasks/${book.id}`)).task.status), 180000);
  const bookDone = (await api(`/api/tasks/${book.id}`)).task;
  expect(bookDone.status === 'done', `booking done after approval (${bookDone.summary})`);
  expect(bookDone.spend_p > 10000, `spend recorded (${bookDone.spend_p}p)`);

  // 4. Question from the web UI path, and the terminal log.
  await api('/api/messages', { method: 'POST', body: { text: 'install blender on my machine' } });
  const install = await until('install task', () => taskByTitle(/blender/i));
  const q = await until('question asked', async () => (await state()).needs_you.find((n) => n.task_id === install.id), 120000);
  expect(q.options.length >= 2, `question has options: ${q.title}`);
  await api('/api/answer', { method: 'POST', body: { question_id: q.id, answer: q.options[0].id } });
  await until('install done', async () => ['done', 'failed'].includes((await api(`/api/tasks/${install.id}`)).task.status), 180000);
  expect((await api(`/api/tasks/${install.id}`)).task.status === 'done', 'install finished');
  const term = await api(`/api/tasks/${install.id}/terminal`);
  expect(typeof term === 'string' && term.length > 50, `terminal log captured (${term.length} bytes)`);
  const machine = (await state()).machines.find((m) => m.id === 'm_errands');
  expect(machine.installs.some((i) => /blender/i.test(i)), `install recorded on machine: ${machine.installs.join(', ')}`);
  expect(!!machine.last_backup_at, 'machine backed up after tasks');

  // 5. Search across everything.
  const found = await api('/api/search?q=polyform%20billing');
  expect(found.results.length > 0, `search finds ${found.results.length} results`);

  // 6. Take control and cancel.
  await api('/api/messages', { method: 'POST', body: { text: 'check my polyform invoices' } });
  const check = await until('check task', () => taskByTitle(/invoices/i));
  await until('check running', async () => (await api(`/api/tasks/${check.id}`)).task.status === 'running', 60000);
  const taken = await api(`/api/tasks/${check.id}/control`, { method: 'POST', body: { action: 'take' } });
  expect(taken.task.control === 'you', 'take control');
  await api(`/api/tasks/${check.id}/control`, { method: 'POST', body: { action: 'release', note: 'scrolled a bit' } });
  const cancelled = await api(`/api/tasks/${check.id}/cancel`, { method: 'POST' });
  expect(cancelled.task.status === 'cancelled', 'cancel works');

  // 7. Restart keeps everything (Vecgra is the store).
  const before = await state();
  server.kill('SIGINT');
  await new Promise((r) => server.on('exit', r));
  startServer();
  await until('server again', () => fetch(base + '/api/health').then((r) => r.ok).catch(() => false), 20000);
  const after = await state();
  expect(after.tasks.length === before.tasks.length, `tasks survive restart (${after.tasks.length})`);
  expect(after.stats.claims === before.stats.claims, `memory survives restart (${after.stats.claims} claims)`);
  expect((await api(`/api/tasks/${cancel.id}`)).events.length === detail.events.length, 'timeline survives restart');

  server.kill('SIGINT');
  await new Promise((r) => server.on('exit', r));
  tgServer.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.error('server log:', path.join(dataDir, 'server.log'));
  server?.kill('SIGINT');
  process.exit(1);
});
