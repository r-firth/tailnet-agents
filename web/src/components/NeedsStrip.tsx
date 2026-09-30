import { useEffect, useRef, useState } from 'react';
import { answer, focus, splitAsk, useStore } from '../store';
import type { NeedsYou } from '../types';
import { ICheck, ISend } from '../icons';
import { ago } from '../format';

/** "Approve and never ask for Northline Rail" reads long on a button; say it the short way. */
const optLabel = (l: string) => l.replace(/^Approve and never ask (?:again )?for /i, 'Always approve ');

function Ask({ n, sent, leaving, focused }: { n: NeedsYou; sent?: string; leaving?: boolean; focused: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (!sent) setBusy(null); }, [sent]);
  if (sent) {
    return (
      <article className={`ask sent ${n.kind} ${leaving ? 'leaving' : ''}`} aria-live="polite">
        <div className="rcpt"><span className="tick"><ICheck size={12} /></span><b>{sent}</b><span>· run {n.task_num}, {n.task_title}. It carries on.</span></div>
      </article>
    );
  }
  // "£42.40 over your £100 line · rest": the over-line part is the reason it's asking
  const [lead, ...rest] = (n.detail || '').split(' · ');
  const overLine = n.kind === 'approval' && /over/i.test(lead);
  const { ask, more } = n.kind === 'question' ? splitAsk(n.title) : { ask: n.title, more: '' };
  // question details repeat the run title and its current step; the run tag already says that
  const detail = overLine ? rest.join(' · ') : n.kind === 'question' ? more : n.detail;
  const pick = (id: string, label: string, t?: string) => { setBusy(id); answer(n, id, label, t); };
  const submitText = () => { const t = text.trim(); if (!t) return; pick('text', `“${t}”`, t); setText(''); };
  return (
    <article className={`ask ${n.kind} ${leaving ? 'leaving' : ''} ${focused ? 'here' : ''}`} aria-label={`${n.kind === 'approval' ? 'Approval' : 'Question'} from run ${n.task_num}`}>
      <button className="txt" onClick={() => focus(n.task_id)} title={`Show run ${n.task_num}`}>
        <b className="q">{ask}</b>
        <span className="l2">
          {overLine && <span className="over">{lead}</span>}
          <span className="tag">run <span className="mono">{n.task_num}</span> {n.task_title} · {ago(n.created_at)}</span>
          {detail && <span className="dt">{detail}</span>}
        </span>
      </button>
      <div className="acts">
        {n.options.map((o) => (
          <button key={o.id} className={`btn ${o.style === 'primary' ? 'pri' : o.style === 'quiet' ? 'ghost quiet' : ''} ${busy === o.id ? 'busy' : ''}`} disabled={!!busy} onClick={() => pick(o.id, o.label)} title={o.label}>{optLabel(o.label)}</button>
        ))}
        {n.allow_text && (
          <form className="qin" onSubmit={(e) => { e.preventDefault(); submitText(); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type…" aria-label="Answer in your own words" disabled={!!busy} />
            <button type="submit" aria-label="Send answer" disabled={!text.trim() || !!busy}><ISend size={13} /></button>
          </form>
        )}
      </div>
    </article>
  );
}

/** Keeps items that just left the list for a moment, so they can animate out instead of vanishing. */
function useLeaving<T extends { id: string }>(items: T[], ms = 260): { item: T; leaving: boolean }[] {
  const [gone, setGone] = useState<T[]>([]);
  const prev = useRef<T[]>(items);
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    const left = prev.current.filter((i) => !ids.has(i.id));
    prev.current = items;
    if (!left.length) return;
    setGone((g) => [...g.filter((x) => !ids.has(x.id)), ...left]);
    const t = setTimeout(() => setGone((g) => g.filter((x) => !left.includes(x))), ms);
    return () => clearTimeout(t);
  }, [items, ms]);
  return [...items.map((item) => ({ item, leaving: false })), ...gone.filter((g) => !items.some((i) => i.id === g.id)).map((item) => ({ item, leaving: true }))];
}

export function NeedsStrip() {
  const s = useStore();
  const items = s.needs;
  const pending = items.filter((n) => !s.answered[n.id]);
  const n = pending.length;
  // approvals first, then oldest first
  const sorted = [...items].sort((a, b) => (a.kind === b.kind ? a.created_at.localeCompare(b.created_at) : a.kind === 'approval' ? -1 : 1));
  const shown = sorted.slice(0, 3);
  const extra = sorted.length - shown.length;
  const rows = useLeaving(shown);
  const lastSent = useRef<string | null>(null);
  const answeredLabels = Object.values(s.answered);
  if (answeredLabels.length) lastSent.current = answeredLabels[answeredLabels.length - 1];
  return (
    <section className={`needs ${rows.length ? '' : 'calm'}`} aria-label="Needs you">
      <div className="nlabel"><b className={`num ${n ? '' : 'zero'}`}>{n}</b><span>{n ? (n === 1 ? 'needs you' : 'need you') : 'all clear'}</span></div>
      {rows.length ? (
        <div className="asks">
          {rows.map(({ item, leaving }) => <Ask key={item.id} n={item} sent={s.answered[item.id] || (leaving ? lastSent.current || 'Answered' : undefined)} leaving={leaving} focused={item.task_id === s.focusId} />)}
          {extra > 0 && <button className="ask more" onClick={() => focus(sorted[3].task_id)}>+{extra} more</button>}
        </div>
      ) : (
        <div className="clear"><span className="ok-dot"><ICheck size={11} /></span>Nothing needs you. Runs carry on by themselves and ask here or on Telegram when they do.</div>
      )}
    </section>
  );
}
