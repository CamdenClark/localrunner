import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, existsSync, readdirSync, unlinkSync, readFileSync } from "fs";
import type { Hono } from "hono";
import type { ServerEnv } from "./hono";
import type { RunContext } from "./types";

interface CacheEntry {
  key: string;
  version: string;
  committed: boolean;
  filePath: string;
  size: number;
  createdAt: string;
}

let nextCacheId = Date.now();

function getCacheDir(repo: string): string {
  const dir = join(tmpdir(), "localactions", "cache", repo);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheEntryPath(repo: string, cacheId: number): string {
  return join(getCacheDir(repo), `cache-${cacheId}`);
}

function cacheMetaPath(repo: string, cacheId: number): string {
  return join(getCacheDir(repo), `cache-${cacheId}.json`);
}

function removeCacheEntry(repo: string, cacheId: number): void {
  try { unlinkSync(cacheEntryPath(repo, cacheId)); } catch {}
  try { unlinkSync(cacheMetaPath(repo, cacheId)); } catch {}
}

function findCache(repo: string, keys: string[], version: string): { cacheId: number; entry: CacheEntry } | null {
  const dir = getCacheDir(repo);
  const metaFiles = readdirSync(dir).filter(f => f.endsWith(".json"));

  for (const key of keys) {
    for (const metaFile of metaFiles) {
      try {
        const meta: CacheEntry = JSON.parse(readFileSync(join(dir, metaFile), "utf8"));
        if (!meta.committed) continue;
        if (meta.key === key && meta.version === version) {
          const cacheId = parseInt(metaFile.replace("cache-", "").replace(".json", ""));
          return { cacheId, entry: meta };
        }
      } catch { continue; }
    }
  }

  for (const key of keys) {
    for (const metaFile of metaFiles) {
      try {
        const meta: CacheEntry = JSON.parse(readFileSync(join(dir, metaFile), "utf8"));
        if (!meta.committed) continue;
        if (meta.key.startsWith(key) && meta.version === version) {
          const cacheId = parseInt(metaFile.replace("cache-", "").replace(".json", ""));
          return { cacheId, entry: meta };
        }
      } catch { continue; }
    }
  }

  return null;
}

export function registerCacheRoutes(app: Hono<ServerEnv>, ctx: RunContext) {
  const repo = ctx.repoCtx.fullName;

  app.get("/_apis/artifactcache/cache", (c) => {
    const url = new URL(c.req.url);
    const keys = url.searchParams.get("keys")?.split(",") || [];
    const version = url.searchParams.get("version") || "";
    ctx.output.emit({ type: "server", tag: "cache", message: `Lookup keys=${keys.join(",")} version=${version.slice(0, 12)}` });

    const found = findCache(repo, keys, version);
    if (found) {
      ctx.output.emit({ type: "server", tag: "cache", message: `Hit: ${found.entry.key} (id=${found.cacheId})` });
      return c.json({
        result: "hit",
        cacheId: found.cacheId,
        scope: "refs/heads/main",
        cacheKey: found.entry.key,
        creationTime: found.entry.createdAt,
        archiveLocation: `${ctx.serverBaseUrl}/_apis/artifactcache/download/${found.cacheId}`,
      });
    }
    ctx.output.emit({ type: "server", tag: "cache", message: "Miss" });
    return new Response(null, { status: 204 });
  });

  app.get("/_apis/artifactcache/download/:id", (c) => {
    const cacheId = parseInt(c.req.param("id"));
    const filePath = cacheEntryPath(repo, cacheId);
    ctx.output.emit({ type: "server", tag: "cache", message: `Download id=${cacheId}` });
    if (existsSync(filePath)) {
      const file = Bun.file(filePath);
      return new Response(file, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.size),
        },
      });
    }
    return new Response("Cache not found", { status: 404 });
  });

  app.post("/_apis/artifactcache/caches", async (c) => {
    const body = (await c.req.json()) as any;
    const cacheId = nextCacheId++;
    const entry: CacheEntry = {
      key: body.key,
      version: body.version || "",
      committed: false,
      filePath: cacheEntryPath(repo, cacheId),
      size: 0,
      createdAt: new Date().toISOString(),
    };
    await Bun.write(cacheMetaPath(repo, cacheId), JSON.stringify(entry));
    ctx.output.emit({ type: "server", tag: "cache", message: `Reserved id=${cacheId} key=${body.key}` });
    return c.json({ cacheId });
  });

  app.patch("/_apis/artifactcache/caches/:id", async (c) => {
    const cacheId = parseInt(c.req.param("id"));
    const data = await c.req.arrayBuffer();
    const filePath = cacheEntryPath(repo, cacheId);
    const contentRange = c.req.header("Content-Range");
    ctx.output.emit({ type: "server", tag: "cache", message: `Upload id=${cacheId} size=${data.byteLength} range=${contentRange || "full"}` });

    if (contentRange) {
      const match = contentRange.match(/bytes (\d+)-(\d+)\//);
      if (match) {
        const start = parseInt(match[1]!);
        if (start === 0) {
          await Bun.write(filePath, data);
        } else {
          const existing = existsSync(filePath) ? await Bun.file(filePath).arrayBuffer() : new ArrayBuffer(0);
          const combined = new Uint8Array(start + data.byteLength);
          combined.set(new Uint8Array(existing), 0);
          combined.set(new Uint8Array(data), start);
          await Bun.write(filePath, combined);
        }
      }
    } else {
      await Bun.write(filePath, data);
    }
    return new Response(null, { status: 204 });
  });

  app.post("/_apis/artifactcache/caches/:id", async (c) => {
    const cacheId = parseInt(c.req.param("id"));
    const body = (await c.req.json()) as any;
    const metaPath = cacheMetaPath(repo, cacheId);

    if (existsSync(metaPath)) {
      const meta: CacheEntry = JSON.parse(readFileSync(metaPath, "utf8"));
      meta.committed = true;
      meta.size = body.size || 0;

      const dir = getCacheDir(repo);
      for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
        const fPath = join(dir, f);
        if (fPath === metaPath) continue;
        try {
          const existing: CacheEntry = JSON.parse(readFileSync(fPath, "utf8"));
          if (existing.key === meta.key && existing.version === meta.version) {
            const oldId = parseInt(f.replace("cache-", "").replace(".json", ""));
            removeCacheEntry(repo, oldId);
          }
        } catch {}
      }

      await Bun.write(metaPath, JSON.stringify(meta));
      ctx.output.emit({ type: "server", tag: "cache", message: `Committed id=${cacheId} key=${meta.key} size=${meta.size}` });
    }
    return new Response(null, { status: 204 });
  });
}
