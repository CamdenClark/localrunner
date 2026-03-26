import { createRunContext } from "./types";
import type { ServerConfig, ServerHandle } from "./types";
import { authRoutes } from "./auth";
import { jobRoutes } from "./job";
import { cacheRoutes } from "./cache";
import { actionsHandler } from "./actions";
import { resultsHandler } from "./results";
import { logsHandler, websocketHandlers } from "./logs";
import { artifactDownloadHandler } from "./artifacts";

export { scriptStep, actionStep } from "./steps";
export type { ServerConfig, ServerHandle } from "./types";

export function createServer(config: ServerConfig): ServerHandle {
  const { ctx, jobCompleted } = createRunContext(config);
  const { output } = ctx;

  // Build wildcard handlers (for paths with dynamic segments the router can't match)
  const handleActions = actionsHandler(ctx);
  const handleResults = resultsHandler(ctx);
  const handleLogs = logsHandler(ctx);
  const handleArtifacts = artifactDownloadHandler(ctx);

  const server = Bun.serve({
    port: ctx.port,
    routes: {
      ...authRoutes(ctx),
      ...jobRoutes(ctx),
      ...cacheRoutes(ctx),
    },

    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      output.emit({ type: "server", tag: method, message: `${path}${url.search}` });

      // Try wildcard handlers in order
      const actionsRes = await handleActions(req);
      if (actionsRes) return actionsRes;

      const resultsRes = await handleResults(req);
      if (resultsRes) return resultsRes;

      const artifactsRes = await handleArtifacts(req);
      if (artifactsRes) return artifactsRes;

      // Feed WebSocket upgrade needs special handling
      if (path.includes("/feed") && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = server.upgrade(req);
        if (upgraded) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const logsRes = await handleLogs(req);
      if (logsRes) return logsRes;

      output.emit({ type: "server", tag: "unhandled", message: `${method} ${path}` });
      return Response.json({});
    },

    websocket: websocketHandlers(ctx),
  });

  output.emit({ type: "info", message: `Local Actions server listening on http://localhost:${ctx.port}` });
  output.emit({ type: "info", message: `Session: ${ctx.sessionId}` });
  output.emit({ type: "info", message: `Job: ${ctx.jobId}` });
  output.emit({ type: "info", message: "Waiting for runner to connect...\n" });

  return { server, jobCompleted, output };
}
