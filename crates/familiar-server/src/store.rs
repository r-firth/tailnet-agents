//! Vecgra is the only database. Every record is a node carrying its JSON
//! document plus a few indexed properties; relationships carry the graph
//! (HAS_EVENT, NEXT, SHOWS, SUPPORTED_BY, SUPERSEDES, ABOUT, LEARNED_FROM …).
//! The store keeps an in-memory copy of each node's properties so a node can
//! be rewritten (vecgra updates replace the whole record) when its JSON
//! changes or when its embedding arrives.
use anyhow::{Context, Result};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use vecgra::{Database, DatabaseOptions, Direction, EdgeFilter, ElementRef, Value as V, VectorTarget};

pub const DIMENSIONS: usize = 3072;

#[derive(Clone)]
struct NodeRec {
    label: String,
    props: Vec<(String, V)>,
    vector: Option<Vec<f32>>,
}

pub struct Store {
    db: Database,
    pub dir: PathBuf,
    keys: HashMap<String, u64>,
    nodes: HashMap<u64, NodeRec>,
}

pub struct Loaded {
    pub label: String,
    pub id: u64,
    pub json: serde_json::Value,
    pub has_vector: bool,
}

impl Store {
    pub fn open(dir: &Path) -> Result<(Self, Vec<Loaded>)> {
        std::fs::create_dir_all(dir)?;
        for sub in ["artifacts", "recordings", "terminal", "machines"] {
            std::fs::create_dir_all(dir.join(sub))?;
        }
        let path = dir.join("memory.vg");
        let db = if path.exists() {
            Database::open(&path).with_context(|| format!("opening {}", path.display()))?
        } else {
            Database::create(&path, DatabaseOptions::new(DIMENSIONS))?
        };
        anyhow::ensure!(
            db.vector_dimension() == DIMENSIONS,
            "memory.vg has dimension {}, expected {DIMENSIONS}",
            db.vector_dimension()
        );
        let mut keys = HashMap::new();
        let mut nodes = HashMap::new();
        let mut loaded = Vec::new();
        {
            let read = db.read();
            for id in read.node_ids() {
                let Some(node) = read.node(id) else { continue };
                let label = read.symbol(node.label).unwrap_or("").to_owned();
                let props: Vec<(String, V)> = node
                    .properties
                    .iter()
                    .map(|p| (read.symbol(p.key).unwrap_or("").to_owned(), p.value.clone()))
                    .collect();
                let vector = if node.vector_count > 0 {
                    read.node_vector_owned(id, 0).ok().flatten()
                } else {
                    None
                };
                let mut json = serde_json::Value::Null;
                for (k, v) in &props {
                    match (k.as_str(), v) {
                        ("key", V::String(s)) => {
                            keys.insert(s.to_string(), id);
                        }
                        ("json", V::String(s)) => {
                            json = serde_json::from_str(s).unwrap_or(serde_json::Value::Null);
                        }
                        _ => {}
                    }
                }
                loaded.push(Loaded { label: label.clone(), id, json, has_vector: vector.is_some() });
                nodes.insert(id, NodeRec { label, props, vector });
            }
        }
        loaded.sort_by_key(|l| l.id);
        Ok((Self { db, dir: dir.to_owned(), keys, nodes }, loaded))
    }

    pub fn id_of(&self, key: &str) -> Option<u64> {
        self.keys.get(key).copied()
    }

    /// Create or replace the node stored under `key`.
    pub fn put<T: Serialize>(
        &mut self,
        label: &str,
        key: &str,
        doc: &T,
        extra: &[(&str, V)],
    ) -> Result<u64> {
        let json = serde_json::to_string(doc)?;
        let mut props: Vec<(String, V)> = vec![
            ("key".into(), V::String(Arc::from(key))),
            ("json".into(), V::String(Arc::from(json))),
        ];
        for (k, v) in extra {
            props.push(((*k).to_owned(), v.clone()));
        }
        let mut tx = self.db.transaction();
        let id = if let Some(id) = self.keys.get(key).copied() {
            let vector = self.nodes.get(&id).and_then(|n| n.vector.clone());
            let vectors: Vec<Vec<f32>> = vector.into_iter().collect();
            tx.update_node(id, label, props.clone(), &vectors)?;
            id
        } else {
            tx.create_node(label, props.clone(), &[])
        };
        tx.commit()?;
        let vector = self.nodes.get(&id).and_then(|n| n.vector.clone());
        self.keys.insert(key.to_owned(), id);
        self.nodes.insert(id, NodeRec { label: label.to_owned(), props, vector });
        Ok(id)
    }

    /// Append a keyless node (events) whose JSON is rewritten via `rewrite`.
    pub fn append<T: Serialize>(&mut self, label: &str, doc: &T, extra: &[(&str, V)], edges: &[(u64, &str, bool)]) -> Result<u64> {
        let json = serde_json::to_string(doc)?;
        let mut props: Vec<(String, V)> = vec![("json".into(), V::String(Arc::from(json)))];
        for (k, v) in extra {
            props.push(((*k).to_owned(), v.clone()));
        }
        let mut tx = self.db.transaction();
        let id = tx.create_node(label, props.clone(), &[]);
        for (other, edge_label, outgoing_from_other) in edges {
            let (s, t) = if *outgoing_from_other { (*other, id) } else { (id, *other) };
            tx.create_edge(s, t, *edge_label, std::iter::empty::<(&str, V)>(), &[]);
        }
        tx.commit()?;
        self.nodes.insert(id, NodeRec { label: label.to_owned(), props, vector: None });
        Ok(id)
    }

    /// Replace the JSON document of an existing node (by id).
    pub fn rewrite<T: Serialize>(&mut self, id: u64, doc: &T) -> Result<()> {
        let Some(rec) = self.nodes.get(&id).cloned() else { anyhow::bail!("node {id} missing") };
        let json = serde_json::to_string(doc)?;
        let props: Vec<(String, V)> = rec
            .props
            .iter()
            .map(|(k, v)| if k == "json" { (k.clone(), V::String(Arc::from(json.as_str()))) } else { (k.clone(), v.clone()) })
            .collect();
        let vectors: Vec<Vec<f32>> = rec.vector.clone().into_iter().collect();
        let mut tx = self.db.transaction();
        tx.update_node(id, rec.label.clone(), props.clone(), &vectors)?;
        tx.commit()?;
        self.nodes.insert(id, NodeRec { label: rec.label, props, vector: rec.vector });
        Ok(())
    }

    pub fn edge(&mut self, source: u64, target: u64, label: &str) -> Result<()> {
        let mut tx = self.db.transaction();
        tx.create_edge(source, target, label, std::iter::empty::<(&str, V)>(), &[]);
        tx.commit()?;
        Ok(())
    }

    pub fn set_vectors(&mut self, vectors: Vec<(u64, Vec<f32>)>) -> Result<()> {
        let mut tx = self.db.transaction();
        let mut applied = Vec::new();
        for (id, vector) in vectors {
            let Some(rec) = self.nodes.get(&id) else { continue };
            if vector.len() != DIMENSIONS {
                continue;
            }
            tx.update_node(id, rec.label.clone(), rec.props.clone(), std::slice::from_ref(&vector))?;
            applied.push((id, vector));
        }
        tx.commit()?;
        for (id, vector) in applied {
            if let Some(rec) = self.nodes.get_mut(&id) {
                rec.vector = Some(vector);
            }
        }
        Ok(())
    }

    /// Drop every vector (embedding model changed). Records stay put.
    pub fn clear_vectors(&mut self) -> Result<()> {
        let ids: Vec<u64> = self.nodes.iter().filter(|(_, r)| r.vector.is_some()).map(|(id, _)| *id).collect();
        if ids.is_empty() {
            return Ok(());
        }
        let mut tx = self.db.transaction();
        for id in &ids {
            let rec = &self.nodes[id];
            tx.update_node(*id, rec.label.clone(), rec.props.clone(), &[])?;
        }
        tx.commit()?;
        for id in ids {
            if let Some(rec) = self.nodes.get_mut(&id) {
                rec.vector = None;
            }
        }
        Ok(())
    }

    pub fn has_vector(&self, id: u64) -> bool {
        self.nodes.get(&id).is_some_and(|r| r.vector.is_some())
    }

    pub fn label(&self, id: u64) -> Option<&str> {
        self.nodes.get(&id).map(|r| r.label.as_str())
    }

    pub fn doc<T: DeserializeOwned>(&self, id: u64) -> Option<T> {
        let rec = self.nodes.get(&id)?;
        rec.props.iter().find_map(|(k, v)| match (k.as_str(), v) {
            ("json", V::String(s)) => serde_json::from_str(s).ok(),
            _ => None,
        })
    }

    /// Exact vector search, optionally restricted to one label.
    pub fn search(&self, query: &[f32], labels: &[&str], limit: usize) -> Result<Vec<(u64, f32)>> {
        let read = self.db.read();
        let mut out = Vec::new();
        if labels.is_empty() {
            for hit in read.vector_search(query, VectorTarget::Nodes, limit, None)? {
                if let ElementRef::Node(id) = hit.element {
                    out.push((id, hit.score));
                }
            }
        } else {
            for label in labels {
                let Some(label_id) = read.label_id(label) else { continue };
                for hit in read.vector_search(query, VectorTarget::Nodes, limit, Some(label_id))? {
                    if let ElementRef::Node(id) = hit.element {
                        out.push((id, hit.score));
                    }
                }
            }
            out.sort_by(|a, b| b.1.total_cmp(&a.1));
            out.truncate(limit);
        }
        Ok(out)
    }

    /// Neighbouring node ids with the relationship label, both directions.
    pub fn neighbours(&self, id: u64) -> Vec<(u64, String, bool)> {
        let read = self.db.read();
        let mut out = Vec::new();
        for (direction, outgoing) in [(Direction::Outgoing, true), (Direction::Incoming, false)] {
            if let Ok(edges) = read.neighbors(id, direction, EdgeFilter { label: None }) {
                for e in edges {
                    let other = if outgoing { e.target } else { e.source };
                    out.push((other, read.symbol(e.label).unwrap_or("").to_owned(), outgoing));
                }
            }
        }
        out
    }

    pub fn stats(&self) -> serde_json::Value {
        let s = self.db.read().stats();
        serde_json::json!({"nodes": s.nodes, "edges": s.edges, "vectors": s.indexed_vectors, "transactions": s.transactions})
    }

    pub fn node_count(&self) -> usize {
        self.db.read().stats().nodes
    }
}
