import { test, expect, describe } from "bun:test";
import { fixtures } from "./fixtures";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

const CLI_PATH = join(import.meta.dir, "..", "cli.ts");
const TIMEOUT = 5 * 60 * 1000; // 5 minutes per test

describe("acceptance", () => {
  for (const fixture of fixtures) {
    test(fixture.name, async () => {
      const workDir = join(tmpdir(), `localrunner-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`);

      try {
        // Clone at pinned commit (shallow)
        const clone = Bun.spawnSync(
          ["git", "clone", "--depth", "1", `https://github.com/${fixture.repo}.git`, workDir],
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(clone.exitCode).toBe(0);

        // Fetch the specific commit if shallow clone HEAD differs
        const headCheck = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: workDir, stdout: "pipe" });
        const currentHead = headCheck.stdout.toString().trim();
        if (currentHead !== fixture.commit) {
          Bun.spawnSync(
            ["git", "fetch", "--depth", "1", "origin", fixture.commit],
            { cwd: workDir, stdout: "pipe", stderr: "pipe" },
          );
          Bun.spawnSync(
            ["git", "checkout", fixture.commit],
            { cwd: workDir, stdout: "pipe", stderr: "pipe" },
          );
        }

        // Run localrunner
        const args = ["bun", CLI_PATH, fixture.event, "-W", fixture.workflow];
        if (fixture.job) {
          args.push("-j", fixture.job);
        }

        const proc = Bun.spawn(args, {
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });

        await proc.exited;

        if (fixture.expected === "succeeded") {
          expect(proc.exitCode).toBe(0);
        } else {
          expect(proc.exitCode).not.toBe(0);
        }
      } finally {
        // Cleanup
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }, TIMEOUT);
  }
});
