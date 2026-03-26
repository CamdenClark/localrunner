import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync, unlinkSync, readFileSync } from "fs";
import type { OutputHandler } from "../output";
import type { RunContext } from "./types";

const CACHE_DIR = join(homedir(), ".localrunner", "cache");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheEntry {
  key: string;
  version: string;
  committed: boolean;
  filePath: string;
  size: number;
  createdAt: string;
}

let nextCacheId = Date.now();

function getCacheDir(): string {
  mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

function cacheEntryPath(cacheId: number): string {
  return join(getCacheDir(), `cache-${cacheId}`);
}

function cacheMetaPath(cacheId: number): string {
  return join(getCacheDir(), `cache-${cacheId}.json`);
}

function isCacheExpired(entry: CacheEntry): boolean {
  return Date.now() - new Date(entry.createdAt).getTime() > CACHE_TTL_MS;
}

function removeCacheEntry(cacheId: number): void {
  try { unlinkSync(cacheEntryPath(cacheId)); } catch {}
  try { unlinkSync(cacheMetaPath(cacheId)); } catch {}
}

export function evictExpiredCaches(output: OutputHandler): void {
  const dir = getCacheDir();
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    try {
      const meta: CacheEntry = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (isCacheExpired(meta)) {
        const cacheId = parseInt(f.replace("cache-", "").replace(".json", ""));
        removeCacheEntry(cacheId);
        output.emit({ type: "server", tag: "cache", message: `Evicted expired entry: ${meta.key}` });
      }
    } catch {}
  }
}

function findCache(keys: string[], version: string): { cacheId: number; entry: CacheEntry } | null {
  const dir = getCacheDir();
  const metaFiles = readdirSync(dir).filter(f => f.endsWith(".json"));

  for (const key of keys) {
    for (const metaFile of metaFiles) {
      try {
        const meta: CacheEntry = JSON.parse(readFileSync(join(dir, metaFile), "utf8"));
        if (!meta.committed || isCacheExpired(meta)) continue;
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
        if (!meta.committed || isCacheExpired(meta)) continue;
        if (meta.key.startsWith(key) && meta.version === version) {
          const cacheId = parseInt(metaFile.replace("cache-", "").replace(".json", ""));
          return { cacheId, entry: meta };
        }
      } catch { continue; }
    }
  }

  return null;
}

export function cacheRoutes(ctx: RunContext) {
  return {
    "/_apis/artifactcache/cache": {
      GET: (req: Request) => {
        const url = new URL(req.url);
        const keys = url.searchParams.get("keys")?.split(",") || [];
        const version = url.searchParams.get("version") || "";
        ctx.output.emit({ type: "server", tag: "cache", message: `Lookup keys=${keys.join(",")} version=${version.slice(0, 12)}` });

        const found = findCache(keys, version);
        if (found) {
          ctx.output.emit({ type: "server", tag: "cache", message: `Hit: ${found.entry.key} (id=${found.cacheId})` });
          return Response.json({
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
      },
    },
    "/_apis/artifactcache/download/:id": {
      GET: (req: Request & { params: { id: string } }) => {
        const cacheId = parseInt(req.params.id);
        const filePath = cacheEntryPath(cacheId);
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
      },
    },
    "/_apis/artifactcache/caches": {
      POST: async (req: Request) => {
        const body = (await req.json()) as any;
        const cacheId = nextCacheId++;
        const entry: CacheEntry = {
          key: body.key,
          version: body.version || "",
          committed: false,
          filePath: cacheEntryPath(cacheId),
          size: 0,
          createdAt: new Date().toISOString(),
        };
        await Bun.write(cacheMetaPath(cacheId), JSON.stringify(entry));
        ctx.output.emit({ type: "server", tag: "cache", message: `Reserved id=${cacheId} key=${body.key}` });
        return Response.json({ cacheId });
      },
    },
    "/_apis/artifactcache/caches/:id": {
      PATCH: async (req: Request & { params: { id: string } }) => {
        const cacheId = parseInt(req.params.id);
        const data = await req.arrayBuffer();
        const filePath = cacheEntryPath(cacheId);
        const contentRange = req.headers.get("Content-Range");
        ctx.output.emit({ type: "server", tag: "cache", message: `Upload id=${cacheId} size=${data.byteLength} range=${contentRange || "full"}` });

        if (contentRange) {
          const match = contentRange.match(/bytes (\d+)-(\d+)\//);
          if (match) {
            const start = parseInt(match[1]);
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
      },
      POST: async (req: Request & { params: { id: string } }) => {
        const cacheId = parseInt(req.params.id);
        const body = (await req.json()) as any;
        const metaPath = cacheMetaPath(cacheId);

        if (existsSync(metaPath)) {
          const meta: CacheEntry = JSON.parse(readFileSync(metaPath, "utf8"));
          meta.committed = true;
          meta.size = body.size || 0;

          const dir = getCacheDir();
          for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
            const fPath = join(dir, f);
            if (fPath === metaPath) continue;
            try {
              const existing: CacheEntry = JSON.parse(readFileSync(fPath, "utf8"));
              if (existing.key === meta.key && existing.version === meta.version) {
                const oldId = parseInt(f.replace("cache-", "").replace(".json", ""));
                removeCacheEntry(oldId);
              }
            } catch {}
          }

          await Bun.write(metaPath, JSON.stringify(meta));
          ctx.output.emit({ type: "server", tag: "cache", message: `Committed id=${cacheId} key=${meta.key} size=${meta.size}` });
        }
        return new Response(null, { status: 204 });
      },
    },
  };
}
