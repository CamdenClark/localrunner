import { randomUUID } from "crypto";
import { buildGitHubContextData } from "./context";
import type { RepoContext } from "./context";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync, unlinkSync, readFileSync } from "fs";

export interface ServerConfig {
  port: number;
  repoCtx: RepoContext;
  jobSteps: object[];
  eventName: string;
  eventPayload: object;
  workflowName: string;
  jobName: string;
  secrets?: Record<string, string>;
  variables?: Record<string, string>;
  hostAddress?: string;
  runnerOs?: string;
  runnerArch?: string;
}

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  jobCompleted: Promise<string>;
}

// --- Step builders ---

export function scriptStep(
  script: string,
  displayName?: string,
): object {
  return {
    type: "Action",
    reference: { type: "Script" },
    id: randomUUID(),
    name: "__run",
    displayName: displayName || `Run ${script.slice(0, 40)}`,
    contextName: `run_${randomUUID().slice(0, 8)}`,
    condition: "success()",
    inputs: {
      type: 2,
      map: [{ Key: "script", Value: script }],
    },
  };
}

export function actionStep(
  action: string,
  ref: string,
  displayName?: string,
  inputs?: Record<string, string>,
): object {
  const inputMap = inputs
    ? Object.entries(inputs).map(([k, v]) => ({ Key: k, Value: v }))
    : [];

  // Split owner/repo/path into repo name and subpath
  const parts = action.split("/");
  let repoName = action;
  let actionPath = "";
  if (parts.length > 2) {
    repoName = `${parts[0]}/${parts[1]}`;
    actionPath = parts.slice(2).join("/");
  }

  return {
    type: "Action",
    reference: {
      type: "Repository",
      name: repoName,
      ref: ref,
      repositoryType: "GitHub",
      path: actionPath,
    },
    id: randomUUID(),
    name: action,
    displayName: displayName || `Run ${action}@${ref}`,
    contextName: action.replace(/[^a-zA-Z0-9]/g, "_"),
    condition: "success()",
    inputs: {
      type: 2,
      map: inputMap,
    },
  };
}

// --- Action resolution: resolve action refs via GitHub API ---

async function resolveActions(
  actions: { action: string; version: string; path: string }[],
  token: string,
  apiUrl: string,
): Promise<Record<string, object>> {
  const result: Record<string, object> = {};

  for (const { action, version, path } of actions) {
    const key = `${action}@${version}`;
    console.log(`[actions] Resolving ${key}...`);

    try {
      const refRes = await fetch(
        `${apiUrl}/repos/${action}/git/ref/tags/${version}`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "localrunner",
            Authorization: `Bearer ${token}`,
          },
        },
      );

      let sha = version;
      if (refRes.ok) {
        const refData = (await refRes.json()) as any;
        sha = refData.object.sha;

        if (refData.object.type === "tag") {
          const tagRes = await fetch(refData.object.url, {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "localrunner",
              Authorization: `Bearer ${token}`,
            },
          });
          if (tagRes.ok) {
            const tagData = (await tagRes.json()) as any;
            sha = tagData.object.sha;
          }
        }
      } else {
        const branchRes = await fetch(
          `${apiUrl}/repos/${action}/git/ref/heads/${version}`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "localrunner",
              Authorization: `Bearer ${token}`,
            },
          },
        );
        if (branchRes.ok) {
          const branchData = (await branchRes.json()) as any;
          sha = branchData.object.sha;
        }
      }

      console.log(`[actions] Resolved ${key} -> ${sha.slice(0, 12)}`);

      result[key] = {
        name: action,
        resolved_name: action,
        resolved_sha: sha,
        tar_url: `${apiUrl}/repos/${action}/tarball/${sha}`,
        zip_url: `${apiUrl}/repos/${action}/zipball/${sha}`,
        version: version,
        authentication: {
          token,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      };
    } catch (err) {
      console.error(`[actions] Failed to resolve ${key}:`, err);
      result[key] = {
        name: action,
        resolved_name: action,
        resolved_sha: version,
        tar_url: `${apiUrl}/repos/${action}/tarball/${version}`,
        zip_url: `${apiUrl}/repos/${action}/zipball/${version}`,
        version: version,
        authentication: {
          token,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      };
    }
  }

  return result;
}

// --- Cache storage ---

const CACHE_DIR = join(homedir(), ".localrunner", "cache");

interface CacheEntry {
  key: string;
  version: string;
  committed: boolean;
  filePath: string;
  size: number;
  createdAt: string;
}

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

function findCache(keys: string[], version: string): { cacheId: number; entry: CacheEntry } | null {
  const dir = getCacheDir();
  const metaFiles = readdirSync(dir).filter(f => f.endsWith(".json"));

  for (const key of keys) {
    // Exact match first
    for (const metaFile of metaFiles) {
      try {
        const meta: CacheEntry = JSON.parse(readFileSync(join(dir, metaFile), "utf8"));
        if (meta.committed && meta.key === key && meta.version === version) {
          const cacheId = parseInt(metaFile.replace("cache-", "").replace(".json", ""));
          return { cacheId, entry: meta };
        }
      } catch {
        continue;
      }
    }
  }

  // Prefix match (restore-keys behavior)
  for (const key of keys) {
    for (const metaFile of metaFiles) {
      try {
        const meta: CacheEntry = JSON.parse(readFileSync(join(dir, metaFile), "utf8"));
        if (meta.committed && meta.key.startsWith(key) && meta.version === version) {
          const cacheId = parseInt(metaFile.replace("cache-", "").replace(".json", ""));
          return { cacheId, entry: meta };
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

let nextCacheId = Date.now();

// --- Server factory ---

export function createServer(config: ServerConfig): ServerHandle {
  const { port, repoCtx, jobSteps, eventName, eventPayload, workflowName, jobName, secrets, variables } = config;
  const hostAddress = config.hostAddress || "localhost";
  const serverBaseUrl = `http://${hostAddress}:${port}`;
  const runnerOs = config.runnerOs || "macOS";
  const runnerArch = config.runnerArch || "ARM64";

  const SESSION_ID = randomUUID();
  const PLAN_ID = randomUUID();
  const TIMELINE_ID = randomUUID();
  const JOB_ID = randomUUID();

  let jobDispatched = false;
  let jobDone = false;

  let resolveJobCompleted: (conclusion: string) => void;
  const jobCompleted = new Promise<string>((resolve) => {
    resolveJobCompleted = resolve;
  });

  function makeJwt(): string {
    const header = Buffer.from(
      JSON.stringify({ typ: "JWT", alg: "HS256" }),
    ).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        sub: "local",
        iss: "local",
        aud: "local",
        nbf: now,
        exp: now + 3600,
      }),
    ).toString("base64url");
    const sig = Buffer.from("localsignature").toString("base64url");
    return `${header}.${payload}.${sig}`;
  }

  const LOCAL_JWT = makeJwt();

  function buildConnectionData(): object {
    return {
      authenticatedUser: { id: "00000000-0000-0000-0000-000000000001" },
      authorizedUser: { id: "00000000-0000-0000-0000-000000000001" },
      instanceId: "00000000-0000-0000-0000-000000000000",
      locationServiceData: {
        serviceOwner: "00000000-0000-0000-0000-000000000000",
        defaultAccessMappingMoniker: "HostGuidAccessMapping",
        lastChangeId: 1,
        lastChangeId64: 1,
        clientCacheFresh: false,
        accessMappings: [
          {
            moniker: "HostGuidAccessMapping",
            accessPoint: `${serverBaseUrl}/`,
            displayName: "Host Guid Access Mapping",
          },
        ],
        serviceDefinitions: [],
      },
    };
  }

  function buildJobMessage(steps: object[]): object {
    return {
      messageType: "RunnerJobRequest",
      plan: {
        scopeIdentifier: "00000000-0000-0000-0000-000000000000",
        planType: "Build",
        version: 1,
        planId: PLAN_ID,
        definition: { id: 1, name: workflowName },
        owner: { id: 1, name: workflowName },
      },
      timeline: {
        id: TIMELINE_ID,
        changeId: 1,
        location: null,
      },
      jobId: JOB_ID,
      jobDisplayName: jobName,
      jobName: jobName.replace(/[^a-zA-Z0-9_]/g, "_"),
      requestId: 1,
      lockedUntil: new Date(Date.now() + 3600000).toISOString(),
      resources: {
        endpoints: [
          {
            id: randomUUID(),
            name: "SystemVssConnection",
            type: "ExternalConnection",
            url: `${serverBaseUrl}/`,
            authorization: {
              scheme: "OAuth",
              parameters: { AccessToken: LOCAL_JWT },
            },
            data: {
              CacheServerUrl: `${serverBaseUrl}/`,
            },
            isShared: false,
            isReady: true,
          },
        ],
        repositories: [
          {
            alias: "self",
            id: "self",
            properties: {
              id: "github",
              type: "GitHub",
              url: `${repoCtx.serverUrl}/${repoCtx.fullName}`,
              version: repoCtx.ref,
            },
          },
        ],
      },
      contextData: {
        github: buildGitHubContextData(repoCtx, eventName, eventPayload, workflowName, jobName),
        strategy: { t: 2, d: [] },
        matrix: { t: 2, d: [] },
        job: { t: 2, d: [] },
        runner: {
          t: 2,
          d: [
            { k: "os", v: runnerOs },
            { k: "arch", v: runnerArch },
            { k: "name", v: "local-runner" },
            { k: "tool_cache", v: "" },
            { k: "temp", v: "/tmp" },
            { k: "workspace", v: "" },
            { k: "debug", v: "" },
          ],
        },
      },
      variables: {
        "system.culture": { value: "en-US" },
        "system.github.token": { value: repoCtx.token, isSecret: true },
        "system.github.job": { value: jobName.replace(/[^a-zA-Z0-9_]/g, "_") },
        "system.github.launch_endpoint": {
          value: serverBaseUrl,
        },
        ...Object.fromEntries(
          Object.entries(secrets || {}).map(([k, v]) => [`secrets.${k}`, { value: v, isSecret: true }]),
        ),
        ...Object.fromEntries(
          Object.entries(variables || {}).map(([k, v]) => [`vars.${k}`, { value: v }]),
        ),
      },
      mask: [
        ...Object.values(secrets || {}).filter((v) => v.length > 0).map((v) => ({ type: "regex", value: v })),
      ],
      steps,
      workspace: { clean: null },
      fileTable: [],
    };
  }

  const server = Bun.serve({
    port,
    routes: {
      // --- Auth & connection ---
      "/_apis/oauth2/token": {
        POST: () => {
          console.log("[auth] Token request");
          return Response.json({
            access_token: LOCAL_JWT,
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      },
      "/_apis/connectionData": {
        GET: () => {
          console.log("[connect] Connection data request");
          return Response.json(buildConnectionData());
        },
      },

      // --- Session ---
      "/session": {
        POST: () => {
          console.log("[session] Created");
          return Response.json({
            sessionId: SESSION_ID,
            ownerName: "local",
            agent: { id: 1, name: "local-runner", version: "2.332.0" },
            encryptionKey: null,
          });
        },
        DELETE: () => {
          console.log("[session] Deleted");
          return Response.json({});
        },
      },

      // --- Message polling ---
      "/message": {
        GET: () => {
          if (!jobDispatched) {
            jobDispatched = true;
            console.log("[message] Dispatching job!");
            return Response.json({
              messageId: 1,
              messageType: "RunnerJobRequest",
              iv: null,
              body: JSON.stringify({
                id: "msg-1",
                runner_request_id: "req-1",
                run_service_url: serverBaseUrl,
                should_acknowledge: false,
                billing_owner_id: "",
              }),
            });
          }
          if (jobDone) {
            return new Response(null, { status: 200 });
          }
          return new Promise((resolve) => {
            setTimeout(() => resolve(new Response(null, { status: 200 })), 5000);
          });
        },
      },

      // --- Job lifecycle ---
      "/acknowledge": { POST: () => Response.json({}) },
      "/acquirejob": {
        POST: () => {
          console.log("[job] Job acquired");
          return Response.json(buildJobMessage(jobSteps));
        },
      },
      "/renewjob": {
        POST: () => Response.json({
          lockedUntil: new Date(Date.now() + 3600000).toISOString(),
        }),
      },
      "/completejob": {
        POST: async (req) => {
          jobDone = true;
          const body = await req.json() as any;
          const conclusion = body.conclusion || "unknown";
          console.log(`[job] Job completed (${conclusion})`);
          if (body.stepResults) {
            for (const step of body.stepResults) {
              if (step.name && step.conclusion) {
                const icon = step.conclusion === "succeeded" ? "✓" : step.conclusion === "skipped" ? "○" : "✗";
                console.log(`  ${icon} ${step.name}: ${step.conclusion}`);
              }
            }
          }
          resolveJobCompleted!(conclusion);
          return Response.json({});
        },
      },

      // --- Cache API ---
      "/_apis/artifactcache/cache": {
        GET: (req) => {
          const url = new URL(req.url);
          const keys = url.searchParams.get("keys")?.split(",") || [];
          const version = url.searchParams.get("version") || "";
          console.log(`[cache] Lookup keys=${keys.join(",")} version=${version.slice(0, 12)}`);

          const found = findCache(keys, version);
          if (found) {
            console.log(`[cache] Hit: ${found.entry.key} (id=${found.cacheId})`);
            return Response.json({
              result: "hit",
              cacheId: found.cacheId,
              scope: "refs/heads/main",
              cacheKey: found.entry.key,
              creationTime: found.entry.createdAt,
              archiveLocation: `${serverBaseUrl}/_apis/artifactcache/download/${found.cacheId}`,
            });
          }
          console.log("[cache] Miss");
          return new Response(null, { status: 204 });
        },
      },
      "/_apis/artifactcache/download/:id": {
        GET: (req) => {
          const cacheId = parseInt(req.params.id);
          const filePath = cacheEntryPath(cacheId);
          console.log(`[cache] Download id=${cacheId}`);
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
        POST: async (req) => {
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
          console.log(`[cache] Reserved id=${cacheId} key=${body.key}`);
          return Response.json({ cacheId });
        },
      },
      "/_apis/artifactcache/caches/:id": {
        PATCH: async (req) => {
          const cacheId = parseInt(req.params.id);
          const data = await req.arrayBuffer();
          const filePath = cacheEntryPath(cacheId);
          const contentRange = req.headers.get("Content-Range");
          console.log(`[cache] Upload id=${cacheId} size=${data.byteLength} range=${contentRange || "full"}`);

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
        POST: async (req) => {
          const cacheId = parseInt(req.params.id);
          const body = (await req.json()) as any;
          const metaPath = cacheMetaPath(cacheId);

          if (existsSync(metaPath)) {
            const meta: CacheEntry = JSON.parse(readFileSync(metaPath, "utf8"));
            meta.committed = true;
            meta.size = body.size || 0;

            // Remove any existing cache with the same key+version
            const dir = getCacheDir();
            for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
              const fPath = join(dir, f);
              if (fPath === metaPath) continue;
              try {
                const existing: CacheEntry = JSON.parse(readFileSync(fPath, "utf8"));
                if (existing.key === meta.key && existing.version === meta.version) {
                  const oldId = parseInt(f.replace("cache-", "").replace(".json", ""));
                  try { unlinkSync(cacheEntryPath(oldId)); } catch {}
                  try { unlinkSync(fPath); } catch {}
                }
              } catch {}
            }

            await Bun.write(metaPath, JSON.stringify(meta));
            console.log(`[cache] Committed id=${cacheId} key=${meta.key} size=${meta.size}`);
          }
          return new Response(null, { status: 204 });
        },
      },
    },

    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      console.log(`[${method}] ${path}${url.search}`);

      // Runner resolve actions (wildcard path with plan/job IDs)
      if (method === "POST" && path.includes("/runnerresolve/actions")) {
        const body = (await req.json()) as any;
        const actions = (body.actions || []).map((a: any) => ({
          action: a.action || a.name,
          version: a.version || a.ref,
          path: a.path || "",
        }));
        const resolved = await resolveActions(actions, repoCtx.token, repoCtx.apiUrl);
        return Response.json({ actions: resolved });
      }

      // Timeline updates (wildcard path with plan/timeline IDs)
      if (path.includes("/timelines")) {
        if (method === "POST") {
          return Response.json({ id: TIMELINE_ID, changeId: 1, records: [] });
        }
        if (method === "PATCH") {
          req.json().then((body: any) => {
            const records = body.value || body;
            if (Array.isArray(records)) {
              for (const record of records) {
                if (record.name && record.state !== undefined) {
                  const states = ["Pending", "InProgress", "Completed"];
                  const results = ["Succeeded", "SucceededWithIssues", "Failed", "Cancelled", "Skipped", "Abandoned"];
                  const state = states[record.state] || record.state;
                  const result = record.result != null ? results[record.result] || record.result : "";
                  console.log(`  [step] ${record.name}: ${state}${result ? ` (${result})` : ""}`);
                }
              }
            }
          });
          return Response.json({ changeId: 2, records: [] });
        }
        if (method === "GET") {
          return Response.json({ id: TIMELINE_ID, changeId: 1, records: [] });
        }
      }

      // Log uploads
      if (path.includes("/logs")) {
        if (method === "POST" && path.match(/\/logs\/\d+/)) {
          req.text().then((text) => {
            for (const line of text.split("\n")) {
              if (line.trim()) console.log(`  [log] ${line.trim()}`);
            }
          });
        }
        return Response.json({ id: 1, path: "logs/1" });
      }

      // Feed
      if (path.includes("/feed")) {
        req.text().then((text) => {
          for (const line of text.split("\n")) {
            if (line.trim()) console.log(`  [feed] ${line.trim()}`);
          }
        });
        return Response.json({});
      }

      // Events
      if (path.includes("/events")) {
        req.json().then((body: any) => {
          console.log(`[event] ${body.name || "unknown"}`);
        });
        return Response.json({});
      }

      console.log(`[unhandled] ${method} ${path}`);
      return Response.json({});
    },
  });

  console.log(`Local Actions server listening on http://localhost:${port}`);
  console.log(`Session: ${SESSION_ID}`);
  console.log(`Job: ${JOB_ID}`);
  console.log("Waiting for runner to connect...\n");

  return { server, jobCompleted };
}
