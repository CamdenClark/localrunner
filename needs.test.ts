import { test, expect, describe } from "bun:test";
import { topologicalSortJobs } from "./cli";

describe("topologicalSortJobs", () => {
  test("single job with no dependencies", () => {
    const result = topologicalSortJobs({ build: {} });
    expect(result).toEqual(["build"]);
  });

  test("two independent jobs", () => {
    const result = topologicalSortJobs({
      build: {},
      test: {},
    });
    expect(result).toEqual(["build", "test"]);
  });

  test("linear dependency chain", () => {
    const result = topologicalSortJobs({
      deploy: { needs: "test" },
      test: { needs: "build" },
      build: {},
    });
    expect(result).toEqual(["build", "test", "deploy"]);
  });

  test("needs as array", () => {
    const result = topologicalSortJobs({
      deploy: { needs: ["build", "test"] },
      build: {},
      test: {},
    });
    expect(result.indexOf("build")).toBeLessThan(result.indexOf("deploy"));
    expect(result.indexOf("test")).toBeLessThan(result.indexOf("deploy"));
  });

  test("needs as single string", () => {
    const result = topologicalSortJobs({
      deploy: { needs: "build" },
      build: {},
    });
    expect(result).toEqual(["build", "deploy"]);
  });

  test("diamond dependency", () => {
    const result = topologicalSortJobs({
      deploy: { needs: ["test-unit", "test-e2e"] },
      "test-unit": { needs: "build" },
      "test-e2e": { needs: "build" },
      build: {},
    });
    expect(result.indexOf("build")).toBe(0);
    expect(result.indexOf("deploy")).toBe(3);
  });

  test("throws on circular dependency", () => {
    expect(() =>
      topologicalSortJobs({
        a: { needs: "b" },
        b: { needs: "a" },
      }),
    ).toThrow("Circular dependency");
  });

  test("throws on unknown dependency", () => {
    expect(() =>
      topologicalSortJobs({
        deploy: { needs: "nonexistent" },
      }),
    ).toThrow("unknown job 'nonexistent'");
  });
});
