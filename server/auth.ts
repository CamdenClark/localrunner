import type { RunContext } from "./types";

export function authRoutes(ctx: RunContext) {
  return {
    "/_apis/oauth2/token": {
      POST: () => {
        ctx.output.emit({ type: "server", tag: "auth", message: "Token request" });
        return Response.json({
          access_token: ctx.jwt,
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
    },
    "/_apis/connectionData": {
      GET: () => {
        ctx.output.emit({ type: "server", tag: "connect", message: "Connection data request" });
        return Response.json(buildConnectionData(ctx));
      },
    },
    "/session": {
      POST: () => {
        ctx.output.emit({ type: "server", tag: "session", message: "Created" });
        return Response.json({
          sessionId: ctx.sessionId,
          ownerName: "local",
          agent: { id: 1, name: "local-runner", version: "2.332.0" },
          encryptionKey: null,
        });
      },
      DELETE: () => {
        ctx.output.emit({ type: "server", tag: "session", message: "Deleted" });
        return Response.json({});
      },
    },
  };
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
