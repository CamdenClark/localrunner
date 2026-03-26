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

    .container { max-width: 960px; margin: 0 auto; padding: 1rem; }

    header {
      border-bottom: 1px solid #21262d;
      padding: 0.75rem 0;
      margin-bottom: 1.5rem;
    }
    header .container { display: flex; align-items: center; gap: 1rem; }
    header h1 { font-size: 1.1rem; font-weight: 600; }
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

    .step { margin: 0.5rem 0; padding: 0.5rem 0.75rem; border-left: 3px solid #21262d; }
    .step-succeeded { border-color: #238636; }
    .step-failed { border-color: #da3633; }
    .step-in_progress { border-color: #d29922; }
    .step-name { font-weight: 600; font-size: 0.9rem; }
    .step-meta { font-size: 0.8rem; color: #8b949e; }

    .logs {
      margin-top: 1rem;
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 6px;
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
      <h1>localrunner</h1>
      <nav>
        <a href="/">Runs</a>
      </nav>
    </div>
  </header>
  <div class="container">
    ${content}
  </div>
</body>
</html>`;
}
