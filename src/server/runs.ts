import { createRunContext } from "./types";
import type { ServerConfig, RunContext } from "./types";

type Listener = () => void;

export class GlobalEventBus {
  private subscribers = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(): void {
    for (const fn of this.subscribers) {
      fn();
    }
  }
}

/**
 * RunManager tracks active runs on the server.
 * Runs are identified by JWT token: the runner gets a JWT containing
 * the runId in its `scp` claim, and sends it as Authorization: Bearer
 * on all requests after the initial token exchange.
 */
export class RunManager {
  private activeRuns = new Map<string, RunContext>();
  public eventBus = new GlobalEventBus();

  registerRun(config: ServerConfig): { ctx: RunContext; jobCompleted: Promise<string> } {
    const { ctx, jobCompleted } = createRunContext(config);
    this.activeRuns.set(ctx.runId, ctx);

    this.eventBus.emit();

    ctx.output.subscribe((event) => {
      if (event.type === "step_start" || event.type === "step_complete" || event.type === "job_complete") {
        this.eventBus.emit();
      }
    });

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
    this.eventBus.emit();
  }

  getActiveRuns(): RunContext[] {
    return Array.from(this.activeRuns.values());
  }

  hasActiveRuns(): boolean {
    return this.activeRuns.size > 0;
  }
}
