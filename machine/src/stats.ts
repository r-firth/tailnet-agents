import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function cpuTimes(): { idle: number; total: number } {
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (n[3] ?? 0) + (n[4] ?? 0);
    return { idle, total: n.reduce((a, b) => a + b, 0) };
  } catch {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
    }
    return { idle, total };
  }
}

function netBytes(): number {
  try {
    return fs
      .readFileSync("/proc/net/dev", "utf8")
      .split("\n")
      .slice(2)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("lo:"))
      .reduce((sum, l) => {
        const f = l.split(/[:\s]+/);
        return sum + Number(f[1] ?? 0) + Number(f[9] ?? 0);
      }, 0);
  } catch {
    return 0;
  }
}

function memUsedBytes(): number {
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8");
    const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(m)?.[1] ?? 0) * 1024;
    return get("MemTotal") - get("MemAvailable");
  } catch {
    return os.totalmem() - os.freemem();
  }
}

export class Stats {
  private prevCpu = cpuTimes();
  private prevNet = netBytes();
  private prevAt = Date.now();
  private started = Date.now();

  sample() {
    const cpu = cpuTimes();
    const net = netBytes();
    const now = Date.now();
    const dt = Math.max(0.001, (now - this.prevAt) / 1000);
    const dTotal = cpu.total - this.prevCpu.total;
    const cpuPct = dTotal > 0 ? (1 - (cpu.idle - this.prevCpu.idle) / dTotal) * 100 : 0;
    const netMbs = Math.max(0, net - this.prevNet) / dt / 1e6;
    this.prevCpu = cpu;
    this.prevNet = net;
    this.prevAt = now;
    return {
      cpu_pct: Math.round(Math.max(0, Math.min(100, cpuPct))),
      mem_gb: Math.round((memUsedBytes() / 1e9) * 10) / 10,
      net_mbs: Math.round(netMbs * 10) / 10,
      uptime_s: Math.round((now - this.started) / 1000),
    };
  }
}

export function specs(home: string) {
  let disk = 0;
  try {
    const s = fs.statfsSync(home);
    disk = (s.blocks * s.bsize) / 1e9;
  } catch {
    /* ignore */
  }
  return { cpu: os.cpus().length, mem_gb: Math.round((os.totalmem() / 1e9) * 10) / 10, disk_gb: Math.round(disk) };
}

/**
 * Things installed under <home>/opt. Each install is a directory with a VERSION file
 * (first line, e.g. "blender 4.5.3") or just a directory name.
 */
export function scanInstalls(home: string): string[] {
  const opt = path.join(home, "opt");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(opt, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "bin").map((d) => d.name).sort();
  } catch {
    return [];
  }
  return dirs.map((d) => {
    let v = "";
    try {
      v = fs.readFileSync(path.join(opt, d, "VERSION"), "utf8").split("\n")[0].trim();
    } catch {
      /* no version file */
    }
    return `${v || d} (~/opt/${d})`;
  });
}
