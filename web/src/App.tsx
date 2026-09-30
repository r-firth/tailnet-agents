import { useEffect } from 'react';
import { activeTasks, finishedTasks, focus, getState, openChat, openOverlay, setState, useStore } from './store';
import { ignoreKey } from './keys';
import { useTheme } from './theme';
import { TopBar } from './components/TopBar';
import { NeedsStrip } from './components/NeedsStrip';
import { Focus } from './components/Focus';
import { Rail } from './components/Rail';
import { Footer } from './components/Footer';
import { Chat } from './components/Chat';
import { Palette } from './components/Palette';
import { MemoryView } from './components/MemoryView';
import { MachinesView } from './components/MachinesView';
import { SettingsView } from './components/SettingsView';
import { KillDialog, NewTaskDialog } from './components/Dialogs';
import { EmptyState } from './components/EmptyState';
import { Dither } from './components/Dither';
import { IChat } from './icons';
import { KeysDialog } from './components/KeysDialog';

function AuthGate() {
  return (
    <div className="authgate">
      <div className="dialog">
        <h2>This Desk needs its token</h2>
        <p>Open the link Familiar sent you on Telegram (it ends in <span className="mono">?token=…</span>), or ask the bot for <span className="mono">/desk</span>. The token is then remembered on this device.</p>
      </div>
    </div>
  );
}

export function App() {
  const s = useStore();
  const { resolved } = useTheme();

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const st = getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setState({ paletteOpen: !st.paletteOpen }); return; }
      if (ignoreKey(e)) return;
      const k = e.key.toLowerCase();
      if (['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); const t = activeTasks(st)[+e.key - 1]; if (t) focus(t.id); }
      else if (k === 'c') { e.preventDefault(); openChat(!st.chatOpen); }
      else if (k === 'm') { e.preventDefault(); openOverlay('memory'); }
      else if (k === '/') { e.preventDefault(); setState({ paletteOpen: true }); }
      else if (e.key === '?') { e.preventDefault(); openOverlay('keys'); }
      else if (k === 'j' || k === 'k') {
        // walk every run, live ones first, like the rail reads
        e.preventDefault();
        const all = [...activeTasks(st), ...finishedTasks(st)];
        if (!all.length) return;
        const i = all.findIndex((t) => t.id === st.focusId);
        const next = all[Math.max(0, Math.min(all.length - 1, (i < 0 ? 0 : i) + (k === 'j' ? 1 : -1)))];
        if (next) focus(next.id);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // the tab says when something is waiting for you
  const waiting = s.needs.filter((n) => !s.answered[n.id]).length;
  useEffect(() => { document.title = waiting ? `(${waiting}) Familiar` : 'Familiar'; }, [waiting]);

  if (s.authError && !s.loaded) return <AuthGate />;
  const task = s.focusId ? s.tasks[s.focusId] : null;
  const noTasks = s.loaded && Object.keys(s.tasks).length === 0;
  const others = activeTasks(s).filter((t) => t.id !== s.focusId).length;

  return (
    <div className={`app ${s.chatOpen ? 'chat-open' : ''}`}>
      <TopBar />
      <NeedsStrip />
      <main className={`desk ${others ? '' : 'solo'}`}>
        {!s.loaded ? (
          <section className="focus"><div className="loading"><Dither w={48} h={12} shape="wave" color="--agent" animate theme={resolved} />Connecting to Familiar…</div></section>
        ) : noTasks || !task ? <EmptyState /> : <Focus key={task.id} task={task} />}
        <Rail />
      </main>
      <Footer />
      <div className="mobile-compose">
        <button onClick={() => openChat(true)}><IChat />Message Familiar…{s.unread > 0 && <span className="badge">{s.unread}</span>}</button>
      </div>
      <Chat />
      <Palette />
      {s.overlay === 'memory' && <MemoryView />}
      {s.overlay === 'machines' && <MachinesView />}
      {s.overlay === 'settings' && <SettingsView />}
      {s.overlay === 'newtask' && <NewTaskDialog />}
      {s.overlay === 'kill' && <KillDialog />}
      {s.overlay === 'keys' && <KeysDialog />}
      <div className="toasts" aria-live="polite">{s.toast && <div className="toast" role="status" key={s.toast.id}>{s.toast.text}</div>}</div>
    </div>
  );
}
