import { activeTasks, messageFamiliar, openOverlay, setState, useStore, machineName } from '../store';
import { cycleTheme, useTheme } from '../theme';
import { clock } from '../format';
import { Dither } from './Dither';
import { useNow } from './ui';
import { IChat, IGear, IMemory, IServer, ISearch, ITheme, IWifiOff } from '../icons';

export function Mark({ size = 10, className }: { size?: number; className?: string }) {
  const { resolved } = useTheme();
  return <Dither w={size} h={size} shape="mark" color="--agent" bg="--raised" theme={resolved} className={className} />;
}

export function TopBar() {
  const s = useStore();
  const { mode } = useTheme();
  const now = useNow(1000);
  const act = activeTasks(s);
  const machinesUsed = new Set(act.map((t) => t.machine_id).filter(Boolean)).size;
  const driving = act.find((t) => t.control === 'you');
  const working = s.stats.working ?? act.filter((t) => t.status === 'running').length;
  const waiting = s.needs.length;
  return (
    <header className="top">
      <div className="brand"><Mark />Familiar <small>Desk</small></div>
      <span className="sep" />
      <div className="fleet" aria-label="Fleet summary">
        <span><span className="dot agent" /><b className="num">{act.length}</b>&nbsp;{act.length === 1 ? 'run' : 'runs'} on {machinesUsed} {machinesUsed === 1 ? 'machine' : 'machines'}</span>
        <span className={working ? '' : 'zero'}><span className="dot ok" />{working} working</span>
        <span className={waiting ? '' : 'zero'}><span className="dot you" />{waiting} waiting on you</span>
        {driving && <span className="drv">You're driving {machineName(driving.machine_id)}</span>}
      </div>
      <span className="sp" />
      {s.conn !== 'online' && s.loaded && (
        <span className={`conn ${s.conn === 'offline' ? 'off' : ''}`} title="Live updates paused; reconnecting automatically">
          {s.conn === 'offline' ? <IWifiOff /> : <span className="dot" />}{s.conn === 'offline' ? 'Offline, retrying' : 'Reconnecting'}
        </span>
      )}
      <button className="tbtn msg" onClick={messageFamiliar} aria-label="Message Familiar" title="Message Familiar (C)">
        <IChat /><span className="grow lbl">Message Familiar…</span><kbd>C</kbd>
        {s.unread > 0 && !s.chatOpen && <span className="badge">{s.unread}</span>}
      </button>
      <div className="tgroup">
        <button className="tbtn icon" onClick={() => openOverlay('memory')} aria-label="Memory" title="Memory (M)"><IMemory /><span className="wlbl">Memory</span></button>
        <button className="tbtn icon" onClick={() => openOverlay('machines')} aria-label="Machines" title="Machines"><IServer /><span className="wlbl">Machines</span></button>
        <button className="tbtn icon" onClick={() => openOverlay('settings')} aria-label="Settings" title="Settings"><IGear /><span className="wlbl">Settings</span></button>
      </div>
      <button className="tbtn" onClick={() => setState({ paletteOpen: true })} aria-label="Open command palette"><ISearch /><span className="lbl">Commands</span> <kbd>⌘K</kbd></button>
      <button className="tbtn" onClick={() => cycleTheme()} aria-label={`Theme: ${mode}. Click to change`} title="Theme: system, light, dark"><ITheme /><span className="lbl">{mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark'}</span></button>
      <span className="clock mono">{clock(new Date(now))}</span>
    </header>
  );
}
