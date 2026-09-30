import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { onTerminal } from '../bus';
import { sendInput } from '../store';

// Terminal content keeps its own dark palette in both themes (it is content,
// like a web page), rendered crisp with the mono UI font.
const THEME = {
  background: '#0c0e11', foreground: '#cfd6dd', cursor: '#cfd6dd', cursorAccent: '#0c0e11', selectionBackground: 'rgba(122,162,255,.35)',
  black: '#1b1f24', red: '#ff8a80', green: '#8fd48a', yellow: '#e6c26a', blue: '#7aa2ff', magenta: '#b495ff', cyan: '#6fd3e0', white: '#cfd6dd',
  brightBlack: '#6c7680', brightRed: '#ffaba3', brightGreen: '#a9e3a5', brightYellow: '#f0d68f', brightBlue: '#a3bfff', brightMagenta: '#cbb5ff', brightCyan: '#9fe5ee', brightWhite: '#ffffff',
};

export function TerminalView({ taskId, interactive, onActivity }: { taskId: string; interactive: boolean; onActivity?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const interRef = useRef(interactive);
  interRef.current = interactive;

  useEffect(() => {
    const el = host.current; if (!el) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5, lineHeight: 1.25, theme: THEME, cursorBlink: false, scrollback: 8000, convertEol: false,
      allowProposedApi: false, disableStdin: false, cursorStyle: 'bar', cursorInactiveStyle: 'none',
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    const doFit = () => { try { fit.fit(); } catch { /* not visible */ } };
    doFit();
    const ro = new ResizeObserver(() => doFit());
    ro.observe(el);
    let ready = false;
    const unsub = onTerminal(taskId, (d) => { if (ready) { term.write(d); onActivity?.(); } });
    let alive = true;
    api.get<string>(`/tasks/${encodeURIComponent(taskId)}/terminal`).then((txt) => {
      if (!alive) return;
      term.write(typeof txt === 'string' ? txt : '');
      ready = true;
    }).catch(() => { ready = true; });
    const sub = term.onData((d) => { if (interRef.current) sendInput(taskId, { kind: 'terminal', data: d }); });
    // document fonts may land after first paint; refit once they do
    document.fonts?.ready.then(() => { if (alive) doFit(); });
    return () => { alive = false; ro.disconnect(); unsub(); sub.dispose(); term.dispose(); termRef.current = null; };
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = termRef.current; if (!t) return;
    t.options.cursorBlink = interactive;
    t.options.disableStdin = !interactive;
    if (interactive) t.focus();
  }, [interactive]);

  return (
    <div className={`termwrap ${interactive ? 'drive' : ''}`} data-capture-keys={interactive ? '1' : undefined}>
      <div ref={host} style={{ height: '100%', width: '100%' }} />
    </div>
  );
}
