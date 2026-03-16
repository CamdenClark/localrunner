#!/usr/bin/env bun
import { parseArgs } from "util";
import { join, resolve, basename } from "path";
import { getRepoContext } from "./context";
import { parseWorkflow, matchesEvent, workflowStepsToRunnerSteps } from "./workflow";
import { generateEventPayload } from "./events";
import { scriptStep, actionStep } from "./server";
import { startRun } from "./orchestrator";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    job: { type: "string" },
    port: { type: "string", default: "9637" },
    payload: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: true,
});

function printUsage() {
  console.log(`Usage: localrunner run <event> [workflow-file] [options]

Commands:
  run <event>    Run a workflow for the given event (push, pull_request, workflow_dispatch, etc.)

Options:
  --job <name>       Run a specific job from the workflow
  --port <number>    Server port (default: 9637)
  --payload <json>   JSON string to merge into the event payload
  -h, --help         Show this help message

Examples:
  localrunner run push
  localrunner run push .github/workflows/ci.yml
  localrunner run pull_request --job test
  localrunner run push --payload '{"head_commit":{"message":"custom"}}'`);
}

if (values.help || positionals.length === 0) {
  printUsage();
  process.exit(0);
}

const command = positionals[0];

if (command !== "run") {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

const eventNameArg = positionals[1];
if (!eventNameArg) {
  console.error("Error: event name is required");
  printUsage();
  process.exit(1);
}
const eventName: string = eventNameArg;

const workflowFile: string | undefined = positionals[2];
const port = parseInt(values.port || "9637", 10);
const payloadOverrides = values.payload ? JSON.parse(values.payload) : undefined;

// --- Find and parse workflow(s) ---

async function findWorkflows(eventName: string): Promise<{ path: string; workflow: ReturnType<typeof parseWorkflow> }[]> {
  const workflowDir = resolve(".github/workflows");
  const glob = new Bun.Glob("*.{yml,yaml}");
  const matches: { path: string; workflow: ReturnType<typeof parseWorkflow> }[] = [];

  for await (const file of glob.scan({ cwd: workflowDir })) {
    const fullPath = join(workflowDir, file);
    try {
      const text = await Bun.file(fullPath).text();
      const workflow = parseWorkflow(text);
      if (matchesEvent(workflow, eventName)) {
        matches.push({ path: fullPath, workflow });
      }
    } catch (err) {
      console.warn(`Warning: could not parse ${file}: ${(err as Error).message}`);
    }
  }

  return matches;
}

async function main() {
  console.log("=== localrunner ===\n");

  let workflow: ReturnType<typeof parseWorkflow>;
  let workflowPath: string;

  if (workflowFile) {
    const fullPath = resolve(workflowFile);
    const text = await Bun.file(fullPath).text();
    workflow = parseWorkflow(text);
    workflowPath = fullPath;

    if (!matchesEvent(workflow, eventName)) {
      console.warn(`Warning: workflow ${basename(fullPath)} does not trigger on '${eventName}', running anyway.`);
    }
  } else {
    const matches = await findWorkflows(eventName);

    if (matches.length === 0) {
      console.error(`Error: no workflows found that trigger on '${eventName}'`);
      console.error("Specify a workflow file explicitly: localrunner run <event> <workflow-file>");
      return process.exit(1);
    }

    if (matches.length > 1) {
      console.error(`Error: multiple workflows match event '${eventName}':`);
      for (const m of matches) {
        console.error(`  - ${basename(m.path)} (${m.workflow.name || "unnamed"})`);
      }
      console.error("Specify one explicitly: localrunner run <event> <workflow-file>");
      return process.exit(1);
    }

    workflow = matches[0]!.workflow;
    workflowPath = matches[0]!.path;
  }

  const workflowName = workflow.name || basename(workflowPath, ".yml");
  console.log(`Workflow: ${workflowName} (${basename(workflowPath)})`);
  console.log(`Event: ${eventName}`);

  // Select job
  const jobNames = Object.keys(workflow.jobs);
  let selectedJobName: string;

  if (values.job) {
    if (!workflow.jobs[values.job]) {
      console.error(`Error: job '${values.job}' not found. Available jobs: ${jobNames.join(", ")}`);
      return process.exit(1);
    }
    selectedJobName = values.job;
  } else if (jobNames.length === 1) {
    selectedJobName = jobNames[0]!;
  } else {
    // Pick the first job that has steps (not a reusable workflow call)
    const jobWithSteps = jobNames.find((n) => {
      const j = workflow.jobs[n];
      return j && j.steps && j.steps.length > 0;
    });
    if (!jobWithSteps) {
      console.error(`Error: no jobs with steps found. Available jobs: ${jobNames.join(", ")}`);
      return process.exit(1);
    }
    selectedJobName = jobWithSteps;
    if (jobNames.length > 1) {
      console.log(`Multiple jobs found, running '${selectedJobName}'. Use --job to select a different one.`);
    }
  }

  const selectedJob = workflow.jobs[selectedJobName]!;
  console.log(`Job: ${selectedJobName}`);

  if (!selectedJob.steps || selectedJob.steps.length === 0) {
    console.error(`Error: job '${selectedJobName}' has no steps`);
    return process.exit(1);
  }

  // Convert steps
  const jobSteps = workflowStepsToRunnerSteps(selectedJob.steps, scriptStep, actionStep);
  console.log(`Steps: ${jobSteps.length}\n`);

  // Get repo context and generate event payload
  const repoCtx = await getRepoContext();
  console.log(`Repo: ${repoCtx.fullName} (${repoCtx.sha.slice(0, 8)})\n`);

  const eventPayload = await generateEventPayload(eventName, repoCtx, payloadOverrides);

  // Resolve runner directory
  const runnerDir = resolve(import.meta.dir, "runner");

  await startRun({
    port,
    repoCtx,
    jobSteps,
    eventName,
    eventPayload,
    workflowName,
    jobName: selectedJobName,
    runnerDir,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
