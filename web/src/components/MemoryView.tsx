import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { getState, openOverlay, seekTo, setState, toast, useStore, focus } from '../store';
import type { Claim, Message, TaskEvent } from '../types';
import { ago, timeOf } from '../format';
import { ISearch, IX, IWhy, IEdit, ITrash, IArrowR } from '../icons';
import { Bar, actorClass } from './ui';

const KINDS = ['fact', 'preference', 'rule', 'procedure', 'account', 'subscription', 'person', 'episode'];
const STATES: { id: string; label: string }[] = [{ id: 'active', label: 'Active' }, { id: 'superseded', label: 'Superseded' }, { id: 'disputed', label: 'Disputed' }, { id: 'forgotten', label: 'Forgotten' }, { id: '', label: 'All states' }];

interface Why { claim: Claim; evidence: (TaskEvent | Message)[]; history: Claim[] }
interface MemStats { nodes: number; edges: number; vectors: number; claims: number }

const isMsg = (x: TaskEvent | Message): x is Message => 'role' in x;

function evText(e: TaskEvent): string {
  switch (e.kind) {
    case 'memory.write': return `${e.op === 'supersede' ? 'Superseded' : e.op === 'forget' ? 'Forgot' : 'Wrote'}: ${e.text}`;
    case 'memory.recall': return `Recalled for “${e.query}”`;
    default: return e.text || e.summary || e.kind;
  }
}

function Detail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [why, setWhy] = useState<Why | null>(null);
  const [err, setErr] = useState(false);
  const [fix, setFix] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const load = useCallback(() => { setErr(false); api.get<Why>(`/memory/${id}`).then(setWhy).catch(() => setErr(true)); }, [id]);
  useEffect(() => { setWhy(null); setFix(null); setArmed(false); load(); }, [load]);
  if (err) return <div className="mdet"><div className="empty-note">Couldn't load this claim.</div></div>;
  if (!why) return <div className="mdet"><div className="empty-note">Loading…</div></div>;
  const c = why.claim;
  const tasks = getState().tasks;
  const forget = async () => {
    if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 3500); return; }
    try { await api.post(`/memory/${c.id}/forget`); toast('Forgotten. Familiar will not use it again.'); load(); onChanged(); } catch (e) { toast(`Failed: ${(e as Error).message}`); }
  };
  const correct = async () => {
    const t = (fix || '').trim(); if (!t) return;
    try { const r = await api.post<{ claim: Claim }>(`/memory/${c.id}/correct`, { text: t }); toast('Corrected. The old claim is kept as history.'); setFix(null); onChanged(); setState({ memoryClaim: r.claim.id }); } catch (e) { toast(`Failed: ${(e as Error).message}`); }
  };
  const chain = [...why.history, c].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (
    <div className="mdet">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`kt ${c.kind}`}>{c.kind}</span>{c.state !== 'active' && <span className={`st-tag ${c.state}`}>{c.state}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setState({ memoryClaim: null })} aria-label="Close detail"><IX /></button>
      </div>
      <div className="big">{c.text}</div>
      <div className="fields">
        <span>Subject</span><b>{c.subject || '—'}</b>
        <span>Confidence</span><b className="conf">{c.confidence.toFixed(2)}<Bar pct={c.confidence * 100} /></b>
        <span>Salience</span><b className="conf">{c.salience.toFixed(2)}<Bar pct={c.salience * 100} /></b>
        <span>Source</span><b>{c.source?.label || '—'}{c.source?.task_id && tasks[c.source.task_id] ? <> · <a href="#" onClick={(e) => { e.preventDefault(); openOverlay(null); focus(c.source!.task_id!); }}>run {tasks[c.source.task_id].num}</a></> : null}</b>
        <span>Learned</span><b>{new Date(c.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</b>
        <span>Id</span><b className="mono">#{c.id}</b>
      </div>
      <div className="acts2">
        {fix == null ? <button className="btn sm" onClick={() => setFix(c.text)} disabled={c.state === 'forgotten'}><IEdit />Correct</button> : null}
        <button className={`btn sm ${armed ? 'danger solid' : 'danger'}`} onClick={forget} disabled={c.state === 'forgotten'}><ITrash />{armed ? 'Really forget?' : 'Forget'}</button>
      </div>
      {fix != null && (
        <form className="correct" onSubmit={(e) => { e.preventDefault(); correct(); }}>
          <input autoFocus value={fix} onChange={(e) => setFix(e.target.value)} aria-label="Corrected text" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFix(null); } }} />
          <button className="btn sm pri" type="submit">Save</button>
        </form>
      )}
      <div>
        <div className="sh"><IWhy />&nbsp;Why Familiar believes this<span className="aux">{why.evidence.length} {why.evidence.length === 1 ? 'piece' : 'pieces'} of evidence</span></div>
        <div className="ev-list">
          {why.evidence.length === 0 && <div className="mem"><div className="none">No linked evidence. It came from “{c.source?.label || 'an import'}”.</div></div>}
          {why.evidence.map((x, i) => isMsg(x) ? (
            <div key={'m' + i} className="ev-i"><span className="k you" /><span>“{x.text}”</span><small>{x.role === 'user' ? 'You' : 'Familiar'} on {x.channel} · {ago(x.at)}</small></div>
          ) : (
            <button key={'e' + x.id} className="ev-i" onClick={() => { openOverlay(null); seekTo(x.task_id, x.ms); }}>
              <span className={`k ${actorClass(x.actor)}`} /><span>{evText(x)}</span>
              <small>run {tasks[x.task_id]?.num ?? '?'} · {timeOf(x.at)} · {ago(x.at)} <IArrowR size={9} /></small>
            </button>
          ))}
        </div>
      </div>
      {chain.length > 1 && (
        <div>
          <div className="sh">History<span className="aux">supersede chain, oldest first</span></div>
          <div className="chain">
            {chain.map((h) => (
              <div key={h.id} className={h.id === c.id ? 'cur' : h.state === 'superseded' ? 'old' : ''} style={{ cursor: h.id === c.id ? 'default' : 'pointer' }} onClick={() => h.id !== c.id && setState({ memoryClaim: h.id })}>
                {h.text}<small>{h.source?.label || ''} · {ago(h.created_at)}{h.state !== 'active' ? ` · ${h.state}` : ''}</small>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function MemoryView() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [state, setStateF] = useState('active');
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [stats, setStats] = useState<MemStats | null>(null);
  const [tick, setTick] = useState(0);
  const sel = s.memoryClaim;
  const close = () => openOverlay(null, { memoryClaim: null });

  useEffect(() => {
    const id = setTimeout(() => {
      const p = new URLSearchParams(); if (q.trim()) p.set('q', q.trim()); if (state) p.set('state', state);
      api.get<{ claims: Claim[]; stats: MemStats }>(`/memory?${p}`).then((r) => { setClaims(r.claims || []); setStats(r.stats || null); }).catch(() => setClaims([]));
    }, 120);
    return () => clearTimeout(id);
  }, [q, state, tick]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.correct')) { if (getState().memoryClaim != null) setState({ memoryClaim: null }); else close(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => { const c: Record<string, number> = {}; (claims || []).forEach((x) => { c[x.kind] = (c[x.kind] || 0) + 1; }); return c; }, [claims]);
  const shown = (claims || []).filter((c) => !kind || c.kind === kind);
  return (
    <div className="scrim sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Memory">
        <div className="sheet-h">
          <h2>Memory</h2>
          <span className="aux">{stats ? `vecgra · ${stats.nodes.toLocaleString('en-GB')} nodes · ${stats.edges.toLocaleString('en-GB')} edges · ${stats.vectors.toLocaleString('en-GB')} vectors · ${stats.claims} claims` : 'vecgra'}</span>
          <span className="sp" />
          <label className="search"><ISearch /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search what Familiar knows…" aria-label="Search memory" /></label>
          <button className="btn ghost sm" onClick={close} aria-label="Close memory"><IX /></button>
        </div>
        <div className={`sheet-b memv ${sel == null ? 'nosel' : ''}`}>
          <nav className="mside" aria-label="Filters">
            <div className="grp">
              <div className="gl">Kind</div>
              <button className={kind === '' ? 'on' : ''} onClick={() => setKind('')}>All kinds<span className="c">{claims?.length ?? ''}</span></button>
              {KINDS.map((k) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}><span className={`k ${k === 'rule' ? 'you' : k === 'preference' ? 'browser' : k === 'procedure' ? 'term' : k === 'subscription' || k === 'account' ? 'memory' : 'machine'}`} />{k}<span className="c">{counts[k] || 0}</span></button>)}
            </div>
            <div className="grp">
              <div className="gl">State</div>
              {STATES.map((x) => <button key={x.id} className={state === x.id ? 'on' : ''} onClick={() => setStateF(x.id)}>{x.label}</button>)}
            </div>
          </nav>
          <div className="mlist">
            <div className="mrow hd"><span>Kind</span><span>Claim</span><span>Confidence</span><span>Sal.</span><span>Source</span><span style={{ textAlign: 'right' }}>Age</span></div>
            {claims == null && <div className="empty-note">Loading…</div>}
            {claims != null && shown.length === 0 && <div className="empty-note">{q ? `Nothing in memory matches “${q}”.` : 'No claims here yet. Familiar writes memories as runs finish, and you can correct them here.'}</div>}
            {shown.map((c) => (
              <button key={c.id} className={`mrow ${c.state} ${sel === c.id ? 'on' : ''}`} onClick={() => setState({ memoryClaim: c.id })}>
                <span className={`kt ${c.kind}`}>{c.kind}</span>
                <span className="tx">{c.text}{c.state !== 'active' && <span className={`st-tag ${c.state}`}>{c.state}</span>}{c.subject && <small>{c.subject}{c.superseded_by ? ` · superseded by #${c.superseded_by}` : ''}</small>}</span>
                <span className="conf">{c.confidence.toFixed(2)}<Bar pct={c.confidence * 100} /></span>
                <span className="num">{c.salience.toFixed(2)}</span>
                <span className="src">{c.source?.label || '—'}</span>
                <span className="ag">{ago(c.created_at).replace(' ago', '')}</span>
              </button>
            ))}
          </div>
          {sel != null && <Detail id={sel} onChanged={() => setTick((x) => x + 1)} />}
        </div>
      </div>
    </div>
  );
}
