import { html } from "hono/html";

interface Run {
  id: string;
  workflowName: string | null;
  jobName: string | null;
  eventName: string | null;
  repoFullName: string | null;
  sha: string | null;
  ref: string | null;
  status: string | null;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface Job {
  id: string;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface Step {
  id: number;
  jobId: string | null;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  sortOrder: number | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface StepLog {
  id: number;
  stepId: number | null;
  lineNumber: number | null;
  content: string | null;
}

function badge(status: string | null, conclusion: string | null) {
  if (status === "completed" && conclusion) {
    return html`<span class="badge badge-${conclusion}">${conclusion}</span>`;
  }
  if (status) {
    return html`<span class="badge badge-${status}">${status}</span>`;
  }
  return html`<span class="badge badge-queued">queued</span>`;
}

function duration(start: number | null, end: number | null): string {
  if (!start) return "";
  const elapsed = (end || Date.now()) - start;
  if (elapsed < 1000) return "<1s";
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s`;
  return `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`;
}

export function runDetailPage(run: Run, jobs: Job[], steps: Step[], logs: StepLog[]) {
  const isActive = run.status === "in_progress" || run.status === "queued";
  const pollAttr = isActive ? `hx-get="/partials/runs/${run.id}" hx-trigger="every 2s" hx-swap="innerHTML"` : "";

  return html`
    <div ${pollAttr}>
      ${runDetailContent(run, jobs, steps, logs)}
    </div>
  `;
}

export function runDetailContent(run: Run, jobs: Job[], steps: Step[], logs: StepLog[]) {
  const logsByStep = new Map<number, StepLog[]>();
  for (const log of logs) {
    if (log.stepId == null) continue;
    const arr = logsByStep.get(log.stepId) || [];
    arr.push(log);
    logsByStep.set(log.stepId, arr);
  }

  return html`
    <div class="run-header">
      <h2>${run.workflowName || "Run"} — ${run.jobName || ""} ${badge(run.status, run.conclusion)}</h2>
      <div class="run-meta">
        ${run.eventName || ""} &middot;
        ${run.repoFullName || ""} &middot;
        <code>${run.sha?.slice(0, 8) || ""}</code> &middot;
        ${duration(run.startedAt, run.completedAt)}
      </div>
    </div>

    ${jobs.map((job) => {
      const jobSteps = steps
        .filter((s) => s.jobId === job.id)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

      return html`
        <div class="run-detail">
          <h3>${job.name || "Job"} ${badge(job.status, job.conclusion)}</h3>

          ${jobSteps.map((step) => {
            const stepClass = step.conclusion || step.status || "";
            const stepLogs = logsByStep.get(step.id) || [];
            stepLogs.sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));

            return html`
              <div class="step step-${stepClass}">
                <div class="step-name">${step.name || "Step"} ${badge(step.status, step.conclusion)}</div>
                <div class="step-meta">${duration(step.startedAt, step.completedAt)}</div>
                ${stepLogs.length > 0
                  ? html`<div class="logs">${stepLogs.map((l) => html`<div class="log-line">${l.content || ""}</div>`)}</div>`
                  : html``
                }
              </div>
            `;
          })}
        </div>
      `;
    })}
  `;
}
