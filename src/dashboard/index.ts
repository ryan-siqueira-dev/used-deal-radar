import { createApplication } from "../app.js";
import { loadConfig } from "../config/env.js";
import { disconnectDatabase } from "../db/client.js";
import { startDashboard } from "./server.js";

const config = loadConfig();
const app = createApplication(config);
const port = Number(process.env.DASHBOARD_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_dashboard_port");
const server = startDashboard(app, port, process.env.DASHBOARD_CONTAINER === "true");
if (config.SCHEDULER_ENABLED) app.scheduler.start();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  try { await app.shutdown(); await disconnectDatabase(); process.exitCode = 0; }
  catch (error) { app.logger.error({ err: error }, "Shutdown failed"); process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
if (process.connected) process.once("disconnect", () => { void shutdown(); });
