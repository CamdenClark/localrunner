import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  workflowName: text("workflow_name").notNull(),
  jobName: text("job_name").notNull(),
  eventName: text("event_name").notNull(),
  eventPayload: text("event_payload"),
  repoOwner: text("repo_owner"),
  repoName: text("repo_name"),
  repoFullName: text("repo_full_name"),
  sha: text("sha"),
  ref: text("ref"),
  conclusion: text("conclusion"),
  startedAt: integer("started_at").notNull(),
  completedAt: integer("completed_at"),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  name: text("name").notNull(),
  conclusion: text("conclusion"),
  startedAt: integer("started_at").notNull(),
  completedAt: integer("completed_at"),
});

export const steps = sqliteTable("steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  name: text("name").notNull(),
  conclusion: text("conclusion"),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
  sortOrder: integer("sort_order").notNull(),
});

export const stepLogs = sqliteTable("step_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stepId: integer("step_id")
    .notNull()
    .references(() => steps.id),
  lineNumber: integer("line_number").notNull(),
  content: text("content").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  name: text("name").notNull(),
  size: integer("size").notNull().default(0),
  finalized: integer("finalized").notNull().default(0),
  createdAt: text("created_at").notNull(),
});
