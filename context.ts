import { $ } from "bun";

export interface RepoContext {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  sha: string;
  ref: string;
  remoteUrl: string;
  token: string;
}

export async function getRepoContext(): Promise<RepoContext> {
  const [repoJson, sha, ref, token] = await Promise.all([
    $`gh repo view --json owner,name,defaultBranchRef,url`.json(),
    $`git rev-parse HEAD`.text(),
    $`git symbolic-ref HEAD`.text().catch(() => "refs/heads/main"),
    $`gh auth token`.text(),
  ]);

  return {
    owner: repoJson.owner.login,
    repo: repoJson.name,
    fullName: `${repoJson.owner.login}/${repoJson.name}`,
    defaultBranch: repoJson.defaultBranchRef?.name || "main",
    sha: sha.trim(),
    ref: ref.trim(),
    remoteUrl: repoJson.url,
    token: token.trim(),
  };
}

// Serialize an event payload object into the {t, d} context format
function serializeEventPayload(payload: object): { t: number; d: any[] } {
  const entries = Object.entries(payload).map(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return { k, v: serializeEventPayload(v) };
    }
    return { k, v };
  });
  return { t: 2, d: entries };
}

export function buildGitHubContextData(
  ctx: RepoContext,
  eventName: string = "push",
  eventPayload: object = {},
  workflowName: string = "Local Workflow",
  jobName: string = "local_job",
): object {
  const headRef = eventName === "pull_request"
    ? (eventPayload as any)?.pull_request?.head?.ref || ""
    : "";
  const baseRef = eventName === "pull_request"
    ? (eventPayload as any)?.pull_request?.base?.ref || ""
    : "";

  return {
    t: 2,
    d: [
      { k: "repository", v: ctx.fullName },
      { k: "repository_owner", v: ctx.owner },
      { k: "sha", v: ctx.sha },
      { k: "ref", v: ctx.ref },
      { k: "head_ref", v: headRef },
      { k: "base_ref", v: baseRef },
      { k: "event_name", v: eventName },
      { k: "workflow", v: workflowName },
      { k: "run_id", v: "1" },
      { k: "run_number", v: "1" },
      { k: "run_attempt", v: "1" },
      { k: "actor", v: ctx.owner },
      { k: "triggering_actor", v: ctx.owner },
      { k: "event", v: serializeEventPayload(eventPayload) },
      { k: "server_url", v: "https://github.com" },
      { k: "api_url", v: "https://api.github.com" },
      { k: "graphql_url", v: "https://api.github.com/graphql" },
      { k: "workspace", v: "" },
      { k: "action", v: "" },
      { k: "token", v: ctx.token },
      { k: "repositoryUrl", v: `https://github.com/${ctx.fullName}` },
      { k: "retention_days", v: "90" },
      { k: "repository_id", v: "1" },
      { k: "repository_owner_id", v: "1" },
      { k: "action_path", v: "" },
      { k: "action_ref", v: "" },
      { k: "action_repository", v: "" },
      { k: "action_status", v: "" },
      { k: "job", v: jobName },
      { k: "path", v: "" },
      { k: "env", v: "" },
      { k: "step_summary", v: "" },
      { k: "output", v: "" },
      { k: "state", v: "" },
    ],
  };
}
