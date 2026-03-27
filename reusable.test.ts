import { test, expect, describe } from "bun:test";
import {
  extractWorkflowCallConfig,
  mapCallerInputs,
  mapCallerSecrets,
  extractReusableOutputs,
  aggregateConclusion,
  resolveReusableWorkflow,
} from "./reusable";
import { parseWorkflow } from "./workflow";
import type { NeedsContext } from "./server/types";

describe("extractWorkflowCallConfig", () => {
  test("extracts inputs with defaults and required flags", () => {
    const workflow = parseWorkflow(`
name: Reusable
on:
  workflow_call:
    inputs:
      environment:
        required: true
        type: string
      debug:
        required: false
        default: "false"
        type: string
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "deploy"
`);
    const config = extractWorkflowCallConfig(workflow);
    expect(config.inputs.environment).toEqual({
      required: true,
      default: undefined,
      type: "string",
      description: undefined,
    });
    expect(config.inputs.debug).toEqual({
      required: false,
      default: "false",
      type: "string",
      description: undefined,
    });
  });

  test("extracts secrets with required flags", () => {
    const workflow = parseWorkflow(`
name: Reusable
on:
  workflow_call:
    secrets:
      API_KEY:
        required: true
      OPTIONAL_SECRET:
        required: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "deploy"
`);
    const config = extractWorkflowCallConfig(workflow);
    expect(config.secrets.API_KEY).toEqual({
      required: true,
      description: undefined,
    });
    expect(config.secrets.OPTIONAL_SECRET).toEqual({
      required: false,
      description: undefined,
    });
  });

  test("extracts outputs with value expressions", () => {
    const workflow = parseWorkflow(`
name: Reusable
on:
  workflow_call:
    outputs:
      artifact_url:
        value: \${{ jobs.build.outputs.url }}
        description: The artifact URL
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      url: \${{ steps.upload.outputs.url }}
    steps:
      - run: echo "build"
`);
    const config = extractWorkflowCallConfig(workflow);
    expect(config.outputs.artifact_url).toEqual({
      value: "${{ jobs.build.outputs.url }}",
      description: "The artifact URL",
    });
  });

  test("returns empty config when no workflow_call config", () => {
    const workflow = parseWorkflow(`
name: Reusable
on:
  workflow_call:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "deploy"
`);
    const config = extractWorkflowCallConfig(workflow);
    expect(config.inputs).toEqual({});
    expect(config.secrets).toEqual({});
    expect(config.outputs).toEqual({});
  });
});

describe("mapCallerInputs", () => {
  const callConfig = {
    inputs: {
      environment: { required: true, type: "string" },
      debug: { required: false, default: "false", type: "string" },
      version: { required: false, type: "string" },
    },
    secrets: {},
    outputs: {},
  };

  test("maps caller with values to inputs", () => {
    const result = mapCallerInputs(
      { environment: "production", debug: "true" },
      callConfig,
      {},
    );
    expect(result).toEqual({
      environment: "production",
      debug: "true",
    });
  });

  test("applies defaults for missing optional inputs", () => {
    const result = mapCallerInputs(
      { environment: "staging" },
      callConfig,
      {},
    );
    expect(result.environment).toBe("staging");
    expect(result.debug).toBe("false");
    // version is optional with no default, so not included
    expect(result.version).toBeUndefined();
  });

  test("throws on missing required input", () => {
    expect(() => mapCallerInputs({}, callConfig, {})).toThrow(
      "Required input 'environment' not provided",
    );
  });

  test("evaluates expressions in with values", () => {
    const exprCtx = { "github.ref_name": "main" };
    const result = mapCallerInputs(
      { environment: "${{ github.ref_name }}" },
      callConfig,
      exprCtx,
    );
    expect(result.environment).toBe("main");
  });

  test("handles undefined callerWith", () => {
    const config = {
      inputs: { opt: { required: false, default: "default_val", type: "string" } },
      secrets: {},
      outputs: {},
    };
    const result = mapCallerInputs(undefined, config, {});
    expect(result.opt).toBe("default_val");
  });
});

describe("mapCallerSecrets", () => {
  const resolvedSecrets = {
    API_KEY: "secret123",
    DB_PASSWORD: "dbpass",
    GITHUB_TOKEN: "ghtoken",
  };

  const callConfig = {
    inputs: {},
    secrets: {
      API_KEY: { required: true },
      OPTIONAL_SECRET: { required: false },
    },
    outputs: {},
  };

  test("inherit passes all secrets through", () => {
    const result = mapCallerSecrets("inherit", resolvedSecrets, callConfig);
    expect(result).toEqual(resolvedSecrets);
  });

  test("maps explicitly provided secrets", () => {
    const result = mapCallerSecrets(
      { API_KEY: "explicit_key" },
      resolvedSecrets,
      callConfig,
    );
    expect(result.API_KEY).toBe("explicit_key");
  });

  test("falls back to resolved secrets for named config secrets", () => {
    const result = mapCallerSecrets({}, resolvedSecrets, callConfig);
    expect(result.API_KEY).toBe("secret123");
  });

  test("throws on missing required secret", () => {
    const strictConfig = {
      inputs: {},
      secrets: { MISSING: { required: true } },
      outputs: {},
    };
    expect(() => mapCallerSecrets({}, {}, strictConfig)).toThrow(
      "Required secret 'MISSING' not provided",
    );
  });
});

describe("extractReusableOutputs", () => {
  test("evaluates output expressions against called needs context", () => {
    const callConfig = {
      inputs: {},
      secrets: {},
      outputs: {
        artifact_url: { value: "${{ jobs.build.outputs.url }}" },
        version: { value: "${{ jobs.build.outputs.version }}" },
      },
    };
    const calledNeedsCtx: NeedsContext = {
      build: {
        result: "success",
        outputs: { url: "https://example.com/artifact", version: "1.2.3" },
      },
    };

    const result = extractReusableOutputs(callConfig, calledNeedsCtx);
    expect(result).toEqual({
      artifact_url: "https://example.com/artifact",
      version: "1.2.3",
    });
  });

  test("returns empty string for missing outputs", () => {
    const callConfig = {
      inputs: {},
      secrets: {},
      outputs: {
        missing: { value: "${{ jobs.build.outputs.nonexistent }}" },
      },
    };
    const calledNeedsCtx: NeedsContext = {
      build: { result: "success", outputs: {} },
    };

    const result = extractReusableOutputs(callConfig, calledNeedsCtx);
    expect(result.missing).toBe("");
  });

  test("handles empty outputs config", () => {
    const callConfig = { inputs: {}, secrets: {}, outputs: {} };
    const result = extractReusableOutputs(callConfig, {});
    expect(result).toEqual({});
  });
});

describe("aggregateConclusion", () => {
  test("returns succeeded when all succeed", () => {
    expect(
      aggregateConclusion({
        a: { result: "success", outputs: {} },
        b: { result: "success", outputs: {} },
      }),
    ).toBe("succeeded");
  });

  test("returns failed when any job fails", () => {
    expect(
      aggregateConclusion({
        a: { result: "success", outputs: {} },
        b: { result: "failure", outputs: {} },
      }),
    ).toBe("failed");
  });

  test("returns cancelled when any job is cancelled", () => {
    expect(
      aggregateConclusion({
        a: { result: "success", outputs: {} },
        b: { result: "cancelled", outputs: {} },
      }),
    ).toBe("cancelled");
  });

  test("returns skipped when all jobs are skipped", () => {
    expect(
      aggregateConclusion({
        a: { result: "skipped", outputs: {} },
        b: { result: "skipped", outputs: {} },
      }),
    ).toBe("skipped");
  });

  test("returns skipped for empty context", () => {
    expect(aggregateConclusion({})).toBe("skipped");
  });

  test("failure takes priority over cancelled", () => {
    expect(
      aggregateConclusion({
        a: { result: "failure", outputs: {} },
        b: { result: "cancelled", outputs: {} },
      }),
    ).toBe("failed");
  });
});

describe("resolveReusableWorkflow", () => {
  test("throws for remote references", async () => {
    await expect(
      resolveReusableWorkflow("owner/repo/.github/workflows/test.yml@main", "/tmp"),
    ).rejects.toThrow("Remote reusable workflow references are not yet supported");
  });

  test("throws for non-existent local file", async () => {
    await expect(
      resolveReusableWorkflow("./.github/workflows/nonexistent.yml", "/tmp"),
    ).rejects.toThrow("Reusable workflow not found");
  });
});
