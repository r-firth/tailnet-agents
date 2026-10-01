//! Familiar: the always-on coordinator. Serves the Desk web UI and API,
//! talks to Telegram, owns the Vecgra memory and drives agent machines.
mod api;
mod consolidate;
mod coordinator;
mod devices;
mod embed;
mod hub;
mod launcher;
mod model;
mod store;
mod telegram;

use anyhow::Result;
use std::path::PathBuf;

fn load_env_file(path: &str) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim().trim_matches('"').trim_matches('\'');
            if std::env::var_os(k).is_none() && !v.is_empty() {
                // SAFETY-free: set before any threads start.
                unsafe { std::env::set_var(k, v) };
            }
        }
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let env_file = args.windows(2).find(|w| w[0] == "--env").map(|w| w[1].clone()).unwrap_or_else(|| ".env".into());
    load_env_file(&env_file);
    if args.iter().any(|a| a == "--demo") {
        unsafe { std::env::set_var("FAMILIAR_DEMO", "1") };
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run())
}

async fn run() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "familiar=info,warn".into())).init();
    let port: u16 = std::env::var("FAMILIAR_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4400);
    let host = std::env::var("FAMILIAR_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let data_dir = PathBuf::from(std::env::var("FAMILIAR_DATA_DIR").unwrap_or_else(|_| "data".into()));
    std::fs::create_dir_all(&data_dir)?;
    let machine_token = std::env::var("FAMILIAR_MACHINE_TOKEN").ok().filter(|t| !t.is_empty()).unwrap_or_else(|| {
        // Persist a generated token so machines survive restarts.
        let path = data_dir.join("machine-token");
        std::fs::read_to_string(&path).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).unwrap_or_else(|| {
            let t: String = (0..32).map(|_| format!("{:x}", rand::random::<u8>() % 16)).collect();
            std::fs::write(&path, &t).ok();
            t
        })
    });
    let token = std::env::var("FAMILIAR_TOKEN").ok().filter(|t| !t.is_empty());
    if token.is_none() && host != "127.0.0.1" && host != "localhost" {
        anyhow::bail!("FAMILIAR_TOKEN is required when listening on {host}");
    }
    let demo = std::env::var("FAMILIAR_DEMO").is_ok_and(|v| v == "1" || v == "true");
    let cfg = hub::Config {
        data_dir: data_dir.clone(),
        port,
        token,
        machine_token: machine_token.clone(),
        public_url: std::env::var("FAMILIAR_PUBLIC_URL").ok().map(|u| u.trim_end_matches('/').to_owned()),
        demo,
    };
    let embedder = embed::Embedder::from_env();
    let launcher = launcher::Launcher::from_env(data_dir.clone(), port, machine_token);
    let (hub, rx) = hub::Hub::open(cfg, embedder, launcher.clone())?;
    let coordinator = coordinator::Coordinator::from_env();
    *hub.coordinator_label.lock().unwrap() = coordinator.label();
    tracing::info!("coordinator: {} · embeddings: {} · demo: {demo}", coordinator.label(), hub.embedder.label());

    tokio::spawn(hub::embed_worker(hub.clone(), rx.embed));
    tokio::spawn(coordinator.run(hub.clone(), rx.inbox));
    match telegram::Telegram::from_env() {
        Some(tg) => {
            tracing::info!("telegram: polling");
            tokio::spawn(telegram::run(hub.clone(), tg, rx.tg));
        }
        None => {
            // Drain so senders never block or grow.
            let mut tg_rx = rx.tg;
            tokio::spawn(async move { while tg_rx.recv().await.is_some() {} });
        }
    }
    {
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                every.tick().await;
                hub.tick();
            }
        });
    }
    // Keep the tailnet's devices fresh, like tailnet-agents' discovery loop.
    {
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                every.tick().await;
                match devices::snapshot().await {
                    Ok(d) => hub.set_devices(d),
                    Err(e) => tracing::debug!("tailnet discovery: {e:#}"),
                }
            }
        });
    }
    // Wake the personal machine up front so the first task starts fast.
    if std::env::var("FAMILIAR_START_MACHINE").map(|v| v != "0").unwrap_or(true) && std::env::var("FAMILIAR_MACHINE_BACKEND").map(|b| b != "manual").unwrap_or(true) {
        let hub2 = hub.clone();
        tokio::spawn(async move {
            if let Err(e) = hub2.launcher.start(&hub2, &hub2.launcher.personal_id(), None).await {
                tracing::warn!("personal machine not started: {e:#}");
            }
        });
    }

    let web_dir = PathBuf::from(std::env::var("FAMILIAR_WEB_DIR").unwrap_or_else(|_| "web/dist".into()));
    let app = api::router(hub.clone(), web_dir);
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    tracing::info!("Familiar on http://{host}:{port}");
    let shutdown = async {
        tokio::signal::ctrl_c().await.ok();
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;
    launcher.stop_all().await;
    Ok(())
}
