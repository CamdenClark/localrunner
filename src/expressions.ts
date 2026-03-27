import type { RepoContext } from "./context";
import { detectOs, detectArch } from "./platform";
import type { NeedsContext } from "./server/types";

// Build a flat lookup table for ${{ expr }} evaluation
export function buildExpressionContext(
  repoCtx: RepoContext,
  eventName: string,
  eventPayload: object,
  workflowName: string,
  jobName: string,
  stepEnv?: Record<string, string>,
  secrets?: Record<string, string>,
  variables?: Record<string, string>,
  matrix?: Record<string, string>,
  runnerInfo?: { os: string; arch: string },
  needs?: NeedsContext,
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
  const runnerOs = runnerInfo?.os ?? detectOs();
  const runnerArch = runnerInfo?.arch ?? detectArch();
  ctx["runner.os"] = runnerOs;
  ctx["runner.arch"] = runnerArch;
  ctx["runner.name"] = "local-runner";
  ctx["runner.temp"] = runnerOs === "Windows" ? (process.env["TEMP"] || "C:\\Windows\\Temp") : "/tmp";
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

  // secrets context
  if (secrets) {
    for (const [k, v] of Object.entries(secrets)) {
      ctx[`secrets.${k}`] = v;
    }
  }

  // vars context
  if (variables) {
    for (const [k, v] of Object.entries(variables)) {
      ctx[`vars.${k}`] = v;
    }
  }

  // matrix context
  if (matrix) {
    for (const [k, v] of Object.entries(matrix)) {
      ctx[`matrix.${k}`] = v;
    }
  }

  // needs context
  if (needs) {
    for (const [jobId, need] of Object.entries(needs)) {
      ctx[`needs.${jobId}.result`] = need.result;
      ctx[`needs.${jobId}.outputs`] = JSON.stringify(need.outputs);
      for (const [k, v] of Object.entries(need.outputs)) {
        ctx[`needs.${jobId}.outputs.${k}`] = v;
      }
    }
  }

  return ctx;
}

function flattenObject(obj: any, prefix: string, out: Record<string, string>) {
  if (obj == null) return;
  for (const [key, value] of Object.entries(obj)) {
    const path = `${prefix}.${key}`;
    if (Array.isArray(value)) {
      out[path] = JSON.stringify(value);
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const itemPath = `${path}.${i}`;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          out[itemPath] = JSON.stringify(item);
          flattenObject(item, itemPath, out);
        } else if (Array.isArray(item)) {
          out[itemPath] = JSON.stringify(item);
        } else {
          out[itemPath] = String(item ?? "");
        }
      }
    } else if (value && typeof value === "object") {
      out[path] = JSON.stringify(value);
      flattenObject(value, path, out);
    } else {
      out[path] = String(value ?? "");
    }
  }
}

// Resolve a single expression against the context
function resolveExpression(expr: string, ctx: Record<string, string>): string {
  // Handle toJSON() function
  const toJsonMatch = expr.match(/^toJSON\(\s*(.+?)\s*\)$/);
  if (toJsonMatch) {
    const path = toJsonMatch[1];
    const jsonValue = ctx[path];
    if (jsonValue !== undefined) {
      // If it's already JSON (object/array), pretty-print it
      try {
        return JSON.stringify(JSON.parse(jsonValue), null, 2);
      } catch {
        // Primitive string value — wrap it in JSON
        return JSON.stringify(jsonValue);
      }
    }
    return "";
  }

  // Handle .* filter (e.g., github.event.issue.labels.*.name)
  if (expr.includes(".*")) {
    const starIdx = expr.indexOf(".*.");
    if (starIdx !== -1) {
      const arrayPath = expr.slice(0, starIdx);
      const prop = expr.slice(starIdx + 3);
      const values: string[] = [];
      const pattern = new RegExp(
        `^${arrayPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\.${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      );
      for (const key of Object.keys(ctx)) {
        if (pattern.test(key)) {
          values.push(ctx[key]);
        }
      }
      return JSON.stringify(values);
    }
  }

  // Normalize bracket notation: labels[0].name → labels.0.name
  const normalized = expr.replace(/\[(\d+)\]/g, ".$1");

  const value = ctx[normalized];
  if (value !== undefined) return value;

  // Return empty string for unknown expressions (matches GitHub behavior)
  return "";
}

// Evaluate ${{ expr }} in a string, replacing with values from the context
export function evaluateExpressions(
  input: string,
  ctx: Record<string, string>,
): string {
  return input.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_match, expr: string) => {
    return resolveExpression(expr.trim(), ctx);
  });
}
