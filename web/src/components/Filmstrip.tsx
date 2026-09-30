import { useEffect, useRef, useState } from 'react';
import type { Moment } from '../timeline';
import { artifactUrl } from '../api';
import { dur } from '../format';
import { actorClass } from './ui';

interface Props {
  moments: Moment[];
  selIdx: number;            // index of the selected moment (-1 none)
  cursor: number | null;
  elapsed: number;           // total ms of the run so far
  live: boolean;
  ended: boolean;
  driving: boolean;
  onPick: (i: number) => void;
  onScrub: (ms: number) => void;
  goLive: () => void;
  cells: number;
}

export function Filmstrip({ moments, selIdx, cursor, elapsed, live, ended, driving, onPick, onScrub, goLive, cells }: Props) {
  const n = moments.length;
  // window of cells: live shows the latest; rewound keeps the selection in view
  let start = Math.max(0, n - cells);
  if (!live && selIdx >= 0) start = Math.min(Math.max(0, selIdx - Math.floor(cells * 0.6)), Math.max(0, n - cells));
  const shown = moments.slice(start, start + cells);

  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const total = Math.max(elapsed, 1);
  const msAt = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * total);
  };
  useEffect(() => {
    if (!drag) return;
    const mv = (e: PointerEvent) => onScrub(msAt(e.clientX));
    const up = () => setDrag(false);
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
  }, [drag]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = cursor == null ? 1 : Math.min(1, cursor / total);
  return (
    <>
      <div className="fs">
        {n ? (
          <div className="fs-cells" style={{ gridTemplateColumns: `repeat(${cells},minmax(0,1fr))` }}>
            {shown.map((m, k) => {
              const i = start + k;
              const sel = live ? i === n - 1 && !ended : i === selIdx;
              const after = !live && i > selIdx;
              return (
                <button key={m.key} className={`fs-c ${sel ? 'sel' : ''} ${after ? 'after' : ''}`} onClick={() => onPick(i)} disabled={driving} aria-label={`Rewind to ${dur(m.ms)}: ${m.label}`} title={`${dur(m.ms)} · ${m.label}${m.detail && m.detail !== m.label ? '\n' + m.detail : ''}`}>
                  <span className="th">
                    {m.artifact ? <img src={artifactUrl(m.artifact)} alt="" loading="lazy" /> : <span className="ev"><span className="evd">{m.detail}</span></span>}
                  </span>
                  <span className="fl"><span className={`k ${actorClass(m.actor)}`} /><b>{dur(m.ms)}</b></span>
                  <span className="fcap">{m.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="fs-empty">Screenshots and moments collect here as the run goes. Scrub back to any of them.</div>
        )}
        <button className={`livebtn ${ended ? (live ? 'ended' : 'back') : live ? 'on' : 'back'}`} onClick={goLive} aria-label={ended ? 'Jump to the end' : 'Back to live'}>
          <span className="dot" /><span>{ended ? (live ? 'Ended' : 'End') : live ? (driving ? 'Paused' : 'Live') : 'Go live'}</span><kbd>L</kbd>
        </button>
      </div>
      <div
        className={`scrub ${drag ? 'drag' : ''}`} ref={bar} role="slider" tabIndex={-1} aria-label="Replay position" aria-valuemin={0} aria-valuemax={total} aria-valuenow={cursor ?? total}
        onPointerDown={(e) => { if (driving) return; setDrag(true); onScrub(msAt(e.clientX)); e.preventDefault(); }}
        onPointerMove={(e) => setHover(msAt(e.clientX))} onPointerLeave={() => setHover(null)}
      >
        <span className="track" />
        <span className="prog" style={{ width: `${pos * 100}%` }} />
        {moments.map((m) => <i key={m.key} className={`k ${actorClass(m.actor)}`} style={{ left: `${(m.ms / total) * 100}%` }} />)}
        <span className="head" style={{ left: `${pos * 100}%` }} />
        {(drag || hover != null) && <span className="tip" style={{ left: `${((drag && cursor != null ? cursor : hover ?? 0) / total) * 100}%` }}>{dur(drag && cursor != null ? cursor : hover ?? 0)}</span>}
      </div>
    </>
  );
}
