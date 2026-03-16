import type { RepoContext } from "./context";
import { $ } from "bun";

// --- Generate event payloads based on event type + local git state ---

async function getLatestCommitMessage(): Promise<string> {
  try {
    return (await $`git log -1 --format=%s`.text()).trim();
  } catch {
    return "local commit";
  }
}

async function getPreviousSha(): Promise<string> {
  try {
    return (await $`git rev-parse HEAD~1`.text()).trim();
  } catch {
    return "0000000000000000000000000000000000000000";
  }
}

async function getCurrentBranch(): Promise<string> {
  try {
    return (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
  } catch {
    return "main";
  }
}

function repoPayload(ctx: RepoContext) {
  return {
    id: 1,
    name: ctx.repo,
    full_name: ctx.fullName,
    owner: {
      login: ctx.owner,
      id: 1,
    },
    html_url: `https://github.com/${ctx.fullName}`,
    default_branch: ctx.defaultBranch,
    private: false,
  };
}

function senderPayload(ctx: RepoContext) {
  return {
    login: ctx.owner,
    id: 1,
  };
}

async function generatePushPayload(ctx: RepoContext): Promise<object> {
  const [before, commitMsg] = await Promise.all([
    getPreviousSha(),
    getLatestCommitMessage(),
  ]);

  return {
    ref: ctx.ref,
    before,
    after: ctx.sha,
    created: false,
    deleted: false,
    forced: false,
    head_commit: {
      id: ctx.sha,
      message: commitMsg,
      timestamp: new Date().toISOString(),
      author: { name: ctx.owner, email: "", username: ctx.owner },
    },
    repository: repoPayload(ctx),
    sender: senderPayload(ctx),
  };
}

async function generatePullRequestPayload(ctx: RepoContext): Promise<object> {
  const branch = await getCurrentBranch();

  return {
    action: "opened",
    number: 1,
    pull_request: {
      number: 1,
      state: "open",
      title: `PR from ${branch}`,
      head: {
        ref: branch,
        sha: ctx.sha,
        repo: repoPayload(ctx),
      },
      base: {
        ref: ctx.defaultBranch,
        sha: ctx.sha,
        repo: repoPayload(ctx),
      },
      user: senderPayload(ctx),
      html_url: `https://github.com/${ctx.fullName}/pull/1`,
    },
    repository: repoPayload(ctx),
    sender: senderPayload(ctx),
  };
}

function generateWorkflowDispatchPayload(ctx: RepoContext): object {
  return {
    ref: ctx.ref,
    inputs: {},
    repository: repoPayload(ctx),
    sender: senderPayload(ctx),
    workflow: "",
  };
}

export async function generateEventPayload(
  eventName: string,
  ctx: RepoContext,
  overrides?: object,
): Promise<object> {
  let payload: object;

  switch (eventName) {
    case "push":
      payload = await generatePushPayload(ctx);
      break;
    case "pull_request":
      payload = await generatePullRequestPayload(ctx);
      break;
    case "workflow_dispatch":
      payload = generateWorkflowDispatchPayload(ctx);
      break;
    default:
      // For unknown events, provide minimal payload
      payload = {
        repository: repoPayload(ctx),
        sender: senderPayload(ctx),
      };
  }

  if (overrides) {
    return { ...payload, ...overrides };
  }

  return payload;
}
