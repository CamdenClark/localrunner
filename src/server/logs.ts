import type { Hono } from "hono";
import type { ServerEnv } from "./hono";
import type { RunContext } from "./types";

export function registerLogsRoutes(
  app: Hono<ServerEnv>,
  ctx: RunContext,
  upgradeWebSocket: (handler: any) => any,
) {
  // Log uploads
  app.post("/logs/:id", async (c) => {
    const text = await c.req.text();
    for (const line of text.split("\n")) {
      if (line.trim()) ctx.output.emit({ type: "step_log", line: line.trim() });
    }
    return c.json({ id: 1, path: "logs/1" });
  });

  // Catch-all for other /logs/* paths
  app.all("/logs/*", (c) => {
    return c.json({ id: 1, path: "logs/1" });
  });

  // Feed - WebSocket upgrade
  app.get(
    "/feed",
    upgradeWebSocket(() => ({
      onOpen(_event: any, ws: any) {
        ctx.output.emit({ type: "server", tag: "feed", message: "WebSocket connected" });
      },
      onMessage(event: any, ws: any) {
        const message = event.data;
        try {
          const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
          if (data.value && Array.isArray(data.value)) {
            for (const line of data.value) {
              if (typeof line === "string" && line.trim()) {
                ctx.output.emit({ type: "step_log", line: line.trim() });
              }
            }
          }
        } catch {
          const text = typeof message === "string" ? message : new TextDecoder().decode(message);
          if (text.trim()) ctx.output.emit({ type: "step_log", line: text.trim() });
        }
      },
      onClose(_event: any, ws: any) {
        ctx.output.emit({ type: "server", tag: "feed", message: "WebSocket closed" });
      },
    })),
  );

  // Non-WebSocket feed posts (fallback)
  app.post("/feed", async (c) => {
    const text = await c.req.text();
    for (const line of text.split("\n")) {
      if (line.trim()) ctx.output.emit({ type: "step_log", line: line.trim() });
    }
    return c.json({});
  });

  // Timeline updates
  app.post("/timelines/*", (c) => {
    return c.json({ id: ctx.timelineId, changeId: 1, records: [] });
  });

  app.patch("/timelines/*", async (c) => {
    const body = (await c.req.json()) as any;
    const records = body.value || body;
    if (Array.isArray(records)) {
      const results = ["Succeeded", "SucceededWithIssues", "Failed", "Cancelled", "Skipped", "Abandoned"];
      for (const record of records) {
        if (record.name && record.state !== undefined) {
          if (record.state === 1) {
            ctx.output.emit({ type: "step_start", stepName: record.name, timestamp: Date.now() });
          } else if (record.state === 2) {
            const result = record.result != null ? (results[record.result] || String(record.result)) : "unknown";
            ctx.output.emit({ type: "step_complete", stepName: record.name, conclusion: result.toLowerCase(), timestamp: Date.now() });
          }
        }
      }
    }
    return c.json({ changeId: 2, records: [] });
  });

  app.get("/timelines/*", (c) => {
    return c.json({ id: ctx.timelineId, changeId: 1, records: [] });
  });

  // Events
  app.post("/events/*", async (c) => {
    const body = (await c.req.json()) as any;
    ctx.output.emit({ type: "server", tag: "event", message: body.name || "unknown" });
    return c.json({});
  });

  // Catch events at root level too
  app.post("/events", async (c) => {
    const body = (await c.req.json()) as any;
    ctx.output.emit({ type: "server", tag: "event", message: body.name || "unknown" });
    return c.json({});
  });
}
