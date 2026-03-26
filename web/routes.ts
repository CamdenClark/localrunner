import type { Hono } from "hono";
import { layout } from "./layout";
import { runsPage, runsTable } from "./runs";
import { runDetailPage, runDetailContent } from "./run-detail";
import { getDb } from "../db";
import { runs, jobs, steps, stepLogs } from "../db/schema";
import { eq, desc } from "drizzle-orm";

export function registerWebRoutes(app: Hono) {
  // Dashboard — list of recent runs
  app.get("/", (c) => {
    const db = getDb();
    const allRuns = db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50).all();
    return c.html(layout("Runs", runsPage(allRuns)));
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
      runDetailPage(data.run, data.jobs, data.steps, data.logs),
    ));
  });

  // HTMX partial — refreshable run detail
  app.get("/partials/runs/:id", (c) => {
    const runId = c.req.param("id");
    const data = loadRunDetail(runId);
    if (!data) return c.text("Not found", 404);
    return c.html(runDetailContent(data.run, data.jobs, data.steps, data.logs));
  });
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

  return { run, jobs: runJobs, steps: allSteps, logs: allLogs };
}
