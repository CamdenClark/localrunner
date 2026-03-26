import { createRunContext } from "./types";
import type { ServerConfig, RunContext } from "./types";

/**
 * RunManager tracks active runs on the server.
 * Runs are identified by JWT token: the runner gets a JWT containing
 * the runId in its `scp` claim, and sends it as Authorization: Bearer
 * on all requests after the initial token exchange.
 */
export class RunManager {
  private activeRuns = new Map<string, RunContext>();

  registerRun(config: ServerConfig): { ctx: RunContext; jobCompleted: Promise<string> } {
    const { ctx, jobCompleted } = createRunContext(config);
    this.activeRuns.set(ctx.runId, ctx);
    return { ctx, jobCompleted };
  }

  getRunByRunId(runId: string): RunContext | undefined {
    return this.activeRuns.get(runId);
  }

  /**
   * Extract runId from a JWT's scp claim and look up the run.
   * JWT payload.scp = "Actions.Results:{runId}:{jobId}"
   */
  getRunFromJwt(jwt: string): RunContext | undefined {
    try {
      const parts = jwt.split(".");
      if (parts.length !== 3) return undefined;
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
      const scp = payload.scp as string;
      if (!scp) return undefined;
      const runId = scp.split(":")[1];
      return runId ? this.activeRuns.get(runId) : undefined;
    } catch {
      return undefined;
    }
  }

  completeRun(runId: string) {
    this.activeRuns.delete(runId);
  }

  getActiveRuns(): RunContext[] {
    return Array.from(this.activeRuns.values());
  }

  hasActiveRuns(): boolean {
    return this.activeRuns.size > 0;
  }
}
