use crate::Shared;
pub use hub_server::embeddings::Embedder;
use hub_server::embeddings::{DIMENSIONS, MODEL};
use serde_json::json;
use std::{collections::HashMap, time::Duration};

/// Agent retrieval waits for the shared query; browser searches return text
/// first and refresh when the same embedding completes.
/// Provider failure leaves lexical retrieval usable without mixing models.
pub async fn query(h: &Shared, text: &str) -> Option<Vec<f32>> {
    tokio::time::timeout(Duration::from_secs(16), h.embedder.query(text.trim()))
        .await
        .ok()
        .and_then(Result::ok)
}
fn status(h: &Shared, state: &str) {
    let changed = {
        let mut current = h.embedding_status.lock().unwrap();
        let changed = current.as_str() != state;
        *current = state.into();
        changed
    };
    if changed {
        let _ = h.record(
            &format!("memory.{state}"),
            "hub",
            json!({"model":MODEL,"dimensions":DIMENSIONS}),
        );
    }
}
pub fn start(h: Shared) {
    tokio::spawn(async move {
        if !h.embedder.configured() {
            status(&h, "unavailable");
            let _ = h.record(
                "memory.error",
                "hub",
                json!({"error":"Set OPENROUTER_API_KEY to enable Qwen semantic memory"}),
            );
            return;
        }
        let mut verified = false;
        let mut last_error = String::new();
        loop {
            let pending = h.store.lock().unwrap().pending_embeddings(32);
            let result = if pending.is_empty() {
                if verified {
                    Ok(())
                } else {
                    h.embedder.query("Hub memory").await.map(|_| ())
                }
            } else {
                if last_error.is_empty() {
                    status(&h, "indexing");
                }
                // Repeated terminal lines or receipts need one API vector per
                // distinct text in the batch, then attach it to each event.
                let mut lookup = HashMap::new();
                let mut texts = Vec::new();
                let mut indices = Vec::new();
                for e in &pending {
                    let text: String = format!(
                        "{} {}",
                        e.kind,
                        e.payload
                            .get("text")
                            .and_then(|v| v.as_str())
                            .map(str::to_owned)
                            .unwrap_or_else(|| e.payload.to_string())
                    )
                    .chars()
                    .take(6000)
                    .collect();
                    let index = *lookup.entry(text.clone()).or_insert_with(|| {
                        texts.push(text);
                        texts.len() - 1
                    });
                    indices.push(index);
                }
                match h.embedder.embed_documents(texts).await {
                    Ok(vectors) => {
                        let batch = pending
                            .iter()
                            .zip(indices)
                            .map(|(e, i)| (e.id, vectors[i].clone()))
                            .collect();
                        h.store.lock().unwrap().embed_batch(batch)
                    }
                    Err(error) => Err(error),
                }
            };
            match result {
                Ok(()) => {
                    verified = true;
                    last_error.clear();
                    let done = h.store.lock().unwrap().pending_embeddings(1).is_empty();
                    status(&h, if done { "ready" } else { "indexing" });
                    tokio::time::sleep(if done {
                        Duration::from_secs(2)
                    } else {
                        Duration::from_millis(100)
                    })
                    .await;
                }
                Err(error) => {
                    status(&h, "unavailable");
                    let error = error.to_string();
                    if error != last_error {
                        let _ = h.record("memory.error", "hub", json!({"error":error}));
                        last_error = error;
                    }
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
            }
        }
    });
}
