import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { join, resolve, basename } from "path";
import { layout } from "./layout";
import { runsPage, runsTable } from "./runs";
import { runDetailPage, runDetailContent } from "./run-detail";
import { workflowsPage } from "./workflows";
import { triggerWorkflow } from "./trigger";
import { getDb } from "../db";
import { runs, jobs, steps, stepLogs, artifacts } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { parseWorkflow, normalizeOn } from "../workflow";
import type { RunManager } from "../server/runs";

export function registerWebRoutes(app: Hono, runManager: RunManager, port: number) {
  // Dashboard — list of recent runs + quick-run cards
  app.get("/", async (c) => {
    const db = getDb();
    const allRuns = db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50).all();
    const workflows = await discoverWorkflows();
    return c.html(layout("Runs", runsPage(allRuns, workflows)));
  });

  // HTMX partial — refreshable runs table
  app.get("/partials/runs", (c) => {
    const db = getDb();
    const allRuns = db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50).all();
    return c.html(runsTable(allRuns));
  });

  // Run detail page
  app.get("/runs/:id", (c) => {
    const runId = c.req.param("id");
    const data = loadRunDetail(runId);
    if (!data) return c.html(layout("Not Found", runsPage([])), 404);
    return c.html(layout(
      `${data.run.workflowName || "Run"} — ${data.run.jobName || ""}`,
      runDetailPage(data.run, data.jobs, data.steps, data.logs, data.artifacts),
    ));
  });

  // HTMX partial — refreshable run detail
  app.get("/partials/runs/:id", (c) => {
    const runId = c.req.param("id");
    const data = loadRunDetail(runId);
    if (!data) return c.text("Not found", 404);
    return c.html(runDetailContent(data.run, data.jobs, data.steps, data.logs, data.artifacts));
  });

  // SSE stream for the runs list page — notifies when any run changes
  app.get("/sse/runs", (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => { closed = true; });

      const unsubscribe = runManager.eventBus.subscribe(() => {
        if (closed) return;
        stream.writeSSE({ event: "run_changed", data: "" }).catch(() => { closed = true; });
      });

      const keepalive = setInterval(() => {
        if (closed) { clearInterval(keepalive); return; }
        stream.writeSSE({ event: "keepalive", data: "" }).catch(() => { closed = true; });
      }, 30000);

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (closed) { clearInterval(check); clearInterval(keepalive); unsubscribe(); resolve(); }
        }, 1000);
      });
    });
  });

  // Workflows page — discover and trigger workflows
  app.get("/workflows", async (c) => {
    const workflows = await discoverWorkflows();
    return c.html(layout("Workflows", workflowsPage(workflows)));
  });

  // Trigger a workflow run
  app.post("/api/trigger", async (c) => {
    const body = await c.req.parseBody();
    const fileName = body.fileName as string;
    const event = body.event as string;
    if (!fileName || !event) return c.text("Missing fileName or event", 400);

    try {
      const { runId } = await triggerWorkflow(fileName, event, port, runManager);
      c.header("HX-Redirect", `/runs/${runId}`);
      return c.text("ok");
    } catch (err) {
      return c.text(`Trigger failed: ${(err as Error).message}`, 500);
    }
  });

  // SSE stream for a single run — notifies on step/log/job changes
  app.get("/sse/runs/:id", (c) => {
    const runId = c.req.param("id");
    const ctx = runManager.getRunByRunId(runId);

    if (!ctx) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "run_complete", data: "" });
      });
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => { closed = true; });

      const unsubscribe = ctx.output.subscribe((event) => {
        if (closed) return;
        if (event.type === "step_start" || event.type === "step_complete" ||
            event.type === "step_log" || event.type === "job_complete") {
          stream.writeSSE({ event: "run_changed", data: "" }).catch(() => { closed = true; });
        }
      });

      const keepalive = setInterval(() => {
        if (closed) { clearInterval(keepalive); return; }
        stream.writeSSE({ event: "keepalive", data: "" }).catch(() => { closed = true; });
      }, 30000);

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (closed || ctx.output.jobCompleted) {
            clearInterval(check); clearInterval(keepalive); unsubscribe(); resolve();
          }
        }, 1000);
      });
    });
  });
}

async function discoverWorkflows() {
  const workflowDir = resolve(".github/workflows");
  const glob = new Bun.Glob("*.{yml,yaml}");
  const results: { fileName: string; name: string; events: string[]; jobs: string[] }[] = [];

  try {
    for await (const file of glob.scan({ cwd: workflowDir })) {
      try {
        const text = await Bun.file(join(workflowDir, file)).text();
        const workflow = parseWorkflow(text);
        const events = Object.keys(normalizeOn(workflow.on));
        const jobNames = Object.keys(workflow.jobs);
        results.push({
          fileName: file,
          name: workflow.name || basename(file, ".yml"),
          events,
          jobs: jobNames,
        });
      } catch {}
    }
  } catch {}

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

function loadRunDetail(runId: string) {
  const db = getDb();
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return null;

  const runJobs = db.select().from(jobs).where(eq(jobs.runId, runId)).all();
  const allSteps: any[] = [];
  const allLogs: any[] = [];

  for (const job of runJobs) {
    const jobSteps = db.select().from(steps).where(eq(steps.jobId, job.id)).all();
    allSteps.push(...jobSteps);
    for (const step of jobSteps) {
      const logs = db.select().from(stepLogs).where(eq(stepLogs.stepId, step.id)).all();
      allLogs.push(...logs);
    }
  }

  const runArtifacts = db.select().from(artifacts).where(eq(artifacts.runId, runId)).all();

  return { run, jobs: runJobs, steps: allSteps, logs: allLogs, artifacts: runArtifacts };
}
