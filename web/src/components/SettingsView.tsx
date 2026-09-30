import { useEffect, useState } from 'react';
import { openOverlay, saveSettings, useStore } from '../store';
import { IX } from '../icons';
import { EXECUTORS } from './Chat';

export function SettingsView() {
  const s = useStore();
  const st = s.settings;
  const [pounds, setPounds] = useState(String((st.approval_threshold_p || 0) / 100));
  const [exec, setExec] = useState(st.default_executor || 'claude');
  const [merchants, setMerchants] = useState<string[]>(st.no_ask_merchants || []);
  const [add, setAdd] = useState('');
  const close = () => openOverlay(null);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const p = Math.round(parseFloat(pounds || '0') * 100);
  const dirty = p !== st.approval_threshold_p || exec !== st.default_executor || merchants.join('|') !== (st.no_ask_merchants || []).join('|');
  const addM = () => { const v = add.trim().replace(/,$/, ''); if (v && !merchants.some((m) => m.toLowerCase() === v.toLowerCase())) setMerchants([...merchants, v]); setAdd(''); };
  return (
    <div className="scrim sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings" style={{ width: 'min(860px,100%)' }}>
        <div className="sheet-h">
          <h2>Settings</h2><span className="aux">how much Familiar may do without asking</span>
          <span className="sp" />
          <button className="btn pri sm" disabled={!dirty || !(p >= 0)} onClick={() => saveSettings({ approval_threshold_p: p, default_executor: exec, no_ask_merchants: merchants })}>Save changes</button>
          <button className="btn ghost sm" onClick={close} aria-label="Close settings"><IX /></button>
        </div>
        <div className="sheet-b setv">
          <div className="sec">
            <div><h3>Approval line</h3><div className="d">Payments above this ask you first, here and on Telegram. At or under it, Familiar pays and logs an auto-approval.</div></div>
            <div><label className="money">£<input inputMode="decimal" value={pounds} onChange={(e) => setPounds(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Approval threshold in pounds" /></label></div>
          </div>
          <div className="sec">
            <div><h3>Default executor</h3><div className="d">Which agent drives a run when you don't pick one. The coordinator can still choose Codex for code.</div></div>
            <div className="seg" role="radiogroup" aria-label="Default executor" style={{ alignSelf: 'start', justifySelf: 'start' }}>
              {EXECUTORS.filter((x) => x.id).map((x) => <button key={x.id} role="radio" aria-checked={exec === x.id} className={exec === x.id ? 'on' : ''} onClick={() => setExec(x.id)}>{x.label}</button>)}
            </div>
          </div>
          <div className="sec">
            <div><h3>Never ask for</h3><div className="d">Merchants Familiar may pay without asking, whatever the amount. “Approve and never ask” adds to this list.</div></div>
            <div className="tagin" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
              {merchants.map((m) => <span key={m} className="tg2">{m}<button onClick={() => setMerchants(merchants.filter((x) => x !== m))} aria-label={`Remove ${m}`}><IX size={10} /></button></span>)}
              <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Add a merchant…" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addM(); } else if (e.key === 'Backspace' && !add && merchants.length) setMerchants(merchants.slice(0, -1)); }} onBlur={addM} aria-label="Add a merchant" />
            </div>
          </div>
          <div className="sec">
            <div><h3>Status</h3><div className="d">Read-only. Set with environment variables on the server.</div></div>
            <div className="ro">
              <span>Coordinator</span><b>{st.coordinator || '—'}</b>
              <span>Embedder</span><b>{st.embedder || '—'}</b>
              <span>Telegram</span><b>{st.telegram || '—'}</b>
              <span>Backends</span><b>{(st.backends || []).join(', ') || '—'}</b>
              <span>Live stream</span><b>{s.conn}</b>
            </div>
          </div>
          <div className="sec">
            <div><h3>Kill switch</h3><div className="d">For when something is going wrong. Also in ⌘K.</div></div>
            <div className="danger-zone"><div><b>Stop every run and machine</b>Cancels all runs now; machines keep their disks.</div><button className="btn danger solid" onClick={() => openOverlay('kill')}>Kill switch…</button></div>
          </div>
        </div>
      </div>
    </div>
  );
}
