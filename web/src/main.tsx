import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Link,
  useRouterState,
  useNavigate,
} from "@tanstack/react-router";
import {
  Search,
  Plus,
  ArrowUpRight,
  ArrowUp,
  ChevronDown,
  X,
  Command,
  TerminalSquare,
  MessageSquare,
  Radio,
  Network,
  Clock3,
  Settings2,
  RefreshCw,
  Check,
  Plug,
  Square,
  Monitor,
  ArrowLeft,
  Database,
  LoaderCircle,
  Expand,
  PanelLeftClose,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  wsUrl,
  type HubState,
  type Chat,
  type Device,
  type Session,
  type Event,
} from "./api";
import { TerminalPane } from "./TerminalPane";
import { activityKind } from "./activity-kind";
import { ActivitySignal } from "./ActivitySignal";
import { DeviceArt } from "./DeviceArt";
import { HardwareSprite } from "./HardwareSprite";
import "./style.css";
import "./pixel-ui.css";
import "./tool-activity.css";
import "./conversations.css";
import { registerHubTools } from "./webmcp";
import { trackViewport } from "./mobile-viewport";
import { chatEntries, ToolActivity, type ChatEntry } from "./ToolActivity";
import { appendHubEvents, mergeHubSnapshot } from "./live-events";
import { UpdateNotice } from "./UpdateNotice";
import { Notifications } from "./Notifications";
import {
  AgentView,
  InputRequest,
  NewSession,
  agentLabel,
  type ViewSpec,
} from "./AgentFeatures";
import { InstallApp, registerServiceWorker } from "./InstallApp";
import hubMark from "./assets/mark.svg";

const MemoryViewer = React.lazy(() => import("./MemoryViewer"));
const queryClient = new QueryClient();
const time = (v: string) =>
  new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function eventLabel(event: Event) {
  const labels: Record<string, string> = {
    "message.assistant": "Coordinator message",
    "message.user": "Your message",
    "terminal.output": "Terminal output",
    "session.created": "Terminal opened",
    "session.closed": "Terminal closed",
    "chat.created": "Conversation created",
    "agent.started": "Agent started",
    "agent.finished": "Agent finished",
    "agent.error": "Agent error",
  };
  return (
    labels[event.kind] ||
    String(event.payload.name || event.kind).replaceAll(/[._]/g, " ")
  );
}
function HubMark({ large = false }: { large?: boolean }) {
  return (
    <img
      src={hubMark}
      width={large ? 48 : 32}
      height={large ? 48 : 32}
      className={`hub-mark ${large ? "large" : ""}`}
      alt=""
      aria-hidden="true"
    />
  );
}
function App() {
  const appFrame = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(
    () => matchMedia("(max-width:1000px)").matches,
  );
  const cache = useQueryClient();
  const navigate = useNavigate();
  const page = useRouterState({ select: (s) => s.location.pathname });
  const receivedEvents = useRef<Event[]>([]);
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["hub"],
    queryFn: async () => {
      const snapshot = await api<HubState>("/state");
      const merged = appendHubEvents(snapshot, receivedEvents.current);
      receivedEvents.current = [];
      return merged;
    },
    structuralSharing: (previous, next) =>
      mergeHubSnapshot(previous as HubState | undefined, next as HubState),
    refetchInterval: 10000,
    retry: 1,
  });
  const [chatId, setChatId] = useState(
    () => new URL(location.href).searchParams.get("chat") || "",
  );
  const initialChat = useRef(new URL(location.href).searchParams.get("chat"));
  const [terminalChatId, setTerminalChatId] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<
    "terminal" | "device" | "search" | "agent" | null
  >(null);
  const [deviceId, setDeviceId] = useState("local");
  const [editingDevice, setEditingDevice] = useState<Device>();
  const editDevice = (device?: Device) => {
    setSidebar(false);
    setEditingDevice(device);
    setDialog("device");
  };
  const [toast, setToast] = useState("");
  const [showUnavailable, setShowUnavailable] = useState(false);
  const visibleDevices =
    data?.devices.filter((d) => showUnavailable || d.status === "online") || [];
  const unavailableCount =
    data?.devices.filter((d) => d.status !== "online").length || 0;
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [closingChats, setClosingChats] = useState<string[]>([]);
  const [sidebar, setSidebar] = useState(false);
  const [connection, setConnection] = useState("Connecting");
  useEffect(() => {
    const media = matchMedia("(max-width:1000px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (appFrame.current) return trackViewport(appFrame.current);
  }, [error?.message === "AUTH_REQUIRED"]);
  useEffect(() => {
    if (!sidebar || !compact) return;
    const items = () =>
      Array.from(
        drawer.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href]",
        ) ?? [],
      ).filter((el) => el.getClientRects().length);
    items()[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = items();
      const first = focusable[0],
        last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    drawer.current?.addEventListener("keydown", trap);
    const element = drawer.current;
    return () => {
      element?.removeEventListener("keydown", trap);
      sidebarTrigger.current?.focus({ preventScroll: true });
    };
  }, [sidebar, compact]);
  const bottom = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const activeChatRef = useRef(chatId);
  activeChatRef.current = chatId;
  const webTerminalHandler = useRef<(session: Session) => Promise<void>>(
    async () => {},
  );
  webTerminalHandler.current = (session) => selectTerminal(session.id);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.data?.type === "tailnet.open-session" &&
        typeof event.data.chat_id === "string"
      ) {
        setChatId(event.data.chat_id);
        navigate({ to: "/" });
      }
    };
    navigator.serviceWorker?.addEventListener("message", receive);
    return () =>
      navigator.serviceWorker?.removeEventListener("message", receive);
  }, [navigate]);
  const chat = data?.chats.find((c) => c.id === chatId && !c.closed);
  const openChats = data?.chats.filter((c) => !c.closed) || [];
  const refresh = () => {
    cache.invalidateQueries({ queryKey: ["hub"] });
  };
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    let previousHeight = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const atEnd =
        element.scrollHeight - element.scrollTop - previousHeight < 80;
      previousHeight = element.clientHeight;
      if (atEnd || document.activeElement === composer.current)
        element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [page]);
  useEffect(() => {
    if (!data) return;
    if (initialChat.current) {
      const requested = initialChat.current;
      initialChat.current = null;
      if (data.chats.some((c) => c.id === requested)) {
        void selectChat(requested);
        return;
      }
    }
    if (!chatId || data.chats.some((c) => c.id === chatId && c.closed)) {
      const next = data.chats.find((c) => !c.closed);
      if (next) setChatId(next.id);
      else {
        setChatId("");
      }
      return;
    }
  }, [data, chatId]);
  useEffect(
    () =>
      registerHubTools(
        (session) => webTerminalHandler.current(session),
        () => activeChatRef.current,
      ),
    [],
  );
  useEffect(() => {
    let dead = false;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (debounce === undefined)
        debounce = setTimeout(() => {
          debounce = undefined;
          refresh();
        }, 100);
    };
    const connect = () => {
      if (dead) return;
      socket = new WebSocket(wsUrl("/events"));
      socket.onopen = () => {
        setConnection("Connected");
        refresh();
      };
      socket.onmessage = (message) => {
        let event: Event;
        try {
          event = JSON.parse(message.data);
          if (
            typeof event.id !== "number" ||
            typeof event.kind !== "string" ||
            !event.payload
          )
            throw new Error("Invalid event");
        } catch {
          scheduleRefresh();
          return;
        }
        receivedEvents.current.push(event);
        if (flushTimer === undefined)
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            cache.setQueryData<HubState>(["hub"], (previous) => {
              // The initial snapshot consumes this buffer if it isn't ready yet.
              if (!previous) return previous;
              const next = appendHubEvents(previous, receivedEvents.current);
              receivedEvents.current = [];
              return next;
            });
          }, 16);
        // Device/session projections still come from the server. Text and tool
        // deltas do not require repeatedly fetching the entire workspace.
        if (!/^(message\.|tool\.|agent\.)/.test(event.kind)) scheduleRefresh();
      };
      socket.onclose = () => {
        if (!dead) {
          setConnection("Reconnecting");
          timer = setTimeout(connect, 2500);
        }
      };
    };
    connect();
    return () => {
      dead = true;
      clearTimeout(timer);
      clearTimeout(debounce);
      clearTimeout(flushTimer);
      socket?.close();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setDialog((d) => (d === "search" ? null : "search"));
      }
      if (e.key === "Escape") {
        setDialog(null);
        setSidebar(false);
        if (!(
          e.target instanceof HTMLElement && e.target.closest(".terminal-pane")
        ))
          setExpanded(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 6000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const events = data?.events.filter((e) => e.scope === chatId) || [];
  const messages = chatEntries(events);
  const running = data?.running.includes(chatId) || false;
  const writing =
    running &&
    messages.some(
      (entry) => entry.event.payload.streaming && entry.event.payload.text,
    );
  const liveAction = running
    ? [...messages]
        .reverse()
        .find(
          (entry) =>
            entry.action &&
            !entry.action.end &&
            !entry.action.interrupted &&
            !entry.action.start.payload.native_receipt,
        )?.action
    : undefined;
  const currentActivity = activityKind(
    String(liveAction?.start.payload.name || ""),
  );
  const lastStatus =
    [...events].reverse().find((e) => e.kind === "agent.status")?.payload
      .text || "Thinking";
  useLayoutEffect(() => {
    followOutput.current = true;
  }, [chatId]);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && followOutput.current)
      element.scrollTop = element.scrollHeight;
  }, [chatId, events.at(-1)?.id, running]);
  const session = data?.sessions.find(
    (s) => !s.closed && chat?.session_ids?.includes(s.id),
  );
  const device = data?.devices.find((d) => d.id === session?.device_id);
  const openTerminal = (id = "local") => {
    setSidebar(false);
    setDeviceId(id);
    setTerminalChatId(chat && !session ? chat.id : "");
    setDialog("terminal");
  };
  const notify = (error: unknown) =>
    setToast(error instanceof Error ? error.message : String(error));
  async function createChat() {
    const created = await api<Chat>("/chats", {});
    cache.setQueryData<HubState>(["hub"], (old) =>
      old ? { ...old, chats: [created, ...old.chats] } : old,
    );
    setChatId(created.id);
    return created.id;
  }
  async function selectChat(id: string) {
    try {
      if (data?.chats.find((c) => c.id === id)?.closed) {
        await api(`/chats/${id}/reopen`, {});
        cache.setQueryData<HubState>(["hub"], (old) =>
          old
            ? {
                ...old,
                chats: old.chats.map((c) =>
                  c.id === id ? { ...c, closed: false } : c,
                ),
              }
            : old,
        );
      }
      setChatId(id);
      navigate({ to: "/" });
      setExpanded(false);
      setSidebar(false);
      refresh();
    } catch (e) {
      notify(e);
    }
  }
  async function closeChat(id: string) {
    if (closingChats.includes(id)) return;
    setClosingChats((ids) => [...ids, id]);
    try {
      const result = await api<{
        closed_terminals: string[];
        pending_terminals?: string[];
      }>(`/chats/${id}/close`, {});
      cache.setQueryData<HubState>(["hub"], (old) =>
        old
          ? {
              ...old,
              chats: old.chats.map((c) =>
                c.id === id
                  ? { ...c, closed: true, closing: false, close_error: null }
                  : c,
              ),
              sessions: old.sessions.map((s) =>
                result.closed_terminals.includes(s.id)
                  ? {
                      ...s,
                      closed: true,
                      cleanup_pending:
                        result.pending_terminals?.includes(s.id) ?? false,
                    }
                  : s,
              ),
            }
          : old,
      );
      if (id === chatId) {
        setChatId(openChats.find((c) => c.id !== id)?.id || "");
        setMessage("");
        setExpanded(false);
      }
      refresh();
      setToast(
        result.pending_terminals?.length
          ? "Session closed. Terminal shutdown continues in the background."
          : "Session closed; terminals stopped. History is in Sessions.",
      );
    } catch (e) {
      notify(e);
      refresh();
    } finally {
      setClosingChats((ids) => ids.filter((value) => value !== id));
    }
  }
  async function selectTerminal(id: string) {
    try {
      const snapshot = await api<HubState>("/state");
      const owner = snapshot.chats.find((c) => c.session_ids?.includes(id));
      if (!owner)
        throw new Error("This terminal has no session. Refresh the workspace.");
      cache.setQueryData(["hub"], snapshot);
      if (owner.closed) {
        await api(`/chats/${owner.id}/reopen`, {});
        cache.setQueryData<HubState>(["hub"], (old) =>
          old
            ? {
                ...old,
                chats: old.chats.map((c) =>
                  c.id === owner.id ? { ...c, closed: false } : c,
                ),
              }
            : old,
        );
      }
      setChatId(owner.id);
      navigate({ to: "/" });
      if (matchMedia("(max-width:1000px)").matches) setExpanded(true);
      setSidebar(false);
      refresh();
    } catch (e) {
      notify(e);
    }
  }
  function newChat() {
    setSidebar(false);
    setDialog("agent");
  }
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (
      !message.trim() ||
      sending ||
      running ||
      chat?.closing ||
      closingChats.includes(chatId)
    )
      return;
    setSending(true);
    try {
      const targetChat = chatId || (await createChat());
      followOutput.current = true;
      await api(`/chats/${targetChat}/messages`, { text: message });
      setMessage("");
      refresh();
    } catch (e) {
      notify(e);
    } finally {
      setSending(false);
    }
  }
  if (error?.message === "AUTH_REQUIRED")
    return <Login onDone={() => refetch()} />;
  return (
    <div
      ref={appFrame}
      className={`app ${sidebar ? "show-sidebar" : ""} ${page === "/memory" ? "memory-open" : ""}`}
    >
      <header className="topbar">
        <button
          className="brand"
          ref={sidebarTrigger}
          onClick={() => setSidebar((v) => !v)}
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          aria-expanded={sidebar}
          aria-controls="workspace-sidebar"
        >
          <HubMark />
        </button>
        <span className="mobile-page-title">
          <strong>{page === "/" ? "Work" : page.slice(1)}</strong>
          <small>
            <i
              className={`dot ${connection === "Connected" ? "online" : ""}`}
            />
            {connection}
          </small>
        </span>
        <nav aria-label="Main navigation">
          {["Work", "Sessions", "Devices", "Activity", "Memory"].map(
            (name, i) => (
              <Link
                key={name}
                to={["/", "/sessions", "/devices", "/activity", "/memory"][i]}
                className={
                  page ===
                  ["/", "/sessions", "/devices", "/activity", "/memory"][i]
                    ? "active"
                    : ""
                }
                onClick={() => setSidebar(false)}
              >
                {name}
              </Link>
            ),
          )}
        </nav>
        <button
          className="search-trigger"
          aria-label="Search workspace"
          onClick={() => {
            setSidebar(false);
            setDialog("search");
          }}
        >
          <Search size={17} />
          <span>Search workspace…</span>
          <kbd>⌘ K</kbd>
        </button>
        <button
          className="button primary new-session"
          aria-label="New session"
          onClick={newChat}
        >
          <Plus size={17} />
          <span>New session</span>
        </button>
      </header>
      <UpdateNotice canReload={!message.trim() && !sending} />
      <div className="workspace">
        {sidebar && (
          <button
            className="sidebar-scrim"
            aria-label="Close workspace menu"
            onClick={() => setSidebar(false)}
          />
        )}
        <aside
          ref={drawer}
          id="workspace-sidebar"
          className="sidebar"
          role={compact ? "dialog" : undefined}
          aria-modal={compact && sidebar ? true : undefined}
          aria-label="Workspace menu"
          inert={compact && !sidebar}
        >
          <div className="mobile-drawer-heading">
            <HubMark />
            <strong>Your workspace</strong>
            <button
              className="icon-button"
              aria-label="Close menu"
              onClick={() => setSidebar(false)}
            >
              <X size={20} />
            </button>
          </div>
          <section className="sidebar-section" aria-label="Sessions">
            <div className="side-section-title">
              <span>
                Sessions{" "}
                <span className="section-count">{openChats.length}</span>
              </span>
              <button
                className="icon-button"
                title="New conversation"
                onClick={newChat}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="chat-list">
              {openChats.map((c) => {
                const terminals =
                  data?.sessions.filter(
                    (s) => !s.closed && c.session_ids?.includes(s.id),
                  ) || [];
                const working = data!.running.includes(c.id);
                const closing = c.closing || closingChats.includes(c.id);
                return (
                  <div
                    className={`chat-row ${chatId === c.id ? "selected" : ""} ${working ? "is-working" : ""}`}
                    key={c.id}
                  >
                    {working && (
                      <div className="sidebar-running-signal">
                        <ActivitySignal active kind="flow" />
                      </div>
                    )}
                    <button
                      className="chat-select"
                      title={c.name}
                      onClick={() => selectChat(c.id)}
                    >
                      <HardwareSprite
                        kind="coordinator"
                        className="coordinator-art"
                        size={38}
                      />
                      <span>
                        {c.name}
                        <small>
                          {closing
                            ? "Closing…"
                            : c.close_error
                              ? "Close failed · retry"
                              : working
                                ? "Working"
                                : terminals.length
                                  ? data?.devices.find(
                                      (d) => d.id === terminals[0].device_id,
                                    )?.name || "Terminal"
                                  : c.agent
                                    ? `${agentLabel(c)} · ${data?.devices.find((d) => d.id === c.agent?.device_id)?.name || c.agent.device_id}`
                                    : agentLabel(c)}
                          {working && terminals.length > 0
                            ? ` · ${data?.devices.find((d) => d.id === terminals[0].device_id)?.name || "Terminal"}`
                            : ""}
                        </small>
                      </span>
                    </button>
                    <button
                      className="icon-button close-conversation"
                      aria-label={`Close ${c.name}`}
                      title="Close session and stop its terminals"
                      disabled={closing}
                      onClick={() => closeChat(c.id)}
                    >
                      {closing ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <X size={15} />
                      )}
                    </button>
                  </div>
                );
              })}
              {!openChats.length && (
                <div className="side-empty">No open conversations</div>
              )}
            </div>
            {data?.chats.some((c) => c.closed) && (
              <Link
                className="text-button muted session-history-link"
                to="/sessions"
                onClick={() => setSidebar(false)}
              >
                <Clock3 size={13} />
                Closed conversations
              </Link>
            )}
          </section>
          <div className="devices-section sidebar-section">
            <div className="side-section-title">
              <span>
                Devices{" "}
                <span className="section-count">{visibleDevices.length}</span>
              </span>
              <button
                className="icon-button"
                title="Add device"
                onClick={() => editDevice()}
              >
                <Plus size={16} />
              </button>
            </div>
            {visibleDevices.map((d) => (
              <button
                className="device-row"
                key={d.id}
                onClick={() => openTerminal(d.id)}
              >
                <DeviceArt
                  small
                  active={d.status === "online"}
                  os={d.os}
                  name={d.name}
                />
                <span className="device-label">
                  {d.name}
                  <small>
                    {d.id === "local"
                      ? `${d.os || "Local"} · host`
                      : d.os || "SSH"}
                  </small>
                </span>
                <i className={`dot ${d.status === "online" ? "online" : ""}`} />
              </button>
            ))}
            {(unavailableCount > 0 || showUnavailable) && (
              <button
                className="text-button muted"
                aria-pressed={showUnavailable}
                onClick={() => setShowUnavailable((value) => !value)}
              >
                {showUnavailable ? "Hide unavailable" : "Show unavailable"}
                <span className="section-count">{unavailableCount}</span>
              </button>
            )}
            <button className="text-button muted" onClick={() => editDevice()}>
              <Network size={14} />
              Add manually
            </button>
          </div>
          <div className="tailnet-note" title={data?.discovery?.message}>
            <Network size={13} />
            <span>
              {data?.discovery?.status === "connected"
                ? "Tailscale connected"
                : data?.discovery?.status === "unavailable"
                  ? "Tailscale unavailable"
                  : data?.discovery?.status === "disabled"
                    ? "Manual connections"
                    : "Finding your devices…"}
            </span>
          </div>
          <Notifications chatId={chatId} installUrl={data?.public_origin} />
          <InstallApp installUrl={data?.public_origin} />
          <div className="sidebar-foot">
            <span className="avatar">R</span>
            <div>
              Your workspace<small>Personal · private</small>
            </div>
            <button
              className="icon-button"
              onClick={() => editDevice()}
              title="Device connections"
            >
              <Settings2 size={15} />
            </button>
          </div>
        </aside>
        <main
          className={`main-content ${expanded ? "terminal-expanded" : ""}`}
          inert={compact && sidebar}
        >
          {page === "/" ? (
            <>
              <div
                className="work-pane-switch"
                role="group"
                aria-label="Workspace view"
              >
                <button
                  aria-pressed={!expanded}
                  onClick={() => setExpanded(false)}
                >
                  <MessageSquare size={16} />
                  Chat{running && <i className="dot working-dot" />}
                </button>
                <button
                  aria-pressed={expanded}
                  onClick={() => setExpanded(true)}
                >
                  <TerminalSquare size={16} />
                  Terminal{session && <i className="dot online" />}
                </button>
              </div>
              <section className="conversation">
                <header
                  className={`conversation-header ${running ? "is-working" : ""}`}
                >
                  <span
                    className={`coordinator-instrument ${running ? "is-live" : ""}`}
                  >
                    {running ? (
                      <ActivitySignal active kind={currentActivity} />
                    ) : (
                      <HardwareSprite
                        kind="coordinator"
                        className="coordinator-art"
                        size={40}
                      />
                    )}
                  </span>
                  <div>
                    <h1 title={chat?.name}>
                      {chat?.name || "New conversation"}
                    </h1>
                    <span className="coordinator-status">
                      <i
                        className={`dot ${running ? "working-dot" : "online"}`}
                      />
                      {agentLabel(chat)} <b>·</b>{" "}
                      {writing ? "Writing" : running ? "Working" : "Ready"}{" "}
                      <b className="coordinator-availability">·</b>{" "}
                      <span className="coordinator-availability">
                        {chat?.agent
                          ? data?.devices.find(
                              (d) => d.id === chat.agent?.device_id,
                            )?.name || chat.agent.device_id
                          : `${data?.devices.filter((d) => d.status === "online").length || 0} available`}
                      </span>
                    </span>
                  </div>
                  <div className="conversation-actions">
                    {chat && (
                      <button
                        className="icon-button"
                        title="Close session and stop its terminals"
                        aria-label="Close current conversation"
                        disabled={chat.closing || closingChats.includes(chatId)}
                        onClick={() => closeChat(chat.id)}
                      >
                        {chat.closing || closingChats.includes(chatId) ? (
                          <LoaderCircle size={18} className="spin" />
                        ) : (
                          <X size={18} />
                        )}
                      </button>
                    )}
                    <button
                      className="icon-button mobile-terminal"
                      title="Show work pane"
                      onClick={() => setExpanded(true)}
                    >
                      <TerminalSquare size={18} />
                    </button>
                    <button
                      className="icon-button"
                      title="New conversation"
                      onClick={newChat}
                    >
                      <Plus size={19} />
                    </button>
                  </div>
                </header>
                {chat?.close_error && (
                  <div className="session-close-error" role="alert">
                    {chat.close_error}
                  </div>
                )}
                <div
                  className="conversation-body"
                  ref={transcript}
                  onScroll={() => {
                    const element = transcript.current;
                    if (element)
                      followOutput.current =
                        element.scrollHeight -
                          element.scrollTop -
                          element.clientHeight <
                        80;
                  }}
                >
                  {isLoading ? (
                    <div className="center-note">
                      <LoaderCircle className="spin" />
                      Connecting to Tailnet Agents…
                    </div>
                  ) : error ? (
                    <div className="center-note error-note">
                      <Plug />
                      <h2>Your workspace is out of reach.</h2>
                      <p>{error.message}</p>
                      <button className="button" onClick={() => refetch()}>
                        Reconnect
                      </button>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="welcome">
                      <div className="welcome-art">
                        <HardwareSprite
                          kind="coordinator"
                          className="coordinator-art"
                          size={76}
                        />
                      </div>
                      <h2>What are we working on?</h2>
                      <p>
                        Open a terminal, or ask the coordinator to get started.
                      </p>
                      <div className="suggestions">
                        {[
                          {
                            icon: <TerminalSquare size={16} />,
                            title: "Explore this machine",
                            text: "Open a terminal on this machine and show me the working directory and available tools.",
                          },
                          {
                            icon: <Network size={16} />,
                            title: "Find my devices",
                            text: "Show me the machines currently connected to this workspace and what we can do with them.",
                          },
                        ].map((s) => (
                          <button
                            key={s.title}
                            onClick={() => {
                              setMessage(s.text);
                              composer.current?.focus();
                            }}
                          >
                            {s.icon}
                            <span>{s.title}</span>
                            <ArrowUpRight size={15} />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="day-divider">
                        <span>
                          {new Date(
                            events[0]?.time || Date.now(),
                          ).toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "long",
                          })}
                        </span>
                      </div>
                      <MessageFeed
                        entries={messages}
                        running={running}
                        devices={data!.devices}
                        sessions={data!.sessions}
                        onTerminal={selectTerminal}
                        onChat={selectChat}
                        agentName={agentLabel(chat)}
                      />
                    </>
                  )}
                  {running && !liveAction && !writing && (
                    <div className="working" role="status">
                      <ActivitySignal active kind="thinking" />
                      <span title={String(lastStatus)}>{lastStatus}</span>
                    </div>
                  )}
                  <div ref={bottom} />
                </div>
                <div className="composer-area">
                  <form
                    className={`composer ${running ? "busy" : ""}`}
                    onSubmit={send}
                  >
                    <textarea
                      ref={composer}
                      aria-label={`Message ${agentLabel(chat)}`}
                      placeholder={`Message ${agentLabel(chat)}…`}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing &&
                          !compact
                        ) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      rows={2}
                    />
                    <div className="composer-toolbar">
                      <span>
                        <Network size={14} />
                        All devices
                      </span>
                      <div>
                        <small>↵ send</small>
                        {running ? (
                          <button
                            type="button"
                            className="send-button stop"
                            title="Stop agent"
                            onClick={() =>
                              api(`/chats/${chatId}/stop`, {})
                                .then(refresh)
                                .catch(notify)
                            }
                          >
                            <Square size={14} />
                          </button>
                        ) : (
                          <button
                            className="send-button"
                            disabled={
                              !message.trim() ||
                              sending ||
                              !data ||
                              chat?.closing ||
                              closingChats.includes(chatId)
                            }
                            title="Send message"
                          >
                            <ArrowUp size={19} />
                          </button>
                        )}
                      </div>
                    </div>
                  </form>
                </div>
              </section>
              <TerminalPane
                session={session}
                device={device}
                devices={data?.devices}
                expanded={expanded}
                visible={!compact || expanded}
                onExpand={() => setExpanded((v) => !v)}
                onOpen={openTerminal}
                refresh={refresh}
                onError={notify}
              />
            </>
          ) : page === "/memory" ? (
            <React.Suspense
              fallback={<div className="empty-state">Loading memory…</div>}
            >
              <MemoryViewer />
            </React.Suspense>
          ) : page === "/devices" ? (
            <Devices
              data={data}
              devices={visibleDevices}
              showUnavailable={showUnavailable}
              onShowUnavailable={setShowUnavailable}
              unavailableCount={unavailableCount}
              openTerminal={openTerminal}
              add={() => editDevice()}
              edit={editDevice}
              refresh={refresh}
              notify={notify}
            />
          ) : page === "/sessions" ? (
            <Sessions
              data={data}
              newChat={newChat}
              selectChat={selectChat}
              closeChat={closeChat}
            />
          ) : (
            <Activity data={data} />
          )}
        </main>
      </div>
      <nav
        className="mobile-navigation"
        aria-label="Mobile navigation"
        inert={compact && sidebar}
      >
        {[
          { name: "Work", path: "/", icon: <MessageSquare size={20} /> },
          {
            name: "Sessions",
            path: "/sessions",
            icon: <TerminalSquare size={20} />,
          },
          { name: "Devices", path: "/devices", icon: <Monitor size={20} /> },
          { name: "Activity", path: "/activity", icon: <Radio size={20} /> },
          { name: "Memory", path: "/memory", icon: <Database size={20} /> },
        ].map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={page === item.path ? "active" : ""}
            aria-current={page === item.path ? "page" : undefined}
            onClick={() => setSidebar(false)}
          >
            {item.icon}
            <span>{item.name}</span>
          </Link>
        ))}
      </nav>
      <footer className="app-footer">
        <span>
          <i className={`dot ${connection === "Connected" ? "online" : ""}`} />
          {connection}
        </span>
        <div>
          <span>
            <Database size={12} />
            {data?.event_count.toLocaleString() || 0} events
          </span>
          <span
            className={data?.embedding_status === "ready" ? "memory-ready" : ""}
          >
            Memory{" "}
            {data?.embedding_status === "ready"
              ? "online"
              : data?.embedding_status || "starting"}
          </span>
          <span>
            {data?.devices.filter((d) => d.status === "online").length || 0}{" "}
            online
          </span>
        </div>
      </footer>
      {dialog && (
        <Dialog onClose={() => setDialog(null)}>
          {dialog === "agent" ? (
            <NewSession
              devices={visibleDevices}
              close={() => setDialog(null)}
              onCreated={(created) => {
                cache.setQueryData<HubState>(["hub"], (old) =>
                  old ? { ...old, chats: [created, ...old.chats] } : old,
                );
                setChatId(created.id);
                setMessage("");
                setExpanded(false);
                navigate({ to: "/" });
                refresh();
              }}
            />
          ) : dialog === "search" ? (
            <SearchPanel
              data={data}
              devices={visibleDevices}
              onClose={() => setDialog(null)}
              onSession={selectTerminal}
              onChat={selectChat}
            />
          ) : dialog === "device" ? (
            <DeviceForm
              device={editingDevice}
              close={() => setDialog(null)}
              refresh={() => {
                refresh();
                setShowUnavailable(true);
                navigate({ to: "/devices" });
              }}
            />
          ) : (
            <TerminalForm
              devices={visibleDevices}
              initialDevice={deviceId}
              chatId={terminalChatId}
              close={() => setDialog(null)}
              onCreated={(s) => {
                void selectTerminal(s.id);
              }}
            />
          )}
        </Dialog>
      )}
      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button className="icon-button" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
function MessageFeed({
  entries,
  sessions,
  devices,
  running,
  onTerminal,
  onChat,
  agentName,
}: {
  entries: ChatEntry[];
  onChat: (id: string) => void;
  agentName: string;
  sessions: Session[];
  devices: Device[];
  running: boolean;
  onTerminal: (id: string) => void;
}) {
  return entries.map(({ event, action }) =>
    event.kind === "ui.updated" ? (
      <AgentView
        key={event.id}
        chatId={event.scope}
        view={event.payload as ViewSpec}
        running={running}
      />
    ) : event.kind === "agent.requested" ? (
      <InputRequest key={event.id} event={event} running={running} />
    ) : action ? (
      <div className="action-run" key={event.id}>
        <ToolActivity
          action={action}
          running={running}
          sessions={sessions}
          devices={devices}
          onTerminal={onTerminal}
        />
        {action.end?.payload.result?.result?.chat?.agent && (
          <button
            className="delegated-session"
            onClick={() => onChat(action.end!.payload.result.result.chat.id)}
          >
            <TerminalSquare size={20} />
            <span>
              {action.end.payload.result.result.chat.name}
              <small>
                {agentLabel(action.end.payload.result.result.chat)} · Open agent
                session
              </small>
            </span>
            <ArrowUpRight size={16} />
          </button>
        )}
      </div>
    ) : (
      <MessageView
        key={event.id}
        event={event}
        running={running}
        agentName={agentName}
      />
    ),
  );
}
function MessageView({
  event: e,
  running,
  agentName = "Coordinator",
}: {
  event: Event;
  running: boolean;
  agentName?: string;
}) {
  const streaming = Boolean(e.payload.streaming && running);
  const user = e.kind === "message.user";
  const error = e.kind === "agent.error";
  return (
    <article
      className={`message ${streaming ? "is-streaming" : ""} ${user ? "user-message" : ""} ${error ? "error-message" : ""}`}
    >
      <div className="message-avatar">
        {user ? (
          <span className="avatar">R</span>
        ) : (
          <HardwareSprite
            kind="coordinator"
            className="coordinator-art"
            size={30}
          />
        )}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <strong>{user ? "You" : agentName}</strong>
          {streaming && (
            <span className="writing-indicator">
              <i aria-hidden="true" />
              Writing
            </span>
          )}
          {e.payload.interrupted && (
            <span className="message-interrupted">Interrupted</span>
          )}
          <time>{time(e.time)}</time>
          {error && <span className="tag">ERROR</span>}
        </div>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {String(e.payload.text || "")}
        </ReactMarkdown>
      </div>
    </article>
  );
}
function Dialog({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-content">{children}</div>
    </dialog>
  );
}
function TerminalForm({
  devices,
  initialDevice,
  chatId,
  close,
  onCreated,
}: {
  devices: Device[];
  initialDevice: string;
  chatId: string;
  close: () => void;
  onCreated: (s: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const p = Object.fromEntries(new FormData(e.currentTarget));
        setBusy(true);
        try {
          onCreated(
            await api<Session>("/sessions", {
              ...p,
              chat_id: chatId || undefined,
            }),
          );
          close();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="dialog-heading">
        <TerminalSquare />
        <h2>Open a terminal</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <p className="muted">
        A persistent shell you and the agent can return to.
      </p>
      <label>
        Device
        <select name="device_id" defaultValue={initialDevice}>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.target ? ` · ${d.target}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input
          name="name"
          placeholder="What is this terminal for?"
          defaultValue="Terminal"
          maxLength={120}
          autoFocus
        />
      </label>
      <label>
        Working directory
        <input name="cwd" placeholder="Home directory (default)" />
      </label>
      {error && <p className="form-error">{error}</p>}
      <footer className="dialog-actions">
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button className="button primary" disabled={busy}>
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Plus size={15} />
          )}
          Open terminal
        </button>
      </footer>
    </form>
  );
}
function DeviceForm({
  device,
  close,
  refresh,
}: {
  close: () => void;
  refresh: () => void;
  device?: Device;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const p = Object.fromEntries(new FormData(e.currentTarget));
        setBusy(true);
        try {
          await api("/devices", { ...p, ...(device ? { id: device.id } : {}) });
          refresh();
          close();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="dialog-heading">
        <Network />
        <h2>{device ? "Connection settings" : "Add an SSH device"}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <p className="muted">
        Tailscale SSH devices appear automatically. Add another host here, or
        set the login used to connect.
      </p>
      <label>
        Name
        <input
          name="name"
          placeholder="Desktop"
          defaultValue={device?.name}
          autoFocus
        />
      </label>
      <label>
        SSH destination
        <input
          name="target"
          placeholder="user@desktop"
          defaultValue={device?.target || ""}
          required
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <p className="field-hint">
        SSH key authentication and tmux must be available on the device.
      </p>
      {error && <p className="form-error">{error}</p>}
      <footer className="dialog-actions">
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button className="button primary" disabled={busy}>
          {device ? "Save connection" : "Add device"}
          <Check size={15} />
        </button>
      </footer>
    </form>
  );
}
function Devices({
  data,
  devices,
  showUnavailable,
  onShowUnavailable,
  unavailableCount,
  openTerminal,
  add,
  edit,
  refresh,
  notify,
}: {
  data?: HubState;
  devices: Device[];
  showUnavailable: boolean;
  onShowUnavailable: (show: boolean) => void;
  unavailableCount: number;
  openTerminal: (id: string) => void;
  add: () => void;
  edit: (device: Device) => void;
  refresh: () => void;
  notify: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState("");
  async function action(path: string, id: string) {
    setBusy(id);
    try {
      const r = await api<any>(path, {});
      if (r.added !== undefined) notify(`${r.added} devices discovered`);
      refresh();
    } catch (e) {
      notify(e);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="full-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">TAILSCALE NETWORK</span>
          <h1>Devices</h1>
          <p>Your SSH machines, kept in sync automatically.</p>
        </div>
        <button
          className="button"
          disabled={!!busy}
          onClick={() => action("/devices/discover", "discover")}
        >
          <RefreshCw size={15} className={busy === "discover" ? "spin" : ""} />
          Refresh
        </button>
        <button className="button primary" onClick={add}>
          <Plus size={15} />
          Add device
        </button>
      </header>
      <div className="network-summary">
        <span>
          <i
            className={`dot ${data?.discovery?.status === "connected" ? "online" : ""}`}
          />
          {data?.discovery?.message || "Finding your devices…"}
        </span>
        <span>
          {data?.discovery?.last_sync
            ? `Updated ${time(data.discovery.last_sync)}`
            : ""}
        </span>
      </div>
      <div className="device-filter">
        <span>
          {devices.length} {showUnavailable ? "devices" : "available"}
          {!showUnavailable && unavailableCount > 0 && (
            <span className="muted"> · {unavailableCount} hidden</span>
          )}
        </span>
        <label>
          <input
            type="checkbox"
            checked={showUnavailable}
            onChange={(e) => onShowUnavailable(e.target.checked)}
          />
          Show unavailable
        </label>
      </div>
      <div className="device-grid">
        <div className="device-table-head">
          <span>Machine</span>
          <span>Address</span>
          <span>Connection</span>
          <span />
        </div>
        {devices.map((d) => (
          <article
            className={`device-card ${d.status === "offline" ? "is-offline" : ""}`}
            key={d.id}
          >
            <div className="device-identity">
              <DeviceArt
                active={d.status === "online"}
                os={d.os}
                name={d.name}
              />
              <div>
                <h2>{d.name}</h2>
                <p>
                  {d.os || "SSH host"}
                  {d.id === "local" && <span> · Workspace host</span>}
                </p>
              </div>
            </div>
            <div className="device-address">
              <span>{d.address || d.target || "Local host"}</span>
              <small title={d.target || ""}>
                {d.target || "On this machine"}
              </small>
            </div>
            <div className="device-access">
              <span>
                <i className={`dot ${d.status === "online" ? "online" : ""}`} />
                {d.status === "unknown" ? "Not checked" : d.status}
              </span>
              <small>
                {d.id === "local"
                  ? "Local shell"
                  : d.ssh === "tailscale"
                    ? "Tailscale SSH"
                    : "SSH"}
              </small>
            </div>
            <div className="device-actions">
              <button
                className="icon-button"
                title={`Check connection to ${d.name}`}
                onClick={() => action(`/devices/${d.id}/probe`, d.id)}
                disabled={!!busy}
              >
                {busy === d.id ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Plug size={15} />
                )}
              </button>
              {d.target && (
                <button
                  className="icon-button"
                  title={`Connection settings for ${d.name}`}
                  onClick={() => edit(d)}
                >
                  <Settings2 size={15} />
                </button>
              )}
              <button className="button" onClick={() => openTerminal(d.id)}>
                Open terminal
                <ArrowUpRight size={14} />
              </button>
            </div>
          </article>
        ))}
        {data && devices.length === 0 && (
          <div className="device-empty">
            <p>No {showUnavailable ? "devices yet" : "available devices"}.</p>
            <span className="muted">
              {unavailableCount > 0
                ? "Show unavailable to check a connection or change its settings."
                : "Refresh your network or add an SSH device."}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
function Sessions({
  data,
  newChat,
  selectChat,
  closeChat,
}: {
  data?: HubState;
  newChat: () => void;
  selectChat: (id: string) => void;
  closeChat: (id: string) => void;
}) {
  return (
    <section className="full-page sessions-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h1>Sessions</h1>
          <p>Each session keeps its conversation and terminal together.</p>
        </div>
        <button className="button primary" onClick={newChat}>
          <Plus size={15} />
          New conversation
        </button>
      </header>
      <div className="conversation-index">
        {data?.chats.map((c) => {
          const terminal =
            data.sessions.find(
              (s) => !s.closed && c.session_ids?.includes(s.id),
            ) || data.sessions.find((s) => c.session_ids?.includes(s.id));
          return (
            <article
              className={`conversation-record ${c.closed ? "is-closed" : ""}`}
              key={c.id}
            >
              <div className="conversation-record-heading">
                <MessageSquare size={18} />
                <button
                  onClick={() => selectChat(c.id)}
                  className="conversation-record-title"
                >
                  <strong>{c.name}</strong>
                  <small>
                    {c.closed
                      ? "Closed"
                      : data.running.includes(c.id)
                        ? "Working"
                        : "Open"}{" "}
                    ·{" "}
                    {new Date(
                      c.updated_at || c.created_at,
                    ).toLocaleDateString()}
                  </small>
                </button>
                {c.closed ? (
                  <button
                    className="button"
                    aria-label={`Reopen ${c.name}`}
                    onClick={() => selectChat(c.id)}
                  >
                    Reopen
                  </button>
                ) : (
                  <button
                    className="icon-button"
                    aria-label={`Close ${c.name}`}
                    title="Close session and stop its terminals"
                    disabled={c.closing}
                    onClick={() => closeChat(c.id)}
                  >
                    {c.closing ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <X size={17} />
                    )}
                  </button>
                )}
              </div>
              {c.close_error && (
                <p className="session-close-error" role="alert">
                  {c.close_error}
                </p>
              )}
              {data.sessions.some(
                (s) => c.session_ids?.includes(s.id) && s.cleanup_pending,
              ) && (
                <p className="session-close-error" role="status">
                  Terminal shutdown pending · retrying automatically. An
                  unreachable device may still be running its process.
                </p>
              )}
              {terminal && (
                <div className="linked-terminal-list">
                  <span className="session-terminal-detail">
                    <TerminalSquare size={14} />
                    <span>
                      {
                        data.devices.find((d) => d.id === terminal.device_id)
                          ?.name
                      }
                    </span>
                    <small>
                      {terminal.cleanup_pending
                        ? "Shutdown pending"
                        : terminal.closed
                          ? "Terminal stopped"
                          : terminal.cwd || "~"}
                    </small>
                  </span>
                </div>
              )}
            </article>
          );
        })}
        {!data?.chats.length && (
          <div className="empty-table">
            <MessageSquare size={24} />
            <h2>No conversations yet</h2>
            <button className="button" onClick={newChat}>
              New conversation
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
function Activity({ data }: { data?: HubState }) {
  const [filter, setFilter] = useState("");
  const events = [...(data?.events || [])]
    .filter(
      (e) => filter || !["message.started", "message.delta"].includes(e.kind),
    )
    .reverse()
    .filter(
      (e) =>
        !filter ||
        `${e.kind} ${JSON.stringify(e.payload)}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
    );
  return (
    <section className="full-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">HISTORY</span>
          <h1>Activity</h1>
          <p>Conversations, actions, and outcomes across your devices.</p>
        </div>
        <span className="count-badge">{data?.event_count || 0} events</span>
      </header>
      <div className="activity-filter">
        <Search size={17} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter activity…"
          aria-label="Filter activity"
        />
      </div>
      <div className="activity-list">
        {events.slice(0, 200).map((e) => (
          <details className="activity-event" key={e.id}>
            <summary>
              <span className="event-glyph">
                {e.kind.startsWith("message") ? (
                  <MessageSquare size={16} />
                ) : e.kind.startsWith("terminal") ? (
                  <TerminalSquare size={16} />
                ) : (
                  <Radio size={16} />
                )}
              </span>
              <div>
                <strong>{eventLabel(e)}</strong>
                <small>
                  {String(
                    e.payload.text ||
                      e.payload.name ||
                      e.payload.error ||
                      e.scope,
                  ).slice(0, 130)}
                </small>
              </div>
              <time>{time(e.time)}</time>
              <ChevronDown size={14} />
            </summary>
            <pre>{JSON.stringify(e.payload, null, 2)}</pre>
          </details>
        ))}
      </div>
    </section>
  );
}
function SearchPanel({
  data,
  devices: visibleDevices,
  onClose,
  onSession,
  onChat,
}: {
  data?: HubState;
  devices: Device[];
  onClose: () => void;
  onSession: (s: string) => void;
  onChat: (s: string) => void;
}) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data: results, isFetching } = useQuery({
    queryKey: ["search", term],
    queryFn: () =>
      api<{ results: Event[]; semantic: boolean; semantic_pending?: boolean }>(
        `/search?q=${encodeURIComponent(term)}`,
      ),
    enabled: !!term,
    refetchInterval: (query) =>
      query.state.data?.semantic_pending ? 500 : false,
  });
  const devices =
    visibleDevices.filter(
      (d) =>
        q && `${d.name} ${d.target}`.toLowerCase().includes(q.toLowerCase()),
    ) || [];
  function select(e: Event) {
    if (data?.sessions.some((s) => s.id === e.scope)) onSession(e.scope);
    if (data?.chats.some((c) => c.id === e.scope)) onChat(e.scope);
    onClose();
  }
  return (
    <div className="search-panel">
      <div className="search-input">
        <Search size={22} />
        <input
          autoFocus
          aria-label="Search workspace"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your workspace…"
        />
        <button
          className="icon-button"
          aria-label="Close search"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="search-label">
        {isFetching
          ? "Searching…"
          : results?.semantic
            ? "Semantic + text search"
            : "Search sessions, devices, and memory"}
      </div>
      <div className="search-results">
        {devices.map((d) => (
          <div className="search-result" key={d.id}>
            <DeviceArt small os={d.os} name={d.name} />
            <div>
              <strong>{d.name}</strong>
              <small>{d.target || "This machine"}</small>
            </div>
            <span className="tag">DEVICE</span>
          </div>
        ))}
        {results?.results.map((e) => (
          <button
            className="search-result"
            key={e.id}
            onClick={() => select(e)}
          >
            {e.kind.startsWith("terminal") || e.kind.startsWith("session") ? (
              <TerminalSquare size={18} />
            ) : e.kind.startsWith("message") ? (
              <MessageSquare size={18} />
            ) : (
              <Radio size={18} />
            )}
            <div>
              <strong>{eventLabel(e)}</strong>
              <small>
                {String(
                  e.payload.text || e.payload.name || JSON.stringify(e.payload),
                ).slice(0, 140)}
              </small>
            </div>
            <ArrowUpRight size={14} />
          </button>
        ))}
        {term && !isFetching && !results?.results.length && !devices.length && (
          <div className="search-empty">No matches yet.</div>
        )}
        {!q && (
          <div className="search-empty">
            <Database size={25} />
            <p>
              Find a conversation, a command,
              <br />
              or something you worked on before.
            </p>
          </div>
        )}
      </div>
      <footer>
        <span>
          <kbd>Esc</kbd> Close
        </span>
        <span>Powered by your memory</span>
      </footer>
    </div>
  );
}
function Login({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  return (
    <div className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const token = new FormData(e.currentTarget).get("token");
          try {
            await api("/login", { token });
            onDone();
          } catch {
            setError("That access token did not match.");
          }
        }}
      >
        <HubMark large />
        <h1>Welcome to Tailnet Agents.</h1>
        <p>Enter your workspace access token.</p>
        <input
          name="token"
          type="password"
          placeholder="Access token"
          required
          autoFocus
        />
        {error && <p className="form-error">{error}</p>}
        <button className="button primary">
          Connect
          <ArrowUpRight size={16} />
        </button>
      </form>
    </div>
  );
}
const rootRoute = createRootRoute({ component: App });
const router = createRouter({
  routeTree: rootRoute.addChildren(
    ["/", "/sessions", "/devices", "/activity", "/memory"].map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        validateSearch:
          path === "/memory" || path === "/"
            ? (search: Record<string, unknown>) => search
            : undefined,
        component: () => null,
      }),
    ),
  ),
});
const hotData = import.meta.hot?.data;
registerServiceWorker();
const root = hotData?.root ?? createRoot(document.getElementById("root")!);
if (hotData) hotData.root = root;
root.render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    queryClient.clear();
  });
