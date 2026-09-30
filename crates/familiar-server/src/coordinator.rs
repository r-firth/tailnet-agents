//! The coordinator: one agent that owns the conversation. It answers from
//! memory when it can and starts tasks on machines when hands-on work is needed.
//! Backends: an OpenRouter chat model with tools, or a rule-based fallback so
//! the product works with no keys.
use crate::hub::{Hub, Inbound};
use crate::model::{ClaimSource, Message, gbp};
use anyhow::{Context, Result, bail};
use base64::Engine;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

pub struct Coordinator {
    client: reqwest::Client,
    key: Option<String>,
    base: String,
    model: String,
    backend: Backend,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Backend {
    OpenRouter,
    Claude,
    Mock,
}

impl Coordinator {
    pub fn from_env() -> Self {
        let key = std::env::var("OPENROUTER_API_KEY").ok().map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
        let demo = std::env::var("FAMILIAR_DEMO").is_ok_and(|v| v == "1" || v == "true");
        let backend = match std::env::var("FAMILIAR_COORDINATOR").unwrap_or_default().as_str() {
            "mock" => Backend::Mock,
            "claude" => Backend::Claude,
            "openrouter" if key.is_some() => Backend::OpenRouter,
            // Default: Ryan's Claude subscription when Claude Code is installed,
            // then OpenRouter, then built-in rules. Demo mode stays offline.
            _ if demo => Backend::Mock,
            _ if on_path("claude") => Backend::Claude,
            _ if key.is_some() => Backend::OpenRouter,
            _ => Backend::Mock,
        };
        Self {
            backend,
            client: reqwest::Client::builder().timeout(Duration::from_secs(120)).build().expect("http"),
            key: if backend == Backend::OpenRouter { key } else { None },
            base: std::env::var("OPENROUTER_BASE_URL").unwrap_or_else(|_| "https://openrouter.ai/api/v1".into()),
            model: std::env::var("FAMILIAR_COORDINATOR_MODEL").unwrap_or_else(|_| "anthropic/claude-opus-5.5".into()),
        }
    }

    pub fn label(&self) -> String {
        match self.backend {
            Backend::OpenRouter => format!("openrouter:{}", self.model),
            Backend::Claude => "claude code (your subscription)".into(),
            Backend::Mock => "built-in rules (set OPENROUTER_API_KEY or FAMILIAR_COORDINATOR=claude)".into(),
        }
    }

    pub async fn run(self, hub: Arc<Hub>, mut rx: tokio::sync::mpsc::UnboundedReceiver<Inbound>) {
        while let Some(inbound) = rx.recv().await {
            hub.emit(json!({"type": "typing", "on": true}));
            *hub.current_inbound.lock().unwrap() = Some(inbound.clone());
            let result = match self.backend {
                Backend::OpenRouter => self.model_turn(&hub, &inbound).await,
                Backend::Claude => claude_turn(&hub, &inbound).await,
                Backend::Mock => mock_turn(&hub, &inbound).await,
            };
            hub.emit(json!({"type": "typing", "on": false}));
            let reply = match result {
                Ok(text) => text,
                Err(e) => {
                    tracing::warn!("coordinator failed: {e:#}");
                    // Keep working without the model rather than dropping the message.
                    match mock_turn(&hub, &inbound).await {
                        Ok(t) => format!("{t}\n\n(My model call failed, so I used my built-in rules: {e})"),
                        Err(_) => format!("Sorry, I couldn't handle that: {e}"),
                    }
                }
            };
            if !reply.trim().is_empty() {
                let channel = inbound.message.channel.clone();
                // Link the reply to the run it started, if any.
                let started = hub.state.lock().unwrap().tasks.values().filter(|t| t.message_id.as_deref() == Some(inbound.message.id.as_str())).max_by_key(|t| t.num).map(|t| t.id.clone());
                hub.add_message("assistant", reply.trim(), &channel, started, None).ok();
                if channel == "telegram" {
                    hub.tg.send(crate::hub::TgCmd::Say(reply.trim().to_owned())).ok();
                }
            }
        }
    }

    async fn model_turn(&self, hub: &Arc<Hub>, inbound: &Inbound) -> Result<String> {
        let key = self.key.as_ref().context("no key")?;
        let memory = hub.context_packet_async(&inbound.message.text, 10).await;
        let system = system_prompt(hub, &memory);
        let mut messages = vec![json!({"role": "system", "content": system})];
        for m in hub.recent_messages(16) {
            if m.id == inbound.message.id {
                continue;
            }
            let role = if m.role == "user" { "user" } else { "assistant" };
            let text = if m.task_id.is_some() && m.role == "assistant" { format!("[update from task] {}", m.text) } else { m.text };
            messages.push(json!({"role": role, "content": text}));
        }
        let mut content = vec![json!({"type": "text", "text": inbound.message.text})];
        if let Some((bytes, mime)) = &inbound.image {
            content.push(json!({"type": "image_url", "image_url": {"url": format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))}}));
        }
        messages.push(json!({"role": "user", "content": content}));
        for _round in 0..6 {
            let body = json!({"model": self.model, "messages": messages, "tools": tools(), "max_tokens": 1500});
            let response = self
                .client
                .post(format!("{}/chat/completions", self.base))
                .bearer_auth(key)
                .header("HTTP-Referer", "https://github.com/r-firth/familiar")
                .header("X-Title", "Familiar")
                .json(&body)
                .send()
                .await?;
            let status = response.status();
            let value: Value = response.json().await?;
            if !status.is_success() {
                bail!("model API {status}: {}", value["error"]["message"].as_str().unwrap_or(&value.to_string()));
            }
            let msg = value["choices"][0]["message"].clone();
            let calls = msg["tool_calls"].as_array().cloned().unwrap_or_default();
            if calls.is_empty() {
                return Ok(msg["content"].as_str().unwrap_or("").to_owned());
            }
            messages.push(json!({"role": "assistant", "content": msg["content"], "tool_calls": calls}));
            for call in calls {
                let name = call["function"]["name"].as_str().unwrap_or("");
                let args: Value = serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}")).unwrap_or(json!({}));
                let result = run_tool(hub, name, &args, &inbound.message, inbound.executor.as_deref()).await;
                let text = match result {
                    Ok(v) => v.to_string(),
                    Err(e) => json!({"error": e.to_string()}).to_string(),
                };
                messages.push(json!({"role": "tool", "tool_call_id": call["id"], "content": text}));
            }
        }
        Ok("I've set that in motion.".into())
    }
}

fn system_prompt(hub: &Arc<Hub>, memory: &[Value]) -> String {
    let tasks: Vec<String> = {
        let st = hub.state.lock().unwrap();
        let mut ts: Vec<_> = st.tasks.values().collect();
        ts.sort_by_key(|t| std::cmp::Reverse(t.num));
        ts.iter().take(8).map(|t| format!("#{} {} [{}] now: {}{}", t.num, t.title, t.status.label(), t.now, t.summary.as_ref().map(|s| format!(" · result: {s}")).unwrap_or_default())).collect()
    };
    let needs: Vec<String> = hub.needs().iter().map(|n| format!("{} (task #{}) id={} options={}", n.title, n.task_num, n.id, n.options.iter().filter_map(|o| o["id"].as_str()).collect::<Vec<_>>().join("/"))).collect();
    let mem: Vec<String> = memory.iter().map(|c| format!("[{}] {} ({}, {}, conf {:.2}{})", c["id"], c["text"].as_str().unwrap_or(""), c["kind"].as_str().unwrap_or(""), c["source"]["label"].as_str().unwrap_or(""), c["confidence"].as_f64().unwrap_or(0.0), if c["state"] == "superseded" { ", SUPERSEDED" } else { "" })).collect();
    let settings = hub.state.lock().unwrap().settings.clone();
    format!(
        "You are Familiar, Ryan's personal agent. You talk to him on Telegram and the web. You remember everything in one Vecgra graph and do hands-on work (browser, desktop, terminal, installs, coding) by starting tasks on his persistent cloud computer, where Claude Code or Codex does the work while he can watch live.\n\n\
Style: short, direct, friendly, British English, no filler. Lead with the answer.\n\n\
Rules:\n\
- If you can answer from memory or general knowledge, just answer. Don't start a task for questions.\n\
- For anything that needs a browser, logged-in account, files, installs, purchases, code or the web, call start_task with a clear, self-contained brief (include relevant facts from memory). Then tell Ryan in one line that it's started; the task reports back itself.\n\
- Executor: default is {default}. Use the one Ryan names (\"use codex\" → codex).\n\
- Remember durable facts, preferences, accounts, subscriptions and rules Ryan tells you with remember (give subject and, for facts that can change, a stable key so newer facts supersede older ones). Never store secrets.\n\
- If Ryan's message answers an open question below, call answer_question.\n\
- Spending is allowed; payments over {threshold} need his approval, which the task asks for itself.\n\
- \"stop everything\" → call kill.\n\n\
Now: {now}\n\nRecent tasks:\n{tasks}\n\nOpen questions for Ryan:\n{needs}\n\nRelevant memory (id, text, kind, source):\n{mem}",
        default = settings.default_executor,
        threshold = gbp(settings.approval_threshold_p),
        now = chrono::Utc::now().format("%A %d %B %Y %H:%M UTC"),
        tasks = if tasks.is_empty() { "none".into() } else { tasks.join("\n") },
        needs = if needs.is_empty() { "none".into() } else { needs.join("\n") },
        mem = if mem.is_empty() { "nothing relevant yet".into() } else { mem.join("\n") },
    )
}

pub fn tools() -> Value {
    let f = |name: &str, desc: &str, params: Value| json!({"type": "function", "function": {"name": name, "description": desc, "parameters": params}});
    json!([
        f("start_task", "Start hands-on work on Ryan's machine (browser, desktop, terminal). Returns the task number.", json!({"type": "object", "properties": {
            "brief": {"type": "string", "description": "Self-contained instructions for the executor, including relevant facts from memory and how to prove the outcome."},
            "title": {"type": "string", "description": "Short title, 2-6 words, in Ryan's words."},
            "executor": {"type": "string", "enum": ["claude", "codex", "scripted"], "description": "Omit for Ryan's default."}
        }, "required": ["brief", "title"]})),
        f("remember", "Store a durable memory about Ryan (fact, preference, rule, account, subscription, person).", json!({"type": "object", "properties": {
            "text": {"type": "string"}, "kind": {"type": "string", "enum": ["fact", "preference", "rule", "account", "subscription", "person"]},
            "subject": {"type": "string", "description": "What it's about, lower case (e.g. meshy, ryan, lner)."},
            "key": {"type": "string", "description": "Stable slot for facts that change (e.g. plan, address). A newer claim with the same subject+key supersedes the old one."}
        }, "required": ["text", "kind", "subject"]})),
        f("recall", "Search memory.", json!({"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]})),
        f("forget", "Forget a memory by id (tombstone).", json!({"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]})),
        f("cancel_task", "Cancel a running task by number.", json!({"type": "object", "properties": {"num": {"type": "integer"}}, "required": ["num"]})),
        f("answer_question", "Answer an open question or approval for a task.", json!({"type": "object", "properties": {"question_id": {"type": "string"}, "answer": {"type": "string", "description": "An option id, or free text."}}, "required": ["question_id", "answer"]})),
        f("schedule", "Run a task later or repeatedly (e.g. every Monday check renewals).", json!({"type": "object", "properties": {"brief": {"type": "string"}, "at": {"type": "string", "description": "RFC 3339 time of the first run"}, "every_minutes": {"type": "integer"}}, "required": ["brief", "at"]})),
        f("kill", "Stop every task and machine now.", json!({"type": "object", "properties": {}}))
    ])
}

pub async fn run_tool(hub: &Arc<Hub>, name: &str, args: &Value, msg: &Message, executor: Option<&str>) -> Result<Value> {
    match name {
        "start_task" => {
            let brief = args["brief"].as_str().context("brief")?;
            let exec = args["executor"].as_str().or(executor);
            let t = hub.create_task(brief, args["title"].as_str(), exec, &msg.channel, Some(msg.id.clone()))?;
            Ok(json!({"task": t.num, "executor": t.executor, "status": "started"}))
        }
        "remember" => {
            let c = hub.add_claim(
                args["kind"].as_str().unwrap_or("fact"),
                args["text"].as_str().context("text")?,
                args["subject"].as_str().unwrap_or(""),
                args["key"].as_str().map(str::to_owned),
                0.9,
                0.6,
                ClaimSource { task_id: None, message_id: Some(msg.id.clone()), event_id: None, label: format!("Ryan, {}", chrono::Utc::now().format("%-d %b")) },
            )?;
            Ok(json!({"id": c.id, "supersedes": c.supersedes}))
        }
        "recall" => Ok(json!(hub.context_packet_async(args["query"].as_str().unwrap_or(""), 10).await)),
        "forget" => Ok(json!(hub.set_claim_state(args["id"].as_u64().context("id")?, "forgotten")?)),
        "cancel_task" => {
            let t = hub.task_by_num(args["num"].as_u64().context("num")?).context("no such task")?;
            hub.cancel_task(&t.id, "Cancelled by Ryan");
            Ok(json!({"cancelled": t.num}))
        }
        "answer_question" => {
            hub.answer(args["question_id"].as_str().context("question_id")?, args["answer"].as_str().unwrap_or(""), args["answer"].as_str().map(str::to_owned), "you")?;
            Ok(json!({"ok": true}))
        }
        "schedule" => {
            let s = hub.add_schedule(args["brief"].as_str().context("brief")?, args["at"].as_str().context("at")?, args["every_minutes"].as_u64(), executor.map(str::to_owned))?;
            Ok(json!(s))
        }
        "kill" => Ok(hub.kill()),
        _ => bail!("unknown tool {name}"),
    }
}

/// Coordinator on Ryan's Claude subscription: a headless Claude Code turn
/// with no built-in tools and Familiar's tools over MCP (served at /api/mcp).
async fn claude_turn(hub: &Arc<Hub>, inbound: &Inbound) -> Result<String> {
    let memory = hub.context_packet_async(&inbound.message.text, 10).await;
    let system = system_prompt(hub, &memory);
    let mut transcript = String::from("Conversation so far (oldest first):\n");
    for m in hub.recent_messages(16) {
        if m.id == inbound.message.id {
            continue;
        }
        transcript.push_str(&format!("{}: {}\n", if m.role == "user" { "Ryan" } else { "Familiar" }, m.text));
    }
    let prompt = format!("{transcript}\nRyan's new message ({}): {}\n\nReply to Ryan. Use the familiar tools when needed.", inbound.message.channel, inbound.message.text);
    let mcp = json!({"mcpServers": {"familiar": {"type": "http", "url": format!("http://127.0.0.1:{}/api/mcp", hub.cfg.port), "headers": {"Authorization": format!("Bearer {}", hub.cfg.machine_token)}}}});
    let mut cmd = tokio::process::Command::new(std::env::var("FAMILIAR_CLAUDE_BIN").unwrap_or_else(|_| "claude".into()));
    cmd.args(["-p", &prompt, "--output-format", "json", "--system-prompt", &system, "--tools", "", "--mcp-config", &mcp.to_string(), "--strict-mcp-config", "--allowedTools", "mcp__familiar", "--no-session-persistence"]);
    let model = std::env::var("FAMILIAR_CLAUDE_MODEL").ok().filter(|m| !m.is_empty()).unwrap_or_else(|| "claude-opus-5-5".into());
    cmd.args(["--model", &model]);
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(240), cmd.output()).await.context("claude timed out")?.context("running claude (is Claude Code installed and logged in?)")?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(stdout.trim()).with_context(|| format!("claude said: {} {}", stdout.trim(), String::from_utf8_lossy(&out.stderr).trim()))?;
    if v["is_error"] == true {
        bail!("claude: {}", v["result"].as_str().unwrap_or("error"));
    }
    Ok(v["result"].as_str().unwrap_or("").to_owned())
}

const TASK_WORDS: &[&str] = &[
    "cancel", "unsubscribe", "install", "book", "buy", "pay", "order", "download", "render", "fix", "find", "check", "renew",
    "return", "fill", "reply", "email", "set up", "setup", "build", "deploy", "open", "sign up", "log in", "login", "update",
    "change", "compare", "research", "watch", "track", "file", "summarise", "summarize", "go to", "browse", "run",
];

/// Rule-based coordinator used without a model key (and as a fallback).
pub async fn mock_turn(hub: &Arc<Hub>, inbound: &Inbound) -> Result<String> {
    let text = inbound.message.text.trim();
    let lower = text.to_lowercase();
    let source = || ClaimSource { task_id: None, message_id: Some(inbound.message.id.clone()), event_id: None, label: format!("Ryan, {}", chrono::Utc::now().format("%-d %b")) };

    if lower == "stop everything" || lower == "/kill" || lower == "kill" {
        let r = hub.kill();
        return Ok(format!("Stopped {} task(s) and {} machine(s).", r["cancelled"], r["machines_stopped"]));
    }
    // A short reply while exactly one question is open answers it.
    let needs = hub.needs();
    if needs.len() == 1 && text.split_whitespace().count() <= 6 && !TASK_WORDS.iter().any(|w| lower.starts_with(w)) {
        let n = &needs[0];
        let option = n.options.iter().find(|o| o["label"].as_str().is_some_and(|l| l.to_lowercase().contains(&lower) || lower.contains(&l.to_lowercase())) || o["id"].as_str() == Some(lower.as_str()));
        let answer = option.and_then(|o| o["id"].as_str()).map(str::to_owned).or_else(|| {
            if matches!(lower.as_str(), "yes" | "y" | "ok" | "approve" | "go" | "do it") && n.kind == "approval" { Some("approve".into()) } else if matches!(lower.as_str(), "no" | "hold" | "stop") && n.kind == "approval" { Some("hold".into()) } else { None }
        });
        if let Some(a) = answer {
            hub.answer(&n.id, &a, None, "you")?;
            return Ok(format!("Got it, passed that to #{}.", n.task_num));
        }
        if n.allow_text {
            hub.answer(&n.id, "text", Some(text.to_owned()), "you")?;
            return Ok(format!("Passed your answer to #{}.", n.task_num));
        }
    }
    if let Some(rest) = strip_any(&lower, &["remember that ", "remember ", "note that ", "fyi "]) {
        let original = text.get(text.len().saturating_sub(rest.len())..).unwrap_or(rest);
        let subject = guess_subject(original);
        let kind = if lower.contains("prefer") || lower.contains(" like ") || lower.contains("always") || lower.contains("never") { "preference" } else { "fact" };
        let c = hub.add_claim(kind, original, &subject, None, 0.9, 0.6, source())?;
        return Ok(format!("Noted. I'll remember that {}", c.text.trim_end_matches('.').to_owned() + "."));
    }
    if let Some(rest) = strip_any(&lower, &["forget that ", "forget "]) {
        let hits = hub.context_packet_async(rest, 1).await;
        if let Some(id) = hits.first().and_then(|c| c["id"].as_u64()) {
            let c = hub.set_claim_state(id, "forgotten")?;
            return Ok(format!("Forgotten: {}", c.text));
        }
        return Ok("I couldn't find that in memory.".into());
    }
    if let Some(rest) = strip_any(&lower, &["what do you know about ", "what do you remember about ", "recall ", "do you remember "]) {
        let hits = hub.context_packet_async(rest, 6).await;
        if hits.is_empty() {
            return Ok(format!("Nothing about {rest} yet."));
        }
        let lines: Vec<String> = hits.iter().map(|c| format!("• {}{}", c["text"].as_str().unwrap_or(""), if c["state"] == "superseded" { " (superseded)" } else { "" })).collect();
        return Ok(lines.join("\n"));
    }
    if lower.starts_with("status") || lower == "/tasks" || lower.contains("what are you doing") {
        let st = hub.state.lock().unwrap();
        let active: Vec<String> = st.tasks.values().filter(|t| !t.status.finished()).map(|t| format!("#{} {}: {}", t.num, t.title, t.now)).collect();
        return Ok(if active.is_empty() { "Nothing running.".into() } else { active.join("\n") });
    }
    let first_words: String = lower.split_whitespace().take(4).collect::<Vec<_>>().join(" ");
    let looks_like_task = TASK_WORDS.iter().any(|w| first_words.contains(w)) || lower.starts_with("can you") || lower.starts_with("please") || lower.starts_with("could you");
    if looks_like_task {
        let executor = if lower.contains("use codex") || lower.contains("with codex") { Some("codex") } else if lower.contains("use claude") || lower.contains("with claude") { Some("claude") } else { inbound.executor.as_deref() };
        // Memory travels to the machine in task.start's context, not in the brief.
        let t = hub.create_task(text, Some(&crate::hub::title_from(text)), executor, &inbound.message.channel, Some(inbound.message.id.clone()))?;
        let exec = match t.executor.as_str() {
            "claude" => "Claude Code",
            "codex" => "Codex",
            _ => "the scripted demo executor",
        };
        return Ok(format!("On it: #{} {}, with {exec}. I'll message you when it's done.", t.num, t.title));
    }
    let hits = hub.context_packet_async(text, 3).await;
    let mut reply = String::from("I'm running on built-in rules until a model key is set, so I can: start tasks (\"cancel my meshy sub\"), remember things (\"remember that my card ends 4242\"), recall (\"what do you know about meshy\"), and show status.");
    if let Some(top) = hits.first().filter(|c| c["score"].as_f64().unwrap_or(0.0) > 0.45) {
        reply = format!("From memory: {}\n\n{reply}", top["text"].as_str().unwrap_or(""));
    }
    Ok(reply)
}

fn strip_any<'a>(s: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    prefixes.iter().find_map(|p| s.strip_prefix(p)).map(str::trim).filter(|r| !r.is_empty())
}

fn guess_subject(text: &str) -> String {
    // Prefer a capitalised word that isn't the first word; else "ryan".
    text.split_whitespace()
        .skip(1)
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .find(|w| w.chars().next().is_some_and(char::is_uppercase) && w.len() > 2 && *w != "I")
        .map(|w| w.to_lowercase())
        .unwrap_or_else(|| "ryan".into())
}

fn on_path(bin: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|p| p.join(bin).is_file()))
}
