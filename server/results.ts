import { randomUUID } from "crypto";
import type { RunContext } from "./types";
import {
  createArtifact,
  finalizeArtifact,
  listArtifacts,
  getSignedArtifactURL,
  registerArtifactBlob,
  getArtifactBlobPath,
} from "./artifacts";

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
        // If this blob is for an artifact upload, register it
        if (body.artifact_name) {
          const runId = body.workflow_run_backend_id || ctx.runId;
          registerArtifactBlob(blobId, runId, body.artifact_name);
        }
        return Response.json({
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
        return Response.json({ ok: true });
      }

      ctx.output.emit({ type: "server", tag: "twirp", message: path });
      return Response.json({});
    }

    // Blob upload endpoint (for Results API log uploads and artifact uploads)
    if (path.startsWith("/_blob/")) {
      if (method === "PUT" || method === "PATCH" || method === "POST") {
        const blobId = path.slice("/_blob/".length);
        const artifactPath = getArtifactBlobPath(blobId);

        if (artifactPath) {
          // This blob is an artifact upload — persist to disk
          const data = await req.arrayBuffer();
          await Bun.write(artifactPath, data);
          ctx.output.emit({ type: "server", tag: "artifact", message: `Blob upload ${blobId} (${data.byteLength} bytes)` });
        } else {
          // Regular log blob
          const text = await req.text();
          for (const line of text.split("\n")) {
            if (line.trim()) ctx.output.emit({ type: "step_log", line: line.trim() });
          }
        }
      }
      return new Response(null, { status: 201, headers: { "x-ms-request-id": randomUUID() } });
    }

    // Artifact blob upload endpoint (Azure SDK compatible)
    // URL format: /localartifact/upload/{blobId}?comp=block&blockid=...
    // Azure SDK uploads blocks then commits with comp=blocklist
    if (path.startsWith("/localartifact/upload/")) {
      const blobId = path.slice("/localartifact/upload/".length);
      const artifactPath = getArtifactBlobPath(blobId);
      const comp = url.searchParams.get("comp");

      if (comp === "blocklist") {
        // Block list commit — artifact upload is complete
        ctx.output.emit({ type: "server", tag: "artifact", message: `Block list committed for ${blobId}` });
        return new Response(null, { status: 201, headers: { "x-ms-request-id": randomUUID(), "x-ms-content-crc64": "" } });
      }

      if (comp === "block") {
        // Individual block upload — append to artifact file
        if (artifactPath) {
          const data = await req.arrayBuffer();
          const { existsSync } = await import("fs");
          if (existsSync(artifactPath)) {
            // Append to existing file
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
      if (method === "PUT" && artifactPath) {
        const data = await req.arrayBuffer();
        await Bun.write(artifactPath, data);
        ctx.output.emit({ type: "server", tag: "artifact", message: `Upload ${blobId} (${data.byteLength} bytes)` });
      }
      return new Response(null, { status: 201, headers: { "x-ms-request-id": randomUUID() } });
    }

    return null;
  };
}
