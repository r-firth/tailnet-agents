//! Embeddings: google/gemini-embedding-2 through OpenRouter (one multimodal
//! space, 3,072 dims), or a local hashed bag-of-words fallback in the same
//! dimension so the product works with no keys. The active profile is stored
//! in the graph; switching profile clears vectors and re-embeds.
use crate::store::DIMENSIONS;
use anyhow::{Context, Result, bail};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Clone, Debug)]
pub enum Input {
    Text(String),
    /// JPEG/PNG bytes plus a caption used by the fallback and as a second facet.
    Image { bytes: Vec<u8>, mime: String, caption: String },
}

#[derive(Clone)]
pub struct Embedder {
    client: reqwest::Client,
    key: Option<String>,
    base: String,
    model: String,
}

impl Embedder {
    pub fn from_env() -> Self {
        let key = std::env::var("OPENROUTER_API_KEY").ok().map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
        let disabled = std::env::var("FAMILIAR_EMBEDDER").is_ok_and(|v| v == "hash");
        Self {
            client: reqwest::Client::builder().timeout(Duration::from_secs(60)).build().expect("http client"),
            key: if disabled { None } else { key },
            base: std::env::var("OPENROUTER_BASE_URL").unwrap_or_else(|_| "https://openrouter.ai/api/v1".into()),
            model: std::env::var("FAMILIAR_EMBEDDING_MODEL").unwrap_or_else(|_| "google/gemini-embedding-2".into()),
        }
    }

    /// Offline embedder (tests, demo).
    #[cfg(test)]
    pub fn local() -> Self {
        Self { client: reqwest::Client::new(), key: None, base: String::new(), model: String::new() }
    }

    pub fn remote(&self) -> bool {
        self.key.is_some()
    }

    pub fn profile(&self) -> String {
        if self.remote() { format!("openrouter:{}:{DIMENSIONS}", self.model) } else { format!("hash-v1:{DIMENSIONS}") }
    }

    pub fn label(&self) -> String {
        if self.remote() { self.model.clone() } else { "local hash (set OPENROUTER_API_KEY for gemini-embedding-2)".into() }
    }

    pub async fn embed(&self, inputs: &[Input]) -> Result<Vec<Vec<f32>>> {
        if inputs.is_empty() {
            return Ok(vec![]);
        }
        let Some(key) = &self.key else {
            return Ok(inputs.iter().map(|i| hash_embed(&caption(i))).collect());
        };
        // Text goes in one batch; each image is its own request so one bad image
        // can't fail the batch, and a failed image falls back to its caption.
        let mut out = vec![Vec::new(); inputs.len()];
        let texts: Vec<(usize, String)> = inputs
            .iter()
            .enumerate()
            .filter_map(|(i, x)| match x {
                Input::Text(t) => Some((i, truncate(t, 12_000))),
                _ => None,
            })
            .collect();
        if !texts.is_empty() {
            let body = json!({"model": self.model, "input": texts.iter().map(|(_, t)| t.clone()).collect::<Vec<_>>(), "dimensions": DIMENSIONS});
            let vectors = self.call(key, body).await?;
            for ((i, _), v) in texts.iter().zip(vectors) {
                out[*i] = v;
            }
        }
        for (i, input) in inputs.iter().enumerate() {
            if let Input::Image { bytes, mime, caption } = input {
                let url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
                // OpenAI-compatible multimodal input shape. Unverified for this
                // model on OpenRouter; on failure we embed the caption instead.
                let body = json!({"model": self.model, "dimensions": DIMENSIONS,
                    "input": [{"content": [{"type": "image_url", "image_url": {"url": url}}]}]});
                out[i] = match self.call(key, body).await {
                    Ok(mut v) if !v.is_empty() => v.remove(0),
                    Ok(_) | Err(_) => {
                        tracing::debug!("image embedding failed; embedding caption instead");
                        let body = json!({"model": self.model, "input": [truncate(caption, 4000)], "dimensions": DIMENSIONS});
                        self.call(key, body).await?.into_iter().next().unwrap_or_default()
                    }
                };
            }
        }
        Ok(out)
    }

    async fn call(&self, key: &str, body: Value) -> Result<Vec<Vec<f32>>> {
        let response = self
            .client
            .post(format!("{}/embeddings", self.base))
            .bearer_auth(key)
            .header("HTTP-Referer", "https://github.com/r-firth/familiar")
            .header("X-Title", "Familiar")
            .json(&body)
            .send()
            .await
            .context("embedding request")?;
        let status = response.status();
        let value: Value = response.json().await.context("embedding response")?;
        if !status.is_success() {
            bail!("embedding API {status}: {}", value["error"]["message"].as_str().unwrap_or(&value.to_string()));
        }
        let data = value["data"].as_array().context("embedding response has no data")?;
        let mut vectors = Vec::new();
        for item in data {
            let v: Vec<f32> = item["embedding"]
                .as_array()
                .context("no embedding")?
                .iter()
                .map(|x| x.as_f64().unwrap_or(0.0) as f32)
                .collect();
            vectors.push(fit(v));
        }
        Ok(vectors)
    }
}

fn caption(input: &Input) -> String {
    match input {
        Input::Text(t) => t.clone(),
        Input::Image { caption, .. } => caption.clone(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_owned()
}

/// Pad or cut to the database dimension, then L2-normalise.
fn fit(mut v: Vec<f32>) -> Vec<f32> {
    v.resize(DIMENSIONS, 0.0);
    normalise(&mut v);
    v
}

fn normalise(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}

/// Signed feature hashing over word unigrams, bigrams and character trigrams.
/// Crude, but gives useful lexical similarity offline.
pub fn hash_embed(text: &str) -> Vec<f32> {
    let mut v = vec![0.0f32; DIMENSIONS];
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty() && !STOP.contains(w)).collect();
    let mut add = |feature: &str, weight: f32| {
        let h = Sha256::digest(feature.as_bytes());
        let idx = u32::from_le_bytes([h[0], h[1], h[2], h[3]]) as usize % DIMENSIONS;
        let sign = if h[4] & 1 == 0 { 1.0 } else { -1.0 };
        v[idx] += sign * weight;
    };
    for w in &words {
        add(w, 1.0);
        let stem = w.trim_end_matches('s');
        if stem != *w {
            add(stem, 0.6);
        }
        let chars: Vec<char> = format!(" {w} ").chars().collect();
        for tri in chars.windows(3) {
            add(&format!("#{}", tri.iter().collect::<String>()), 0.25);
        }
    }
    for pair in words.windows(2) {
        add(&format!("{} {}", pair[0], pair[1]), 0.7);
    }
    normalise(&mut v);
    v
}

const STOP: &[&str] = &["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "my", "me", "i", "you", "can", "please", "with", "at", "be", "this", "that", "what", "do"];
