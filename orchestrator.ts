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
  dockerImage?: string;
}

function buildJitConfig(port: number, hostAddress: string): string {
  const serverUrl = `http://${hostAddress}:${port}`;
  const runnerConfig = JSON.stringify({
    AgentId: 1,
    AgentName: "local-runner",
    PoolId: 1,
    PoolName: "default",
    ServerUrl: serverUrl,
    ServerUrlV2: serverUrl,
    GitHubUrl: serverUrl,
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

export async function startRun(config: RunConfig): Promise<string> {
  const { port, repoCtx, jobSteps, eventName, eventPayload, workflowName, jobName, runnerDir, secrets, variables, dockerImage } = config;

  const isDocker = !!dockerImage;
  const hostAddress = isDocker ? "host.docker.internal" : "localhost";

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
    hostAddress,
    runnerOs: isDocker ? "Linux" : "macOS",
    runnerArch: isDocker ? "X64" : "ARM64",
  });

  const jitconfig = buildJitConfig(port, hostAddress);

  // Create Docker network if running in Docker mode
  let networkName: string | undefined;
  if (isDocker) {
    networkName = `localrunner-${Date.now()}`;
    const netProc = Bun.spawnSync(["docker", "network", "create", networkName]);
    if (netProc.exitCode !== 0) {
      console.error(`Failed to create Docker network: ${netProc.stderr.toString()}`);
      server.stop(true);
      process.exit(1);
    }
  }

  console.log(isDocker ? `Starting runner in Docker (${dockerImage})...\n` : "Starting runner...\n");

  let proc: ReturnType<typeof Bun.spawn>;

  if (isDocker) {
    const dockerArgs = [
      "docker", "run", "--rm",
      "--network", networkName!,
      "--add-host", "host.docker.internal:host-gateway",
      "-e", "GITHUB_ACTIONS_RUNNER_FORCE_GHES=1",
      "-e", "RUNNER_ALLOW_RUNASROOT=1",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      dockerImage,
      "./run.sh", "--jitconfig", jitconfig,
    ];
    proc = Bun.spawn(dockerArgs, {
      stdout: "inherit",
      stderr: "inherit",
    });
  } else {
    const runnerScript = join(runnerDir, "run.sh");
    proc = Bun.spawn([runnerScript, "--jitconfig", jitconfig], {
      cwd: runnerDir,
      env: {
        ...process.env,
        GITHUB_ACTIONS_RUNNER_FORCE_GHES: "1",
        RUNNER_ALLOW_RUNASROOT: "1",
      },
      stdout: "inherit",
      stderr: "inherit",
    });
  }

  // Wait for either job completion or runner exit
  const runnerExit = proc.exited;

  const conclusion = await Promise.race([
    jobCompleted,
    runnerExit.then(() => "failed" as string),
  ]);

  // Give a moment for final logs to flush
  await new Promise((r) => setTimeout(r, 500));

  // Clean up
  console.log("\nRunner finished. Stopping server...");
  server.stop(true);
  proc.kill();

  // Clean up Docker network
  if (networkName) {
    Bun.spawnSync(["docker", "network", "rm", networkName]);
  }

  // Clean up temp dir
  try {
    const { unlinkSync, rmdirSync } = await import("fs");
    unlinkSync(join(tmpDir, "event.json"));
    rmdirSync(tmpDir);
  } catch {
    // best effort cleanup
  }

  return conclusion;
}
