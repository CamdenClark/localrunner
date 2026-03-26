import { getDb } from "./db";
import { runs, jobs, steps as stepsTable, stepLogs } from "./db/schema";
import { eq, isNull } from "drizzle-orm";

export type OutputMode = "pretty" | "raw" | "verbose";

export type RunEvent =
  | { type: "server"; tag: string; message: string }
  | { type: "step_start"; stepName: string; timestamp: number }
  | { type: "step_complete"; stepName: string; conclusion: string; timestamp: number }
  | { type: "step_log"; line: string }
  | { type: "runner"; line: string; stream: "stdout" | "stderr" }
  | { type: "job_complete"; conclusion: string }
  | { type: "info"; message: string };

interface StepRecord {
  name: string;
  startedAt: number;
  completedAt?: number;
  conclusion?: string;
  logs: string[];
}

export class OutputHandler {
  mode: OutputMode;
  steps: Map<string, StepRecord> = new Map();
  currentStep: string | null = null;
  allLogs: string[] = [];

  runId: string | null = null;
  jobId: string | null = null;
  jobCompleted = false;
  private stepDbIds: Map<string, number> = new Map();
  private stepSortOrder = 0;
  private pendingLogs: Map<string, { stepId: number; lines: string[] }> = new Map();

  constructor(mode: OutputMode) {
    this.mode = mode;
  }

  emit(event: RunEvent): void {
    if (event.type === "job_complete") {
      this.jobCompleted = true;
    }
    switch (this.mode) {
      case "verbose":
        this.emitVerbose(event);
        break;
      case "raw":
        this.emitRaw(event);
        break;
      case "pretty":
        this.emitPretty(event);
        break;
    }
  }

  private print(msg: string) {
    console.log(msg);
    this.allLogs.push(msg);
  }

  // === Verbose mode: identical to current behavior ===

  private emitVerbose(event: RunEvent): void {
    switch (event.type) {
      case "server":
        this.print(`  [${event.tag}] ${event.message}`);
        break;
      case "step_start": {
        this.trackStepStart(event.stepName, event.timestamp);
        this.print(`  [step] ${event.stepName}: InProgress`);
        break;
      }
      case "step_complete": {
        this.trackStepComplete(event.stepName, event.conclusion, event.timestamp);
        const icon = event.conclusion === "succeeded" ? "✓" : event.conclusion === "skipped" ? "○" : "✗";
        this.print(`  [step] ${icon} ${event.stepName}: Completed (${event.conclusion})`);
        break;
      }
      case "step_log":
        this.bufferStepLog(event.line);
        this.print(`  [log] ${event.line}`);
        break;
      case "runner":
        this.print(`  [runner${event.stream === "stderr" ? ":err" : ""}] ${event.line}`);
        break;
      case "job_complete":
        this.print(`  [job] Completed: ${event.conclusion}`);
        break;
      case "info":
        this.print(event.message);
        break;
    }
  }

  // === Raw mode: structured output for agents ===

  private emitRaw(event: RunEvent): void {
    switch (event.type) {
      case "server":
        // suppress server internals
        this.allLogs.push(`  [${event.tag}] ${event.message}`);
        break;
      case "step_start":
        this.trackStepStart(event.stepName, event.timestamp);
        this.print(`::step-start::${event.stepName}`);
        break;
      case "step_complete":
        this.trackStepComplete(event.stepName, event.conclusion, event.timestamp);
        this.print(`::step-end::${event.stepName}::${event.conclusion}`);
        break;
      case "step_log":
        this.bufferStepLog(event.line);
        this.print(event.line);
        break;
      case "runner":
        // suppress runner internals
        this.allLogs.push(`  [runner${event.stream === "stderr" ? ":err" : ""}] ${event.line}`);
        break;
      case "job_complete":
        this.print(`::job-end::${event.conclusion}`);
        break;
      case "info":
        this.print(event.message);
        break;
    }
  }

  // === Pretty mode: compact human-friendly output ===

  private emitPretty(event: RunEvent): void {
    switch (event.type) {
      case "server":
        // suppress server internals, but still collect
        this.allLogs.push(`  [${event.tag}] ${event.message}`);
        break;
      case "step_start":
        this.trackStepStart(event.stepName, event.timestamp);
        process.stdout.write(`  ◦ ${event.stepName}...`);
        break;
      case "step_complete": {
        this.trackStepComplete(event.stepName, event.conclusion, event.timestamp);
        const step = this.steps.get(event.stepName);
        const duration = step ? ((step.completedAt! - step.startedAt) / 1000).toFixed(1) : "?";
        const icon = event.conclusion === "succeeded" ? "✓" : event.conclusion === "skipped" ? "○" : "✗";
        // Clear the "◦ Step Name..." line and replace with result
        if (process.stdout.isTTY) {
          process.stdout.write(`\r\x1b[K`);
        } else {
          process.stdout.write("\n");
        }
        console.log(`  ${icon} ${event.stepName} (${duration}s)`);
        break;
      }
      case "step_log":
        this.bufferStepLog(event.line);
        // suppress — will dump on failure at job_complete
        break;
      case "runner":
        // suppress runner internals
        this.allLogs.push(`  [runner${event.stream === "stderr" ? ":err" : ""}] ${event.line}`);
        break;
      case "job_complete":
        this.dumpFailedStepLogs();
        break;
      case "info":
        console.log(event.message);
        break;
    }
  }

  private dumpFailedStepLogs(): void {
    for (const [, step] of this.steps) {
      if (step.conclusion && step.conclusion !== "succeeded" && step.conclusion !== "skipped" && step.logs.length > 0) {
        const header = `── ${step.name} `;
        const rule = "─".repeat(Math.max(0, 44 - header.length));
        console.log();
        console.log(`  ${header}${rule}`);
        for (const line of step.logs) {
          console.log(`  ${line}`);
        }
        console.log(`  ${"─".repeat(44)}`);
      }
    }
  }

  // === Shared step tracking ===

  private trackStepStart(name: string, timestamp: number): void {
    if (this.steps.has(name)) return; // dedup
    this.steps.set(name, { name, startedAt: timestamp, logs: [] });
    this.currentStep = name;

    if (this.jobId) {
      try {
        const db = getDb();
        const order = this.stepSortOrder++;
        const result = db
          .insert(stepsTable)
          .values({
            jobId: this.jobId,
            name,
            status: "in_progress",
            startedAt: timestamp,
            sortOrder: order,
          })
          .returning({ id: stepsTable.id })
          .get();
        this.stepDbIds.set(name, result.id);
        this.pendingLogs.set(name, { stepId: result.id, lines: [] });
      } catch {}
    }
  }

  private trackStepComplete(name: string, conclusion: string, timestamp: number): void {
    const step = this.steps.get(name);
    if (step) {
      if (step.completedAt) return; // dedup
      step.completedAt = timestamp;
      step.conclusion = conclusion;
    }
    if (this.currentStep === name) {
      this.currentStep = null;
    }

    if (this.jobId) {
      try {
        const stepDbId = this.stepDbIds.get(name);
        if (stepDbId) {
          const db = getDb();
          db.update(stepsTable)
            .set({ status: "completed", conclusion, completedAt: timestamp })
            .where(eq(stepsTable.id, stepDbId))
            .run();
          this.flushStepLogs(name);
        }
      } catch {}
    }
  }

  private bufferStepLog(line: string): void {
    if (this.currentStep) {
      const step = this.steps.get(this.currentStep);
      if (step) {
        step.logs.push(line);
      }
      const pending = this.pendingLogs.get(this.currentStep);
      if (pending) {
        pending.lines.push(line);
      }
    }
  }

  private flushStepLogs(stepName: string): void {
    const pending = this.pendingLogs.get(stepName);
    if (!pending || pending.lines.length === 0) return;

    try {
      const db = getDb();
      const values = pending.lines.map((content, i) => ({
        stepId: pending.stepId,
        lineNumber: i + 1,
        content,
      }));
      db.insert(stepLogs).values(values).run();
    } catch {}

    pending.lines = [];
  }

  flushAllLogs(): void {
    for (const [name] of this.pendingLogs) {
      this.flushStepLogs(name);
    }
  }

  markCancelled(): void {
    this.flushAllLogs();

    if (!this.jobId || !this.runId) return;

    try {
      const db = getDb();
      const now = Date.now();

      // Mark incomplete steps as cancelled
      for (const [name, step] of this.steps) {
        if (!step.completedAt) {
          const stepDbId = this.stepDbIds.get(name);
          if (stepDbId) {
            db.update(stepsTable)
              .set({ status: "completed", conclusion: "cancelled", completedAt: now })
              .where(eq(stepsTable.id, stepDbId))
              .run();
          }
        }
      }

      db.update(jobs)
        .set({ status: "completed", conclusion: "cancelled", completedAt: now })
        .where(eq(jobs.id, this.jobId))
        .run();
      db.update(runs)
        .set({ status: "completed", conclusion: "cancelled", completedAt: now })
        .where(eq(runs.id, this.runId))
        .run();
    } catch {}
  }
}
