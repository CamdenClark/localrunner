import { randomUUID } from "crypto";

export function scriptStep(
  script: string,
  displayName?: string,
): object {
  return {
    type: "Action",
    reference: { type: "Script" },
    id: randomUUID(),
    name: "__run",
    displayName: displayName || `Run ${script.slice(0, 40)}`,
    contextName: `run_${randomUUID().slice(0, 8)}`,
    condition: "success()",
    inputs: {
      type: 2,
      map: [{ Key: "script", Value: script }],
    },
  };
}

export function actionStep(
  action: string,
  ref: string,
  displayName?: string,
  inputs?: Record<string, string>,
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
    contextName: action.replace(/[^a-zA-Z0-9]/g, "_"),
    condition: "success()",
    inputs: {
      type: 2,
      map: inputMap,
    },
  };
}
