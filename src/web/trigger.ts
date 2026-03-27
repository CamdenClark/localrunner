import { resolve, join, basename } from "path";
import { getRepoContext } from "../context";
import { parseWorkflow, normalizeOn, workflowStepsToRunnerSteps } from "../workflow";
import { generateEventPayload } from "../events";
import { scriptStep, actionStep } from "../server/steps";
import { buildExpressionContext, evaluateExpressions } from "../expressions";
import { resolveSecrets, scanRequiredSecrets } from "../secrets";
import { resolveVariables } from "../variables";
import { expandMatrix } from "../matrix";
import { OutputHandler } from "../output";
import { launchRunner, type RunConfig } from "../orchestrator";
import type { RunManager } from "../server/runs";

const DEFAULT_IMAGES: Record<string, string> = {
  "ubuntu-latest": "ghcr.io/camdenclark/localrunner:ubuntu24",
  "ubuntu-24.04": "ghcr.io/camdenclark/localrunner:ubuntu24",
  "ubuntu-22.04": "ghcr.io/camdenclark/localrunner:ubuntu22",
};

function resolveDockerImage(runsOn: string | string[] | undefined): string | undefined {
  const label = Array.isArray(runsOn) ? runsOn[0] : runsOn;
  const key = label || "ubuntu-latest";
  return DEFAULT_IMAGES[key] || DEFAULT_IMAGES["ubuntu-latest"];
}

/**
 * Trigger a workflow run from the web UI.
 * Replicates the core CLI flow: parse workflow, resolve context, register run, launch runner.
 */
export async function triggerWorkflow(
  fileName: string,
  eventName: string,
  port: number,
  runManager: RunManager,
): Promise<{ runId: string }> {
  const workflowDir = resolve(".github/workflows");
  const fullPath = join(workflowDir, fileName);
  const text = await Bun.file(fullPath).text();
  const workflow = parseWorkflow(text);
  const workflowName = workflow.name || basename(fileName, ".yml");

  const repoCtx = await getRepoContext();

  // Select first job with steps
  const jobNames = Object.keys(workflow.jobs);
  const selectedJobName = jobNames.find((n) => {
    const j = workflow.jobs[n];
    return j && j.steps && j.steps.length > 0;
  }) || jobNames[0]!;
  const selectedJob = workflow.jobs[selectedJobName]!;

  // Resolve secrets and variables
  const secrets = await resolveSecrets({
    token: repoCtx.token,
    yamlText: text,
  });
  const variables = await resolveVariables({});

  // Event payload
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
  const eventPayload = await generateEventPayload(eventName, repoCtx, undefined, inputDefaults);

  // Matrix — use first combo or none
  const matrixConfig = selectedJob.strategy?.matrix;
  const matrixCombinations = expandMatrix(matrixConfig);
  const matrixCombo = matrixCombinations.length > 0 ? matrixCombinations[0] : undefined;

  // Build expression context and convert steps
  const exprCtx = buildExpressionContext(
    repoCtx, eventName, eventPayload, workflowName, selectedJobName,
    undefined, secrets, variables, matrixCombo,
  );

  const jobSteps = workflowStepsToRunnerSteps(
    selectedJob.steps!,
    (script, displayName) => scriptStep(evaluateExpressions(script, exprCtx), displayName),
    (action, ref, displayName, inputs) => {
      const evaluated = inputs
        ? Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, evaluateExpressions(v, exprCtx)]))
        : undefined;
      return actionStep(action, ref, displayName, evaluated);
    },
  );

  const dockerImage = resolveDockerImage(selectedJob["runs-on"]);
  const isDocker = !!dockerImage;
  const hostAddress = isDocker ? "host.docker.internal" : "localhost";

  // Register the run
  const output = new OutputHandler("verbose");
  const { ctx, jobCompleted } = runManager.registerRun({
    port,
    repoCtx,
    jobSteps,
    eventName,
    eventPayload,
    workflowName,
    jobName: selectedJobName,
    secrets,
    variables,
    matrix: matrixCombo,
    hostAddress,
    runnerOs: isDocker ? "Linux" : "macOS",
    runnerArch: isDocker ? "X64" : "ARM64",
    output,
  });

  // Launch runner in the background
  const runnerDir = resolve(import.meta.dir, "..", "runner");
  launchRunner({
    port,
    hostAddress,
    dockerImage,
    runnerDir,
    eventPayload,
    services: selectedJob.services,
    output,
    jobCompleted,
    onComplete: () => runManager.completeRun(ctx.runId),
  }).catch(() => runManager.completeRun(ctx.runId));

  return { runId: ctx.runId };
}
