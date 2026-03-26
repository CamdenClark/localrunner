import type { Hono } from "hono";
import type { ServerEnv } from "./hono";
import type { OutputHandler } from "../output";
import type { RunContext } from "./types";

export function registerActionsRoutes(app: Hono<ServerEnv>, ctx: RunContext) {
  // The runner posts to paths like /runnerresolve/actions or /_apis/.../runnerresolve/actions
  app.post("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (!url.pathname.includes("/runnerresolve/actions")) {
      await next();
      return;
    }
    const body = (await c.req.json()) as any;
    const actions = (body.actions || []).map((a: any) => ({
      action: a.action || a.name,
      version: a.version || a.ref,
      path: a.path || "",
    }));
    const resolved = await resolveActions(actions, ctx.repoCtx.token, ctx.repoCtx.apiUrl, ctx.output);
    return c.json({ actions: resolved });
  });
}

async function resolveActions(
  actions: { action: string; version: string; path: string }[],
  token: string,
  apiUrl: string,
  output: OutputHandler,
): Promise<Record<string, object>> {
  const result: Record<string, object> = {};

  for (const { action, version, path } of actions) {
    const key = `${action}@${version}`;
    output.emit({ type: "server", tag: "actions", message: `Resolving ${key}...` });

    try {
      const refRes = await fetch(
        `${apiUrl}/repos/${action}/git/ref/tags/${version}`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "localrunner",
            Authorization: `Bearer ${token}`,
          },
        },
      );

      let sha = version;
      if (refRes.ok) {
        const refData = (await refRes.json()) as any;
        sha = refData.object.sha;

        if (refData.object.type === "tag") {
          const tagRes = await fetch(refData.object.url, {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "localrunner",
              Authorization: `Bearer ${token}`,
            },
          });
          if (tagRes.ok) {
            const tagData = (await tagRes.json()) as any;
            sha = tagData.object.sha;
          }
        }
      } else {
        const branchRes = await fetch(
          `${apiUrl}/repos/${action}/git/ref/heads/${version}`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "localrunner",
              Authorization: `Bearer ${token}`,
            },
          },
        );
        if (branchRes.ok) {
          const branchData = (await branchRes.json()) as any;
          sha = branchData.object.sha;
        }
      }

      output.emit({ type: "server", tag: "actions", message: `Resolved ${key} -> ${sha.slice(0, 12)}` });

      result[key] = {
        name: action,
        resolved_name: action,
        resolved_sha: sha,
        tar_url: `${apiUrl}/repos/${action}/tarball/${sha}`,
        zip_url: `${apiUrl}/repos/${action}/zipball/${sha}`,
        version: version,
        authentication: {
          token,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      };
    } catch (err) {
      output.emit({ type: "server", tag: "actions", message: `Failed to resolve ${key}: ${err}` });
      result[key] = {
        name: action,
        resolved_name: action,
        resolved_sha: version,
        tar_url: `${apiUrl}/repos/${action}/tarball/${version}`,
        zip_url: `${apiUrl}/repos/${action}/zipball/${version}`,
        version: version,
        authentication: {
          token,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      };
    }
  }

  return result;
}
