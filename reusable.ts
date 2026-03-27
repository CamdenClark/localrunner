import { resolve, dirname } from "path";
import { parseWorkflow, normalizeOn, type Workflow } from "./workflow";
import { evaluateExpressions } from "./expressions";
import type { NeedsContext } from "./server/types";

export interface WorkflowCallConfig {
  inputs: Record<string, { required?: boolean; default?: string; type?: string; description?: string }>;
  secrets: Record<string, { required?: boolean; description?: string }>;
  outputs: Record<string, { value: string; description?: string }>;
}

/**
 * Resolve a reusable workflow reference to a parsed workflow.
 * Supports local references (./.github/workflows/...) only for now.
 */
export async function resolveReusableWorkflow(
  usesRef: string,
  repoRoot: string,
): Promise<{ workflow: Workflow; path: string; yamlText: string }> {
  if (usesRef.startsWith("./") || usesRef.startsWith("../")) {
    const fullPath = resolve(repoRoot, usesRef);
    const file = Bun.file(fullPath);
    if (!(await file.exists())) {
      throw new Error(`Reusable workflow not found: ${fullPath}`);
    }
    const yamlText = await file.text();
    const workflow = parseWorkflow(yamlText);

    // Validate it has workflow_call trigger
    const events = normalizeOn(workflow.on);
    if (!("workflow_call" in events)) {
      throw new Error(
        `Reusable workflow ${usesRef} does not have 'workflow_call' trigger`,
      );
    }

    return { workflow, path: fullPath, yamlText };
  }

  throw new Error(
    `Remote reusable workflow references are not yet supported: ${usesRef}`,
  );
}

/**
 * Extract the workflow_call configuration (inputs, secrets, outputs) from a reusable workflow.
 */
export function extractWorkflowCallConfig(
  workflow: Workflow,
): WorkflowCallConfig {
  const events = normalizeOn(workflow.on);
  const callConfig = events["workflow_call"] as Record<string, any> | null;

  const inputs: WorkflowCallConfig["inputs"] = {};
  const secrets: WorkflowCallConfig["secrets"] = {};
  const outputs: WorkflowCallConfig["outputs"] = {};

  if (callConfig?.inputs) {
    for (const [name, config] of Object.entries(callConfig.inputs)) {
      const cfg = config as any;
      inputs[name] = {
        required: cfg?.required,
        default: cfg?.default !== undefined ? String(cfg.default) : undefined,
        type: cfg?.type,
        description: cfg?.description,
      };
    }
  }

  if (callConfig?.secrets) {
    for (const [name, config] of Object.entries(callConfig.secrets)) {
      const cfg = config as any;
      secrets[name] = {
        required: cfg?.required,
        description: cfg?.description,
      };
    }
  }

  if (callConfig?.outputs) {
    for (const [name, config] of Object.entries(callConfig.outputs)) {
      const cfg = config as any;
      outputs[name] = {
        value: cfg?.value || "",
        description: cfg?.description,
      };
    }
  }

  return { inputs, secrets, outputs };
}

/**
 * Map caller's `with` values to the called workflow's inputs context.
 */
export function mapCallerInputs(
  callerWith: Record<string, any> | undefined,
  callConfig: WorkflowCallConfig,
  exprCtx: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, def] of Object.entries(callConfig.inputs)) {
    if (callerWith && name in callerWith) {
      const raw = String(callerWith[name]);
      result[name] = evaluateExpressions(raw, exprCtx);
    } else if (def.default !== undefined) {
      result[name] = def.default;
    } else if (def.required) {
      throw new Error(
        `Required input '${name}' not provided for reusable workflow`,
      );
    }
  }

  return result;
}

/**
 * Map caller's secrets to the called workflow's secrets.
 * If callerSecrets is "inherit", all resolved secrets are passed through.
 */
export function mapCallerSecrets(
  callerSecrets: any,
  resolvedSecrets: Record<string, string>,
  callConfig: WorkflowCallConfig,
): Record<string, string> {
  if (callerSecrets === "inherit") {
    return { ...resolvedSecrets };
  }

  const result: Record<string, string> = {};
  const explicitSecrets = (callerSecrets as Record<string, string>) || {};

  for (const [name, def] of Object.entries(callConfig.secrets)) {
    if (name in explicitSecrets) {
      result[name] = explicitSecrets[name];
    } else if (name in resolvedSecrets) {
      // Fall back to resolved secrets if explicitly named in the called workflow
      result[name] = resolvedSecrets[name];
    } else if (def.required) {
      throw new Error(
        `Required secret '${name}' not provided for reusable workflow`,
      );
    }
  }

  // Also pass through any explicitly provided secrets not in the config
  for (const [name, value] of Object.entries(explicitSecrets)) {
    if (!(name in result)) {
      result[name] = value;
    }
  }

  return result;
}

/**
 * Extract outputs from a completed reusable workflow run.
 * Evaluates `on.workflow_call.outputs[name].value` expressions against
 * the called workflow's internal needs context (using `jobs.<id>.outputs.<key>` syntax).
 */
export function extractReusableOutputs(
  callConfig: WorkflowCallConfig,
  calledNeedsCtx: NeedsContext,
): Record<string, string> {
  const result: Record<string, string> = {};

  // Build a context with jobs.<id>.outputs.<key> for expression evaluation
  const ctx: Record<string, string> = {};
  for (const [jobId, need] of Object.entries(calledNeedsCtx)) {
    ctx[`jobs.${jobId}.result`] = need.result;
    ctx[`jobs.${jobId}.outputs`] = JSON.stringify(need.outputs);
    for (const [k, v] of Object.entries(need.outputs)) {
      ctx[`jobs.${jobId}.outputs.${k}`] = v;
    }
  }

  for (const [name, def] of Object.entries(callConfig.outputs)) {
    if (def.value) {
      result[name] = evaluateExpressions(def.value, ctx);
    }
  }

  return result;
}

/**
 * Aggregate the conclusion from multiple called workflow jobs.
 */
export function aggregateConclusion(calledNeedsCtx: NeedsContext): string {
  const results = Object.values(calledNeedsCtx).map((n) => n.result);
  if (results.length === 0) return "skipped";
  if (results.some((r) => r === "failure")) return "failed";
  if (results.some((r) => r === "cancelled")) return "cancelled";
  if (results.every((r) => r === "skipped")) return "skipped";
  return "succeeded";
}
