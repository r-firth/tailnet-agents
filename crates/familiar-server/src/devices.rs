//! Your tailnet's devices, found the way tailnet-agents finds them: `tailscale status --json`,
//! skipping Mullvad exit nodes and shared-in nodes. A device with Tailscale SSH (advertised host
//! keys, or an SSH greeting on port 22) is one a run can work on with `ssh <name>`.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::time::timeout;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

fn tailnet_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]),
        IpAddr::V6(v) => v.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

/// The devices in a `tailscale status --json` document, sorted by name.
pub fn parse(value: &Value) -> Result<Vec<Value>> {
    if text(value, "BackendState") != "Running" {
        bail!("Tailscale is not connected");
    }
    let peers = value["Peer"].as_object().context("Tailscale returned no network map")?;
    let mut out = Vec::new();
    for p in peers.values() {
        let dns = text(p, "DNSName").trim_end_matches('.');
        if text(p, "ID").is_empty() || p["ShareeNode"].as_bool() == Some(true) || dns.ends_with(".mullvad.ts.net") {
            continue;
        }
        let ips: Vec<String> = p["TailscaleIPs"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).filter(|s| s.parse::<IpAddr>().is_ok_and(|ip| tailnet_ip(&ip))).map(str::to_owned).collect();
        let name = dns.split('.').next().filter(|s| !s.is_empty()).map(str::to_owned).or_else(|| ips.first().cloned());
        let Some(name) = name else { continue };
        out.push(json!({
            "name": name,
            "host": text(p, "HostName"),
            "dns": dns,
            "os": text(p, "OS"),
            "online": p["Online"].as_bool().unwrap_or(false),
            "ssh": p["sshHostKeys"].as_array().is_some_and(|k| !k.is_empty()),
            "ips": ips,
        }));
    }
    out.sort_by(|a, b| text(a, "name").cmp(text(b, "name")));
    Ok(out)
}

/// Read only the SSH server's greeting; never send anything.
async fn ssh_banner(addr: SocketAddr) -> bool {
    timeout(Duration::from_millis(1500), async {
        let stream = TcpStream::connect(addr).await.ok()?;
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        (&mut reader).take(512).read_until(b'\n', &mut line).await.ok()?;
        line.starts_with(b"SSH-").then_some(())
    })
    .await
    .ok()
    .flatten()
    .is_some()
}

pub async fn snapshot() -> Result<Vec<Value>> {
    let bins = std::env::var("FAMILIAR_TAILSCALE_BIN").map(|b| vec![b]).unwrap_or_else(|_| vec!["tailscale".into(), "/Applications/Tailscale.app/Contents/MacOS/Tailscale".into()]);
    let mut doc = None;
    for bin in bins {
        if let Ok(Ok(out)) = timeout(Duration::from_secs(5), Command::new(&bin).args(["status", "--json"]).kill_on_drop(true).output()).await {
            if out.status.success() {
                doc = Some(serde_json::from_slice::<Value>(&out.stdout)?);
                break;
            }
        }
    }
    let mut devices = parse(&doc.context("Tailscale isn't available on this host")?)?;
    for d in devices.iter_mut().filter(|d| d["online"] == true && d["ssh"] != true) {
        for ip in d["ips"].as_array().cloned().unwrap_or_default() {
            if let Some(ip) = ip.as_str().and_then(|s| s.parse::<IpAddr>().ok()) {
                if ssh_banner(SocketAddr::new(ip, 22)).await {
                    d["ssh"] = json!(true);
                    break;
                }
            }
        }
    }
    Ok(devices)
}

/// For prompts: one line per device, SSH-able ones first.
pub fn describe(devices: &[Value]) -> String {
    if devices.is_empty() {
        return "none found (Tailscale isn't reachable from this host)".into();
    }
    let mut v: Vec<&Value> = devices.iter().collect();
    v.sort_by_key(|d| (d["ssh"] != true, d["online"] != true));
    v.iter()
        .map(|d| format!("- {} ({}{}, {})", text(d, "name"), if text(d, "os").is_empty() { "?" } else { text(d, "os") }, if d["ssh"] == true { ", Tailscale SSH" } else { "" }, if d["online"] == true { "online" } else { "offline" }))
        .collect::<Vec<_>>()
        .join("\n")
}
