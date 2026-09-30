import type { Machine, NeedsYou, Settings, Task, TaskEvent } from '../types';
import { stepAt, stepTextAt, type StepRow } from '../timeline';
import { dur, gbp, timeOf, tokens as ftok, uptime } from '../format';
import { Bar, Spark } from './ui';
import { openOverlay, machineName, type Hist } from '../store';

export function StepsPanel({ steps, cursor, task, onSeek, driving }: { steps: StepRow[]; cursor: number | null; task: Task; onSeek: (ms: number) => void; driving: boolean }) {
  const real = steps.filter((s) => s.ms != null).length;
  const est = Math.max(task.steps_estimate || 0, steps.length);
  let curStep = 0;
  if (cursor != null) steps.forEach((s, i) => { const st = stepAt(s, cursor); if (st !== 'after' && st !== 'pending') curStep = i + 1; });
  return (
    <div className="panel">
      <div className="sh">Steps<span className={`aux ${cursor != null ? 'rw' : ''}`}>{cursor != null ? `at step ${curStep}` : `${Math.max(task.step || 0, real)} of ${est ? '~' + est : '?'}`}</span></div>
      {steps.length === 0 ? <div className="mem"><div className="none">The plan appears here once the agent has read the brief.</div></div> : (
        <ol className="steps">
          {steps.map((s) => {
            const st = cursor == null ? s.state : stepAt(s, cursor);
            const isCur = st === 'active';
            const when = s.ms != null ? dur(s.doneMs ?? s.ms) : '';
            return (
              <li key={s.id} className={`st ${st} ${s.ms != null && !driving ? 'clickable' : ''}`} onClick={() => s.ms != null && !driving && onSeek(s.ms)}>
                <span className="ic"><i /></span>
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

export function MemoryPanel({ events, cursor }: { events: TaskEvent[]; cursor: number | null }) {
  const upto = cursor == null ? events : events.filter((e) => e.ms <= cursor);
  const recalls = upto.filter((e) => e.kind === 'memory.recall');
  const writes = upto.filter((e) => e.kind === 'memory.write');
  const last = recalls[recalls.length - 1];
  const hits = last?.hits || [];
  const pending = cursor != null && !last && events.some((e) => e.kind === 'memory.recall');
  const firstRecall = events.find((e) => e.kind === 'memory.recall');
  return (
    <div className="panel mem">
      <div className="sh" style={{ marginBottom: 1 }}>Memory<span className="aux">{last ? `recalled “${last.query}”, ${hits.length} ${hits.length === 1 ? 'hit' : 'hits'}${recalls.length > 1 ? ` · ${recalls.length} searches` : ''}` : pending ? `not recalled yet (${dur(firstRecall!.ms)})` : 'nothing recalled yet'}</span><span className="sp" /><button className="aux" onClick={() => openOverlay('memory')}>Open</button></div>
      {hits.slice(0, 5).map((h) => (
        <button key={h.id + h.text} className="row rec" onClick={() => openOverlay('memory', { memoryClaim: h.id })} title="Why does Familiar know this?">
          <span className="sc">{h.score.toFixed(2).replace(/^0/, '')}</span><span>{h.text}</span><span className="src">{h.source || h.kind}</span>
        </button>
      ))}
      {writes.length > 0 && <div className="sub">Writes <i>{writes.some((w) => w.status === 'queued') ? 'some queued until finish' : 'saved'}</i></div>}
      {writes.map((w) => (
        <button key={w.id} className="row" onClick={() => w.claim_id != null && openOverlay('memory', { memoryClaim: w.claim_id })}>
          <span className={`op ${w.op}`}>{OP[w.op || 'add'] || '+'}</span><span>{w.text}</span><span className="src">{w.status === 'queued' ? 'queued' : w.op === 'supersede' ? 'supersedes' : w.claim_kind}</span>
        </button>
      ))}
      {!last && !writes.length && !pending && <div className="none">Recalls and new memories for this run show here.</div>}
    </div>
  );
}

const BACKEND: Record<string, string> = { cloudflare: 'Cloudflare', docker: 'Docker', local: 'Local', ssh: 'SSH' };
const kv = (l: string, v: React.ReactNode, viz?: React.ReactNode) => (
  <div className="kvr"><span className="kl">{l}</span><b>{v}</b><span className="kz">{viz}</span></div>
);

export function MachinePanel({ m, hist, task }: { m: Machine | undefined; hist: Hist | undefined; task: Task }) {
  if (!m) return <div className="panel"><div className="sh">Machine<span className="aux">{task.machine_id ? machineName(task.machine_id) : 'not assigned yet'}</span></div></div>;
  const on = m.status !== 'offline' && m.status !== 'sleeping';
  const col = task.control ? 'var(--you)' : task.status === 'running' ? 'var(--agent)' : 'var(--muted)';
  return (
    <div className="panel">
      <div className="sh">Machine<span className="aux">{m.name} · {BACKEND[m.backend] || m.backend} · {m.specs.cpu} vCPU / {m.specs.mem_gb} GB</span><span className="sp" /><button className="aux" onClick={() => openOverlay('machines')}>Open</button></div>
      <div className="kv">
        {kv('CPU', on ? `${m.stats.cpu_pct}%` : '—', <Spark data={hist?.cpu.slice(-40) || []} color={col} max={100} />)}
        {kv('MEM', <>{on ? m.stats.mem_gb.toFixed(1) : '—'} <i>/ {m.specs.mem_gb} GB</i></>, <Bar pct={(m.stats.mem_gb / m.specs.mem_gb) * 100} />)}
        {kv('NET', <>{on ? m.stats.net_mbs.toFixed(1) : '—'} <i>MB/s</i></>, <Spark data={hist?.net.slice(-40) || []} color="var(--mach)" />)}
        {kv('Uptime', on ? uptime(m.stats.uptime_s) : m.status, <Bar pct={on ? 100 : 0} color={on ? 'var(--ok)' : 'var(--muted)'} />)}
      </div>
    </div>
  );
}

export function BudgetPanel({ task, settings, elapsed, tokenHist }: { task: Task; settings: Settings; elapsed: number; tokenHist: number[] }) {
  const th = settings.approval_threshold_p || 10000;
  const cap = (task.time_cap_s || 0) * 1000;
  return (
    <div className="panel">
      <div className="sh">Budget<span className="aux">asks only above {gbp(th, { short: true })}</span></div>
      <div className="kv">
        {kv('Spend', <>{gbp(task.spend_p, { short: true })} <i>of {gbp(th, { short: true })}</i></>, <Bar pct={(task.spend_p / th) * 100} color={task.spend_p > th ? 'var(--you)' : undefined} />)}
        {kv('Time', <>{dur(elapsed)} {cap ? <i>of {dur(cap)}</i> : null}</>, cap ? <Bar pct={(elapsed / cap) * 100} color="var(--agent)" /> : null)}
        {kv('Tokens', ftok(task.tokens), <Spark data={tokenHist.slice(-40)} color="var(--muted)" />)}
        {kv('Step', <>{task.step || 0} <i>of ~{task.steps_estimate || '?'}</i></>, <Bar pct={task.steps_estimate ? ((task.step || 0) / task.steps_estimate) * 100 : 0} color="var(--ok)" />)}
      </div>
    </div>
  );
}

/** What the single, self-editing Telegram status message for this run says right now. */
export function TelegramMirror({ task, needs, events }: { task: Task; needs: NeedsYou[]; events: TaskEvent[] }) {
  const n = needs.find((x) => x.task_id === task.id);
  const lastMsg = [...events].reverse().find((e) => e.kind === 'message');
  let text: React.ReactNode;
  let kb: string[] = [];
  const est = task.steps_estimate ? `/~${task.steps_estimate}` : '';
  if (task.control === 'you') text = <>Paused: Ryan is driving {machineName(task.machine_id)}. <a href="#" onClick={(e) => e.preventDefault()}>Watch live ›</a></>;
  else if (n) { text = <>{n.kind === 'approval' ? 'Needs your OK: ' : 'Question: '}{n.title}{n.detail && n.kind === 'approval' ? ` (${n.detail.split(' · ')[0]})` : ''}</>; kb = n.options.filter((o) => o.style !== 'quiet').map((o) => o.label).slice(0, 3); }
  else if (task.status === 'done') text = <>{task.outcome === 'partial' ? '◐ ' : '✓ '}{task.summary || lastMsg?.text}</>;
  else if (task.status === 'failed') text = <>✕ Failed: {task.summary || task.now}</>;
  else if (task.status === 'cancelled') text = <>Cancelled. {task.now}</>;
  else if (task.status === 'queued' || task.status === 'starting') text = <>Starting {task.title} on {machineName(task.machine_id)}…</>;
  else text = <>{task.title}. Step {task.step || 0}{est}: {task.now}. <a href="#" onClick={(e) => e.preventDefault()}>Watch live ›</a></>;
  const at = events.length ? events[events.length - 1].at : task.created_at;
  return (
    <div className="panel">
      <div className="sh">Telegram mirror<span className="aux">one message, edits itself</span><span className="sp" /><span className="aux mono">{timeOf(at, true)}</span></div>
      <div className="tg">
        <div className="av">F</div>
        <div className="bub">{text}{kb.length > 0 && <div className="kb">{kb.map((k) => <span key={k}>{k}</span>)}</div>}</div>
      </div>
    </div>
  );
}
