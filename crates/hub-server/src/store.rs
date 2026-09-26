use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use vecgra::{Database, DatabaseOptions, ElementRef, Value as V, VectorTarget};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub id: u64,
    pub kind: String,
    pub scope: String,
    pub time: String,
    pub payload: Value,
}

pub struct Store {
    pub artifacts: crate::artifacts::Artifacts,
    pub(crate) db: Database,
    pub(crate) events: Vec<Event>,
    pub(crate) scopes: HashMap<String, u64>,
    pub(crate) memory: crate::memory::MemoryIndex,
    last: HashMap<String, u64>,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
        }
        let db = if path.exists() {
            Database::open(path)?
        } else {
            Database::create(path, DatabaseOptions::new(crate::embeddings::DIMENSIONS))?
        };
        // No user data is written before permissions are tightened. This also
        // protects archives created by versions that inherited the host umask.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let mut events = Vec::new();
        let artifacts = crate::artifacts::Artifacts::new(path.with_file_name("artifacts"))?;
        let mut scopes = HashMap::new();
        let mut last = HashMap::new();
        {
            let read = db.read();
            for id in read.node_ids() {
                let node = read.node(id).unwrap();
                for p in node.properties.iter() {
                    if let V::String(s) = &p.value {
                        match read.symbol(p.key) {
                            Some("event") => {
                                let mut event: Event = serde_json::from_str(s)?;
                                event.id = id;
                                last.insert(event.scope.clone(), id);
                                events.push(event);
                            }
                            Some("scope_id") => {
                                scopes.insert(s.to_string(), id);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        events.sort_by_key(|e| e.id);
        // Upgrade older native image receipts once. The image bytes are copied
        // before replacing embedded base64 with searchable attachment metadata.
        for event in &mut events {
            if event.kind != "tool.result" {
                continue;
            }
            let original = event.payload.clone();
            artifacts.normalize(&mut event.payload);
            if event.payload != original {
                let mut tx = db.transaction();
                tx.update_node(
                    event.id,
                    "Event",
                    [
                        ("event", V::String(Arc::from(serde_json::to_string(event)?))),
                        ("kind", V::String(Arc::from(event.kind.as_str()))),
                    ],
                    &[],
                )?;
                tx.commit()?;
            }
        }
        for event in &events {
            last.insert(event.scope.clone(), event.id);
        }
        let mut memory = crate::memory::MemoryIndex::default();
        for (i, event) in events.iter().enumerate() {
            memory.add(event, i);
        }
        Ok(Self {
            artifacts,
            memory,
            db,
            events,
            scopes,
            last,
        })
    }
    pub fn append(&mut self, kind: &str, scope: &str, mut payload: Value) -> Result<Event> {
        if kind == "tool.result" {
            self.artifacts.normalize(&mut payload);
        }
        let mut event = Event {
            id: 0,
            kind: kind.into(),
            scope: scope.into(),
            time: chrono::Utc::now().to_rfc3339(),
            payload,
        };
        let mut tx = self.db.transaction();
        let scope_node = self.scopes.get(scope).copied().unwrap_or_else(|| {
            tx.create_node("Scope", [("scope_id", V::String(Arc::from(scope)))], &[])
        });
        let text = serde_json::to_string(&event)?;
        let id = tx.create_node(
            "Event",
            [
                ("event", V::String(Arc::from(text))),
                ("kind", V::String(Arc::from(kind))),
            ],
            &[],
        );
        tx.create_edge(
            scope_node,
            id,
            "HAS_EVENT",
            std::iter::empty::<(&str, V)>(),
            &[],
        );
        if let Some(previous) = self.last.get(scope) {
            tx.create_edge(*previous, id, "NEXT", std::iter::empty::<(&str, V)>(), &[]);
        }
        tx.commit()?;
        event.id = id;
        self.scopes.insert(scope.into(), scope_node);
        self.last.insert(scope.into(), id);
        self.memory.add(&event, self.events.len());
        self.events.push(event.clone());
        Ok(event)
    }
    pub fn events(&self) -> Vec<Event> {
        self.events.clone()
    }
    pub fn metadata(&self) -> Vec<Event> {
        self.events
            .iter()
            .filter(|e| e.kind != "terminal.output")
            .cloned()
            .collect()
    }
    pub fn event_count(&self) -> usize {
        self.events.len()
    }
    pub fn archive_offset(&self, scope: &str) -> u64 {
        self.events
            .iter()
            .rev()
            .find(|e| e.scope == scope && e.kind == "terminal.output" && e.payload["end"].is_u64())
            .and_then(|e| e.payload["end"].as_u64())
            .unwrap_or(0)
    }
    pub fn has_terminal_output(&self, scope: &str) -> bool {
        self.events
            .iter()
            .any(|e| e.scope == scope && e.kind == "terminal.output")
    }
    pub fn pending_embeddings(&self, limit: usize) -> Vec<Event> {
        let read = self.db.read();
        self.events
            .iter()
            .filter(|e| {
                (matches!(
                    e.kind.as_str(),
                    "message.user"
                        | "message.assistant"
                        | "tool.result"
                        | "session.created"
                        | "device.saved"
                ) || (e.kind == "terminal.output"
                    && e.payload["text"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty())))
                    && read.node(e.id).is_some_and(|n| n.vector_count == 0)
            })
            .take(limit)
            .cloned()
            .collect()
    }
    /// Switch model identity and remove incompatible vectors in one durable
    /// transaction. Node/edge IDs, properties, events, and attachments stay put.
    pub fn prepare_embeddings(&mut self, profile: &str) -> Result<Option<PathBuf>> {
        anyhow::ensure!(
            self.db.vector_dimension() == crate::embeddings::DIMENSIONS,
            "Memory database has an unsupported embedding dimension"
        );
        let read = self.db.read();
        let marker = read.node_ids().into_iter().find_map(|id| {
            let node = read.node(id)?;
            (read.symbol(node.label) == Some("EmbeddingConfig")).then(|| {
                let current = node.properties.iter().find_map(|p| {
                    if read.symbol(p.key) == Some("profile")
                        && let V::String(value) = &p.value
                    {
                        return Some(value.to_string());
                    }
                    None
                });
                (id, current)
            })
        });
        if marker.as_ref().and_then(|(_, p)| p.as_deref()) == Some(profile) {
            return Ok(None);
        }
        let nodes = read
            .node_ids()
            .into_iter()
            .filter_map(|id| {
                let n = read.node(id)?;
                (n.vector_count > 0).then(|| {
                    (
                        id,
                        read.symbol(n.label).unwrap().to_owned(),
                        n.properties
                            .iter()
                            .map(|p| (read.symbol(p.key).unwrap().to_owned(), p.value.clone()))
                            .collect::<Vec<_>>(),
                    )
                })
            })
            .collect::<Vec<_>>();
        let edges = read
            .edge_ids()
            .into_iter()
            .filter_map(|id| {
                let e = read.edge(id)?;
                (e.vector_count > 0).then(|| {
                    (
                        id,
                        e.source,
                        e.target,
                        read.symbol(e.label).unwrap().to_owned(),
                        e.properties
                            .iter()
                            .map(|p| (read.symbol(p.key).unwrap().to_owned(), p.value.clone()))
                            .collect::<Vec<_>>(),
                    )
                })
            })
            .collect::<Vec<_>>();
        drop(read);
        let backup = if !nodes.is_empty() || !edges.is_empty() {
            let path = self.db.path();
            let backup = path.with_file_name(format!(
                "{}.pre-embedding-{}.vg",
                path.file_name().unwrap().to_string_lossy(),
                uuid::Uuid::new_v4()
            ));
            // Vecgra creates files with the host umask. Write inside a private
            // temporary directory, then publish the already-protected backup.
            let staging = tempfile::tempdir_in(path.parent().unwrap())?;
            let staged = staging.path().join("memory.vg");
            self.db.compact_to(&staged, self.db.vector_encoding())?;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600))?;
            std::fs::rename(staged, &backup)?;
            Some(backup)
        } else {
            None
        };
        let mut tx = self.db.transaction();
        for (id, label, props) in nodes {
            tx.update_node(id, label, props, &[])?;
        }
        for (id, source, target, label, props) in edges {
            tx.update_edge(id, source, target, label, props, &[])?;
        }
        let props = [("profile", V::String(Arc::from(profile)))];
        if let Some((id, _)) = marker {
            tx.update_node(id, "EmbeddingConfig", props, &[])?;
        } else {
            tx.create_node("EmbeddingConfig", props, &[]);
        }
        tx.commit()?;
        Ok(backup)
    }
    pub fn embed(&self, id: u64, vector: Vec<f32>) -> Result<()> {
        self.embed_batch(vec![(id, vector)])
    }
    pub fn embed_batch(&self, vectors: Vec<(u64, Vec<f32>)>) -> Result<()> {
        let mut tx = self.db.transaction();
        for (id, vector) in vectors {
            let properties = {
                let r = self.db.read();
                let n = r.node(id).ok_or_else(|| anyhow::anyhow!("event missing"))?;
                n.properties
                    .iter()
                    .map(|p| (r.symbol(p.key).unwrap().to_owned(), p.value.clone()))
                    .collect::<Vec<_>>()
            };
            tx.update_node(id, "Event", properties, &[vector])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn search(&self, query: &str, vector: Option<&[f32]>) -> Result<Vec<Event>> {
        let mut ranked: HashMap<u64, f32> = HashMap::new();
        if let Some(v) = vector {
            for hit in self
                .db
                .read()
                .vector_search(v, VectorTarget::Nodes, 24, None)?
            {
                if let ElementRef::Node(id) = hit.element {
                    ranked.insert(id, hit.score);
                }
            }
        }
        let query = query.to_lowercase();
        for event in self.events.iter() {
            // Keep transport chunks for replay; search the canonical answer.
            if matches!(event.kind.as_str(), "message.started" | "message.delta") {
                continue;
            }
            if (if event.kind == "terminal.output" {
                event.payload["text"].as_str().unwrap_or("").to_owned()
            } else {
                event.payload.to_string()
            })
            .to_lowercase()
            .contains(&query)
            {
                *ranked.entry(event.id).or_default() += 1.0;
            }
        }
        let mut matches: Vec<_> = self
            .events
            .iter()
            .filter_map(|e| ranked.get(&e.id).map(|s| (*s, e.clone())))
            .collect();
        matches.sort_by(|a, b| b.0.total_cmp(&a.0));
        Ok(matches
            .into_iter()
            .take(30)
            .map(|(_, mut e)| {
                if let Some(payload) = e.payload.as_object_mut() {
                    payload.remove("bytes");
                }
                e
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failed_commit_does_not_leave_an_uncommitted_scope_in_memory() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("memory.vg");
        let mut store = Store::open(&path).unwrap();
        // A read-only handle gives a deterministic commit failure without
        // damaging a file or depending on the host's permission model.
        store.db = Database::open_read_only(&path).unwrap();
        assert!(
            store
                .append("message.user", "chat", json!({"text":"retry me"}))
                .is_err()
        );
        store.db = Database::open(&path).unwrap();
        store
            .append("message.user", "chat", json!({"text":"retry succeeded"}))
            .unwrap();
        let graph = store.memory_graph(None, 0).unwrap();
        assert_eq!(graph["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(graph["edges"].as_array().unwrap().len(), 1);
        drop(store);
        assert_eq!(Store::open(&path).unwrap().events().len(), 1);
    }
}
