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

interface Artifact {
  id: number;
  name: string;
  size: number;
  finalized: number;
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

function dotClass(status: string | null, conclusion: string | null): string {
  if (status === "completed" && conclusion) return `dot-${conclusion}`;
  if (status) return `dot-${status}`;
  return "dot-queued";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Parse and render a log line, handling ##[annotation] syntax. */
function renderLogLine(content: string) {
  let match = content.match(/^##\[(\w+)](.*)/);
  if (!match) match = content.match(/^\[command](.*)/);
  if (!match) return html`<div class="log-line">${content}</div>`;
  // Normalize [command] match to have same shape
  if (match.length === 2) match = [match[0], "command", match[1]] as unknown as RegExpMatchArray;

  const [, type, message] = match;
  switch (type) {
    case "warning":
      return html`<div class="log-line log-warning">⚠ ${message}</div>`;
    case "error":
      return html`<div class="log-line log-error">✖ ${message}</div>`;
    case "notice":
      return html`<div class="log-line log-notice">ℹ ${message}</div>`;
    case "debug":
      return html`<div class="log-line log-debug">${message}</div>`;
    case "group":
      return html`<div class="log-line log-group">▸ ${message}</div>`;
    case "endgroup":
      return html``;
    case "command":
      return html`<div class="log-line log-command">$ ${message}</div>`;
    case "section":
      return html``;
    default:
      return html`<div class="log-line">${content}</div>`;
  }
}

export function runDetailPage(run: Run, jobs: Job[], steps: Step[], logs: StepLog[], artifacts: Artifact[]) {
  const isActive = run.status === "in_progress" || run.status === "queued";

  if (!isActive) {
    return html`<div>${runDetailContent(run, jobs, steps, logs, artifacts)}</div>`;
  }

  return html`
    <div
      hx-ext="sse"
      sse-connect="/sse/runs/${run.id}"
      hx-get="/partials/runs/${run.id}"
      hx-trigger="sse:run_changed"
      hx-swap="innerHTML"
    >
      ${runDetailContent(run, jobs, steps, logs, artifacts)}
    </div>
  `;
}

export function runDetailContent(run: Run, jobs: Job[], steps: Step[], logs: StepLog[], artifacts: Artifact[]) {
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

    <div class="run-layout">
      <nav class="run-sidebar">
        <div class="sidebar-section">
          <h4>Jobs</h4>
          ${jobs.map((job) => html`
            <a class="sidebar-job" href="#job-${job.id}">
              <span class="status-dot ${dotClass(job.status, job.conclusion)}"></span>
              ${job.name || "Job"}
            </a>
          `)}
        </div>

        ${artifacts.length > 0 ? html`
          <div class="sidebar-section">
            <h4>Artifacts</h4>
            ${artifacts.map((a) => html`
              <div class="sidebar-artifact">
                <span>${a.name}</span>
                <span class="artifact-size">${formatSize(a.size)}</span>
              </div>
            `)}
          </div>
        ` : html``}
      </nav>

      <div class="run-main">
        ${jobs.map((job) => {
          const jobSteps = steps
            .filter((s) => s.jobId === job.id)
            .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

          return html`
            <div class="run-detail" id="job-${job.id}">
              <h3>${job.name || "Job"} ${badge(job.status, job.conclusion)}</h3>

              ${jobSteps.map((step) => {
                const stepClass = step.conclusion || step.status || "";
                const stepLogs = logsByStep.get(step.id as any) || [];
                stepLogs.sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));

                const collapsed = step.conclusion === "succeeded" || step.conclusion === "skipped";
                return html`
                  <div class="step step-${stepClass}${collapsed ? "" : " open"}" data-step-id="${step.id}">
                    <div class="step-header">
                      <span class="chevron">&#9654;</span>
                      <span class="step-name">${step.name || "Step"}</span>
                      ${badge(step.status, step.conclusion)}
                      <span class="step-meta">${duration(step.startedAt, step.completedAt)}</span>
                    </div>
                    ${stepLogs.length > 0
                      ? html`<div class="step-body"><div class="logs">${stepLogs.map((l) => renderLogLine(l.content || ""))}</div></div>`
                      : html``
                    }
                  </div>
                `;
              })}
            </div>
          `;
        })}
      </div>
    </div>
  `;
}
