//! After each task: write the episode, learn a procedure from what worked,
//! and (with a model key) extract grounded claims that cite the task.
use crate::hub::{Hub, obj};
use crate::model::{ClaimSource, Task, TaskStatus};
use serde_json::{Value, json};
use std::sync::Arc;

pub async fn after_task(hub: &Arc<Hub>, t: &Task) {
    if t.status == TaskStatus::Cancelled {
        return;
    }
    let events = hub.events(&t.id);
    let done_event = events.iter().rev().find(|e| e.kind == "done" || e.kind == "failed").map(|e| e.id);
    let steps: Vec<String> = events.iter().filter(|e| e.kind == "step").filter_map(|e| e.str("text").map(str::to_owned)).collect();
    let written: Vec<(String, String)> = events
        .iter()
        .filter(|e| e.kind == "memory.write")
        .map(|e| (e.str("claim_kind").unwrap_or("").to_owned(), e.str("text").unwrap_or("").to_owned()))
        .collect();
    let subject = {
        let st = hub.state.lock().unwrap();
        events
            .iter()
            .filter(|e| e.kind == "memory.write")
            .filter_map(|e| e.fields.get("claim_id").and_then(Value::as_u64))
            .filter_map(|id| st.claims.get(&id).map(|c| c.subject.clone()))
            .find(|s| !s.is_empty())
            .unwrap_or_default()
    };
    let source = |label: String| ClaimSource { task_id: Some(t.id.clone()), message_id: None, event_id: done_event, label };
    let label = format!("Task #{}", t.num);

    let summary = t.summary.clone().unwrap_or_default();
    let episode = format!("{} ({}): {}", t.title, t.outcome.clone().unwrap_or_default(), summary);
    if let Ok(c) = hub.add_claim("episode", &episode, &subject, None, 1.0, 0.4, source(label.clone())) {
        hub.add_event(&t.id, "memory", "memory.write", obj(json!({"op": "add", "text": c.text, "claim_kind": "episode", "claim_id": c.id}))).ok();
    }

    let has_procedure = written.iter().any(|(k, _)| k == "procedure");
    if t.status == TaskStatus::Done && !has_procedure && steps.len() >= 3 {
        let text = format!("How to {}: {}", lowercase_first(&t.title), steps.join(" → "));
        if let Ok(c) = hub.add_claim("procedure", &text, &subject, Some(format!("howto:{}", slug(&t.title))), 0.8, 0.7, source(label.clone())) {
            hub.add_event(&t.id, "memory", "memory.write", obj(json!({"op": if c.supersedes.is_some() {"supersede"} else {"add"}, "text": c.text, "claim_kind": "procedure", "claim_id": c.id}))).ok();
        }
    }

    if let Some(extracted) = extract(t, &steps, &written).await {
        for item in extracted {
            let (Some(kind), Some(text)) = (item["kind"].as_str(), item["text"].as_str()) else { continue };
            let subj = item["subject"].as_str().unwrap_or(&subject).to_owned();
            if let Ok(c) = hub.add_claim(kind, text, &subj, item["key"].as_str().map(str::to_owned), item["confidence"].as_f64().unwrap_or(0.8), 0.6, source(label.clone())) {
                hub.add_event(&t.id, "memory", "memory.write", obj(json!({"op": if c.supersedes.is_some() {"supersede"} else {"add"}, "text": c.text, "claim_kind": c.kind, "claim_id": c.id}))).ok();
            }
        }
    }
}

/// Grounded claim extraction with the coordinator's model. Every claim must
/// be supported by the task record; the prompt forbids guesses.
async fn extract(t: &Task, steps: &[String], written: &[(String, String)]) -> Option<Vec<Value>> {
    let key = std::env::var("OPENROUTER_API_KEY").ok().filter(|k| !k.trim().is_empty())?;
    if std::env::var("FAMILIAR_COORDINATOR").is_ok_and(|v| v == "mock") {
        return None;
    }
    let model = std::env::var("FAMILIAR_COORDINATOR_MODEL").unwrap_or_else(|_| "anthropic/claude-opus-5.5".into());
    let base = std::env::var("OPENROUTER_BASE_URL").unwrap_or_else(|_| "https://openrouter.ai/api/v1".into());
    let record = json!({"brief": t.brief, "outcome": t.outcome, "summary": t.summary, "steps": steps, "already_written": written});
    let prompt = format!(
        "From this completed task record, extract durable facts about Ryan's accounts, subscriptions, preferences or rules that the record directly proves. Skip anything already written, anything speculative, and secrets. For facts that can change, give a stable key (e.g. plan, renewal, status). Reply with JSON only: {{\"claims\": [{{\"kind\": \"fact|account|subscription|preference|rule\", \"subject\": \"lowercase\", \"key\": \"optional\", \"text\": \"...\", \"confidence\": 0.0-1.0}}]}}. Return an empty list if nothing qualifies.\n\n{record}"
    );
    let body = json!({"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": 800, "response_format": {"type": "json_object"}});
    let client = reqwest::Client::new();
    let response = client.post(format!("{base}/chat/completions")).bearer_auth(key).json(&body).send().await.ok()?;
    let value: Value = response.json().await.ok()?;
    let content = value["choices"][0]["message"]["content"].as_str()?;
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    let parsed: Value = serde_json::from_str(&content[start..=end]).ok()?;
    parsed["claims"].as_array().cloned()
}

fn lowercase_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn slug(s: &str) -> String {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join("-")
}
