import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, artifactUrl } from '../api';
import { cancelTask, execName, followUp, machineName, newTask, setControl, setState, useStore } from '../store';
import type { ReplayFrame, Task } from '../types';
import { logRows, moments as getMoments, steps as getSteps, urlAt, usesBrowser, usesTerminal, type Moment } from '../timeline';
import { dur, gbp, timeOf, tokens } from '../format';
import { Pill, Rid, runState, useNow } from './ui';
import { LiveView, type Tab } from './LiveView';
import { Filmstrip } from './Filmstrip';
import { ActionLog } from './ActionLog';
import { MachinePanel, MemoryPanel, StepsPanel, TelegramMirror } from './SidePanels';
import { Md, stripMd } from '../md';
import { ignoreKey } from '../keys';
import { IHand, IRedo, IReply, IStop } from '../icons';

const SOURCE: Record<string, string> = { telegram: 'Telegram', web: 'Web', schedule: 'Schedule', github: 'GitHub' };
const ENDED = ['done', 'failed', 'cancelled'];

function useCells(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  return w < 820 ? 4 : w < 1300 ? 5 : w < 1720 ? 6 : 8;
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
  const [fit, setFit] = useState<'all' | 'width'>('all');
  const [armed, setArmed] = useState(false);
  const cells = useCells();

  // default tab per run: browser if it has a browser, terminal for coding runs
  const [tabBy, setTabBy] = useState<Record<string, Tab>>({});
  // The machine's Chrome streams frames whatever the run is doing, and on a
  // persistent machine it still shows the last run's page. Only this run's own
  // browser use makes the browser the default view.
  const browserish = usesBrowser(events) || !!task.receipt_artifact;
  const autoTab: Tab = browserish ? 'browser' : usesTerminal(events) ? 'terminal' : 'browser';
  const tab = tabBy[task.id] || autoTab;
  const setTab = (t: Tab) => setTabBy((m) => ({ ...m, [task.id]: t }));

  const [openNow, setOpenNow] = useState(false);
  useEffect(() => { setCursor(null); setArmed(false); setOpenNow(false); }, [task.id]);
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
      else if (k === 'z') { e.preventDefault(); setFit((f) => (f === 'all' ? 'width' : 'all')); }
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
  } else if (n) {
    sub = <><span className="wf">{n.kind === 'approval' ? 'waiting for your approval' : 'waiting for your answer'}</span> · {dur(now - Date.parse(n.created_at))}</>;
  } else if (task.waiting_for) {
    const since = curRow?.pending ? start + curRow.ms : now;
    sub = <>waiting for <span className="wf">{task.waiting_for}</span> · {dur(now - since)}</>;
  }

  const planned = stepRows.some((r) => r.state === 'pending');
  const realSteps = stepRows.filter((r) => r.ms != null).length;
  const stepNow = Math.max(task.step || 0, realSteps);
  const cap = (task.time_cap_s || 0) * 1000;
  const capLabel = cap ? (cap >= 3600000 ? `${+(cap / 3600000).toFixed(1)} h` : `${Math.round(cap / 60000)} min`) : '';
  const cls = ['focus', driving ? 'driving' : '', !live ? 'rewound' : '', ended ? 'ended' : '', ended && task.outcome === 'success' ? 'okay' : '', wide ? 'wide' : ''].join(' ');
  return (
    <section className={cls} aria-label={`Run ${task.num}: ${task.title}`}>
      <header className="fh">
        <div className="fh-l">
          <div className="fh-1">
            <Rid n={task.num} />
            <h1>{task.title}</h1>
            <Pill kind={st.cls}>{st.label}</Pill>
            <span className="fh-meta">{SOURCE[task.source] || task.source} · {timeOf(task.created_at)} · {execName(task.executor)} on <b>{machineName(task.machine_id)}</b></span>
          </div>
          <div className={`fh-2 ${openNow ? 'open' : ''}`}>
            <span className="nk">{nk}</span>
            <div className="int" role="button" tabIndex={0} title={openNow ? undefined : stripMd(intent)} aria-expanded={openNow}
              onClick={() => setOpenNow((o) => !o)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenNow((o) => !o); } }}>
              {ended && live ? <Md text={intent} inlineOnly={!openNow} /> : intent}
              {sub && <span className="sub">{sub}</span>}
            </div>
          </div>
        </div>
        <div className="fh-r">
          {ended
            ? <div className="hstat"><small>Steps</small><b>{realSteps || task.step || 0}</b></div>
            : <div className="hstat"><small>Step</small><b>{stepNow} <i>of {task.steps_estimate ? (planned ? '' : '~') + task.steps_estimate : '?'}</i></b></div>}
          <div className="hstat" title={cap ? `Stops by itself after ${capLabel}` : undefined}><small>{ended ? 'Took' : 'Elapsed'}</small><b>{dur(elapsed)}{cap && !ended ? <i> / {capLabel}</i> : null}</b></div>
          <div className="hstat" title={`Payments over ${gbp(s.settings.approval_threshold_p, { short: true })} wait for you`}><small>Spend</small><b>{gbp(task.spend_p)} <i>/ {gbp(s.settings.approval_threshold_p, { short: true })} line</i></b></div>
          <div className="hstat opt" title={task.tokens && !task.spend_p && task.executor !== 'codex' ? 'Tokens on your Claude plan cost nothing extra' : undefined}><small>Tokens</small><b>{task.tokens ? tokens(task.tokens) : <i>none</i>}</b></div>
          {ended && (
            <div className="fh-acts">
              <button className="btn sm" onClick={() => followUp(task)} title="Ask Familiar about this run"><IReply size={13} />Follow up</button>
              <button className="btn sm ghost" onClick={() => newTask(task.brief, task.executor)} title="Start the same brief again"><IRedo size={13} />Run again</button>
            </div>
          )}
          {!ended && (
            <>
              <button className={`ctl ${driving ? 'on' : ''}`} onClick={() => setControl(task, !driving)} title={driving ? 'Hand control back to the agent (T)' : 'Pause the agent and drive the machine yourself (T)'}>
                <IHand />{driving ? 'Hand back' : 'Take control'} <kbd>T</kbd>
              </button>
              <button className={`xbtn ${armed ? 'armed' : ''}`} onClick={() => { if (armed) { cancelTask(task); setArmed(false); } else { setArmed(true); setTimeout(() => setArmed(false), 3500); } }} aria-label={armed ? 'Confirm: stop this run' : 'Stop this run'} title={armed ? 'Click again to stop' : 'Stop this run (asks once more)'}>
                <IStop size={11} />{armed ? 'Stop run?' : 'Stop'}
              </button>
            </>
          )}
        </div>
      </header>
      <div className="fb">
        <div className="lc">
          <LiveView task={task} machine={machine} events={events} tab={tab} setTab={setTab} cursor={cursor} replaySrc={replaySrc}
            replayMoment={cursor == null ? liveMoment : selMoment} url={url} curRow={curRow} elapsed={elapsed} goLive={goLive} wide={wide} setWide={setWide} fit={fit} setFit={setFit} browserUsed={browserish} />
          <Filmstrip moments={moms} selIdx={selIdx} cursor={cursor} elapsed={elapsed} live={live} ended={ended} driving={driving} onPick={pick} onScrub={seek} goLive={goLive} cells={cells} />
          <ActionLog rows={rows} cursor={cursor} curKey={curRow && (cursor != null || curRow.pending) ? curRow.key : null} onSeek={seek} driving={driving} />
        </div>
        <div className="rc">
          <StepsPanel steps={stepRows} cursor={cursor} task={task} onSeek={seek} driving={driving} />
          <MemoryPanel events={events} cursor={cursor} />
          <MachinePanel m={machine} hist={machine ? s.hist[machine.id] : undefined} task={task} />
          {/* Only when a bot is actually set up; otherwise there's no Telegram message to mirror. */}
          {s.settings.telegram && s.settings.telegram !== 'off' && <TelegramMirror task={task} needs={s.needs} events={events} />}
        </div>
      </div>
    </section>
  );
}
