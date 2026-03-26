import { test, expect, describe } from "bun:test";
import { generateEventPayload, EVENT_DEFINITIONS, EVENT_REGISTRY } from "./events";
import type { RepoContext } from "./context";

const mockCtx: RepoContext = {
  owner: "testowner",
  repo: "testrepo",
  fullName: "testowner/testrepo",
  defaultBranch: "main",
  sha: "abc123def456",
  ref: "refs/heads/main",
  remoteUrl: "https://github.com/testowner/testrepo",
  token: "test-token",
  actor: "testuser",
  actorId: "12345",
  repositoryId: "67890",
  repositoryOwnerId: "11111",
  serverUrl: "https://github.com",
  apiUrl: "https://api.github.com",
  graphqlUrl: "https://api.github.com/graphql",
};

describe("generateEventPayload", () => {
  test("generates push payload", async () => {
    const payload = (await generateEventPayload("push", mockCtx)) as any;
    expect(payload.ref).toBe("refs/heads/main");
    expect(payload.after).toBe("abc123def456");
    expect(payload.repository.full_name).toBe("testowner/testrepo");
    expect(payload.sender.login).toBe("testuser");
    expect(payload.head_commit).toBeDefined();
    expect(payload.head_commit.id).toBe("abc123def456");
  });

  test("generates pull_request payload", async () => {
    const payload = (await generateEventPayload("pull_request", mockCtx)) as any;
    expect(payload.action).toBe("opened");
    expect(payload.number).toBe(1);
    expect(payload.pull_request).toBeDefined();
    expect(payload.pull_request.base.ref).toBe("main");
    expect(payload.repository.full_name).toBe("testowner/testrepo");
  });

  test("generates workflow_dispatch payload", async () => {
    const payload = (await generateEventPayload("workflow_dispatch", mockCtx)) as any;
    expect(payload.ref).toBe("refs/heads/main");
    expect(payload.inputs).toEqual({});
    expect(payload.repository.full_name).toBe("testowner/testrepo");
  });

  test("generates minimal payload for unknown events", async () => {
    const payload = (await generateEventPayload("custom_unknown_event", mockCtx)) as any;
    expect(payload.repository.full_name).toBe("testowner/testrepo");
    expect(payload.sender.login).toBe("testuser");
  });

  test("merges overrides into payload", async () => {
    const payload = (await generateEventPayload("push", mockCtx, {
      custom_field: "custom_value",
    })) as any;
    expect(payload.custom_field).toBe("custom_value");
    expect(payload.ref).toBe("refs/heads/main");
  });
});

describe("EVENT_REGISTRY", () => {
  test("all events have name and description", () => {
    for (const def of EVENT_DEFINITIONS) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
  });

  test("registry has same count as definitions array", () => {
    expect(EVENT_REGISTRY.size).toBe(EVENT_DEFINITIONS.length);
  });

  test("all events produce payloads with repository and sender", async () => {
    for (const [name, def] of EVENT_REGISTRY) {
      const payload = (await def.generatePayload(mockCtx)) as any;
      expect(payload.repository).toBeDefined();
      expect(payload.sender).toBeDefined();
    }
  });

  test("action events include action field matching defaultAction", async () => {
    for (const [name, def] of EVENT_REGISTRY) {
      if (def.defaultAction) {
        const payload = (await def.generatePayload(mockCtx)) as any;
        expect(payload.action).toBe(def.defaultAction);
      }
    }
  });

  test("known events generate specific payloads via generateEventPayload", async () => {
    const release = (await generateEventPayload("release", mockCtx)) as any;
    expect(release.action).toBe("published");
    expect(release.release).toBeDefined();
    expect(release.release.tag_name).toBe("v1.0.0");

    const issues = (await generateEventPayload("issues", mockCtx)) as any;
    expect(issues.action).toBe("opened");
    expect(issues.issue).toBeDefined();
    expect(issues.issue.number).toBe(1);

    const create = (await generateEventPayload("create", mockCtx)) as any;
    expect(create.ref).toBe("main");
    expect(create.ref_type).toBe("branch");
  });
});
