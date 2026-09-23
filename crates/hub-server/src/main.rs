mod embedding;
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use futures_util::SinkExt;
use hub_server::{
    conversations::{self, Chat},
    discovery::{self, Device, DiscoveryState},
    store::{Event, Store},
    terminal::{self, Terminal},
    validate_target,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex as AsyncMutex, broadcast},
};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    id: String,
    name: String,
    device_id: String,
    cwd: String,
    created_at: String,
    #[serde(default = "agent_owner")]
    owner: String,
    #[serde(default)]
    closed: bool,
}
fn agent_owner() -> String {
    "agent".into()
}
struct Live {
    terminal: Arc<Terminal>,
    tx: broadcast::Sender<Vec<u8>>,
}
struct Hub {
    store: Mutex<Store>,
    input_lock: Mutex<()>,
    events: broadcast::Sender<Event>,
    terminals: AsyncMutex<HashMap<String, Live>>,
    terminal_lifecycle: AsyncMutex<()>,
    running: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    embedder: embedding::Embedder,
    embedding_status: Mutex<String>,
    discovery: Mutex<DiscoveryState>,
    discovery_lock: AsyncMutex<()>,
    root: PathBuf,
    token: Option<String>,
    port: u16,
    allowed_hosts: HashSet<String>,
}
type Shared = Arc<Hub>;
struct ApiError(anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":self.0.to_string()})),
        )
            .into_response()
    }
}
type Api<T> = std::result::Result<Json<T>, ApiError>;
impl Hub {
    fn record(&self, kind: &str, scope: &str, payload: Value) -> Result<Event> {
        let event = self.store.lock().unwrap().append(kind, scope, payload)?;
        let _ = self.events.send(event.clone());
        Ok(event)
    }
    fn history(&self) -> Vec<Event> {
        self.store.lock().unwrap().metadata()
    }
    fn devices(&self) -> Vec<Device> {
        let mut map = HashMap::new();
        for e in self.history() {
            if e.kind == "device.saved"
                && let Ok(d) = serde_json::from_value::<Device>(e.payload.clone())
            {
                map.insert(d.id.clone(), d);
            }
            if e.kind == "device.status"
                && let Some(d) = map.get_mut(&e.scope)
            {
                d.status = e.payload["status"].as_str().unwrap_or("unknown").into();
            }
        }
        let mut result: Vec<_> = map.into_values().collect();
        result.sort_by_key(|d| (d.id != "local", d.name.clone()));
        result
    }
    fn sessions(&self) -> Vec<Session> {
        let mut map = HashMap::new();
        for e in self.history() {
            if e.kind == "session.created"
                && let Ok(s) = serde_json::from_value::<Session>(e.payload.clone())
            {
                map.insert(s.id.clone(), s);
            }
            if let Some(s) = map.get_mut(&e.scope) {
                if e.kind == "session.closed" {
                    s.closed = true;
                }
                if e.kind == "session.control" {
                    s.owner = e.payload["owner"].as_str().unwrap_or("agent").into();
                }
            }
        }
        let mut result: Vec<_> = map.into_values().collect();
        result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        result
    }
    fn chats(&self) -> Vec<Chat> {
        conversations::project(&self.history())
    }
    fn link_terminal(&self, chat_id: &str, session_id: &str) -> Result<()> {
        let chats = self.chats();
        let chat = chats
            .iter()
            .find(|c| c.id == chat_id)
            .context("Conversation not found")?;
        if chat.closed || chat.closing {
            bail!("Conversation is closed or closing");
        }
        self.session(session_id)?;
        if chats
            .iter()
            .any(|c| c.id != chat_id && c.session_ids.iter().any(|id| id == session_id))
        {
            bail!("This terminal belongs to another session. Open that session to use it.");
        }
        if self
            .sessions()
            .iter()
            .any(|s| !s.closed && s.id != session_id && chat.session_ids.contains(&s.id))
        {
            bail!("This session already has a terminal. Use its existing terminal.");
        }
        if !chat.session_ids.iter().any(|id| id == session_id) {
            self.record(
                "chat.terminal_linked",
                chat_id,
                json!({"session_id":session_id}),
            )?;
        }
        Ok(())
    }

    fn chat_terminals(&self, chat_id: &str) -> Vec<Session> {
        let ids = self
            .chats()
            .into_iter()
            .find(|c| c.id == chat_id)
            .map(|c| c.session_ids)
            .unwrap_or_default();
        self.sessions()
            .into_iter()
            .filter(|s| ids.contains(&s.id))
            .collect()
    }

    fn check_terminal_owner(&self, chat_id: &str, session_id: &str) -> Result<()> {
        if !self
            .chat_terminals(chat_id)
            .iter()
            .any(|s| s.id == session_id && !s.closed)
        {
            bail!(
                "This terminal does not belong to this session. Use list_terminals or open_terminal for this session's terminal."
            );
        }
        Ok(())
    }

    fn migrate_terminal_ownership(&self) -> Result<()> {
        let chats = self.chats();
        let mut occupied = HashSet::new();
        for session in self.sessions().into_iter().filter(|s| !s.closed) {
            let owner = chats.iter().find(|c| c.session_ids.contains(&session.id));
            if let Some(owner) = owner
                && (owner.closing || (!owner.closed && occupied.insert(owner.id.clone())))
            {
                continue;
            }
            let chat = Chat {
                id: format!("terminal-{}", session.id),
                name: session.name.clone(),
                created_at: session.created_at.clone(),
                title_generated: true,
                ..Default::default()
            };
            self.record(
                "chat.terminal_split",
                &chat.id,
                json!({"session_id":session.id,"chat":chat}),
            )?;
        }
        Ok(())
    }

    fn session(&self, id: &str) -> Result<(Session, Device)> {
        let session = self
            .sessions()
            .into_iter()
            .find(|s| s.id == id && !s.closed)
            .context("Terminal not found or closed")?;
        let device = self
            .devices()
            .into_iter()
            .find(|d| d.id == session.device_id)
            .context("Device not found")?;
        Ok((session, device))
    }
}
async fn attached(hub: &Shared, id: &str) -> Result<(Arc<Terminal>, broadcast::Receiver<Vec<u8>>)> {
    let mut live = hub.terminals.lock().await;
    let (s, d) = hub.session(id)?;
    if let Some(l) = live.get(id) {
        return Ok((l.terminal.clone(), l.tx.subscribe()));
    }
    let (terminal, mut output) = Terminal::open(id, d.target.as_deref(), &s.cwd).await?;
    let (tx, rx) = broadcast::channel(512);
    live.insert(
        id.into(),
        Live {
            terminal: terminal.clone(),
            tx: tx.clone(),
        },
    );
    let h = hub.clone();
    let id = id.to_owned();
    tokio::spawn(async move {
        while let Some(bytes) = output.recv().await {
            let _ = tx.send(bytes);
        }
        h.terminals.lock().await.remove(&id);
        let _ = h.record("session.detached", &id, json!({}));
    });
    Ok((terminal, rx))
}

fn start_archive(h: Shared, id: String) {
    tokio::spawn(async move {
        let mut offset = h.store.lock().unwrap().archive_offset(&id);
        let mut last_error = String::new();
        while let Some(session) = h.sessions().into_iter().find(|s| s.id == id) {
            let Some(device) = h.devices().into_iter().find(|d| d.id == session.device_id) else {
                break;
            };
            match terminal::read_log(&id, device.target.as_deref(), offset).await {
                Ok(bytes) if !bytes.is_empty() => {
                    let text =
                        String::from_utf8_lossy(&strip_ansi_escapes::strip(&bytes)).into_owned();
                    let end = offset + bytes.len() as u64;
                    match h.record("terminal.output", &id, json!({"bytes": B64.encode(&bytes), "offset":offset, "end":end, "text":text})) {
                        Ok(_) => { offset = end; last_error.clear(); },
                        Err(e) => { tracing::error!("Archive write failed: {e}"); tokio::time::sleep(std::time::Duration::from_secs(2)).await; },
                    }
                    continue;
                }
                Ok(_) => {
                    if session.closed {
                        break;
                    }
                    last_error.clear();
                }
                Err(e) => {
                    let error = e.to_string();
                    if error != last_error {
                        let _ = h.record("archive.waiting", &id, json!({"error":error}));
                        last_error = error;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

async fn open_terminal(hub: &Shared, p: &Value, chat_id: Option<&str>) -> Result<Session> {
    let _lifecycle = hub.terminal_lifecycle.lock().await;
    if let Some(id) = chat_id {
        if !hub
            .chats()
            .iter()
            .any(|c| c.id == id && !c.closed && !c.closing)
        {
            bail!("Conversation is closed or closing");
        }
        if let Some(existing) = hub.chat_terminals(id).into_iter().find(|s| !s.closed) {
            if p["device_id"]
                .as_str()
                .is_some_and(|device| device != existing.device_id)
            {
                bail!(
                    "This session already has a terminal on another device. Use that terminal (SSH from it if needed), or start a new session for another device."
                );
            }
            attached(hub, &existing.id).await?;
            return Ok(existing);
        }
    }
    let device_id = p["device_id"].as_str().unwrap_or("local");
    let d = hub
        .devices()
        .into_iter()
        .find(|d| d.id == device_id)
        .context("Choose an existing device")?;
    let owner_id = match chat_id {
        Some(id) => id.to_owned(),
        None => {
            let chat = new_chat(State(hub.clone()), Json(json!({"name":p["name"]})))
                .await
                .map_err(|error| error.0)?
                .0;
            chat.id
        }
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let s = Session {
        id: id.clone(),
        name: p["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Terminal")
            .chars()
            .take(120)
            .collect(),
        device_id: d.id,
        cwd: p["cwd"].as_str().unwrap_or("").into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        owner: "agent".into(),
        closed: false,
    };
    hub.record("session.created", &id, serde_json::to_value(&s)?)?;
    // Keep a terminal with its conversation even while SSH is connecting,
    // or if the first attachment fails and the user needs to retry it.
    // Allocation holds the lifecycle lock so close includes this terminal.
    hub.record("chat.terminal_linked", &owner_id, json!({"session_id":id}))?;
    start_archive(hub.clone(), id.clone());
    match attached(hub, &id).await {
        Ok(_) => {
            hub.record("device.status", &s.device_id, json!({"status":"online"}))?;
        }
        Err(e) => {
            hub.record("session.error", &id, json!({"error":e.to_string()}))?;
            return Err(e);
        }
    }
    Ok(s)
}
async fn write_terminal(hub: &Shared, id: &str, data: &str, actor: &str) -> Result<()> {
    let (terminal, _) = attached(hub, id).await?;
    let _input_guard = hub.input_lock.lock().unwrap();
    let (s, _) = hub.session(id)?;
    if s.owner != actor {
        bail!(
            "Terminal is controlled by {}. Release control before {} sends input.",
            s.owner,
            actor
        );
    }
    hub.record("terminal.input", id, json!({"text":data,"actor":actor}))?;
    terminal.write(data.as_bytes())?;
    Ok(())
}
async fn state(State(h): State<Shared>) -> Api<Value> {
    let sessions = h.sessions();
    let live: Vec<_> = h.terminals.lock().await.keys().cloned().collect();
    let events = h.history();
    let history: Vec<_> = events
        .iter()
        .filter(|e| e.kind != "terminal.output")
        .cloned()
        .collect();
    Ok(Json(json!({
        "public_origin": std::env::var("HUB_PUBLIC_ORIGIN").ok(),
        "devices": h.devices(),
        "discovery": h.discovery.lock().unwrap().clone(),
        "sessions": sessions,
        "chats": h.chats(),
        "events": history,
        "live": live,
        "running": h.running.lock().unwrap().keys().cloned().collect::<Vec<_>>(),
        "event_count": h.store.lock().unwrap().event_count(),
        "embedding_status": h.embedding_status.lock().unwrap().clone(),
        "embedding_model": hub_server::embeddings::MODEL,
        "embedding_dimensions": hub_server::embeddings::DIMENSIONS,
        "model": std::env::var("HUB_MODEL").unwrap_or("gpt-6-astra".into()),
    })))
}
async fn image_artifact(State(h): State<Shared>, Path(id): Path<String>) -> Response {
    let path = h.store.lock().unwrap().artifacts.path(&id);
    let Some(path) = path else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = match id.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; sandbox",
            ),
        ],
        bytes,
    )
        .into_response()
}
async fn create_session(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Session> {
    let chat_id = p["chat_id"].as_str().filter(|id| !id.is_empty());
    if let Some(id) = chat_id
        && !h
            .chats()
            .iter()
            .any(|c| c.id == id && !c.closed && !c.closing)
    {
        bail_api("Conversation not found or closed")?;
    }
    Ok(Json(open_terminal(&h, &p, chat_id).await?))
}
async fn save_device(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Device> {
    let target = p["target"]
        .as_str()
        .context("SSH destination is required")?
        .trim();
    if !validate_target(target) {
        bail_api("Use an SSH alias or user@hostname")?;
    }
    let id = p["id"]
        .as_str()
        .filter(|id| *id != "local")
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if h.sessions().iter().any(|s| s.device_id == id && !s.closed) {
        bail_api("Close this device's terminals before changing its destination")?;
    }
    let previous = h
        .devices()
        .into_iter()
        .find(|d| d.id == id)
        .unwrap_or_default();
    let device = Device {
        id,
        name: p["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(target)
            .chars()
            .take(80)
            .collect(),
        target: Some(target.into()),
        status: "unknown".into(),
        source: "manual".into(),
        ..previous
    };
    h.record("device.saved", &device.id, serde_json::to_value(&device)?)?;
    Ok(Json(device))
}
fn bail_api(message: &str) -> Result<()> {
    bail!("{message}")
}
async fn probe_device(State(h): State<Shared>, Path(id): Path<String>) -> Api<Value> {
    let d = h
        .devices()
        .into_iter()
        .find(|d| d.id == id)
        .context("Device not found")?;
    let start = std::time::Instant::now();
    let result=terminal::run(d.target.as_deref(), "printf 'Connected\\n'; uname -s; command -v tmux; command -v codex || true; command -v copilot || true").await;
    let status = if result.is_ok() { "online" } else { "offline" };
    let details = result.map_err(|e| e.to_string());
    h.record(
        "device.status",
        &id,
        json!({"status":status,"details":details,"latency_ms":start.elapsed().as_millis()}),
    )?;
    Ok(Json(json!({"status":status,"details":details})))
}
async fn sync_devices(h: &Shared) -> Result<usize> {
    let _guard = h.discovery_lock.lock().await;
    let snapshot = discovery::snapshot().await?;
    let existing = h.devices();
    let changes = discovery::reconcile(&existing, &snapshot.peers);
    let added = changes
        .iter()
        .filter(|d| !existing.iter().any(|old| old.id == d.id))
        .count();
    for d in &changes {
        h.record("device.saved", &d.id, serde_json::to_value(d)?)?;
    }
    if let Some(local) = existing.iter().find(|d| d.id == "local") {
        let mut updated = local.clone();
        updated.os = snapshot.local_os;
        updated.address = snapshot.local_address;
        if &updated != local {
            h.record("device.saved", "local", serde_json::to_value(updated)?)?;
        }
    }
    let count = snapshot.peers.iter().filter(|p| p.ssh).count();
    let previous = h.discovery.lock().unwrap().status.clone();
    *h.discovery.lock().unwrap() = DiscoveryState {
        status: "connected".into(),
        message: "Synced from Tailscale".into(),
        last_sync: Some(chrono::Utc::now().to_rfc3339()),
        count,
    };
    if previous != "connected" {
        h.record("discovery.connected", "hub", json!({"devices":count}))?;
    }
    Ok(added)
}
async fn discover(State(h): State<Shared>) -> Api<Value> {
    Ok(Json(json!({"added":sync_devices(&h).await?})))
}
fn start_discovery(h: Shared) {
    if std::env::var("HUB_DISCOVERY").as_deref() == Ok("off") {
        {
            let mut state = h.discovery.lock().unwrap();
            state.status = "disabled".into();
            state.message = "Automatic discovery disabled".into();
        }
        return;
    }
    tokio::spawn(async move {
        loop {
            if let Err(error) = sync_devices(&h).await {
                let message = error.to_string();
                let changed = h.discovery.lock().unwrap().message != message;
                {
                    let mut state = h.discovery.lock().unwrap();
                    state.status = "unavailable".into();
                    state.message = message.clone();
                }
                if changed {
                    let _ = h.record("discovery.unavailable", "hub", json!({"message":message}));
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}
async fn session_action(
    State(h): State<Shared>,
    Path((id, action)): Path<(String, String)>,
    Json(p): Json<Value>,
) -> Api<Value> {
    h.session(&id)?;
    match action.as_str() {
        "control" => {
            let _input_guard = h.input_lock.lock().unwrap();
            let owner = p["owner"].as_str().unwrap_or("agent");
            if !["agent", "user"].contains(&owner) {
                bail_api("Invalid controller")?;
            }
            h.record("session.control", &id, json!({"owner":owner}))?;
        }
        "close" => {
            let _lifecycle = h.terminal_lifecycle.lock().await;
            close_terminal(&h, &id).await?;
        }
        "input" => {
            write_terminal(&h, &id, p["text"].as_str().unwrap_or(""), "user").await?;
        }
        "interrupt" => {
            let (t, _) = attached(&h, &id).await?;
            t.write(&[3])?;
            h.record("terminal.interrupted", &id, json!({"actor":"user"}))?;
        }
        _ => bail_api("Unknown terminal action")?,
    }
    Ok(Json(json!({"ok":true})))
}
async fn terminal_ws(
    State(h): State<Shared>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let (t, rx) = attached(&h, &id).await?;
    Ok(ws.on_upgrade(move |socket| stream_terminal(h, id, t, rx, socket)))
}
async fn terminal_history(
    State(h): State<Shared>,
    Path(id): Path<String>,
) -> Api<terminal::History> {
    let (_, device) = h.session(&id)?;
    Ok(Json(
        terminal::history(&id, device.target.as_deref()).await?,
    ))
}
async fn stream_terminal(
    h: Shared,
    id: String,
    t: Arc<Terminal>,
    mut rx: broadcast::Receiver<Vec<u8>>,
    mut socket: WebSocket,
) {
    let view = uuid::Uuid::new_v4().to_string();
    let mut geometry = t.geometry();
    let (cols, rows) = *geometry.borrow_and_update();
    let _ = socket
        .send(Message::Text(
            json!({"type":"geometry", "cols":cols, "rows":rows})
                .to_string()
                .into(),
        ))
        .await;
    if let Ok((_, d)) = h.session(&id)
        && let Ok(screen) = terminal::capture(&id, d.target.as_deref()).await
    {
        let _ = socket
            .send(Message::Text(
                format!("\x1b[2J\x1b[H{}", screen.replace('\n', "\r\n")).into(),
            ))
            .await;
    }
    loop {
        tokio::select! {
            changed = geometry.changed() => {
                if changed.is_err() { break; }
                let (cols, rows) = *geometry.borrow_and_update();
                let update = json!({"type": "geometry", "cols": cols, "rows": rows});
                if socket.send(Message::Text(update.to_string().into())).await.is_err() { break; }
            },
            output = rx.recv() => match output {
                Ok(data) => {
                    if socket.send(Message::Binary(data.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = socket.close().await;
                    break;
                }
                Err(_) => break,
            },
            input = socket.recv() => match input {
                Some(Ok(Message::Text(text))) => if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    if value["type"] == "resize" {
                        let cols = value["cols"].as_u64().unwrap_or(120).clamp(20, 400) as u16;
                        let rows = value["rows"].as_u64().unwrap_or(32).clamp(5, 150) as u16;
                        let active = value["active"].as_bool().unwrap_or(true);
                        let _ = t.size_view(&view, cols, rows, active);
                    }
                    if value["type"] == "input"
                        && let Err(error) = write_terminal(&h, &id, value["data"].as_str().unwrap_or(""), "user").await
                    {
                        let _ = h.record("session.error", &id, json!({"error": error.to_string()}));
                    }
                },
                Some(Ok(Message::Ping(data))) => { let _ = socket.send(Message::Pong(data)).await; }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
    let _ = t.remove_view(&view);
}
async fn event_ws(State(h): State<Shared>, ws: WebSocketUpgrade) -> Response {
    let mut rx = h.events.subscribe();
    ws.on_upgrade(move |mut socket| async move {
        loop {
            tokio::select! {
                event = rx.recv() => match event {
                    Ok(event) => {
                        if event.kind != "terminal.output" {
                            let message = Message::Text(serde_json::to_string(&event).unwrap().into());
                            if socket.send(message).await.is_err() { break; }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // A reconnect reloads the durable snapshot before new events.
                        let _ = socket.close().await;
                        break;
                    }
                    Err(_) => break,
                },
                message = socket.recv() => match message {
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    _ => {}
                },
            }
        }
    })
}
async fn new_chat(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Chat> {
    let chat = Chat {
        id: uuid::Uuid::new_v4().to_string(),
        name: p["name"]
            .as_str()
            .unwrap_or("New conversation")
            .chars()
            .take(100)
            .collect(),
        created_at: chrono::Utc::now().to_rfc3339(),
        title_generated: p["name"].as_str().is_some_and(|s| !s.trim().is_empty()),
        ..Default::default()
    };
    h.record("chat.created", &chat.id, serde_json::to_value(&chat)?)?;
    Ok(Json(chat))
}
async fn close_terminal(h: &Shared, id: &str) -> Result<()> {
    // Serialize with attachments so a reconnect cannot recreate a shell after
    // it was killed but before the closed event is committed.
    let mut live = h.terminals.lock().await;
    let session = h
        .sessions()
        .into_iter()
        .find(|s| s.id == id)
        .context("Terminal not found")?;
    if session.closed {
        return Ok(());
    }
    let device = h
        .devices()
        .into_iter()
        .find(|d| d.id == session.device_id)
        .context("Device not found")?;
    terminal::close(id, device.target.as_deref()).await?;
    h.record("session.closed", id, json!({}))?;
    live.remove(id);
    Ok(())
}

async fn close_chat(h: &Shared, id: &str) -> Result<Vec<String>> {
    {
        // Publish the close intent before waiting on in-flight SSH work. New
        // messages and terminal allocations cannot slip in during shutdown.
        let mut running = h.running.lock().unwrap();
        h.record("chat.closing", id, json!({}))?;
        if let Some(handle) = running.remove(id) {
            handle.abort();
            h.record(
                "agent.stopped",
                id,
                json!({"text":"Session closing. Stopping its terminals."}),
            )?;
        }
    }
    let _lifecycle = h.terminal_lifecycle.lock().await;
    let chat = h
        .chats()
        .into_iter()
        .find(|c| c.id == id)
        .context("Conversation not found")?;
    let mut failures = Vec::new();
    for terminal in h
        .sessions()
        .into_iter()
        .filter(|s| !s.closed && chat.session_ids.contains(&s.id))
    {
        if let Err(error) = close_terminal(h, &terminal.id).await {
            h.record(
                "session.close_failed",
                &terminal.id,
                json!({"error":error.to_string(),"chat_id":id}),
            )?;
            failures.push(format!("{}: {error}", terminal.name));
        }
    }
    if !failures.is_empty() {
        let error = format!(
            "Could not stop every terminal. Session remains open; retry closing it. {}",
            failures.join("; ")
        );
        h.record("chat.close_failed", id, json!({"error":error}))?;
        bail!("{error}");
    }
    h.record("chat.closed", id, json!({}))?;
    Ok(chat.session_ids)
}

async fn chat_action(
    State(h): State<Shared>,
    Path((id, action)): Path<(String, String)>,
    Json(p): Json<Value>,
) -> Api<Value> {
    if !h.chats().iter().any(|c| c.id == id) {
        bail_api("Conversation not found")?;
    }
    match action.as_str() {
        "close" => {
            // Finish shutdown even if the initiating browser disconnects.
            let h2 = h.clone();
            let stopped = tokio::spawn(async move { close_chat(&h2, &id).await }).await??;
            return Ok(Json(json!({"ok":true,"closed_terminals":stopped})));
        }
        "reopen" => {
            let _lifecycle = h.terminal_lifecycle.lock().await;
            let current = h
                .chats()
                .into_iter()
                .find(|c| c.id == id)
                .context("Conversation not found")?;
            if current.closing {
                bail_api("Wait for the session to finish closing")?;
            }
            if current.closed {
                h.record("chat.reopened", &id, json!({}))?;
            }
        }
        "terminals" => {
            let _lifecycle = h.terminal_lifecycle.lock().await;
            h.link_terminal(&id, p["session_id"].as_str().context("Terminal required")?)?;
        }
        _ => bail_api("Unknown conversation action")?,
    }
    Ok(Json(json!({"ok":true})))
}
async fn send_message(
    State(h): State<Shared>,
    Path(id): Path<String>,
    Json(p): Json<Value>,
) -> Api<Value> {
    if !h
        .chats()
        .iter()
        .any(|c| c.id == id && !c.closed && !c.closing)
    {
        bail_api("Conversation not found")?;
    }
    let text = p["text"].as_str().context("Message required")?.trim();
    if text.is_empty() || text.len() > 64000 {
        bail_api("Message must contain 1–64000 characters")?;
    }
    let mut running = h.running.lock().unwrap();
    if !h
        .chats()
        .iter()
        .any(|c| c.id == id && !c.closed && !c.closing)
    {
        bail_api("Conversation not found or closed")?;
    }
    if running.contains_key(&id) {
        bail_api("The agent is already working in this conversation")?;
    }
    h.record("message.user", &id, json!({"text":text}))?;
    h.record("agent.started", &id, json!({}))?;
    let h2 = h.clone();
    let id2 = id.clone();
    let task = tokio::spawn(async move {
        let result = agent_turn(&h2, &id2).await;
        if let Err(e) = result {
            let _ = h2.record("agent.error", &id2, json!({"text":e.to_string()}));
        }
        let _ = h2.record("agent.finished", &id2, json!({}));
        h2.running.lock().unwrap().remove(&id2);
    });
    running.insert(id, task.abort_handle());
    Ok(Json(json!({"ok":true})))
}
async fn stop_agent(State(h): State<Shared>, Path(id): Path<String>) -> Api<Value> {
    if let Some(handle) = h.running.lock().unwrap().remove(&id) {
        handle.abort();
        h.record(
            "agent.stopped",
            &id,
            json!({"text":"Agent stopped. Existing terminal processes continue running."}),
        )?;
    }
    Ok(Json(json!({"ok":true})))
}
struct AgentGroup(u32);
impl Drop for AgentGroup {
    fn drop(&mut self) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(self.0 as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
    }
}
async fn agent_turn(h: &Shared, id: &str) -> Result<()> {
    let history: Vec<_> = h
        .history()
        .into_iter()
        .filter(|e| {
            e.scope == id
                && ["message.user", "message.assistant", "tool.result"].contains(&e.kind.as_str())
        })
        .collect();
    let mut child = tokio::process::Command::new(h.root.join("agent/.venv/bin/python"))
        .arg("-u")
        .arg(h.root.join("agent/worker.py"))
        .env("HUB_URL", format!("http://127.0.0.1:{}", h.port))
        .env("HUB_TOKEN", h.token.as_deref().unwrap_or(""))
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Agent runtime missing. Run uv sync --project agent.")?;
    let _process_group = AgentGroup(child.id().context("Agent process has no PID")?);
    let mut stdin = child.stdin.take().unwrap();
    let conversation = h.chats().into_iter().find(|c| c.id == id);
    let task = json!({
        "chat_id": id,
        "needs_title": conversation.as_ref().is_some_and(|c| !c.title_generated),
        "conversation": conversation,
        "history": history,
        "devices": h.devices(),
        "discovery": h.discovery.lock().unwrap().clone(),
        "sessions": h.chat_terminals(id),
    });
    stdin.write_all(format!("{task}\n").as_bytes()).await?;
    drop(stdin);
    let stderr = child.stderr.take().unwrap();
    let errors = tokio::spawn(async move {
        let mut r = BufReader::new(stderr).lines();
        let mut text = String::new();
        while let Ok(Some(l)) = r.next_line().await {
            if text.len() < 4000 {
                text.push_str(&l);
                text.push('\n');
            }
        }
        text
    });
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    while let Some(line) = lines.next_line().await? {
        let frame: Value = serde_json::from_str(&line).context("Invalid agent response")?;
        if frame["type"] == "title" {
            if h.chats().iter().any(|c| c.id == id && !c.title_generated)
                && let Some(name) = frame["name"].as_str().and_then(conversations::clean_title)
            {
                h.record("chat.renamed", id, json!({"name":name}))?;
            }
            continue;
        }
        let kind = match frame["type"].as_str() {
            Some("message") => "message.assistant",
            Some("message.started") => "message.started",
            Some("message.delta") => "message.delta",
            Some("error") => "agent.error",
            Some("status") => "agent.status",
            Some("tool.started") => "tool.started",
            Some("tool.output") => "tool.output",
            Some("tool.result") => "tool.result",
            _ => continue,
        };
        h.record(kind, id, frame)?;
    }
    let status = child.wait().await?;
    let errors = errors.await.unwrap_or_default();
    if !status.success() {
        bail!(
            "Agent worker exited: {}",
            errors.chars().take(1500).collect::<String>()
        );
    }
    Ok(())
}
async fn tool(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Value> {
    let scope = p["chat_id"].as_str().context("Conversation required")?;
    let name = p["name"].as_str().context("Tool name required")?;
    let args = &p["arguments"];
    {
        let _lifecycle = h.terminal_lifecycle.lock().await;
        if !h.running.lock().unwrap().contains_key(scope)
            || !h
                .chats()
                .iter()
                .any(|c| c.id == scope && !c.closed && !c.closing)
        {
            bail_api("This conversation has no active agent")?;
        }
        h.record("tool.started", scope, json!({"name":name,"arguments":args}))?;
    }
    let result = execute_tool(&h, scope, name, args).await;
    let response = match result {
        Ok(v) => json!({"ok":true,"result":v}),
        Err(e) => json!({"ok":false,"error":e.to_string()}),
    };
    h.record(
        "tool.result",
        scope,
        json!({"name":name,"arguments":args,"result":response}),
    )?;
    Ok(Json(response))
}
async fn execute_tool(h: &Shared, chat_id: &str, name: &str, args: &Value) -> Result<Value> {
    let id = args["session_id"].as_str().unwrap_or("");
    if matches!(
        name,
        "terminal_send" | "terminal_read" | "terminal_interrupt"
    ) {
        h.check_terminal_owner(chat_id, id)?;
    }
    match name {
        "list_devices" => Ok(serde_json::to_value(h.devices())?),
        "list_terminals" => Ok(serde_json::to_value(h.chat_terminals(chat_id))?),
        "show_image" => {
            let path = args["path"]
                .as_str()
                .context("Image path required")?
                .to_owned();
            let caption = args["caption"].as_str().unwrap_or("").to_owned();
            let device_id = args["device_id"].as_str().unwrap_or("local");
            let device = h
                .devices()
                .into_iter()
                .find(|d| d.id == device_id)
                .context("Device not found")?;
            let artifacts = h.store.lock().unwrap().artifacts.clone();
            let image = if let Some(target) = device.target {
                let bytes = terminal::read_image(&target, &path).await?;
                tokio::task::spawn_blocking(move || {
                    artifacts.save(&bytes, &caption, Some(&path), Some(&device.id))
                })
                .await??
            } else {
                tokio::task::spawn_blocking(move || artifacts.local(&path, &caption)).await??
            };
            Ok(json!({"images":[image], "displayed":true}))
        }
        "open_terminal" => Ok(serde_json::to_value(
            open_terminal(h, args, Some(chat_id)).await?,
        )?),
        "terminal_send" => {
            write_terminal(
                h,
                id,
                args["text"].as_str().context("text required")?,
                "agent",
            )
            .await?;
            Ok(json!({"sent":true}))
        }
        "terminal_read" => {
            let (_, d) = h.session(id)?;
            let text = terminal::capture(id, d.target.as_deref()).await?;
            Ok(json!({"output":text}))
        }
        "terminal_interrupt" => {
            write_terminal(h, id, "\u{3}", "agent").await?;
            Ok(json!({"interrupted":true}))
        }
        "wait" => {
            tokio::time::sleep(std::time::Duration::from_secs(
                args["seconds"].as_u64().unwrap_or(2).min(10),
            ))
            .await;
            Ok(json!({"waited":true}))
        }
        "search_memory" => {
            let q = args["query"].as_str().context("query required")?;
            let v = embedding::query(h, q).await;
            Ok(serde_json::to_value(
                h.store.lock().unwrap().search(q, v.as_deref())?,
            )?)
        }
        _ => bail!("Unknown tool: {name}"),
    }
}
#[derive(Deserialize)]
struct Search {
    q: String,
}
async fn search(State(h): State<Shared>, Query(q): Query<Search>) -> Api<Value> {
    if q.q.trim().is_empty() {
        return Ok(Json(json!({"results":[],"semantic":false})));
    }
    let (v, pending) = h.embedder.search_query(q.q.trim()).await;
    let hits = h.store.lock().unwrap().search(&q.q, v.as_deref())?;
    Ok(Json(
        json!({"results":hits,"semantic":v.is_some(),"semantic_pending":pending}),
    ))
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct MemoryQuery {
    q: String,
    kind: String,
    mode: String,
    node: Option<u64>,
    anchor: Option<u64>,
    offset: Option<usize>,
}
async fn memory_search(State(h): State<Shared>, Query(q): Query<MemoryQuery>) -> Api<Value> {
    if q.q.len() > 512 {
        bail_api("Search is limited to 512 bytes")?;
    }
    let kind = if q.kind.is_empty() { "all" } else { &q.kind };
    if !["all", "raw", "message", "tool", "terminal", "system"].contains(&kind) {
        bail_api("Unknown source filter")?;
    }
    if !["", "text", "hybrid"].contains(&q.mode.as_str()) {
        bail_api("Unknown search mode")?;
    }
    let started = std::time::Instant::now();
    let (vector, pending) = if q.mode == "hybrid" && !q.q.trim().is_empty() {
        h.embedder.search_query(q.q.trim()).await
    } else {
        (None, false)
    };
    let warning = if pending {
        Some("Finding semantic matches… Text results are available now.")
    } else if q.mode == "hybrid" && !q.q.trim().is_empty() && vector.is_none() {
        Some("Semantic search is unavailable. Showing text matches.")
    } else if vector.is_some() && h.embedding_status.lock().unwrap().as_str() == "indexing" {
        Some("Memory is being reindexed. Semantic matches currently cover the completed portion.")
    } else {
        None
    };
    let kind = kind.to_owned();
    let mut response = tokio::task::spawn_blocking(move || {
        h.store.lock().unwrap().memory_search(
            &q.q,
            &kind,
            q.offset.unwrap_or(0).min(1_000_000),
            vector.as_deref(),
        )
    })
    .await??;
    response["elapsed_ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    response["warning"] = json!(warning);
    response["semantic_pending"] = json!(pending);
    Ok(Json(response))
}
async fn memory_graph(State(h): State<Shared>, Query(q): Query<MemoryQuery>) -> Api<Value> {
    let started = std::time::Instant::now();
    let mut response = tokio::task::spawn_blocking(move || {
        h.store
            .lock()
            .unwrap()
            .memory_graph(q.node, q.offset.unwrap_or(0).min(1_000_000))
    })
    .await??;
    response["elapsed_ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    Ok(Json(response))
}
async fn memory_element(
    State(h): State<Shared>,
    Path((kind, id)): Path<(String, u64)>,
) -> Api<Value> {
    Ok(Json(
        tokio::task::spawn_blocking(move || h.store.lock().unwrap().memory_element(&kind, id))
            .await??,
    ))
}
async fn memory_run(
    State(h): State<Shared>,
    Path(id): Path<u64>,
    Query(q): Query<MemoryQuery>,
) -> Api<Value> {
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            h.store.lock().unwrap().memory_run(id, q.anchor, q.offset)
        })
        .await??,
    ))
}
async fn login(State(h): State<Shared>, Json(p): Json<Value>) -> Response {
    if h.token
        .as_deref()
        .is_none_or(|s| Some(s) == p["token"].as_str())
    {
        let secure = std::env::var("HUB_PUBLIC_ORIGIN")
            .unwrap_or_default()
            .starts_with("https://");
        let cookie = format!(
            "hub_token={}; HttpOnly; SameSite=Strict; Path=/{}",
            h.token.as_deref().unwrap_or("local"),
            if secure { "; Secure" } else { "" }
        );
        ([(header::SET_COOKIE, cookie)], Json(json!({"ok":true}))).into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Access token did not match"})),
        )
            .into_response()
    }
}
async fn guard(State(h): State<Shared>, req: axum::extract::Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !h.allowed_hosts.contains(host) {
        return (StatusCode::FORBIDDEN, "Unrecognized host").into_response();
    }
    if let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok())
    {
        let origin_host = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"));
        if origin_host != Some(host) {
            return (StatusCode::FORBIDDEN, "Cross-origin request rejected").into_response();
        }
    }
    if req.uri().path().starts_with("/api/")
        && req.uri().path() != "/api/login"
        && let Some(token) = &h.token
    {
        let bearer = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        let cookie = req
            .headers()
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|c| {
                c.split(';')
                    .map(str::trim)
                    .find_map(|v| v.strip_prefix("hub_token="))
            });
        if bearer != Some(token.as_str()) && cookie != Some(token.as_str()) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"Sign in to Tailnet Agents"})),
            )
                .into_response();
        }
    }
    let is_app_metadata = matches!(
        req.uri().path(),
        "/build.json" | "/sw.js" | "/manifest.webmanifest"
    );
    let mut response = next.run(req).await;
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/html"));
    if is_html || is_app_metadata {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    response
}
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("hub_server=info,tower_http=info")
        .init();
    let root = std::env::var_os("HUB_ROOT")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let data = std::env::var_os("HUB_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(root.join("data"));
    let port = std::env::var("HUB_PORT")
        .unwrap_or("4318".into())
        .parse::<u16>()?;
    let bind = std::env::var("HUB_BIND").unwrap_or("127.0.0.1".into());
    let token = std::env::var("HUB_TOKEN").ok().filter(|s| !s.is_empty());
    if bind != "127.0.0.1" && token.as_ref().is_none_or(|s| s.len() < 32) {
        bail!("Set HUB_TOKEN to at least 32 characters before listening beyond localhost");
    }
    let mut allowed_hosts: HashSet<String> = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        "127.0.0.1:4317".into(),
        "localhost:4317".into(),
    ]
    .into_iter()
    .collect();
    if let Ok(origin) = std::env::var("HUB_PUBLIC_ORIGIN") {
        let url = reqwest::Url::parse(&origin)?;
        if let Some(host) = url.host_str() {
            allowed_hosts.insert(match url.port() {
                Some(p) => format!("{host}:{p}"),
                None => host.into(),
            });
        }
    }
    if let Ok(hosts) = std::env::var("HUB_ALLOWED_HOSTS") {
        allowed_hosts.extend(
            hosts
                .split(',')
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .map(str::to_owned),
        );
    }
    let embedder = embedding::Embedder::from_env()?;
    let mut store = Store::open(&data.join("history.vg"))?;
    if store.prepare_embeddings(&embedder.profile())?.is_some() {
        tracing::info!(
            "Previous embedding index backed up; Qwen reindexing will resume in the background"
        );
    }
    let (events, _) = broadcast::channel(1024);
    let hub = Arc::new(Hub {
        store: Mutex::new(store),
        input_lock: Mutex::new(()),
        events,
        terminals: AsyncMutex::new(HashMap::new()),
        terminal_lifecycle: AsyncMutex::new(()),
        running: Mutex::new(HashMap::new()),
        embedder,
        embedding_status: Mutex::new("starting".into()),
        discovery: Mutex::new(DiscoveryState::default()),
        discovery_lock: AsyncMutex::new(()),
        root: root.clone(),
        token,
        port,
        allowed_hosts,
    });
    if hub.devices().is_empty() {
        hub.record(
            "device.saved",
            "local",
            serde_json::to_value(Device {
                id: "local".into(),
                name: "This machine".into(),
                target: None,
                status: "online".into(),
                source: "local".into(),
                ..Default::default()
            })?,
        )?;
    }
    if hub.chats().is_empty() {
        let chat = Chat {
            id: uuid::Uuid::new_v4().to_string(),
            name: "New conversation".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        };
        hub.record("chat.created", &chat.id, serde_json::to_value(&chat)?)?;
    }
    hub.migrate_terminal_ownership()?;
    for chat in hub.chats().into_iter().filter(|c| c.closing) {
        let h = hub.clone();
        tokio::spawn(async move {
            if let Err(error) = close_chat(&h, &chat.id).await {
                tracing::warn!("Could not finish closing session {}: {error}", chat.id);
            }
        });
    }
    // Interrupted decisions aren't replayed automatically: commands may already have run.
    let mut interrupted = HashSet::new();
    for event in hub.history() {
        match event.kind.as_str() {
            "agent.started" => {
                interrupted.insert(event.scope);
            }
            "agent.finished" | "agent.stopped" => {
                interrupted.remove(&event.scope);
            }
            _ => {}
        }
    }
    for id in interrupted {
        hub.record("agent.stopped", &id, json!({"text":"Tailnet Agents restarted during this turn. Terminal processes continue; send a message to resume."}))?;
    }
    for session in hub.sessions() {
        start_archive(hub.clone(), session.id);
    }
    hub.record(
        "hub.started",
        "hub",
        json!({"version":env!("CARGO_PKG_VERSION")}),
    )?;
    embedding::start(hub.clone());
    start_discovery(hub.clone());
    let app = Router::new()
        .route("/api/state", get(state))
        .route("/api/artifacts/{id}", get(image_artifact))
        .route("/api/login", post(login))
        .route("/api/events", get(event_ws))
        .route("/api/devices", post(save_device))
        .route("/api/devices/discover", post(discover))
        .route("/api/devices/{id}/probe", post(probe_device))
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/{id}/stream", get(terminal_ws))
        .route("/api/sessions/{id}/history", get(terminal_history))
        .route("/api/sessions/{id}/{action}", post(session_action))
        .route("/api/chats", post(new_chat))
        .route("/api/chats/{id}/messages", post(send_message))
        .route("/api/chats/{id}/stop", post(stop_agent))
        .route("/api/chats/{id}/{action}", post(chat_action))
        .route("/api/tools", post(tool))
        .route("/api/search", get(search))
        .route("/api/memory/search", get(memory_search))
        .route("/api/memory/graph", get(memory_graph))
        .route("/api/memory/element/{kind}/{id}", get(memory_element))
        .route("/api/memory/runs/{id}", get(memory_run))
        .route_service(
            "/sessions",
            ServeFile::new(root.join("web/dist/index.html")),
        )
        .route_service("/devices", ServeFile::new(root.join("web/dist/index.html")))
        .route_service(
            "/activity",
            ServeFile::new(root.join("web/dist/index.html")),
        )
        .route_service("/memory", ServeFile::new(root.join("web/dist/index.html")))
        .fallback_service(
            ServeDir::new(root.join("web/dist"))
                .not_found_service(ServeFile::new(root.join("web/dist/index.html"))),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(hub.clone(), guard))
        .with_state(hub);
    let listener = tokio::net::TcpListener::bind((bind.as_str(), port)).await?;
    tracing::info!("Tailnet Agents listening on http://{bind}:{port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    fn test_hub(path: &std::path::Path) -> Shared {
        let (events, _) = broadcast::channel(16);
        Arc::new(Hub {
            store: Mutex::new(Store::open(&path.join("history.vg")).unwrap()),
            input_lock: Mutex::new(()),
            events,
            terminals: AsyncMutex::new(HashMap::new()),
            terminal_lifecycle: AsyncMutex::new(()),
            running: Mutex::new(HashMap::new()),
            embedder: embedding::Embedder::new(None, hub_server::embeddings::ENDPOINT).unwrap(),
            embedding_status: Mutex::new("starting".into()),
            discovery: Mutex::new(DiscoveryState::default()),
            discovery_lock: AsyncMutex::new(()),
            root: PathBuf::from("."),
            token: None,
            port: 0,
            allowed_hosts: HashSet::new(),
        })
    }

    #[tokio::test]
    async fn legacy_terminals_get_exclusive_owners_without_stopping_shells() {
        let path = std::env::temp_dir().join(format!("hub-ownership-{}", uuid::Uuid::new_v4()));
        let h = test_hub(&path);
        for id in ["a", "b"] {
            h.record(
                "chat.created",
                id,
                json!({"id":id,"name":id,"created_at":"now"}),
            )
            .unwrap();
        }
        for (id, time) in [("one", "1"), ("two", "2"), ("orphan", "3")] {
            h.record(
                "session.created",
                id,
                json!({"id":id,"name":id,"device_id":"local","cwd":"","created_at":time}),
            )
            .unwrap();
        }
        for id in ["one", "two"] {
            h.record("chat.terminal_linked", "a", json!({"session_id":id}))
                .unwrap();
        }
        h.record("chat.terminal_linked", "b", json!({"session_id":"one"}))
            .unwrap();
        h.migrate_terminal_ownership().unwrap();
        assert_eq!(
            h.chat_terminals("a")
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["two"]
        );
        assert!(h.chat_terminals("b").is_empty());
        for terminal in h.sessions() {
            assert!(!terminal.closed);
            let owners: Vec<_> = h
                .chats()
                .into_iter()
                .filter(|c| c.session_ids.contains(&terminal.id))
                .collect();
            assert_eq!(owners.len(), 1);
            assert_eq!(owners[0].session_ids.len(), 1);
        }
        for name in ["terminal_send", "terminal_read", "terminal_interrupt"] {
            let rejected = execute_tool(
                &h,
                "b",
                name,
                &json!({"session_id":"two","text":"should never run\n"}),
            )
            .await
            .unwrap_err();
            assert!(rejected.to_string().contains("does not belong"));
        }
        assert_eq!(
            execute_tool(&h, "a", "list_terminals", &json!({}))
                .await
                .unwrap()[0]["id"],
            "two"
        );
        assert_eq!(
            execute_tool(&h, "b", "list_terminals", &json!({}))
                .await
                .unwrap(),
            json!([])
        );
        let before = h.history().len();
        h.migrate_terminal_ownership().unwrap();
        assert_eq!(h.history().len(), before);
        drop(h);
        let restored = test_hub(&path);
        restored.migrate_terminal_ownership().unwrap();
        assert_eq!(restored.history().len(), before);
        assert_eq!(restored.chat_terminals("a")[0].id, "two");
        drop(restored);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn closing_stops_the_agent_and_blocks_queued_terminal_creation() {
        let path = std::env::temp_dir().join(format!("hub-close-{}", uuid::Uuid::new_v4()));
        let h = test_hub(&path);
        h.record(
            "chat.created",
            "chat",
            json!({"id":"chat","name":"Closing check","created_at":"now"}),
        )
        .unwrap();
        let worker = tokio::spawn(std::future::pending::<()>());
        h.running
            .lock()
            .unwrap()
            .insert("chat".into(), worker.abort_handle());
        let held = h.terminal_lifecycle.lock().await;
        let opener = {
            let h = h.clone();
            tokio::spawn(async move { open_terminal(&h, &json!({}), Some("chat")).await })
        };
        let closer = {
            let h = h.clone();
            tokio::spawn(async move { close_chat(&h, "chat").await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !h.chats()[0].closing {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(h.running.lock().unwrap().is_empty());
        assert!(worker.await.unwrap_err().is_cancelled());
        let rejected = send_message(
            State(h.clone()),
            Path("chat".into()),
            Json(json!({"text":"Too late"})),
        )
        .await;
        assert!(
            rejected.is_err(),
            "No new agent turn may start while terminals are closing"
        );
        drop(held);
        assert!(opener.await.unwrap().is_err());
        closer.await.unwrap().unwrap();
        assert!(
            h.sessions().is_empty(),
            "Queued creation escaped the close boundary"
        );
        assert!(h.chats()[0].closed && !h.chats()[0].closing);
        drop(h);
        std::fs::remove_dir_all(path).unwrap();
    }
}
