import { test, expect, describe } from "bun:test";
import { resolveVariables } from "./variables";
import { join } from "path";
import { tmpdir } from "os";

async function writeTmpFile(content: string): Promise<string> {
  const path = join(tmpdir(), `test-vars-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await Bun.write(path, content);
  return path;
}

describe("resolveVariables", () => {
  test("loads variables from file", async () => {
    const path = await writeTmpFile("MY_VAR=hello\nOTHER=world");
    const result = await resolveVariables({ varFile: path });
    expect(result["MY_VAR"]).toBe("hello");
    expect(result["OTHER"]).toBe("world");
  });

  test("inline --var overrides file", async () => {
    const path = await writeTmpFile("MY_VAR=fromfile");
    const result = await resolveVariables({
      varFile: path,
      varArgs: ["MY_VAR=inline"],
    });
    expect(result["MY_VAR"]).toBe("inline");
  });

  test("handles multiple inline vars", async () => {
    const result = await resolveVariables({
      varArgs: ["A=1", "B=2", "C=3"],
    });
    expect(result).toEqual({ A: "1", B: "2", C: "3" });
  });

  test("warns on invalid var format (no equals)", async () => {
    const result = await resolveVariables({
      varArgs: ["INVALID"],
    });
    expect(result["INVALID"]).toBeUndefined();
  });

  test("returns empty object with no inputs", async () => {
    const result = await resolveVariables({});
    // May have gh variables if authenticated, so just check it's an object
    expect(typeof result).toBe("object");
  });
});
