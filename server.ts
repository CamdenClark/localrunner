import { randomUUID } from "crypto";
import { buildGitHubContextData } from "./context";
import type { RepoContext } from "./context";

export interface ServerConfig {
  port: number;
  repoCtx: RepoContext;
  jobSteps: object[];
  eventName: string;
  eventPayload: object;
  workflowName: string;
  jobName: string;
}

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  jobCompleted: Promise<void>;
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
  return {
    type: "Action",
    reference: {
      type: "Repository",
      name: action,
      ref: ref,
      repositoryType: "GitHub",
      path: "",
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
): Promise<Record<string, object>> {
  const result: Record<string, object> = {};

  for (const { action, version, path } of actions) {
    const key = `${action}@${version}`;
    console.log(`[actions] Resolving ${key}...`);

    try {
      const refRes = await fetch(
        `https://api.github.com/repos/${action}/git/ref/tags/${version}`,
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
          `https://api.github.com/repos/${action}/git/ref/heads/${version}`,
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
        tar_url: `https://api.github.com/repos/${action}/tarball/${sha}`,
        zip_url: `https://api.github.com/repos/${action}/zipball/${sha}`,
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
        tar_url: `https://api.github.com/repos/${action}/tarball/${version}`,
        zip_url: `https://api.github.com/repos/${action}/zipball/${version}`,
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

// --- Server factory ---

export function createServer(config: ServerConfig): ServerHandle {
  const { port, repoCtx, jobSteps, eventName, eventPayload, workflowName, jobName } = config;

  const SESSION_ID = randomUUID();
  const PLAN_ID = randomUUID();
  const TIMELINE_ID = randomUUID();
  const JOB_ID = randomUUID();

  let jobDispatched = false;
  let jobDone = false;

  let resolveJobCompleted: () => void;
  const jobCompleted = new Promise<void>((resolve) => {
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
            accessPoint: `http://localhost:${port}/`,
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
            url: `http://localhost:${port}/`,
            authorization: {
              scheme: "OAuth",
              parameters: { AccessToken: LOCAL_JWT },
            },
            data: {},
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
              url: `https://github.com/${repoCtx.fullName}`,
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
            { k: "os", v: "macOS" },
            { k: "arch", v: "ARM64" },
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
          value: `http://localhost:${port}`,
        },
      },
      mask: [],
      steps,
      workspace: { clean: null },
      fileTable: [],
    };
  }

  const server = Bun.serve({
    port,
    routes: {
      "/_apis/oauth2/token": {
        POST: async () => {
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
    },

    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      console.log(`[${method}] ${path}${url.search}`);

      if (method === "POST" && path === "/session") {
        console.log("[session] Created");
        return Response.json({
          sessionId: SESSION_ID,
          ownerName: "local",
          agent: { id: 1, name: "local-runner", version: "2.332.0" },
          encryptionKey: null,
        });
      }

      if (method === "DELETE" && path === "/session") {
        console.log("[session] Deleted");
        return Response.json({});
      }

      if (method === "GET" && path === "/message") {
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
              run_service_url: `http://localhost:${port}`,
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
      }

      if (method === "POST" && path === "/acknowledge") {
        return Response.json({});
      }

      if (method === "POST" && path === "/acquirejob") {
        console.log("[job] Job acquired");
        return Response.json(buildJobMessage(jobSteps));
      }

      if (method === "POST" && path === "/renewjob") {
        return Response.json({
          lockedUntil: new Date(Date.now() + 3600000).toISOString(),
        });
      }

      if (method === "POST" && path === "/completejob") {
        jobDone = true;
        console.log("[job] Job completed!");
        resolveJobCompleted!();
        return Response.json({});
      }

      if (method === "POST" && path.includes("/runnerresolve/actions")) {
        const body = (await req.json()) as any;
        const actions = (body.actions || []).map((a: any) => ({
          action: a.action || a.name,
          version: a.version || a.ref,
          path: a.path || "",
        }));
        const resolved = await resolveActions(actions, repoCtx.token);
        return Response.json({ actions: resolved });
      }

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
                  const results = [
                    "Succeeded",
                    "SucceededWithIssues",
                    "Failed",
                    "Cancelled",
                    "Skipped",
                    "Abandoned",
                  ];
                  const state = states[record.state] || record.state;
                  const result =
                    record.result != null
                      ? results[record.result] || record.result
                      : "";
                  console.log(
                    `  [step] ${record.name}: ${state}${result ? ` (${result})` : ""}`,
                  );
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

      if (path.includes("/logs")) {
        if (method === "POST" && !path.match(/\/logs\/\d+/)) {
          return Response.json({ id: 1, path: "logs/1" });
        }
        if (method === "POST" && path.match(/\/logs\/\d+/)) {
          req.text().then((text) => {
            for (const line of text.split("\n")) {
              if (line.trim()) console.log(`  [log] ${line.trim()}`);
            }
          });
          return Response.json({ id: 1, path: "logs/1" });
        }
      }

      if (path.includes("/feed")) {
        req.text().then((text) => {
          for (const line of text.split("\n")) {
            if (line.trim()) console.log(`  [feed] ${line.trim()}`);
          }
        });
        return Response.json({});
      }

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
