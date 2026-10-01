import { useState } from 'react';
import { sourceLabel } from '../md';
import type { Machine, NeedsYou, Task, TaskEvent } from '../types';
import { stepAt, stepTextAt, type StepRow } from '../timeline';
import { dur, timeOf, uptime } from '../format';
import { Bar, Spark } from './ui';
import { getState, openOverlay, machineName, splitAsk, type Hist } from '../store';
import { Md, stripMd } from '../md';
import { ICheck, IChevron, ITelegram } from '../icons';

const ENDED = ['done', 'failed', 'cancelled'];

export function StepsPanel({ steps, cursor, task, onSeek, driving }: { steps: StepRow[]; cursor: number | null; task: Task; onSeek: (ms: number) => void; driving: boolean }) {
  const real = steps.filter((s) => s.ms != null).length;
  const planned = steps.some((s) => s.state === 'pending');
  const ended = ENDED.includes(task.status);
  const est = Math.max(task.steps_estimate || 0, steps.length);
  let curStep = 0;
  if (cursor != null) steps.forEach((s, i) => { const st = stepAt(s, cursor); if (st !== 'after' && st !== 'pending') curStep = i + 1; });
  const aux = cursor != null ? `at step ${curStep} of ${real}` : ended ? `${real} ${real === 1 ? 'step' : 'steps'}` : `${Math.max(task.step || 0, real)} of ${est ? (planned ? '' : '~') + est : '?'}`;
  return (
    <div className="panel">
      <div className="sh">Steps<span className={`aux ${cursor != null ? 'rw' : ''}`}>{aux}</span></div>
      {steps.length === 0 ? <div className="mem"><div className="none">{task.status === 'queued' || task.status === 'starting' ? 'The plan appears once the agent has read the brief.' : 'No steps yet.'}</div></div> : (
        <ol className="steps">
          {steps.map((s) => {
            const st = cursor == null ? s.state : stepAt(s, cursor);
            const isCur = st === 'active';
            const when = s.ms != null ? dur(s.doneMs ?? s.ms) : '';
            return (
              <li key={s.id} className={`st ${st} ${s.ms != null && !driving ? 'clickable' : ''}`} onClick={() => s.ms != null && !driving && onSeek(s.ms)}>
                <span className="ic">{st === 'done' ? <ICheck size={11} /> : <i />}</span>
                <span className="tt">{stepTextAt(s, cursor)}{isCur && cursor == null && task.waiting_for && <span className="dt">waiting for {task.waiting_for}</span>}</span>
                <span className="tm">{st === 'pending' || st === 'after' ? '' : when}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

const OP: Record<string, string> = { add: '+', supersede: '~', forget: '−' };
// Hits below this are what any query returns; showing them reads as noise.
const FLOOR = 0.45;

/** "Task #3" → "run 3 · Cancel my polyform sub" when that run is known. */
function provenance(source: unknown, kind: string | undefined): { short: string; long: string } {
  const src = sourceLabel(source);
  const m = /^task #?(\d+)/i.exec(src);
  if (m) {
    const t = Object.values(getState().tasks).find((x) => x.num === +m[1]);
    return { short: `run ${m[1]}`, long: t ? `Learned in run ${m[1]}, ${t.title}` : `Learned in run ${m[1]}` };
  }
  return { short: src || kind || '', long: src || kind || '' };
}

export function MemoryPanel({ events, cursor }: { events: TaskEvent[]; cursor: number | null }) {
  const [all, setAll] = useState(false);
  const upto = cursor == null ? events : events.filter((e) => e.ms <= cursor);
  const recalls = upto.filter((e) => e.kind === 'memory.recall');
  const writes = upto.filter((e) => e.kind === 'memory.write');
  const last = recalls[recalls.length - 1];
  const hits = last?.hits || [];
  const close = hits.filter((h) => h.score >= FLOOR);
  const shown = all ? hits : close;
  const pending = cursor != null && !last && events.some((e) => e.kind === 'memory.recall');
  const firstRecall = events.find((e) => e.kind === 'memory.recall');
  let aux = 'nothing recalled yet';
  if (last) aux = close.length ? `${close.length} ${close.length === 1 ? 'memory' : 'memories'} for “${last.query}”` : hits.length ? `nothing close for “${last.query}”` : `nothing known yet about “${last.query}”`;
  else if (pending) aux = `recalls at ${dur(firstRecall!.ms)}`;
  return (
    <div className="panel mem">
      <div className="sh">Memory<span className="aux" title={last?.query}>{aux}</span><span className="sp" /><button className="aux lnk" onClick={() => openOverlay('memory')}>All memory</button></div>
      {shown.slice(0, 5).map((h) => {
        const pv = provenance(h.source, h.kind);
        return (
          <button key={h.id + h.text} className={`row rec ${h.score < FLOOR ? 'weak' : ''}`} onClick={() => openOverlay('memory', { memoryClaim: h.id })} title={`${h.text}\n${pv.long} · match ${Math.round(h.score * 100)}%`}>
            <span className="sc">{Math.round(h.score * 100)}</span><span>{h.text}</span><span className="src">{pv.short}</span>
          </button>
        );
      })}
      {last && hits.length > close.length && (
        <button className="more-lnk" onClick={() => setAll((a) => !a)}>{all ? 'Hide weak matches' : `${hits.length - close.length} weak ${hits.length - close.length === 1 ? 'match' : 'matches'} hidden`}</button>
      )}
      {writes.length > 0 && <div className="sub">{writes.some((w) => w.status === 'queued') ? 'Saving when the run finishes' : `Saved ${writes.length} ${writes.length === 1 ? 'memory' : 'memories'}`}</div>}
      {writes.map((w) => (
        <button key={w.id} className="row" onClick={() => w.claim_id != null && openOverlay('memory', { memoryClaim: w.claim_id })} title={w.text}>
          <span className={`op ${w.op}`}>{OP[w.op || 'add'] || '+'}</span><span>{w.text}</span><span className="src">{w.status === 'queued' ? 'queued' : w.op === 'supersede' ? 'replaces' : w.claim_kind}</span>
        </button>
      ))}
      {!last && !writes.length && !pending && <div className="none">What it recalls and learns shows here.</div>}
    </div>
  );
}

const BACKEND: Record<string, string> = { cloudflare: 'Cloudflare', docker: 'Docker', local: 'Local', ssh: 'SSH' };
const kv = (l: string, v: React.ReactNode, viz?: React.ReactNode) => (
  <div className="kvr"><span className="kl">{l}</span><b>{v}</b><span className="kz">{viz}</span></div>
);
// a sparkline of a handful of samples is a flat line that says nothing
const spark = (d: number[] | undefined, color: string, max?: number) => (d && d.length >= 10 ? <Spark data={d.slice(-40)} color={color} max={max} /> : null);

export function MachinePanel({ m, hist, task }: { m: Machine | undefined; hist: Hist | undefined; task: Task }) {
  const ended = ENDED.includes(task.status);
  const spec = m ? `${BACKEND[m.backend] || m.backend} · ${m.specs.cpu} vCPU / ${m.specs.mem_gb} GB` : '';
  if (ended) {
    const other = m?.task_id && m.task_id !== task.id ? getState().tasks[m.task_id] : null;
    const state = !m ? 'Released when the run ended' : other ? `Now busy with run ${other.num}, ${other.title}` : m.status === 'offline' || m.status === 'sleeping' ? `Asleep since the run ended` : 'Idle, ready for the next run';
    return (
      <div className="panel">
        <div className="sh">Machine<span className="aux">{machineName(task.machine_id)}{spec ? ` · ${spec}` : ''}</span><span className="sp" /><button className="aux lnk" onClick={() => openOverlay('machines')}>Machines</button></div>
        <div className="mline">{state}{m?.last_backup_at ? ` · backed up ${timeOf(m.last_backup_at)}` : ''}</div>
      </div>
    );
  }
  if (!m) return <div className="panel"><div className="sh">Machine<span className="aux">{task.machine_id ? machineName(task.machine_id) : 'picking one'}</span></div></div>;
  const on = m.status !== 'offline' && m.status !== 'sleeping';
  const col = task.control ? 'var(--you)' : task.status === 'running' ? 'var(--agent)' : 'var(--muted)';
  return (
    <div className="panel">
      <div className="sh">Machine<span className="aux">{m.name} · {spec}</span><span className="sp" /><button className="aux lnk" onClick={() => openOverlay('machines')}>Machines</button></div>
      <div className="kv">
        {kv('CPU', on ? `${Math.round(m.stats.cpu_pct)}%` : '—', spark(hist?.cpu, col, 100))}
        {kv('Memory', <>{on ? m.stats.mem_gb.toFixed(1) : '—'} <i>/ {m.specs.mem_gb} GB</i></>, <Bar pct={(m.stats.mem_gb / m.specs.mem_gb) * 100} />)}
        {kv('Network', <>{on ? m.stats.net_mbs.toFixed(1) : '—'} <i>MB/s</i></>, spark(hist?.net, 'var(--mach)'))}
        {kv('Up', on ? uptime(m.stats.uptime_s) : m.status)}
      </div>
    </div>
  );
}

/** The single, self-editing Telegram status message for this run, as it reads right now. One line until opened. */
export function TelegramMirror({ task, needs, events }: { task: Task; needs: NeedsYou[]; events: TaskEvent[] }) {
  const [open, setOpen] = useState(false);
  const n = needs.find((x) => x.task_id === task.id);
  const lastMsg = [...events].reverse().find((e) => e.kind === 'message');
  const est = task.steps_estimate ? `/${task.steps_estimate}` : '';
  let text = '';
  let buttons: string[] = [];
  if (task.control === 'you') text = `Paused: Ryan is driving ${machineName(task.machine_id)}.`;
  else if (n) { text = `${n.kind === 'approval' ? 'Needs your OK: ' : ''}${n.kind === 'question' ? splitAsk(n.title).ask : n.title}`; buttons = n.options.map((o) => o.label).slice(0, 3); }
  else if (task.status === 'done') text = `${task.outcome === 'partial' ? '◐ ' : '✓ '}${task.summary || lastMsg?.text || ''}`;
  else if (task.status === 'failed') text = `✕ Failed: ${task.summary || task.now}`;
  else if (task.status === 'cancelled') text = `Cancelled. ${task.now || ''}`;
  else if (task.status === 'queued' || task.status === 'starting') text = `Starting ${task.title}…`;
  else text = `${task.title}. Step ${task.step || 0}${est}: ${task.now}`;
  const at = events.length ? events[events.length - 1].at : task.created_at;
  return (
    <div className={`panel tgp ${open ? 'open' : ''}`}>
      <button className="sh tgh" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <IChevron size={10} className="chev" />Telegram<span className="aux">one message, edited {timeOf(at)}</span>
      </button>
      {open ? (
        <div className="tg">
          <div className="av"><ITelegram size={11} /></div>
          <div className="bub"><Md text={text} />{buttons.length > 0 && <div className="kb" aria-label="Buttons under the message">{buttons.map((k) => <span key={k}>{k}</span>)}</div>}</div>
        </div>
      ) : (
        <button className="tgline" onClick={() => setOpen(true)} title="Show the whole message">{stripMd(text)}{buttons.length > 0 && <span className="dim"> · buttons: {buttons.join(', ')}</span>}</button>
      )}
    </div>
  );
}
