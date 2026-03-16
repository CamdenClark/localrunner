import { test, expect, describe } from "bun:test";
import { generateEventPayload } from "./events";
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
};

describe("generateEventPayload", () => {
  test("generates push payload", async () => {
    const payload = (await generateEventPayload("push", mockCtx)) as any;
    expect(payload.ref).toBe("refs/heads/main");
    expect(payload.after).toBe("abc123def456");
    expect(payload.repository.full_name).toBe("testowner/testrepo");
    expect(payload.sender.login).toBe("testowner");
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
    const payload = (await generateEventPayload("release", mockCtx)) as any;
    expect(payload.repository.full_name).toBe("testowner/testrepo");
    expect(payload.sender.login).toBe("testowner");
  });

  test("merges overrides into payload", async () => {
    const payload = (await generateEventPayload("push", mockCtx, {
      custom_field: "custom_value",
    })) as any;
    expect(payload.custom_field).toBe("custom_value");
    expect(payload.ref).toBe("refs/heads/main");
  });
});
