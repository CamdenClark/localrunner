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
  actor: string;
  actorId: string;
  repositoryId: string;
  repositoryOwnerId: string;
  serverUrl: string;
  apiUrl: string;
  graphqlUrl: string;
}

export async function getRepoContext(): Promise<RepoContext> {
  // Parse owner/repo from git remote so we can fire all API calls in parallel
  const remoteUrl = (await $`git remote get-url origin`.text()).trim();
  const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Could not parse owner/repo from remote URL: ${remoteUrl}`);
  const [, remoteOwner, remoteRepo] = match;

  const [sha, ref, token] = await Promise.all([
    $`git rev-parse HEAD`.text(),
    $`git symbolic-ref HEAD`.text().catch(() => "refs/heads/main"),
    $`gh auth token`.text().catch(() => ""),
  ]);

  // Try GitHub API calls, but fall back gracefully for repos that don't exist on GitHub
  let repoJson: { owner: { login: string }; name: string; defaultBranchRef?: { name: string }; url: string } | null = null;
  let userJson: { login: string; id: number } | null = null;
  let repoApiData: { id: number; owner: { id: number } } | null = null;

  try {
    [repoJson, userJson, repoApiData] = await Promise.all([
      $`gh repo view ${remoteOwner}/${remoteRepo} --json owner,name,defaultBranchRef,url`.json(),
      $`gh api user`.json() as Promise<{ login: string; id: number }>,
      $`gh api repos/${remoteOwner}/${remoteRepo}`.json() as Promise<{ id: number; owner: { id: number } }>,
    ]);
  } catch {
    // GitHub API unavailable or repo doesn't exist — use local git info
  }

  const fullName = repoJson
    ? `${repoJson.owner.login}/${repoJson.name}`
    : `${remoteOwner}/${remoteRepo}`;

  const repoUrl = repoJson ? new URL(repoJson.url) : new URL(`https://github.com/${remoteOwner}/${remoteRepo}`);
  const isGHES = repoUrl.hostname !== "github.com";
  const serverUrl = `${repoUrl.protocol}//${repoUrl.host}`;
  const apiUrl = isGHES ? `${serverUrl}/api/v3` : "https://api.github.com";
  const graphqlUrl = isGHES ? `${serverUrl}/api/graphql` : "https://api.github.com/graphql";

  return {
    owner: repoJson?.owner.login || remoteOwner!,
    repo: repoJson?.name || remoteRepo!,
    fullName,
    defaultBranch: repoJson?.defaultBranchRef?.name || "main",
    sha: sha.trim(),
    ref: ref.trim(),
    remoteUrl: repoJson?.url || remoteUrl,
    token: token.trim(),
    actor: userJson?.login || remoteOwner!,
    actorId: userJson ? String(userJson.id) : "0",
    repositoryId: repoApiData ? String(repoApiData.id) : "0",
    repositoryOwnerId: repoApiData ? String(repoApiData.owner.id) : "0",
    serverUrl,
    apiUrl,
    graphqlUrl,
  };
}

// Serialize an event payload object into the {t, d} context format
function serializeEventValue(v: any): any {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) {
    return { t: 1, seq: v.map(serializeEventValue) };
  }
  if (v && typeof v === "object") {
    return serializeEventPayload(v);
  }
  return v;
}

function serializeEventPayload(payload: object): { t: number; d: any[] } {
  const entries = Object.entries(payload).map(([k, v]) => {
    return { k, v: serializeEventValue(v) };
  });
  return { t: 2, d: entries };
}

export function buildGitHubContextData(
  ctx: RepoContext,
  eventName: string = "push",
  eventPayload: object = {},
  workflowName: string = "Local Workflow",
  jobName: string = "local_job",
  runId: string = "1",
  workspace: string = "",
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
      { k: "run_id", v: runId },
      { k: "run_number", v: "1" },
      { k: "run_attempt", v: "1" },
      { k: "actor", v: ctx.actor },
      { k: "triggering_actor", v: ctx.actor },
      { k: "event", v: serializeEventPayload(eventPayload) },
      { k: "server_url", v: ctx.serverUrl },
      { k: "api_url", v: ctx.apiUrl },
      { k: "graphql_url", v: ctx.graphqlUrl },
      { k: "workspace", v: workspace },
      { k: "action", v: "" },
      { k: "token", v: ctx.token },
      { k: "repositoryUrl", v: `${ctx.serverUrl}/${ctx.fullName}` },
      { k: "retention_days", v: "90" },
      { k: "repository_id", v: ctx.repositoryId },
      { k: "repository_owner_id", v: ctx.repositoryOwnerId },
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
