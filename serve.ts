#!/usr/bin/env bun
/**
 * Long-lived localrunner server.
 * Handles the runner protocol for active runs and serves the web UI.
 *
 * Usage:
 *   bun serve.ts [--port 9637]
 *
 * The CLI registers runs via POST /api/register-run, then launches the
 * runner process pointing at this server. The CLI connects to
 * GET /api/runs/:id/events (SSE) for real-time output.
 */
import { parseArgs } from "util";
import { createMultiRunApp, websocket } from "./server/hono";
import { RunManager } from "./server/runs";
import { registerWebRoutes } from "./web/routes";
import { registerApiRoutes } from "./web/api";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "9637" },
  },
  allowPositionals: false,
  strict: true,
});

const port = parseInt(values.port || "9637", 10);
const runManager = new RunManager();
const { app, addRunnerCatchAll } = createMultiRunApp(runManager);

// Web UI and API routes (before runner catch-all)
registerWebRoutes(app, runManager);
registerApiRoutes(app, runManager, port);

// Runner protocol catch-all (must be last)
addRunnerCatchAll();

const server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
});

console.log(`localrunner server listening on http://localhost:${port}`);
console.log(`Web UI: http://localhost:${port}/`);
console.log(`Press Ctrl+C to stop.\n`);

const pidFile = `${process.env.HOME}/.localrunner/server.pid`;
await Bun.write(pidFile, String(process.pid));

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  try { require("fs").unlinkSync(pidFile); } catch {}
  server.stop(true);
  process.exit(0);
});

process.on("SIGTERM", () => {
  try { require("fs").unlinkSync(pidFile); } catch {}
  server.stop(true);
  process.exit(0);
});
