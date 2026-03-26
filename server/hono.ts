import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { RunContext } from "./types";
import type { RunManager } from "./runs";
import { registerAuthRoutes } from "./auth";
import { registerJobRoutes } from "./job";
import { registerCacheRoutes } from "./cache";
import { registerActionsRoutes } from "./actions";
import { registerResultsRoutes } from "./results";
import { registerLogsRoutes } from "./logs";

export type ServerEnv = {
  Variables: {
    ctx: RunContext;
  };
};

const { upgradeWebSocket, websocket } = createBunWebSocket();

export { websocket };

function registerRunnerRoutes(app: Hono<ServerEnv>, ctx: RunContext) {
  registerAuthRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerCacheRoutes(app, ctx);
  registerActionsRoutes(app, ctx);
  registerResultsRoutes(app, ctx);
  registerLogsRoutes(app, ctx, upgradeWebSocket);
}

/**
 * Create a Hono app for the ephemeral single-run server (backwards compat).
 */
export function createApp(ctx: RunContext) {
  const app = new Hono<ServerEnv>();

  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    const url = new URL(c.req.url);
    ctx.output.emit({
      type: "server",
      tag: c.req.method,
      message: `${url.pathname}${url.search}`,
    });
    await next();
  });

  registerRunnerRoutes(app, ctx);

  app.all("*", (c) => {
    ctx.output.emit({
      type: "server",
      tag: "unhandled",
      message: `${c.req.method} ${new URL(c.req.url).pathname}`,
    });
    return c.json({});
  });

  return app;
}

/** Create a per-run Hono sub-app with all runner protocol routes. */
function createRunApp(ctx: RunContext): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  registerRunnerRoutes(app, ctx);
  app.all("*", (c) => {
    ctx.output.emit({
      type: "server",
      tag: "unhandled",
      message: `${c.req.method} ${new URL(c.req.url).pathname}`,
    });
    return c.json({});
  });
  return app;
}

/**
 * Resolve RunContext from a request by parsing the JWT in the Authorization header.
 * Falls back to single active run if only one exists.
 */
function resolveRun(req: Request, runManager: RunManager): RunContext | undefined {
  // Try JWT from Authorization header
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const ctx = runManager.getRunFromJwt(auth.slice(7));
    if (ctx) return ctx;
  }

  // Fallback: if only one active run, use it
  const active = runManager.getActiveRuns();
  if (active.length === 1) return active[0];

  return undefined;
}

/**
 * Create the long-lived multi-run Hono app.
 *
 * Runner identification: the runner receives a JWT (via /_apis/oauth2/token)
 * containing the runId in its `scp` claim. It sends this JWT as
 * `Authorization: Bearer {jwt}` on all subsequent requests.
 * We decode the JWT to route each request to the correct RunContext.
 */
export function createMultiRunApp(runManager: RunManager) {
  const app = new Hono();

  // Health check (web UI / CLI)
  app.get("/api/health", (c) => c.json({ ok: true }));

  /**
   * Call AFTER registering all web UI and API routes on `app`.
   * Adds the catch-all that dispatches runner protocol requests to per-run sub-apps.
   */
  function addRunnerCatchAll() {
    app.all("*", async (c) => {
      const ctx = resolveRun(c.req.raw, runManager);
      if (!ctx) {
        return c.json({ error: "No active run found" }, 404);
      }

      const url = new URL(c.req.url);
      ctx.output.emit({
        type: "server",
        tag: c.req.method,
        message: `${url.pathname}${url.search}`,
      });

      if (!ctx._app) {
        ctx._app = createRunApp(ctx);
      }

      // Pass env through so Hono's Bun adapter can access the server (needed for WebSocket upgrade)
      return ctx._app.fetch(c.req.raw, c.env);
    });
  }

  return { app, addRunnerCatchAll };
}
