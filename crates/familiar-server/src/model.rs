//! Wire and storage shapes. See docs/protocol.md for the contract.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id(prefix: &str) -> String {
    let id = uuid::Uuid::now_v7().simple().to_string();
    // The v7 prefix is a timestamp; the tail keeps ids unique and short.
    format!("{prefix}_{}", &id[id.len() - 12..])
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Starting,
    Running,
    Waiting,
    Done,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn finished(&self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
    pub fn label(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Waiting => "waiting on you",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub num: u64,
    pub title: String,
    pub brief: String,
    pub status: TaskStatus,
    pub executor: String,
    pub machine_id: Option<String>,
    pub source: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    #[serde(default)]
    pub now: String,
    #[serde(default)]
    pub waiting_for: Option<String>,
    #[serde(default)]
    pub step: u32,
    #[serde(default)]
    pub steps_estimate: u32,
    #[serde(default)]
    pub spend_p: i64,
    #[serde(default)]
    pub tokens: u64,
    pub time_cap_s: u64,
    #[serde(default)]
    pub control: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub receipt_artifact: Option<String>,
    #[serde(default)]
    pub last_frame_artifact: Option<String>,
    /// Telegram chat + message that mirrors this task (edited in place).
    #[serde(default)]
    pub telegram: Option<(i64, i64)>,
    #[serde(default)]
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub id: u64,
    pub task_id: String,
    pub at: String,
    pub ms: u64,
    pub actor: String,
    pub kind: String,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl Event {
    pub fn str(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
    pub channel: String,
    #[serde(default)]
    pub task_id: Option<String>,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClaimSource {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub event_id: Option<u64>,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Claim {
    pub id: u64,
    pub kind: String,
    pub text: String,
    pub subject: String,
    /// Optional stable slot ("plan", "login") — a new claim with the same
    /// subject and key supersedes the old one instead of overwriting it.
    #[serde(default)]
    pub key: Option<String>,
    pub confidence: f64,
    pub salience: f64,
    pub state: String,
    pub source: ClaimSource,
    pub created_at: String,
    #[serde(default)]
    pub superseded_by: Option<u64>,
    #[serde(default)]
    pub supersedes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NeedsYou {
    pub id: String,
    pub task_id: String,
    pub task_num: u64,
    pub task_title: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub options: Vec<Value>,
    pub allow_text: bool,
    pub created_at: String,
    #[serde(skip)]
    pub merchant: Option<String>,
    #[serde(skip)]
    pub telegram: Option<(i64, i64)>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub status: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub specs: Value,
    #[serde(default)]
    pub stats: Value,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub has_desktop: bool,
    #[serde(default)]
    pub desktop_url: Option<String>,
    #[serde(default)]
    pub last_backup_at: Option<String>,
    #[serde(default)]
    pub installs: Vec<String>,
    #[serde(default)]
    pub executors: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub approval_threshold_p: i64,
    pub default_executor: String,
    #[serde(default)]
    pub no_ask_merchants: Vec<String>,
    #[serde(default)]
    pub telegram_chat_id: Option<i64>,
    #[serde(default = "default_cap")]
    pub time_cap_s: u64,
}

fn default_cap() -> u64 {
    3600
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Schedule {
    pub id: String,
    pub brief: String,
    pub executor: Option<String>,
    /// Next run time (RFC 3339).
    pub next_at: String,
    /// Repeat interval; None runs once.
    pub every_minutes: Option<u64>,
    pub active: bool,
    pub created_at: String,
}

pub fn gbp(p: i64) -> String {
    format!("£{}.{:02}", p / 100, (p % 100).abs())
}
