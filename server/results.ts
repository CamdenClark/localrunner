import { randomUUID } from "crypto";
import type { RunContext } from "./types";

export function resultsHandler(ctx: RunContext) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Results API - Twirp endpoints
    if (path.startsWith("/twirp/")) {
      const body = await req.json() as any;

      if (path.includes("WorkflowStepsUpdate")) {
        const conclusionNames: Record<number, string> = { 2: "succeeded", 3: "failed", 4: "cancelled", 7: "skipped" };
        if (body.steps) {
          for (const step of body.steps) {
            if (step.name) {
              if (step.status === 3) {
                ctx.output.emit({ type: "step_start", stepName: step.name, timestamp: Date.now() });
              } else if (step.status === 6) {
                const conclusion = conclusionNames[step.conclusion] || "unknown";
                ctx.output.emit({ type: "step_complete", stepName: step.name, conclusion, timestamp: Date.now() });
              }
            }
          }
        }
        return Response.json({ stepsResult: [] });
      }

      if (path.includes("SignedBlobURL")) {
        const blobId = randomUUID();
        return Response.json({
          url: `${ctx.serverBaseUrl}/_blob/${blobId}`,
          blob_storage_type: "BLOB_STORAGE_TYPE_AZURE",
          soft_size_limit: 104857600,
        });
      }

      if (path.includes("Metadata")) {
        return Response.json({ ok: true });
      }

      ctx.output.emit({ type: "server", tag: "twirp", message: path });
      return Response.json({});
    }

    // Blob upload endpoint (for Results API log uploads)
    if (path.startsWith("/_blob/")) {
      if (method === "PUT" || method === "PATCH" || method === "POST") {
        const text = await req.text();
        for (const line of text.split("\n")) {
          if (line.trim()) ctx.output.emit({ type: "step_log", line: line.trim() });
        }
      }
      return new Response(null, { status: 201, headers: { "x-ms-request-id": randomUUID() } });
    }

    return null;
  };
}
