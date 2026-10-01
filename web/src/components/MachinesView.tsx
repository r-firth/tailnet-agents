import { useEffect, useState } from 'react';
import { focus, machineAction, openOverlay, startMachine, useStore } from '../store';
import type { Machine } from '../types';
import { ago, uptime } from '../format';
import { IX, IBackup, IFork, IStop, IPlay, IPlus } from '../icons';
import { Bar, Spark, Rid } from './ui';

const BACKEND: Record<string, string> = { cloudflare: 'Cloudflare sandbox', docker: 'Docker', local: 'Local process', ssh: 'SSH / Tailscale' };

function Card({ m }: { m: Machine }) {
  const s = useStore();
  const [armed, setArmed] = useState(false);
  const t = m.task_id ? s.tasks[m.task_id] : null;
  const h = s.hist[m.id];
  const on = m.status !== 'offline' && m.status !== 'sleeping';
  const parent = m.parent ? s.machines[m.parent] : null;
  return (
    <div className={`mcard ${m.status === 'busy' ? 'busy' : ''}`}>
      <div className="mh">
        <b>{m.name}</b><span className="bk">{m.backend}</span>
        <span className="sp" />
        <span className={`mstat ${m.status}`}><span className="dot" />{m.status}</span>
      </div>
      <div className="spec">{BACKEND[m.backend] || m.backend} · <b>{m.specs.cpu} vCPU</b> · <b>{m.specs.mem_gb} GB</b> RAM · <b>{m.specs.disk_gb >= 1000 ? `${(m.specs.disk_gb / 1000).toFixed(0)} TB` : `${m.specs.disk_gb} GB`}</b> disk{m.has_desktop ? ' · desktop' : ''}{parent ? <> · fork of <b>{parent.name}</b></> : null}</div>
      {t ? (
        <button className="runon" onClick={() => { openOverlay(null); focus(t.id); }}><Rid n={t.num} /><span className="t">{t.title}</span><span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t.status}</span></button>
      ) : <div className="spec">{on ? 'Idle, ready for a run' : 'Stopped. Disk kept; starts in a few seconds'}</div>}
      <div className="kv" style={{ padding: 0 }}>
        <div className="kvr"><span className="kl">CPU</span><b>{on ? `${m.stats.cpu_pct}%` : '—'}</b><span className="kz"><Spark data={h?.cpu.slice(-40) || []} color={m.status === 'busy' ? 'var(--agent)' : 'var(--muted)'} max={100} /></span></div>
        <div className="kvr"><span className="kl">MEM</span><b>{on ? m.stats.mem_gb.toFixed(1) : '—'} <i>/ {m.specs.mem_gb} GB</i></b><span className="kz"><Bar pct={(m.stats.mem_gb / m.specs.mem_gb) * 100} /></span></div>
        <div className="kvr"><span className="kl">NET</span><b>{on ? m.stats.net_mbs.toFixed(1) : '—'} <i>MB/s</i></b><span className="kz"><Spark data={h?.net.slice(-40) || []} color="var(--mach)" /></span></div>
        <div className="kvr"><span className="kl">Up</span><b>{on ? uptime(m.stats.uptime_s) : '—'}</b><span className="kz" /></div>
      </div>
      {m.installs?.length > 0 && <div className="inst">{m.installs.slice(0, 5).map((x) => <span key={x} title={x}>{x}</span>)}{m.installs.length > 5 && <span style={{ color: 'var(--muted)' }}>+{m.installs.length - 5} more</span>}</div>}
      <div className="mf">
        <small>Backup {ago(m.last_backup_at)}</small>
        <span className="sp" />
        <button className="btn xs" onClick={() => machineAction(m, 'backup')} disabled={!on}><IBackup />Back up</button>
        <button className="btn xs" onClick={() => machineAction(m, 'fork')}><IFork />Fork</button>
        {on ? (
          <button className={`btn xs ${armed ? 'danger solid' : 'danger'}`} onClick={() => { if (armed || !t) { machineAction(m, 'stop'); setArmed(false); } else { setArmed(true); setTimeout(() => setArmed(false), 3500); } }}><IStop size={11} />{armed ? `Stop and cancel run ${t?.num}?` : 'Stop'}</button>
        ) : (
          <button className="btn xs" onClick={() => machineAction(m, 'start')}><IPlay size={10} />Start</button>
        )}
      </div>
    </div>
  );
}

export function MachinesView() {
  const s = useStore();
  const [backend, setBackend] = useState('docker');
  const close = () => openOverlay(null);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ms = Object.values(s.machines).sort((a, b) => (a.status === 'sleeping' || a.status === 'offline' ? 1 : 0) - (b.status === 'sleeping' || b.status === 'offline' ? 1 : 0) || a.name.localeCompare(b.name));
  const backends = s.settings.backends?.length ? s.settings.backends : ['docker', 'cloudflare', 'local', 'ssh'];
  const busy = ms.filter((m) => m.status === 'busy').length;
  return (
    <div className="scrim sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Machines">
        <div className="sheet-h">
          <h2>Machines</h2>
          <span className="aux">{ms.length} machines · {busy} busy · each has its own Chrome, terminal and snapshot</span>
          <span className="sp" />
          <div className="newm">
            <select className="btn sm" value={backend} onChange={(e) => setBackend(e.target.value)} aria-label="Backend for a new machine">
              {backends.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <button className="btn sm pri" onClick={() => startMachine(backend)}><IPlus />Start machine</button>
          </div>
          <button className="btn ghost sm" onClick={close} aria-label="Close machines"><IX /></button>
        </div>
        <div className="sheet-b machv">
          {ms.length === 0 ? <div className="empty-note">No machines yet. Start one, or run agentd on any box and it dials in.</div> : <div className="mgrid">{ms.map((m) => <Card key={m.id} m={m} />)}</div>}
          {s.devices.length > 0 && (
            <div className="devs">
              <h3>Tailnet devices <span className="aux">runs can work on these over Tailscale SSH; ask for "… on hserver"</span></h3>
              <div className="devgrid">
                {s.devices.slice().sort((a, b) => Number(b.ssh) - Number(a.ssh) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)).map((d) => (
                  <div key={d.name} className={`dev ${d.online ? '' : 'off'}`} title={d.dns}>
                    <span className={`dot ${d.online ? 'on' : ''}`} /><b>{d.name}</b><span className="os">{d.os || '—'}</span>{d.ssh && <span className="ssh">SSH</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
