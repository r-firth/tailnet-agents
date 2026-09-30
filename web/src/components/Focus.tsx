import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, artifactUrl } from '../api';
import { hasFrames } from '../bus';
import { cancelTask, execName, machineName, setControl, setState, useStore } from '../store';
import type { ReplayFrame, Task } from '../types';
import { logRows, moments as getMoments, steps as getSteps, urlAt, usesBrowser, usesTerminal, type Moment } from '../timeline';
import { dur, gbp, timeOf, tokens } from '../format';
import { Pill, Rid, runState, useNow } from './ui';
import { LiveView, type Tab } from './LiveView';
import { Filmstrip } from './Filmstrip';
import { ActionLog } from './ActionLog';
import { BudgetPanel, MachinePanel, MemoryPanel, StepsPanel, TelegramMirror } from './SidePanels';
import { ignoreKey } from '../keys';
import { IHand, IStop } from '../icons';

const SOURCE: Record<string, string> = { telegram: 'Telegram', web: 'Web', schedule: 'Schedule', github: 'GitHub' };
const ENDED = ['done', 'failed', 'cancelled'];

function useCells(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  return w < 820 ? 4 : w < 1300 ? 6 : 8;
}

export function Focus({ task }: { task: Task }) {
  const s = useStore();
  const now = useNow(1000);
  const events = s.events[task.id] || [];
  const machine = task.machine_id ? s.machines[task.machine_id] : undefined;
  const ended = ENDED.includes(task.status);
  const driving = task.control === 'you';
  const [cursor, setCursor] = useState<number | null>(null);
  const [frames, setFrames] = useState<ReplayFrame[]>([]);
  const [wide, setWide] = useState(false);
  const [armed, setArmed] = useState(false);
  const cells = useCells();

  // default tab per run: browser if it has a browser, terminal for coding runs
  const [tabBy, setTabBy] = useState<Record<string, Tab>>({});
  const browserish = usesBrowser(events) || hasFrames(task.id) || !!task.last_frame_artifact;
  const autoTab: Tab = browserish ? 'browser' : usesTerminal(events) ? 'terminal' : 'browser';
  const tab = tabBy[task.id] || autoTab;
  const setTab = (t: Tab) => setTabBy((m) => ({ ...m, [task.id]: t }));

  useEffect(() => { setCursor(null); setArmed(false); }, [task.id]);
  useEffect(() => { if (driving) setCursor(null); }, [driving]);

  const start = Date.parse(task.started_at || task.created_at);
  const endT = task.ended_at ? Date.parse(task.ended_at) : now;
  const elapsed = Math.max(0, endT - start);

  const loadFrames = useCallback(() => {
    api.get<ReplayFrame[]>(`/tasks/${encodeURIComponent(task.id)}/frames`).then((f) => setFrames(Array.isArray(f) ? f : [])).catch(() => {});
  }, [task.id]);
  useEffect(() => { setFrames([]); loadFrames(); }, [loadFrames]);
  useEffect(() => { if (cursor != null) loadFrames(); }, [cursor != null]); // eslint-disable-line react-hooks/exhaustive-deps

  // seeks requested from elsewhere (palette, search, memory evidence)
  useEffect(() => {
    if (s.seek && s.seek.taskId === task.id) { setCursor(Math.max(0, s.seek.ms)); setState({ seek: null }); }
  }, [s.seek, task.id]);

  const rows = useMemo(() => logRows(events), [events]);
  const stepRows = useMemo(() => getSteps(events), [events]);
  const moms = useMemo(() => getMoments(events), [events]);

  const selIdx = useMemo(() => {
    if (cursor == null) return moms.length - 1;
    let k = -1; moms.forEach((m, i) => { if (m.ms <= cursor) k = i; }); return k;
  }, [moms, cursor]);
  const selMoment: Moment | null = selIdx >= 0 ? moms[selIdx] : null;

  const liveMoment = useMemo(() => {
    // for the pre-browser card when live: most recent non-browser moment
    for (let i = moms.length - 1; i >= 0; i--) if (!moms[i].artifact) return moms[i];
    return null;
  }, [moms]);

  const replaySrc = useMemo(() => {
    if (cursor == null) return null;
    if (selMoment?.artifact && cursor - selMoment.ms < 1500) return artifactUrl(selMoment.artifact);
    let f: ReplayFrame | null = null;
    for (const fr of frames) { if (fr.ms <= cursor) f = fr; else break; }
    if (f && (!selMoment || f.ms >= selMoment.ms - 1000 || !['brief', 'memory.recall', 'machine'].includes(selMoment.kind))) return artifactUrl(f.artifact);
    if (selMoment?.artifact) return artifactUrl(selMoment.artifact);
    // fall back to the last keyframe before the cursor
    for (let i = selIdx; i >= 0; i--) if (moms[i].artifact && !['brief', 'memory.recall', 'machine'].includes(selMoment?.kind || '')) return artifactUrl(moms[i].artifact);
    return null;
  }, [cursor, frames, selMoment, selIdx, moms]);

  const curRow = useMemo(() => {
    if (cursor == null) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].pending) return rows[i];
      return rows[rows.length - 1] || null;
    }
    let r = null; for (const x of rows) { if (x.ms <= cursor) r = x; else break; } return r;
  }, [rows, cursor]);

  const url = urlAt(events, cursor);

  const seek = useCallback((ms: number) => { if (driving) return; setCursor(ended && ms >= elapsed - 500 ? null : Math.max(0, Math.min(ms, elapsed))); }, [driving, ended, elapsed]);
  const goLive = useCallback(() => setCursor(null), []);
  const pick = (i: number) => { if (driving) return; if (i >= moms.length - 1 && !ended) setCursor(null); else setCursor(moms[i].ms); };

  // keyboard: ← → L T F
  const ref = useRef({ moms, selIdx, cursor, ended, driving, task });
  ref.current = { moms, selIdx, cursor, ended, driving, task };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (ignoreKey(e)) return;
      const c = ref.current;
      const k = e.key.toLowerCase();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (c.driving || !c.moms.length) return;
        e.preventDefault();
        const cur = c.cursor == null ? c.moms.length : c.selIdx;
        let i = cur + (e.key === 'ArrowLeft' ? -1 : 1);
        if (c.cursor != null && e.key === 'ArrowLeft' && c.moms[c.selIdx] && c.cursor > c.moms[c.selIdx].ms + 800) i = c.selIdx;
        if (i >= c.moms.length) setCursor(null);
        else setCursor(c.moms[Math.max(0, i)].ms);
      } else if (k === 'l') { e.preventDefault(); setCursor(null); }
      else if (k === 't') { e.preventDefault(); if (!ENDED.includes(c.task.status)) setControl(c.task, !c.driving); }
      else if (k === 'f') { e.preventDefault(); setWide((w) => !w); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const st = runState(task, s.needs, true);
  const n = s.needs.find((x) => x.task_id === task.id);
  const live = cursor == null;
  let nk = 'Now', intent = task.now || '', sub: React.ReactNode = null;
  if (driving) { nk = 'Paused'; intent = `You have the wheel. ${execName(task.executor)} resumes from step ${task.step} when you hand back`; }
  else if (!live) {
    nk = 'Then';
    const act = [...stepRows].reverse().find((r) => r.ms != null && r.ms <= cursor!);
    intent = act ? (act.history.filter((h) => h.ms <= cursor!).pop()?.text || act.text) : selMoment?.label || 'Before the first step';
    sub = <>at {dur(cursor!)}{selMoment ? ` · ${selMoment.label}` : ''}</>;
  } else if (ended) {
    nk = task.status === 'done' ? (task.outcome === 'partial' ? 'Partly' : 'Done') : task.status === 'failed' ? 'Failed' : 'Stopped';
    intent = task.summary || task.now || '';
    sub = <>ended {timeOf(task.ended_at)} · took {dur(elapsed)}</>;
  } else if (n) {
    sub = <><span className="wf">{n.kind === 'approval' ? 'waiting for your approval' : 'waiting on your answer'}</span> · {dur(now - Date.parse(n.created_at))}</>;
  } else if (task.waiting_for) {
    const since = curRow?.pending ? start + curRow.ms : now;
    sub = <>waiting for <span className="wf">{task.waiting_for}</span> · {dur(now - since)}</>;
  } else if (curRow?.pending) {
    sub = <>{curRow.tool} · {dur(now - (start + curRow.ms))}</>;
  }

  const cls = ['focus', driving ? 'driving' : '', !live ? 'rewound' : '', ended ? 'ended' : '', ended && task.outcome === 'success' ? 'okay' : '', wide ? 'wide' : ''].join(' ');
  return (
    <section className={cls} aria-label={`Run ${task.num}: ${task.title}`}>
      <header className="fh">
        <div className="fh-l">
          <div className="fh-1">
            <Rid n={task.num} />
            <h1>{task.title}</h1>
            <Pill kind={st.cls}>{st.label}</Pill>
            <span className="fh-meta">{SOURCE[task.source] || task.source} {timeOf(task.created_at, true)} · {execName(task.executor)} on <b>{machineName(task.machine_id)}</b></span>
          </div>
          <div className="fh-2">
            <span className="nk">{nk}</span>
            <span className="int" title={intent}>{intent}</span>
            {sub && <span className="sub">{sub}</span>}
          </div>
        </div>
        <div className="fh-r">
          <div className="hstat"><small>Step</small><b>{task.step || 0} <i>of ~{task.steps_estimate || '?'}</i></b></div>
          <div className="hstat"><small>Elapsed</small><b>{dur(elapsed)}</b></div>
          <div className="hstat"><small>Spend</small><b>{gbp(task.spend_p)} <i>/ {gbp(s.settings.approval_threshold_p, { short: true })} no-ask</i></b></div>
          <div className="hstat opt"><small>Tokens</small><b>{tokens(task.tokens)}</b></div>
          {!ended && (
            <>
              <button className={`ctl ${driving ? 'on' : ''}`} onClick={() => setControl(task, !driving)} title={driving ? 'Hand control back to the agent (T)' : 'Pause the agent and drive the machine yourself (T)'}>
                <IHand />{driving ? 'Hand back' : 'Take control'} <kbd>T</kbd>
              </button>
              <button className={`xbtn ${armed ? 'armed' : ''}`} onClick={() => { if (armed) { cancelTask(task); setArmed(false); } else { setArmed(true); setTimeout(() => setArmed(false), 3500); } }} aria-label={armed ? 'Confirm cancel run' : 'Cancel run'} title="Cancel this run">
                <IStop size={13} />{armed && 'Cancel run?'}
              </button>
            </>
          )}
        </div>
      </header>
      <div className="fb">
        <div className="lc">
          <LiveView task={task} machine={machine} events={events} tab={tab} setTab={setTab} cursor={cursor} replaySrc={replaySrc}
            replayMoment={cursor == null ? liveMoment : selMoment} url={url} curRow={curRow} elapsed={elapsed} goLive={goLive} wide={wide} setWide={setWide} />
          <Filmstrip moments={moms} selIdx={selIdx} cursor={cursor} elapsed={elapsed} live={live} ended={ended} driving={driving} onPick={pick} onScrub={seek} goLive={goLive} cells={cells} />
          <ActionLog rows={rows} cursor={cursor} curKey={curRow && (cursor != null || curRow.pending) ? curRow.key : null} onSeek={seek} driving={driving} />
        </div>
        <div className="rc">
          <StepsPanel steps={stepRows} cursor={cursor} task={task} onSeek={seek} driving={driving} />
          <MemoryPanel events={events} cursor={cursor} />
          <MachinePanel m={machine} hist={machine ? s.hist[machine.id] : undefined} task={task} />
          <BudgetPanel task={task} settings={s.settings} elapsed={elapsed} tokenHist={s.tokenHist[task.id] || []} />
          <TelegramMirror task={task} needs={s.needs} events={events} />
        </div>
      </div>
    </section>
  );
}
