import type { RepoContext } from "./context";
import { $ } from "bun";

// --- Types ---

export interface EventPayloadOptions {
  inputDefaults?: Record<string, string>;
}

export interface EventDefinition {
  name: string;
  description: string;
  defaultAction: string | null;
  validActions: string[];
  supportsFilters: { branches: boolean; paths: boolean; tags: boolean };
  generatePayload: (ctx: RepoContext, options?: EventPayloadOptions) => Promise<object> | object;
}

// --- Git helpers ---

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

// --- Payload helpers ---

function repoPayload(ctx: RepoContext) {
  return {
    id: Number(ctx.repositoryId),
    name: ctx.repo,
    full_name: ctx.fullName,
    owner: {
      login: ctx.owner,
      id: Number(ctx.repositoryOwnerId),
    },
    html_url: `${ctx.serverUrl}/${ctx.fullName}`,
    default_branch: ctx.defaultBranch,
    private: false,
  };
}

function senderPayload(ctx: RepoContext) {
  return {
    login: ctx.actor,
    id: Number(ctx.actorId),
  };
}

function basePayload(ctx: RepoContext) {
  return {
    repository: repoPayload(ctx),
    sender: senderPayload(ctx),
  };
}

function entityPayload(
  ctx: RepoContext,
  action: string,
  entityKey: string,
  entityFields: Record<string, unknown> = {},
) {
  return {
    action,
    [entityKey]: { id: 1, node_id: "stub", ...entityFields },
    ...basePayload(ctx),
  };
}

// --- Custom payload generators ---

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
      author: { name: ctx.actor, email: "", username: ctx.actor },
    },
    ...basePayload(ctx),
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
      html_url: `${ctx.serverUrl}/${ctx.fullName}/pull/1`,
    },
    ...basePayload(ctx),
  };
}

function generateWorkflowDispatchPayload(ctx: RepoContext, opts?: EventPayloadOptions): object {
  return {
    ref: ctx.ref,
    inputs: opts?.inputDefaults ?? {},
    workflow: "",
    ...basePayload(ctx),
  };
}

// --- No-filter shorthand ---
const noFilters = { branches: false, paths: false, tags: false };

// --- Event definitions ---

export const EVENT_DEFINITIONS: EventDefinition[] = [
  // Custom generators
  {
    name: "push",
    description: "Push to a branch or tag",
    defaultAction: null,
    validActions: [],
    supportsFilters: { branches: true, paths: true, tags: true },
    generatePayload: (ctx) => generatePushPayload(ctx),
  },
  {
    name: "pull_request",
    description: "Pull request activity",
    defaultAction: "opened",
    validActions: [
      "opened", "edited", "closed", "reopened", "synchronize", "assigned", "unassigned",
      "labeled", "unlabeled", "ready_for_review", "converted_to_draft", "locked", "unlocked",
      "enqueued", "dequeued", "milestoned", "demilestoned", "review_requested",
      "review_request_removed", "auto_merge_enabled", "auto_merge_disabled",
    ],
    supportsFilters: { branches: true, paths: true, tags: false },
    generatePayload: (ctx) => generatePullRequestPayload(ctx),
  },
  {
    name: "pull_request_target",
    description: "Pull request activity (runs in base branch context)",
    defaultAction: "opened",
    validActions: [
      "opened", "edited", "closed", "reopened", "synchronize", "assigned", "unassigned",
      "labeled", "unlabeled", "ready_for_review", "converted_to_draft", "locked", "unlocked",
      "enqueued", "dequeued", "milestoned", "demilestoned", "review_requested",
      "review_request_removed", "auto_merge_enabled", "auto_merge_disabled",
    ],
    supportsFilters: { branches: true, paths: true, tags: false },
    generatePayload: (ctx) => generatePullRequestPayload(ctx),
  },
  {
    name: "workflow_dispatch",
    description: "Manual workflow trigger with optional inputs",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx, opts) => generateWorkflowDispatchPayload(ctx, opts),
  },

  // Issue & PR comment events
  {
    name: "issues",
    description: "Issue activity",
    defaultAction: "opened",
    validActions: [
      "opened", "edited", "deleted", "pinned", "unpinned", "closed", "reopened",
      "assigned", "unassigned", "labeled", "unlabeled", "locked", "unlocked",
      "transferred", "milestoned", "demilestoned",
    ],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "opened", "issue", {
      number: 1, title: "Test issue", body: "", state: "open",
      html_url: `${ctx.serverUrl}/${ctx.fullName}/issues/1`,
      labels: [], assignees: [], comments: 0, locked: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      user: senderPayload(ctx),
    }),
  },
  {
    name: "issue_comment",
    description: "Comment on an issue or pull request",
    defaultAction: "created",
    validActions: ["created", "edited", "deleted"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      action: "created",
      issue: { id: 1, number: 1, title: "Test issue", state: "open",
        html_url: `${ctx.serverUrl}/${ctx.fullName}/issues/1`,
        user: senderPayload(ctx) },
      comment: { id: 1, body: "Test comment", user: senderPayload(ctx) },
      ...basePayload(ctx),
    }),
  },
  {
    name: "pull_request_review",
    description: "Pull request review submitted, edited, or dismissed",
    defaultAction: "submitted",
    validActions: ["submitted", "edited", "dismissed"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      action: "submitted",
      review: { id: 1, state: "approved", body: "", user: senderPayload(ctx) },
      pull_request: { number: 1, title: "Test PR", state: "open",
        html_url: `${ctx.serverUrl}/${ctx.fullName}/pull/1`,
        user: senderPayload(ctx) },
      ...basePayload(ctx),
    }),
  },
  {
    name: "pull_request_review_comment",
    description: "Comment on a pull request diff",
    defaultAction: "created",
    validActions: ["created", "edited", "deleted"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      action: "created",
      comment: { id: 1, body: "Test comment", path: "file.txt", user: senderPayload(ctx) },
      pull_request: { number: 1, title: "Test PR", state: "open",
        html_url: `${ctx.serverUrl}/${ctx.fullName}/pull/1`,
        user: senderPayload(ctx) },
      ...basePayload(ctx),
    }),
  },
  {
    name: "pull_request_review_thread",
    description: "Pull request comment thread resolved or unresolved",
    defaultAction: "resolved",
    validActions: ["resolved", "unresolved"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      action: "resolved",
      thread: { id: 1, node_id: "stub" },
      pull_request: { number: 1, title: "Test PR", state: "open",
        html_url: `${ctx.serverUrl}/${ctx.fullName}/pull/1`,
        user: senderPayload(ctx) },
      ...basePayload(ctx),
    }),
  },

  // Discussion events
  {
    name: "discussion",
    description: "Discussion activity",
    defaultAction: "created",
    validActions: [
      "created", "edited", "deleted", "transferred", "pinned", "unpinned",
      "labeled", "unlabeled", "locked", "unlocked", "category_changed", "answered", "unanswered",
    ],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "created", "discussion", {
      number: 1, title: "Test discussion",
      html_url: `${ctx.serverUrl}/${ctx.fullName}/discussions/1`,
      user: senderPayload(ctx),
    }),
  },
  {
    name: "discussion_comment",
    description: "Comment on a discussion",
    defaultAction: "created",
    validActions: ["created", "edited", "deleted"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      action: "created",
      discussion: { id: 1, number: 1, title: "Test discussion",
        html_url: `${ctx.serverUrl}/${ctx.fullName}/discussions/1`,
        user: senderPayload(ctx) },
      comment: { id: 1, body: "Test comment", user: senderPayload(ctx) },
      ...basePayload(ctx),
    }),
  },

  // Ref lifecycle events
  {
    name: "create",
    description: "Branch or tag created",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      ref: ctx.ref.replace(/^refs\/(heads|tags)\//, ""),
      ref_type: ctx.ref.startsWith("refs/tags/") ? "tag" : "branch",
      master_branch: ctx.defaultBranch,
      ...basePayload(ctx),
    }),
  },
  {
    name: "delete",
    description: "Branch or tag deleted",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      ref: ctx.ref.replace(/^refs\/(heads|tags)\//, ""),
      ref_type: ctx.ref.startsWith("refs/tags/") ? "tag" : "branch",
      ...basePayload(ctx),
    }),
  },

  // Repository events
  {
    name: "fork",
    description: "Repository forked",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      forkee: {
        id: 2,
        full_name: `${ctx.actor}/${ctx.repo}`,
        owner: senderPayload(ctx),
        html_url: `${ctx.serverUrl}/${ctx.actor}/${ctx.repo}`,
      },
      ...basePayload(ctx),
    }),
  },
  {
    name: "gollum",
    description: "Wiki page created or updated",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      pages: [{ page_name: "Home", title: "Home", action: "created",
        html_url: `${ctx.serverUrl}/${ctx.fullName}/wiki/Home` }],
      ...basePayload(ctx),
    }),
  },
  {
    name: "public",
    description: "Repository changed from private to public",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => basePayload(ctx),
  },
  {
    name: "watch",
    description: "Repository starred",
    defaultAction: "started",
    validActions: ["started"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({ action: "started", ...basePayload(ctx) }),
  },

  // Label, milestone, project events
  {
    name: "label",
    description: "Label created, edited, or deleted",
    defaultAction: "created",
    validActions: ["created", "edited", "deleted"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "created", "label", {
      name: "bug", color: "d73a4a", description: "Something isn't working",
    }),
  },
  {
    name: "milestone",
    description: "Milestone activity",
    defaultAction: "created",
    validActions: ["created", "closed", "opened", "edited", "deleted"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "created", "milestone", {
      number: 1, title: "v1.0", state: "open",
      html_url: `${ctx.serverUrl}/${ctx.fullName}/milestone/1`,
    }),
  },
  {
    name: "project",
    description: "Classic project board activity",
    defaultAction: "created",
    validActions: ["created", "closed", "reopened", "edited", "deleted"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "created", "project", {
      name: "Test project",
      html_url: `${ctx.serverUrl}/${ctx.fullName}/projects/1`,
    }),
  },
  {
    name: "project_card",
    description: "Classic project card activity",
    defaultAction: "created",
    validActions: ["created", "moved", "converted", "edited", "deleted"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "created", "project_card", {
      note: "Test card",
    }),
  },
  {
    name: "project_column",
    description: "Classic project column activity",
    defaultAction: "created",
    validActions: ["created", "updated", "moved", "deleted"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "created", "project_column", {
      name: "To Do",
    }),
  },

  // Release & registry
  {
    name: "release",
    description: "Release published, edited, or deleted",
    defaultAction: "published",
    validActions: ["published", "unpublished", "created", "edited", "deleted", "prereleased", "released"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "published", "release", {
      tag_name: "v1.0.0", name: "v1.0.0", draft: false, prerelease: false,
      html_url: `${ctx.serverUrl}/${ctx.fullName}/releases/tag/v1.0.0`,
      author: senderPayload(ctx),
    }),
  },
  {
    name: "registry_package",
    description: "GitHub Packages activity",
    defaultAction: "published",
    validActions: ["published", "updated"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "published", "registry_package", {
      name: ctx.repo, package_type: "container",
    }),
  },

  // CI/CD events
  {
    name: "check_run",
    description: "Check run activity",
    defaultAction: "completed",
    validActions: ["created", "completed", "rerequested", "requested_action"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "completed", "check_run", {
      name: "test", head_sha: ctx.sha, status: "completed", conclusion: "success",
      html_url: `${ctx.serverUrl}/${ctx.fullName}/runs/1`,
    }),
  },
  {
    name: "check_suite",
    description: "Check suite activity",
    defaultAction: "completed",
    validActions: ["completed", "requested", "rerequested"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "completed", "check_suite", {
      head_sha: ctx.sha, head_branch: ctx.ref.replace("refs/heads/", ""),
      status: "completed", conclusion: "success",
    }),
  },
  {
    name: "deployment",
    description: "Deployment created",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      deployment: {
        id: 1, node_id: "stub", sha: ctx.sha,
        ref: ctx.ref, environment: "production",
        creator: senderPayload(ctx),
      },
      ...basePayload(ctx),
    }),
  },
  {
    name: "deployment_status",
    description: "Deployment status updated",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      deployment_status: {
        id: 1, node_id: "stub", state: "success",
        environment: "production",
        creator: senderPayload(ctx),
      },
      deployment: {
        id: 1, node_id: "stub", sha: ctx.sha,
        ref: ctx.ref, environment: "production",
        creator: senderPayload(ctx),
      },
      ...basePayload(ctx),
    }),
  },
  {
    name: "status",
    description: "Commit status updated",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      sha: ctx.sha, state: "success", context: "default",
      description: "", target_url: "",
      ...basePayload(ctx),
    }),
  },
  {
    name: "page_build",
    description: "GitHub Pages build completed",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      build: { status: "built", error: { message: null } },
      ...basePayload(ctx),
    }),
  },

  // Branch protection & merge
  {
    name: "branch_protection_rule",
    description: "Branch protection rule activity",
    defaultAction: "created",
    validActions: ["created", "edited", "deleted"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "created", "rule", {
      name: ctx.defaultBranch,
    }),
  },
  {
    name: "merge_group",
    description: "Merge queue activity",
    defaultAction: "checks_requested",
    validActions: ["checks_requested", "destroyed"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "checks_requested", "merge_group", {
      head_sha: ctx.sha,
      head_ref: `refs/heads/gh-readonly-queue/${ctx.defaultBranch}/pr-1`,
      base_sha: ctx.sha,
      base_ref: `refs/heads/${ctx.defaultBranch}`,
    }),
  },

  // Workflow events
  {
    name: "workflow_run",
    description: "Workflow run requested or completed",
    defaultAction: "completed",
    validActions: ["completed", "requested", "in_progress"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      action: "completed",
      workflow_run: {
        id: 1, node_id: "stub", name: "CI", head_sha: ctx.sha,
        head_branch: ctx.ref.replace("refs/heads/", ""),
        status: "completed", conclusion: "success",
        html_url: `${ctx.serverUrl}/${ctx.fullName}/actions/runs/1`,
      },
      workflow: { id: 1, name: "CI", path: ".github/workflows/ci.yml" },
      ...basePayload(ctx),
    }),
  },
  {
    name: "workflow_call",
    description: "Reusable workflow called from another workflow",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => basePayload(ctx),
  },
  {
    name: "repository_dispatch",
    description: "Custom webhook event via API",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      action: "",
      client_payload: {},
      ...basePayload(ctx),
    }),
  },
  {
    name: "schedule",
    description: "Scheduled cron trigger",
    defaultAction: null,
    validActions: [],
    supportsFilters: noFilters,
    generatePayload: (ctx) => ({
      schedule: "",
      ...basePayload(ctx),
    }),
  },

  // Security events
  {
    name: "code_scanning_alert",
    description: "Code scanning alert activity",
    defaultAction: "appeared_in_branch",
    validActions: ["appeared_in_branch", "closed_by_user", "created", "fixed", "reopened", "reopened_by_user"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "appeared_in_branch", "alert", {
      number: 1, state: "open",
      rule: { id: "test-rule", severity: "warning" },
      tool: { name: "test-tool" },
    }),
  },
  {
    name: "secret_scanning_alert",
    description: "Secret scanning alert activity",
    defaultAction: "created",
    validActions: ["created", "resolved", "reopened", "validated"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "created", "alert", {
      number: 1, secret_type: "test_secret",
      html_url: `${ctx.serverUrl}/${ctx.fullName}/security/secret-scanning/1`,
    }),
  },
  {
    name: "dependabot_alert",
    description: "Dependabot alert activity",
    defaultAction: "created",
    validActions: ["created", "dismissed", "fixed", "reintroduced", "reopened"],
    supportsFilters: noFilters,
    generatePayload: (ctx) => entityPayload(ctx, "created", "alert", {
      number: 1, state: "open",
      dependency: { package: { name: "test-package" } },
    }),
  },
];

export const EVENT_REGISTRY: Map<string, EventDefinition> = new Map(
  EVENT_DEFINITIONS.map((e) => [e.name, e]),
);

// --- Public API ---

export async function generateEventPayload(
  eventName: string,
  ctx: RepoContext,
  overrides?: object,
  inputDefaults?: Record<string, string>,
): Promise<object> {
  const definition = EVENT_REGISTRY.get(eventName);

  let payload: object;
  if (definition) {
    payload = await definition.generatePayload(ctx, { inputDefaults });
  } else {
    payload = basePayload(ctx);
  }

  if (overrides) {
    return { ...payload, ...overrides };
  }

  return payload;
}
