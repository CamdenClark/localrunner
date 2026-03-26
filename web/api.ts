import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunManager } from "../server/runs";
import type { ServerConfig } from "../server/types";
import { OutputHandler, type RunEvent } from "../output";
import { getDb } from "../db";
import { runs, jobs, steps, stepLogs } from "../db/schema";
import { eq, desc } from "drizzle-orm";

export function registerApiRoutes(app: Hono, runManager: RunManager, port: number) {
  /**
   * Register a new run on the server.
   * The CLI calls this, then launches the runner process itself.
   * Returns runId/jobId so the CLI can build the JIT config.
   */
  app.post("/api/register-run", async (c) => {
    const body = (await c.req.json()) as {
      config: Omit<ServerConfig, "port" | "output">;
    };

    const output = new OutputHandler("verbose");
    const { ctx, jobCompleted } = runManager.registerRun({
      ...body.config,
      port,
      output,
    });

    // The jobCompleted promise is monitored so we can clean up
    // when the runner finishes (via the completejob endpoint)
    jobCompleted.then(() => {
      runManager.completeRun(ctx.runId);
    }).catch(() => {
      runManager.completeRun(ctx.runId);
    });

    return c.json({
      runId: ctx.runId,
      jobId: ctx.jobId,
    });
  });

  /**
   * SSE stream of output events for an active run.
   * The CLI connects here after registering a run to get real-time output.
   */
  app.get("/api/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    const ctx = runManager.getRunByRunId(runId);
    if (!ctx) {
      return c.json({ error: "Run not found or not active" }, 404);
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => { closed = true; });

      // Send an initial comment so the response headers flush immediately
      await stream.writeSSE({ data: "", event: "keepalive" });

      const unsubscribe = ctx.output.subscribe((event: RunEvent) => {
        if (closed) return;
        stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        }).catch(() => { closed = true; });
      });

      // Keep the stream open until job completes or client disconnects
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (closed || ctx.output.jobCompleted) {
            clearInterval(checkInterval);
            unsubscribe();
            resolve();
          }
        }, 500);
      });
    });
  });

  // List runs from DB
  app.get("/api/runs", (c) => {
    const db = getDb();
    const allRuns = db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50).all();
    return c.json(allRuns);
  });

  // Get a single run with jobs, steps, and logs
  app.get("/api/runs/:id", (c) => {
    const runId = c.req.param("id");
    const db = getDb();

    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) return c.json({ error: "Run not found" }, 404);

    const runJobs = db.select().from(jobs).where(eq(jobs.runId, runId)).all();
    const allSteps: any[] = [];
    const allLogs: any[] = [];
    for (const j of runJobs) {
      const js = db.select().from(steps).where(eq(steps.jobId, j.id)).all();
      allSteps.push(...js);
      for (const s of js) {
        allLogs.push(...db.select().from(stepLogs).where(eq(stepLogs.stepId, s.id)).all());
      }
    }

    return c.json({ run, jobs: runJobs, steps: allSteps, logs: allLogs });
  });
}
