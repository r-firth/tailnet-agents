import { useState } from 'react';
import { answer, focus, useStore } from '../store';
import type { NeedsYou } from '../types';
import { useTheme } from '../theme';
import { Dither } from './Dither';
import { ICheck, ISend } from '../icons';
import { ago } from '../format';

function Ask({ n, sent }: { n: NeedsYou; sent?: string }) {
  const [text, setText] = useState('');
  if (sent) {
    return (
      <article className={`ask sent ${n.kind}`}>
        <div className="rcpt"><ICheck /><b>{sent}</b><span>· run {n.task_num} {n.task_title}</span></div>
      </article>
    );
  }
  // split "£42.40 over your £100 line · rest" so the over-line part reads as the reason
  const [lead, ...rest] = (n.detail || '').split(' · ');
  const overLine = n.kind === 'approval' && /over/i.test(lead);
  const submitText = () => { const t = text.trim(); if (!t) return; answer(n, 'text', `“${t}”`, t); setText(''); };
  return (
    <article className={`ask ${n.kind}`} aria-label={`${n.kind === 'approval' ? 'Approval' : 'Question'} from run ${n.task_num}`}>
      <button className="txt" onClick={() => focus(n.task_id)} title={`Focus run ${n.task_num}`}>
        <div className="l1">
          <b>{n.title}</b>
          <span className="tag">{overLine && <span className="over" style={{ color: 'var(--you)' }}>{lead} · </span>}run <span className="mono">{n.task_num}</span> {n.task_title}</span>
        </div>
        <div className="l2">{overLine ? rest.join(' · ') : n.detail}{' '}<span className="age">· {ago(n.created_at)}</span></div>
      </button>
      <div className="acts">
        {n.options.map((o) => (
          <button key={o.id} className={`btn ${o.style === 'primary' ? 'pri' : o.style === 'quiet' ? 'ghost' : ''}`} onClick={() => answer(n, o.id, o.label)} style={o.style === 'quiet' ? { padding: '0 8px' } : undefined}>{o.label}</button>
        ))}
        {n.allow_text && (
          <form className="qin" onSubmit={(e) => { e.preventDefault(); submitText(); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type an answer…" aria-label="Answer in your own words" />
            <button type="submit" aria-label="Send answer" disabled={!text.trim()}><ISend size={13} /></button>
          </form>
        )}
      </div>
    </article>
  );
}

export function NeedsStrip() {
  const s = useStore();
  const { resolved } = useTheme();
  const items = s.needs;
  const pending = items.filter((n) => !s.answered[n.id]);
  const n = pending.length;
  // approvals first, then oldest first
  const sorted = [...items].sort((a, b) => (a.kind === b.kind ? a.created_at.localeCompare(b.created_at) : a.kind === 'approval' ? -1 : 1));
  const shown = sorted.slice(0, 3);
  const extra = sorted.length - shown.length;
  return (
    <section className="needs" aria-label="Needs you">
      <div className="nlabel"><b className={`num ${n ? '' : 'zero'}`}>{n}</b><span>{n ? (n === 1 ? 'needs you' : 'need you') : 'all clear'}</span></div>
      {items.length ? (
        <div className="asks">
          {shown.map((x) => <Ask key={x.id} n={x} sent={s.answered[x.id]} />)}
          {extra > 0 && <button className="ask more" onClick={() => focus(sorted[3].task_id)}>+{extra} more</button>}
        </div>
      ) : (
        <div className="clear"><Dither w={60} h={12} shape="wave" color="--you" alpha={200} theme={resolved} />Nothing needs you. Runs carry on by themselves and ask here or on Telegram when they need you.</div>
      )}
    </section>
  );
}
