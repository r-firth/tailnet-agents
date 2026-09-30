#!/usr/bin/env node
// Screenshots of the Desk against the real server in demo mode (scripted
// executor, real Chromium, built-in coordinator). Build first (`./scripts/setup.sh`
// or `cd web && npm run build` after UI changes).
//
//   node scripts/screens.mjs [out-dir]      default: docs/screenshots
//
// Captures, in dark and light: a finished errand, three runs with two asking
// for you, the replay of the finished run, and the phone layout.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'docs/screenshots'));
const port = 4477;
const base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'familiar-screens-'));
fs.mkdirSync(out, { recursive: true });

let chromium;
for (const p of [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  if (!p) continue;
  try { chromium = (await import(p)).chromium; if (chromium) break; } catch { /* next */ }
}
if (!chromium) { console.error('playwright not found (set PLAYWRIGHT_PATH)'); process.exit(1); }

const api = async (p, body) => {
  const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
};
const until = async (what, fn, ms = 120000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`timed out waiting for ${what}`);
};
const state = () => api('/api/state');
const task = async (re) => (await state()).tasks.find((t) => re.test(t.title) || re.test(t.brief));

const bin = ['release', 'debug'].map((d) => path.join(root, 'target', d, 'familiar')).find((p) => fs.existsSync(p));
if (!bin) { console.error('build the server first'); process.exit(1); }
const server = spawn(bin, ['--env', '/nonexistent'], {
  cwd: root,
  env: { ...process.env, FAMILIAR_PORT: String(port), FAMILIAR_DATA_DIR: dataDir, FAMILIAR_DEMO: '1', FAMILIAR_COORDINATOR: 'mock', FAMILIAR_EMBEDDER: 'hash', OPENROUTER_API_KEY: '', TELEGRAM_BOT_TOKEN: '', FAMILIAR_SCRIPT_SPEED: process.env.FAMILIAR_SCRIPT_SPEED || '2', FAMILIAR_MACHINE_NAME: 'errands' },
  stdio: ['ignore', fs.openSync(path.join(dataDir, 'server.log'), 'a'), fs.openSync(path.join(dataDir, 'server.log'), 'a')],
});
const stop = () => { try { server.kill('SIGINT'); } catch { /* gone */ } };
process.on('exit', stop);

const browser = await chromium.launch();
async function shot(name, { theme = 'dark', w = 1600, h = 1000, mobile = false, full = false, prep } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 3 : 1, colorScheme: theme, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('familiar.theme', t); } catch { /* */ } }, theme);
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('.desk');
  await page.evaluate(() => document.fonts.ready);
  if (prep) await prep(page);
  await page.waitForTimeout(900);
  const file = path.join(out, `${name}-${theme}.png`);
  await page.screenshot({ path: file, fullPage: full });
  console.log('  ✓', path.relative(root, file));
  await ctx.close();
}
const focusRun = (num) => async (page) => { await page.keyboard.press('Meta+k'); await page.keyboard.type(String(num)); await page.waitForTimeout(250); await page.keyboard.press('Enter'); };

try {
  await until('server', () => fetch(base + '/api/health').then((r) => r.ok), 20000);
  await until('machine online', async () => (await state()).machines.some((m) => m.status === 'online'), 60000);
  console.log('· server up, data in', dataDir);

  await api('/api/messages', { text: 'cancel my polyform sub' });
  const cancel = await until('cancel task', () => task(/polyform/i));
  await until('cancel done', async () => ['done', 'failed'].includes((await api(`/api/tasks/${cancel.id}`)).task.status), 240000);
  await new Promise((r) => setTimeout(r, 2500));
  for (const theme of ['dark', 'light']) await shot('finished-run', { theme });
  await shot('finished-run-replay', { prep: async (p) => { await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft'); } });

  await api('/api/messages', { text: 'install blender on my machine' });
  await until('install task', () => task(/blender/i));
  await api('/api/messages', { text: 'book me the train to edinburgh and pay for it' });
  await until('both asking', async () => (await state()).needs_you.length >= 2, 240000);
  await new Promise((r) => setTimeout(r, 2500));
  for (const theme of ['dark', 'light']) await shot('three-runs', { theme });
  await shot('palette', { prep: async (p) => { await p.keyboard.press('Meta+k'); await p.keyboard.type('pay'); } });
  await shot('shortcuts', { prep: async (p) => { await p.keyboard.press('Shift+Slash'); } });
  for (const theme of ['dark', 'light']) await shot('phone', { theme, w: 390, h: 844, mobile: true });
  await shot('phone-full', { w: 390, h: 844, mobile: true, full: true });
} catch (e) {
  console.error(e);
  console.error('server log:', path.join(dataDir, 'server.log'));
  process.exitCode = 1;
} finally {
  await browser.close();
  stop();
}
