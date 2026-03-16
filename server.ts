import { randomUUID } from "crypto";

const PORT = 9637;
const SESSION_ID = randomUUID();
const PLAN_ID = randomUUID();
const TIMELINE_ID = randomUUID();
const JOB_ID = randomUUID();
const STEP_ID = randomUUID();

let jobDispatched = false;
let jobCompleted = false;

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
  // Fake signature — runner parses but doesn't verify
  const sig = Buffer.from("localsignature").toString("base64url");
  return `${header}.${payload}.${sig}`;
}

const LOCAL_JWT = makeJwt();

// The job message the runner will execute
function buildJobMessage(): object {
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
            url: `file://${process.cwd()}`,
            version: "main",
          },
        },
      ],
    },
    contextData: {
      github: {
        t: 2,
        d: [
          { k: "repository", v: "local/localrunner" },
          { k: "repository_owner", v: "local" },
          { k: "sha", v: "0000000000000000000000000000000000000000" },
          { k: "ref", v: "refs/heads/main" },
          { k: "event_name", v: "push" },
          { k: "workflow", v: "Local Workflow" },
          { k: "run_id", v: "1" },
          { k: "run_number", v: "1" },
          { k: "actor", v: "local" },
          { k: "event", v: { t: 2, d: [] } },
          { k: "server_url", v: `http://localhost:${PORT}` },
          { k: "api_url", v: `http://localhost:${PORT}/api` },
        ],
      },
    },
    variables: {
      "system.culture": { value: "en-US" },
      "system.github.token": { value: LOCAL_JWT, isSecret: true },
      "system.github.job": { value: "local_job" },
    },
    mask: [],
    steps: [
      {
        type: "Action",
        reference: { type: "Script" },
        id: STEP_ID,
        name: "__run",
        displayName: "Run echo hello world",
        contextName: "run_echo",
        condition: "success()",
        inputs: {
          type: 2,
          map: [
            {
              Key: "script",
              Value: "echo 'Hello from local GitHub Actions runner!'",
            },
          ],
        },
      },
    ],
    workspace: { clean: null },
    fileTable: [],
  };
}

// Connection data with route templates for the VSS SDK
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

Bun.serve({
  port: PORT,
  routes: {
    // OAuth token endpoint
    "/_apis/oauth2/token": {
      POST: async (req) => {
        console.log("[auth] Token request");
        return Response.json({
          access_token: LOCAL_JWT,
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
    },

    // Connection data (bootstrap)
    "/_apis/connectionData": {
      GET: (req) => {
        console.log("[connect] Connection data request");
        return Response.json(buildConnectionData());
      },
    },
  },

  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    console.log(`[${method}] ${path}${url.search}`);

    // --- Broker endpoints ---

    // Create session
    if (method === "POST" && path === "/session") {
      console.log("[session] Created session", SESSION_ID);
      return Response.json({
        sessionId: SESSION_ID,
        ownerName: "local",
        agent: { id: 1, name: "local-runner", version: "2.332.0" },
        encryptionKey: null,
      });
    }

    // Delete session
    if (method === "DELETE" && path === "/session") {
      console.log("[session] Deleted session");
      return Response.json({});
    }

    // Long-poll for messages
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
      // No more messages - long poll (return 200 empty after delay)
      if (jobCompleted) {
        return new Response(null, { status: 200 });
      }
      // Keep the runner waiting
      return new Promise((resolve) => {
        setTimeout(() => resolve(new Response(null, { status: 200 })), 5000);
      });
    }

    // Acknowledge message
    if (method === "POST" && path === "/acknowledge") {
      console.log("[ack] Job acknowledged");
      return Response.json({});
    }

    // --- Run service endpoints ---

    // Acquire job (V2 flow)
    if (method === "POST" && path === "/acquirejob") {
      console.log("[job] Job acquired");
      return Response.json(buildJobMessage());
    }

    // Renew job
    if (method === "POST" && path === "/renewjob") {
      return Response.json({
        lockedUntil: new Date(Date.now() + 3600000).toISOString(),
      });
    }

    // Complete job
    if (method === "POST" && path === "/completejob") {
      jobCompleted = true;
      console.log("[job] Job completed!");
      return Response.json({});
    }

    // --- Feedback endpoints (timelines, logs, etc.) ---

    // Create/get timeline
    if (path.includes("/timelines")) {
      if (method === "POST") {
        console.log("[timeline] Timeline created");
        return Response.json({ id: TIMELINE_ID, changeId: 1, records: [] });
      }
      if (method === "PATCH") {
        // Update timeline records - this is where step status comes through
        req.json().then((body: any) => {
          if (Array.isArray(body.value || body)) {
            for (const record of body.value || body) {
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
                  record.result !== null && record.result !== undefined
                    ? results[record.result] || record.result
                    : "";
                console.log(
                  `  [step] ${record.name}: ${state}${result ? ` (${result})` : ""}`
                );
              }
            }
          }
        });
        return Response.json({
          changeId: 2,
          records: [],
        });
      }
      if (method === "GET") {
        return Response.json({ id: TIMELINE_ID, changeId: 1, records: [] });
      }
    }

    // Create/append logs
    if (path.includes("/logs")) {
      if (method === "POST" && !path.match(/\/logs\/\d+/)) {
        // Create log
        return Response.json({ id: 1, path: "logs/1" });
      }
      if (method === "POST" && path.match(/\/logs\/\d+/)) {
        // Append log lines
        req.text().then((text) => {
          if (text.trim()) {
            for (const line of text.split("\n")) {
              if (line.trim()) console.log(`  [log] ${line.trim()}`);
            }
          }
        });
        return Response.json({ id: 1, path: "logs/1" });
      }
    }

    // Live console feed
    if (path.includes("/feed")) {
      req.text().then((text) => {
        if (text.trim()) {
          for (const line of text.split("\n")) {
            if (line.trim()) console.log(`  [feed] ${line.trim()}`);
          }
        }
      });
      return Response.json({});
    }

    // Plan events (JobStarted, JobCompleted)
    if (path.includes("/events")) {
      req.json().then((body: any) => {
        console.log(`[event] ${body.name || "unknown"}`);
      });
      return Response.json({});
    }

    // Action resolution
    if (path.includes("/actions")) {
      console.log("[actions] Action resolution request (not implemented)");
      return Response.json({ actions: {} });
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
