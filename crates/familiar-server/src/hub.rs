//! The coordinator's in-process state: tasks, timelines, machines, questions,
//! conversation and memory, all persisted in Vecgra through `Store`.
use crate::embed::{Embedder, Input};
use crate::model::*;
use crate::store::{Loaded, Store};
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::{broadcast, mpsc};
use vecgra::Value as V;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutKind {
    Normal,
    Frame,
    Terminal,
}

#[derive(Clone, Debug)]
pub struct Out {
    pub kind: OutKind,
    pub task: Option<String>,
    pub json: Arc<str>,
}

/// Work for the Telegram adapter.
#[derive(Clone, Debug)]
pub enum TgCmd {
    Task(String),
    Ask(String),
    Resolved(String, String),
    Say(String),
}

/// A message for the coordinator loop.
#[derive(Clone, Debug)]
pub struct Inbound {
    pub message: Message,
    pub executor: Option<String>,
    pub image: Option<(Vec<u8>, String)>,
}

pub struct Config {
    pub data_dir: std::path::PathBuf,
    pub port: u16,
    pub token: Option<String>,
    pub machine_token: String,
    pub public_url: Option<String>,
    pub demo: bool,
}

pub struct State {
    pub store: Store,
    pub tasks: BTreeMap<String, Task>,
    task_nodes: HashMap<String, u64>,
    pub events: HashMap<String, Vec<Event>>,
    last_event: HashMap<String, u64>,
    pub messages: Vec<(u64, Message)>,
    pub claims: BTreeMap<u64, Claim>,
    subjects: HashMap<String, u64>,
    pub machines: BTreeMap<String, Machine>,
    pub needs: BTreeMap<String, NeedsYou>,
    question_machine: HashMap<String, String>,
    pub settings: Settings,
    pub schedules: BTreeMap<String, Schedule>,
    pub artifacts: HashMap<String, Value>,
    next_num: u64,
    last_frame_saved: HashMap<String, Instant>,
    task_started: HashMap<String, Instant>,
}

pub struct Hub {
    pub cfg: Config,
    pub state: Mutex<State>,
    pub out: broadcast::Sender<Out>,
    pub embedder: Embedder,
    embed_tx: mpsc::UnboundedSender<(u64, Input)>,
    pub tg: mpsc::UnboundedSender<TgCmd>,
    pub inbox: mpsc::UnboundedSender<Inbound>,
    pub machine_links: Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>,
    pub launcher: crate::launcher::Launcher,
    pub coordinator_label: Mutex<String>,
    /// The user message the coordinator is handling (attribution for MCP tool calls).
    pub current_inbound: Mutex<Option<Inbound>>,
    pub telegram_label: Mutex<String>,
}

pub struct Receivers {
    pub embed: mpsc::UnboundedReceiver<(u64, Input)>,
    pub tg: mpsc::UnboundedReceiver<TgCmd>,
    pub inbox: mpsc::UnboundedReceiver<Inbound>,
}

fn s(v: &str) -> V {
    V::String(Arc::from(v))
}

impl Hub {
    pub fn open(cfg: Config, embedder: Embedder, launcher: crate::launcher::Launcher) -> Result<(Arc<Self>, Receivers)> {
        let (store, loaded) = Store::open(&cfg.data_dir)?;
        let default_executor = std::env::var("FAMILIAR_DEFAULT_EXECUTOR").unwrap_or_else(|_| if cfg.demo { "scripted".into() } else { "claude".into() });
        let threshold = std::env::var("FAMILIAR_APPROVAL_THRESHOLD_GBP").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(100.0);
        let mut st = State {
            store,
            tasks: BTreeMap::new(),
            task_nodes: HashMap::new(),
            events: HashMap::new(),
            last_event: HashMap::new(),
            messages: Vec::new(),
            claims: BTreeMap::new(),
            subjects: HashMap::new(),
            machines: BTreeMap::new(),
            needs: BTreeMap::new(),
            question_machine: HashMap::new(),
            settings: Settings {
                approval_threshold_p: (threshold * 100.0).round() as i64,
                default_executor,
                no_ask_merchants: vec![],
                telegram_chat_id: None,
                time_cap_s: 3600,
            },
            schedules: BTreeMap::new(),
            artifacts: HashMap::new(),
            next_num: 1,
            last_frame_saved: HashMap::new(),
            task_started: HashMap::new(),
        };
        let mut unembedded = Vec::new();
        for Loaded { label, id, json, has_vector } in loaded {
            match label.as_str() {
                "Task" => {
                    if let Ok(mut t) = serde_json::from_value::<Task>(json) {
                        st.next_num = st.next_num.max(t.num + 1);
                        if !t.status.finished() {
                            // The machine connection died with the old process.
                            t.status = TaskStatus::Failed;
                            t.outcome = Some("failed".into());
                            t.summary = Some("Interrupted by a coordinator restart. Check the real state before retrying.".into());
                            t.ended_at = Some(now());
                            st.store.rewrite(id, &t).ok();
                        }
                        st.task_nodes.insert(t.id.clone(), id);
                        st.tasks.insert(t.id.clone(), t);
                    }
                }
                "Event" => {
                    if let Ok(mut e) = serde_json::from_value::<Event>(json) {
                        e.id = id;
                        st.last_event.insert(e.task_id.clone(), id);
                        st.events.entry(e.task_id.clone()).or_default().push(e);
                    }
                }
                "Message" => {
                    if let Ok(m) = serde_json::from_value::<Message>(json) {
                        if !has_vector {
                            unembedded.push((id, Input::Text(m.text.clone())));
                        }
                        st.messages.push((id, m));
                    }
                }
                "Claim" => {
                    if let Ok(mut c) = serde_json::from_value::<Claim>(json) {
                        c.id = id;
                        if !has_vector {
                            unembedded.push((id, Input::Text(claim_text(&c))));
                        }
                        st.claims.insert(id, c);
                    }
                }
                "Subject" => {
                    if let Some(name) = json["name"].as_str() {
                        st.subjects.insert(name.to_owned(), id);
                    }
                }
                "Machine" => {
                    if let Ok(mut m) = serde_json::from_value::<Machine>(json) {
                        m.status = "offline".into();
                        m.task_id = None;
                        st.machines.insert(m.id.clone(), m);
                    }
                }
                "Settings" => {
                    if let Ok(settings) = serde_json::from_value::<Settings>(json) {
                        st.settings = settings;
                    }
                }
                "Schedule" => {
                    if let Ok(sch) = serde_json::from_value::<Schedule>(json) {
                        st.schedules.insert(sch.id.clone(), sch);
                    }
                }
                "Artifact" => {
                    if let Some(aid) = json["id"].as_str() {
                        st.artifacts.insert(aid.to_owned(), json.clone());
                    }
                }
                _ => {}
            }
        }
        let task_ids: Vec<String> = st.tasks.keys().cloned().collect();
        for id in task_ids {
            if let Some(t) = st.tasks.get(&id) {
                if t.summary.is_some() && !st.task_nodes.get(&id).is_some_and(|n| st.store.has_vector(*n)) {
                    unembedded.push((st.task_nodes[&id], Input::Text(task_text(t))));
                }
            }
        }
        let (out, _) = broadcast::channel(4096);
        let (embed_tx, embed_rx) = mpsc::unbounded_channel();
        let (tg_tx, tg_rx) = mpsc::unbounded_channel();
        let (inbox_tx, inbox_rx) = mpsc::unbounded_channel();
        let hub = Arc::new(Self {
            cfg,
            state: Mutex::new(st),
            out,
            embedder,
            embed_tx,
            tg: tg_tx,
            inbox: inbox_tx,
            machine_links: Mutex::new(HashMap::new()),
            launcher,
            coordinator_label: Mutex::new(String::new()),
            current_inbound: Mutex::new(None),
            telegram_label: Mutex::new("off".into()),
        });
        hub.check_embedding_profile()?;
        for item in unembedded {
            hub.embed_tx.send(item).ok();
        }
        Ok((hub, Receivers { embed: embed_rx, tg: tg_rx, inbox: inbox_rx }))
    }

    fn check_embedding_profile(&self) -> Result<()> {
        let profile = self.embedder.profile();
        let mut st = self.state.lock().unwrap();
        let current: Option<Value> = st.store.id_of("embedding:profile").and_then(|id| st.store.doc(id));
        if current.as_ref().and_then(|v| v["profile"].as_str()) != Some(profile.as_str()) {
            if current.is_some() {
                tracing::warn!("embedding profile changed to {profile}; clearing vectors for re-embedding");
                st.store.clear_vectors()?;
                // Everything becomes pending again.
                let items: Vec<(u64, Input)> = st
                    .claims
                    .values()
                    .map(|c| (c.id, Input::Text(claim_text(c))))
                    .chain(st.messages.iter().map(|(id, m)| (*id, Input::Text(m.text.clone()))))
                    .collect();
                for item in items {
                    self.embed_tx.send(item).ok();
                }
            }
            st.store.put("EmbeddingConfig", "embedding:profile", &json!({"profile": profile}), &[])?;
        }
        Ok(())
    }

    // ---------- broadcasting ----------

    pub fn emit(&self, value: Value) {
        self.out.send(Out { kind: OutKind::Normal, task: None, json: Arc::from(value.to_string()) }).ok();
    }

    fn emit_task(&self, t: &Task) {
        self.emit(json!({"type": "task", "task": t}));
    }

    pub fn emit_needs(&self) {
        let items: Vec<NeedsYou> = self.state.lock().unwrap().needs.values().cloned().collect();
        self.emit(json!({"type": "needs_you", "items": items}));
    }

    pub fn emit_stats(&self) {
        let stats = self.stats();
        self.emit(json!({"type": "stats", "stats": stats}));
    }

    pub fn stats(&self) -> Value {
        let st = self.state.lock().unwrap();
        let today = chrono::Utc::now().date_naive().to_string();
        let todays: Vec<&Task> = st.tasks.values().filter(|t| t.created_at.starts_with(&today)).collect();
        json!({
            "spend_today_p": todays.iter().map(|t| t.spend_p).sum::<i64>(),
            "tokens_today": todays.iter().map(|t| t.tokens).sum::<u64>(),
            "memory_nodes": st.store.node_count(),
            "claims": st.claims.values().filter(|c| c.state == "active").count(),
            "runs_today": todays.len(),
            "runs_done_today": todays.iter().filter(|t| t.status == TaskStatus::Done).count(),
            "working": st.tasks.values().filter(|t| matches!(t.status, TaskStatus::Running | TaskStatus::Starting)).count(),
            "waiting": st.needs.len(),
        })
    }

    pub fn settings_view(&self) -> Value {
        let st = self.state.lock().unwrap();
        let mut v = serde_json::to_value(&st.settings).unwrap_or_default();
        v["coordinator"] = json!(self.coordinator_label.lock().unwrap().clone());
        v["embedder"] = json!(self.embedder.label());
        v["telegram"] = json!(self.telegram_label.lock().unwrap().clone());
        v["backends"] = json!(self.launcher.backends());
        v["demo"] = json!(self.cfg.demo);
        v
    }

    pub fn snapshot(&self) -> Value {
        let stats = self.stats();
        let settings = self.settings_view();
        let st = self.state.lock().unwrap();
        let mut tasks: Vec<&Task> = st.tasks.values().collect();
        tasks.sort_by_key(|t| std::cmp::Reverse(t.num));
        tasks.truncate(100);
        let messages: Vec<&Message> = st.messages.iter().rev().take(50).map(|(_, m)| m).collect::<Vec<_>>().into_iter().rev().collect();
        json!({
            "tasks": tasks,
            "machines": st.machines.values().collect::<Vec<_>>(),
            "needs_you": st.needs.values().collect::<Vec<_>>(),
            "messages": messages,
            "stats": stats,
            "settings": settings,
        })
    }

    // ---------- conversation ----------

    pub fn add_message(&self, role: &str, text: &str, channel: &str, task_id: Option<String>, artifact: Option<String>) -> Result<Message> {
        let m = Message { id: new_id("msg"), role: role.into(), text: text.into(), channel: channel.into(), task_id, at: now(), artifact };
        let id = {
            let mut st = self.state.lock().unwrap();
            let id = st.store.put("Message", &format!("message:{}", m.id), &m, &[("role", s(role))])?;
            st.messages.push((id, m.clone()));
            id
        };
        self.embed_tx.send((id, Input::Text(format!("{role}: {text}")))).ok();
        self.emit(json!({"type": "message", "message": m}));
        Ok(m)
    }

    pub fn recent_messages(&self, n: usize) -> Vec<Message> {
        let st = self.state.lock().unwrap();
        st.messages.iter().rev().take(n).map(|(_, m)| m.clone()).collect::<Vec<_>>().into_iter().rev().collect()
    }

    // ---------- tasks ----------

    pub fn create_task(self: &Arc<Self>, brief: &str, title: Option<&str>, executor: Option<&str>, source: &str, message_id: Option<String>) -> Result<Task> {
        let (task, node) = {
            let mut st = self.state.lock().unwrap();
            let num = st.next_num;
            st.next_num += 1;
            let executor = executor.filter(|e| !e.is_empty() && *e != "auto").map(str::to_owned).unwrap_or_else(|| st.settings.default_executor.clone());
            let task = Task {
                id: new_id("t"),
                num,
                title: title.map(str::to_owned).unwrap_or_else(|| title_from(brief)),
                brief: brief.into(),
                status: TaskStatus::Queued,
                executor,
                machine_id: None,
                source: source.into(),
                created_at: now(),
                started_at: None,
                ended_at: None,
                now: "Waiting for a machine".into(),
                waiting_for: None,
                step: 0,
                steps_estimate: 0,
                spend_p: 0,
                tokens: 0,
                time_cap_s: st.settings.time_cap_s,
                control: None,
                outcome: None,
                summary: None,
                receipt_artifact: None,
                last_frame_artifact: None,
                telegram: None,
                message_id,
            };
            let node = st.store.put("Task", &format!("task:{}", task.id), &task, &[("num", V::Int(num as i64))])?;
            st.task_nodes.insert(task.id.clone(), node);
            st.tasks.insert(task.id.clone(), task.clone());
            st.task_started.insert(task.id.clone(), Instant::now());
            (task, node)
        };
        let _ = node;
        self.emit_task(&task);
        self.add_event(&task.id, "you", "brief", obj(json!({"text": brief, "channel": source})))?;
        self.tg.send(TgCmd::Task(task.id.clone())).ok();
        self.emit_stats();
        self.dispatch();
        Ok(task)
    }

    pub fn task(&self, id: &str) -> Option<Task> {
        self.state.lock().unwrap().tasks.get(id).cloned()
    }

    pub fn task_by_num(&self, num: u64) -> Option<Task> {
        self.state.lock().unwrap().tasks.values().find(|t| t.num == num).cloned()
    }

    pub fn update_task(&self, id: &str, f: impl FnOnce(&mut Task)) -> Option<Task> {
        let t = {
            let mut st = self.state.lock().unwrap();
            let node = *st.task_nodes.get(id)?;
            let t = st.tasks.get_mut(id)?;
            f(t);
            let t = t.clone();
            st.store.rewrite(node, &t).ok();
            t
        };
        self.emit_task(&t);
        self.tg.send(TgCmd::Task(id.to_owned())).ok();
        Some(t)
    }

    pub fn add_event(&self, task_id: &str, actor: &str, kind: &str, fields: Map<String, Value>) -> Result<Event> {
        let event = {
            let mut st = self.state.lock().unwrap();
            let Some(task_node) = st.task_nodes.get(task_id).copied() else { bail!("unknown task {task_id}") };
            let ms = st.tasks.get(task_id).and_then(|t| chrono::DateTime::parse_from_rfc3339(&t.created_at).ok()).map(|c| (chrono::Utc::now() - c.with_timezone(&chrono::Utc)).num_milliseconds().max(0) as u64).unwrap_or(0);
            let mut e = Event { id: 0, task_id: task_id.into(), at: now(), ms, actor: actor.into(), kind: kind.into(), fields };
            let mut edges: Vec<(u64, &str, bool)> = vec![(task_node, "HAS_EVENT", true)];
            if let Some(prev) = st.last_event.get(task_id).copied() {
                edges.push((prev, "NEXT", true));
            }
            let id = st.store.append("Event", &e, &[("kind", s(kind)), ("task", s(task_id))], &edges)?;
            e.id = id;
            // Write the id into the stored doc so replays keep it.
            st.store.rewrite(id, &e).ok();
            if let Some(a) = e.str("artifact").map(str::to_owned) {
                if let Some(aid) = st.store.id_of(&format!("artifact:{a}")) {
                    st.store.edge(id, aid, "SHOWS").ok();
                }
            }
            st.last_event.insert(task_id.into(), id);
            st.events.entry(task_id.into()).or_default().push(e.clone());
            e
        };
        if matches!(kind, "step" | "done" | "message" | "brief" | "answer") {
            let text = event.str("text").or(event.str("summary")).or(event.str("label")).unwrap_or("").to_owned();
            if !text.is_empty() {
                self.embed_tx.send((event.id, Input::Text(text))).ok();
            }
        }
        self.emit(json!({"type": "event", "event": event}));
        Ok(event)
    }

    /// Update a previous event in place (step state, tool completion).
    fn complete_event(&self, task_id: &str, match_key: &str, match_val: &str, fields: &Map<String, Value>) -> Option<Event> {
        let e = {
            let mut st = self.state.lock().unwrap();
            let list = st.events.get_mut(task_id)?;
            let e = list.iter_mut().rev().find(|e| e.str(match_key) == Some(match_val))?;
            for (k, v) in fields {
                e.fields.insert(k.clone(), v.clone());
            }
            let e = e.clone();
            st.store.rewrite(e.id, &e).ok();
            e
        };
        self.emit(json!({"type": "event", "event": e}));
        Some(e)
    }

    pub fn events(&self, task_id: &str) -> Vec<Event> {
        self.state.lock().unwrap().events.get(task_id).cloned().unwrap_or_default()
    }

    pub fn save_artifact(&self, task_id: Option<&str>, bytes: &[u8], mime: &str, meta: Value, embed_caption: Option<String>) -> Result<String> {
        let id = new_id("a");
        let ext = if mime.contains("png") { "png" } else if mime.contains("ogg") { "ogg" } else { "jpg" };
        let path = self.cfg.data_dir.join("artifacts").join(format!("{id}.{ext}"));
        std::fs::write(&path, bytes)?;
        let mut doc = meta;
        doc["id"] = json!(id);
        doc["mime"] = json!(mime);
        doc["file"] = json!(format!("{id}.{ext}"));
        doc["task_id"] = json!(task_id);
        doc["at"] = json!(now());
        let node = {
            let mut st = self.state.lock().unwrap();
            let node = st.store.put("Artifact", &format!("artifact:{id}"), &doc, &[])?;
            if let Some(t) = task_id.and_then(|t| st.task_nodes.get(t).copied()) {
                st.store.edge(node, t, "PRODUCED_BY").ok();
            }
            st.artifacts.insert(id.clone(), doc);
            node
        };
        if let Some(caption) = embed_caption {
            if mime.starts_with("image/") {
                self.embed_tx.send((node, Input::Image { bytes: bytes.to_vec(), mime: mime.into(), caption })).ok();
            }
        }
        Ok(id)
    }

    pub fn artifact_path(&self, id: &str) -> Option<(std::path::PathBuf, String)> {
        let st = self.state.lock().unwrap();
        let doc = st.artifacts.get(id)?;
        Some((self.cfg.data_dir.join("artifacts").join(doc["file"].as_str()?), doc["mime"].as_str().unwrap_or("image/jpeg").to_owned()))
    }

    // ---------- machines & dispatch ----------

    pub fn machine_connected(self: &Arc<Self>, hello: &Value, link: mpsc::UnboundedSender<Value>) -> Result<Machine> {
        let id = hello["id"].as_str().context("hello without id")?.to_owned();
        self.machine_links.lock().unwrap().insert(id.clone(), link);
        let m = {
            let mut st = self.state.lock().unwrap();
            let mut m = st.machines.get(&id).cloned().unwrap_or_default();
            m.id = id.clone();
            m.name = hello["name"].as_str().unwrap_or(&id).to_owned();
            m.backend = hello["backend"].as_str().unwrap_or("local").to_owned();
            m.status = "online".into();
            m.specs = hello["specs"].clone();
            m.has_desktop = hello["has_desktop"].as_bool().unwrap_or(false);
            m.desktop_url = hello["desktop_url"].as_str().map(str::to_owned);
            m.executors = hello["executors"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
            if let Some(p) = self.launcher.parent_of(&id) {
                m.parent = Some(p);
            }
            m.task_id = None;
            st.store.put("Machine", &format!("machine:{id}"), &m, &[])?;
            st.machines.insert(id.clone(), m.clone());
            m
        };
        self.emit(json!({"type": "machine", "machine": m}));
        self.dispatch();
        Ok(m)
    }

    pub fn machine_disconnected(self: &Arc<Self>, id: &str, link: &mpsc::UnboundedSender<Value>) {
        {
            let mut links = self.machine_links.lock().unwrap();
            // A reconnect may already have replaced this link.
            if !links.get(id).is_some_and(|l| l.same_channel(link)) {
                return;
            }
            links.remove(id);
        }
        let (m, orphan) = {
            let mut st = self.state.lock().unwrap();
            let Some(m) = st.machines.get_mut(id) else { return };
            m.status = "offline".into();
            let orphan = m.task_id.take();
            (m.clone(), orphan)
        };
        self.emit(json!({"type": "machine", "machine": m}));
        if let Some(t) = orphan {
            if self.task(&t).is_some_and(|t| !t.status.finished()) {
                self.fail_task(&t, "The machine disconnected mid-task. The next run will check the real state before retrying.");
            }
        }
    }

    pub fn send_machine(&self, machine_id: &str, msg: Value) -> bool {
        self.machine_links.lock().unwrap().get(machine_id).is_some_and(|l| l.send(msg).is_ok())
    }

    fn send_task_machine(&self, task_id: &str, msg: Value) -> bool {
        let Some(m) = self.task(task_id).and_then(|t| t.machine_id) else { return false };
        self.send_machine(&m, msg)
    }

    /// Assign queued tasks to idle machines; ask the launcher for a fork when
    /// everything is busy.
    pub fn dispatch(self: &Arc<Self>) {
        loop {
            let pick = {
                let st = self.state.lock().unwrap();
                let Some(task) = st.tasks.values().filter(|t| t.status == TaskStatus::Queued).min_by_key(|t| t.num).cloned() else { return };
                let links = self.machine_links.lock().unwrap();
                // Prefer the personal machine (no parent), then forks.
                let idle = st
                    .machines
                    .values()
                    .filter(|m| m.status == "online" && m.task_id.is_none() && links.contains_key(&m.id))
                    .min_by_key(|m| (m.parent.is_some(), m.id.clone()))
                    .cloned();
                let busy = st.machines.values().filter(|m| links.contains_key(&m.id)).count();
                (task, idle, busy)
            };
            match pick {
                (task, Some(machine), _) => self.start_on(&task, &machine),
                (_task, None, busy) => {
                    // Everything busy (or nothing running): the launcher decides
                    // whether to wake the personal machine or fork it.
                    let launcher = self.launcher.clone();
                    let hub = self.clone();
                    tokio::spawn(async move {
                        if let Err(e) = launcher.ensure_capacity(&hub, busy).await {
                            tracing::warn!("no machine available: {e:#}");
                        }
                    });
                    return;
                }
            }
        }
    }

    fn start_on(self: &Arc<Self>, task: &Task, machine: &Machine) {
        let context = self.context_packet(&task.brief, 8);
        let procedures: Vec<&Value> = context.iter().filter(|c| c["kind"] == "procedure").collect();
        {
            let mut st = self.state.lock().unwrap();
            if let Some(m) = st.machines.get_mut(&machine.id) {
                m.task_id = Some(task.id.clone());
                m.status = "busy".into();
            }
        }
        let m = self.state.lock().unwrap().machines.get(&machine.id).cloned();
        if let Some(m) = m {
            self.emit(json!({"type": "machine", "machine": m}));
        }
        let t = self.update_task(&task.id, |t| {
            t.status = TaskStatus::Starting;
            t.machine_id = Some(machine.id.clone());
            t.started_at = Some(now());
            t.now = format!("Waking {}", machine.name);
        });
        let hits: Vec<Value> = context.iter().map(|c| json!({"id": c["id"], "score": c["score"], "text": c["text"], "kind": c["kind"], "source": c["source"]["label"]})).collect();
        self.add_event(&task.id, "memory", "memory.recall", obj(json!({"query": task.brief, "hits": hits}))).ok();
        self.add_event(&task.id, "machine", "machine", obj(json!({"text": format!("Checkpoint taken on {} ({})", machine.name, machine.backend)}))).ok();
        let Some(t) = t else { return };
        self.send_machine(
            &machine.id,
            json!({"type": "task.start", "task_id": t.id, "brief": t.brief, "title": t.title, "executor": t.executor,
                   "context": {"memory": context, "procedures": procedures}, "time_cap_s": t.time_cap_s,
                   "approval_threshold_p": self.state.lock().unwrap().settings.approval_threshold_p}),
        );
    }

    pub fn fail_task(self: &Arc<Self>, id: &str, error: &str) {
        if self.task(id).is_none_or(|t| t.status.finished()) {
            return;
        }
        self.add_event(id, "machine", "failed", obj(json!({"error": error}))).ok();
        self.finish_common(id, TaskStatus::Failed, Some("failed".into()), Some(error.into()), None);
    }

    fn finish_common(self: &Arc<Self>, id: &str, status: TaskStatus, outcome: Option<String>, summary: Option<String>, receipt: Option<String>) {
        let t = self.update_task(id, |t| {
            t.status = status.clone();
            t.outcome = outcome.clone();
            t.summary = summary.clone();
            if receipt.is_some() {
                t.receipt_artifact = receipt.clone();
            }
            t.ended_at = Some(now());
            t.now = match status {
                TaskStatus::Done => "Done".into(),
                TaskStatus::Cancelled => "Cancelled".into(),
                _ => "Failed".into(),
            };
            t.waiting_for = None;
            t.control = None;
        });
        // Drop its open questions.
        let removed: Vec<String> = {
            let mut st = self.state.lock().unwrap();
            let ids: Vec<String> = st.needs.values().filter(|n| n.task_id == id).map(|n| n.id.clone()).collect();
            for q in &ids {
                st.needs.remove(q);
            }
            ids
        };
        for q in removed {
            self.tg.send(TgCmd::Resolved(q, "closed".into())).ok();
        }
        self.emit_needs();
        let machine = {
            let mut st = self.state.lock().unwrap();
            let mut freed = None;
            for m in st.machines.values_mut() {
                if m.task_id.as_deref() == Some(id) {
                    m.task_id = None;
                    if m.status == "busy" {
                        m.status = "online".into();
                    }
                    freed = Some(m.clone());
                }
            }
            freed
        };
        if let Some(m) = machine {
            self.emit(json!({"type": "machine", "machine": m.clone()}));
            let hub = self.clone();
            let launcher = self.launcher.clone();
            tokio::spawn(async move {
                launcher.after_task(&hub, &m.id).await;
            });
        }
        if let Some(t) = t {
            if let Some(summary) = &t.summary {
                let node = self.state.lock().unwrap().task_nodes.get(&t.id).copied();
                if let Some(node) = node {
                    self.embed_tx.send((node, Input::Text(task_text(&t)))).ok();
                }
                let _ = summary;
            }
            let hub = self.clone();
            tokio::spawn(async move { crate::consolidate::after_task(&hub, &t).await });
        }
        self.emit_stats();
        self.dispatch();
    }

    pub fn cancel_task(self: &Arc<Self>, id: &str, why: &str) -> Option<Task> {
        let t = self.task(id)?;
        if t.status.finished() {
            return Some(t);
        }
        self.send_task_machine(id, json!({"type": "task.cancel", "task_id": id}));
        self.add_event(id, "you", "control", obj(json!({"state": "cancelled", "note": why}))).ok();
        self.finish_common(id, TaskStatus::Cancelled, Some("cancelled".into()), Some(why.into()), None);
        self.task(id)
    }

    pub fn kill(self: &Arc<Self>) -> Value {
        let active: Vec<String> = self.state.lock().unwrap().tasks.values().filter(|t| !t.status.finished()).map(|t| t.id.clone()).collect();
        for id in &active {
            self.cancel_task(id, "Stopped by the kill switch");
        }
        let machines: Vec<String> = self.machine_links.lock().unwrap().keys().cloned().collect();
        for m in &machines {
            self.send_machine(m, json!({"type": "shutdown"}));
        }
        let launcher = self.launcher.clone();
        tokio::spawn(async move { launcher.stop_all().await });
        json!({"cancelled": active.len(), "machines_stopped": machines.len()})
    }

    pub fn control(self: &Arc<Self>, id: &str, take: bool, note: Option<String>) -> Option<Task> {
        let t = self.update_task(id, |t| t.control = if take { Some("you".into()) } else { None })?;
        let state = if take { "taken" } else { "released" };
        self.add_event(id, "you", "control", obj(json!({"state": state, "note": note}))).ok();
        self.send_task_machine(id, json!({"type": "control", "task_id": id, "state": state, "note": note}));
        Some(t)
    }

    pub fn forward_input(&self, task_id: &str, input: Value) {
        if self.task(task_id).is_some_and(|t| t.control.is_some()) {
            self.send_task_machine(task_id, json!({"type": "input", "task_id": task_id, "input": input}));
        }
    }

    pub fn subscribe_hint(&self, task_id: &str) {
        self.send_task_machine(task_id, json!({"type": "subscribe", "task_id": task_id, "rate": "full"}));
    }

    // ---------- questions & approvals ----------

    fn open_question(self: &Arc<Self>, machine_id: &str, n: NeedsYou) {
        {
            let mut st = self.state.lock().unwrap();
            st.question_machine.insert(n.id.clone(), machine_id.into());
            st.needs.insert(n.id.clone(), n.clone());
        }
        self.update_task(&n.task_id, |t| {
            t.status = TaskStatus::Waiting;
            t.waiting_for = Some(if n.kind == "approval" { "your approval".into() } else { "your answer".into() });
        });
        self.emit_needs();
        self.emit_stats();
        self.tg.send(TgCmd::Ask(n.id.clone())).ok();
    }

    pub fn answer(self: &Arc<Self>, qid: &str, answer: &str, text: Option<String>, by: &str) -> Result<()> {
        let (n, machine) = {
            let mut st = self.state.lock().unwrap();
            let n = st.needs.remove(qid).context("that question is no longer open")?;
            let machine = st.question_machine.remove(qid);
            if n.kind == "approval" && answer == "approve_always" {
                if let Some(merchant) = &n.merchant {
                    let merchant = merchant.to_lowercase();
                    if !st.settings.no_ask_merchants.contains(&merchant) {
                        st.settings.no_ask_merchants.push(merchant);
                    }
                    let settings = st.settings.clone();
                    st.store.put("Settings", "settings:main", &settings, &[]).ok();
                }
            }
            (n, machine)
        };
        let label = n.options.iter().find(|o| o["id"] == answer).and_then(|o| o["label"].as_str()).map(str::to_owned).or_else(|| text.clone()).unwrap_or_else(|| answer.to_owned());
        let normalized = if answer == "approve_always" { "approve" } else { answer };
        self.add_event(&n.task_id, "you", "answer", obj(json!({"question_id": qid, "answer": normalized, "label": label, "text": text, "by": by}))).ok();
        if let Some(m) = machine {
            self.send_machine(&m, json!({"type": "answer", "question_id": qid, "answer": normalized, "label": label, "text": text}));
        }
        self.update_task(&n.task_id, |t| {
            if t.status == TaskStatus::Waiting {
                t.status = TaskStatus::Running;
            }
            t.waiting_for = None;
        });
        self.emit_needs();
        self.emit_stats();
        self.tg.send(TgCmd::Resolved(qid.into(), label)).ok();
        Ok(())
    }

    pub fn needs(&self) -> Vec<NeedsYou> {
        self.state.lock().unwrap().needs.values().cloned().collect()
    }

    // ---------- machine messages ----------

    pub fn on_machine_message(self: &Arc<Self>, machine_id: &str, msg: Value) {
        let kind = msg["type"].as_str().unwrap_or("");
        let task_id = msg["task_id"].as_str().unwrap_or("").to_owned();
        match kind {
            "event" => {
                let mut ev = msg["event"].as_object().cloned().unwrap_or_default();
                let actor = ev.remove("actor").and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "agent".into());
                let ekind = ev.remove("kind").and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "step".into());
                ev.remove("id");
                ev.remove("task_id");
                ev.remove("at");
                ev.remove("ms");
                if let Some(Value::String(b64)) = ev.remove("image") {
                    if let Ok(bytes) = b64decode(&b64) {
                        let caption = format!("{} {}", ev.get("title").and_then(Value::as_str).unwrap_or(""), ev.get("url").and_then(Value::as_str).unwrap_or(""));
                        if let Ok(aid) = self.save_artifact(Some(&task_id), &bytes, "image/jpeg", json!({"kind": "keyframe", "url": ev.get("url"), "title": ev.get("title")}), Some(caption)) {
                            ev.insert("artifact".into(), json!(aid.clone()));
                            self.update_task(&task_id, |t| t.last_frame_artifact = Some(aid));
                        }
                    }
                }
                // Updates to an earlier step/tool call rewrite that event.
                if ekind == "tool" {
                    if let Some(call) = ev.get("call_id").and_then(Value::as_str).map(str::to_owned) {
                        let exists = self.state.lock().unwrap().events.get(&task_id).is_some_and(|l| l.iter().any(|e| e.str("call_id") == Some(call.as_str())));
                        if exists {
                            self.complete_event(&task_id, "call_id", &call, &ev);
                            return;
                        }
                    }
                }
                if ekind == "step" {
                    if let Some(sid) = ev.get("step_id").and_then(Value::as_str).map(str::to_owned) {
                        let exists = self.state.lock().unwrap().events.get(&task_id).is_some_and(|l| l.iter().any(|e| e.str("step_id") == Some(sid.as_str())));
                        if exists {
                            self.complete_event(&task_id, "step_id", &sid, &ev);
                            return;
                        }
                    }
                    if ev.get("state").and_then(Value::as_str) != Some("done") {
                        if let Some(text) = ev.get("text").and_then(Value::as_str).map(str::to_owned) {
                            self.update_task(&task_id, |t| {
                                t.now = text;
                                if t.status == TaskStatus::Starting {
                                    t.status = TaskStatus::Running;
                                }
                            });
                        }
                    }
                }
                if ekind == "message" {
                    if let Some(text) = ev.get("text").and_then(Value::as_str) {
                        let text = text.to_owned();
                        self.add_message("assistant", &text, "task", Some(task_id.clone()), None).ok();
                        self.tg.send(TgCmd::Say(format!("#{} {}", self.task(&task_id).map(|t| t.num).unwrap_or(0), text))).ok();
                    }
                }
                self.add_event(&task_id, &actor, &ekind, ev).ok();
            }
            "frame" => {
                let data = msg["data"].as_str().unwrap_or("");
                // ~1 fps recording for replay.
                let save = {
                    let mut st = self.state.lock().unwrap();
                    let last = st.last_frame_saved.get(&task_id).copied();
                    if last.is_none_or(|l| l.elapsed().as_millis() >= 1000) {
                        st.last_frame_saved.insert(task_id.clone(), Instant::now());
                        true
                    } else {
                        false
                    }
                };
                if save && !task_id.is_empty() {
                    if let (Ok(bytes), Some(ms)) = (b64decode(data), self.task_ms(&task_id)) {
                        let dir = self.cfg.data_dir.join("recordings").join(&task_id);
                        std::fs::create_dir_all(&dir).ok();
                        std::fs::write(dir.join(format!("{ms:010}.jpg")), bytes).ok();
                    }
                }
                let payload = json!({"type": "frame", "task_id": task_id, "machine_id": machine_id, "data": data, "w": msg["w"], "h": msg["h"]});
                self.out.send(Out { kind: OutKind::Frame, task: Some(task_id), json: Arc::from(payload.to_string()) }).ok();
            }
            "terminal" => {
                let data = msg["data"].as_str().unwrap_or("");
                if !task_id.is_empty() {
                    use std::io::Write;
                    let path = self.cfg.data_dir.join("terminal").join(format!("{task_id}.log"));
                    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                        f.write_all(data.as_bytes()).ok();
                    }
                }
                let payload = json!({"type": "terminal", "task_id": task_id, "data": data});
                self.out.send(Out { kind: OutKind::Terminal, task: Some(task_id), json: Arc::from(payload.to_string()) }).ok();
            }
            "task.update" => {
                self.update_task(&task_id, |t| {
                    if let Some(v) = msg["now"].as_str() {
                        t.now = v.into();
                    }
                    if msg.get("waiting_for").is_some() {
                        t.waiting_for = msg["waiting_for"].as_str().map(str::to_owned);
                    }
                    if let Some(v) = msg["step"].as_u64() {
                        t.step = v as u32;
                    }
                    if let Some(v) = msg["steps_estimate"].as_u64() {
                        t.steps_estimate = v as u32;
                    }
                    if let Some(v) = msg["tokens"].as_u64() {
                        t.tokens = v;
                    }
                    if let Some(v) = msg["spend_p"].as_i64() {
                        t.spend_p = v;
                    }
                    if t.status == TaskStatus::Starting {
                        t.status = TaskStatus::Running;
                    }
                });
            }
            "task.done" => {
                let receipt = msg["receipt_image"].as_str().and_then(|b| b64decode(b).ok()).and_then(|bytes| {
                    self.save_artifact(Some(&task_id), &bytes, "image/jpeg", json!({"kind": "receipt"}), Some(format!("receipt: {}", msg["summary"].as_str().unwrap_or("")))).ok()
                });
                let outcome = msg["outcome"].as_str().unwrap_or("success").to_owned();
                let summary = msg["summary"].as_str().unwrap_or("Done.").to_owned();
                self.add_event(&task_id, "agent", "done", obj(json!({"outcome": outcome, "summary": summary, "receipt_artifact": receipt}))).ok();
                let status = if outcome == "failed" { TaskStatus::Failed } else if outcome == "cancelled" { TaskStatus::Cancelled } else { TaskStatus::Done };
                self.finish_common(&task_id, status, Some(outcome), Some(summary), receipt);
            }
            "task.failed" => {
                let error = msg["error"].as_str().unwrap_or("The executor failed.").to_owned();
                self.fail_task(&task_id, &error);
            }
            "ask" => {
                let Some(t) = self.task(&task_id) else { return };
                let qid = msg["question_id"].as_str().map(str::to_owned).unwrap_or_else(|| new_id("q"));
                let question = msg["question"].as_str().unwrap_or("Question").to_owned();
                let options: Vec<Value> = msg["options"].as_array().cloned().unwrap_or_default().into_iter().map(|o| if o.is_string() { json!({"id": o, "label": o}) } else { o }).collect();
                self.add_event(&task_id, "agent", "ask", obj(json!({"question_id": qid, "question": question, "options": options}))).ok();
                self.open_question(machine_id, NeedsYou {
                    id: qid,
                    task_id: t.id.clone(),
                    task_num: t.num,
                    task_title: t.title.clone(),
                    kind: "question".into(),
                    title: question,
                    detail: format!("{} · {}", t.title, msg["detail"].as_str().unwrap_or(&t.now)),
                    options,
                    allow_text: msg["allow_text"].as_bool().unwrap_or(true),
                    created_at: now(),
                    merchant: None,
                    telegram: None,
                });
            }
            "approval" => {
                let Some(t) = self.task(&task_id) else { return };
                let qid = msg["question_id"].as_str().map(str::to_owned).unwrap_or_else(|| new_id("q"));
                let amount = msg["amount_p"].as_i64().unwrap_or(0);
                let merchant = msg["merchant"].as_str().unwrap_or("merchant").to_owned();
                let description = msg["description"].as_str().unwrap_or("").to_owned();
                let (threshold, no_ask) = {
                    let st = self.state.lock().unwrap();
                    (st.settings.approval_threshold_p, st.settings.no_ask_merchants.contains(&merchant.to_lowercase()))
                };
                let auto = amount <= threshold || no_ask;
                self.add_event(&task_id, "agent", "approval", obj(json!({"question_id": qid, "amount_p": amount, "merchant": merchant, "description": description, "auto": auto}))).ok();
                self.update_task(&task_id, |t| t.spend_p += 0);
                if auto {
                    let why = if no_ask { format!("{merchant} is on your no-ask list") } else { format!("under your {} line", gbp(threshold)) };
                    self.add_event(&task_id, "you", "answer", obj(json!({"question_id": qid, "answer": "approve", "label": format!("Auto-approved: {why}"), "by": "auto"}))).ok();
                    self.send_machine(machine_id, json!({"type": "answer", "question_id": qid, "answer": "approve", "label": "Auto-approved"}));
                    return;
                }
                let over = amount - threshold;
                self.open_question(machine_id, NeedsYou {
                    id: qid,
                    task_id: t.id.clone(),
                    task_num: t.num,
                    task_title: t.title.clone(),
                    kind: "approval".into(),
                    title: format!("Pay {} to {merchant}", gbp(amount)),
                    detail: format!("{} over your {} line · {description}", gbp(over), gbp(threshold)),
                    options: vec![
                        json!({"id": "approve", "label": "Approve", "style": "primary"}),
                        json!({"id": "hold", "label": "Hold"}),
                        json!({"id": "approve_always", "label": format!("Approve and never ask for {merchant}"), "style": "quiet"}),
                    ],
                    allow_text: false,
                    created_at: now(),
                    merchant: Some(merchant),
                    telegram: None,
                });
            }
            "spend" => {
                let amount = msg["amount_p"].as_i64().unwrap_or(0);
                self.update_task(&task_id, |t| t.spend_p += amount);
                self.emit_stats();
            }
            "memory" => {
                let req = msg["req_id"].clone();
                let op = msg["op"].as_str().unwrap_or("search");
                let result = match op {
                    "note" => {
                        let text = msg["text"].as_str().unwrap_or("").to_owned();
                        let kind = msg["kind"].as_str().unwrap_or("fact").to_owned();
                        let subject = msg["subject"].as_str().unwrap_or("").to_owned();
                        let key = msg["key"].as_str().map(str::to_owned);
                        let evidence = self.state.lock().unwrap().last_event.get(&task_id).copied();
                        let label = self.task(&task_id).map(|t| format!("Task #{}", t.num)).unwrap_or_else(|| "agent".into());
                        match self.add_claim(&kind, &text, &subject, key, msg["confidence"].as_f64().unwrap_or(0.85), 0.6, ClaimSource { task_id: Some(task_id.clone()), message_id: None, event_id: evidence, label }) {
                            Ok(c) => {
                                if !task_id.is_empty() {
                                    self.add_event(&task_id, "memory", "memory.write", obj(json!({"op": if c.supersedes.is_some() {"supersede"} else {"add"}, "text": c.text, "claim_kind": c.kind, "claim_id": c.id}))).ok();
                                }
                                json!({"ok": true, "result": {"id": c.id}})
                            }
                            Err(e) => json!({"ok": false, "result": e.to_string()}),
                        }
                    }
                    _ => {
                        let q = msg["query"].as_str().unwrap_or("").to_owned();
                        let hub = self.clone();
                        let machine = machine_id.to_owned();
                        tokio::spawn(async move {
                            let hits = hub.context_packet_async(&q, 8).await;
                            if !task_id.is_empty() {
                                let brief: Vec<Value> = hits.iter().map(|c| json!({"id": c["id"], "score": c["score"], "text": c["text"], "kind": c["kind"], "source": c["source"]["label"]})).collect();
                                hub.add_event(&task_id, "memory", "memory.recall", obj(json!({"query": q, "hits": brief}))).ok();
                            }
                            hub.send_machine(&machine, json!({"type": "memory.result", "req_id": req, "ok": true, "result": hits}));
                        });
                        return;
                    }
                };
                let mut reply = result;
                reply["type"] = json!("memory.result");
                reply["req_id"] = req;
                self.send_machine(machine_id, reply);
            }
            "stats" => {
                let m = {
                    let mut st = self.state.lock().unwrap();
                    let Some(m) = st.machines.get_mut(machine_id) else { return };
                    m.stats = msg["stats"].clone();
                    m.clone()
                };
                self.emit(json!({"type": "machine", "machine": m}));
            }
            "installs" => {
                let m = {
                    let mut st = self.state.lock().unwrap();
                    let Some(m) = st.machines.get_mut(machine_id) else { return };
                    m.installs = msg["installs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                    let m = m.clone();
                    st.store.put("Machine", &format!("machine:{}", m.id), &m, &[]).ok();
                    m
                };
                self.emit(json!({"type": "machine", "machine": m}));
            }
            "backup.done" => {
                let m = {
                    let mut st = self.state.lock().unwrap();
                    let Some(m) = st.machines.get_mut(machine_id) else { return };
                    m.last_backup_at = Some(now());
                    let m = m.clone();
                    st.store.put("Machine", &format!("machine:{}", m.id), &m, &[]).ok();
                    m
                };
                self.emit(json!({"type": "machine", "machine": m}));
            }
            _ => tracing::debug!("unknown machine message {kind}"),
        }
    }

    fn task_ms(&self, task_id: &str) -> Option<u64> {
        let t = self.task(task_id)?;
        let c = chrono::DateTime::parse_from_rfc3339(&t.created_at).ok()?;
        Some((chrono::Utc::now() - c.with_timezone(&chrono::Utc)).num_milliseconds().max(0) as u64)
    }

    pub fn mark_backup(&self, machine_id: &str) {
        let m = {
            let mut st = self.state.lock().unwrap();
            let Some(m) = st.machines.get_mut(machine_id) else { return };
            m.last_backup_at = Some(now());
            let m = m.clone();
            st.store.put("Machine", &format!("machine:{}", m.id), &m, &[]).ok();
            m
        };
        self.emit(json!({"type": "machine", "machine": m}));
    }

    // ---------- memory ----------

    pub fn add_claim(&self, kind: &str, text: &str, subject: &str, key: Option<String>, confidence: f64, salience: f64, source: ClaimSource) -> Result<Claim> {
        let text = text.trim();
        anyhow::ensure!(!text.is_empty(), "empty memory");
        let subject = subject.trim().to_lowercase();
        let claim = {
            let mut st = self.state.lock().unwrap();
            // Exact duplicate of an active claim: reinforce instead of adding.
            if let Some(existing) = st.claims.values().find(|c| c.state == "active" && c.text.eq_ignore_ascii_case(text)).cloned() {
                return Ok(existing);
            }
            let previous = key.as_ref().and_then(|k| st.claims.values().find(|c| c.state == "active" && c.subject == subject && c.key.as_deref() == Some(k.as_str())).cloned());
            let mut c = Claim {
                id: 0,
                kind: kind.into(),
                text: text.into(),
                subject: subject.clone(),
                key: key.clone(),
                confidence: confidence.clamp(0.0, 1.0),
                salience: salience.clamp(0.0, 1.0),
                state: "active".into(),
                source: source.clone(),
                created_at: now(),
                superseded_by: None,
                supersedes: previous.as_ref().map(|p| p.id),
            };
            let id = st.store.append("Claim", &c, &[("kind", s(kind)), ("subject", s(&subject))], &[])?;
            c.id = id;
            st.store.rewrite(id, &c)?;
            if !subject.is_empty() {
                let subject_node = match st.subjects.get(&subject).copied() {
                    Some(n) => n,
                    None => {
                        let n = st.store.put("Subject", &format!("subject:{subject}"), &json!({"name": subject}), &[])?;
                        st.subjects.insert(subject.clone(), n);
                        n
                    }
                };
                st.store.edge(id, subject_node, "ABOUT")?;
            }
            if let Some(e) = source.event_id {
                st.store.edge(id, e, "SUPPORTED_BY").ok();
            }
            if let Some(m) = source.message_id.as_ref().and_then(|m| st.store.id_of(&format!("message:{m}"))) {
                st.store.edge(id, m, "SUPPORTED_BY").ok();
            }
            if let Some(t) = source.task_id.as_ref().and_then(|t| st.task_nodes.get(t).copied()) {
                st.store.edge(id, t, if kind == "procedure" { "LEARNED_FROM" } else { "FROM_TASK" }).ok();
            }
            if let Some(mut p) = previous {
                p.state = "superseded".into();
                p.superseded_by = Some(id);
                st.store.rewrite(p.id, &p)?;
                st.store.edge(id, p.id, "SUPERSEDES")?;
                st.claims.insert(p.id, p);
            }
            st.claims.insert(id, c.clone());
            c
        };
        self.embed_tx.send((claim.id, Input::Text(claim_text(&claim)))).ok();
        self.emit(json!({"type": "claim", "claim": claim}));
        self.emit_stats();
        Ok(claim)
    }

    pub fn set_claim_state(&self, id: u64, state: &str) -> Result<Claim> {
        let mut st = self.state.lock().unwrap();
        let mut c = st.claims.get(&id).cloned().context("no such memory")?;
        c.state = state.into();
        st.store.rewrite(id, &c)?;
        st.claims.insert(id, c.clone());
        Ok(c)
    }

    pub fn correct_claim(&self, id: u64, text: &str) -> Result<Claim> {
        let old = self.state.lock().unwrap().claims.get(&id).cloned().context("no such memory")?;
        let key = old.key.clone().unwrap_or_else(|| format!("c{id}"));
        if old.key.is_none() {
            // Give the old claim a slot so the correction supersedes it.
            let mut st = self.state.lock().unwrap();
            let mut o = old.clone();
            o.key = Some(key.clone());
            st.store.rewrite(id, &o)?;
            st.claims.insert(id, o);
        }
        self.add_claim(&old.kind, text, &old.subject, Some(key), 0.95, old.salience.max(0.6), ClaimSource { task_id: None, message_id: None, event_id: None, label: "Ryan, corrected".into() })
    }

    pub fn claims(&self) -> Vec<Claim> {
        self.state.lock().unwrap().claims.values().cloned().collect()
    }

    /// Why the agent believes a claim: its supporting evidence and history.
    pub fn claim_detail(&self, id: u64) -> Option<Value> {
        let st = self.state.lock().unwrap();
        let claim = st.claims.get(&id)?.clone();
        let mut evidence = Vec::new();
        for (other, label, outgoing) in st.store.neighbours(id) {
            if outgoing && (label == "SUPPORTED_BY" || label == "FROM_TASK" || label == "LEARNED_FROM") {
                match st.store.label(other) {
                    Some("Event") => {
                        if let Some(e) = st.store.doc::<Value>(other) {
                            evidence.push(json!({"type": "event", "item": e}));
                        }
                    }
                    Some("Message") => {
                        if let Some(m) = st.store.doc::<Value>(other) {
                            evidence.push(json!({"type": "message", "item": m}));
                        }
                    }
                    Some("Task") => {
                        if let Some(t) = st.store.doc::<Value>(other) {
                            evidence.push(json!({"type": "task", "item": t}));
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut history = Vec::new();
        let mut cursor = claim.supersedes;
        while let Some(p) = cursor.and_then(|i| st.claims.get(&i)) {
            history.push(p.clone());
            cursor = p.supersedes;
        }
        let mut forward = claim.superseded_by;
        let mut newer = Vec::new();
        while let Some(n) = forward.and_then(|i| st.claims.get(&i)) {
            newer.push(n.clone());
            forward = n.superseded_by;
        }
        let related: Vec<Claim> = st.claims.values().filter(|c| c.subject == claim.subject && c.id != claim.id && !claim.subject.is_empty() && c.state == "active").take(8).cloned().collect();
        Some(json!({"claim": claim, "evidence": evidence, "history": history, "newer": newer, "related": related}))
    }

    /// Context packet: best semantic matches among claims, then a bounded walk
    /// to claims about the same subjects. Superseded claims are marked, not hidden.
    pub async fn context_packet_async(&self, query: &str, k: usize) -> Vec<Value> {
        let vector = self.embedder.embed(&[Input::Text(query.to_owned())]).await.ok().and_then(|mut v| v.pop());
        self.rank_claims(query, vector.as_deref(), k)
    }

    pub fn context_packet(&self, query: &str, k: usize) -> Vec<Value> {
        // Synchronous callers use the local lexical vector; the remote embedder
        // is used by the async path.
        let vector = if self.embedder.remote() { None } else { Some(crate::embed::hash_embed(query)) };
        self.rank_claims(query, vector.as_deref(), k)
    }

    fn rank_claims(&self, query: &str, vector: Option<&[f32]>, k: usize) -> Vec<Value> {
        let st = self.state.lock().unwrap();
        let mut scores: HashMap<u64, f64> = HashMap::new();
        if let Some(v) = vector {
            if let Ok(hits) = st.store.search(v, &["Claim"], k * 3) {
                for (id, score) in hits {
                    scores.insert(id, score as f64);
                }
            }
        }
        let q = query.to_lowercase();
        let words: HashSet<&str> = q.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 2).collect();
        for c in st.claims.values() {
            if c.state == "forgotten" {
                continue;
            }
            let hay = format!("{} {}", c.text.to_lowercase(), c.subject);
            let overlap = words.iter().filter(|w| hay.contains(*w)).count() as f64;
            if overlap > 0.0 || (!c.subject.is_empty() && q.contains(&c.subject)) {
                *scores.entry(c.id).or_insert(0.0) += 0.15 * overlap + if !c.subject.is_empty() && q.contains(&c.subject) { 0.3 } else { 0.0 };
            }
        }
        // Bounded neighbour walk: other active claims about the top subjects.
        let mut top: Vec<(u64, f64)> = scores.iter().map(|(a, b)| (*a, *b)).collect();
        top.sort_by(|a, b| b.1.total_cmp(&a.1));
        let subjects: HashSet<String> = top.iter().take(3).filter_map(|(id, _)| st.claims.get(id)).map(|c| c.subject.clone()).filter(|s| !s.is_empty()).collect();
        for c in st.claims.values() {
            if subjects.contains(&c.subject) && c.state == "active" {
                scores.entry(c.id).or_insert(0.2);
            }
        }
        let now = chrono::Utc::now();
        let mut ranked: Vec<(f64, &Claim)> = scores
            .iter()
            .filter_map(|(id, sim)| st.claims.get(id).map(|c| (*sim, c)))
            .filter(|(_, c)| c.state != "forgotten")
            .map(|(sim, c)| {
                let age_days = chrono::DateTime::parse_from_rfc3339(&c.created_at).map(|d| (now - d.with_timezone(&chrono::Utc)).num_hours() as f64 / 24.0).unwrap_or(30.0);
                let recency = (-age_days / 30.0).exp();
                let penalty = if c.state == "superseded" { 0.25 } else { 0.0 };
                (0.6 * sim + 0.2 * c.confidence + 0.1 * c.salience + 0.1 * recency - penalty, c)
            })
            .collect();
        ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
        ranked
            .into_iter()
            .take(k)
            .map(|(score, c)| {
                let mut v = serde_json::to_value(c).unwrap_or_default();
                v["score"] = json!((score * 100.0).round() / 100.0);
                v
            })
            .collect()
    }

    /// Search everything: tasks, events, claims, messages and keyframes.
    pub async fn search(&self, q: &str) -> Vec<Value> {
        let vector = self.embedder.embed(&[Input::Text(q.to_owned())]).await.ok().and_then(|mut v| v.pop());
        let st = self.state.lock().unwrap();
        let mut scored: HashMap<u64, f64> = HashMap::new();
        if let Some(v) = &vector {
            if let Ok(hits) = st.store.search(v, &[], 40) {
                for (id, score) in hits {
                    scored.insert(id, score as f64);
                }
            }
        }
        let needle = q.to_lowercase();
        let mut results: Vec<(f64, Value)> = Vec::new();
        let mut seen: HashSet<u64> = HashSet::new();
        let mut push = |score: f64, v: Value, id: u64, seen: &mut HashSet<u64>| {
            if seen.insert(id) {
                results.push((score, v));
            }
        };
        for t in st.tasks.values() {
            let node = st.task_nodes.get(&t.id).copied().unwrap_or(0);
            let hay = format!("{} {} {}", t.title, t.brief, t.summary.clone().unwrap_or_default()).to_lowercase();
            let lexical = if hay.contains(&needle) { 1.0 } else { 0.0 };
            let score = lexical + scored.get(&node).copied().unwrap_or(0.0);
            if score > 0.35 {
                push(score, json!({"type": "task", "id": t.id, "task_id": t.id, "text": format!("#{} {} — {}", t.num, t.title, t.summary.clone().unwrap_or_else(|| t.status.label().into())), "score": score, "at": t.created_at, "artifact": t.receipt_artifact.clone().or(t.last_frame_artifact.clone())}), node, &mut seen);
            }
        }
        for c in st.claims.values().filter(|c| c.state != "forgotten") {
            let lexical = if c.text.to_lowercase().contains(&needle) { 1.0 } else { 0.0 };
            let score = lexical + scored.get(&c.id).copied().unwrap_or(0.0);
            if score > 0.35 {
                push(score, json!({"type": "claim", "id": c.id, "text": c.text, "kind": c.kind, "state": c.state, "score": score, "at": c.created_at}), c.id, &mut seen);
            }
        }
        for (id, m) in &st.messages {
            let lexical = if m.text.to_lowercase().contains(&needle) { 1.0 } else { 0.0 };
            let score = lexical + scored.get(id).copied().unwrap_or(0.0);
            if score > 0.4 {
                push(score, json!({"type": "message", "id": m.id, "task_id": m.task_id, "text": m.text, "role": m.role, "score": score, "at": m.at}), *id, &mut seen);
            }
        }
        for list in st.events.values() {
            for e in list {
                let text = e.str("text").or(e.str("summary")).or(e.str("target")).unwrap_or("");
                let hay = format!("{} {} {}", e.kind, e.str("tool").unwrap_or(""), text).to_lowercase();
                let lexical = if !text.is_empty() && hay.contains(&needle) { 0.9 } else { 0.0 };
                let score = lexical + scored.get(&e.id).copied().unwrap_or(0.0);
                if score > 0.4 {
                    let label = if e.kind == "tool" { format!("{} {}", e.str("tool").unwrap_or(""), e.str("target").unwrap_or("")) } else { text.to_owned() };
                    push(score, json!({"type": "event", "id": e.id, "task_id": e.task_id, "text": label, "kind": e.kind, "score": score, "at": e.at, "ms": e.ms, "artifact": e.fields.get("artifact")}), e.id, &mut seen);
                }
            }
        }
        // Keyframes found by what they showed.
        for (id, score) in &scored {
            if st.store.label(*id) == Some("Artifact") && *score > 0.3 {
                if let Some(doc) = st.store.doc::<Value>(*id) {
                    push(*score, json!({"type": "keyframe", "id": doc["id"], "task_id": doc["task_id"], "text": format!("{} {}", doc["title"].as_str().unwrap_or("Screenshot"), doc["url"].as_str().unwrap_or("")), "score": score, "at": doc["at"], "artifact": doc["id"]}), *id, &mut seen);
                }
            }
        }
        results.sort_by(|a, b| b.0.total_cmp(&a.0));
        results.into_iter().take(40).map(|(_, v)| v).collect()
    }

    pub fn memory_stats(&self) -> Value {
        let st = self.state.lock().unwrap();
        let mut v = st.store.stats();
        v["claims"] = json!(st.claims.values().filter(|c| c.state == "active").count());
        v
    }

    // ---------- settings & schedules ----------

    pub fn update_settings(&self, patch: &Value) -> Result<()> {
        let mut st = self.state.lock().unwrap();
        if let Some(v) = patch["approval_threshold_p"].as_i64() {
            st.settings.approval_threshold_p = v.max(0);
        }
        if let Some(v) = patch["default_executor"].as_str() {
            st.settings.default_executor = v.into();
        }
        if let Some(v) = patch["no_ask_merchants"].as_array() {
            st.settings.no_ask_merchants = v.iter().filter_map(|x| x.as_str().map(|s| s.to_lowercase())).collect();
        }
        if let Some(v) = patch["time_cap_s"].as_u64() {
            st.settings.time_cap_s = v.clamp(60, 24 * 3600);
        }
        if patch.get("telegram_chat_id").is_some() {
            st.settings.telegram_chat_id = patch["telegram_chat_id"].as_i64();
        }
        let settings = st.settings.clone();
        st.store.put("Settings", "settings:main", &settings, &[])?;
        Ok(())
    }

    pub fn add_schedule(&self, brief: &str, next_at: &str, every_minutes: Option<u64>, executor: Option<String>) -> Result<Schedule> {
        let sch = Schedule { id: new_id("s"), brief: brief.into(), executor, next_at: next_at.into(), every_minutes, active: true, created_at: now() };
        let mut st = self.state.lock().unwrap();
        st.store.put("Schedule", &format!("schedule:{}", sch.id), &sch, &[])?;
        st.schedules.insert(sch.id.clone(), sch.clone());
        Ok(sch)
    }

    /// Fire due schedules and enforce time caps. Called every few seconds.
    pub fn tick(self: &Arc<Self>) {
        let now_t = chrono::Utc::now();
        let due: Vec<Schedule> = {
            let mut st = self.state.lock().unwrap();
            let mut due = Vec::new();
            let ids: Vec<String> = st.schedules.keys().cloned().collect();
            for id in ids {
                let Some(sch) = st.schedules.get(&id).cloned() else { continue };
                if !sch.active {
                    continue;
                }
                let Ok(at) = chrono::DateTime::parse_from_rfc3339(&sch.next_at) else { continue };
                if at.with_timezone(&chrono::Utc) <= now_t {
                    let mut next = sch.clone();
                    match sch.every_minutes {
                        Some(m) => next.next_at = (now_t + chrono::Duration::minutes(m as i64)).to_rfc3339(),
                        None => next.active = false,
                    }
                    st.store.put("Schedule", &format!("schedule:{}", next.id), &next, &[]).ok();
                    st.schedules.insert(next.id.clone(), next);
                    due.push(sch);
                }
            }
            due
        };
        for sch in due {
            self.create_task(&sch.brief, None, sch.executor.as_deref(), "schedule", None).ok();
        }
        let over: Vec<String> = {
            let st = self.state.lock().unwrap();
            st.tasks
                .values()
                .filter(|t| !t.status.finished())
                .filter(|t| t.started_at.as_ref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).is_some_and(|s| (now_t - s.with_timezone(&chrono::Utc)).num_seconds() as u64 > t.time_cap_s))
                .map(|t| t.id.clone())
                .collect()
        };
        for id in over {
            self.cancel_task(&id, "Stopped at its time cap");
        }
    }

    pub fn terminal_log(&self, task_id: &str) -> Vec<u8> {
        std::fs::read(self.cfg.data_dir.join("terminal").join(format!("{task_id}.log"))).unwrap_or_default()
    }

    pub fn frames(&self, task_id: &str) -> Vec<Value> {
        let dir = self.cfg.data_dir.join("recordings").join(task_id);
        let mut out: Vec<Value> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        let ms: u64 = name.trim_end_matches(".jpg").parse().ok()?;
                        Some(json!({"ms": ms, "url": format!("/api/tasks/{task_id}/frames/{name}")}))
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by_key(|v| v["ms"].as_u64());
        out
    }

    pub fn embed_sender(&self) -> mpsc::UnboundedSender<(u64, Input)> {
        self.embed_tx.clone()
    }
}

pub fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

pub fn b64decode(s: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    let s = s.split_once(',').map(|(_, b)| b).unwrap_or(s);
    Ok(base64::engine::general_purpose::STANDARD.decode(s)?)
}

pub fn claim_text(c: &Claim) -> String {
    format!("{} ({}{}): {}", c.kind, c.subject, c.key.as_ref().map(|k| format!(" {k}")).unwrap_or_default(), c.text)
}

fn task_text(t: &Task) -> String {
    format!("Task #{} {}: {}. {}", t.num, t.title, t.brief, t.summary.clone().unwrap_or_default())
}

/// "cancel my meshy sub" → "Cancel my meshy sub"
pub fn title_from(brief: &str) -> String {
    let line = brief.lines().next().unwrap_or(brief).trim().trim_end_matches(['.', '!', '?']);
    let mut words: Vec<&str> = line.split_whitespace().collect();
    if words.first().is_some_and(|w| matches!(w.to_lowercase().as_str(), "can" | "could" | "please" | "pls")) {
        words.remove(0);
        if words.first().is_some_and(|w| w.eq_ignore_ascii_case("you")) {
            words.remove(0);
        }
    }
    let mut title = words.into_iter().take(9).collect::<Vec<_>>().join(" ");
    if let Some(first) = title.get(0..1) {
        title = first.to_uppercase() + &title[1..];
    }
    if title.is_empty() { "Task".into() } else { title }
}

pub async fn embed_worker(hub: Arc<Hub>, mut rx: mpsc::UnboundedReceiver<(u64, Input)>) {
    let mut failures = 0u32;
    while let Some(first) = rx.recv().await {
        let mut batch = vec![first];
        while batch.len() < 16 {
            match rx.try_recv() {
                Ok(item) => batch.push(item),
                Err(_) => break,
            }
        }
        let inputs: Vec<Input> = batch.iter().map(|(_, i)| i.clone()).collect();
        match hub.embedder.embed(&inputs).await {
            Ok(vectors) => {
                failures = 0;
                let pairs: Vec<(u64, Vec<f32>)> = batch.iter().map(|(id, _)| *id).zip(vectors).filter(|(_, v)| !v.is_empty()).collect();
                if let Err(e) = hub.state.lock().unwrap().store.set_vectors(pairs) {
                    tracing::warn!("storing vectors failed: {e:#}");
                }
            }
            Err(e) => {
                failures += 1;
                tracing::warn!("embedding failed ({failures}): {e:#}");
                // Fall back to local vectors so memory keeps working; they are
                // replaced when the profile is re-checked on the next start.
                if failures > 3 {
                    let pairs: Vec<(u64, Vec<f32>)> = batch.iter().map(|(id, i)| (*id, crate::embed::hash_embed(&match i { Input::Text(t) => t.clone(), Input::Image { caption, .. } => caption.clone() }))).collect();
                    let _ = pairs; // hashed vectors live in a different space; skip rather than mix.
                }
                tokio::time::sleep(std::time::Duration::from_secs(2u64.pow(failures.min(6)))).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(dir: &std::path::Path) -> Arc<Hub> {
        let cfg = Config { data_dir: dir.to_owned(), port: 0, token: None, machine_token: "t".into(), public_url: None, demo: true };
        let launcher = crate::launcher::Launcher::manual_for_tests(dir.to_owned());
        Hub::open(cfg, Embedder::local(), launcher).unwrap().0
    }

    fn src() -> ClaimSource {
        ClaimSource { task_id: None, message_id: None, event_id: None, label: "test".into() }
    }

    #[tokio::test]
    async fn claims_supersede_and_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let hub = open(dir.path());
        let old = hub.add_claim("subscription", "Polyform Pro renews 14 Oct", "polyform", Some("plan".into()), 0.9, 0.6, src()).unwrap();
        let new = hub.add_claim("subscription", "Polyform Pro cancelled, ends 14 Oct", "polyform", Some("plan".into()), 0.9, 0.6, src()).unwrap();
        assert_eq!(new.supersedes, Some(old.id));
        let detail = hub.claim_detail(new.id).unwrap();
        assert_eq!(detail["history"][0]["id"], json!(old.id));
        hub.add_claim("preference", "Ryan prefers aisle seats", "ryan", None, 0.9, 0.6, src()).unwrap();
        let packet = hub.context_packet_async("cancel polyform", 5).await;
        assert!(packet[0]["text"].as_str().unwrap().contains("cancelled"), "{packet:?}");
        drop(hub);
        let hub = open(dir.path());
        let claims = hub.claims();
        assert_eq!(claims.len(), 3);
        assert_eq!(claims.iter().find(|c| c.id == old.id).unwrap().state, "superseded");
    }

    #[tokio::test]
    async fn tasks_and_timelines_persist() {
        let dir = tempfile::tempdir().unwrap();
        let hub = open(dir.path());
        let t = hub.create_task("cancel my polyform sub", None, Some("scripted"), "web", None).unwrap();
        assert_eq!(t.title, "Cancel my polyform sub");
        hub.add_event(&t.id, "agent", "step", obj(json!({"text": "Opening billing", "step_id": "s1"}))).unwrap();
        // Let spawned dispatch work finish and release its handle.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(hub);
        let hub = open(dir.path());
        let t2 = hub.task(&t.id).unwrap();
        // Unfinished work is marked interrupted, never silently resumed.
        assert_eq!(t2.status, TaskStatus::Failed);
        let kinds: Vec<String> = hub.events(&t.id).into_iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec!["brief", "step"]);
    }

    #[test]
    fn titles() {
        assert_eq!(title_from("can you cancel my meshy sub?"), "Cancel my meshy sub");
        assert_eq!(title_from("Install Blender"), "Install Blender");
    }
}
