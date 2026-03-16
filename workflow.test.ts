import { test, expect, describe } from "bun:test";
import { parseWorkflow, matchesEvent, normalizeOn, workflowStepsToRunnerSteps } from "./workflow";
import { scriptStep, actionStep } from "./server";

describe("parseWorkflow", () => {
  test("parses a basic workflow", () => {
    const yaml = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo hello
`;
    const w = parseWorkflow(yaml);
    expect(w.name).toBe("CI");
    expect(w.on).toBe("push");
    expect(Object.keys(w.jobs)).toEqual(["build"]);
    expect(w.jobs.build.steps).toHaveLength(2);
  });

  test("parses on as array", () => {
    const yaml = `
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const w = parseWorkflow(yaml);
    expect(w.on).toEqual(["push", "pull_request"]);
  });

  test("parses on as object with config", () => {
    const yaml = `
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const w = parseWorkflow(yaml);
    expect(typeof w.on).toBe("object");
    expect(Array.isArray(w.on)).toBe(false);
  });

  test("parses step with inputs", () => {
    const yaml = `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: main
`;
    const w = parseWorkflow(yaml);
    const step = w.jobs.build.steps![0];
    expect(step.with).toEqual({ "fetch-depth": 0, ref: "main" });
  });
});

describe("normalizeOn", () => {
  test("normalizes string to record", () => {
    expect(normalizeOn("push")).toEqual({ push: null });
  });

  test("normalizes array to record", () => {
    expect(normalizeOn(["push", "pull_request"])).toEqual({
      push: null,
      pull_request: null,
    });
  });

  test("passes through object", () => {
    const on = { push: { branches: ["main"] }, pull_request: null };
    expect(normalizeOn(on)).toEqual(on);
  });
});

describe("matchesEvent", () => {
  test("matches string on", () => {
    const w = parseWorkflow(`
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(matchesEvent(w, "push")).toBe(true);
    expect(matchesEvent(w, "pull_request")).toBe(false);
  });

  test("matches array on", () => {
    const w = parseWorkflow(`
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(matchesEvent(w, "push")).toBe(true);
    expect(matchesEvent(w, "pull_request")).toBe(true);
    expect(matchesEvent(w, "workflow_dispatch")).toBe(false);
  });

  test("matches object on", () => {
    const w = parseWorkflow(`
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(matchesEvent(w, "push")).toBe(true);
    expect(matchesEvent(w, "workflow_dispatch")).toBe(true);
    expect(matchesEvent(w, "pull_request")).toBe(false);
  });
});

describe("workflowStepsToRunnerSteps", () => {
  test("converts action steps", () => {
    const steps = [{ uses: "actions/checkout@v4", name: "Checkout" }];
    const result = workflowStepsToRunnerSteps(steps, scriptStep, actionStep);
    expect(result).toHaveLength(1);
    expect((result[0] as any).reference.type).toBe("Repository");
    expect((result[0] as any).reference.name).toBe("actions/checkout");
    expect((result[0] as any).reference.ref).toBe("v4");
    expect((result[0] as any).displayName).toBe("Checkout");
  });

  test("converts script steps", () => {
    const steps = [{ run: "echo hello", name: "Say hello" }];
    const result = workflowStepsToRunnerSteps(steps, scriptStep, actionStep);
    expect(result).toHaveLength(1);
    expect((result[0] as any).reference.type).toBe("Script");
    expect((result[0] as any).displayName).toBe("Say hello");
  });

  test("converts action with inputs", () => {
    const steps = [{ uses: "actions/setup-node@v4", with: { "node-version": "20" } }];
    const result = workflowStepsToRunnerSteps(steps, scriptStep, actionStep);
    expect((result[0] as any).inputs.map).toEqual([{ Key: "node-version", Value: "20" }]);
  });

  test("throws on step without uses or run", () => {
    const steps = [{ name: "Invalid step" }];
    expect(() => workflowStepsToRunnerSteps(steps, scriptStep, actionStep)).toThrow("must have either");
  });

  test("throws on invalid action ref without @", () => {
    const steps = [{ uses: "actions/checkout" }];
    expect(() => workflowStepsToRunnerSteps(steps, scriptStep, actionStep)).toThrow("missing @version");
  });
});
