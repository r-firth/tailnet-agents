import { useStore } from '../store';
import { gbp, tokens } from '../format';

export function Footer() {
  const s = useStore();
  const st = s.stats;
  return (
    <footer className="foot">
      <span>Today</span>
      <span>Spend <b>{gbp(st.spend_today_p)}</b></span>
      <span>Tokens <b>{tokens(st.tokens_today)}</b></span>
      <span>Memory <b>{(st.memory_nodes || 0).toLocaleString('en-GB')}</b> nodes</span>
      <span>Runs <b>{st.runs_today}</b> · {st.runs_done_today} done</span>
      {s.settings.coordinator && <span>Coordinator <b>{s.settings.coordinator}</b></span>}
      <span className="sp" />
      <span className="keys">
        <span><kbd>1</kbd>–<kbd>4</kbd> focus</span>
        <span><kbd>←</kbd><kbd>→</kbd> rewind</span>
        <span><kbd>L</kbd> live</span>
        <span><kbd>T</kbd> take control</span>
        <span><kbd>C</kbd> chat</span>
        <span><kbd>⌘K</kbd> commands</span>
      </span>
    </footer>
  );
}
