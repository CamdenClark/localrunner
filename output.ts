import { randomUUID } from "crypto";
import { getDb } from "./db";
import { runs, jobs, steps as stepsTable, stepLogs } from "./db/schema";
import { eq } from "drizzle-orm";

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

/** Parse GitHub Actions annotations. Handles `##[cmd]msg` and `[command]msg` formats. */
function parseAnnotation(line: string): { type: string; message: string } | null {
  const match = line.match(/^##\[(\w+)](.*)/);
  if (match) return { type: match[1], message: match[2] };
  const cmdMatch = line.match(/^\[command](.*)/);
  if (cmdMatch) return { type: "command", message: cmdMatch[1] };
  return null;
}

/** Format an annotation for colored terminal output. */
function formatAnnotation(ann: { type: string; message: string }): string | null {
  switch (ann.type) {
    case "warning":
      return `\x1b[33m⚠ ${ann.message}\x1b[0m`;
    case "error":
      return `\x1b[31m✖ ${ann.message}\x1b[0m`;
    case "notice":
      return `\x1b[36mℹ ${ann.message}\x1b[0m`;
    case "debug":
      return `\x1b[90m${ann.message}\x1b[0m`;
    case "group":
      return `\x1b[1m▸ ${ann.message}\x1b[0m`;
    case "endgroup":
      return null; // suppress
    case "command":
      return `\x1b[90m$ ${ann.message}\x1b[0m`;
    case "section":
      return null; // internal, suppress
    default:
      return ann.message;
  }
}

/** Format an annotation for verbose mode with tag labels. */
function formatAnnotationVerbose(ann: { type: string; message: string }): string | null {
  switch (ann.type) {
    case "warning":
      return `\x1b[33m[warning] ${ann.message}\x1b[0m`;
    case "error":
      return `\x1b[31m[error] ${ann.message}\x1b[0m`;
    case "notice":
      return `\x1b[36m[notice] ${ann.message}\x1b[0m`;
    case "debug":
      return `\x1b[90m[debug] ${ann.message}\x1b[0m`;
    case "group":
      return `\x1b[1m[group] ${ann.message}\x1b[0m`;
    case "endgroup":
      return `[endgroup]`;
    case "command":
      return `\x1b[90m[command] ${ann.message}\x1b[0m`;
    case "section":
      return null;
    default:
      return `[${ann.type}] ${ann.message}`;
  }
}

export class OutputHandler {
  mode: OutputMode;
  steps: Map<string, StepRecord> = new Map();
  currentStep: string | null = null;
  allLogs: string[] = [];

  runId: string | null = null;
  jobId: string | null = null;
  jobCompleted = false;
  private stepUuids: Map<string, string> = new Map();
  private stepSortOrder = 0;
  private pendingLogs: Map<string, { stepId: string; lines: string[] }> = new Map();

  /** External subscribers for event streaming (e.g. SSE) */
  private subscribers: Set<(event: RunEvent) => void> = new Set();

  constructor(mode: OutputMode) {
    this.mode = mode;
  }

  /** Build name→UUID mapping from the step objects sent to the runner. */
  setStepMapping(jobSteps: object[]): void {
    for (const step of jobSteps) {
      const s = step as { id?: string; displayName?: string };
      if (s.id && s.displayName) {
        this.stepUuids.set(s.displayName, s.id);
      }
    }
  }

  subscribe(fn: (event: RunEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(event: RunEvent): void {
    if (event.type === "job_complete") {
      this.jobCompleted = true;
    }

    // Detect post-run steps: if a step_start arrives for a name that already completed,
    // rename it to "Post <name>" so it's tracked as a separate step.
    if (event.type === "step_start") {
      const existing = this.steps.get(event.stepName);
      if (existing?.completedAt) {
        event = { ...event, stepName: `Post ${event.stepName}` };
      }
    } else if (event.type === "step_complete") {
      const existing = this.steps.get(event.stepName);
      if (existing?.completedAt) {
        event = { ...event, stepName: `Post ${event.stepName}` };
      } else if (!existing && this.steps.has(`Post ${event.stepName}`)) {
        event = { ...event, stepName: `Post ${event.stepName}` };
      }
    }

    // Notify subscribers
    for (const fn of this.subscribers) {
      fn(event);
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
      case "step_log": {
        this.bufferStepLog(event.line);
        const ann = parseAnnotation(event.line);
        if (ann) {
          const formatted = formatAnnotationVerbose(ann);
          if (formatted !== null) this.print(`  [log] ${formatted}`);
        } else {
          this.print(`  [log] ${event.line}`);
        }
        break;
      }
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

  private formatLogLine(line: string): string | null {
    const ann = parseAnnotation(line);
    if (ann) return formatAnnotation(ann);
    return line;
  }

  private dumpFailedStepLogs(): void {
    for (const [, step] of this.steps) {
      if (step.conclusion && step.conclusion !== "succeeded" && step.conclusion !== "skipped" && step.logs.length > 0) {
        const header = `── ${step.name} `;
        const rule = "─".repeat(Math.max(0, 44 - header.length));
        console.log();
        console.log(`  ${header}${rule}`);
        for (const line of step.logs) {
          const formatted = this.formatLogLine(line);
          if (formatted !== null) console.log(`  ${formatted}`);
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
        const stepId = this.stepUuids.get(name) || randomUUID();
        db.insert(stepsTable)
          .values({
            id: stepId,
            jobId: this.jobId,
            name,
            status: "in_progress",
            startedAt: timestamp,
            sortOrder: order,
          })
          .run();
        this.stepUuids.set(name, stepId);
        this.pendingLogs.set(name, { stepId, lines: [] });
      } catch {}
    }
  }

  private trackStepComplete(name: string, conclusion: string, timestamp: number): void {
    const step = this.steps.get(name);
    const hadStarted = !!step;
    if (step) {
      if (step.completedAt) return; // dedup
      step.completedAt = timestamp;
      step.conclusion = conclusion;
    } else {
      // Step completed without a prior start event — create the record now.
      this.steps.set(name, { name, startedAt: timestamp, completedAt: timestamp, conclusion, logs: [] });
    }
    if (this.currentStep === name) {
      this.currentStep = null;
    }

    if (this.jobId) {
      try {
        const db = getDb();
        const stepId = this.stepUuids.get(name) || randomUUID();
        if (hadStarted) {
          // DB row was inserted by trackStepStart — update it.
          db.update(stepsTable)
            .set({ status: "completed", conclusion, completedAt: timestamp })
            .where(eq(stepsTable.id, stepId))
            .run();
          this.flushStepLogs(name);
        } else {
          // No start event was received — insert a completed row directly.
          const order = this.stepSortOrder++;
          db.insert(stepsTable)
            .values({
              id: stepId,
              jobId: this.jobId,
              name,
              status: "completed",
              conclusion,
              startedAt: timestamp,
              completedAt: timestamp,
              sortOrder: order,
            })
            .run();
          this.stepUuids.set(name, stepId);
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
          const stepId = this.stepUuids.get(name);
          if (stepId) {
            db.update(stepsTable)
              .set({ status: "completed", conclusion: "cancelled", completedAt: now })
              .where(eq(stepsTable.id, stepId))
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
