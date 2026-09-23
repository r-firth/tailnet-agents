//! Qwen retrieval embeddings over OpenRouter. The graph's vector dimension is
//! retained during migration; model identity is stored separately in Vecgra.
use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;
type QueryResult = Option<(Instant, std::result::Result<Vec<f32>, String>)>;
struct QueryEntry {
    text: String,
    result: watch::Receiver<QueryResult>,
}

pub const MODEL: &str = "qwen/qwen3-embedding-8b";
pub const DIMENSIONS: usize = 384;
pub const ENDPOINT: &str = "https://openrouter.ai/api/v1/embeddings";
const QUERY_PREFIX: &str = "Instruct: Retrieve graph elements relevant to the query\nQuery: ";

#[derive(Clone)]
pub struct Embedder {
    client: Client,
    endpoint: Url,
    api_key: Option<String>,
    queries: Arc<Mutex<VecDeque<QueryEntry>>>,
}
impl Embedder {
    pub fn from_env() -> Result<Self> {
        Self::new(
            std::env::var("OPENROUTER_API_KEY").ok(),
            &std::env::var("HUB_EMBEDDING_URL").unwrap_or_else(|_| ENDPOINT.into()),
        )
    }
    pub fn new(api_key: Option<String>, endpoint: &str) -> Result<Self> {
        let endpoint = Url::parse(endpoint).context("Invalid embedding endpoint")?;
        let loopback = endpoint.host_str().is_some_and(|h| {
            h == "localhost"
                || h.parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        ensure!(
            (endpoint.scheme() == "https" || (endpoint.scheme() == "http" && loopback))
                && endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.query().is_none()
                && endpoint.fragment().is_none(),
            "Embedding endpoint requires HTTPS (HTTP is allowed only on loopback) and no credentials or query parameters"
        );
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(45))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            endpoint,
            api_key: api_key
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()),
            queries: Arc::new(Mutex::new(VecDeque::new())),
        })
    }
    pub fn configured(&self) -> bool {
        self.api_key.is_some()
    }
    pub fn profile(&self) -> String {
        json!({"provider":self.endpoint.as_str(),"model":MODEL,"dimensions":DIMENSIONS,"query_prefix":QUERY_PREFIX}).to_string()
    }
    pub async fn query(&self, text: &str) -> Result<Vec<f32>> {
        ensure!(
            self.configured(),
            "Set OPENROUTER_API_KEY to enable Qwen semantic memory"
        );
        let mut result = {
            let mut cache = self.queries.lock().unwrap();
            // A brief negative cache stops concurrent viewers from multiplying
            // failing requests, while allowing a later retry to recover.
            cache.retain(|entry| {
                !entry.result.borrow().as_ref().is_some_and(|(at, result)| {
                    result.is_err() && at.elapsed() > Duration::from_secs(10)
                })
            });
            if let Some(index) = cache.iter().position(|entry| entry.text == text) {
                let entry = cache.remove(index).unwrap();
                let result = entry.result.clone();
                cache.push_back(entry);
                result
            } else {
                ensure!(
                    cache
                        .iter()
                        .filter(|entry| entry.result.borrow().is_none())
                        .count()
                        < 8,
                    "Semantic search is busy; showing text matches"
                );
                if cache.len() >= 64 {
                    let index = cache
                        .iter()
                        .position(|entry| entry.result.borrow().is_some())
                        .context("Semantic search is busy")?;
                    cache.remove(index);
                }
                let (sender, receiver) = watch::channel(None);
                cache.push_back(QueryEntry {
                    text: text.into(),
                    result: receiver.clone(),
                });
                let client = self.clone();
                let input = format!("{QUERY_PREFIX}{text}");
                // Own the provider request independently of any browser's
                // deadline or disconnect. Every viewer awaits the same result.
                tokio::spawn(async move {
                    let result = match tokio::time::timeout(
                        Duration::from_secs(15),
                        client.embed_documents(vec![input]),
                    )
                    .await
                    {
                        Ok(Ok(mut vectors)) => {
                            vectors.pop().ok_or_else(|| "No query vector".to_owned())
                        }
                        Ok(Err(error)) => Err(error.to_string()),
                        Err(_) => Err("OpenRouter query embedding timed out".into()),
                    };
                    if let Err(error) = &result {
                        tracing::warn!(error = %error, "Qwen query embedding failed");
                    }
                    sender.send_replace(Some((Instant::now(), result)));
                });
                receiver
            }
        };
        loop {
            if let Some((_, value)) = result.borrow().clone() {
                return value.map_err(anyhow::Error::msg);
            }
            result
                .changed()
                .await
                .context("Query embedding worker stopped")?;
        }
    }
    /// Return quick text matches while a single shared Qwen request completes.
    /// Read result and pending state together so completion at the deadline
    /// cannot strand a viewer with text results and no refresh signal.
    pub async fn search_query(&self, text: &str) -> (Option<Vec<f32>>, bool) {
        let _ = tokio::time::timeout(Duration::from_millis(150), self.query(text)).await;
        let cache = self.queries.lock().unwrap();
        let Some(entry) = cache.iter().find(|entry| entry.text == text) else {
            return (None, false);
        };
        match entry.result.borrow().as_ref() {
            Some((_, Ok(vector))) => (Some(vector.clone()), false),
            Some((_, Err(_))) => (None, false),
            None => (None, true),
        }
    }
    pub async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let key = self
            .api_key
            .as_deref()
            .context("Set OPENROUTER_API_KEY to enable Qwen semantic memory")?;
        let body =
            json!({"model":MODEL,"input":texts,"dimensions":DIMENSIONS,"encoding_format":"float"});
        for attempt in 0..3 {
            let response = self
                .client
                .post(self.endpoint.clone())
                .bearer_auth(key)
                .json(&body)
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    let reply = response.json::<EmbeddingResponse>().await.map_err(|_| {
                        anyhow::anyhow!("OpenRouter returned an invalid embedding response")
                    })?;
                    return ordered_vectors(reply, texts.len());
                }
                Ok(response) => {
                    let status = response.status();
                    let retryable = status == StatusCode::TOO_MANY_REQUESTS
                        || status == StatusCode::REQUEST_TIMEOUT
                        || status.is_server_error();
                    // Do not propagate remote response bodies: they can echo
                    // the submitted text or credentials into logs and events.
                    if !retryable || attempt == 2 {
                        bail!("OpenRouter embeddings returned HTTP {}", status.as_u16());
                    }
                    let delay = response
                        .headers()
                        .get("retry-after")
                        .and_then(|h| h.to_str().ok())
                        .and_then(|h| h.parse::<u64>().ok())
                        .map(|s| Duration::from_secs(s.min(30)))
                        .unwrap_or_else(|| Duration::from_millis(350 * (1 << attempt)));
                    tokio::time::sleep(delay).await;
                }
                Err(_) => {
                    if attempt == 2 {
                        bail!("OpenRouter embeddings could not connect or timed out");
                    }
                    tokio::time::sleep(Duration::from_millis(350 * (1 << attempt))).await;
                }
            }
        }
        unreachable!()
    }
}
#[derive(Deserialize)]
struct EmbeddingResponse {
    model: Option<String>,
    data: Vec<EmbeddingDatum>,
}
#[derive(Deserialize)]
struct EmbeddingDatum {
    index: usize,
    embedding: Vec<f32>,
}
fn ordered_vectors(reply: EmbeddingResponse, count: usize) -> Result<Vec<Vec<f32>>> {
    ensure!(
        reply
            .model
            .is_none_or(|model| model.eq_ignore_ascii_case(MODEL)),
        "OpenRouter returned a different embedding model"
    );
    ensure!(
        reply.data.len() == count,
        "OpenRouter returned an incorrect embedding count"
    );
    let mut ordered = vec![None; count];
    for datum in reply.data {
        ensure!(
            datum.index < count,
            "OpenRouter returned an invalid input index"
        );
        ensure!(
            datum.embedding.len() == DIMENSIONS
                && datum.embedding.iter().all(|v| v.is_finite())
                && datum.embedding.iter().any(|v| *v != 0.0),
            "OpenRouter returned an invalid embedding vector"
        );
        ensure!(
            ordered[datum.index].replace(datum.embedding).is_none(),
            "OpenRouter returned duplicate input indices"
        );
    }
    ordered
        .into_iter()
        .map(|v| v.context("OpenRouter omitted an embedding"))
        .collect()
}
