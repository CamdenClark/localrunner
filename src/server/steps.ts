import { randomUUID } from "crypto";

export interface StepOptions {
  condition?: string;
  continueOnError?: boolean;
  environment?: Record<string, string>;
  stepId?: string;
  shell?: string;
  workingDirectory?: string;
  timeoutMinutes?: number;
}

// If condition contains a status function, use as-is; otherwise wrap with success()
function resolveCondition(ifExpr?: string): string {
  if (!ifExpr) return "success()";
  const statusFunctions = /\b(success|failure|always|cancelled)\s*\(/;
  if (statusFunctions.test(ifExpr)) return ifExpr;
  return `success() && (${ifExpr})`;
}

export function scriptStep(
  script: string,
  displayName?: string,
  opts?: StepOptions,
): object {
  const inputMap: { Key: string; Value: string }[] = [{ Key: "script", Value: script }];
  if (opts?.shell) inputMap.push({ Key: "shell", Value: opts.shell });
  if (opts?.workingDirectory) inputMap.push({ Key: "workingDirectory", Value: opts.workingDirectory });

  return {
    type: "Action",
    reference: { type: "Script" },
    id: randomUUID(),
    name: "__run",
    displayName: displayName || `Run ${script.slice(0, 40)}`,
    contextName: opts?.stepId || `run_${randomUUID().slice(0, 8)}`,
    condition: resolveCondition(opts?.condition),
    inputs: {
      type: 2,
      map: inputMap,
    },
    ...(opts?.environment ? {
      environment: { type: 2, map: Object.entries(opts.environment).map(([k, v]) => ({ Key: k, Value: v })) },
    } : {}),
    ...(opts?.continueOnError ? { continueOnError: true } : {}),
    ...(opts?.timeoutMinutes ? { timeoutInMinutes: opts.timeoutMinutes } : {}),
  };
}

export function actionStep(
  action: string,
  ref: string,
  displayName?: string,
  inputs?: Record<string, string>,
  opts?: StepOptions,
): object {
  const inputMap = inputs
    ? Object.entries(inputs).map(([k, v]) => ({ Key: k, Value: v }))
    : [];

  const parts = action.split("/");
  let repoName = action;
  let actionPath = "";
  if (parts.length > 2) {
    repoName = `${parts[0]}/${parts[1]}`;
    actionPath = parts.slice(2).join("/");
  }

  return {
    type: "Action",
    reference: {
      type: "Repository",
      name: repoName,
      ref: ref,
      repositoryType: "GitHub",
      path: actionPath,
    },
    id: randomUUID(),
    name: action,
    displayName: displayName || `Run ${action}@${ref}`,
    contextName: opts?.stepId || action.replace(/[^a-zA-Z0-9]/g, "_"),
    condition: resolveCondition(opts?.condition),
    inputs: {
      type: 2,
      map: inputMap,
    },
    ...(opts?.environment ? {
      environment: { type: 2, map: Object.entries(opts.environment).map(([k, v]) => ({ Key: k, Value: v })) },
    } : {}),
    ...(opts?.continueOnError ? { continueOnError: true } : {}),
    ...(opts?.timeoutMinutes ? { timeoutInMinutes: opts.timeoutMinutes } : {}),
  };
}
