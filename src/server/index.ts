import { createRunContext } from "./types";
import type { ServerConfig, ServerHandle } from "./types";
import { createApp, websocket } from "./hono";

export { scriptStep, actionStep } from "./steps";
export type { ServerConfig, ServerHandle } from "./types";

export function createServer(config: ServerConfig): ServerHandle {
  const { ctx, jobCompleted } = createRunContext(config);
  const { output } = ctx;

  const app = createApp(ctx);

  const server = Bun.serve({
    port: ctx.port,
    fetch: app.fetch,
    websocket,
  });

  output.emit({ type: "info", message: `Local Actions server listening on http://localhost:${ctx.port}` });
  output.emit({ type: "info", message: `Session: ${ctx.sessionId}` });
  output.emit({ type: "info", message: `Job: ${ctx.jobId}` });
  output.emit({ type: "info", message: "Waiting for runner to connect...\n" });

  return { server, jobCompleted, output, ctx };
}
