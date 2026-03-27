import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { OutputHandler } from "./output";

// Capture console.log output
function captureOutput(handler: OutputHandler, fn: () => void): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const writeSpy = spyOn(process.stdout, "write").mockImplementation((data: string | Uint8Array) => {
    // capture stdout.write too (used by pretty mode)
    return true;
  });
  fn();
  spy.mockRestore();
  writeSpy.mockRestore();
  return lines;
}

describe("annotation rendering", () => {
  describe("verbose mode", () => {
    test("renders ##[warning] with color and tag", () => {
      const handler = new OutputHandler("verbose");
      const lines = captureOutput(handler, () => {
        handler.emit({ type: "step_start", stepName: "Test", timestamp: 0 });
        handler.emit({ type: "step_log", line: "##[warning]Cache miss" });
      });
      const logLine = lines.find((l) => l.includes("warning"));
      expect(logLine).toBeDefined();
      expect(logLine).toContain("[warning]");
      expect(logLine).toContain("Cache miss");
      expect(logLine).toContain("\x1b[33m"); // yellow
    });

    test("renders ##[error] with color and tag", () => {
      const handler = new OutputHandler("verbose");
      const lines = captureOutput(handler, () => {
        handler.emit({ type: "step_start", stepName: "Test", timestamp: 0 });
        handler.emit({ type: "step_log", line: "##[error]Build failed" });
      });
      const logLine = lines.find((l) => l.includes("error"));
      expect(logLine).toBeDefined();
      expect(logLine).toContain("[error]");
      expect(logLine).toContain("Build failed");
      expect(logLine).toContain("\x1b[31m"); // red
    });

    test("renders ##[notice] with color and tag", () => {
      const handler = new OutputHandler("verbose");
      const lines = captureOutput(handler, () => {
        handler.emit({ type: "step_start", stepName: "Test", timestamp: 0 });
        handler.emit({ type: "step_log", line: "##[notice]Deployment complete" });
      });
      const logLine = lines.find((l) => l.includes("notice"));
      expect(logLine).toBeDefined();
      expect(logLine).toContain("[notice]");
      expect(logLine).toContain("Deployment complete");
    });

    test("renders ##[group] with bold", () => {
      const handler = new OutputHandler("verbose");
      const lines = captureOutput(handler, () => {
        handler.emit({ type: "step_start", stepName: "Test", timestamp: 0 });
        handler.emit({ type: "step_log", line: "##[group]Run bun install" });
      });
      const logLine = lines.find((l) => l.includes("group"));
      expect(logLine).toBeDefined();
      expect(logLine).toContain("Run bun install");
    });

    test("renders ##[endgroup]", () => {
      const handler = new OutputHandler("verbose");
      const lines = captureOutput(handler, () => {
        handler.emit({ type: "step_start", stepName: "Test", timestamp: 0 });
        handler.emit({ type: "step_log", line: "##[endgroup]" });
      });
      const logLine = lines.find((l) => l.includes("endgroup"));
      expect(logLine).toBeDefined();
    });

    test("renders [command] without ## prefix", () => {
      const handler = new OutputHandler("verbose");
      const lines = captureOutput(handler, () => {
        handler.emit({ type: "step_start", stepName: "Test", timestamp: 0 });
        handler.emit({ type: "step_log", line: "[command]/usr/bin/tar -xf archive.tar" });
      });
      const logLine = lines.find((l) => l.includes("tar"));
      expect(logLine).toBeDefined();
      expect(logLine).toContain("[command]");
      expect(logLine).toContain("/usr/bin/tar -xf archive.tar");
      expect(logLine).toContain("\x1b[90m"); // dim
    });

    test("passes through non-annotation lines unchanged", () => {
      const handler = new OutputHandler("verbose");
      const lines = captureOutput(handler, () => {
        handler.emit({ type: "step_start", stepName: "Test", timestamp: 0 });
        handler.emit({ type: "step_log", line: "normal log line" });
      });
      const logLine = lines.find((l) => l.includes("normal log line"));
      expect(logLine).toBeDefined();
      expect(logLine).toContain("[log] normal log line");
    });
  });

  describe("raw mode", () => {
    test("passes annotations through unchanged", () => {
      const handler = new OutputHandler("raw");
      const lines = captureOutput(handler, () => {
        handler.emit({ type: "step_start", stepName: "Test", timestamp: 0 });
        handler.emit({ type: "step_log", line: "##[warning]Cache miss" });
      });
      expect(lines).toContain("##[warning]Cache miss");
    });
  });

  describe("pretty mode - failed step dump", () => {
    test("formats annotations in failed step logs", () => {
      const handler = new OutputHandler("pretty");
      const lines = captureOutput(handler, () => {
        handler.emit({ type: "step_start", stepName: "Build", timestamp: 0 });
        handler.emit({ type: "step_log", line: "##[warning]Deprecated API" });
        handler.emit({ type: "step_log", line: "##[error]Compilation failed" });
        handler.emit({ type: "step_log", line: "normal output" });
        handler.emit({ type: "step_log", line: "##[group]Details" });
        handler.emit({ type: "step_log", line: "##[endgroup]" });
        handler.emit({
          type: "step_complete",
          stepName: "Build",
          conclusion: "failed",
          timestamp: 1000,
        });
        handler.emit({ type: "job_complete", conclusion: "failed" });
      });
      const output = lines.join("\n");
      // Should contain formatted warning (yellow)
      expect(output).toContain("\x1b[33m");
      expect(output).toContain("Deprecated API");
      // Should contain formatted error (red)
      expect(output).toContain("\x1b[31m");
      expect(output).toContain("Compilation failed");
      // Normal output should pass through
      expect(output).toContain("normal output");
      // endgroup should be suppressed
      expect(output).not.toContain("endgroup");
    });
  });
});
