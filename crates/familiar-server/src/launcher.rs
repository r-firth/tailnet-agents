//! Starting, forking, backing up and stopping machines. Every backend runs the
//! same `agentd`, which dials back to /api/machines/connect, so the rest of
//! the server never cares where a machine lives.
//!
//! - local: agentd as a child process with a persistent home under data/machines/<name>/home
//! - docker: the image in image/, home in a named volume
//! - ssh: your own box over Tailscale (agentd installed there)
//! - cloudflare: a Worker using the Sandbox SDK (cloudflare/), backup/restore via R2
use crate::hub::Hub;
use anyhow::{Context, Result, bail};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::process::{Child, Command};

#[derive(Clone)]
pub struct Launcher {
    inner: Arc<Inner>,
}

struct Inner {
    manual: bool,
    backend: String,
    personal: String,
    max_machines: usize,
    agentd_dir: PathBuf,
    data_dir: PathBuf,
    server_ws: String,
    machine_token: String,
    children: Mutex<HashMap<String, Child>>,
    starting: Mutex<HashSet<String>>,
    parents: Mutex<HashMap<String, String>>,
    fork_seq: Mutex<u32>,
    http: reqwest::Client,
}

impl Launcher {
    pub fn from_env(data_dir: PathBuf, port: u16, machine_token: String) -> Self {
        let server_ws = std::env::var("FAMILIAR_MACHINE_SERVER_URL").unwrap_or_else(|_| format!("ws://127.0.0.1:{port}"));
        Self {
            inner: Arc::new(Inner {
                manual: std::env::var("FAMILIAR_MACHINE_BACKEND").is_ok_and(|b| b == "manual"),
                backend: std::env::var("FAMILIAR_MACHINE_BACKEND").unwrap_or_else(|_| "local".into()),
                personal: std::env::var("FAMILIAR_MACHINE_NAME").unwrap_or_else(|_| "errands".into()),
                max_machines: std::env::var("FAMILIAR_MAX_MACHINES").ok().and_then(|v| v.parse().ok()).unwrap_or(3),
                agentd_dir: std::env::var("FAMILIAR_AGENTD_DIR").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("machine")),
                data_dir,
                server_ws,
                machine_token,
                children: Mutex::new(HashMap::new()),
                starting: Mutex::new(HashSet::new()),
                parents: Mutex::new(HashMap::new()),
                fork_seq: Mutex::new(0),
                http: reqwest::Client::new(),
            }),
        }
    }

    pub fn backends(&self) -> Vec<String> {
        let mut v = vec![self.inner.backend.clone()];
        if std::env::var("FAMILIAR_SSH_HOST").is_ok() && self.inner.backend != "ssh" {
            v.push("ssh".into());
        }
        v
    }

    pub fn personal_id(&self) -> String {
        format!("m_{}", self.inner.personal)
    }

    pub fn parent_of(&self, id: &str) -> Option<String> {
        self.inner.parents.lock().unwrap().get(id).cloned()
    }

    fn manual(&self) -> bool {
        self.inner.manual
    }

    #[cfg(test)]
    pub fn manual_for_tests(data_dir: PathBuf) -> Self {
        let l = Self::from_env(data_dir, 0, "t".into());
        let mut inner = Arc::try_unwrap(l.inner).ok().expect("fresh launcher");
        inner.manual = true;
        Self { inner: Arc::new(inner) }
    }

    /// Called when a task is queued and no idle machine is connected.
    pub async fn ensure_capacity(&self, hub: &Arc<Hub>, connected: usize) -> Result<()> {
        if self.manual() {
            return Ok(());
        }
        let personal = self.personal_id();
        let personal_up = hub.machine_links.lock().unwrap().contains_key(&personal);
        if !self.inner.starting.lock().unwrap().is_empty() {
            return Ok(()); // one launch at a time; dispatch runs again on connect
        }
        if !personal_up {
            return self.start(hub, &personal, None).await;
        }
        if connected >= self.inner.max_machines {
            bail!("all {} machines busy; the task stays queued", self.inner.max_machines);
        }
        let n = {
            let mut seq = self.inner.fork_seq.lock().unwrap();
            *seq += 1;
            *seq
        };
        let id = format!("{personal}-fork{n}");
        self.start(hub, &id, Some(personal)).await
    }

    pub async fn start(&self, hub: &Arc<Hub>, id: &str, fork_of: Option<String>) -> Result<()> {
        self.inner.starting.lock().unwrap().insert(id.to_owned());
        if let Some(p) = &fork_of {
            self.inner.parents.lock().unwrap().insert(id.to_owned(), p.clone());
        }
        let result = match self.inner.backend.as_str() {
            "local" => self.start_local(id, fork_of.as_deref()).await,
            "docker" => self.start_docker(id, fork_of.as_deref()).await,
            "ssh" => self.start_ssh(id).await,
            "cloudflare" => self.start_cloudflare(id, fork_of.as_deref()).await,
            other => Err(anyhow::anyhow!("unknown machine backend {other}")),
        };
        if let Err(e) = &result {
            tracing::warn!("starting {id} failed: {e:#}");
            hub.emit(json!({"type": "notice", "level": "error", "text": format!("Couldn't start machine {id}: {e}")}));
        }
        // Clear the launching flag once it connects or after a timeout.
        let inner = self.inner.clone();
        let id = id.to_owned();
        let hub = hub.clone();
        tokio::spawn(async move {
            for _ in 0..120 {
                if hub.machine_links.lock().unwrap().contains_key(&id) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            inner.starting.lock().unwrap().remove(&id);
            hub.dispatch();
        });
        result
    }

    fn name_of(id: &str) -> String {
        id.trim_start_matches("m_").to_owned()
    }

    fn home(&self, id: &str) -> PathBuf {
        self.inner.data_dir.join("machines").join(Self::name_of(id)).join("home")
    }

    async fn start_local(&self, id: &str, fork_of: Option<&str>) -> Result<()> {
        let home = self.home(id);
        if let Some(parent) = fork_of {
            // A fork starts from the parent's current home: same installs and logins.
            let src = self.home(parent);
            if home.exists() {
                tokio::fs::remove_dir_all(&home).await.ok();
            }
            tokio::fs::create_dir_all(home.parent().unwrap()).await?;
            let status = Command::new("cp").arg("-a").arg(&src).arg(&home).status().await?;
            if !status.success() {
                tokio::fs::create_dir_all(&home).await?;
            }
            // Chrome refuses a profile another process holds.
            for lock in ["SingletonLock", "SingletonCookie", "SingletonSocket"] {
                tokio::fs::remove_file(home.join(".config/familiar-chrome").join(lock)).await.ok();
            }
        }
        tokio::fs::create_dir_all(&home).await?;
        let main = self.inner.agentd_dir.join("dist/main.js");
        if !main.exists() {
            bail!("agentd is not built at {} (run: cd machine && npm install && npm run build)", main.display());
        }
        let log = std::fs::File::create(self.inner.data_dir.join("machines").join(format!("{}.log", Self::name_of(id))))?;
        let child = Command::new("node")
            .arg(&main)
            .args(["--server", &self.inner.server_ws, "--token", &self.inner.machine_token, "--id", id, "--name", &Self::name_of(id), "--backend", "local", "--home"])
            .arg(&home)
            .stdout(log.try_clone()?)
            .stderr(log)
            .kill_on_drop(true)
            .spawn()
            .context("spawning agentd")?;
        self.inner.children.lock().unwrap().insert(id.to_owned(), child);
        Ok(())
    }

    async fn start_docker(&self, id: &str, fork_of: Option<&str>) -> Result<()> {
        let name = Self::name_of(id);
        let volume = format!("familiar-{name}-home");
        let image = std::env::var("FAMILIAR_DOCKER_IMAGE").unwrap_or_else(|_| "familiar-machine:latest".into());
        if let Some(parent) = fork_of {
            let src = format!("familiar-{}-home", Self::name_of(parent));
            run("docker", &["volume", "create", &volume]).await?;
            run("docker", &["run", "--rm", "-v", &format!("{src}:/from"), "-v", &format!("{volume}:/to"), "alpine", "sh", "-c", "cp -a /from/. /to/ && rm -f /to/.config/familiar-chrome/Singleton*"]).await?;
        }
        run("docker", &["rm", "-f", &format!("familiar-{name}")]).await.ok();
        let server = self.inner.server_ws.replace("127.0.0.1", "host.docker.internal").replace("localhost", "host.docker.internal");
        let mut args = vec![
            "run".to_owned(), "-d".into(), "--name".into(), format!("familiar-{name}"),
            "--add-host".into(), "host.docker.internal:host-gateway".into(),
            "--shm-size".into(), "1g".into(),
            "-v".into(), format!("{volume}:/home/agent"),
            "-e".into(), format!("FAMILIAR_SERVER={server}"),
            "-e".into(), format!("FAMILIAR_MACHINE_TOKEN={}", self.inner.machine_token),
            "-e".into(), format!("FAMILIAR_MACHINE_ID={id}"),
            "-e".into(), format!("FAMILIAR_MACHINE_NAME={name}"),
            "-e".into(), "FAMILIAR_BACKEND=docker".into(),
            "-P".into(),
        ];
        for key in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] {
            if std::env::var(key).is_ok() {
                args.push("-e".into());
                args.push(key.into());
            }
        }
        args.push(image);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run("docker", &refs).await
    }

    async fn start_ssh(&self, id: &str) -> Result<()> {
        let host = std::env::var("FAMILIAR_SSH_HOST").context("set FAMILIAR_SSH_HOST (a tailnet host with agentd installed)")?;
        let dir = std::env::var("FAMILIAR_SSH_AGENTD_DIR").unwrap_or_else(|_| "~/familiar/machine".into());
        let server = std::env::var("FAMILIAR_PUBLIC_WS_URL").context("set FAMILIAR_PUBLIC_WS_URL to a ws:// URL your box can reach over Tailscale")?;
        let name = Self::name_of(id);
        let remote = format!(
            "cd {dir} && nohup node dist/main.js --server {server} --token {} --id {id} --name {name} --backend ssh --home ~/.familiar/{name} > ~/.familiar-{name}.log 2>&1 &",
            self.inner.machine_token
        );
        run("ssh", &[&host, &remote]).await
    }

    async fn cf(&self, path: &str, body: serde_json::Value) -> Result<()> {
        let base = std::env::var("FAMILIAR_CF_WORKER_URL").context("set FAMILIAR_CF_WORKER_URL to your deployed familiar-runner Worker")?;
        let token = std::env::var("FAMILIAR_CF_TOKEN").unwrap_or_default();
        let response = self.inner.http.post(format!("{base}{path}")).bearer_auth(token).json(&body).send().await?;
        if !response.status().is_success() {
            bail!("Cloudflare runner {}: {}", response.status(), response.text().await.unwrap_or_default());
        }
        Ok(())
    }

    async fn start_cloudflare(&self, id: &str, fork_of: Option<&str>) -> Result<()> {
        let server = std::env::var("FAMILIAR_PUBLIC_WS_URL").context("set FAMILIAR_PUBLIC_WS_URL to a wss:// URL the sandbox can reach")?;
        self.cf(&format!("/machines/{}/start", Self::name_of(id)), json!({"id": id, "server": server, "token": self.inner.machine_token, "fork_of": fork_of.map(Self::name_of)})).await
    }

    /// After every task: back up the personal machine, throw forks away.
    pub async fn after_task(&self, hub: &Arc<Hub>, id: &str) {
        if self.manual() {
            return;
        }
        let is_fork = self.parent_of(id).is_some();
        if is_fork {
            self.stop(hub, id).await.ok();
            return;
        }
        match self.backup(id).await {
            Ok(()) => hub.mark_backup(id),
            Err(e) => tracing::warn!("backup of {id} failed: {e:#}"),
        }
    }

    pub async fn backup(&self, id: &str) -> Result<()> {
        match self.inner.backend.as_str() {
            "local" => {
                let home = self.home(id);
                let dir = home.parent().unwrap().join("backups");
                tokio::fs::create_dir_all(&dir).await?;
                let file = dir.join(format!("{}.tar.gz", chrono::Utc::now().format("%Y%m%dT%H%M%S")));
                let status = Command::new("tar")
                    .args(["--exclude=./.cache", "--exclude=*/Cache", "--exclude=*/Code Cache", "--exclude=*/GPUCache", "--exclude=*/Singleton*", "-czf"])
                    .arg(&file)
                    .arg("-C")
                    .arg(&home)
                    .arg(".")
                    .status()
                    .await?;
                // tar exits 1 when files change while reading (Chrome is live); keep it.
                if !(status.success() || status.code() == Some(1)) {
                    bail!("tar failed");
                }
                // Keep the last five.
                let mut entries: Vec<_> = std::fs::read_dir(&dir)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
                entries.sort();
                while entries.len() > 5 {
                    std::fs::remove_file(entries.remove(0)).ok();
                }
                Ok(())
            }
            "docker" => {
                let name = Self::name_of(id);
                let dir = self.inner.data_dir.join("machines").join(&name).join("backups");
                std::fs::create_dir_all(&dir)?;
                let dir = std::fs::canonicalize(dir)?;
                let file = format!("{}.tar.gz", chrono::Utc::now().format("%Y%m%dT%H%M%S"));
                run("docker", &["run", "--rm", "-v", &format!("familiar-{name}-home:/home"), "-v", &format!("{}:/backup", dir.display()), "alpine", "tar", "--exclude=./.cache", "-czf", &format!("/backup/{file}"), "-C", "/home", "."]).await
            }
            "cloudflare" => self.cf(&format!("/machines/{}/backup", Self::name_of(id)), json!({})).await,
            _ => Ok(()),
        }
    }

    pub async fn stop(&self, hub: &Arc<Hub>, id: &str) -> Result<()> {
        hub.send_machine(id, json!({"type": "shutdown"}));
        let child = self.inner.children.lock().unwrap().remove(id);
        if let Some(mut child) = child {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            child.kill().await.ok();
        }
        match self.inner.backend.as_str() {
            "docker" => {
                run("docker", &["rm", "-f", &format!("familiar-{}", Self::name_of(id))]).await.ok();
                if self.parent_of(id).is_some() {
                    run("docker", &["volume", "rm", &format!("familiar-{}-home", Self::name_of(id))]).await.ok();
                }
            }
            "cloudflare" => {
                self.cf(&format!("/machines/{}/stop", Self::name_of(id)), json!({})).await.ok();
            }
            "local" => {
                if self.parent_of(id).is_some() {
                    tokio::fs::remove_dir_all(self.home(id).parent().unwrap()).await.ok();
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.inner.children.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let child = self.inner.children.lock().unwrap().remove(&id);
            if let Some(mut c) = child {
                c.kill().await.ok();
            }
        }
    }
}

async fn run(program: &str, args: &[&str]) -> Result<()> {
    let out = Command::new(program).args(args).output().await.with_context(|| format!("running {program}"))?;
    if !out.status.success() {
        bail!("{program} {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}
