import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, artifactUrl } from '../api';
import { activeTasks, answer, finishedTasks, focus, getState, openChat, openOverlay, seekTo, setControl, setState, splitAsk, useStore } from '../store';
import type { SearchResult } from '../types';
import { cycleTheme, useTheme } from '../theme';
import { dayLabel } from '../format';
import { IBrowser, IChat, IGear, IMemory, IPlus, IPower, ISearch, IServer, ITheme, IHand, IPlay, ICheck, IKeys } from '../icons';

interface Item { key: string; group: string; title: string; sub?: string; right?: ReactNode; icon?: ReactNode; thumb?: string; danger?: boolean; run: () => void }

const GROUP_ORDER = ['Needs you', 'Commands', 'Runs', 'Keyframes', 'Timeline', 'Memory', 'Messages'];

export function Palette() {
  const s = useStore();
  const { mode } = useTheme();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const close = () => setState({ paletteOpen: false });

  useEffect(() => { if (s.paletteOpen) { setQ(''); setSel(0); setResults([]); } }, [s.paletteOpen]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const id = setTimeout(() => {
      api.get<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(term)}`)
        .then((r) => setResults(r.results || []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 140);
    return () => clearTimeout(id);
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const st = getState();
    const focused = st.focusId ? st.tasks[st.focusId] : null;
    const cmds: Item[] = [
      { key: 'c-msg', group: 'Commands', title: 'Message Familiar', sub: 'the coordinator, same thread as Telegram', icon: <IChat />, right: <kbd>C</kbd>, run: () => openChat(true) },
      { key: 'c-new', group: 'Commands', title: 'New task', sub: 'start a run directly, skipping the coordinator', icon: <IPlus />, run: () => openOverlay('newtask') },
      { key: 'c-mem', group: 'Commands', title: 'Open memory', sub: 'claims, evidence, corrections', icon: <IMemory />, right: <kbd>M</kbd>, run: () => openOverlay('memory') },
      { key: 'c-mach', group: 'Commands', title: 'Open machines', sub: 'start, fork, back up, stop', icon: <IServer />, run: () => openOverlay('machines') },
      { key: 'c-set', group: 'Commands', title: 'Settings', sub: 'approval line, default executor, no-ask merchants', icon: <IGear />, run: () => openOverlay('settings') },
      { key: 'c-theme', group: 'Commands', title: `Theme: ${mode} → ${mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system'}`, icon: <ITheme />, run: () => cycleTheme() },
    ];
    if (focused && ['running', 'waiting', 'starting'].includes(focused.status)) {
      cmds.splice(2, 0, { key: 'c-ctl', group: 'Commands', title: focused.control ? `Hand back ${focused.title}` : `Take control of run ${focused.num}`, icon: <IHand />, right: <kbd>T</kbd>, run: () => setControl(focused, !focused.control) });
    }
    cmds.push({ key: 'c-keys', group: 'Commands', title: 'Keyboard shortcuts', icon: <IKeys />, right: <kbd>?</kbd>, run: () => openOverlay('keys') });
    cmds.push({ key: 'c-kill', group: 'Commands', title: 'Kill switch', sub: 'cancel every run and stop every machine', icon: <IPower />, danger: true, run: () => openOverlay('kill') });
    // answer what's waiting without leaving the keyboard
    const needs: Item[] = st.needs.filter((n) => !st.answered[n.id]).flatMap((n) => n.options.map((o) => ({
      key: `n-${n.id}-${o.id}`, group: 'Needs you', title: `${o.label}`, sub: `${n.kind === 'question' ? splitAsk(n.title).ask : n.title} · run ${n.task_num}`,
      icon: <ICheck />, run: () => answer(n, o.id, o.label),
    })));
    const act = activeTasks(st);
    const runs: Item[] = [...act, ...finishedTasks(st)].map((t, i) => ({
      key: 'r-' + t.id, group: 'Runs', title: `${t.num} · ${t.title}`, sub: t.status === 'done' || t.status === 'failed' || t.status === 'cancelled' ? (t.summary || t.status) : t.now || t.status,
      icon: <IPlay size={11} />, right: i < 4 && act.includes(t) ? <kbd>{i + 1}</kbd> : <span>{dayLabel(t.created_at)}</span>, run: () => focus(t.id),
    }));
    const ql = q.trim().toLowerCase();
    const match = (it: Item) => !ql || `${it.group} ${it.title} ${it.sub || ''}`.toLowerCase().includes(ql);
    const out: Item[] = [...needs.filter(match), ...cmds.filter(match), ...runs.filter(match).slice(0, ql ? 6 : 8)];
    const seen = new Set(out.map((x) => x.key));
    for (const r of results) {
      const t = r.task_id ? st.tasks[r.task_id] : null;
      const startMs = t ? Date.parse(t.started_at || t.created_at) : 0;
      const ms = t ? Math.max(0, Date.parse(r.at) - startMs) : 0;
      let it: Item | null = null;
      if (r.type === 'task') { if (seen.has('r-' + r.id)) continue; it = { key: 's-' + r.type + r.id, group: 'Runs', title: t ? `${t.num} · ${t.title}` : r.text, sub: t ? r.text : undefined, icon: <IPlay size={11} />, right: dayLabel(r.at), run: () => focus(r.task_id || r.id) }; }
      else if (r.type === 'keyframe') it = { key: 's-k' + r.id, group: 'Keyframes', title: r.text, sub: t ? `run ${t.num}` : undefined, thumb: r.artifact ? artifactUrl(r.artifact) : undefined, icon: <IBrowser />, right: dayLabel(r.at), run: () => t && seekTo(t.id, ms) };
      else if (r.type === 'event') it = { key: 's-e' + r.id, group: 'Timeline', title: r.text, sub: t ? `run ${t.num} · ${t.title}` : undefined, right: dayLabel(r.at), run: () => t && seekTo(t.id, ms) };
      else if (r.type === 'claim') it = { key: 's-c' + r.id, group: 'Memory', title: r.text, icon: <IMemory />, right: dayLabel(r.at), run: () => openOverlay('memory', { memoryClaim: Number(r.id) }) };
      else if (r.type === 'message') it = { key: 's-m' + r.id, group: 'Messages', title: r.text, icon: <IChat />, right: dayLabel(r.at), run: () => openChat(true) };
      if (it) out.push(it);
    }
    return out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }, [q, results, mode, s.tasks, s.needs, s.answered]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setSel((x) => Math.min(x, Math.max(0, items.length - 1))); }, [items.length]);
  useEffect(() => { list.current?.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  if (!s.paletteOpen) return null;
  const run = (it?: Item) => { if (!it) return; close(); it.run(); };
  let lastG = '';
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="pal-box pal" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="pal-in"><ISearch />
          <input ref={input} autoFocus value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} placeholder="Search runs, keyframes, memory, messages… or type a command" autoComplete="off" spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { setSel((x) => Math.min(items.length - 1, x + 1)); e.preventDefault(); }
              else if (e.key === 'ArrowUp') { setSel((x) => Math.max(0, x - 1)); e.preventDefault(); }
              else if (e.key === 'Enter') { run(items[sel]); e.preventDefault(); }
              else if (e.key === 'Escape') { close(); e.preventDefault(); }
            }} aria-controls="pal-list" />
          {searching && <span style={{ fontSize: 11 }}>searching…</span>}
        </div>
        <ul id="pal-list" ref={list} role="listbox">
          {items.map((it, i) => {
            const g = it.group !== lastG ? <li className="g" key={'g' + it.group}>{it.group}</li> : null;
            lastG = it.group;
            return [g, (
              <li key={it.key} role="option" aria-selected={i === sel} className={`it ${i === sel ? 'on' : ''} ${it.danger ? 'danger' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(it)}>
                {it.thumb ? <img src={it.thumb} alt="" /> : <span className="ic">{it.icon}</span>}
                <span className="tx">{it.title}{it.sub && <small>{it.sub}</small>}</span>
                {it.right && <span className="rt">{it.right}</span>}
              </li>
            )];
          })}
          {!items.length && <li className="none">{searching ? 'Searching…' : 'Nothing matches. Try a run number, a site, or something Familiar should remember.'}</li>}
        </ul>
        <div className="foot2"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span style={{ marginLeft: 'auto' }}>searches tasks, timelines, keyframes, memory and messages</span></div>
      </div>
    </div>
  );
}
