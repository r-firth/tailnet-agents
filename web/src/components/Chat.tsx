import { useEffect, useRef, useState } from 'react';
import { focus, openChat, sendMessage, useDocked, useStore, getState } from '../store';
import type { Message } from '../types';
import { timeOf } from '../format';
import { ISend, ITelegram, IX, IArrowR, IChat } from '../icons';
import { Mark } from './TopBar';
import { Md } from '../md';

export const EXECUTORS: { id: string; label: string }[] = [
  { id: '', label: 'Auto' }, { id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }, { id: 'scripted', label: 'Scripted' },
];
const EXKEY = 'familiar.executor';

export function Composer({ autoFocus, placeholder, onSent, big }: { autoFocus?: boolean; placeholder?: string; onSent?: () => void; big?: boolean }) {
  const [text, setText] = useState('');
  const [ex, setEx] = useState(() => { try { return localStorage.getItem(EXKEY) || ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) ta.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = Math.min(160, el.scrollHeight) + 'px';
  }, [text]);
  // allow suggestion chips elsewhere to fill the composer
  useEffect(() => {
    const f = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      setText(v);
      requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } });
    };
    window.addEventListener('familiar:compose', f);
    return () => window.removeEventListener('familiar:compose', f);
  }, []);
  const setExec = (v: string) => { setEx(v); try { localStorage.setItem(EXKEY, v); } catch { /* ignore */ } };
  const submit = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true);
    const ok = await sendMessage(t, ex || undefined);
    setBusy(false);
    if (ok) { setText(''); onSent?.(); }
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea ref={ta} rows={big ? 2 : 1} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder || 'Ask Familiar to do something…'}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } if (e.key === 'Escape') (e.target as HTMLElement).blur(); }}
        aria-label="Message to Familiar" />
      <div className="cb">
        <div className="seg" role="radiogroup" aria-label="Executor">
          {EXECUTORS.map((x) => <button type="button" key={x.id} role="radio" aria-checked={ex === x.id} className={ex === x.id ? 'on' : ''} onClick={() => setExec(x.id)}>{x.label}</button>)}
        </div>
        <span className="hint">Enter to send · Shift+Enter for a new line</span>
        <button className="send" type="submit" disabled={!text.trim() || busy} aria-label="Send"><ISend /></button>
      </div>
    </form>
  );
}

function dayOf(iso: string) {
  const d = new Date(iso); const t = new Date();
  const same = d.toDateString() === t.toDateString();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  return same ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function Bubble({ m }: { m: Message }) {
  const s = getState();
  const t = m.task_id ? s.tasks[m.task_id] : null;
  return (
    <div className={`bub ${m.role}`}>
      {m.role === 'assistant' ? <Md className="tx" text={m.text} /> : <div className="tx">{m.text}</div>}
      <div className="mt">
        {m.channel === 'telegram' && <><ITelegram />Telegram ·</>}
        {m.channel === 'web' && <>Web ·</>}
        <span>{timeOf(m.at)}</span>
        {t && <button className="runlink" onClick={() => { focus(t.id); if (window.innerWidth < 820) openChat(false); }}>run {t.num}<IArrowR size={10} /></button>}
      </div>
    </div>
  );
}

export function Chat() {
  const s = useStore();
  const docked = useDocked();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = body.current; if (el) el.scrollTop = el.scrollHeight; }, [s.messages.length, s.typing, s.chatOpen]);
  useEffect(() => {
    if (!s.chatOpen || docked) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !getState().paletteOpen && !getState().overlay) openChat(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [s.chatOpen, docked]);
  if (!s.chatOpen && !docked) return null;
  let lastDay = '';
  return (
    <aside className={`chat ${docked ? 'docked' : ''}`} role={docked ? 'complementary' : 'dialog'} aria-label="Conversation with Familiar">
      <div className="chat-h">
        <span className="av"><Mark /></span>
        <div><b>Familiar</b><small>{s.typing ? 'thinking…' : `coordinator · ${s.settings.coordinator || 'online'} · same thread as Telegram`}</small></div>
        <span className="sp" />
        {!docked && <button className="btn ghost sm" onClick={() => openChat(false)} aria-label="Close chat"><IX /></button>}
      </div>
      <div className="chat-b" ref={body}>
        {s.messages.length === 0 && (
          <div className="chat-empty"><IChat size={20} />Tell Familiar what you need in plain words. It starts a run when one is needed and asks before spending over your line.</div>
        )}
        {s.messages.map((m) => {
          const d = dayOf(m.at);
          const sep = d !== lastDay; lastDay = d;
          return <div key={m.id} style={{ display: 'contents' }}>{sep && <div className="chat-day">{d}</div>}<Bubble m={m} /></div>;
        })}
        {s.typing && <div className="typing" aria-label="Familiar is typing"><i /><i /><i /></div>}
      </div>
      <div className="chat-f"><Composer autoFocus={!docked} /></div>
    </aside>
  );
}
