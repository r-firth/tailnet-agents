import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as RKE, type PointerEvent as RPE } from 'react';
import { getFrame, onFrame } from '../bus';
import { artifactUrl } from '../api';
import { machineName, sendInput, setControl, execName } from '../store';
import type { Machine, Task, TaskEvent } from '../types';
import type { LogRow, Moment } from '../timeline';
import { dur, splitUrl, timeOf } from '../format';
import { Dither } from './Dither';
import { useTheme } from '../theme';
import { IBack, IBrowser, IDesktop, IExpand, IFwd, ILock, IGlobe, IReload, IShrink, ITerm, IReceipt } from '../icons';
import { TerminalView } from './TerminalView';
import { Pill, actorClass } from './ui';

export type Tab = 'browser' | 'terminal' | 'desktop';

interface Props {
  task: Task;
  machine: Machine | undefined;
  events: TaskEvent[];
  tab: Tab;
  setTab: (t: Tab) => void;
  cursor: number | null;          // replay cursor (ms) or null for live
  replaySrc: string | null;       // image to show while rewound
  replayMoment: Moment | null;    // moment at the cursor (for non-image moments)
  url: string | null;
  curRow: LogRow | null;          // tool at the cursor / pending tool when live
  elapsed: number;
  goLive: () => void;
  wide: boolean;
  setWide: (w: boolean) => void;
}

const ended = (t: Task) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled';

/** Maps a pointer position to frame pixels for an <img> using object-fit: contain. */
function mapPoint(img: HTMLImageElement, cx: number, cy: number): { x: number; y: number } | null {
  const r = img.getBoundingClientRect();
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return null;
  const s = Math.min(r.width / nw, r.height / nh);
  const dw = nw * s, dh = nh * s;
  const ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
  const x = (cx - ox) / s, y = (cy - oy) / s;
  if (x < 0 || y < 0 || x > nw || y > nh) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function LiveFrame({ taskId, driving, fallback }: { taskId: string; driving: boolean; fallback: string | null }) {
  const img = useRef<HTMLImageElement>(null);
  const [has, setHas] = useState(() => !!getFrame(taskId));
  useLayoutEffect(() => {
    const f = getFrame(taskId);
    setHas(!!f);
    if (f && img.current) img.current.src = f.src;
    return onFrame(taskId, (fr) => { if (img.current) img.current.src = fr.src; else setHas(true); setHas(true); });
  }, [taskId]);

  // input forwarding while the user holds control
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const lastMove = useRef(0);
  const onDown = (e: RPE) => {
    if (!driving || !img.current) return;
    (e.currentTarget as HTMLElement).focus();
    const p = mapPoint(img.current, e.clientX, e.clientY); if (!p) return;
    drag.current = { ...p, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPE) => {
    if (!driving || !img.current) return;
    const now = performance.now();
    if (now - lastMove.current < 33) return;
    lastMove.current = now;
    const p = mapPoint(img.current, e.clientX, e.clientY); if (!p) return;
    if (drag.current && !drag.current.moved && Math.hypot(p.x - drag.current.x, p.y - drag.current.y) > 4) {
      drag.current.moved = true;
      sendInput(taskId, { kind: 'mouse', action: 'move', x: drag.current.x, y: drag.current.y });
      sendInput(taskId, { kind: 'mouse', action: 'down', x: drag.current.x, y: drag.current.y, button: 'left' });
    }
    sendInput(taskId, { kind: 'mouse', action: 'move', x: p.x, y: p.y });
  };
  const onUp = (e: RPE) => {
    if (!driving || !img.current || !drag.current) return;
    const p = mapPoint(img.current, e.clientX, e.clientY) || { x: drag.current.x, y: drag.current.y };
    const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    if (drag.current.moved) sendInput(taskId, { kind: 'mouse', action: 'up', x: p.x, y: p.y, button: btn });
    else sendInput(taskId, { kind: 'mouse', action: 'click', x: p.x, y: p.y, button: btn });
    drag.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!driving || !img.current) return;
    const p = mapPoint(img.current, e.clientX, e.clientY); if (!p) return;
    sendInput(taskId, { kind: 'mouse', action: 'wheel', x: p.x, y: p.y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
  };
  const onKey = (e: RKE) => {
    if (!driving) return;
    if (e.key === 'Escape') { (e.currentTarget as HTMLElement).blur(); return; }
    e.preventDefault(); e.stopPropagation();
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta'].filter(Boolean) as string[];
    if (e.key.length === 1 && !mods.length) sendInput(taskId, { kind: 'key', action: 'type', text: e.key });
    else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) sendInput(taskId, { kind: 'key', action: 'press', key: [...mods, e.shiftKey && e.key.length > 1 ? 'Shift' : '', e.key].filter(Boolean).join('+') });
  };

  const showImg = has || !!fallback;
  return (
    <>
      {showImg ? <img ref={img} className="frame" alt="Live view of the machine's browser" src={has ? getFrame(taskId)?.src : fallback || undefined} draggable={false} /> : null}
      {driving && (
        <div className="capture" tabIndex={0} data-capture-keys="1" aria-label="Remote browser. Click to interact, Escape to stop typing"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()} />
      )}
    </>
  );
}

function MomentCard({ m, task, machine }: { m: Moment | null; task: Task; machine: Machine | undefined }) {
  const { resolved } = useTheme();
  if (!m || task.status === 'queued' || task.status === 'starting' || m.kind === 'machine') {
    const waking = !m || task.status === 'queued' || task.status === 'starting';
    return (
      <div className="vstate">
        <Dither w={200} h={112} shape="glow" color="--mach" bg="--sunk" alpha={110} animate={waking} theme={resolved} className="bgd" />
        <div className="card">
          <div className="eyebrow"><span className="k machine" />{waking ? 'Machine waking' : 'Machine'}</div>
          <h3>{waking ? `Waking ${machineName(task.machine_id)}` : m?.detail}</h3>
          <p>{machine ? `${machine.backend} · ${machine.specs.cpu} vCPU / ${machine.specs.mem_gb} GB` : 'Picking a machine'}{waking ? ' · the browser appears here as soon as it is up' : ''}</p>
        </div>
      </div>
    );
  }
  const e = m.ev;
  if (m.kind === 'brief') {
    return (
      <div className="vstate"><div className="card" style={{ background: 'transparent', border: 0, boxShadow: 'none' }}>
        <div className="eyebrow"><span className="k you" />Brief · {e.channel || 'web'} · {timeOf(e.at, true)}</div>
        <div className="tgm"><div className="av">R</div><div className="b">{e.text}<small>Ryan · {timeOf(e.at)}</small></div></div>
      </div></div>
    );
  }
  if (m.kind === 'memory.recall') {
    return (
      <div className="vstate"><div className="card">
        <div className="eyebrow"><span className="k memory" />Memory · “{e.query}” · {e.hits?.length ?? 0} hits</div>
        <div className="hits">{(e.hits || []).slice(0, 6).map((h) => <div key={h.id}><b>{h.score.toFixed(2).replace(/^0/, '')}</b><span>{h.text}</span><small>{h.kind || h.source}</small></div>)}</div>
      </div></div>
    );
  }
  return (
    <div className="vstate"><div className="card">
      <div className="eyebrow"><span className={`k ${actorClass(m.actor)}`} />{m.label} · {dur(m.ms)}</div>
      {m.detail && <h3>{m.detail}</h3>}
    </div></div>
  );
}

export function LiveView(p: Props) {
  const { task, machine, tab, cursor } = p;
  const driving = task.control === 'you';
  const live = cursor == null;
  const [termAct, setTermAct] = useState(false);
  useEffect(() => { if (tab === 'terminal') setTermAct(false); }, [tab]);
  const [editUrl, setEditUrl] = useState<string | null>(null);
  const u = splitUrl(p.url);
  const isEnded = ended(task);
  const fallback = artifactUrl(isEnded ? task.receipt_artifact || task.last_frame_artifact : task.last_frame_artifact) || null;

  let view;
  if (tab === 'terminal') {
    view = (
      <>
        {!live && <span className="termnote">Terminal shows the full log · replay moves the browser, steps and log</span>}
        <TerminalView taskId={task.id} interactive={driving && live} onActivity={() => tab !== 'terminal' && setTermAct(true)} />
      </>
    );
  } else if (tab === 'desktop' && machine?.desktop_url) {
    view = <iframe className="desktop-frame" src={machine.desktop_url} title={`${machine.name} desktop`} allow="clipboard-read; clipboard-write" />;
  } else {
    let inner;
    if (!live) {
      inner = p.replaySrc ? <img className="frame" src={p.replaySrc} alt={`Replay at ${dur(cursor!)}`} draggable={false} /> : <MomentCard m={p.replayMoment} task={task} machine={machine} />;
    } else if (isEnded) {
      inner = fallback ? (
        <>
          <img className="frame" src={fallback} alt="Final screenshot" draggable={false} />
          <span className={`receipt-tag ${task.outcome === 'partial' ? 'partial' : task.status !== 'done' || task.outcome === 'failed' ? 'bad' : ''}`}><IReceipt />{task.status === 'done' ? (task.outcome === 'partial' ? 'Partial · proof' : 'Receipt') : task.status === 'cancelled' ? 'Cancelled · last frame' : 'Failed · last frame'}</span>
        </>
      ) : <MomentCard m={p.replayMoment} task={task} machine={machine} />;
    } else {
      inner = <LiveOrCard task={task} machine={machine} driving={driving} fallback={fallback} moment={p.replayMoment} />;
    }
    view = (
      <div className={`vp fill ${driving && live ? 'drive' : ''}`}>
        {inner}
        {!driving && tab === 'browser' && p.curRow && !isEnded && (
          <span className="vp-act"><span className={`k ${actorClass(p.curRow.actor)}`} /><b>{p.curRow.tool}</b> {p.curRow.target}{p.curRow.pending ? <span className="pend"> · {live ? 'running' : 'running at this point'}</span> : p.curRow.result ? ` → ${p.curRow.result}` : ''}</span>
        )}
        {driving && live && (
          <div className="drive-bar">
            <b>You're driving {machineName(task.machine_id)}</b>
            <span className="s">{execName(task.executor)} paused at step {task.step} · click the page, then type · Esc stops typing</span>
            <span className="sp" />
            <button onClick={() => setControl(task, false)}>Hand back <kbd>T</kbd></button>
          </div>
        )}
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: JSX.Element; show: boolean }[] = [
    { id: 'browser', label: 'Browser', icon: <IBrowser size={13} />, show: true },
    { id: 'terminal', label: 'Terminal', icon: <ITerm size={13} />, show: true },
    { id: 'desktop', label: 'Desktop', icon: <IDesktop size={13} />, show: !!machine?.has_desktop && !!machine.desktop_url },
  ];

  return (
    <div className="bw">
      <div className="chrome">
        <div className="tabs" role="tablist" aria-label="Live view">
          {tabs.filter((t) => t.show).map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => p.setTab(t.id)}>
              {t.icon}{t.label}{t.id === 'terminal' && termAct && tab !== 'terminal' && <span className="act" />}
            </button>
          ))}
        </div>
        {tab === 'browser' && (
          <span className="nav" aria-hidden="true"><IBack /><IFwd /><IReload /></span>
        )}
        {tab === 'browser' ? (
          driving && live && editUrl != null ? (
            <form className="url edit" onSubmit={(e) => { e.preventDefault(); const v = editUrl.trim(); if (v) sendInput(task.id, { kind: 'navigate', url: /^[a-z]+:\/\//i.test(v) ? v : `https://${v}` }); setEditUrl(null); }}>
              <IGlobe /><input autoFocus value={editUrl} onChange={(e) => setEditUrl(e.target.value)} onBlur={() => setEditUrl(null)} onKeyDown={(e) => { if (e.key === 'Escape') setEditUrl(null); }} aria-label="Go to address" data-capture-keys="1" />
            </form>
          ) : (
            <div className="url" onClick={() => driving && live && setEditUrl(p.url || '')} title={driving && live ? 'Type an address' : p.url || undefined} style={driving && live ? { cursor: 'text' } : undefined}>
              {u ? <>{u.secure ? <ILock /> : <IGlobe />}<b>{u.host}</b><span className="p">{u.path}</span></> : <span className="dim">{task.status === 'queued' || task.status === 'starting' ? `${machineName(task.machine_id)} · starting` : 'No page yet'}</span>}
            </div>
          )
        ) : (
          <div className="url">
            {tab === 'terminal' ? <ITerm size={12} /> : <IDesktop size={12} />}
            <b>{machineName(task.machine_id)}</b><span className="p">&nbsp;{tab === 'terminal' ? `${task.executor} · pty` : `desktop · ${machine?.backend || ''}`}</span>
          </div>
        )}
        <span className="who">
          {live ? (
            <span className="wtx">{machineName(task.machine_id)} · {tab === 'browser' ? 'Chrome' : tab === 'terminal' ? 'shell' : 'VNC'}</span>
          ) : (
            <span className="rwb"><Pill kind="replay">Replay</Pill><b className="mono">{dur(cursor!)}</b><span className="wtx">of {dur(p.elapsed)}</span><button className="btn sm" onClick={p.goLive}>{isEnded ? 'Latest' : 'Back to live'}</button></span>
          )}
          <button className="ibtn" onClick={() => p.setWide(!p.wide)} aria-label={p.wide ? 'Show side panels' : 'Widen the view'} title={p.wide ? 'Show side panels (F)' : 'Widen the view (F)'}>{p.wide ? <IShrink size={13} /> : <IExpand size={13} />}</button>
        </span>
      </div>
      {view}
    </div>
  );
}

function LiveOrCard({ task, machine, driving, fallback, moment }: { task: Task; machine: Machine | undefined; driving: boolean; fallback: string | null; moment: Moment | null }) {
  const [has, setHas] = useState(() => !!getFrame(task.id));
  useEffect(() => { setHas(!!getFrame(task.id)); return onFrame(task.id, () => setHas(true)); }, [task.id]);
  if (has || fallback) return <LiveFrame taskId={task.id} driving={driving} fallback={fallback} />;
  return <MomentCard m={moment} task={task} machine={machine} />;
}
