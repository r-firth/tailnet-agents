//! Rebuildable read index and bounded views over the actual Vecgra graph.
use crate::store::{Event, Store};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use vecgra::{Direction, EdgeFilter, ElementRef, Value as V, VectorTarget};

#[derive(Default)]
pub struct MemoryIndex {
    pub by_id: HashMap<u64, usize>,
    pub by_scope: HashMap<String, Vec<usize>>,
    titles: HashMap<String, String>,
    texts: Vec<String>,
    postings: HashMap<[u8; 3], Vec<usize>>,
    run_for: HashMap<u64, u64>,
    runs: HashMap<u64, Vec<usize>>,
    current: HashMap<String, u64>,
}
fn transport(kind: &str) -> bool {
    matches!(
        kind,
        "message.started" | "message.delta" | "tool.output" | "agent.status"
    )
}
pub fn category(kind: &str) -> &'static str {
    if kind.starts_with("message.") {
        "message"
    } else if kind.starts_with("tool.") {
        "tool"
    } else if kind.starts_with("terminal.") || kind.starts_with("session.") {
        "terminal"
    } else {
        "system"
    }
}
fn text_of(e: &Event) -> String {
    if let Some(text) = e.payload["text"].as_str() {
        return text.into();
    }
    if let Some(delta) = e.payload["delta"].as_str() {
        return delta.into();
    }
    let mut payload = e.payload.clone();
    if let Some(p) = payload.as_object_mut() {
        p.remove("bytes");
    }
    serde_json::to_string(&payload).unwrap_or_default()
}
fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}
impl MemoryIndex {
    pub fn add(&mut self, event: &Event, position: usize) {
        self.by_id.insert(event.id, position);
        let scope = self.by_scope.entry(event.scope.clone()).or_default();
        scope.push(position);
        if let Some(name) = event.payload["name"].as_str().filter(|_| {
            matches!(
                event.kind.as_str(),
                "chat.created" | "chat.renamed" | "session.created" | "device.saved"
            )
        }) {
            self.titles.insert(event.scope.clone(), name.into());
        }
        if event.kind == "message.user" || !self.current.contains_key(&event.scope) {
            self.current.insert(event.scope.clone(), event.id);
        }
        let run = self.current[&event.scope];
        self.run_for.insert(event.id, run);
        self.runs.entry(run).or_default().push(position);
        let text = text_of(event).to_lowercase();
        // The index contains searchable content, never terminal binary archives.
        let unique: HashSet<[u8; 3]> = text
            .as_bytes()
            .windows(3)
            .map(|w| [w[0], w[1], w[2]])
            .collect();
        for gram in unique {
            self.postings.entry(gram).or_default().push(position);
        }
        self.texts.push(text);
    }
    fn candidates(&self, query: &str) -> Vec<usize> {
        let grams: Vec<[u8; 3]> = query
            .split_whitespace()
            .flat_map(|t| t.as_bytes().windows(3).map(|w| [w[0], w[1], w[2]]))
            .collect();
        if grams.iter().any(|g| !self.postings.contains_key(g)) {
            return Vec::new();
        }
        if let Some(shortest) = grams
            .iter()
            .filter_map(|g| self.postings.get(g))
            .min_by_key(|p| p.len())
        {
            shortest
                .iter()
                .rev()
                .copied()
                .filter(|i| {
                    grams
                        .iter()
                        .all(|g| self.postings[g].binary_search(i).is_ok())
                })
                .collect()
        } else {
            (0..self.texts.len()).rev().collect()
        }
    }
}
impl Store {
    fn memory_event(&self, id: u64) -> Option<&Event> {
        self.memory.by_id.get(&id).map(|&i| &self.events[i])
    }
    fn scope_title(&self, scope: &str) -> String {
        self.memory
            .titles
            .get(scope)
            .cloned()
            .unwrap_or_else(|| scope.into())
    }
    fn memory_node(&self, id: u64) -> Option<Value> {
        let read = self.db.read();
        let node = read.node(id)?;
        let label = read.symbol(node.label).unwrap_or("Node");
        if let Some(e) = self.memory_event(id) {
            let title = match e.kind.as_str() {
                "message.user" => "You".into(),
                "message.assistant" => "Coordinator".into(),
                "tool.started" | "tool.result" => e.payload["name"]
                    .as_str()
                    .unwrap_or("Tool")
                    .replace('_', " "),
                _ => e.kind.replace(['.', '_'], " "),
            };
            Some(
                json!({"id":id,"label":label,"kind":e.kind,"category":category(&e.kind),"title":title,"scope":e.scope,"scope_name":self.scope_title(&e.scope),"time":e.time,"run_id":self.memory.run_for.get(&id),"excerpt":clip(&text_of(e),240),"vectors":node.vector_count}),
            )
        } else {
            let scope = node
                .properties
                .iter()
                .find_map(|p| {
                    if read.symbol(p.key) == Some("scope_id") {
                        if let V::String(s) = &p.value {
                            Some(s.as_ref())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                })
                .unwrap_or("");
            Some(
                json!({"id":id,"label":label,"kind":"scope","category":"scope","scope":scope,"scope_name":self.scope_title(scope),"title":self.scope_title(scope),"excerpt":"","vectors":node.vector_count}),
            )
        }
    }
    pub fn memory_search(
        &self,
        query: &str,
        kind: &str,
        offset: usize,
        vector: Option<&[f32]>,
    ) -> Result<Value> {
        let query = query.trim().to_lowercase();
        let tokens: Vec<_> = query.split_whitespace().collect();
        let accepts = |e: &Event| {
            (!transport(&e.kind) || kind == "raw")
                && (kind == "all" || kind == "raw" || category(&e.kind) == kind)
        };
        // Lexical results already arrive newest-first from the postings index.
        // Avoid sorting or hashing the entire archive for the common text path.
        let lexical: Vec<_> = self
            .memory
            .candidates(&query)
            .into_iter()
            .filter(|&i| {
                accepts(&self.events[i]) && tokens.iter().all(|t| self.memory.texts[i].contains(t))
            })
            .map(|i| (i, 1.0_f32))
            .collect();
        let ranked = if let Some(v) = vector {
            let mut ranked: HashMap<usize, f32> = lexical.into_iter().collect();
            for hit in self
                .db
                .read()
                .vector_search(v, VectorTarget::Nodes, 120, None)?
            {
                if let ElementRef::Node(id) = hit.element
                    && let Some(&i) = self.memory.by_id.get(&id)
                    && accepts(&self.events[i])
                {
                    *ranked.entry(i).or_default() += hit.score.max(0.0);
                }
            }
            let mut ranked: Vec<_> = ranked.into_iter().collect();
            ranked.sort_unstable_by(|(a, sa), (b, sb)| sb.total_cmp(sa).then(b.cmp(a)));
            ranked
        } else {
            lexical
        };
        let total = ranked.len();
        let hits: Vec<_> = ranked
            .into_iter()
            .skip(offset)
            .take(40)
            .filter_map(|(i, score)| {
                let e = &self.events[i];
                let mut node = self.memory_node(e.id)?;
                let text = text_of(e);
                let lower = text.to_lowercase();
                let start = tokens.first().and_then(|t| lower.find(t)).unwrap_or(0);
                // Byte positions from lowercasing may differ; clip on UTF-8 boundaries.
                let start = text
                    .char_indices()
                    .map(|(i, _)| i)
                    .take_while(|i| *i <= start.saturating_sub(60))
                    .last()
                    .unwrap_or(0);
                let start = text[..start]
                    .rfind(char::is_whitespace)
                    .map(|i| i + text[i..].chars().next().unwrap().len_utf8())
                    .filter(|&i| start - i < 40)
                    .unwrap_or(start);
                let excerpt = clip(&text[start..], 260);
                node["excerpt"] = json!(format!(
                    "{}{}{}",
                    if start > 0 { "… " } else { "" },
                    excerpt,
                    if start + excerpt.len() < text.len() {
                        " …"
                    } else {
                        ""
                    }
                ));
                node["score"] = json!(score);
                Some(node)
            })
            .collect();
        let next = offset.saturating_add(40);
        Ok(json!({
            "hits": hits,
            "total": total,
            "next_offset": (next < total).then_some(next),
            "semantic": vector.is_some(),
        }))
    }
    pub fn memory_graph(&self, focus: Option<u64>, offset: usize) -> Result<Value> {
        let mut ids = HashSet::new();
        let mut total_context = 0;
        if let Some(id) = focus {
            let read = self.db.read();
            let node = read.node(id).context("Node not found")?;
            ids.insert(id);
            if let Some(scope) = self
                .scopes
                .iter()
                .find_map(|(s, &node)| if node == id { Some(s) } else { None })
            {
                if let Some(positions) = self.memory.by_scope.get(scope) {
                    total_context = positions.len();
                    ids.extend(
                        positions
                            .iter()
                            .rev()
                            .skip(offset)
                            .take(100)
                            .map(|&i| self.events[i].id),
                    );
                }
            } else if let Some(e) = self.memory_event(node.id) {
                if let Some(&root) = self.scopes.get(&e.scope) {
                    ids.insert(root);
                }
                let positions = &self.memory.by_scope[&e.scope];
                let p = positions
                    .binary_search(&self.memory.by_id[&id])
                    .unwrap_or(0);
                ids.extend(
                    positions[p.saturating_sub(12)..(p + 13).min(positions.len())]
                        .iter()
                        .map(|&i| self.events[i].id),
                );
                total_context = positions.len();
            }
        } else {
            let mut scopes: Vec<_> = self.memory.by_scope.iter().collect();
            scopes.sort_unstable_by_key(|(_, events)| {
                std::cmp::Reverse(events.last().copied().unwrap_or(0))
            });
            total_context = scopes.len();
            for (scope, positions) in scopes.into_iter().skip(offset).take(12) {
                if let Some(&id) = self.scopes.get(scope) {
                    ids.insert(id);
                }
                ids.extend(
                    positions
                        .iter()
                        .rev()
                        .filter(|&&i| !transport(&self.events[i].kind))
                        .take(12)
                        .map(|&i| self.events[i].id),
                );
            }
        }
        let read = self.db.read();
        let mut edges = HashMap::new();
        // Event adjacency is small (scope membership plus chronology). Reading
        // it from both directions avoids expanding every high-degree scope.
        for &id in &ids {
            if self.memory.by_id.contains_key(&id) {
                read.visit_neighbors(id,Direction::Both,EdgeFilter::default(),|other,edge_id|{
                    if ids.contains(&other)
                        && let Some(e)=read.edge(edge_id) { edges.insert(edge_id,json!({"id":e.id,"source":e.source,"target":e.target,"label":read.symbol(e.label).unwrap_or("Edge")})); }
                })?;
            }
        }
        let stats = read.stats();
        drop(read);
        let mut nodes: Vec<_> = ids
            .into_iter()
            .filter_map(|id| self.memory_node(id))
            .collect();
        nodes.sort_by_key(|n| n["id"].as_u64());
        let mut edges: Vec<_> = edges.into_values().collect();
        edges.sort_by_key(|e| e["id"].as_u64());
        let step = if focus.is_some() { 100 } else { 12 };
        let next = offset.saturating_add(step);
        let more =
            focus.is_none_or(|id| !self.memory.by_id.contains_key(&id)) && next < total_context;
        Ok(json!({
            "nodes": nodes,
            "edges": edges,
            "focus": focus,
            "offset": offset,
            "context_total": total_context,
            "next_offset": more.then_some(next),
            "stats": {
                "nodes": stats.nodes,
                "edges": stats.edges,
                "vectors": stats.indexed_vectors,
                "runs": self.memory.runs.len(),
            },
        }))
    }
    pub fn memory_element(&self, kind: &str, id: u64) -> Result<Value> {
        let summary = if kind == "node" {
            self.memory_node(id)
        } else {
            None
        };
        let read = self.db.read();
        let (properties, vector, mut result) = match kind {
            "node" => {
                let n = read.node(id).context("Node not found")?;
                (
                    n.properties.clone(),
                    read.node_vector_owned(id, 0)?,
                    summary.context("Node not found")?,
                )
            }
            "edge" => {
                let e = read.edge(id).context("Relationship not found")?;
                (
                    e.properties.clone(),
                    read.edge_vector_owned(id, 0)?,
                    json!({"id":id,"label":read.symbol(e.label),"source":e.source,"target":e.target,"vectors":e.vector_count}),
                )
            }
            _ => bail!("Unknown element kind"),
        };
        let mut values = serde_json::Map::new();
        for p in properties.iter() {
            let value = match &p.value {
                V::Null => Value::Null,
                V::Bool(v) => json!(v),
                V::Int(v) => json!(v),
                V::Float(v) => json!(v),
                V::String(v) => {
                    if read.symbol(p.key) == Some("event") {
                        serde_json::from_str(v).unwrap_or_else(|_| json!(v.to_string()))
                    } else {
                        json!(v.to_string())
                    }
                }
                V::Bytes(v) => json!({"bytes":v.len()}),
                V::Node(v) => json!({"node":v}),
                V::Edge(v) => json!({"edge":v}),
            };
            values.insert(read.symbol(p.key).unwrap_or("property").into(), value);
        }
        result["properties"] = json!(values);
        result["vector"] = json!(vector);
        if kind == "node" {
            let mut neighbors = Vec::new();
            let mut degree = 0;
            read.visit_neighbors(id,Direction::Both,EdgeFilter::default(),|other,edge|{
                degree+=1;
                if neighbors.len()<40 && let Some(e)=read.edge(edge) {neighbors.push(json!({"id":edge,"node":other,"label":read.symbol(e.label),"direction":if e.source==id {"out"}else{"in"}}));}
            })?;
            result["neighbors"] = json!(neighbors);
            result["degree"] = json!(degree);
        }
        Ok(result)
    }
    pub fn memory_run(&self, id: u64, anchor: Option<u64>, offset: Option<usize>) -> Result<Value> {
        let positions = self.memory.runs.get(&id).context("Run not found")?;
        let first = &self.events[positions[0]];
        let visible: Vec<_> = positions
            .iter()
            .copied()
            .filter(|&i| !transport(&self.events[i].kind) || Some(self.events[i].id) == anchor)
            .collect();
        let start = offset.unwrap_or_else(|| {
            anchor
                .and_then(|a| visible.iter().position(|&i| self.events[i].id == a))
                .map(|i| i.saturating_sub(5))
                .unwrap_or(0)
        });
        let events: Vec<_> = visible
            .iter()
            .skip(start)
            .take(80)
            .map(|&i| {
                let mut e = self.events[i].clone();
                if let Some(p) = e.payload.as_object_mut() {
                    p.remove("bytes");
                }
                e
            })
            .collect();
        let scope = &self.memory.by_scope[&first.scope];
        let mut runs: Vec<_> = scope
            .iter()
            .filter_map(|&i| self.memory.run_for.get(&self.events[i].id).copied())
            .collect();
        runs.dedup();
        let index = runs.iter().position(|&r| r == id).unwrap_or(0);
        let status = if positions
            .iter()
            .any(|&i| self.events[i].kind == "agent.error")
        {
            "Failed"
        } else if positions
            .iter()
            .any(|&i| self.events[i].kind == "agent.stopped")
        {
            "Stopped"
        } else if positions
            .iter()
            .any(|&i| self.events[i].kind == "agent.finished")
        {
            "Complete"
        } else {
            "Recorded"
        };
        let next = start.saturating_add(80);
        Ok(json!({
            "id": id,
            "scope": first.scope,
            "name": self.scope_title(&first.scope),
            "prompt": clip(&text_of(first), 200),
            "time": first.time,
            "status": status,
            "events": events,
            "total": visible.len(),
            "offset": start,
            "next_offset": (next < visible.len()).then_some(next),
            "previous_offset": (start > 0).then_some(start.saturating_sub(80)),
            "previous_run": index.checked_sub(1).map(|i| runs[i]),
            "next_run": runs.get(index + 1),
        }))
    }
}
