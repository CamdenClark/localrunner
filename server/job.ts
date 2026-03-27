import { randomUUID } from "crypto";
import type { Hono } from "hono";
import type { ServerEnv } from "./hono";
import { buildGitHubContextData } from "../context";
import type { RunContext } from "./types";
import { getDb } from "../db";
import { runs, jobs } from "../db/schema";
import { eq } from "drizzle-orm";

export function registerJobRoutes(app: Hono<ServerEnv>, ctx: RunContext) {
  app.get("/message", (c) => {
    if (!ctx.jobDispatched) {
      ctx.jobDispatched = true;
      ctx.output.emit({ type: "server", tag: "message", message: "Dispatching job!" });
      return c.json({
        messageId: 1,
        messageType: "RunnerJobRequest",
        iv: null,
        body: JSON.stringify({
          id: "msg-1",
          runner_request_id: "req-1",
          run_service_url: ctx.serverBaseUrl,
          should_acknowledge: false,
          billing_owner_id: "",
        }),
      });
    }
    if (ctx.jobDone) {
      return new Response(null, { status: 200 });
    }
    return new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(null, { status: 200 })), 5000);
    });
  });

  app.post("/acknowledge", (c) => c.json({}));

  app.post("/acquirejob", (c) => {
    ctx.output.emit({ type: "server", tag: "job", message: "Job acquired" });
    return c.json(buildJobMessage(ctx));
  });

  app.post("/renewjob", (c) =>
    c.json({
      lockedUntil: new Date(Date.now() + 3600000).toISOString(),
    })
  );

  app.post("/completejob", async (c) => {
    ctx.jobDone = true;
    const body = (await c.req.json()) as any;
    const conclusion = body.conclusion || "unknown";

    // Capture job outputs from the runner's completion message
    if (body.outputVariables) {
      for (const [key, val] of Object.entries(body.outputVariables)) {
        ctx.jobOutputs[key] = typeof val === "object" && val !== null ? (val as any).value ?? String(val) : String(val);
      }
    }
    if (body.outputs) {
      for (const [key, val] of Object.entries(body.outputs)) {
        ctx.jobOutputs[key] = typeof val === "object" && val !== null ? (val as any).value ?? String(val) : String(val);
      }
    }

    ctx.output.emit({ type: "server", tag: "job", message: `Job completed (${conclusion})` });
    ctx.output.emit({ type: "job_complete", conclusion });

    ctx.output.flushAllLogs();
    try {
      const db = getDb();
      const now = Date.now();
      db.update(jobs)
        .set({ status: "completed", conclusion, completedAt: now })
        .where(eq(jobs.id, ctx.jobId))
        .run();
      db.update(runs)
        .set({ status: "completed", conclusion, completedAt: now })
        .where(eq(runs.id, ctx.runId))
        .run();
    } catch {}

    ctx.resolveJobCompleted(conclusion);
    return c.json({});
  });
}

function buildJobMessage(ctx: RunContext): object {
  // Compute the runner workspace path
  // Docker runners use host.docker.internal and run from /home/runner
  const isDocker = ctx.hostAddress === "host.docker.internal";
  const workspace = isDocker
    ? `/home/runner/_work/${ctx.repoCtx.repo}/${ctx.repoCtx.repo}`
    : "";
  return {
    messageType: "RunnerJobRequest",
    plan: {
      scopeIdentifier: "00000000-0000-0000-0000-000000000000",
      planType: "Build",
      version: 1,
      planId: ctx.planId,
      definition: { id: 1, name: ctx.workflowName },
      owner: { id: 1, name: ctx.workflowName },
    },
    timeline: {
      id: ctx.timelineId,
      changeId: 1,
      location: null,
    },
    jobId: ctx.jobId,
    jobDisplayName: ctx.jobName,
    jobName: ctx.jobName.replace(/[^a-zA-Z0-9_]/g, "_"),
    requestId: 1,
    lockedUntil: new Date(Date.now() + 3600000).toISOString(),
    resources: {
      endpoints: [
        {
          id: randomUUID(),
          name: "SystemVssConnection",
          type: "ExternalConnection",
          url: `${ctx.serverBaseUrl}/`,
          authorization: {
            scheme: "OAuth",
            parameters: { AccessToken: ctx.jwt },
          },
          data: {
            CacheServerUrl: `${ctx.serverBaseUrl}/`,
            ResultsServiceUrl: `${ctx.serverBaseUrl}/`,
            FeedStreamUrl: `ws://${ctx.hostAddress}:${ctx.port}/feed`,
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
            url: `${ctx.repoCtx.serverUrl}/${ctx.repoCtx.fullName}`,
            version: ctx.repoCtx.ref,
          },
        },
      ],
    },
    contextData: {
      github: buildGitHubContextData(ctx.repoCtx, ctx.eventName, ctx.eventPayload, ctx.workflowName, ctx.jobName, ctx.runId, workspace),
      strategy: {
        t: 2,
        d: [
          { k: "fail-fast", v: String(ctx.strategy.failFast) },
          { k: "job-index", v: String(ctx.strategy.jobIndex) },
          { k: "job-total", v: String(ctx.strategy.jobTotal) },
          ...(ctx.strategy.maxParallel != null ? [{ k: "max-parallel", v: String(ctx.strategy.maxParallel) }] : []),
        ],
      },
      matrix: {
        t: 2,
        d: Object.entries(ctx.matrix).map(([k, v]) => ({ k, v })),
      },
      inputs: {
        t: 2,
        d: Object.entries(ctx.inputs).map(([k, v]) => ({ k, v })),
      },
      needs: {
        t: 2,
        d: Object.entries(ctx.needs).map(([jobId, need]) => ({
          k: jobId,
          v: {
            t: 2,
            d: [
              { k: "result", v: need.result },
              {
                k: "outputs",
                v: {
                  t: 2,
                  d: Object.entries(need.outputs).map(([k, v]) => ({ k, v })),
                },
              },
            ],
          },
        })),
      },
      job: { t: 2, d: [] },
      runner: {
        t: 2,
        d: [
          { k: "os", v: ctx.runnerOs },
          { k: "arch", v: ctx.runnerArch },
          { k: "name", v: "local-runner" },
          { k: "tool_cache", v: "" },
          { k: "temp", v: ctx.runnerOs === "Windows" ? (process.env["TEMP"] || "C:\\Windows\\Temp") : "/tmp" },
          { k: "workspace", v: workspace },
          { k: "debug", v: "" },
        ],
      },
    },
    variables: {
      "system.culture": { value: "en-US" },
      "system.defaultWorkingDirectory": { value: workspace },
      "system.github.workspace": { value: workspace },
      "system.github.token": { value: ctx.repoCtx.token, isSecret: true },
      "system.github.job": { value: ctx.jobName.replace(/[^a-zA-Z0-9_]/g, "_") },
      "system.github.launch_endpoint": {
        value: ctx.serverBaseUrl,
      },
      "system.github.results_endpoint": {
        value: ctx.serverBaseUrl,
      },
      "system.github.workflow_run_backend_id": {
        value: ctx.runId,
      },
      "system.github.workflow_job_run_backend_id": {
        value: ctx.jobId,
      },
      ...Object.fromEntries(
        Object.entries(ctx.secrets).map(([k, v]) => [`secrets.${k}`, { value: v, isSecret: true }]),
      ),
      ...Object.fromEntries(
        Object.entries(ctx.variables).map(([k, v]) => [`vars.${k}`, { value: v }]),
      ),
    },
    mask: [
      ...Object.values(ctx.secrets).filter((v) => v.length > 0).map((v) => ({ type: "regex", value: v })),
    ],
    steps: ctx.jobSteps,
    workspace: { clean: null },
    fileTable: [],
  };
}
