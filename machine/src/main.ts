#!/usr/bin/env node
import { Agentd } from "./agentd.js";
import { parseConfig } from "./config.js";
import { log } from "./util.js";

const cfg = parseConfig(process.argv.slice(2));
if (!cfg.token) log("warn", "no machine token given (--token / FAMILIAR_MACHINE_TOKEN); the server may refuse the connection");

const d = new Agentd(cfg);
process.on("SIGINT", () => void d.shutdown(0));
process.on("SIGTERM", () => void d.shutdown(0));
process.on("unhandledRejection", (e) => log("error", "unhandled rejection", e as Error));
process.on("uncaughtException", (e) => log("error", "uncaught exception", e));

d.start().then(
  () => log("info", `agentd ${cfg.id} (${cfg.backend}) up; home ${cfg.home}`),
  (e) => {
    log("error", "failed to start", e);
    process.exit(1);
  },
);
