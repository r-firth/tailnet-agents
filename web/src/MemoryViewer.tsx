import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Search,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  Focus,
  Play,
  Pause,
  GitBranch,
  ListOrdered,
  Plus,
  Minus,
  X,
  RefreshCw,
  Database,
  Network,
  ChevronRight,
  Check,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ActivitySignal } from "./ActivitySignal";
import { MemoryGraph, type Selection } from "./MemoryGraph";
import { nodeColor, type MemoryNode, type MemoryScene } from "./memory-graph";
import type { Event } from "./api";
import "./memory.css";

type SearchResult = {
  hits: MemoryNode[];
  total: number;
  next_offset: number | null;
  semantic: boolean;
  semantic_pending?: boolean;
  elapsed_ms: number;
  warning?: string;
};
type Element = Partial<MemoryNode> & {
  id: number;
  label: string;
  properties: Record<string, unknown>;
  vector: number[] | null;
  source?: number;
  target?: number;
  degree?: number;
  neighbors?: { id: number; node: number; label: string; direction: string }[];
};
type Run = {
  id: number;
  name: string;
  prompt: string;
  status: string;
  time: string;
  events: Event[];
  total: number;
  offset: number;
  next_offset: number | null;
  previous_offset: number | null;
  previous_run: number | null;
  next_run: number | null;
};
type Params = {
  q?: string;
  mode?: string;
  kind?: string;
  node?: number;
  edge?: number;
  focus?: number;
  run?: number;
  anchor?: number;
};
const date = (s?: string) =>
  s
    ? new Date(s).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(`/api/memory/${path}`, { signal });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `Unable to load memory (${r.status})`);
  }
  return r.json();
}
const number = (v: unknown) =>
  v !== undefined &&
  v !== null &&
  v !== "" &&
  Number.isSafeInteger(Number(v)) &&
  Number(v) >= 0
    ? Number(v)
    : undefined;
export function memoryParams(raw: Record<string, unknown>): Params {
  return {
    q: typeof raw.q === "string" ? raw.q : undefined,
    kind: ["all", "message", "tool", "terminal", "system", "raw"].includes(
      String(raw.kind),
    )
      ? String(raw.kind)
      : undefined,
    mode: raw.mode === "hybrid" ? "hybrid" : undefined,
    node: number(raw.node),
    edge: number(raw.edge),
    focus: number(raw.focus),
    run: number(raw.run),
    anchor: number(raw.anchor),
  };
}
export default function MemoryViewer() {
  const raw = useRouterState({
    select: (s) => s.location.search,
  }) as unknown as Record<string, unknown>;
  const params = memoryParams(raw),
    navigate = useNavigate(),
    client = useQueryClient();
  const [text, setText] = useState(params.q || ""),
    [searchPage, setSearchPage] = useState(0),
    [graphPage, setGraphPage] = useState(0),
    [runPage, setRunPage] = useState<number>();
  const [fitKey, setFitKey] = useState(0),
    [zoom, setZoom] = useState(0),
    [pane, setPane] = useState<"graph" | "results" | "inspect">("graph");
  const [layout, setLayout] = useState<"network" | "sequence">("network");
  const [tracing, setTracing] = useState(true);
  const url = useRef(params);
  url.current = params;
  const update = (patch: Partial<Params>, replace = false) => {
    const next = { ...url.current, ...patch };
    void navigate({ to: "/memory", search: next, replace });
  };
  useEffect(() => {
    setText(params.q || "");
  }, [params.q]);
  useEffect(() => {
    if (text === (params.q || "")) return;
    const timer = setTimeout(() => {
      setSearchPage(0);
      update({ q: text || undefined }, true);
    }, 140);
    return () => clearTimeout(timer);
  }, [text, params.q]);
  useEffect(() => {
    setGraphPage(0);
  }, [params.focus]);
  useEffect(() => {
    setSearchPage(0);
  }, [params.q, params.kind, params.mode]);
  useEffect(() => {
    setRunPage(undefined);
  }, [params.run, params.anchor]);
  const selected: Selection | undefined =
    params.edge !== undefined
      ? { kind: "edge", id: params.edge }
      : params.node !== undefined
        ? { kind: "node", id: params.node }
        : undefined;
  const search = useQuery({
    queryKey: [
      "memory",
      "search",
      params.q,
      params.kind,
      params.mode,
      searchPage,
    ],
    queryFn: ({ signal }) =>
      get<SearchResult>(
        `search?${new URLSearchParams({ q: params.q || "", kind: params.kind || "all", mode: params.mode || "text", offset: String(searchPage) })}`,
        signal,
      ),
    refetchInterval: (query) =>
      query.state.data?.semantic_pending ? 500 : false,
    staleTime: 30_000,
    retry: 1,
  });
  const graph = useQuery<MemoryScene>({
    queryKey: ["memory", "graph", params.focus, graphPage],
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) =>
      get<MemoryScene>(
        `graph?offset=${graphPage}${params.focus !== undefined ? `&node=${params.focus}` : ""}`,
        signal,
      ),
    staleTime: 30_000,
    retry: 1,
  });
  const element = useQuery({
    queryKey: ["memory", "element", selected?.kind, selected?.id],
    queryFn: ({ signal }) =>
      get<Element>(`element/${selected!.kind}/${selected!.id}`, signal),
    enabled: !!selected,
    staleTime: 30_000,
    retry: 1,
  });
  const run = useQuery({
    queryKey: ["memory", "run", params.run, params.anchor, runPage],
    queryFn: ({ signal }) =>
      get<Run>(
        `runs/${params.run}?${new URLSearchParams({ ...(params.anchor !== undefined ? { anchor: String(params.anchor) } : {}), ...(runPage !== undefined ? { offset: String(runPage) } : {}) })}`,
        signal,
      ),
    enabled: params.run !== undefined,
    staleTime: 30_000,
    retry: 1,
  });
  const select = (selection: Selection, focus = false) => {
    update({
      node: selection.kind === "node" ? selection.id : undefined,
      edge: selection.kind === "edge" ? selection.id : undefined,
      ...(focus ? { focus: selection.id } : {}),
      run: undefined,
      anchor: undefined,
    });
    setPane("inspect");
  };
  const focus = (id: number) => {
    setGraphPage(0);
    update({ focus: id, node: id, edge: undefined, run: undefined });
    setPane("graph");
  };
  const overview = () => {
    setGraphPage(0);
    update({
      focus: undefined,
      node: undefined,
      edge: undefined,
      run: undefined,
      anchor: undefined,
    });
    setPane("graph");
  };
  const openRun = (id: number, anchor?: number) => {
    setRunPage(undefined);
    update({ run: id, anchor });
    setPane("graph");
  };
  const busy =
    search.isFetching ||
    graph.isFetching ||
    element.isFetching ||
    run.isFetching;
  const scene = graph.data;
  return (
    <section
      className={`memory-view memory-pane-${pane}`}
      aria-label="Memory explorer"
    >
      <header className="memory-heading">
        <div className="memory-heading-title">
          <Database size={21} />
          <h1>Memory</h1>
          <span className="memory-engine">Vecgra</span>
        </div>
        <div className="memory-counts">
          {scene && (
            <>
              <span>
                <b>{scene.stats.nodes.toLocaleString()}</b> nodes
              </span>
              <span>
                <b>{scene.stats.edges.toLocaleString()}</b> edges
              </span>
              <span>
                <b>{scene.stats.vectors.toLocaleString()}</b> vectors
              </span>
            </>
          )}
          <span className="memory-loading">
            <ActivitySignal active={busy} kind="memory" />
          </span>
          <button
            className="icon-button"
            aria-label="Refresh memory"
            onClick={() => client.invalidateQueries({ queryKey: ["memory"] })}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </header>
      <div className="memory-mobile-tabs" aria-label="Memory panels">
        {(["graph", "results", "inspect"] as const).map((p) => (
          <button
            key={p}
            aria-pressed={pane === p}
            onClick={() => {
              if (p === "inspect" && params.run !== undefined)
                update({ run: undefined, anchor: undefined });
              setPane(p);
            }}
          >
            {p === "graph"
              ? params.run !== undefined
                ? "Run"
                : "Graph"
              : p === "results"
                ? "Search"
                : "Inspector"}
          </button>
        ))}
      </div>
      <div
        className={`memory-layout ${params.run !== undefined ? "has-run" : ""}`}
      >
        <aside className="memory-search-panel" aria-label="Memory search">
          <div className="memory-search-box">
            <Search size={16} />
            <input
              aria-label="Search memory"
              placeholder="Find something you remember…"
              value={text}
              maxLength={512}
              onChange={(e) => setText(e.target.value)}
            />
            {text && (
              <button
                aria-label="Clear memory search"
                onClick={() => setText("")}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="memory-search-options">
            <div className="memory-mode">
              {["text", "hybrid"].map((mode) => (
                <button
                  key={mode}
                  aria-pressed={(params.mode || "text") === mode}
                  onClick={() =>
                    update({ mode: mode === "text" ? undefined : mode })
                  }
                >
                  {mode === "text" ? "Text" : "Semantic + text"}
                </button>
              ))}
            </div>
            <select
              aria-label="Filter memory records"
              value={params.kind || "all"}
              onChange={(e) => update({ kind: e.target.value })}
            >
              <option value="all">All records</option>
              <option value="message">Messages</option>
              <option value="tool">Tools</option>
              <option value="terminal">Terminals</option>
              <option value="system">System</option>
              <option value="raw">Include stream fragments</option>
            </select>
          </div>
          <div className="memory-list-caption">
            <span>
              {params.q ? "Matches" : "Recent records"}{" "}
              <b>{search.data?.total.toLocaleString() ?? "—"}</b>
            </span>
            <span>
              {search.data ? `${Math.round(search.data.elapsed_ms)} ms` : ""}
            </span>
          </div>
          {search.data?.warning && (
            <p className="memory-warning" role="status">
              {search.data.warning}
            </p>
          )}
          <div className="memory-results" aria-busy={search.isFetching}>
            {search.isError ? (
              <Problem
                message={search.error.message}
                retry={() => search.refetch()}
              />
            ) : search.isPending ? (
              <p className="memory-empty">Reading memory…</p>
            ) : !search.data.hits.length ? (
              <p className="memory-empty">
                No matching records.
                <br />
                <small>Try fewer words or semantic search.</small>
              </p>
            ) : (
              search.data.hits.map((hit) => (
                <button
                  className={`memory-result ${selected?.kind === "node" && selected.id === hit.id ? "selected" : ""}`}
                  key={hit.id}
                  onClick={() => select({ kind: "node", id: hit.id }, true)}
                >
                  <span className="memory-result-top">
                    <i style={{ background: nodeColor(hit.category) }} />
                    <span>{hit.title}</span>
                    <code>#{hit.id}</code>
                  </span>
                  <span className="memory-result-excerpt">
                    <Highlight text={hit.excerpt} query={params.q || ""} />
                  </span>
                  <span className="memory-result-bottom">
                    <span>{hit.scope_name}</span>
                    <time>{date(hit.time)}</time>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="memory-pagination">
            <button
              disabled={!searchPage}
              aria-label="Previous search results"
              onClick={() => setSearchPage(Math.max(0, searchPage - 40))}
            >
              <ArrowLeft size={15} />
            </button>
            <span>
              {search.data?.total
                ? `${searchPage + 1}–${searchPage + search.data.hits.length}`
                : "0"}{" "}
              of {search.data?.total.toLocaleString() ?? "—"}
            </span>
            <button
              disabled={search.data?.next_offset == null}
              aria-label="Next search results"
              onClick={() => setSearchPage(search.data!.next_offset!)}
            >
              <ArrowRight size={15} />
            </button>
          </div>
        </aside>
        {params.run !== undefined ? (
          <div className="memory-run-panel">
            <div className="memory-graph-toolbar">
              <button
                onClick={() => update({ run: undefined, anchor: undefined })}
              >
                <ArrowLeft size={14} /> Graph
              </button>
              <span className="memory-overline">
                Source run · #{params.run}
              </span>
              <button
                className="icon-button"
                aria-label="Close source run"
                onClick={() => update({ run: undefined, anchor: undefined })}
              >
                <X size={16} />
              </button>
            </div>
            {run.isError ? (
              <Problem
                message={run.error.message}
                retry={() => run.refetch()}
              />
            ) : run.data ? (
              <RunView
                run={run.data}
                anchor={params.anchor}
                onPage={setRunPage}
                onRun={openRun}
                onNode={(id) => select({ kind: "node", id }, true)}
              />
            ) : (
              <p className="memory-empty">Reading source run…</p>
            )}
          </div>
        ) : (
          <>
            <div className="memory-graph-panel">
              <div className="memory-graph-toolbar">
                <button
                  onClick={overview}
                  className={params.focus === undefined ? "active" : ""}
                >
                  <Network size={15} /> Overview
                </button>
                {params.focus !== undefined && (
                  <>
                    <ChevronRight size={13} />
                    <span className="memory-context">
                      #{params.focus} context
                    </span>
                  </>
                )}
                <div className="memory-camera-controls">
                  <button
                    aria-label="Zoom out"
                    onClick={() => setZoom((z) => z - 1)}
                  >
                    <Minus size={15} />
                  </button>
                  <button
                    aria-label="Fit graph"
                    onClick={() => setFitKey((k) => k + 1)}
                  >
                    <Focus size={16} />
                  </button>
                  <button
                    aria-label="Zoom in"
                    onClick={() => setZoom((z) => z + 1)}
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>
              <div className="memory-arrangement-bar">
                <div role="group" aria-label="Graph arrangement">
                  <button
                    aria-pressed={layout === "network"}
                    onClick={() => setLayout("network")}
                  >
                    <GitBranch size={13} /> Network
                  </button>
                  <button
                    aria-pressed={layout === "sequence"}
                    onClick={() => setLayout("sequence")}
                  >
                    <ListOrdered size={13} /> Sequence
                  </button>
                </div>
                <button
                  className="memory-trace-toggle"
                  aria-pressed={tracing}
                  aria-label="Animate relationship direction"
                  title="Pixel traces show the direction of stored relationships"
                  onClick={() => setTracing((v) => !v)}
                >
                  {tracing ? <Pause size={12} /> : <Play size={12} />} Trace
                </button>
              </div>
              <div className="memory-graph-surface">
                {graph.isError ? (
                  <Problem
                    message={graph.error.message}
                    retry={() => graph.refetch()}
                  />
                ) : scene?.nodes.length ? (
                  <MemoryGraph
                    scene={scene}
                    selected={selected}
                    onSelect={select}
                    onFocus={focus}
                    fitKey={fitKey}
                    zoom={zoom}
                    layout={layout}
                    trace={tracing}
                  />
                ) : (
                  <div className="memory-graph-empty">
                    <Network size={32} />
                    <p>
                      {graph.isPending
                        ? "Reading the graph…"
                        : "Your memory starts here"}
                    </p>
                    <small>
                      {graph.isPending
                        ? ""
                        : "Conversations and actions will appear as connected records."}
                    </small>
                  </div>
                )}
                <div className="memory-graph-key">
                  {["scope", "message", "tool", "terminal", "system"].map(
                    (kind) => (
                      <span key={kind}>
                        <i style={{ background: nodeColor(kind) }} />
                        {kind === "scope"
                          ? "Context"
                          : kind === "message"
                            ? "Message"
                            : kind === "tool"
                              ? "Tool"
                              : kind === "terminal"
                                ? "Terminal"
                                : "System"}
                      </span>
                    ),
                  )}
                </div>
              </div>
              <div className="memory-graph-footer">
                <span>
                  {scene
                    ? `${scene.nodes.length} nodes · ${scene.edges.length} edges in view`
                    : "—"}
                </span>
                <span className="memory-graph-help">
                  Double-click to explore
                </span>
              </div>
              <div className="memory-graph-picker">
                <select
                  aria-label="Select a graph node"
                  value={
                    selected?.kind === "node" &&
                    scene?.nodes.some((n) => n.id === selected.id)
                      ? selected.id
                      : ""
                  }
                  onChange={(e) => {
                    if (e.target.value)
                      select({ kind: "node", id: Number(e.target.value) });
                  }}
                >
                  <option value="">Inspect a node…</option>
                  {scene?.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      #{n.id} · {n.title}
                    </option>
                  ))}
                </select>
                <button
                  disabled={!graphPage}
                  aria-label="Previous graph contexts"
                  onClick={() =>
                    setGraphPage(
                      Math.max(
                        0,
                        graphPage - (params.focus !== undefined ? 100 : 12),
                      ),
                    )
                  }
                >
                  <ArrowLeft size={14} />
                </button>
                <button
                  disabled={scene?.next_offset == null}
                  aria-label="Next graph contexts"
                  onClick={() => setGraphPage(scene!.next_offset!)}
                >
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
            <aside className="memory-inspector" aria-label="Memory inspector">
              <div className="memory-inspector-heading">
                <span className="memory-overline">Inspector</span>
                {selected && (
                  <code>
                    {selected.kind} #{selected.id}
                  </code>
                )}
              </div>
              {!selected ? (
                <div className="memory-inspector-empty">
                  <span className="memory-inspect-glyph" aria-hidden="true">
                    ⌖
                  </span>
                  <h2>Follow a connection.</h2>
                  <p>
                    Select a node or relationship to inspect its record, vector,
                    and source run.
                  </p>
                  <div>
                    <i /> HAS_EVENT <small>context → event</small>
                  </div>
                  <div>
                    <i className="next" /> NEXT{" "}
                    <small>event → next event</small>
                  </div>
                </div>
              ) : element.isError ? (
                <Problem
                  message={element.error.message}
                  retry={() => element.refetch()}
                />
              ) : element.data ? (
                <Inspector
                  element={element.data}
                  kind={selected.kind}
                  onSelect={select}
                  onFocus={focus}
                  onRun={openRun}
                />
              ) : (
                <p className="memory-empty">Reading record…</p>
              )}
            </aside>
          </>
        )}
      </div>
    </section>
  );
}
function Problem({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="memory-error" role="alert">
      <p>{message}</p>
      <button onClick={retry}>
        Try again <RefreshCw size={13} />
      </button>
    </div>
  );
}
function Highlight({ text, query }: { text: string; query: string }) {
  const token = query.trim().split(/\s+/)[0];
  if (!token) return <>{text}</>;
  const i = text.toLowerCase().indexOf(token.toLowerCase());
  return i < 0 ? (
    <>{text}</>
  ) : (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + token.length)}</mark>
      {text.slice(i + token.length)}
    </>
  );
}
function Inspector({
  element: e,
  kind,
  onSelect,
  onFocus,
  onRun,
}: {
  element: Element;
  kind: string;
  onSelect: (s: Selection, focus?: boolean) => void;
  onFocus: (id: number) => void;
  onRun: (id: number, anchor?: number) => void;
}) {
  return (
    <div className="memory-inspector-scroll">
      <div className="memory-record-head">
        <span
          className="memory-record-type"
          style={{ color: nodeColor(e.category || "scope") }}
        >
          {e.kind || e.label}
        </span>
        <h2>{e.title || e.label}</h2>
        {e.scope_name && <p>{e.scope_name}</p>}
        <time>{date(e.time)}</time>
      </div>
      {kind === "edge" ? (
        <div className="memory-endpoints">
          <button
            onClick={() => onSelect({ kind: "node", id: e.source! }, true)}
          >
            #{e.source}
          </button>
          <ArrowRight size={15} />
          <button
            onClick={() => onSelect({ kind: "node", id: e.target! }, true)}
          >
            #{e.target}
          </button>
        </div>
      ) : (
        <div className="memory-record-actions">
          <button onClick={() => onFocus(e.id)}>
            <Network size={14} /> Explore context
          </button>
          {e.run_id !== undefined && (
            <button onClick={() => onRun(e.run_id!, e.id)}>
              View source run <ArrowUpRight size={14} />
            </button>
          )}
        </div>
      )}
      {e.excerpt && <p className="memory-record-preview">{e.excerpt}</p>}
      <details className="memory-properties">
        <summary>
          Properties <span>{Object.keys(e.properties).length}</span>
        </summary>
        <pre>{JSON.stringify(e.properties, null, 2)}</pre>
      </details>
      <details className="memory-vector" open>
        <summary>
          Embedding{" "}
          <span>{e.vector ? `${e.vector.length} dimensions` : "None"}</span>
        </summary>
        {e.vector && (
          <>
            <div
              className="memory-vector-map"
              role="img"
              aria-label={`Embedding with ${e.vector.length} dimensions; copper is positive, blue is negative`}
            >
              {e.vector.map((v, i) => (
                <i
                  key={i}
                  title={`${i}: ${v.toFixed(6)}`}
                  style={{
                    background: v >= 0 ? "#eaa372" : "#94b8c9",
                    opacity: 0.12 + Math.min(Math.abs(v) * 8, 0.88),
                  }}
                />
              ))}
            </div>
            <p>
              Positive <i className="positive" /> <i className="negative" />{" "}
              Negative
            </p>
            <details>
              <summary>Vector values</summary>
              <pre>{e.vector.map((v) => v.toFixed(6)).join(", ")}</pre>
            </details>
          </>
        )}
      </details>
      {e.neighbors && (
        <section className="memory-neighbors">
          <h3>
            Relationships <span>{e.degree}</span>
          </h3>
          {e.neighbors.map((n) => (
            <div key={n.id}>
              <button
                title={`Inspect relationship #${n.id}`}
                onClick={() => onSelect({ kind: "edge", id: n.id })}
              >
                <span>{n.direction === "out" ? "↗" : "↙"}</span>
                {n.label}
              </button>
              <button
                title={`Inspect node #${n.node}`}
                onClick={() => onSelect({ kind: "node", id: n.node }, true)}
              >
                #{n.node}
                <ChevronRight size={12} />
              </button>
            </div>
          ))}
          {(e.degree || 0) > e.neighbors.length && (
            <p>
              Showing {e.neighbors.length} of {e.degree}. Explore context to
              browse more.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
function RunView({
  run,
  anchor,
  onPage,
  onRun,
  onNode,
}: {
  run: Run;
  anchor?: number;
  onPage: (n: number) => void;
  onRun: (id: number) => void;
  onNode: (id: number) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (anchor !== undefined)
      content.current
        ?.querySelector(`[data-event-id="${anchor}"]`)
        ?.scrollIntoView({ block: "center" });
    else content.current?.scrollTo({ top: 0 });
  }, [run.id, run.offset, anchor]);
  return (
    <>
      <header className="memory-run-heading">
        <div>
          <span className="memory-overline">
            {date(run.time)} · {run.status}
          </span>
          <h2>{run.name}</h2>
          <p>{run.prompt}</p>
        </div>
        <span className="memory-readonly">
          <Check size={12} /> Recorded history
        </span>
      </header>
      <div className="memory-run-events" ref={content}>
        {run.previous_offset !== null && (
          <button
            className="memory-page-events"
            onClick={() => onPage(run.previous_offset!)}
          >
            Earlier records
          </button>
        )}
        {run.events.map((e) => (
          <article
            className={`memory-run-event ${anchor === e.id ? "is-source" : ""}`}
            data-event-id={e.id}
            key={e.id}
          >
            <header>
              <span>
                {e.kind === "message.user"
                  ? "You"
                  : e.kind === "message.assistant"
                    ? "Coordinator"
                    : String(e.payload.name || e.kind).replaceAll(/[._]/g, " ")}
              </span>
              <time>{date(e.time)}</time>
              <button onClick={() => onNode(e.id)} title="Inspect this node">
                #{e.id}
                <ArrowUpRight size={12} />
              </button>
            </header>
            {anchor === e.id && (
              <span className="memory-source-label">Selected source</span>
            )}
            {typeof e.payload.text === "string" ? (
              <div className="memory-run-message">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {e.payload.text}
                </ReactMarkdown>
              </div>
            ) : (
              <details open={anchor === e.id || e.kind === "tool.result"}>
                <summary>{e.kind}</summary>
                <pre>{JSON.stringify(e.payload, null, 2)}</pre>
              </details>
            )}
          </article>
        ))}
        {run.next_offset !== null && (
          <button
            className="memory-page-events"
            onClick={() => onPage(run.next_offset!)}
          >
            Later records
          </button>
        )}
      </div>
      <footer className="memory-run-navigation">
        <button
          disabled={run.previous_run === null}
          onClick={() => onRun(run.previous_run!)}
        >
          <ArrowLeft size={14} /> Previous run
        </button>
        <span>
          {run.offset + 1}–{run.offset + run.events.length} of {run.total}{" "}
          records
        </span>
        <button
          disabled={run.next_run === null}
          onClick={() => onRun(run.next_run!)}
        >
          Next run <ArrowRight size={14} />
        </button>
      </footer>
    </>
  );
}
