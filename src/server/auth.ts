import type { Hono } from "hono";
import type { ServerEnv } from "./hono";
import type { RunContext } from "./types";

export function registerAuthRoutes(app: Hono<ServerEnv>, ctx: RunContext) {
  app.post("/_apis/oauth2/token", (c) => {
    ctx.output.emit({ type: "server", tag: "auth", message: "Token request" });
    return c.json({
      access_token: ctx.jwt,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  app.get("/_apis/connectionData", (c) => {
    ctx.output.emit({ type: "server", tag: "connect", message: "Connection data request" });
    return c.json(buildConnectionData(ctx));
  });

  app.post("/session", (c) => {
    ctx.output.emit({ type: "server", tag: "session", message: "Created" });
    return c.json({
      sessionId: ctx.sessionId,
      ownerName: "local",
      agent: { id: 1, name: "local-runner", version: "2.332.0" },
      encryptionKey: null,
    });
  });

  app.delete("/session", (c) => {
    ctx.output.emit({ type: "server", tag: "session", message: "Deleted" });
    return c.json({});
  });
}

function buildConnectionData(ctx: RunContext): object {
  return {
    authenticatedUser: { id: "00000000-0000-0000-0000-000000000001" },
    authorizedUser: { id: "00000000-0000-0000-0000-000000000001" },
    instanceId: "00000000-0000-0000-0000-000000000000",
    locationServiceData: {
      serviceOwner: "00000000-0000-0000-0000-000000000000",
      defaultAccessMappingMoniker: "HostGuidAccessMapping",
      lastChangeId: 1,
      lastChangeId64: 1,
      clientCacheFresh: false,
      accessMappings: [
        {
          moniker: "HostGuidAccessMapping",
          accessPoint: `${ctx.serverBaseUrl}/`,
          displayName: "Host Guid Access Mapping",
        },
      ],
      serviceDefinitions: [],
    },
  };
}
