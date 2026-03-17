import { createServer, type ServerConfig } from "./server";
import { tmpdir } from "os";
import { join } from "path";

export interface RunConfig {
  port: number;
  repoCtx: ServerConfig["repoCtx"];
  jobSteps: object[];
  eventName: string;
  eventPayload: object;
  workflowName: string;
  jobName: string;
  runnerDir: string;
  secrets?: Record<string, string>;
  variables?: Record<string, string>;
}

function buildJitConfig(port: number): string {
  const runnerConfig = JSON.stringify({
    AgentId: 1,
    AgentName: "local-runner",
    PoolId: 1,
    PoolName: "default",
    ServerUrl: `http://localhost:${port}`,
    ServerUrlV2: `http://localhost:${port}`,
    GitHubUrl: `http://localhost:${port}`,
    UseV2Flow: true,
    WorkFolder: "_work",
    Ephemeral: true,
    DisableUpdate: true,
  });

  const credsConfig = JSON.stringify({
    Scheme: "OAuthAccessToken",
    Data: { token: "local-token" },
  });

  const jitPayload = JSON.stringify({
    ".runner": Buffer.from(runnerConfig).toString("base64"),
    ".credentials": Buffer.from(credsConfig).toString("base64"),
  });

  return Buffer.from(jitPayload).toString("base64");
}

export async function startRun(config: RunConfig): Promise<void> {
  const { port, repoCtx, jobSteps, eventName, eventPayload, workflowName, jobName, runnerDir, secrets, variables } = config;

  // Write event.json to a temp directory for the runner
  const tmpDir = join(tmpdir(), `localrunner-${Date.now()}`);
  await Bun.write(join(tmpDir, "event.json"), JSON.stringify(eventPayload, null, 2));

  // Start the mock server
  const { server, jobCompleted } = createServer({
    port,
    repoCtx,
    jobSteps,
    eventName,
    eventPayload,
    workflowName,
    jobName,
    secrets,
    variables,
  });

  const jitconfig = buildJitConfig(port);

  console.log("Starting runner...\n");

  const runnerScript = join(runnerDir, "run.sh");
  const proc = Bun.spawn([runnerScript, "--jitconfig", jitconfig], {
    cwd: runnerDir,
    env: {
      ...process.env,
      GITHUB_ACTIONS_RUNNER_FORCE_GHES: "1",
      RUNNER_ALLOW_RUNASROOT: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  // Wait for either job completion or runner exit
  const runnerExit = proc.exited;

  await Promise.race([jobCompleted, runnerExit]);

  // Give a moment for final logs to flush
  await new Promise((r) => setTimeout(r, 500));

  // Clean up
  console.log("\nRunner finished. Stopping server...");
  server.stop(true);
  proc.kill();

  // Clean up temp dir
  try {
    const { unlinkSync, rmdirSync } = await import("fs");
    unlinkSync(join(tmpDir, "event.json"));
    rmdirSync(tmpDir);
  } catch {
    // best effort cleanup
  }
}
