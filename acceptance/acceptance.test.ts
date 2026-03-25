import { test, expect, describe } from "bun:test";
import { fixtures, type RemoteFixture, type LocalFixture } from "./fixtures";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync } from "fs";

const CLI_PATH = join(import.meta.dir, "..", "cli.ts");
const TIMEOUT = 5 * 60 * 1000; // 5 minutes per test

// Sharding support: set SHARD_INDEX and SHARD_TOTAL to split fixtures across CI runners
const shardIndex = parseInt(process.env.SHARD_INDEX || "0", 10);
const shardTotal = parseInt(process.env.SHARD_TOTAL || "1", 10);
const shardedFixtures = fixtures.filter((_, i) => i % shardTotal === shardIndex);

// Randomize port to avoid conflicts when running in parallel
function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

async function setupRemote(fixture: RemoteFixture): Promise<string> {
  const workDir = join(tmpdir(), `localrunner-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const clone = Bun.spawnSync(
    ["git", "clone", "--depth", "1", `https://github.com/${fixture.repo}.git`, workDir],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (clone.exitCode !== 0) throw new Error(`Failed to clone ${fixture.repo}`);

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

  return workDir;
}

async function setupLocal(fixture: LocalFixture): Promise<{ workDir: string; workflowPath: string }> {
  const workDir = join(tmpdir(), `localrunner-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workflowDir = join(workDir, ".github", "workflows");
  mkdirSync(workflowDir, { recursive: true });

  // Initialize a git repo so localrunner can get repo context
  Bun.spawnSync(["git", "init"], { cwd: workDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/test/acceptance-test.git"], { cwd: workDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: workDir, stdout: "pipe", stderr: "pipe" });

  const workflowPath = join(workflowDir, "test.yml");
  await Bun.write(workflowPath, fixture.workflowContent);

  return { workDir, workflowPath };
}

describe("acceptance", () => {
  for (const fixture of shardedFixtures) {
    test(fixture.name, async () => {
      let workDir: string;
      let workflowPath: string;

      if (fixture.type === "remote") {
        workDir = await setupRemote(fixture);
        workflowPath = fixture.workflow;
      } else {
        const result = await setupLocal(fixture);
        workDir = result.workDir;
        workflowPath = result.workflowPath;
      }

      try {
        const port = randomPort();
        const args = ["bun", CLI_PATH, fixture.event, "-W", workflowPath, "--port", String(port)];
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

        if (fixture.expected === "succeeded" && proc.exitCode !== 0) {
          const stderr = await Bun.readableStreamToText(proc.stderr);
          const stdout = await Bun.readableStreamToText(proc.stdout);
          console.error(`[${fixture.name}] stdout:\n${stdout}`);
          console.error(`[${fixture.name}] stderr:\n${stderr}`);
          expect(proc.exitCode).toBe(0);
        } else if (fixture.expected !== "succeeded") {
          expect(proc.exitCode).not.toBe(0);
        }
      } finally {
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }, TIMEOUT);
  }
});
