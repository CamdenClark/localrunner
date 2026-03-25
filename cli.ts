#!/usr/bin/env bun
import { parseArgs } from "util";
import { join, resolve, basename } from "path";
import { getRepoContext } from "./context";
import { parseWorkflow, matchesEvent, normalizeOn, workflowStepsToRunnerSteps } from "./workflow";
import { generateEventPayload } from "./events";
import { scriptStep, actionStep } from "./server";
import { startRun } from "./orchestrator";
import { buildExpressionContext, evaluateExpressions } from "./expressions";
import { resolveSecrets, scanRequiredSecrets } from "./secrets";
import { resolveVariables } from "./variables";
import { existsSync } from "fs";

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
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: true,
});

function printUsage() {
  console.log(`Usage: localrunner [event] [flags]

Events:
  push (default), pull_request, workflow_dispatch, etc.

Flags:
  -W, --workflows <path>    Workflow file or directory (default: .github/workflows/)
  -j, --job <name>          Run a specific job
  -s, --secret <KEY=VAL>    Secret (use -s KEY to read from env)
  --secret-file <path>      Path to .env-style secrets file (default: .secrets)
  --var <KEY=VAL>            Variable
  --var-file <path>          Path to .env-style vars file (default: .vars)
  -e, --eventpath <path>    Path to event payload JSON file
  -l, --list                List matching workflows and exit
  --local                    Run with local runner instead of Docker (default: Docker)
  --image <name>             Docker image override for all jobs
  -P, --platform <label=img> Map runs-on label to Docker image (e.g. -P ubuntu-latest=myimage:tag)
  --port <number>            Server port (default: 9637)
  -h, --help                Show this help message

Examples:
  localrunner                                    # push event, auto-detect workflow
  localrunner push                               # explicit push
  localrunner pull_request -j test               # specific job
  localrunner -l                                 # list all workflows
  localrunner push -l                            # list push workflows
  localrunner push -W .github/workflows/ci.yml   # specific workflow
  localrunner push -s MY_SECRET=foo              # with secret`);
}

if (values.help) {
  printUsage();
  process.exit(0);
}

// Event name: first positional or default to "push"
const eventName: string = positionals[0] || "push";

const port = parseInt(values.port || "9637", 10);

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

  console.log("=== localrunner ===\n");

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

  function resolveDockerImage(runsOn: string | string[] | undefined): string | undefined {
    if (values.local) return undefined;
    if (values.image) return values.image;
    const label = Array.isArray(runsOn) ? runsOn[0] : runsOn;
    const key = label || "ubuntu-latest";
    return platformOverrides[key] || DEFAULT_IMAGES[key] || DEFAULT_IMAGES["ubuntu-latest"];
  }

  let anyFailed = false;

  for (const match of workflowMatches) {
    const { workflow, path: workflowPath, yamlText } = match;
    const workflowName = workflow.name || basename(workflowPath, ".yml");

    console.log(`--- ${workflowName} (${basename(workflowPath)}) ---\n`);

    // Select job
    const jobNames = Object.keys(workflow.jobs);
    let selectedJobName: string;

    if (values.job) {
      if (!workflow.jobs[values.job]) {
        console.error(`Error: job '${values.job}' not found in ${basename(workflowPath)}. Available jobs: ${jobNames.join(", ")}`);
        continue;
      }
      selectedJobName = values.job;
    } else if (jobNames.length === 1) {
      selectedJobName = jobNames[0]!;
    } else {
      const jobWithSteps = jobNames.find((n) => {
        const j = workflow.jobs[n];
        return j && j.steps && j.steps.length > 0;
      });
      if (!jobWithSteps) {
        console.error(`Error: no jobs with steps found in ${basename(workflowPath)}. Available jobs: ${jobNames.join(", ")}`);
        continue;
      }
      selectedJobName = jobWithSteps;
      if (jobNames.length > 1) {
        console.log(`Multiple jobs found, running '${selectedJobName}'. Use -j to select a different one.`);
      }
    }

    const selectedJob = workflow.jobs[selectedJobName]!;
    const dockerImage = resolveDockerImage(selectedJob["runs-on"]);
    console.log(`Job: ${selectedJobName}${dockerImage ? ` (${selectedJob["runs-on"] || "ubuntu-latest"} → ${dockerImage})` : " (local)"}`);

    if (!selectedJob.steps || selectedJob.steps.length === 0) {
      console.error(`Error: job '${selectedJobName}' has no steps`);
      continue;
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

    const eventPayload = await generateEventPayload(eventName, repoCtx, payloadOverrides, inputDefaults);

    // Build expression context and convert steps
    const exprCtx = buildExpressionContext(repoCtx, eventName, eventPayload, workflowName, selectedJobName, undefined, secrets, variables);

    const jobSteps = workflowStepsToRunnerSteps(
      selectedJob.steps,
      (script, displayName) => scriptStep(evaluateExpressions(script, exprCtx), displayName),
      (action, ref, displayName, inputs) => {
        const evaluated = inputs
          ? Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, evaluateExpressions(v, exprCtx)]))
          : undefined;
        return actionStep(action, ref, displayName, evaluated);
      },
    );
    const serviceNames = selectedJob.services ? Object.keys(selectedJob.services) : [];
    if (serviceNames.length > 0) {
      console.log(`Services: ${serviceNames.join(", ")}`);
    }
    console.log(`Steps: ${jobSteps.length}\n`);

    const conclusion = await startRun({
      port,
      repoCtx,
      jobSteps,
      eventName,
      eventPayload,
      workflowName,
      jobName: selectedJobName,
      runnerDir,
      secrets,
      variables,
      dockerImage,
      services: selectedJob.services,
    });

    if (conclusion !== "succeeded") {
      anyFailed = true;
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
