import { randomUUID } from "crypto";
import { getRepoContext, buildGitHubContextData } from "./context";

const PORT = 9637;
const SESSION_ID = randomUUID();
const PLAN_ID = randomUUID();
const TIMELINE_ID = randomUUID();
const JOB_ID = randomUUID();

let jobDispatched = false;
let jobCompleted = false;

// Resolve repo context from gh CLI + git
const repoCtx = await getRepoContext();
console.log(`Repo: ${repoCtx.fullName} (${repoCtx.sha.slice(0, 8)})`);

function makeJwt(): string {
  const header = Buffer.from(
    JSON.stringify({ typ: "JWT", alg: "HS256" })
  ).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: "local",
      iss: "local",
      aud: "local",
      nbf: now,
      exp: now + 3600,
    })
  ).toString("base64url");
  const sig = Buffer.from("localsignature").toString("base64url");
  return `${header}.${payload}.${sig}`;
}

const LOCAL_JWT = makeJwt();

// --- Step builders ---

function scriptStep(
  script: string,
  displayName?: string
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

function actionStep(
  action: string,
  ref: string,
  displayName?: string,
  inputs?: Record<string, string>
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

// --- Job message ---

function buildJobMessage(steps: object[]): object {
  return {
    messageType: "RunnerJobRequest",
    plan: {
      scopeIdentifier: "00000000-0000-0000-0000-000000000000",
      planType: "Build",
      version: 1,
      planId: PLAN_ID,
      definition: { id: 1, name: "Local Workflow" },
      owner: { id: 1, name: "Local Workflow" },
    },
    timeline: {
      id: TIMELINE_ID,
      changeId: 1,
      location: null,
    },
    jobId: JOB_ID,
    jobDisplayName: "Local Job",
    jobName: "local_job",
    requestId: 1,
    lockedUntil: new Date(Date.now() + 3600000).toISOString(),
    resources: {
      endpoints: [
        {
          id: randomUUID(),
          name: "SystemVssConnection",
          type: "ExternalConnection",
          url: `http://localhost:${PORT}/`,
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
      github: buildGitHubContextData(repoCtx),
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
      "system.github.job": { value: "local_job" },
      "system.github.launch_endpoint": {
        value: `http://localhost:${PORT}`,
      },
    },
    mask: [],
    steps,
    workspace: { clean: null },
    fileTable: [],
  };
}

// --- Action resolution: resolve action refs via GitHub API ---

async function resolveActions(
  actions: { action: string; version: string; path: string }[]
): Promise<Record<string, object>> {
  const result: Record<string, object> = {};

  for (const { action, version, path } of actions) {
    const key = `${action}@${version}`;
    console.log(`[actions] Resolving ${key}...`);

    try {
      // Resolve the ref to a SHA via GitHub API
      const refRes = await fetch(
        `https://api.github.com/repos/${action}/git/ref/tags/${version}`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "localrunner",
            Authorization: `Bearer ${repoCtx.token}`,
          },
        }
      );

      let sha = version;
      if (refRes.ok) {
        const refData = (await refRes.json()) as any;
        sha = refData.object.sha;

        // If it's an annotated tag, dereference to the commit
        if (refData.object.type === "tag") {
          const tagRes = await fetch(refData.object.url, {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "localrunner",
              ...(process.env.GITHUB_TOKEN
                ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
                : {}),
            },
          });
          if (tagRes.ok) {
            const tagData = (await tagRes.json()) as any;
            sha = tagData.object.sha;
          }
        }
      } else {
        // Try as a branch
        const branchRes = await fetch(
          `https://api.github.com/repos/${action}/git/ref/heads/${version}`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "localrunner",
              ...(process.env.GITHUB_TOKEN
                ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
                : {}),
            },
          }
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
          token: repoCtx.token,
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
          token: repoCtx.token,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      };
    }
  }

  return result;
}

// --- Connection data ---

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
          accessPoint: `http://localhost:${PORT}/`,
          displayName: "Host Guid Access Mapping",
        },
      ],
      serviceDefinitions: [],
    },
  };
}

// --- Define the job steps ---

const jobSteps: object[] = [
  actionStep("actions/checkout", "v4", "Checkout"),
  scriptStep("echo 'Hello from local GitHub Actions runner!'"),
  scriptStep("ls -la"),
];

// --- Server ---

Bun.serve({
  port: PORT,
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

    // --- Broker endpoints ---

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
            run_service_url: `http://localhost:${PORT}`,
            should_acknowledge: false,
            billing_owner_id: "",
          }),
        });
      }
      if (jobCompleted) {
        return new Response(null, { status: 200 });
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve(new Response(null, { status: 200 })), 5000);
      });
    }

    if (method === "POST" && path === "/acknowledge") {
      return Response.json({});
    }

    // --- Run service endpoints ---

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
      jobCompleted = true;
      console.log("[job] Job completed!");
      return Response.json({});
    }

    // --- Action resolution ---
    // POST /actions/build/{planId}/jobs/{jobId}/runnerresolve/actions
    if (method === "POST" && path.includes("/runnerresolve/actions")) {
      const body = (await req.json()) as any;
      const actions = (body.actions || []).map((a: any) => ({
        action: a.action || a.name,
        version: a.version || a.ref,
        path: a.path || "",
      }));
      const resolved = await resolveActions(actions);
      return Response.json({ actions: resolved });
    }

    // --- Feedback endpoints ---

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
                  `  [step] ${record.name}: ${state}${result ? ` (${result})` : ""}`
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

    // Catch-all
    console.log(`[unhandled] ${method} ${path}`);
    return Response.json({});
  },
});

console.log(`Local Actions server listening on http://localhost:${PORT}`);
console.log(`Session: ${SESSION_ID}`);
console.log(`Job: ${JOB_ID}`);
console.log("Waiting for runner to connect...\n");
