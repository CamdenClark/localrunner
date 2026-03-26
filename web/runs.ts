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

function badge(status: string | null, conclusion: string | null) {
  if (status === "completed" && conclusion) {
    return html`<span class="badge badge-${conclusion}">${conclusion}</span>`;
  }
  if (status) {
    return html`<span class="badge badge-${status}">${status}</span>`;
  }
  return html`<span class="badge badge-queued">queued</span>`;
}

function relativeTime(ts: number | null): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function duration(start: number | null, end: number | null): string {
  if (!start) return "";
  const elapsed = (end || Date.now()) - start;
  if (elapsed < 1000) return "<1s";
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s`;
  return `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`;
}

export function runsTable(runs: Run[]) {
  if (runs.length === 0) {
    return html`<div class="empty">No runs yet. Trigger one with <code>localrunner push</code></div>`;
  }

  return html`
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Workflow</th>
          <th>Job</th>
          <th>Event</th>
          <th>SHA</th>
          <th>Duration</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        ${runs.map(
          (r) => html`
            <tr>
              <td>${badge(r.status, r.conclusion)}</td>
              <td><a href="/runs/${r.id}">${r.workflowName || "—"}</a></td>
              <td>${r.jobName || "—"}</td>
              <td>${r.eventName || "—"}</td>
              <td><code>${r.sha?.slice(0, 8) || "—"}</code></td>
              <td>${duration(r.startedAt, r.completedAt)}</td>
              <td>${relativeTime(r.startedAt)}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;
}

export function runsPage(runs: Run[]) {
  return html`
    <div
      hx-get="/partials/runs"
      hx-trigger="every 3s"
      hx-swap="innerHTML"
    >
      ${runsTable(runs)}
    </div>
  `;
}
