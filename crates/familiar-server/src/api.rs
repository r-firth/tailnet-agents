//! HTTP API, the UI stream and the machine socket.
use crate::hub::{Hub, Inbound, OutKind};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, Request, State, WebSocketUpgrade, ws::Message as WsMessage},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

type AppState = Arc<Hub>;

pub fn router(hub: Arc<Hub>, web_dir: std::path::PathBuf) -> Router {
    let api = Router::new()
        .route("/state", get(state))
        .route("/tasks", post(create_task))
        .route("/tasks/{id}", get(task))
        .route("/tasks/{id}/terminal", get(terminal))
        .route("/tasks/{id}/frames", get(frames))
        .route("/tasks/{id}/frames/{name}", get(frame_file))
        .route("/tasks/{id}/cancel", post(cancel))
        .route("/tasks/{id}/control", post(control))
        .route("/artifacts/{id}", get(artifact))
        .route("/messages", get(messages).post(post_message))
        .route("/answer", post(answer))
        .route("/kill", post(kill))
        .route("/memory", get(memory))
        .route("/memory/{id}", get(memory_detail))
        .route("/memory/{id}/forget", post(memory_forget))
        .route("/memory/{id}/correct", post(memory_correct))
        .route("/search", get(search))
        .route("/machines", get(machines).post(start_machine))
        .route("/machines/{id}/backup", post(backup_machine))
        .route("/machines/{id}/stop", post(stop_machine))
        .route("/settings", get(get_settings).put(put_settings))
        .route("/schedules", get(schedules))
        .route("/stream", get(stream))
        .route_layer(middleware::from_fn_with_state(hub.clone(), auth))
        .route("/machines/connect", get(machine_connect))
        .route("/mcp", post(mcp))
        .route("/health", get(|| async { "ok" }));
    let index = web_dir.join("index.html");
    let static_files = tower_http::services::ServeDir::new(&web_dir).fallback(tower_http::services::ServeFile::new(index));
    Router::new().nest("/api", api).fallback_service(static_files).with_state(hub)
}

async fn auth(State(hub): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>, req: Request, next: Next) -> Response {
    // Through `tailscale serve`, Tailscale says who is asking. With FAMILIAR_TAILSCALE_USERS set,
    // only those logins get in that way, and they don't need the token.
    if let Some(login) = headers.get("tailscale-user-login").and_then(|v| v.to_str().ok()) {
        if let Ok(allowed) = std::env::var("FAMILIAR_TAILSCALE_USERS") {
            let allowed: Vec<&str> = allowed.split(',').map(str::trim).filter(|l| !l.is_empty()).collect();
            if !allowed.is_empty() {
                return if allowed.iter().any(|l| l.eq_ignore_ascii_case(login)) { next.run(req).await } else { (StatusCode::FORBIDDEN, "not on the allowed Tailscale logins").into_response() };
            }
        }
    }
    let Some(token) = hub.cfg.token.as_deref() else { return next.run(req).await };
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).and_then(|c| c.split(';').find_map(|p| p.trim().strip_prefix("familiar_token=")));
    let query = q.get("token").map(String::as_str);
    if [bearer, cookie, query].into_iter().flatten().any(|t| constant_eq(t, token)) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "token required").into_response()
    }
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn err(status: StatusCode, e: impl std::fmt::Display) -> Response {
    (status, Json(json!({"error": e.to_string()}))).into_response()
}

async fn state(State(hub): State<AppState>) -> Json<Value> {
    Json(hub.snapshot())
}

async fn task(State(hub): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(t) = hub.task(&id) else { return err(StatusCode::NOT_FOUND, "no such task") };
    Json(json!({"task": t, "events": hub.events(&id)})).into_response()
}

async fn terminal(State(hub): State<AppState>, Path(id): Path<String>) -> Response {
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], hub.terminal_log(&id)).into_response()
}

async fn frames(State(hub): State<AppState>, Path(id): Path<String>) -> Json<Value> {
    Json(json!(hub.frames(&id)))
}

async fn frame_file(State(hub): State<AppState>, Path((id, name)): Path<(String, String)>) -> Response {
    if id.contains("..") || name.contains("..") || name.contains('/') {
        return err(StatusCode::BAD_REQUEST, "bad path");
    }
    match tokio::fs::read(hub.cfg.data_dir.join("recordings").join(&id).join(&name)).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=86400")], bytes).into_response(),
        Err(_) => err(StatusCode::NOT_FOUND, "no frame"),
    }
}

async fn artifact(State(hub): State<AppState>, Path(id): Path<String>) -> Response {
    let Some((path, mime)) = hub.artifact_path(&id) else { return err(StatusCode::NOT_FOUND, "no artifact") };
    match tokio::fs::read(path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "private, max-age=86400".into())], bytes).into_response(),
        Err(e) => err(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Deserialize)]
struct NewMessage {
    text: String,
    executor: Option<String>,
}

async fn post_message(State(hub): State<AppState>, Json(body): Json<NewMessage>) -> Response {
    if body.text.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "empty message");
    }
    match hub.add_message("user", body.text.trim(), "web", None, None) {
        Ok(m) => {
            hub.inbox.send(Inbound { message: m.clone(), executor: body.executor, image: None, report_for: None }).ok();
            Json(json!({"message": m})).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn messages(State(hub): State<AppState>) -> Json<Value> {
    Json(json!(hub.recent_messages(200)))
}

#[derive(Deserialize)]
struct NewTask {
    brief: String,
    executor: Option<String>,
    title: Option<String>,
}

async fn create_task(State(hub): State<AppState>, Json(body): Json<NewTask>) -> Response {
    match hub.create_task(&body.brief, body.title.as_deref(), body.executor.as_deref(), "web", None) {
        Ok(t) => Json(json!({"task": t})).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn cancel(State(hub): State<AppState>, Path(id): Path<String>) -> Response {
    match hub.cancel_task(&id, "Cancelled by Ryan") {
        Some(t) => Json(json!({"task": t})).into_response(),
        None => err(StatusCode::NOT_FOUND, "no such task"),
    }
}

#[derive(Deserialize)]
struct ControlBody {
    action: String,
    note: Option<String>,
}

async fn control(State(hub): State<AppState>, Path(id): Path<String>, Json(body): Json<ControlBody>) -> Response {
    match hub.control(&id, body.action == "take", body.note) {
        Some(t) => Json(json!({"task": t})).into_response(),
        None => err(StatusCode::NOT_FOUND, "no such task"),
    }
}

#[derive(Deserialize)]
struct AnswerBody {
    question_id: String,
    answer: String,
    text: Option<String>,
}

async fn answer(State(hub): State<AppState>, Json(body): Json<AnswerBody>) -> Response {
    match hub.answer(&body.question_id, &body.answer, body.text, "you") {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => err(StatusCode::CONFLICT, e),
    }
}

async fn kill(State(hub): State<AppState>) -> Json<Value> {
    Json(hub.kill())
}

async fn memory(State(hub): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let mut claims = if let Some(query) = q.get("q").filter(|s| !s.trim().is_empty()) {
        hub.context_packet_async(query, 60).await
    } else {
        let mut all: Vec<Value> = hub.claims().into_iter().rev().map(|c| serde_json::to_value(c).unwrap_or_default()).collect();
        all.truncate(500);
        all
    };
    if let Some(kind) = q.get("kind").filter(|k| !k.is_empty() && *k != "all") {
        claims.retain(|c| c["kind"] == kind.as_str());
    }
    if let Some(state) = q.get("state").filter(|k| !k.is_empty() && *k != "all") {
        claims.retain(|c| c["state"] == state.as_str());
    }
    Json(json!({"claims": claims, "stats": hub.memory_stats()}))
}

async fn memory_detail(State(hub): State<AppState>, Path(id): Path<u64>) -> Response {
    match hub.claim_detail(id) {
        Some(v) => Json(v).into_response(),
        None => err(StatusCode::NOT_FOUND, "no such memory"),
    }
}

async fn memory_forget(State(hub): State<AppState>, Path(id): Path<u64>) -> Response {
    match hub.set_claim_state(id, "forgotten") {
        Ok(c) => {
            hub.emit(json!({"type": "claim", "claim": c}));
            Json(json!({"claim": c})).into_response()
        }
        Err(e) => err(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Deserialize)]
struct CorrectBody {
    text: String,
}

async fn memory_correct(State(hub): State<AppState>, Path(id): Path<u64>, Json(body): Json<CorrectBody>) -> Response {
    match hub.correct_claim(id, &body.text) {
        Ok(c) => Json(json!({"claim": c})).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn search(State(hub): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let query = q.get("q").cloned().unwrap_or_default();
    if query.trim().is_empty() {
        return Json(json!({"results": []}));
    }
    Json(json!({"results": hub.search(query.trim()).await}))
}

async fn machines(State(hub): State<AppState>) -> Json<Value> {
    Json(json!(hub.state.lock().unwrap().machines.values().cloned().collect::<Vec<_>>()))
}

#[derive(Deserialize, Default)]
struct StartMachine {
    id: Option<String>,
    fork_of: Option<String>,
}

async fn start_machine(State(hub): State<AppState>, body: Option<Json<StartMachine>>) -> Response {
    let body = body.map(|b| b.0).unwrap_or_default();
    let launcher = hub.launcher.clone();
    let id = match (&body.id, &body.fork_of) {
        (_, Some(parent)) => format!("{parent}-fork{}", chrono::Utc::now().timestamp() % 10000),
        (Some(id), None) => id.clone(),
        (None, None) => launcher.personal_id(),
    };
    match launcher.start(&hub, &id, body.fork_of.clone()).await {
        Ok(()) => Json(json!({"machine": {"id": id, "status": "starting"}})).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn backup_machine(State(hub): State<AppState>, Path(id): Path<String>) -> Response {
    match hub.launcher.backup(&id).await {
        Ok(()) => {
            hub.mark_backup(&id);
            Json(json!({"machine": hub.state.lock().unwrap().machines.get(&id).cloned()})).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn stop_machine(State(hub): State<AppState>, Path(id): Path<String>) -> Response {
    match hub.launcher.stop(&hub, &id).await {
        Ok(()) => Json(json!({"machine": hub.state.lock().unwrap().machines.get(&id).cloned()})).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn get_settings(State(hub): State<AppState>) -> Json<Value> {
    Json(hub.settings_view())
}

async fn put_settings(State(hub): State<AppState>, Json(patch): Json<Value>) -> Response {
    match hub.update_settings(&patch) {
        Ok(()) => {
            let v = hub.settings_view();
            hub.emit(json!({"type": "settings", "settings": v}));
            Json(v).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn schedules(State(hub): State<AppState>) -> Json<Value> {
    Json(json!(hub.state.lock().unwrap().schedules.values().cloned().collect::<Vec<_>>()))
}

// ---------- UI stream ----------

async fn stream(State(hub): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(1 << 20).on_upgrade(move |socket| async move {
        let (mut sink, mut source) = socket.split();
        let mut rx = hub.out.subscribe();
        let hello = json!({"type": "hello", "state": hub.snapshot()});
        if sink.send(WsMessage::Text(hello.to_string().into())).await.is_err() {
            return;
        }
        let mut focused: Option<String> = None;
        let mut last_tile: HashMap<String, Instant> = HashMap::new();
        loop {
            tokio::select! {
                out = rx.recv() => {
                    let out = match out {
                        Ok(o) => o,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    };
                    let send = match out.kind {
                        OutKind::Normal => true,
                        OutKind::Terminal => out.task == focused,
                        OutKind::Frame => {
                            if out.task == focused { true } else {
                                let key = out.task.clone().unwrap_or_default();
                                let due = last_tile.get(&key).is_none_or(|t| t.elapsed().as_millis() >= 1000);
                                if due { last_tile.insert(key, Instant::now()); }
                                due
                            }
                        }
                    };
                    if send && sink.send(WsMessage::Text(out.json.to_string().into())).await.is_err() {
                        break;
                    }
                }
                incoming = source.next() => {
                    let Some(Ok(msg)) = incoming else { break };
                    let WsMessage::Text(text) = msg else { continue };
                    let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                    match v["type"].as_str() {
                        Some("subscribe") => {
                            focused = v["task_id"].as_str().map(str::to_owned);
                            if let Some(t) = &focused { hub.subscribe_hint(t); }
                        }
                        Some("input") => {
                            if let Some(t) = v["task_id"].as_str() { hub.forward_input(t, v["input"].clone()); }
                        }
                        Some("ping") => { sink.send(WsMessage::Text(json!({"type":"pong"}).to_string().into())).await.ok(); }
                        _ => {}
                    }
                }
            }
        }
    })
}

// ---------- MCP (coordinator tools for Claude Code) ----------

async fn mcp(State(hub): State<AppState>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    let allowed = bearer.is_some_and(|b| constant_eq(b, &hub.cfg.machine_token) || hub.cfg.token.as_deref().is_some_and(|t| constant_eq(b, t)));
    if !allowed {
        return (StatusCode::UNAUTHORIZED, "token required").into_response();
    }
    let handle = |req: Value| {
        let hub = hub.clone();
        async move {
            let id = req.get("id").cloned();
            let method = req["method"].as_str().unwrap_or("").to_owned();
            let result: Result<Value, String> = match method.as_str() {
                "initialize" => Ok(json!({"protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "familiar", "version": env!("CARGO_PKG_VERSION")}})),
                "tools/list" => Ok(json!({"tools": crate::coordinator::tools().as_array().cloned().unwrap_or_default().into_iter().map(|t| json!({"name": t["function"]["name"], "description": t["function"]["description"], "inputSchema": t["function"]["parameters"]})).collect::<Vec<_>>()})),
                "tools/call" => {
                    let name = req["params"]["name"].as_str().unwrap_or("").to_owned();
                    let args = req["params"]["arguments"].clone();
                    let inbound = hub.current_inbound.lock().unwrap().clone();
                    let message = inbound.as_ref().map(|i| i.message.clone()).unwrap_or_else(|| crate::model::Message { id: "mcp".into(), role: "user".into(), text: String::new(), channel: "web".into(), task_id: None, at: crate::model::now(), artifact: None, activity: Vec::new() });
                    let executor = inbound.and_then(|i| i.executor);
                    Ok(match crate::coordinator::run_tool(&hub, &name, &args, &message, executor.as_deref()).await {
                        Ok(v) => json!({"content": [{"type": "text", "text": v.to_string()}]}),
                        Err(e) => json!({"content": [{"type": "text", "text": e.to_string()}], "isError": true}),
                    })
                }
                "ping" => Ok(json!({})),
                m if m.starts_with("notifications/") => return None,
                other => Err(format!("unknown method {other}")),
            };
            Some(match result {
                Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
                Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": e}}),
            })
        }
    };
    if let Some(batch) = body.as_array() {
        let mut out = Vec::new();
        for req in batch.clone() {
            if let Some(r) = handle(req).await {
                out.push(r);
            }
        }
        return if out.is_empty() { StatusCode::ACCEPTED.into_response() } else { Json(Value::Array(out)).into_response() };
    }
    match handle(body).await {
        Some(r) => Json(r).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

// ---------- machine socket ----------

async fn machine_connect(State(hub): State<AppState>, Query(q): Query<HashMap<String, String>>, ws: WebSocketUpgrade) -> Response {
    if !q.get("token").is_some_and(|t| constant_eq(t, &hub.cfg.machine_token)) {
        return (StatusCode::UNAUTHORIZED, "bad machine token").into_response();
    }
    ws.max_message_size(32 << 20).on_upgrade(move |socket| async move {
        let (mut sink, mut source) = socket.split();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let writer = tokio::spawn(async move {
            while let Some(v) = rx.recv().await {
                if sink.send(WsMessage::Text(v.to_string().into())).await.is_err() {
                    break;
                }
            }
        });
        let mut machine_id: Option<String> = None;
        while let Some(Ok(msg)) = source.next().await {
            let text = match msg {
                WsMessage::Text(t) => t.to_string(),
                WsMessage::Binary(b) => String::from_utf8_lossy(&b).to_string(),
                WsMessage::Close(_) => break,
                _ => continue,
            };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            if v["type"] == "hello" {
                match hub.machine_connected(&v, tx.clone()) {
                    Ok(m) => {
                        tracing::info!("machine {} connected ({})", m.id, m.backend);
                        machine_id = Some(m.id);
                    }
                    Err(e) => tracing::warn!("bad hello: {e:#}"),
                }
                continue;
            }
            if let Some(id) = &machine_id {
                hub.on_machine_message(id, v);
            }
        }
        if let Some(id) = machine_id {
            tracing::info!("machine {id} disconnected");
            hub.machine_disconnected(&id, &tx);
        }
        writer.abort();
    })
}

#[allow(dead_code)]
fn _body(_: Body) {}
