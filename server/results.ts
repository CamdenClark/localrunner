import { randomUUID } from "crypto";
import type { Hono } from "hono";
import type { ServerEnv } from "./hono";
import type { RunContext } from "./types";
import {
  createArtifact,
  finalizeArtifact,
  listArtifacts,
  getSignedArtifactURL,
  registerArtifactBlob,
  getArtifactBlobPath,
} from "./artifacts";

export function registerResultsRoutes(app: Hono<ServerEnv>, ctx: RunContext) {
  // Twirp endpoints
  app.post("/twirp/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    const body = (await c.req.json()) as any;

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
      return c.json({ stepsResult: [] });
    }

    if (path.includes("SignedBlobURL")) {
      const blobId = randomUUID();
      if (body.artifact_name) {
        const runId = body.workflow_run_backend_id || ctx.runId;
        registerArtifactBlob(blobId, runId, body.artifact_name);
      }
      return c.json({
        url: `${ctx.serverBaseUrl}/_blob/${blobId}`,
        blob_storage_type: "BLOB_STORAGE_TYPE_AZURE",
        soft_size_limit: 104857600,
      });
    }

    if (path.includes("CreateArtifact")) {
      return createArtifact(ctx, body);
    }

    if (path.includes("FinalizeArtifact")) {
      return finalizeArtifact(ctx, body);
    }

    if (path.includes("ListArtifacts")) {
      return listArtifacts(ctx, body);
    }

    if (path.includes("GetSignedArtifactURL")) {
      return getSignedArtifactURL(ctx, body);
    }

    if (path.includes("Metadata")) {
      return c.json({ ok: true });
    }

    ctx.output.emit({ type: "server", tag: "twirp", message: path });
    return c.json({});
  });

  // Blob upload endpoint
  app.all("/_blob/:blobId", async (c) => {
    const method = c.req.method;
    const blobId = c.req.param("blobId");

    if (method === "PUT" || method === "PATCH" || method === "POST") {
      const artifactPath = getArtifactBlobPath(blobId);

      if (artifactPath) {
        const data = await c.req.arrayBuffer();
        await Bun.write(artifactPath, data);
        ctx.output.emit({ type: "server", tag: "artifact", message: `Blob upload ${blobId} (${data.byteLength} bytes)` });
      } else {
        const text = await c.req.text();
        for (const line of text.split("\n")) {
          if (line.trim()) ctx.output.emit({ type: "step_log", line: line.trim() });
        }
      }
    }
    return new Response(null, { status: 201, headers: { "x-ms-request-id": randomUUID() } });
  });

  // Artifact blob upload endpoint (Azure SDK compatible)
  app.all("/localartifact/upload/:blobId", async (c) => {
    const blobId = c.req.param("blobId");
    const artifactPath = getArtifactBlobPath(blobId);
    const url = new URL(c.req.url);
    const comp = url.searchParams.get("comp");

    if (comp === "blocklist") {
      ctx.output.emit({ type: "server", tag: "artifact", message: `Block list committed for ${blobId}` });
      return new Response(null, { status: 201, headers: { "x-ms-request-id": randomUUID(), "x-ms-content-crc64": "" } });
    }

    if (comp === "block") {
      if (artifactPath) {
        const data = await c.req.arrayBuffer();
        const { existsSync } = await import("fs");
        if (existsSync(artifactPath)) {
          const existing = await Bun.file(artifactPath).arrayBuffer();
          const combined = new Uint8Array(existing.byteLength + data.byteLength);
          combined.set(new Uint8Array(existing), 0);
          combined.set(new Uint8Array(data), existing.byteLength);
          await Bun.write(artifactPath, combined);
        } else {
          await Bun.write(artifactPath, data);
        }
        ctx.output.emit({ type: "server", tag: "artifact", message: `Block upload ${blobId} (${data.byteLength} bytes)` });
      }
      return new Response(null, { status: 201, headers: { "x-ms-request-id": randomUUID(), "x-ms-content-md5": "" } });
    }

    // Simple PUT (no chunking)
    if (c.req.method === "PUT" && artifactPath) {
      const data = await c.req.arrayBuffer();
      await Bun.write(artifactPath, data);
      ctx.output.emit({ type: "server", tag: "artifact", message: `Upload ${blobId} (${data.byteLength} bytes)` });
    }
    return new Response(null, { status: 201, headers: { "x-ms-request-id": randomUUID() } });
  });

  // Artifact download endpoint
  app.get("/_artifacts/:runId/:name{.+}", async (c) => {
    const runId = c.req.param("runId");
    const name = decodeURIComponent(c.req.param("name"));
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    const filePath = join(homedir(), ".localrunner", "runs", runId, "artifacts", name);

    if (existsSync(filePath)) {
      const file = Bun.file(filePath);
      ctx.output.emit({ type: "server", tag: "artifact", message: `Download "${name}" (run=${runId})` });
      return new Response(file, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.size),
        },
      });
    }

    return new Response("Artifact not found", { status: 404 });
  });
}
