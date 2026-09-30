import { useEffect, useState } from 'react';
import { activeTasks, kill, newTask, openOverlay, useStore } from '../store';
import { EXECUTORS } from './Chat';

function useEsc(fn: () => void) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') fn(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [fn]);
}

export function NewTaskDialog() {
  const s = useStore();
  const [brief, setBrief] = useState('');
  const [ex, setEx] = useState('');
  const close = () => openOverlay(null);
  useEsc(close);
  const go = async () => { if (!brief.trim()) return; await newTask(brief.trim(), ex || undefined); close(); };
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-label="New task" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <h2>New task</h2>
        <p>Starts a run straight away, skipping the coordinator. Familiar still asks before spending over {`£${(s.settings.approval_threshold_p / 100).toFixed(0)}`}.</p>
        <textarea className="textarea" autoFocus value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. Download my October Hetzner invoices and forward them to accounts@"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } }} />
        <div className="row">
          <div className="seg" role="radiogroup" aria-label="Executor">
            {EXECUTORS.map((x) => <button type="button" key={x.id} className={ex === x.id ? 'on' : ''} onClick={() => setEx(x.id)}>{x.label}</button>)}
          </div>
          <span className="sp" />
          <button type="button" className="btn ghost" onClick={close}>Cancel</button>
          <button type="submit" className="btn pri" disabled={!brief.trim()}>Start run <kbd>⌘↵</kbd></button>
        </div>
      </form>
    </div>
  );
}

export function KillDialog() {
  const s = useStore();
  const act = activeTasks(s);
  const machines = Object.values(s.machines).filter((m) => m.status !== 'offline' && m.status !== 'sleeping');
  const close = () => openOverlay(null);
  useEsc(close);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label="Kill switch">
        <h2>Stop everything?</h2>
        <p>Cancels every run and stops every machine now. Machines keep their disks, so you can start them again. Nothing is paid or sent after this.</p>
        <ul>
          <li>{act.length} {act.length === 1 ? 'run' : 'runs'} cancelled{act.length ? `: ${act.map((t) => t.num).join(', ')}` : ''}</li>
          <li>{machines.length} {machines.length === 1 ? 'machine' : 'machines'} stopped{machines.length ? `: ${machines.map((m) => m.name).join(', ')}` : ''}</li>
        </ul>
        <div className="row">
          <button className="btn ghost" onClick={close} autoFocus>Keep running</button>
          <button className="btn danger solid" onClick={async () => { await kill(); close(); }}>Stop all runs and machines</button>
        </div>
      </div>
    </div>
  );
}
