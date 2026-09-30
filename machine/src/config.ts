import os from "node:os";
import path from "node:path";

export interface Config {
  server: string;
  token: string;
  id: string;
  name: string;
  backend: string;
  home: string;
  desktopUrl: string | null;
  hasDesktop: boolean;
  ownerName: string;
  scriptSpeed: number;
  defaultTimeCapS: number;
  executors: string[];
}

const HELP = `agentd - the Familiar in-machine daemon

Usage: agentd [options]

  --server <url>       Familiar server base, e.g. ws://127.0.0.1:4400   (FAMILIAR_SERVER)
  --token <token>      machine token                                   (FAMILIAR_MACHINE_TOKEN)
  --id <id>            machine id, e.g. m_errands                      (FAMILIAR_MACHINE_ID)
  --name <name>        display name                                    (FAMILIAR_MACHINE_NAME)
  --backend <kind>     local|docker|cloudflare|ssh                     (FAMILIAR_BACKEND)
  --home <dir>         persistent home (Chrome profile, ~/opt, skills) (FAMILIAR_HOME)
  --desktop-url <url>  noVNC URL when a full desktop is available      (FAMILIAR_DESKTOP_URL)
  --owner <name>       owner's first name used in timeline text        (FAMILIAR_OWNER_NAME)
  -h, --help

Other env: FAMILIAR_SCRIPT_SPEED (scripted pacing multiplier), CHROME_PATH,
FAMILIAR_CLAUDE_BIN, FAMILIAR_CODEX_BIN, FAMILIAR_TIME_CAP_S, FAMILIAR_LOG=debug|info|warn|error.
`;

export function parseConfig(argv: string[], env = process.env): Config {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
      else args[a.slice(2)] = argv[++i] ?? "";
    }
  }
  const pick = (k: string, e: string, d = "") => args[k] ?? env[e] ?? d;
  const id = pick("id", "FAMILIAR_MACHINE_ID", `m_${os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`);
  const home = path.resolve(pick("home", "FAMILIAR_HOME", path.join(os.homedir(), ".familiar-machine")));
  const desktopUrl = pick("desktop-url", "FAMILIAR_DESKTOP_URL") || null;
  return {
    server: pick("server", "FAMILIAR_SERVER", "ws://127.0.0.1:4400").replace(/\/+$/, ""),
    token: pick("token", "FAMILIAR_MACHINE_TOKEN"),
    id,
    name: pick("name", "FAMILIAR_MACHINE_NAME", id.replace(/^m_/, "")),
    backend: pick("backend", "FAMILIAR_BACKEND", "local"),
    home,
    desktopUrl,
    hasDesktop: !!desktopUrl,
    ownerName: pick("owner", "FAMILIAR_OWNER_NAME", "Ryan"),
    scriptSpeed: Math.max(0.05, Number(env.FAMILIAR_SCRIPT_SPEED ?? "1") || 1),
    defaultTimeCapS: Number(env.FAMILIAR_TIME_CAP_S ?? "3600") || 3600,
    executors: ["claude", "codex", "scripted"],
  };
}

/** The machine protocol endpoint for a server base URL (accepts http(s) or ws(s), with or without path). */
export function connectUrl(cfg: Config): string {
  let base = cfg.server;
  if (base.startsWith("http://")) base = "ws://" + base.slice(7);
  else if (base.startsWith("https://")) base = "wss://" + base.slice(8);
  else if (!/^wss?:\/\//.test(base)) base = "ws://" + base;
  const u = new URL(base);
  if (!u.pathname.endsWith("/api/machines/connect")) u.pathname = u.pathname.replace(/\/+$/, "") + "/api/machines/connect";
  u.searchParams.set("token", cfg.token);
  u.searchParams.set("id", cfg.id);
  return u.toString();
}
