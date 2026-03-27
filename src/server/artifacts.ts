import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync, readFileSync } from "fs";
import type { RunContext } from "./types";
import { getDb } from "../db";
import { artifacts as artifactsTable } from "../db/schema";
import { eq, and } from "drizzle-orm";

interface ArtifactEntry {
  id: number;
  name: string;
  size: number;
  finalized: boolean;
  blobId: string;
  createdAt: string;
}

// Maps blobId → artifact file path (for routing blob uploads to artifact storage)
const pendingBlobs = new Map<string, string>();

let nextArtifactId = 1;

function getArtifactsDir(runId: string): string {
  const dir = join(homedir(), ".localactions", "runs", runId, "artifacts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function artifactMetaPath(runId: string, name: string): string {
  return join(getArtifactsDir(runId), `${name}.json`);
}

function artifactDataPath(runId: string, name: string): string {
  return join(getArtifactsDir(runId), name);
}

export function registerArtifactBlob(blobId: string, runId: string, artifactName: string): void {
  pendingBlobs.set(blobId, artifactDataPath(runId, artifactName));
}

export function getArtifactBlobPath(blobId: string): string | undefined {
  return pendingBlobs.get(blobId);
}

export async function createArtifact(ctx: RunContext, body: any): Promise<Response> {
  const name = body.name || "artifact";
  const artifactId = nextArtifactId++;
  const runId = body.workflow_run_backend_id || ctx.runId;

  const entry: ArtifactEntry = {
    id: artifactId,
    name,
    size: 0,
    finalized: false,
    blobId: "",
    createdAt: new Date().toISOString(),
  };

  // Register a blob path for this artifact so uploads get persisted
  const blobId = `artifact-${artifactId}`;
  registerArtifactBlob(blobId, runId, name);

  await Bun.write(artifactMetaPath(runId, name), JSON.stringify(entry));

  try {
    const db = getDb();
    db.insert(artifactsTable)
      .values({
        runId,
        name,
        size: 0,
        finalized: 0,
        createdAt: entry.createdAt,
      })
      .run();
  } catch {}

  ctx.output.emit({ type: "server", tag: "artifact", message: `Created artifact "${name}" (id=${artifactId})` });

  // The upload-artifact action uses Azure SDK's BlobClient which extracts an accountName from the URL.
  // For localhost URLs, the Azure SDK uses the first path segment as the account name.
  // Format: http://localhost:PORT/account/container/blob
  const uploadUrl = `${ctx.serverBaseUrl}/localartifact/upload/${blobId}`;

  return Response.json({
    ok: true,
    signed_upload_url: uploadUrl,
  });
}

export async function finalizeArtifact(ctx: RunContext, body: any): Promise<Response> {
  const name = body.name || "artifact";
  const runId = body.workflow_run_backend_id || ctx.runId;
  const metaPath = artifactMetaPath(runId, name);

  let artifactId = 0;
  if (existsSync(metaPath)) {
    const meta: ArtifactEntry = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.finalized = true;
    meta.size = body.size || 0;
    if (body.hash) {
      (meta as any).hash = body.hash;
    }
    artifactId = meta.id;
    await Bun.write(metaPath, JSON.stringify(meta));

    try {
      const db = getDb();
      db.update(artifactsTable)
        .set({ finalized: 1, size: meta.size })
        .where(
          and(
            eq(artifactsTable.runId, runId),
            eq(artifactsTable.name, name),
          ),
        )
        .run();
    } catch {}

    ctx.output.emit({ type: "server", tag: "artifact", message: `Finalized artifact "${name}" (size=${meta.size})` });
  }

  return Response.json({
    ok: true,
    artifact_id: artifactId.toString(),
  });
}

export async function listArtifacts(ctx: RunContext, body: any): Promise<Response> {
  const runId = body.workflow_run_backend_id || ctx.runId;
  const nameFilter = body.name_filter || "";
  const dir = getArtifactsDir(runId);

  const artifacts: any[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    try {
      const meta: ArtifactEntry = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!meta.finalized) continue;
      if (nameFilter && meta.name !== nameFilter) continue;
      artifacts.push({
        name: meta.name,
        id: meta.name,
        size: meta.size,
        created_at: meta.createdAt,
      });
    } catch { continue; }
  }

  return Response.json({ artifacts });
}

export async function getSignedArtifactURL(ctx: RunContext, body: any): Promise<Response> {
  const name = body.name || "";
  const runId = body.workflow_run_backend_id || ctx.runId;

  return Response.json({
    signed_url: `${ctx.serverBaseUrl}/_artifacts/${runId}/${encodeURIComponent(name)}`,
    name,
  });
}

