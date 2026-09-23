// Development-only visual fixture. No API calls, sessions, or user data.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ToolActivity } from "./ToolActivity";
import { ActivitySignal } from "./ActivitySignal";
import type { Event } from "./api";
import "./style.css";
import "./pixel-ui.css";
import "./tool-activity.css";

const tools = [
  ["web_search", { query: "wgpu surface configuration" }],
  [
    "command_execution",
    { command: "cargo test -p renderer", cwd: "/work/game" },
  ],
  [
    "file_change",
    {
      changes: [
        {
          path: "src/renderer.rs",
          kind: { type: "update" },
          diff: "- old\n+ new",
        },
      ],
    },
  ],
  ["open_terminal", { name: "Game build", device_id: "desktop" }],
  ["search_memory", { query: "What did we decide about the renderer?" }],
] as const;
function Preview() {
  const [state, setState] = useState("Live");
  const live = state === "Live";
  return (
    <main
      style={{
        maxWidth: 610,
        margin: "32px auto",
        padding: "0 16px",
        width: "100%",
      }}
    >
      <header style={{ marginBottom: 28 }}>
        <p
          style={{
            font: "10px var(--mono)",
            letterSpacing: "0.12em",
            color: "var(--muted)",
            marginBottom: 10,
          }}
        >
          DESIGN REVIEW · SYNTHETIC EVENTS
        </p>
        <h1 style={{ fontSize: 22, fontWeight: 500 }}>Live instruments</h1>
        <p style={{ color: "var(--muted)", margin: "12px 0" }}>
          Actual transcript components. Expand a row to inspect its receipt.
        </p>
        <div className="toggle" style={{ display: "inline-flex" }}>
          {["Live", "Completed", "Failed", "Stopped"].map((s) => (
            <button
              className={s === state ? "selected" : ""}
              onClick={() => setState(s)}
              key={s}
            >
              {s}
            </button>
          ))}
        </div>
      </header>
      {tools.map(([name, args], i) => {
        const start: Event = {
          id: i,
          time: "2026-09-23T17:00:00Z",
          scope: "preview",
          kind: "tool.started",
          payload: { name, arguments: args, source: "codex" },
        };
        const end: Event | undefined =
          live || state === "Stopped"
            ? undefined
            : {
                ...start,
                id: i + 10,
                kind: "tool.result",
                payload: {
                  ...start.payload,
                  result: {
                    ok: state !== "Failed",
                    result: {
                      ...args,
                      durationMs: 1842,
                      output:
                        state === "Failed"
                          ? "Connection unavailable"
                          : "Action completed. This is a visual test fixture.",
                      ...(name === "command_execution"
                        ? { exitCode: state === "Failed" ? 1 : 0 }
                        : {}),
                    },
                  },
                },
              };
        return (
          <ToolActivity
            key={name}
            action={{
              start,
              end,
              output:
                live && name === "command_execution"
                  ? "Compiling renderer…"
                  : "",
              interrupted: state === "Stopped",
            }}
            running={live}
            devices={[
              {
                id: "desktop",
                name: "Desktop",
                target: "desktop",
                status: "online",
              },
            ]}
            sessions={[]}
            onTerminal={() => {}}
          />
        );
      })}
      {live && (
        <div className="working" style={{ marginLeft: 0 }}>
          <ActivitySignal active kind="thinking" />
          <span>Thinking</span>
        </div>
      )}
      <footer
        style={{
          font: "10px/1.8 var(--mono)",
          color: "var(--quiet)",
          marginTop: 28,
        }}
      >
        Web · command · file edit · connection · memory · thinking
        <br />
        Motion signals activity. No simulated progress values.
      </footer>
    </main>
  );
}
const hotData = import.meta.hot?.data;
const root = hotData?.root ?? createRoot(document.getElementById("root")!);
if (hotData) hotData.root = root;
root.render(<Preview />);
