import { useEffect } from 'react';
import { openOverlay } from '../store';
import { IX } from '../icons';

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  { title: 'Runs', keys: [[['1', '–', '4'], 'Show a live run'], [['J'], 'Next run'], [['K'], 'Previous run'], [['F'], 'Widen the view'], [['Z'], 'Fit the page to the width']] },
  { title: 'Replay', keys: [[['←'], 'Back one moment'], [['→'], 'Forward one moment'], [['L'], 'Back to live']] },
  { title: 'Control', keys: [[['T'], 'Take control or hand back'], [['Esc'], 'Stop typing into the machine']] },
  { title: 'Everywhere', keys: [[['⌘', 'K'], 'Commands and search'], [['/'], 'Search'], [['C'], 'Message Familiar'], [['M'], 'Memory'], [['?'], 'This list']] },
];

export function KeysDialog() {
  const close = () => openOverlay(null);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); close(); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="kh"><h2>Keyboard</h2><span className="sp" /><button className="btn ghost sm" onClick={close} aria-label="Close"><IX /></button></div>
        <div className="kgrid">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              {g.keys.map(([ks, what]) => (
                <div className="krow" key={what}><span>{what}</span><span className="kk">{ks.map((k, i) => (k === '–' ? <i key={i}>–</i> : <kbd key={i}>{k}</kbd>))}</span></div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
