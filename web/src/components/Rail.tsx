import { useEffect, useRef, useState } from 'react';
import { activeTasks, finishedTasks, focus, execName, loadTask, machineName, useStore } from '../store';
import { getFrame, onFrame } from '../bus';
import { artifactUrl } from '../api';
import type { Task, TaskEvent } from '../types';
import { logRows, usesBrowser } from '../timeline';
import { dur, timeOf, tplus } from '../format';
import { Pill, Rid, Spark, runState, useNow } from './ui';
import { ICheck, IX } from '../icons';

function TileView({ task, events }: { task: Task; events: TaskEvent[] }) {
  // only show the browser once this run has used it (see Focus: the machine's
  // Chrome may still show an earlier run's page)
  const browser = usesBrowser(events) || !!task.last_frame_artifact;
  return browser ? <TileFrame task={task} /> : <TileLog events={events} />;
}

function TileFrame({ task }: { task: Task }) {
  const img = useRef<HTMLImageElement>(null);
  const [has, setHas] = useState(() => !!getFrame(task.id));
  useEffect(() => {
    const f = getFrame(task.id);
    if (f && img.current) img.current.src = f.src;
    let last = 0;
    return onFrame(task.id, (fr) => {
      const t = performance.now();
      if (t - last < 900) return; // ~1 fps is plenty for a tile
      last = t;
      if (img.current) img.current.src = fr.src; else setHas(true);
    });
  }, [task.id]);
  const src = has ? getFrame(task.id)?.src : artifactUrl(task.last_frame_artifact);
  if (src) return <img ref={img} src={src} alt="" draggable={false} />;
  return <div className="minilog" aria-hidden="true"><div className="pd">waiting for the first frame…</div></div>;
}

function TileLog({ events }: { events: TaskEvent[] }) {
  // no picture (e.g. a coding run): show its latest tool calls, which is what matters
  const rows = logRows(events).filter((r) => !r.tool.endsWith('.recv')).slice(-7);
  return (
    <div className="minilog" aria-hidden="true">
      {rows.map((r) => (
        <div key={r.key}><span className="t">{tplus(r.ms)} </span>{r.tool === 'shell' ? `$ ${r.target}` : r.tool === 'ask.you' ? 'asked you' : r.tool} <span className={r.pending || r.result === 'waiting' ? 'pd' : r.status === 'error' ? 'er' : 'ok'}>{r.pending ? '…' : r.result}</span></div>
      ))}
    </div>
  );
}

function Tile({ task, idx }: { task: Task; idx: number }) {
  const s = useStore();
  const now = useNow(1000);
  const st = runState(task, s.needs);
  const m = task.machine_id ? s.machines[task.machine_id] : undefined;
  const hist = m ? s.hist[m.id] : undefined;
  const elapsed = task.started_at ? now - Date.parse(task.started_at) : 0;
  const n = s.needs.find((x) => x.task_id === task.id);
  const col = st.cls === 'running' || st.cls === 'live' ? 'var(--ok)' : st.cls === 'driving' || st.cls === 'wait' || st.cls === 'approval' ? 'var(--you)' : 'var(--muted)';
  return (
    <button className={`tile ${n ? 'needs' : ''} ${task.control ? 'driving' : ''}`} onClick={() => focus(task.id)} title={idx < 4 ? `Show this run (${idx + 1})` : undefined} aria-label={`Focus run ${task.num}, ${task.title}`}>
      <span className="th"><Rid n={task.num} /><span className="tn">{task.title}</span><Pill kind={st.cls}>{st.short}</Pill></span>
      <span className="tv"><TileView task={task} events={s.events[task.id] || []} /></span>
      <span className={`ti ${n ? 'you' : ''}`}>{n ? (n.kind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer') : task.now}</span>
      <span className="tf"><span>{machineName(task.machine_id)} · {execName(task.executor)}</span><span className="sp" /><span className="mono">{dur(elapsed)}</span>{(hist?.cpu.length ?? 0) >= 10 && <span className="spk"><Spark data={hist!.cpu.slice(-30)} w={56} h={14} color={col} max={100} /></span>}</span>
    </button>
  );
}

export function Rail() {
  const s = useStore();
  const act = activeTasks(s);
  const others = act.filter((t) => t.id !== s.focusId);
  // tiles need each run's timeline too (what it's doing, whether it has used the browser)
  const missing = others.filter((t) => !s.events[t.id]).map((t) => t.id).join(',');
  useEffect(() => { if (missing) missing.split(',').forEach((id) => loadTask(id)); }, [missing]);
  const done = finishedTasks(s);
  return (
    <aside className="rail" aria-label="Other runs">
      {others.map((t) => <Tile key={t.id} task={t} idx={act.indexOf(t)} />)}
      {!others.length && act.length > 0 && (
        <div className="rail-empty"><b>One run right now</b>Start another from Message Familiar or Telegram and it shows up here as a live tile.</div>
      )}
      {act.length === 0 && (
        <div className="rail-empty">
          <b>Machines</b>
          {Object.values(s.machines).length === 0 && <span>None connected yet.</span>}
          {Object.values(s.machines).map((m) => (
            <div key={m.id} className="mrow2"><span className={`dot ${m.status === 'online' || m.status === 'busy' ? 'ok' : ''}`} /><span className="n">{m.name}</span><small>{m.backend} · {m.specs.cpu} vCPU</small></div>
          ))}
          <span style={{ marginTop: 4 }}>Runs show here as live tiles while they work.</span>
        </div>
      )}
      {done.length > 0 && (
        <div className="earlier">
          <div className="sh">Earlier today<span className="aux">{done.length} finished</span></div>
          {done.slice(0, 12).map((t) => (
            <button key={t.id} className={`er-row ${t.id === s.focusId ? 'on' : ''}`} onClick={() => focus(t.id)} title={t.summary || t.title}>
              <span className={`oc ${t.status === 'done' ? t.outcome || 'success' : t.status === 'failed' ? 'failed' : 'cancelled'}`}>
                {t.status === 'done' ? (t.outcome === 'partial' ? <span style={{ fontSize: 11 }}>◐</span> : <ICheck size={12} />) : <IX size={12} />}
              </span>
              <span className="n">{t.num}</span>
              <span className="tt">{t.title}</span>
              <span className="w">{timeOf(t.ended_at || t.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
