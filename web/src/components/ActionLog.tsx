import { useEffect, useRef, useState } from 'react';
import type { LogRow } from '../timeline';
import { tplus } from '../format';

interface Props { rows: LogRow[]; cursor: number | null; curKey: string | null; onSeek: (ms: number) => void; driving: boolean }

export function ActionLog({ rows, cursor, curKey, onSeek, driving }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [faded, setFaded] = useState(false);
  const live = cursor == null;
  useEffect(() => {
    const el = box.current; if (!el) return;
    if (live) { if (stick.current) el.scrollTop = el.scrollHeight; setFaded(el.scrollTop > 2); return; }
    const cur = el.querySelector<HTMLElement>('.lr.cur') || [...el.querySelectorAll<HTMLElement>('.lr:not(.after)')].pop();
    if (cur) el.scrollTop = Math.max(0, cur.offsetTop - el.offsetTop - el.clientHeight + 40);
  }, [rows.length, cursor, live, curKey]);
  const before = live ? rows.length : rows.filter((r) => r.ms <= cursor!).length;
  return (
    <div className="log">
      <div className="sh">Action log<span className={`aux ${live ? '' : 'rw'}`}>{live ? `${rows.length} calls` : `as of ${tplus(cursor!).replace('.', ':')} · ${before} of ${rows.length}`}</span><span className="sp" /><span className="aux">t+ · tool · target · result · ms</span></div>
      <div className={`lg ${faded ? 'faded' : ''}`} ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; setFaded(el.scrollTop > 2); }}>
        {rows.length === 0 && <div className="none">No tool calls yet.</div>}
        {rows.map((r) => {
          const after = !live && r.ms > cursor!;
          const cur = r.key === curKey;
          return (
            <button key={r.key} className={`lr ${r.actor} ${after ? 'after' : ''} ${cur ? 'cur' : ''} ${r.pending ? 'pend' : ''}`} onClick={() => !driving && onSeek(r.ms)} title={`${r.tool} ${r.target}${r.result ? ' → ' + r.result : ''}`}>
              <span className="t">{tplus(r.ms)}</span>
              <span className="tool">{r.tool}</span>
              <span>{r.target}</span>
              <span className={`res ${r.status === 'error' ? 'err' : ''}`}>{r.pending ? 'running…' : r.result}</span>
              <span className="ms">{r.dur != null ? r.dur.toLocaleString('en-GB') : '--'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
