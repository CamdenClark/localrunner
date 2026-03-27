import { html } from "hono/html";

interface WorkflowInfo {
  fileName: string;
  name: string;
  events: string[];
  jobs: string[];
}

export function workflowsPage(workflows: WorkflowInfo[]) {
  if (workflows.length === 0) {
    return html`<div class="empty">No workflows found in <code>.github/workflows/</code></div>`;
  }

  return html`
    <div class="workflow-list">
      ${workflows.map((wf) => html`
        <div class="workflow-card">
          <div class="workflow-info">
            <div class="workflow-name">${wf.name}</div>
            <div class="workflow-file">${wf.fileName}</div>
            <div class="workflow-jobs">${wf.jobs.length} job${wf.jobs.length !== 1 ? "s" : ""}: ${wf.jobs.join(", ")}</div>
          </div>
          <div class="workflow-triggers">
            ${wf.events.map((event) => html`
              <button
                class="trigger-btn"
                hx-post="/api/trigger"
                hx-vals='${JSON.stringify({ fileName: wf.fileName, event })}'
                hx-swap="none"
                onclick="this.classList.add('triggered'); this.textContent='triggered…'; setTimeout(() => { this.classList.remove('triggered'); this.textContent='${event}'; }, 2000)"
              >${event}</button>
            `)}
          </div>
        </div>
      `)}
    </div>
  `;
}
