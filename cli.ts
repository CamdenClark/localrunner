#!/usr/bin/env bun
import { parseArgs } from "util";
import { join, resolve, basename } from "path";
import { getRepoContext } from "./context";
import { parseWorkflow, matchesEvent, normalizeOn, workflowStepsToRunnerSteps } from "./workflow";
import { generateEventPayload, EVENT_DEFINITIONS, EVENT_REGISTRY } from "./events";
import { scriptStep, actionStep } from "./server/index";
import { startRun, startRunOnRemoteServer } from "./orchestrator";
import { buildExpressionContext, evaluateExpressions } from "./expressions";
import { resolveSecrets, scanRequiredSecrets } from "./secrets";
import { resolveVariables } from "./variables";
import { existsSync } from "fs";
import { OutputHandler, type OutputMode } from "./output";
import { expandMatrix, filterMatrix, formatMatrixCombo } from "./matrix";
import { detectOs, detectArch } from "./platform";
import type { NeedsContext } from "./server/types";

/** Normalize job needs to an array */
function normalizeNeeds(needs: string | string[] | undefined): string[] {
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/** Topological sort of jobs by `needs` dependencies. Returns job names in execution order. */
export function topologicalSortJobs(
  jobs: Record<string, { needs?: string | string[] }>,
): string[] {
  const jobNames = Object.keys(jobs);
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(name: string, stack: Set<string>) {
    if (visited.has(name)) return;
    if (stack.has(name)) {
      throw new Error(`Circular dependency detected in jobs: ${[...stack, name].join(" → ")}`);
    }
    stack.add(name);
    const deps = normalizeNeeds(jobs[name]?.needs);
    for (const dep of deps) {
      if (!jobs[dep]) {
        throw new Error(`Job '${name}' depends on unknown job '${dep}'`);
      }
      visit(dep, stack);
    }
    stack.delete(name);
    visited.add(name);
    result.push(name);
  }

  for (const name of jobNames) {
    visit(name, new Set());
  }

  return result;
}

/** Map runner conclusion to GitHub Actions needs.*.result value */
function conclusionToResult(conclusion: string): string {
  switch (conclusion) {
    case "succeeded": return "success";
    case "failed": return "failure";
    case "cancelled": return "cancelled";
    case "skipped": return "skipped";
    default: return conclusion;
  }
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    workflows: { type: "string", short: "W" },
    job: { type: "string", short: "j" },
    secret: { type: "string", short: "s", multiple: true },
    "secret-file": { type: "string" },
    var: { type: "string", multiple: true },
    "var-file": { type: "string" },
    eventpath: { type: "string", short: "e" },
    list: { type: "boolean", short: "l" },
    local: { type: "boolean" },
    image: { type: "string" },
    platform: { type: "string", short: "P", multiple: true },
    port: { type: "string", default: "9637" },
    raw: { type: "boolean" },
    verbose: { type: "boolean", short: "v" },
    matrix: { type: "string", short: "m", multiple: true },
    "list-events": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: true,
});

function printUsage() {
  const common = ["push", "pull_request", "pull_request_target", "workflow_dispatch", "issues", "release", "schedule"];
  const eventLines = common
    .map((name) => EVENT_REGISTRY.get(name))
    .filter(Boolean)
    .map((def) => `  ${def!.name.padEnd(26)} ${def!.description}${def!.name === "push" ? " (default)" : ""}`)
    .join("\n");

  console.log(`Usage: localrunner [event] [flags]
       localrunner serve [--port 9637]

Events:
${eventLines}

  Use --list-events to see all ${EVENT_REGISTRY.size} supported events.

Commands:
  serve                     Start the long-lived server with web UI

Flags:
  -W, --workflows <path>    Workflow file or directory (default: .github/workflows/)
  -j, --job <name>          Run a specific job
  -s, --secret <KEY=VAL>    Secret (use -s KEY to read from env)
  --secret-file <path>      Path to .env-style secrets file (default: .secrets)
  --var <KEY=VAL>            Variable
  --var-file <path>          Path to .env-style vars file (default: .vars)
  -e, --eventpath <path>    Path to event payload JSON (merges with defaults, e.g. {"action": "labeled"})
  -l, --list                List matching workflows and exit
  --local                    Run with local runner instead of Docker (default: Docker)
  --image <name>             Docker image override for all jobs
  -P, --platform <label=img> Map runs-on label to Docker image (e.g. -P ubuntu-latest=myimage:tag)
  -m, --matrix <key:value>   Filter matrix combinations (e.g. --matrix node:18)
  --port <number>            Server port (default: 9637)
  --raw                      Raw output for agents (step markers + log lines)
  -v, --verbose              Verbose output with full server internals
  -h, --help                Show this help message

Examples:
  localrunner                                    # push event, auto-detect workflow
  localrunner push                               # explicit push
  localrunner pull_request -j test               # specific job
  localrunner -l                                 # list all workflows
  localrunner push -l                            # list push workflows
  localrunner push -W .github/workflows/ci.yml   # specific workflow
  localrunner push -s MY_SECRET=foo              # with secret
  localrunner push --matrix node:18              # filter matrix
  localrunner pull_request --help                 # show event activity types & sample payload`);
}

if (values.help && positionals[0]) {
  // Event-specific help: bun cli.ts push --help
  const name = positionals[0];
  const def = EVENT_REGISTRY.get(name);
  if (!def) {
    console.error(`Unknown event: '${name}'. Run --list-events to see all supported events.`);
    process.exit(1);
  }

  console.log(`Event: ${def.name}`);
  console.log(`  ${def.description}\n`);

  if (def.validActions.length > 0) {
    console.log(`Activity types: ${def.validActions.join(", ")}`);
    console.log(`Default: ${def.defaultAction}\n`);
  }

  const filters: string[] = [];
  if (def.supportsFilters.branches) filters.push("branches");
  if (def.supportsFilters.paths) filters.push("paths");
  if (def.supportsFilters.tags) filters.push("tags");
  if (filters.length > 0) {
    console.log(`Filters: ${filters.join(", ")}\n`);
  }

  console.log(`Workflow usage:`);
  if (def.validActions.length > 0) {
    console.log(`  on:`);
    console.log(`    ${def.name}:`);
    console.log(`      types: [${def.validActions.slice(0, 3).join(", ")}]`);
  } else {
    console.log(`  on: [${def.name}]`);
  }

  // Generate and show sample payload
  const { getRepoContext: getCtx } = await import("./context");
  try {
    const ctx = await getCtx();
    const payload = await def.generatePayload(ctx);
    console.log(`\nSample payload (github.event):`);
    console.log(JSON.stringify(payload, null, 2));
  } catch {
    // Fall back to a stub context if git/gh isn't available
    const stubCtx = {
      owner: "owner", repo: "repo", fullName: "owner/repo",
      defaultBranch: "main", sha: "abc123", ref: "refs/heads/main",
      remoteUrl: "https://github.com/owner/repo", token: "",
      actor: "user", actorId: "1", repositoryId: "1",
      repositoryOwnerId: "1", serverUrl: "https://github.com",
      apiUrl: "https://api.github.com", graphqlUrl: "https://api.github.com/graphql",
    };
    const payload = await def.generatePayload(stubCtx);
    console.log(`\nSample payload (github.event):`);
    console.log(JSON.stringify(payload, null, 2));
  }

  console.log(`\nOverride with: localrunner ${def.name} -e payload.json`);
  process.exit(0);
}

if (values.help) {
  printUsage();
  process.exit(0);
}

if (values["list-events"]) {
  for (const def of EVENT_DEFINITIONS) {
    console.log(def.name);
    console.log(`  ${def.description}`);
    if (def.validActions.length > 0) {
      console.log(`  Activity types: ${def.validActions.join(", ")}`);
      console.log(`  Default: ${def.defaultAction}`);
    }
    const filters: string[] = [];
    if (def.supportsFilters.branches) filters.push("branches");
    if (def.supportsFilters.paths) filters.push("paths");
    if (def.supportsFilters.tags) filters.push("tags");
    if (filters.length > 0) {
      console.log(`  Filters: ${filters.join(", ")}`);
    }
    console.log();
  }
  process.exit(0);
}

// --- Serve subcommand ---
if (positionals[0] === "serve") {
  const port = parseInt(values.port || "9637", 10);
  const { createMultiRunApp, websocket } = await import("./server/hono");
  const { RunManager } = await import("./server/runs");
  const { registerWebRoutes } = await import("./web/routes");
  const { registerApiRoutes } = await import("./web/api");

  const runManager = new RunManager();
  const { app, addRunnerCatchAll } = createMultiRunApp(runManager);

  registerWebRoutes(app, runManager, port);
  registerApiRoutes(app, runManager, port);
  addRunnerCatchAll();

  const server = Bun.serve({ port, fetch: app.fetch, websocket });

  console.log(`localrunner server listening on http://localhost:${port}`);
  console.log(`Web UI: http://localhost:${port}/`);
  console.log(`Press Ctrl+C to stop.\n`);

  const pidFile = `${process.env.HOME}/.localrunner/server.pid`;
  await Bun.write(pidFile, String(process.pid));

  process.on("SIGINT", () => {
    try { require("fs").unlinkSync(pidFile); } catch {}
    server.stop(true);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    try { require("fs").unlinkSync(pidFile); } catch {}
    server.stop(true);
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {});
}

// Event name: first positional or default to "push"
const eventName: string = positionals[0] || "push";

if (!EVENT_REGISTRY.has(eventName)) {
  console.warn(`Warning: '${eventName}' is not a recognized GitHub Actions event. Using minimal payload.`);
  console.warn(`Run with --list-events to see all supported events.`);
}

const port = parseInt(values.port || "9637", 10);

const outputMode: OutputMode = values.raw ? "raw" : values.verbose ? "verbose" : "pretty";
const output = new OutputHandler(outputMode);

/** Check if the long-lived server is running on the given port. */
async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}


// --- Find and parse workflow(s) ---

async function findWorkflows(
  eventName: string,
  workflowPath?: string,
): Promise<{ path: string; workflow: ReturnType<typeof parseWorkflow>; yamlText: string }[]> {
  // If -W points to a specific file
  if (workflowPath && !workflowPath.endsWith("/")) {
    const stat = await Bun.file(workflowPath).exists();
    if (stat) {
      const fullPath = resolve(workflowPath);
      const text = await Bun.file(fullPath).text();
      const workflow = parseWorkflow(text);
      return [{ path: fullPath, workflow, yamlText: text }];
    }
  }

  const workflowDir = resolve(workflowPath || ".github/workflows");
  const glob = new Bun.Glob("*.{yml,yaml}");
  const matches: { path: string; workflow: ReturnType<typeof parseWorkflow>; yamlText: string }[] = [];

  for await (const file of glob.scan({ cwd: workflowDir })) {
    const fullPath = join(workflowDir, file);
    try {
      const text = await Bun.file(fullPath).text();
      const workflow = parseWorkflow(text);
      if (matchesEvent(workflow, eventName)) {
        matches.push({ path: fullPath, workflow, yamlText: text });
      }
    } catch (err) {
      console.warn(`Warning: could not parse ${file}: ${(err as Error).message}`);
    }
  }

  return matches;
}

async function main() {
  // --- List mode ---
  if (values.list) {
    const matches = await findWorkflows(eventName, values.workflows);
    if (matches.length === 0) {
      console.log(`No workflows found for event '${eventName}'`);
      return process.exit(0);
    }
    for (const m of matches) {
      const name = m.workflow.name || basename(m.path);
      const jobNames = Object.keys(m.workflow.jobs);
      const requiredSecrets = scanRequiredSecrets(m.yamlText);
      console.log(`${basename(m.path)}`);
      console.log(`  Name: ${name}`);
      console.log(`  Jobs: ${jobNames.join(", ")}`);
      if (requiredSecrets.length > 0) {
        console.log(`  Secrets: ${requiredSecrets.join(", ")}`);
      }
      console.log();
    }
    return process.exit(0);
  }

  const serverRunning = await isServerRunning();

  console.log("=== localrunner ===\n");
  if (serverRunning) {
    console.log(`Using running server on port ${port}\n`);
  }

  // --- Find workflows ---
  let workflowMatches: { path: string; workflow: ReturnType<typeof parseWorkflow>; yamlText: string }[];

  if (values.workflows && !values.workflows.endsWith("/") && existsSync(values.workflows)) {
    const fullPath = resolve(values.workflows);
    const text = await Bun.file(fullPath).text();
    const workflow = parseWorkflow(text);
    workflowMatches = [{ path: fullPath, workflow, yamlText: text }];

    if (!matchesEvent(workflow, eventName)) {
      console.warn(`Warning: workflow ${basename(fullPath)} does not trigger on '${eventName}', running anyway.`);
    }
  } else {
    workflowMatches = await findWorkflows(eventName, values.workflows);

    if (workflowMatches.length === 0) {
      console.error(`Error: no workflows found that trigger on '${eventName}'`);
      console.error("Specify a workflow file explicitly: localrunner <event> -W <workflow-file>");
      return process.exit(1);
    }
  }

  // Get repo context once (shared across all workflows)
  const repoCtx = await getRepoContext();
  console.log(`Repo: ${repoCtx.fullName} (${repoCtx.sha.slice(0, 8)})`);
  console.log(`Event: ${eventName}`);
  console.log(`Workflows: ${workflowMatches.map((m) => basename(m.path)).join(", ")}\n`);

  // Load event payload overrides from --eventpath (shared)
  let payloadOverrides: object | undefined;
  if (values.eventpath) {
    const eventJson = await Bun.file(resolve(values.eventpath)).text();
    payloadOverrides = JSON.parse(eventJson);
  }

  // Resolve variables once (shared across all workflows)
  const variables = await resolveVariables({
    varArgs: values.var,
    varFile: values["var-file"],
  });

  const runnerDir = resolve(import.meta.dir, "runner");

  const DEFAULT_IMAGES: Record<string, string> = {
    "ubuntu-latest": "ghcr.io/camdenclark/localrunner:ubuntu24",
    "ubuntu-24.04": "ghcr.io/camdenclark/localrunner:ubuntu24",
    "ubuntu-22.04": "ghcr.io/camdenclark/localrunner:ubuntu22",
  };

  // Parse --platform overrides (e.g. -P ubuntu-latest=myimage:tag)
  const platformOverrides: Record<string, string> = {};
  for (const p of values.platform || []) {
    const eq = p.indexOf("=");
    if (eq === -1) {
      console.error(`Error: invalid --platform format '${p}', expected label=image`);
      process.exit(1);
    }
    platformOverrides[p.slice(0, eq)] = p.slice(eq + 1);
  }

  function resolveRunsOnImage(label: string): string | undefined {
    // Exact match in defaults
    if (DEFAULT_IMAGES[label]) return DEFAULT_IMAGES[label];

    // Larger runner variants: ubuntu-latest-Xcores, ubuntu-24.04-Xcores, etc.
    // Strip the trailing resource suffix (e.g. "-4-cores", "-16-cores") and retry
    const withoutCores = label.replace(/-\d+-cores?$/, "");
    if (withoutCores !== label && DEFAULT_IMAGES[withoutCores]) {
      return DEFAULT_IMAGES[withoutCores];
    }

    // Match ubuntu version patterns like "ubuntu-22.04-anything"
    if (label.startsWith("ubuntu-22.04")) return DEFAULT_IMAGES["ubuntu-22.04"];
    if (label.startsWith("ubuntu-24.04") || label.startsWith("ubuntu-latest")) {
      return DEFAULT_IMAGES["ubuntu-latest"];
    }

    return undefined;
  }

  function resolveDockerImage(runsOn: string | string[] | undefined): string | undefined {
    if (values.local) return undefined;
    if (values.image) return values.image;
    const label = Array.isArray(runsOn) ? runsOn[0] : runsOn;
    const key = label || "ubuntu-latest";
    return platformOverrides[key] || resolveRunsOnImage(key) || DEFAULT_IMAGES["ubuntu-latest"];
  }

  let anyFailed = false;

  for (const match of workflowMatches) {
    const { workflow, path: workflowPath, yamlText } = match;
    const workflowName = workflow.name || basename(workflowPath, ".yml");

    console.log(`--- ${workflowName} (${basename(workflowPath)}) ---\n`);

    // Determine which jobs to run and in what order
    const allJobNames = Object.keys(workflow.jobs);
    let jobsToRun: string[];

    if (values.job) {
      if (!workflow.jobs[values.job]) {
        console.error(`Error: job '${values.job}' not found in ${basename(workflowPath)}. Available jobs: ${allJobNames.join(", ")}`);
        continue;
      }
      jobsToRun = [values.job];
    } else {
      try {
        jobsToRun = topologicalSortJobs(workflow.jobs);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        continue;
      }
      // Filter to jobs with steps
      jobsToRun = jobsToRun.filter((n) => {
        const j = workflow.jobs[n];
        return j && j.steps && j.steps.length > 0;
      });
      if (jobsToRun.length === 0) {
        console.error(`Error: no jobs with steps found in ${basename(workflowPath)}. Available jobs: ${allJobNames.join(", ")}`);
        continue;
      }
    }

    // Resolve secrets per-workflow (yaml scanning is workflow-specific)
    const secrets = await resolveSecrets({
      token: repoCtx.token,
      secretArgs: values.secret,
      secretFile: values["secret-file"],
      yamlText,
    });

    // Extract workflow_dispatch input defaults
    let inputDefaults: Record<string, string> | undefined;
    if (eventName === "workflow_dispatch") {
      const onConfig = normalizeOn(workflow.on);
      const dispatchConfig = onConfig["workflow_dispatch"] as { inputs?: Record<string, { default?: string }> } | null;
      if (dispatchConfig?.inputs) {
        inputDefaults = {};
        for (const [key, config] of Object.entries(dispatchConfig.inputs)) {
          if (config?.default !== undefined) {
            inputDefaults[key] = String(config.default);
          }
        }
      }
    }

    // Extract defaults.run from workflow level
    const workflowDefaults = workflow.defaults as { run?: { shell?: string; "working-directory"?: string } } | undefined;
    const defaultShell = workflowDefaults?.run?.shell;
    const defaultWorkingDirectory = workflowDefaults?.run?.["working-directory"];

    const eventPayload = await generateEventPayload(eventName, repoCtx, payloadOverrides, inputDefaults);

    if (jobsToRun.length > 1) {
      console.log(`Jobs: ${jobsToRun.join(" → ")}\n`);
    }

    // Track needs context across jobs
    const needsCtx: NeedsContext = {};

    for (const selectedJobName of jobsToRun) {
      const selectedJob = workflow.jobs[selectedJobName]!;
      const dockerImage = resolveDockerImage(selectedJob["runs-on"]);

      if (!selectedJob.steps || selectedJob.steps.length === 0) {
        console.error(`Error: job '${selectedJobName}' has no steps`);
        continue;
      }

      // Check that all dependencies succeeded (unless job has explicit if condition)
      const deps = normalizeNeeds(selectedJob.needs);
      if (deps.length > 0 && !selectedJob.if) {
        const failedDep = deps.find((d) => needsCtx[d]?.result !== "success");
        if (failedDep) {
          console.log(`  Skipping job '${selectedJobName}': dependency '${failedDep}' did not succeed (${needsCtx[failedDep]?.result || "not run"})`);
          needsCtx[selectedJobName] = { result: "skipped", outputs: {} };
          continue;
        }
      }

      // Build the needs context for this job (only include direct dependencies)
      const jobNeeds: NeedsContext = {};
      for (const dep of deps) {
        if (needsCtx[dep]) {
          jobNeeds[dep] = needsCtx[dep];
        }
      }

      // Expand matrix combinations
      const matrixConfig = selectedJob.strategy?.matrix;
      let matrixCombinations = expandMatrix(matrixConfig);
      if (values.matrix && values.matrix.length > 0) {
        matrixCombinations = filterMatrix(matrixCombinations, values.matrix);
        if (matrixCombinations.length === 0) {
          console.error(`Error: no matrix combinations match the provided --matrix filters`);
          continue;
        }
      }

      const hasMatrix = matrixCombinations.length > 0;
      const combosToRun = hasMatrix ? matrixCombinations : [{}];

      // Extract job-level defaults.run (overrides workflow-level)
      const jobDefaults = selectedJob.defaults as { run?: { shell?: string; "working-directory"?: string } } | undefined;
      const jobDefaultShell = jobDefaults?.run?.shell ?? defaultShell;
      const jobDefaultWorkingDirectory = jobDefaults?.run?.["working-directory"] ?? defaultWorkingDirectory;

      if (hasMatrix) {
        console.log(`Job: ${selectedJobName} (${combosToRun.length} matrix combination${combosToRun.length > 1 ? "s" : ""})${dockerImage ? ` (${selectedJob["runs-on"] || "ubuntu-latest"} → ${dockerImage})` : " (local)"}`);
      } else {
        console.log(`Job: ${selectedJobName}${dockerImage ? ` (${selectedJob["runs-on"] || "ubuntu-latest"} → ${dockerImage})` : " (local)"}`);
      }

      let jobConclusion = "succeeded";
      let jobOutputs: Record<string, string> = {};

      for (const matrixCombo of combosToRun) {
        const comboLabel = hasMatrix ? ` ${formatMatrixCombo(matrixCombo)}` : "";
        if (hasMatrix) {
          console.log(`\n  Matrix:${comboLabel}`);
        }

        // Build expression context and convert steps
        const isDocker = !!dockerImage;
        const runnerOs = isDocker ? "Linux" : detectOs();
        const runnerArch = isDocker ? "X64" : detectArch();
        const exprCtx = buildExpressionContext(repoCtx, eventName, eventPayload, workflowName, selectedJobName, undefined, secrets, variables, hasMatrix ? matrixCombo : undefined, { os: runnerOs, arch: runnerArch }, jobNeeds);

        // Evaluate job-level `if` condition
        if (selectedJob.if) {
          const conditionResult = evaluateExpressions(`\${{ ${selectedJob.if} }}`, exprCtx);
          if (conditionResult === "false" || conditionResult === "" || conditionResult === "0") {
            console.log(`  Skipping job '${selectedJobName}': condition '${selectedJob.if}' evaluated to false`);
            jobConclusion = "skipped";
            continue;
          }
        }

        // Merge job-level env into step environments
        const jobEnv = selectedJob.env
          ? Object.fromEntries(Object.entries(selectedJob.env).map(([k, v]) => [k, evaluateExpressions(v, exprCtx)]))
          : undefined;
        // Also merge workflow-level env
        const workflowEnv = workflow.env
          ? Object.fromEntries(Object.entries(workflow.env).map(([k, v]) => [k, evaluateExpressions(v, exprCtx)]))
          : undefined;

        const evaluateOpts = (opts?: { condition?: string; continueOnError?: boolean; environment?: Record<string, string>; stepId?: string; shell?: string; workingDirectory?: string; timeoutMinutes?: number }) => {
          if (!opts) return opts;
          const mergedEnv = {
            ...workflowEnv,
            ...jobEnv,
            ...(opts.environment
              ? Object.fromEntries(Object.entries(opts.environment).map(([k, v]) => [k, evaluateExpressions(v, exprCtx)]))
              : {}),
          };
          return {
            ...opts,
            environment: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
            shell: opts.shell ?? jobDefaultShell,
            workingDirectory: opts.workingDirectory ?? jobDefaultWorkingDirectory,
          };
        };
        const jobSteps = workflowStepsToRunnerSteps(
          selectedJob.steps,
          (script, displayName, opts) => scriptStep(evaluateExpressions(script, exprCtx), displayName, evaluateOpts(opts)),
          (action, ref, displayName, inputs, opts) => {
            const evaluated = inputs
              ? Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, evaluateExpressions(v, exprCtx)]))
              : undefined;
            return actionStep(action, ref, displayName, evaluated, evaluateOpts(opts));
          },
        );
        const serviceNames = selectedJob.services ? Object.keys(selectedJob.services) : [];
        if (serviceNames.length > 0) {
          console.log(`Services: ${serviceNames.join(", ")}`);
        }
        console.log(`  Steps: ${jobSteps.length}\n`);

        const jobDisplayName = hasMatrix ? `${selectedJobName}${comboLabel}` : selectedJobName;

        let result: { conclusion: string; outputs: Record<string, string> };

        // Build strategy context
        const strategyCtx = hasMatrix ? {
          failFast: selectedJob.strategy?.["fail-fast"] !== false,
          jobIndex: combosToRun.indexOf(matrixCombo),
          jobTotal: combosToRun.length,
          maxParallel: selectedJob.strategy?.["max-parallel"],
        } : undefined;

        const inputsCtx = inputDefaults || undefined;

        if (serverRunning) {
          result = await startRunOnRemoteServer({
            port,
            repoCtx,
            jobSteps,
            eventName,
            eventPayload,
            workflowName,
            jobName: jobDisplayName,
            runnerDir,
            secrets,
            variables,
            matrix: hasMatrix ? matrixCombo : undefined,
            strategy: strategyCtx,
            inputs: inputsCtx,
            needs: jobNeeds,
            dockerImage,
            services: selectedJob.services,
            output,
          });
        } else {
          result = await startRun({
            port,
            repoCtx,
            jobSteps,
            eventName,
            eventPayload,
            workflowName,
            jobName: jobDisplayName,
            runnerDir,
            secrets,
            variables,
            matrix: hasMatrix ? matrixCombo : undefined,
            strategy: strategyCtx,
            inputs: inputsCtx,
            needs: jobNeeds,
            dockerImage,
            services: selectedJob.services,
            output,
          });
        }

        jobConclusion = result.conclusion;
        jobOutputs = { ...jobOutputs, ...result.outputs };

        if (result.conclusion !== "succeeded") {
          anyFailed = true;
        }
      }

      // Store this job's result in the needs context for downstream jobs
      needsCtx[selectedJobName] = {
        result: conclusionToResult(jobConclusion),
        outputs: jobOutputs,
      };
    }

    console.log();
  }

  if (anyFailed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
