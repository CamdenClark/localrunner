import { createServer, type ServerConfig } from "./server";
import { tmpdir } from "os";
import { join } from "path";
import type { Service } from "./workflow";

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
  services?: Record<string, Service>;
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

export interface RunResult {
  conclusion: string;
  logs: string[];
}

export async function startRun(config: RunConfig): Promise<RunResult> {
  const { port, repoCtx, jobSteps, eventName, eventPayload, workflowName, jobName, runnerDir, secrets, variables, dockerImage, services } = config;

  const isDocker = !!dockerImage;
  const hostAddress = isDocker ? "host.docker.internal" : "localhost";

  // Write event.json to a temp directory for the runner
  const tmpDir = join(tmpdir(), `localrunner-${Date.now()}`);
  await Bun.write(join(tmpDir, "event.json"), JSON.stringify(eventPayload, null, 2));

  // Start the mock server
  const { server, jobCompleted, logs } = createServer({
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

  // Start service containers
  const serviceContainerIds: string[] = [];
  if (isDocker && services && networkName) {
    for (const [serviceName, serviceConfig] of Object.entries(services)) {
      console.log(`Starting service '${serviceName}' (${serviceConfig.image})...`);
      const args = [
        "docker", "run", "-d", "--rm",
        "--network", networkName,
        "--network-alias", serviceName,
        "--name", `${networkName}-${serviceName}`,
      ];

      // Add environment variables
      if (serviceConfig.env) {
        for (const [key, value] of Object.entries(serviceConfig.env)) {
          args.push("-e", `${key}=${value}`);
        }
      }

      // Add port mappings
      if (serviceConfig.ports) {
        for (const port of serviceConfig.ports) {
          args.push("-p", String(port));
        }
      }

      // Add volume mounts
      if (serviceConfig.volumes) {
        for (const vol of serviceConfig.volumes) {
          args.push("-v", vol);
        }
      }

      // Add extra docker options (respecting quoted strings)
      if (serviceConfig.options) {
        const optionTokens: string[] = [];
        const regex = /"([^"]*)"|\S+/g;
        let match;
        while ((match = regex.exec(serviceConfig.options)) !== null) {
          optionTokens.push(match[1] ?? match[0]);
        }
        args.push(...optionTokens);
      }

      args.push(serviceConfig.image);

      const svcProc = Bun.spawnSync(args);
      if (svcProc.exitCode !== 0) {
        console.error(`Failed to start service '${serviceName}': ${svcProc.stderr.toString()}`);
        // Clean up any already-started services
        for (const id of serviceContainerIds) {
          Bun.spawnSync(["docker", "rm", "-f", id]);
        }
        if (networkName) Bun.spawnSync(["docker", "network", "rm", networkName]);
        server.stop(true);
        process.exit(1);
      }
      const containerId = svcProc.stdout.toString().trim();
      serviceContainerIds.push(containerId);
    }

    // Wait briefly for services to initialize
    await new Promise((r) => setTimeout(r, 2000));
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
      stdout: "pipe",
      stderr: "pipe",
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
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  // Stream runner output to console and collect in logs
  async function pipeStream(stream: ReadableStream<Uint8Array> | null, prefix: string) {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const msg = `  [runner${prefix}] ${line}`;
        console.log(msg);
        logs.push(msg);
      }
    }
    if (buffer) {
      const msg = `  [runner${prefix}] ${buffer}`;
      console.log(msg);
      logs.push(msg);
    }
  }

  const stdoutPipe = pipeStream(proc.stdout as ReadableStream<Uint8Array>, "");
  const stderrPipe = pipeStream(proc.stderr as ReadableStream<Uint8Array>, ":err");

  // Wait for either job completion or runner exit
  const runnerExit = proc.exited;

  const conclusion = await Promise.race([
    jobCompleted,
    runnerExit.then(() => "failed" as string),
  ]);

  // Wait for output streams to finish
  await Promise.allSettled([stdoutPipe, stderrPipe]);

  // Give a moment for final logs to flush
  await new Promise((r) => setTimeout(r, 500));

  // Clean up
  console.log("\nRunner finished. Stopping server...");
  server.stop(true);
  proc.kill();

  // Clean up service containers
  for (const id of serviceContainerIds) {
    Bun.spawnSync(["docker", "rm", "-f", id]);
  }

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

  return { conclusion, logs };
}
