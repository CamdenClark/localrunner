import { test, expect, describe } from "bun:test";
import { evaluateExpressions, buildExpressionContext } from "./expressions";
import type { RepoContext } from "./context";
import { detectOs, detectArch } from "./platform";

// Helper to build expression strings without triggering JS template parsing
function expr(name: string): string {
  return "$" + "{{ " + name + " }}";
}

const mockCtx: RepoContext = {
  owner: "testowner",
  repo: "testrepo",
  fullName: "testowner/testrepo",
  defaultBranch: "main",
  sha: "abc123def456",
  ref: "refs/heads/main",
  remoteUrl: "https://github.com/testowner/testrepo",
  token: "ghp_testtoken123",
  actor: "testuser",
  actorId: "12345",
  repositoryId: "67890",
  repositoryOwnerId: "11111",
  serverUrl: "https://github.com",
  apiUrl: "https://api.github.com",
  graphqlUrl: "https://api.github.com/graphql",
};

// --- evaluateExpressions ---

describe("evaluateExpressions", () => {
  const ctx: Record<string, string> = {
    "github.repository": "owner/repo",
    "github.actor": "someuser",
    "github.sha": "abc123",
    "github.ref": "refs/heads/main",
    "runner.os": "macOS",
    "env.MY_VAR": "hello",
  };

  test("replaces a single expression", () => {
    expect(evaluateExpressions("repo: " + expr("github.repository"), ctx)).toBe(
      "repo: owner/repo",
    );
  });

  test("replaces multiple expressions in one string", () => {
    const input =
      expr("github.actor") +
      " pushed " +
      expr("github.sha") +
      " to " +
      expr("github.ref");
    expect(evaluateExpressions(input, ctx)).toBe(
      "someuser pushed abc123 to refs/heads/main",
    );
  });

  test("handles expressions with extra whitespace", () => {
    expect(evaluateExpressions("$" + "{{   github.repository   }}", ctx)).toBe(
      "owner/repo",
    );
  });

  test("handles expressions with no whitespace", () => {
    expect(evaluateExpressions("$" + "{{github.repository}}", ctx)).toBe("owner/repo");
  });

  test("returns empty string for unknown expressions", () => {
    expect(evaluateExpressions("val=" + expr("nonexistent.thing"), ctx)).toBe("val=");
  });

  test("leaves strings without expressions unchanged", () => {
    const input = "echo hello world";
    expect(evaluateExpressions(input, ctx)).toBe("echo hello world");
  });

  test("preserves bash variable syntax", () => {
    const input = "echo ${MY_VAR} and " + expr("env.MY_VAR");
    expect(evaluateExpressions(input, ctx)).toBe("echo ${MY_VAR} and hello");
  });

  test("handles expression at start of string", () => {
    expect(evaluateExpressions(expr("runner.os") + "-latest", ctx)).toBe("macOS-latest");
  });

  test("handles expression at end of string", () => {
    expect(evaluateExpressions("os=" + expr("runner.os"), ctx)).toBe("os=macOS");
  });

  test("handles expression as entire string", () => {
    expect(evaluateExpressions(expr("github.sha"), ctx)).toBe("abc123");
  });

  test("handles empty input", () => {
    expect(evaluateExpressions("", ctx)).toBe("");
  });

  test("handles adjacent expressions", () => {
    expect(
      evaluateExpressions(expr("github.actor") + expr("github.sha"), ctx),
    ).toBe("someuserabc123");
  });

  test("handles multiline scripts with expressions", () => {
    const script =
      'echo "repo: ' +
      expr("github.repository") +
      '"\n' +
      'echo "sha: ' +
      expr("github.sha") +
      '"\n' +
      'echo "done"';
    const expected =
      'echo "repo: owner/repo"\necho "sha: abc123"\necho "done"';
    expect(evaluateExpressions(script, ctx)).toBe(expected);
  });

  test("handles empty context", () => {
    expect(evaluateExpressions(expr("anything"), {})).toBe("");
  });

  test("does not replace incomplete expression syntax", () => {
    expect(evaluateExpressions("$" + "{{ not closed", ctx)).toBe(
      "$" + "{{ not closed",
    );
    expect(evaluateExpressions("no open }}", ctx)).toBe("no open }}");
    expect(evaluateExpressions("${ single.brace }", ctx)).toBe(
      "${ single.brace }",
    );
  });
});

// --- buildExpressionContext ---

describe("buildExpressionContext", () => {
  test("populates github context fields from RepoContext", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "My Workflow", "build");
    expect(ctx["github.repository"]).toBe("testowner/testrepo");
    expect(ctx["github.repository_owner"]).toBe("testowner");
    expect(ctx["github.repository_id"]).toBe("67890");
    expect(ctx["github.repository_owner_id"]).toBe("11111");
    expect(ctx["github.actor"]).toBe("testuser");
    expect(ctx["github.triggering_actor"]).toBe("testuser");
    expect(ctx["github.sha"]).toBe("abc123def456");
    expect(ctx["github.ref"]).toBe("refs/heads/main");
    expect(ctx["github.event_name"]).toBe("push");
    expect(ctx["github.workflow"]).toBe("My Workflow");
    expect(ctx["github.job"]).toBe("build");
    expect(ctx["github.token"]).toBe("ghp_testtoken123");
  });

  test("populates URL fields from RepoContext", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job");
    expect(ctx["github.server_url"]).toBe("https://github.com");
    expect(ctx["github.api_url"]).toBe("https://api.github.com");
    expect(ctx["github.graphql_url"]).toBe("https://api.github.com/graphql");
    expect(ctx["github.repositoryUrl"]).toBe(
      "https://github.com/testowner/testrepo",
    );
  });

  test("populates GHES URL fields", () => {
    const ghesCtx: RepoContext = {
      ...mockCtx,
      serverUrl: "https://github.mycompany.com",
      apiUrl: "https://github.mycompany.com/api/v3",
      graphqlUrl: "https://github.mycompany.com/api/graphql",
    };
    const ctx = buildExpressionContext(ghesCtx, "push", {}, "wf", "job");
    expect(ctx["github.server_url"]).toBe("https://github.mycompany.com");
    expect(ctx["github.api_url"]).toBe("https://github.mycompany.com/api/v3");
    expect(ctx["github.graphql_url"]).toBe(
      "https://github.mycompany.com/api/graphql",
    );
    expect(ctx["github.repositoryUrl"]).toBe(
      "https://github.mycompany.com/testowner/testrepo",
    );
  });

  test("computes ref_name from branch ref", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job");
    expect(ctx["github.ref_name"]).toBe("main");
  });

  test("computes ref_name from tag ref", () => {
    const tagCtx: RepoContext = { ...mockCtx, ref: "refs/tags/v1.0.0" };
    const ctx = buildExpressionContext(tagCtx, "push", {}, "wf", "job");
    expect(ctx["github.ref_name"]).toBe("v1.0.0");
  });

  test("populates runner context with detected values", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job");
    expect(ctx["runner.os"]).toBe(detectOs());
    expect(ctx["runner.arch"]).toBe(detectArch());
    expect(ctx["runner.name"]).toBe("local-runner");
    expect(ctx["runner.temp"]).toBe("/tmp");
  });

  test("populates runner context with explicit values", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job", undefined, undefined, undefined, undefined, { os: "Linux", arch: "X64" });
    expect(ctx["runner.os"]).toBe("Linux");
    expect(ctx["runner.arch"]).toBe("X64");
  });

  test("flattens event payload into github.event.*", () => {
    const payload = {
      ref: "refs/heads/main",
      repository: {
        id: 123,
        full_name: "testowner/testrepo",
        owner: { login: "testowner", id: 456 },
      },
      sender: { login: "testuser", id: 789 },
    };
    const ctx = buildExpressionContext(mockCtx, "push", payload, "wf", "job");
    expect(ctx["github.event.ref"]).toBe("refs/heads/main");
    expect(ctx["github.event.repository.id"]).toBe("123");
    expect(ctx["github.event.repository.full_name"]).toBe("testowner/testrepo");
    expect(ctx["github.event.repository.owner.login"]).toBe("testowner");
    expect(ctx["github.event.repository.owner.id"]).toBe("456");
    expect(ctx["github.event.sender.login"]).toBe("testuser");
    expect(ctx["github.event.sender.id"]).toBe("789");
  });

  test("flattens deeply nested event payload", () => {
    const payload = {
      pull_request: {
        head: { ref: "feature-branch", sha: "deadbeef" },
        base: { ref: "main", sha: "cafebabe" },
      },
    };
    const ctx = buildExpressionContext(
      mockCtx,
      "pull_request",
      payload,
      "wf",
      "job",
    );
    expect(ctx["github.event.pull_request.head.ref"]).toBe("feature-branch");
    expect(ctx["github.event.pull_request.head.sha"]).toBe("deadbeef");
    expect(ctx["github.event.pull_request.base.ref"]).toBe("main");
    expect(ctx["github.event.pull_request.base.sha"]).toBe("cafebabe");
  });

  test("sets head_ref and base_ref from pull_request event", () => {
    const payload = {
      pull_request: {
        head: { ref: "feature-branch" },
        base: { ref: "main" },
      },
    };
    const ctx = buildExpressionContext(
      mockCtx,
      "pull_request",
      payload,
      "wf",
      "job",
    );
    expect(ctx["github.head_ref"]).toBe("feature-branch");
    expect(ctx["github.base_ref"]).toBe("main");
  });

  test("head_ref and base_ref are empty for push events", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job");
    expect(ctx["github.head_ref"]).toBe("");
    expect(ctx["github.base_ref"]).toBe("");
  });

  test("includes step env in env context", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job", {
      NODE_ENV: "production",
      API_KEY: "secret123",
    });
    expect(ctx["env.NODE_ENV"]).toBe("production");
    expect(ctx["env.API_KEY"]).toBe("secret123");
  });

  test("omits env context when stepEnv is undefined", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job");
    expect(Object.keys(ctx).filter((k) => k.startsWith("env."))).toEqual([]);
  });

  test("includes secrets in context", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job", undefined, {
      MY_SECRET: "s3cret",
      GITHUB_TOKEN: "ghp_abc",
    });
    expect(ctx["secrets.MY_SECRET"]).toBe("s3cret");
    expect(ctx["secrets.GITHUB_TOKEN"]).toBe("ghp_abc");
  });

  test("includes variables in context", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job", undefined, undefined, {
      MY_VAR: "hello",
      DEPLOY_ENV: "staging",
    });
    expect(ctx["vars.MY_VAR"]).toBe("hello");
    expect(ctx["vars.DEPLOY_ENV"]).toBe("staging");
  });

  test("omits secrets context when undefined", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job");
    expect(Object.keys(ctx).filter((k) => k.startsWith("secrets."))).toEqual([]);
  });

  test("omits vars context when undefined", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job");
    expect(Object.keys(ctx).filter((k) => k.startsWith("vars."))).toEqual([]);
  });

  test("handles null values in event payload", () => {
    const payload = { some_field: null, other_field: "value" };
    const ctx = buildExpressionContext(mockCtx, "push", payload, "wf", "job");
    expect(ctx["github.event.some_field"]).toBe("");
    expect(ctx["github.event.other_field"]).toBe("value");
  });

  test("handles boolean values in event payload", () => {
    const payload = { private: false, fork: true };
    const ctx = buildExpressionContext(mockCtx, "push", payload, "wf", "job");
    expect(ctx["github.event.private"]).toBe("false");
    expect(ctx["github.event.fork"]).toBe("true");
  });

  test("handles numeric values in event payload", () => {
    const payload = { number: 42 };
    const ctx = buildExpressionContext(mockCtx, "push", payload, "wf", "job");
    expect(ctx["github.event.number"]).toBe("42");
  });

  test("handles empty event payload", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "wf", "job");
    expect(
      Object.keys(ctx).filter((k) => k.startsWith("github.event.")).length,
    ).toBe(0);
  });

  test("handles array values in event payload by stringifying", () => {
    const payload = { labels: ["bug", "urgent"] };
    const ctx = buildExpressionContext(mockCtx, "push", payload, "wf", "job");
    expect(ctx["github.event.labels"]).toBe("bug,urgent");
  });
});

// --- integration: buildExpressionContext + evaluateExpressions ---

describe("expression evaluation integration", () => {
  test("evaluates a realistic workflow script", () => {
    const payload = {
      head_commit: { id: "abc123", message: "fix bug" },
      repository: { full_name: "testowner/testrepo" },
      sender: { login: "testuser" },
    };
    const ctx = buildExpressionContext(mockCtx, "push", payload, "CI", "test");

    const script =
      'echo "Repo: ' +
      expr("github.repository") +
      '"\n' +
      'echo "Commit: ' +
      expr("github.event.head_commit.id") +
      '"\n' +
      'echo "By: ' +
      expr("github.event.sender.login") +
      '"\n' +
      'echo "Ref: ' +
      expr("github.ref_name") +
      '"';

    const result = evaluateExpressions(script, ctx);
    expect(result).toBe(
      'echo "Repo: testowner/testrepo"\n' +
        'echo "Commit: abc123"\n' +
        'echo "By: testuser"\n' +
        'echo "Ref: main"',
    );
  });

  test("evaluates action inputs with expressions", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "CI", "test");
    expect(evaluateExpressions(expr("github.token"), ctx)).toBe(
      "ghp_testtoken123",
    );
  });

  test("evaluates mixed literal and expression in action input", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "CI", "test");
    const input = "https://npm.pkg.github.com/" + expr("github.repository_owner");
    expect(evaluateExpressions(input, ctx)).toBe(
      "https://npm.pkg.github.com/testowner",
    );
  });

  test("evaluates env expressions alongside github expressions", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "CI", "test", {
      NODE_VERSION: "20",
    });
    const input =
      "node " + expr("env.NODE_VERSION") + " on " + expr("runner.os");
    expect(evaluateExpressions(input, ctx)).toBe(`node 20 on ${detectOs()}`);
  });

  test("evaluates secrets expressions", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "CI", "test", undefined, {
      NPM_TOKEN: "npm_abc123",
    });
    const input = "echo " + expr("secrets.NPM_TOKEN");
    expect(evaluateExpressions(input, ctx)).toBe("echo npm_abc123");
  });

  test("evaluates vars expressions", () => {
    const ctx = buildExpressionContext(mockCtx, "push", {}, "CI", "test", undefined, undefined, {
      DEPLOY_ENV: "production",
    });
    const input = "deploy to " + expr("vars.DEPLOY_ENV");
    expect(evaluateExpressions(input, ctx)).toBe("deploy to production");
  });
});
