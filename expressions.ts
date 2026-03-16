import type { RepoContext } from "./context";

// Build a flat lookup table for ${{ expr }} evaluation
export function buildExpressionContext(
  repoCtx: RepoContext,
  eventName: string,
  eventPayload: object,
  workflowName: string,
  jobName: string,
  stepEnv?: Record<string, string>,
): Record<string, string> {
  const ctx: Record<string, string> = {};

  // github context
  ctx["github.repository"] = repoCtx.fullName;
  ctx["github.repository_owner"] = repoCtx.owner;
  ctx["github.repository_id"] = repoCtx.repositoryId;
  ctx["github.repository_owner_id"] = repoCtx.repositoryOwnerId;
  ctx["github.actor"] = repoCtx.actor;
  ctx["github.triggering_actor"] = repoCtx.actor;
  ctx["github.sha"] = repoCtx.sha;
  ctx["github.ref"] = repoCtx.ref;
  ctx["github.ref_name"] = repoCtx.ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
  ctx["github.event_name"] = eventName;
  ctx["github.workflow"] = workflowName;
  ctx["github.job"] = jobName;
  ctx["github.run_id"] = "1";
  ctx["github.run_number"] = "1";
  ctx["github.run_attempt"] = "1";
  ctx["github.server_url"] = repoCtx.serverUrl;
  ctx["github.api_url"] = repoCtx.apiUrl;
  ctx["github.graphql_url"] = repoCtx.graphqlUrl;
  ctx["github.repositoryUrl"] = `${repoCtx.serverUrl}/${repoCtx.fullName}`;
  ctx["github.token"] = repoCtx.token;
  ctx["github.head_ref"] = "";
  ctx["github.base_ref"] = "";
  ctx["github.workspace"] = "";
  ctx["github.action"] = "";
  ctx["github.action_path"] = "";
  ctx["github.action_ref"] = "";
  ctx["github.action_repository"] = "";
  ctx["github.action_status"] = "";
  ctx["github.retention_days"] = "90";

  // runner context
  ctx["runner.os"] = "macOS";
  ctx["runner.arch"] = "ARM64";
  ctx["runner.name"] = "local-runner";
  ctx["runner.temp"] = "/tmp";
  ctx["runner.tool_cache"] = "";
  ctx["runner.workspace"] = "";
  ctx["runner.debug"] = "";

  // Flatten event payload into github.event.* paths
  flattenObject(eventPayload, "github.event", ctx);

  // Pull request head/base refs
  const pr = (eventPayload as any)?.pull_request;
  if (pr) {
    ctx["github.head_ref"] = pr.head?.ref || "";
    ctx["github.base_ref"] = pr.base?.ref || "";
  }

  // env context from step-level env
  if (stepEnv) {
    for (const [k, v] of Object.entries(stepEnv)) {
      ctx[`env.${k}`] = v;
    }
  }

  return ctx;
}

function flattenObject(obj: any, prefix: string, out: Record<string, string>) {
  if (obj == null) return;
  for (const [key, value] of Object.entries(obj)) {
    const path = `${prefix}.${key}`;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value, path, out);
    } else {
      out[path] = String(value ?? "");
    }
  }
}

// Evaluate ${{ expr }} in a string, replacing with values from the context
export function evaluateExpressions(
  input: string,
  ctx: Record<string, string>,
): string {
  return input.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_match, expr: string) => {
    const value = ctx[expr.trim()];
    if (value !== undefined) return value;
    // Return empty string for unknown expressions (matches GitHub behavior)
    return "";
  });
}
