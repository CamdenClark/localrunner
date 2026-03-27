import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export function layout(title: string, content: HtmlEscapedString) {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — localrunner</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.2/sse.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      background: #0d1117;
      color: #c9d1d9;
      line-height: 1.5;
    }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }

    .container { max-width: 1200px; margin: 0 auto; padding: 1rem; }

    .run-layout { display: flex; gap: 1.5rem; }
    .run-sidebar {
      width: 260px;
      flex-shrink: 0;
      position: sticky;
      top: 1rem;
      align-self: flex-start;
      max-height: calc(100vh - 2rem);
      overflow-y: auto;
      border-right: 1px solid #21262d;
      padding-right: 1rem;
      background: #0d1117;
    }
    .run-main { flex: 1; min-width: 0; }

    .sidebar-section { margin-bottom: 1.5rem; }
    .sidebar-section h4 {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #8b949e;
      margin-bottom: 0.5rem;
      padding: 0 0.5rem;
    }
    .sidebar-job {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.5rem;
      border-radius: 6px;
      font-size: 0.85rem;
      color: #c9d1d9;
      cursor: pointer;
      transition: background 0.15s;
    }
    .sidebar-job:hover { background: #161b22; text-decoration: none; }
    .sidebar-job .status-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    }
    .dot-succeeded { background: #238636; }
    .dot-failed { background: #da3633; }
    .dot-cancelled { background: #6e7681; }
    .dot-in_progress { background: #d29922; }
    .dot-queued { background: #388bfd; }

    .sidebar-artifact {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.3rem 0.5rem;
      font-size: 0.8rem;
      color: #8b949e;
    }
    .sidebar-artifact .artifact-size { margin-left: auto; font-size: 0.7rem; }

    header {
      border-bottom: 1px solid #21262d;
      padding: 0.75rem 0;
      margin-bottom: 1.5rem;
    }
    header .container { display: flex; align-items: center; gap: 1rem; }
    header h1 { font-size: 1.1rem; font-weight: 600; }
    header nav { margin-left: auto; }
    header nav a { font-size: 0.9rem; color: #8b949e; }
    header nav a:hover { color: #c9d1d9; }

    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-succeeded { background: #238636; color: #fff; }
    .badge-failed { background: #da3633; color: #fff; }
    .badge-cancelled { background: #6e7681; color: #fff; }
    .badge-in_progress { background: #d29922; color: #fff; }
    .badge-queued { background: #388bfd; color: #fff; }

    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 0.8rem; color: #8b949e; padding: 0.5rem; border-bottom: 1px solid #21262d; }
    td { padding: 0.5rem; border-bottom: 1px solid #161b22; font-size: 0.9rem; }
    tr:hover { background: #161b22; }

    .run-detail { margin-top: 1rem; }
    .run-header { margin-bottom: 1rem; }
    .run-header h2 { font-size: 1.2rem; margin-bottom: 0.25rem; }
    .run-meta { font-size: 0.85rem; color: #8b949e; }

    .step { margin: 0.25rem 0; border-left: 3px solid #21262d; border-radius: 4px; }
    .step-succeeded { border-color: #238636; }
    .step-failed { border-color: #da3633; }
    .step-in_progress { border-color: #d29922; }
    .step-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s;
    }
    .step-header:hover { background: #161b22; }
    .step-header .chevron {
      font-size: 0.7rem;
      color: #484f58;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .step.open .chevron { transform: rotate(90deg); }
    .step-name { font-weight: 600; font-size: 0.9rem; flex: 1; }
    .step-meta { font-size: 0.8rem; color: #8b949e; flex-shrink: 0; }
    .step-body { display: none; }
    .step.open .step-body { display: block; }

    .logs {
      margin: 0;
      background: #161b22;
      border-top: 1px solid #21262d;
      padding: 0.75rem;
      max-height: 600px;
      overflow-y: auto;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.8rem;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.4;
    }
    .log-line { color: #c9d1d9; }
    .log-warning { color: #d29922; }
    .log-error { color: #f85149; font-weight: 600; }
    .log-notice { color: #58a6ff; }
    .log-debug { color: #484f58; }
    .log-group { color: #c9d1d9; font-weight: 600; }
    .log-command { color: #484f58; }

    .workflow-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .workflow-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      border: 1px solid #21262d;
      border-radius: 6px;
      background: #161b22;
    }
    .workflow-card:hover { border-color: #30363d; }
    .workflow-name { font-weight: 600; font-size: 1rem; }
    .workflow-file { font-size: 0.8rem; color: #8b949e; margin-top: 0.15rem; }
    .workflow-jobs { font-size: 0.8rem; color: #8b949e; margin-top: 0.25rem; }
    .workflow-triggers { display: flex; gap: 0.5rem; flex-wrap: wrap; flex-shrink: 0; margin-left: 1rem; }
    .trigger-btn {
      background: #21262d;
      color: #c9d1d9;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 0.35rem 0.75rem;
      font-size: 0.8rem;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      font-family: inherit;
    }
    .trigger-btn:hover { background: #30363d; border-color: #484f58; }
    .trigger-btn.triggered { background: #238636; border-color: #238636; color: #fff; }

    .quick-run { margin-bottom: 2rem; }
    .quick-run-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }
    .quick-run-title { font-size: 1rem; font-weight: 600; }
    .quick-run-link { font-size: 0.85rem; color: #58a6ff; }
    .quick-run-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 0.75rem;
    }
    .qr-card {
      border: 1px solid #21262d;
      border-radius: 8px;
      background: #161b22;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .qr-card:hover { border-color: #30363d; }
    .qr-card-name { font-weight: 600; font-size: 0.95rem; }
    .qr-card-meta { font-size: 0.8rem; color: #8b949e; }
    .qr-card-triggers { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.25rem; }
    .qr-trigger {
      background: #238636;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 0.35rem 0.75rem;
      font-size: 0.8rem;
      cursor: pointer;
      font-family: inherit;
      font-weight: 500;
      transition: background 0.15s;
    }
    .qr-trigger:hover { background: #2ea043; }
    .qr-trigger.triggered { background: #1a7f37; opacity: 0.8; }

    .empty { text-align: center; padding: 3rem; color: #8b949e; }

    .refresh-indicator {
      font-size: 0.75rem;
      color: #484f58;
      float: right;
    }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <h1><a href="/" style="color: inherit;">localrunner</a></h1>
      <nav>
        <a href="/workflows">All Workflows</a>
      </nav>
    </div>
  </header>
  <div class="container">
    ${content}
  </div>
  <script>
    // Track user-toggled steps so state survives SSE innerHTML swaps
    const userToggles = new Map(); // stepId -> true (open) | false (closed)

    document.addEventListener('click', (e) => {
      const header = e.target.closest('.step-header');
      if (!header) return;
      const step = header.parentElement;
      step.classList.toggle('open');
      const id = step.dataset.stepId;
      if (id) userToggles.set(id, step.classList.contains('open'));
    });

    // After HTMX swaps new HTML in, re-apply any user overrides
    document.addEventListener('htmx:afterSwap', () => {
      for (const [id, isOpen] of userToggles) {
        const el = document.querySelector('[data-step-id="' + id + '"]');
        if (!el) continue;
        el.classList.toggle('open', isOpen);
      }
    });
  </script>
</body>
</html>`;
}
