//! Telegram: long polling (no public URL needed), one message per task that
//! edits itself in place, questions and approvals as buttons, receipts as
//! photos, voice notes transcribed for the coordinator.
use crate::hub::{Hub, Inbound, TgCmd};
use crate::model::{TaskStatus, gbp};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Telegram {
    client: reqwest::Client,
    base: String,
    file_base: String,
    allowed: Vec<i64>,
}

impl Telegram {
    pub fn from_env() -> Option<Self> {
        let token = std::env::var("TELEGRAM_BOT_TOKEN").ok().filter(|t| !t.trim().is_empty())?;
        let api = std::env::var("TELEGRAM_API_BASE").unwrap_or_else(|_| "https://api.telegram.org".into());
        let allowed = std::env::var("TELEGRAM_ALLOWED_USERS").unwrap_or_default().split(',').filter_map(|s| s.trim().parse().ok()).collect();
        Some(Self {
            client: reqwest::Client::builder().timeout(Duration::from_secs(60)).build().ok()?,
            base: format!("{api}/bot{}", token.trim()),
            file_base: format!("{api}/file/bot{}", token.trim()),
            allowed,
        })
    }

    async fn call(&self, method: &str, body: Value) -> Result<Value> {
        let v: Value = self.client.post(format!("{}/{method}", self.base)).json(&body).send().await?.json().await?;
        if v["ok"] != true {
            bail!("telegram {method}: {}", v["description"].as_str().unwrap_or(&v.to_string()));
        }
        Ok(v["result"].clone())
    }

    async fn send_photo(&self, chat: i64, bytes: Vec<u8>, caption: &str) -> Result<()> {
        let form = reqwest::multipart::Form::new()
            .text("chat_id", chat.to_string())
            .text("caption", caption.chars().take(1000).collect::<String>())
            .part("photo", reqwest::multipart::Part::bytes(bytes).file_name("receipt.jpg").mime_str("image/jpeg")?);
        let v: Value = self.client.post(format!("{}/sendPhoto", self.base)).multipart(form).send().await?.json().await?;
        if v["ok"] != true {
            bail!("sendPhoto: {v}");
        }
        Ok(())
    }

    async fn download(&self, file_id: &str) -> Result<Vec<u8>> {
        let f = self.call("getFile", json!({"file_id": file_id})).await?;
        let path = f["file_path"].as_str().context("no file path")?;
        Ok(self.client.get(format!("{}/{path}", self.file_base)).send().await?.bytes().await?.to_vec())
    }
}

pub async fn run(hub: Arc<Hub>, tg: Telegram, mut cmds: tokio::sync::mpsc::UnboundedReceiver<TgCmd>) {
    *hub.telegram_label.lock().unwrap() = if tg.allowed.is_empty() { "polling (set TELEGRAM_ALLOWED_USERS)".into() } else { "polling".into() };
    let poller = tokio::spawn(poll(hub.clone(), tg.clone()));
    let mut last_edit: HashMap<String, (Instant, String)> = HashMap::new();
    let mut pending: HashMap<String, Instant> = HashMap::new();
    let mut ask_msgs: HashMap<String, (i64, i64)> = HashMap::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(700));
    loop {
        tokio::select! {
            cmd = cmds.recv() => {
                let Some(cmd) = cmd else { break };
                let Some(chat) = hub.state.lock().unwrap().settings.telegram_chat_id else { continue };
                match cmd {
                    TgCmd::Task(id) => { pending.entry(id).or_insert_with(Instant::now); }
                    TgCmd::Say(text) => { tg.call("sendMessage", json!({"chat_id": chat, "text": text})).await.map_err(|e| tracing::warn!("{e:#}")).ok(); }
                    TgCmd::Ask(qid) => {
                        let Some(n) = hub.needs().into_iter().find(|n| n.id == qid) else { continue };
                        let buttons: Vec<Vec<Value>> = n.options.iter().map(|o| vec![json!({"text": o["label"], "callback_data": format!("a|{}|{}", n.id, o["id"].as_str().unwrap_or(""))})]).collect();
                        let icon = if n.kind == "approval" { "💳" } else { "❓" };
                        let text = format!("{icon} #{} {}\n{}\n\n{}", n.task_num, n.title, n.detail, if n.allow_text { "Tap an option, or reply to this message with your answer." } else { "" });
                        match tg.call("sendMessage", json!({"chat_id": chat, "text": text.trim(), "reply_markup": {"inline_keyboard": buttons}})).await {
                            Ok(m) => { if let Some(mid) = m["message_id"].as_i64() { ask_msgs.insert(qid, (chat, mid)); } }
                            Err(e) => tracing::warn!("{e:#}"),
                        }
                    }
                    TgCmd::Resolved(qid, label) => {
                        if let Some((c, mid)) = ask_msgs.remove(&qid) {
                            tg.call("editMessageReplyMarkup", json!({"chat_id": c, "message_id": mid, "reply_markup": {"inline_keyboard": []}})).await.ok();
                            tg.call("sendMessage", json!({"chat_id": c, "text": format!("✓ {label}"), "reply_parameters": {"message_id": mid}})).await.ok();
                        }
                    }
                }
            }
            _ = ticker.tick() => {
                // Coalesce task edits: at most one edit per task every 2.5 s.
                let due: Vec<String> = pending.iter().filter(|(id, first)| {
                    last_edit.get(*id).is_none_or(|(t, _)| t.elapsed() >= Duration::from_millis(2500)) || first.elapsed() > Duration::from_secs(10)
                }).map(|(id, _)| id.clone()).collect();
                for id in due {
                    pending.remove(&id);
                    if let Err(e) = sync_task(&hub, &tg, &id, &mut last_edit).await {
                        tracing::warn!("telegram task sync: {e:#}");
                    }
                }
            }
        }
    }
    poller.abort();
}

fn status_text(hub: &Hub, t: &crate::model::Task) -> String {
    let icon = match t.status {
        TaskStatus::Queued | TaskStatus::Starting => "⏳",
        TaskStatus::Running => "▶️",
        TaskStatus::Waiting => "✋",
        TaskStatus::Done => "✅",
        TaskStatus::Failed => "⚠️",
        TaskStatus::Cancelled => "⏹",
    };
    let mut s = format!("{icon} #{} {}\n", t.num, t.title);
    if t.status.finished() {
        s.push_str(t.summary.as_deref().unwrap_or(t.status.label()));
    } else {
        let step = if t.steps_estimate > 0 { format!("Step {}/~{}: ", t.step, t.steps_estimate) } else { String::new() };
        s.push_str(&format!("{step}{}", t.now));
        if let Some(w) = &t.waiting_for {
            s.push_str(&format!("\nWaiting for {w}"));
        }
    }
    let exec = match t.executor.as_str() {
        "claude" => "Claude Code",
        "codex" => "Codex",
        _ => "scripted",
    };
    s.push_str(&format!("\n\n{exec}{}{}", t.machine_id.as_ref().map(|m| format!(" on {}", m.trim_start_matches("m_"))).unwrap_or_default(), if t.spend_p > 0 { format!(" · {}", gbp(t.spend_p)) } else { String::new() }));
    let _ = hub;
    s
}

async fn sync_task(hub: &Arc<Hub>, tg: &Telegram, id: &str, last: &mut HashMap<String, (Instant, String)>) -> Result<()> {
    let Some(t) = hub.task(id) else { return Ok(()) };
    let chat = hub.state.lock().unwrap().settings.telegram_chat_id.context("no chat yet")?;
    let text = status_text(hub, &t);
    if last.get(id).is_some_and(|(_, prev)| *prev == text) {
        return Ok(());
    }
    let markup = hub.cfg.public_url.as_ref().filter(|u| u.starts_with("https://")).map(|u| json!({"inline_keyboard": [[{"text": if t.status.finished() { "Replay" } else { "Watch live" }, "url": format!("{u}/#/task/{}", t.id)}]]}));
    match t.telegram {
        Some((c, mid)) => {
            let mut body = json!({"chat_id": c, "message_id": mid, "text": text});
            if let Some(m) = &markup {
                body["reply_markup"] = m.clone();
            }
            if let Err(e) = tg.call("editMessageText", body).await {
                if !e.to_string().contains("not modified") {
                    return Err(e);
                }
            }
        }
        None => {
            let mut body = json!({"chat_id": chat, "text": text});
            if let Some(m) = &markup {
                body["reply_markup"] = m.clone();
            }
            let m = tg.call("sendMessage", body).await?;
            if let Some(mid) = m["message_id"].as_i64() {
                hub.update_task(id, |t| t.telegram = Some((chat, mid)));
            }
        }
    }
    last.insert(id.to_owned(), (Instant::now(), text));
    // Deliver the receipt once, when the task ends.
    if t.status.finished() {
        if let Some((path, _)) = t.receipt_artifact.as_ref().and_then(|a| hub.artifact_path(a)) {
            if let Ok(bytes) = std::fs::read(path) {
                tg.send_photo(chat, bytes, &format!("#{} receipt: {}", t.num, t.summary.clone().unwrap_or_default())).await.ok();
            }
        }
    }
    Ok(())
}

async fn poll(hub: Arc<Hub>, tg: Telegram) {
    // Persisted so a restart never replays handled messages.
    let mut offset: i64 = hub.state.lock().unwrap().settings.telegram_offset;
    loop {
        let updates = match tg.call("getUpdates", json!({"offset": offset, "timeout": 25, "allowed_updates": ["message", "callback_query"]})).await {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!("telegram poll: {e:#}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        for u in updates.as_array().cloned().unwrap_or_default() {
            offset = offset.max(u["update_id"].as_i64().unwrap_or(0) + 1);
            hub.update_settings(&json!({"telegram_offset": offset})).ok();
            if let Err(e) = handle_update(&hub, &tg, &u).await {
                tracing::warn!("telegram update: {e:#}");
            }
        }
    }
}

async fn handle_update(hub: &Arc<Hub>, tg: &Telegram, u: &Value) -> Result<()> {
    if let Some(cb) = u.get("callback_query") {
        let user = cb["from"]["id"].as_i64().unwrap_or(0);
        if !tg.allowed.contains(&user) {
            return Ok(());
        }
        let data = cb["data"].as_str().unwrap_or("");
        let parts: Vec<&str> = data.splitn(3, '|').collect();
        let reply = if parts.len() == 3 && parts[0] == "a" {
            match hub.answer(parts[1], parts[2], None, "you") {
                Ok(()) => "Done".to_owned(),
                Err(e) => e.to_string(),
            }
        } else {
            "Unknown button".into()
        };
        tg.call("answerCallbackQuery", json!({"callback_query_id": cb["id"], "text": reply})).await.ok();
        return Ok(());
    }
    let Some(m) = u.get("message") else { return Ok(()) };
    let user = m["from"]["id"].as_i64().unwrap_or(0);
    let chat = m["chat"]["id"].as_i64().unwrap_or(0);
    if !tg.allowed.contains(&user) {
        tg.call("sendMessage", json!({"chat_id": chat, "text": format!("Hi. This is a private agent. If you own it, add {user} to TELEGRAM_ALLOWED_USERS and restart.")})).await.ok();
        return Ok(());
    }
    if hub.state.lock().unwrap().settings.telegram_chat_id != Some(chat) {
        hub.update_settings(&json!({"telegram_chat_id": chat}))?;
    }
    let mut text = m["text"].as_str().or(m["caption"].as_str()).unwrap_or("").trim().to_owned();
    if text == "/start" {
        tg.call("sendMessage", json!({"chat_id": chat, "text": "Familiar is connected. Ask me for anything: \"cancel my meshy sub\", \"remember that…\", /tasks, /kill."})).await?;
        return Ok(());
    }
    if text == "/kill" {
        let r = hub.kill();
        tg.call("sendMessage", json!({"chat_id": chat, "text": format!("Stopped {} task(s) and {} machine(s).", r["cancelled"], r["machines_stopped"])})).await?;
        return Ok(());
    }
    // A reply to a question message answers that question.
    if let Some(reply_to) = m["reply_to_message"]["message_id"].as_i64() {
        let _ = reply_to;
        let open: Vec<_> = hub.needs().into_iter().filter(|n| n.allow_text).collect();
        if open.len() == 1 && !text.is_empty() {
            hub.answer(&open[0].id, "text", Some(text.clone()), "you")?;
            return Ok(());
        }
    }
    let mut image = None;
    let mut artifact = None;
    if let Some(photos) = m["photo"].as_array() {
        if let Some(best) = photos.last() {
            let bytes = tg.download(best["file_id"].as_str().unwrap_or("")).await?;
            artifact = hub.save_artifact(None, &bytes, "image/jpeg", json!({"kind": "photo", "title": "Photo from Telegram"}), Some(if text.is_empty() { "photo from Ryan".into() } else { text.clone() })).ok();
            image = Some((bytes, "image/jpeg".to_owned()));
            if text.is_empty() {
                text = "(photo)".into();
            }
        }
    }
    if let Some(voice) = m.get("voice").or(m.get("audio")) {
        let bytes = tg.download(voice["file_id"].as_str().unwrap_or("")).await?;
        artifact = hub.save_artifact(None, &bytes, "audio/ogg", json!({"kind": "voice", "title": "Voice note"}), None).ok();
        text = match transcribe(&bytes).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("transcription failed: {e:#}");
                tg.call("sendMessage", json!({"chat_id": chat, "text": "I got your voice note but couldn't transcribe it (needs OPENROUTER_API_KEY). Could you type it?"})).await.ok();
                return Ok(());
            }
        };
    }
    if text.is_empty() {
        return Ok(());
    }
    let message = hub.add_message("user", &text, "telegram", None, artifact)?;
    tg.call("sendChatAction", json!({"chat_id": chat, "action": "typing"})).await.ok();
    hub.inbox.send(Inbound { message, executor: None, image, report_for: None }).ok();
    Ok(())
}

/// Voice notes are transcribed by an audio-capable model on OpenRouter.
async fn transcribe(bytes: &[u8]) -> Result<String> {
    use base64::Engine;
    let key = std::env::var("OPENROUTER_API_KEY").ok().filter(|k| !k.trim().is_empty()).context("no OPENROUTER_API_KEY")?;
    let base = std::env::var("OPENROUTER_BASE_URL").unwrap_or_else(|_| "https://openrouter.ai/api/v1".into());
    let model = std::env::var("FAMILIAR_TRANSCRIBE_MODEL").unwrap_or_else(|_| "google/gemini-3.8-flash".into());
    let body = json!({"model": model, "messages": [{"role": "user", "content": [
        {"type": "text", "text": "Transcribe this voice note verbatim. Reply with the transcript only."},
        {"type": "input_audio", "input_audio": {"data": base64::engine::general_purpose::STANDARD.encode(bytes), "format": "ogg"}}
    ]}]});
    let v: Value = reqwest::Client::new().post(format!("{base}/chat/completions")).bearer_auth(key).json(&body).send().await?.json().await?;
    let text = v["choices"][0]["message"]["content"].as_str().context("no transcript")?.trim().to_owned();
    if text.is_empty() {
        bail!("empty transcript");
    }
    Ok(text)
}
