import type { RunContext } from "./types";

export function logsHandler(ctx: RunContext) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Log uploads
    if (path.includes("/logs")) {
      if (method === "POST" && path.match(/\/logs\/\d+/)) {
        const text = await req.text();
        for (const line of text.split("\n")) {
          if (line.trim()) ctx.output.emit({ type: "step_log", line: line.trim() });
        }
      }
      return Response.json({ id: 1, path: "logs/1" });
    }

    // Feed - WebSocket upgrade
    if (path.includes("/feed")) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        // Return null to signal caller should attempt upgrade
        return null;
      }
      const text = await req.text();
      for (const line of text.split("\n")) {
        if (line.trim()) ctx.output.emit({ type: "step_log", line: line.trim() });
      }
      return Response.json({});
    }

    // Timeline updates
    if (path.includes("/timelines")) {
      if (method === "POST") {
        return Response.json({ id: ctx.timelineId, changeId: 1, records: [] });
      }
      if (method === "PATCH") {
        const body = await req.json() as any;
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
        return Response.json({ changeId: 2, records: [] });
      }
      if (method === "GET") {
        return Response.json({ id: ctx.timelineId, changeId: 1, records: [] });
      }
    }

    // Events
    if (path.includes("/events")) {
      const body = await req.json() as any;
      ctx.output.emit({ type: "server", tag: "event", message: body.name || "unknown" });
      return Response.json({});
    }

    return null;
  };
}

export function websocketHandlers(ctx: RunContext) {
  return {
    open(ws: any) {
      ctx.output.emit({ type: "server", tag: "feed", message: "WebSocket connected" });
    },
    message(ws: any, message: any) {
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
    close(ws: any) {
      ctx.output.emit({ type: "server", tag: "feed", message: "WebSocket closed" });
    },
  };
}
