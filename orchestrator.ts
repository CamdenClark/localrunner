import { createServer, type ServerConfig } from "./server/index";
import { tmpdir } from "os";
import { join } from "path";
import type { Service } from "./workflow";
import { OutputHandler } from "./output";
import type { RunContext } from "./server/types";
import type { RunManager } from "./server/runs";
import { detectOs, detectArch } from "./platform";

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
  matrix?: Record<string, string>;
  strategy?: ServerConfig["strategy"];
  inputs?: Record<string, string>;
  dockerImage?: string;
  services?: Record<string, Service>;
  output?: OutputHandler;
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

/**
 * Launch a runner process and wait for job completion.
 * Shared between ephemeral server mode (startRun) and long-lived server mode (startRunOnServer).
 */
export async function launchRunner(opts: {
  port: number;
  hostAddress: string;
  dockerImage?: string;
  runnerDir: string;
  eventPayload: object;
  services?: Record<string, Service>;
  output: OutputHandler;
  jobCompleted: Promise<string>;
  /** If provided, cleanup won't stop the server */
  stopServer?: () => void;
  /** Called when the run finishes */
  onComplete?: () => void;
}): Promise<RunResult> {
  const { port, hostAddress, dockerImage, runnerDir, eventPayload, services, output, jobCompleted, stopServer, onComplete } = opts;
  const isDocker = !!dockerImage;

  // Write event.json to a temp directory for the runner
  const tmpDir = join(tmpdir(), `localrunner-${Date.now()}`);
  await Bun.write(join(tmpDir, "event.json"), JSON.stringify(eventPayload, null, 2));

  const jitconfig = buildJitConfig(port, hostAddress);

  // Create Docker network if running in Docker mode
  let networkName: string | undefined;
  if (isDocker) {
    networkName = `localrunner-${Date.now()}`;
    const netProc = Bun.spawnSync(["docker", "network", "create", networkName]);
    if (netProc.exitCode !== 0) {
      output.emit({ type: "info", message: `Failed to create Docker network: ${netProc.stderr.toString()}` });
      stopServer?.();
      process.exit(1);
    }
  }

  // Start service containers
  const serviceContainerIds: string[] = [];
  if (isDocker && services && networkName) {
    for (const [serviceName, serviceConfig] of Object.entries(services)) {
      output.emit({ type: "info", message: `Starting service '${serviceName}' (${serviceConfig.image})...` });
      const args = [
        "docker", "run", "-d", "--rm",
        "--network", networkName,
        "--network-alias", serviceName,
        "--name", `${networkName}-${serviceName}`,
      ];

      if (serviceConfig.env) {
        for (const [key, value] of Object.entries(serviceConfig.env)) {
          args.push("-e", `${key}=${value}`);
        }
      }

      if (serviceConfig.ports) {
        for (const p of serviceConfig.ports) {
          args.push("-p", String(p));
        }
      }

      if (serviceConfig.volumes) {
        for (const vol of serviceConfig.volumes) {
          args.push("-v", vol);
        }
      }

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
        output.emit({ type: "info", message: `Failed to start service '${serviceName}': ${svcProc.stderr.toString()}` });
        for (const id of serviceContainerIds) {
          Bun.spawnSync(["docker", "rm", "-f", id]);
        }
        if (networkName) Bun.spawnSync(["docker", "network", "rm", networkName]);
        stopServer?.();
        process.exit(1);
      }
      const containerId = svcProc.stdout.toString().trim();
      serviceContainerIds.push(containerId);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let runnerContainerName: string | undefined;
  let cleanedUp = false;
  let cancelled = false;

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;

    output.emit({ type: "info", message: "\nCleaning up..." });

    if (proc) {
      try { proc.kill(); } catch {}
    }

    if (runnerContainerName) {
      Bun.spawnSync(["docker", "rm", "-f", runnerContainerName]);
    }

    for (const id of serviceContainerIds) {
      Bun.spawnSync(["docker", "rm", "-f", id]);
    }

    if (networkName) {
      Bun.spawnSync(["docker", "network", "rm", networkName]);
    }

    stopServer?.();

    try {
      const fs = require("fs");
      fs.unlinkSync(join(tmpDir, "event.json"));
      fs.rmdirSync(tmpDir);
    } catch {}

    onComplete?.();
  }

  function onSignal() {
    cancelled = true;
    // Kill the runner process to unblock the Promise.race below,
    // letting the normal flow handle cleanup and return the result.
    if (proc) {
      try { proc.kill(); } catch {}
    }
    if (runnerContainerName) {
      try { Bun.spawnSync(["docker", "rm", "-f", runnerContainerName]); } catch {}
    }
  }

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  output.emit({ type: "info", message: isDocker ? `Starting runner in Docker (${dockerImage})...\n` : "Starting runner...\n" });

  if (isDocker) {
    runnerContainerName = `localrunner-runner-${Date.now()}`;
    const dockerArgs = [
      "docker", "run", "--rm",
      "--name", runnerContainerName,
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

  async function pipeStream(stream: ReadableStream<Uint8Array> | null, streamName: "stdout" | "stderr") {
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
        output.emit({ type: "runner", line, stream: streamName });
      }
    }
    if (buffer) {
      output.emit({ type: "runner", line: buffer, stream: streamName });
    }
  }

  const stdoutPipe = pipeStream(proc!.stdout as ReadableStream<Uint8Array>, "stdout");
  const stderrPipe = pipeStream(proc!.stderr as ReadableStream<Uint8Array>, "stderr");

  const runnerExit = proc!.exited;

  const conclusion = await Promise.race([
    jobCompleted,
    runnerExit.then(() => "cancelled" as string),
  ]);

  await Promise.allSettled([stdoutPipe, stderrPipe]);
  await new Promise((r) => setTimeout(r, 500));

  if (!output.jobCompleted) {
    output.markCancelled();
  }

  output.emit({ type: "info", message: cancelled ? "\nRun cancelled." : "\nRunner finished." });
  cleanup();

  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);

  return { conclusion: cancelled ? "cancelled" : conclusion, logs: output.allLogs };
}

/**
 * Start a run with an ephemeral server (original CLI flow).
 * Creates a server, runs the job, stops the server when done.
 */
export async function startRun(config: RunConfig): Promise<RunResult> {
  const { port, repoCtx, jobSteps, eventName, eventPayload, workflowName, jobName, runnerDir, secrets, variables, matrix, strategy, inputs, dockerImage, services, output: configOutput } = config;

  const isDocker = !!dockerImage;
  const hostAddress = isDocker ? "host.docker.internal" : "localhost";

  const { server, jobCompleted, output } = createServer({
    port,
    repoCtx,
    jobSteps,
    eventName,
    eventPayload,
    workflowName,
    jobName,
    secrets,
    variables,
    matrix,
    strategy,
    inputs,
    hostAddress,
    runnerOs: isDocker ? "Linux" : detectOs(),
    runnerArch: isDocker ? "X64" : detectArch(),
    output: configOutput,
  });

  return launchRunner({
    port,
    hostAddress,
    dockerImage,
    runnerDir,
    eventPayload,
    services,
    output,
    jobCompleted,
    stopServer: () => server.stop(true),
  });
}

/**
 * Start a run on the long-lived server (no server creation/teardown).
 * Used by serve.ts when a run is triggered via the API.
 */
export async function startRunOnServer(opts: {
  ctx: RunContext;
  jobCompleted: Promise<string>;
  runManager: RunManager;
  runnerDir: string;
  dockerImage?: string;
  services?: Record<string, Service>;
  output: OutputHandler;
}): Promise<RunResult> {
  const { ctx, jobCompleted, runManager, runnerDir, dockerImage, services, output } = opts;
  const isDocker = !!dockerImage;
  const hostAddress = isDocker ? "host.docker.internal" : "localhost";

  const result = await launchRunner({
    port: ctx.port,
    hostAddress,
    dockerImage,
    runnerDir,
    eventPayload: ctx.eventPayload,
    services,
    output,
    jobCompleted,
    // Don't stop the server — it's long-lived
    stopServer: undefined,
    onComplete: () => runManager.completeRun(ctx.runId),
  });

  // If cancelled and the server-side context doesn't know yet, resolve it
  if (result.conclusion === "cancelled" && !ctx.jobDone) {
    ctx.resolveJobCompleted("cancelled");
  }

  return result;
}

/**
 * Start a run against a remote long-lived server.
 * Used by the CLI when it detects an already-running server.
 *
 * 1. Registers the run on the server via HTTP
 * 2. Connects to SSE for real-time output events
 * 3. Launches the runner locally, pointing at the server
 * 4. Waits for job completion (signaled via SSE)
 */
export async function startRunOnRemoteServer(config: RunConfig): Promise<RunResult> {
  const { port, repoCtx, jobSteps, eventName, eventPayload, workflowName, jobName, runnerDir, secrets, variables, matrix, strategy, inputs, dockerImage, services, output: configOutput } = config;

  const isDocker = !!dockerImage;
  const hostAddress = isDocker ? "host.docker.internal" : "localhost";
  const output = configOutput ?? new OutputHandler("verbose");

  // 1. Register the run on the server
  const res = await fetch(`http://localhost:${port}/api/register-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: {
        repoCtx,
        jobSteps,
        eventName,
        eventPayload,
        workflowName,
        jobName,
        secrets,
        variables,
        matrix,
        strategy,
        inputs,
        hostAddress,
        runnerOs: isDocker ? "Linux" : detectOs(),
        runnerArch: isDocker ? "X64" : detectArch(),
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to register run on server: ${await res.text()}`);
  }

  const { runId } = (await res.json()) as { runId: string };
  output.emit({ type: "info", message: `Run registered on server (runId: ${runId})` });
  output.emit({ type: "info", message: `View in browser: http://localhost:${port}/runs/${runId}\n` });

  // 2. Connect to SSE for real-time output, and create a jobCompleted promise
  let resolveJobCompleted!: (conclusion: string) => void;
  const jobCompleted = new Promise<string>((resolve) => {
    resolveJobCompleted = resolve;
  });

  // Connect to SSE — await the initial response so we know the stream is established
  const abortController = new AbortController();
  const sseRes = await fetch(`http://localhost:${port}/api/runs/${runId}/events`, {
    signal: abortController.signal,
  });

  // Parse SSE frames in the background (don't await — stream is long-lived)
  if (sseRes.body) {
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            if (!frame.trim()) continue;
            let eventType = "message";
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event: ")) eventType = line.slice(7).trim();
              else if (line.startsWith("data: ")) data = line.slice(6);
            }
            if (!data || eventType === "keepalive") continue;
            try {
              const parsed = JSON.parse(data);
              output.emit(parsed);
              if (eventType === "job_complete") {
                resolveJobCompleted(parsed.conclusion || "unknown");
              }
            } catch {}
          }
        }
      } catch {
        // Stream closed (abort or server disconnect)
      }
    })();
  }

  // 3. Launch runner locally, pointing at the already-running server
  const result = await launchRunner({
    port,
    hostAddress,
    dockerImage,
    runnerDir,
    eventPayload,
    services,
    output,
    jobCompleted,
    // Don't stop the server — it's long-lived
    stopServer: undefined,
  });

  // If the run was cancelled (Ctrl+C or runner killed), notify the server
  if (result.conclusion === "cancelled") {
    try {
      await fetch(`http://localhost:${port}/api/runs/${runId}/cancel`, { method: "POST" });
    } catch {}
  }

  abortController.abort();
  return result;
}
