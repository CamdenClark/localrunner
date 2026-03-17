import { test, expect, describe } from "bun:test";
import { parseEnvFile, scanRequiredSecrets, resolveSecrets } from "./secrets";
import { join } from "path";
import { tmpdir } from "os";

async function writeTmpFile(content: string): Promise<string> {
  const path = join(tmpdir(), `test-secrets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await Bun.write(path, content);
  return path;
}

describe("parseEnvFile", () => {
  test("parses KEY=VALUE lines", async () => {
    const path = await writeTmpFile("FOO=bar\nBAZ=qux\n");
    const result = await parseEnvFile(path);
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("skips comments and blank lines", async () => {
    const path = await writeTmpFile("# comment\n\nFOO=bar\n  # another comment\n\nBAZ=qux");
    const result = await parseEnvFile(path);
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("strips surrounding double quotes", async () => {
    const path = await writeTmpFile('MY_SECRET="hello world"');
    const result = await parseEnvFile(path);
    expect(result).toEqual({ MY_SECRET: "hello world" });
  });

  test("strips surrounding single quotes", async () => {
    const path = await writeTmpFile("MY_SECRET='hello world'");
    const result = await parseEnvFile(path);
    expect(result).toEqual({ MY_SECRET: "hello world" });
  });

  test("handles values with equals signs", async () => {
    const path = await writeTmpFile("URL=https://example.com?a=1&b=2");
    const result = await parseEnvFile(path);
    expect(result).toEqual({ URL: "https://example.com?a=1&b=2" });
  });

  test("handles empty values", async () => {
    const path = await writeTmpFile("EMPTY=\nFOO=bar");
    const result = await parseEnvFile(path);
    expect(result).toEqual({ EMPTY: "", FOO: "bar" });
  });
});

describe("scanRequiredSecrets", () => {
  test("finds secret references in workflow YAML", () => {
    const yaml = `
jobs:
  build:
    steps:
      - run: echo \${{ secrets.MY_SECRET }}
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.GITHUB_TOKEN }}
`;
    expect(scanRequiredSecrets(yaml).sort()).toEqual(["GITHUB_TOKEN", "MY_SECRET"]);
  });

  test("deduplicates secret names", () => {
    const yaml = `
      - run: echo \${{ secrets.FOO }} \${{ secrets.FOO }}
      - run: echo \${{ secrets.FOO }}
`;
    expect(scanRequiredSecrets(yaml)).toEqual(["FOO"]);
  });

  test("returns empty for no secrets", () => {
    const yaml = `
jobs:
  build:
    steps:
      - run: echo hello
`;
    expect(scanRequiredSecrets(yaml)).toEqual([]);
  });

  test("handles various secret name patterns", () => {
    const yaml = `secrets.A secrets._B secrets.C123 secrets.D_E_F`;
    expect(scanRequiredSecrets(yaml).sort()).toEqual(["A", "C123", "D_E_F", "_B"]);
  });
});

describe("resolveSecrets", () => {
  test("includes GITHUB_TOKEN from token option", async () => {
    const result = await resolveSecrets({ token: "ghp_test123" });
    expect(result["GITHUB_TOKEN"]).toBe("ghp_test123");
  });

  test("loads secrets from file", async () => {
    const path = await writeTmpFile("MY_SECRET=fromfile\nOTHER=val");
    const result = await resolveSecrets({ secretFile: path });
    expect(result["MY_SECRET"]).toBe("fromfile");
    expect(result["OTHER"]).toBe("val");
  });

  test("inline -s KEY=VALUE overrides file", async () => {
    const path = await writeTmpFile("MY_SECRET=fromfile");
    const result = await resolveSecrets({
      secretFile: path,
      secretArgs: ["MY_SECRET=inline"],
    });
    expect(result["MY_SECRET"]).toBe("inline");
  });

  test("inline -s KEY reads from process.env", async () => {
    process.env["__TEST_SECRET_ENV"] = "from_env";
    const result = await resolveSecrets({ secretArgs: ["__TEST_SECRET_ENV"] });
    expect(result["__TEST_SECRET_ENV"]).toBe("from_env");
    delete process.env["__TEST_SECRET_ENV"];
  });

  test("priority: inline > file > token", async () => {
    const path = await writeTmpFile("GITHUB_TOKEN=fromfile");
    const result = await resolveSecrets({
      token: "fromtoken",
      secretFile: path,
      secretArgs: ["GITHUB_TOKEN=inline"],
    });
    expect(result["GITHUB_TOKEN"]).toBe("inline");
  });
});
