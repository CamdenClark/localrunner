import { randomUUID } from "crypto";
import type { RepoContext } from "../context";
import { OutputHandler } from "../output";
import { getDb } from "../db";
import { runs, jobs } from "../db/schema";

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
  matrix?: Record<string, string>;
  runnerOs?: string;
  runnerArch?: string;
  output?: OutputHandler;
}

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  jobCompleted: Promise<string>;
  output: OutputHandler;
}

export interface RunContext {
  port: number;
  repoCtx: RepoContext;
  jobSteps: object[];
  eventName: string;
  eventPayload: object;
  workflowName: string;
  jobName: string;
  secrets: Record<string, string>;
  variables: Record<string, string>;
  matrix: Record<string, string>;
  hostAddress: string;
  serverBaseUrl: string;
  runnerOs: string;
  runnerArch: string;
  output: OutputHandler;

  runId: string;
  sessionId: string;
  planId: string;
  timelineId: string;
  jobId: string;
  jwt: string;

  jobDispatched: boolean;
  jobDone: boolean;
  resolveJobCompleted: (conclusion: string) => void;

  /** Cached per-run Hono app (set lazily by the multi-run server) */
  _app?: import("hono").Hono;
}

export function createRunContext(config: ServerConfig): { ctx: RunContext; jobCompleted: Promise<string> } {
  const hostAddress = config.hostAddress || "localhost";
  const port = config.port;
  const serverBaseUrl = `http://${hostAddress}:${port}`;
  const output = config.output ?? new OutputHandler("verbose");

  let resolveJobCompleted!: (conclusion: string) => void;
  const jobCompleted = new Promise<string>((resolve) => {
    resolveJobCompleted = resolve;
  });

  const runId = randomUUID();
  const jobId = randomUUID();

  const ctx: RunContext = {
    port,
    repoCtx: config.repoCtx,
    jobSteps: config.jobSteps,
    eventName: config.eventName,
    eventPayload: config.eventPayload,
    workflowName: config.workflowName,
    jobName: config.jobName,
    secrets: config.secrets || {},
    variables: config.variables || {},
    matrix: config.matrix || {},
    hostAddress,
    serverBaseUrl,
    runnerOs: config.runnerOs || "macOS",
    runnerArch: config.runnerArch || "ARM64",
    output,

    runId: runId,
    sessionId: randomUUID(),
    planId: randomUUID(),
    timelineId: randomUUID(),
    jobId: jobId,
    jwt: makeJwt(runId, jobId),

    jobDispatched: false,
    jobDone: false,
    resolveJobCompleted,
  };

  output.runId = runId;
  output.jobId = jobId;
  output.setStepMapping(config.jobSteps);

  try {
    const db = getDb();
    const now = Date.now();
    db.insert(runs)
      .values({
        id: runId,
        workflowName: config.workflowName,
        jobName: config.jobName,
        eventName: config.eventName,
        eventPayload: JSON.stringify(config.eventPayload),
        repoOwner: config.repoCtx.owner,
        repoName: config.repoCtx.repo,
        repoFullName: config.repoCtx.fullName,
        sha: config.repoCtx.sha,
        ref: config.repoCtx.ref,
        status: "in_progress",
        startedAt: now,
      })
      .run();
    db.insert(jobs)
      .values({
        id: jobId,
        runId,
        name: config.jobName,
        status: "in_progress",
        startedAt: now,
      })
      .run();
  } catch {}

  return { ctx, jobCompleted };
}

function makeJwt(runId: string, jobId: string): string {
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
      scp: `Actions.Results:${runId}:${jobId}`,
    }),
  ).toString("base64url");
  const sig = Buffer.from("localsignature").toString("base64url");
  return `${header}.${payload}.${sig}`;
}
