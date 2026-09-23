import { useEffect, useRef, useState } from "react";
import { createGhosttyTerminal } from "./ghostty";
import { mountTerminal, type TerminalControls } from "./terminal-session";
import type { HistoryState, TerminalHistory } from "./terminal-history";
import { DeviceArt } from "./DeviceArt";
import { TerminalGlyph } from "./TerminalGlyph";
import {
  Maximize2,
  Plus,
  Minimize2,
  Hand,
  Eye,
  Square,
  TerminalSquare,
  X,
  RotateCcw,
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Keyboard,
  History,
} from "lucide-react";
import { api, wsUrl, type Session, type Device } from "./api";

export function TerminalPane({
  session,
  device,
  devices = [],
  expanded,
  visible = true,
  onExpand,
  onOpen,
  refresh,
  onError,
}: {
  session?: Session;
  device?: Device;
  devices?: Device[];
  expanded: boolean;
  visible?: boolean;
  onExpand: () => void;
  onOpen: (id?: string) => void;
  refresh: () => void;
  onError: (s: string) => void;
}) {
  const pane = useRef<HTMLElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const owner = useRef(session?.owner);
  const controls = useRef<TerminalControls | undefined>(undefined);
  const [status, setStatus] = useState("Connecting");
  const [retry, setRetry] = useState(0);
  const [historyState, setHistoryState] = useState<HistoryState>("live");
  owner.current = session?.owner;
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    controls.current?.syncInput();
  }, [session?.owner]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => controls.current?.activate());
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  useEffect(() => {
    if (!session || !container.current) return;
    setHistoryState("live");
    return mountTerminal({
      element: container.current,
      interactionElement: pane.current ?? undefined,
      url: wsUrl(`/sessions/${session.id}/stream`),
      canInput: () => owner.current === "user",
      onStatus: setStatus,
      onError: (message) => errorHandler.current(message),
      create: createGhosttyTerminal,
      loadHistory: (signal) =>
        api<TerminalHistory>(
          `/sessions/${session.id}/history`,
          undefined,
          signal,
        ),
      onHistoryState: setHistoryState,
      onReady: (value) => {
        controls.current = value;
      },
    });
  }, [session?.id, retry]);
  async function action(name: string, body: unknown = {}) {
    try {
      await api(`/sessions/${session!.id}/${name}`, body);
      refresh();
    } catch (e) {
      onError(String(e));
    }
  }
  if (!session)
    return (
      <aside className="terminal-pane empty-terminal">
        <header className="pane-header">
          <TerminalSquare size={18} />
          <span>Session terminal</span>
          <button
            className="icon-button"
            title="Open terminal"
            onClick={() => onOpen()}
          >
            <Plus size={17} />
          </button>
          {expanded && (
            <button
              className="icon-button"
              title="Back to conversation"
              onClick={onExpand}
            >
              <Minimize2 size={17} />
            </button>
          )}
        </header>
        <div className="terminal-empty-content">
          <TerminalGlyph />
          <h2>No terminal open</h2>
          <p>
            Open a persistent shell, or let the coordinator start one. Watch the
            work happen here.
          </p>
          <button className="button" onClick={() => onOpen()}>
            <TerminalSquare size={15} />
            Open a terminal
          </button>
          <div className="terminal-device-shortcuts">
            {devices
              .filter((d) => d.status === "online")
              .slice(0, 4)
              .map((d) => (
                <button key={d.id} onClick={() => onOpen(d.id)}>
                  <DeviceArt small os={d.os} name={d.name} />
                  <span>{d.name}</span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
          </div>
        </div>
        <footer className="terminal-footer">
          Persistent sessions · reconnect anytime
        </footer>
      </aside>
    );
  return (
    <aside ref={pane} className={`terminal-pane ${expanded ? "expanded" : ""}`}>
      <header className="terminal-header">
        <TerminalGlyph />
        <div>
          <strong>{session.name}</strong>
          <span>
            <i className={`dot ${status === "Connected" ? "online" : ""}`} />
            {device?.name} <b>·</b> {status}
          </span>
        </div>
        <button
          className="icon-button"
          title={expanded ? "Restore panes" : "Expand terminal"}
          onClick={onExpand}
        >
          {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
      </header>
      <div className="terminal-toolbar">
        <span>
          <TerminalSquare size={13} />
          {session.cwd || "~"}
        </span>
        <button
          className={`control-button terminal-history-button ${historyState !== "live" ? "is-reading" : ""}`}
          onClick={() =>
            historyState === "live"
              ? controls.current?.history()
              : controls.current?.live()
          }
          title="Read scrollback without interrupting the agent. Scroll down to return to live output."
        >
          {historyState === "live" ? (
            <History size={13} />
          ) : (
            <ArrowDown size={13} />
          )}
          {historyState === "live"
            ? "History"
            : historyState === "loading"
              ? "Cancel history"
              : "Back to live"}
        </button>
        <button
          className={`control-button ${session.owner === "user" ? "has-control" : ""}`}
          onClick={() =>
            action("control", {
              owner: session.owner === "user" ? "agent" : "user",
            })
          }
        >
          {session.owner === "user" ? <Hand size={13} /> : <Eye size={13} />}{" "}
          {session.owner === "user" ? "Release control" : "Take control"}
        </button>
      </div>
      <div className="terminal-viewport" ref={container} />
      <div className="terminal-touch-keys" aria-label="Terminal keys">
        <button
          aria-label="Show or hide keyboard"
          disabled={
            session.owner !== "user" ||
            status !== "Connected" ||
            historyState !== "live"
          }
          onClick={() => controls.current?.keyboard()}
        >
          <Keyboard size={19} />
        </button>
        {[
          { label: "Escape", text: "Esc", value: "\u001b" },
          { label: "Tab", text: "Tab", value: "\t" },
          { label: "Control C", text: "^C", value: "\u0003" },
          {
            label: "Arrow left",
            text: <ArrowLeft size={16} />,
            value: "\u001b[D",
          },
          {
            label: "Arrow down",
            text: <ArrowDown size={16} />,
            value: "\u001b[B",
          },
          { label: "Arrow up", text: <ArrowUp size={16} />, value: "\u001b[A" },
          {
            label: "Arrow right",
            text: <ArrowRight size={16} />,
            value: "\u001b[C",
          },
        ].map((key) => (
          <button
            key={key.label}
            aria-label={key.label}
            disabled={
              session.owner !== "user" ||
              status !== "Connected" ||
              historyState !== "live"
            }
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => controls.current?.send(key.value)}
          >
            {key.text}
          </button>
        ))}
      </div>
      <footer className="terminal-footer">
        <span>
          <i className={`dot ${status === "Connected" ? "online" : ""}`} />
          {historyState === "loading"
            ? "Loading scrollback…"
            : historyState === "history"
              ? "History · live output continues"
              : session.owner === "user"
                ? "You have control"
                : "Watching · agent has control"}
        </span>
        <div>
          <button
            className="icon-button"
            title="Reconnect"
            onClick={() => setRetry((v) => v + 1)}
          >
            <RotateCcw size={13} />
          </button>
          <button
            className="icon-button"
            title="Interrupt process (Ctrl+C)"
            onClick={() => action("interrupt")}
          >
            <Square size={12} />
          </button>
          <button
            className="icon-button"
            title="Close terminal and stop its processes"
            onClick={() => {
              if (
                confirm(
                  "Close this terminal and stop all processes running inside it?",
                )
              )
                action("close");
            }}
          >
            <X size={15} />
          </button>
        </div>
      </footer>
    </aside>
  );
}
