import { z } from "zod";

// --- Zod schemas for GitHub Actions workflow YAML ---

// YAML parses bare numbers/booleans as non-strings, but GitHub Actions env values are always strings
const EnvSchema = z.record(z.union([z.string(), z.number(), z.boolean()]).transform(String));

const StepSchema = z.object({
  uses: z.string().optional(),
  run: z.string().optional(),
  name: z.string().optional(),
  with: z.record(z.any()).optional(),
  env: EnvSchema.optional(),
  if: z.string().optional(),
  id: z.string().optional(),
  "continue-on-error": z.union([z.boolean(), z.string()]).optional(),
  "timeout-minutes": z.union([z.number(), z.string()]).optional(),
  "working-directory": z.string().optional(),
  shell: z.string().optional(),
});

export type Step = z.infer<typeof StepSchema>;

const StrategySchema = z.object({
  matrix: z.any().optional(),
  "fail-fast": z.boolean().optional(),
  "max-parallel": z.number().optional(),
}).optional();

const ServiceSchema = z.object({
  image: z.string(),
  env: EnvSchema.optional(),
  ports: z.array(z.union([z.string(), z.number()])).optional(),
  volumes: z.array(z.string()).optional(),
  options: z.string().optional(),
});

export type Service = z.infer<typeof ServiceSchema>;

const ContainerSchema = z.union([
  z.string(),
  z.object({
    image: z.string(),
    env: EnvSchema.optional(),
    ports: z.array(z.union([z.string(), z.number()])).optional(),
    volumes: z.array(z.string()).optional(),
    options: z.string().optional(),
    credentials: z.object({
      username: z.string().optional(),
      password: z.string().optional(),
    }).optional(),
  }),
]).optional();

const JobSchema = z.object({
  "runs-on": z.union([z.string(), z.array(z.string())]).optional(),
  steps: z.array(StepSchema).optional(),
  env: EnvSchema.optional(),
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  strategy: StrategySchema,
  services: z.record(ServiceSchema).optional(),
  container: ContainerSchema,
  name: z.string().optional(),
  "timeout-minutes": z.union([z.number(), z.string()]).optional(),
  outputs: z.record(z.string()).optional(),
  permissions: z.any().optional(),
  concurrency: z.any().optional(),
  uses: z.string().optional(),
  with: z.record(z.any()).optional(),
  secrets: z.any().optional(),
});

export type Job = z.infer<typeof JobSchema>;

// `on` can be: string, array of strings, or object with event configs
const EventConfigSchema = z.union([
  z.null(),
  z.object({
    branches: z.array(z.string()).optional(),
    "branches-ignore": z.array(z.string()).optional(),
    paths: z.array(z.string()).optional(),
    "paths-ignore": z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    "tags-ignore": z.array(z.string()).optional(),
    types: z.array(z.string()).optional(),
    inputs: z.record(z.any()).optional(),
    workflows: z.array(z.string()).optional(),
  }).passthrough(),
]);

const OnSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.record(EventConfigSchema),
]);

const WorkflowSchema = z.object({
  name: z.string().optional(),
  on: OnSchema,
  env: EnvSchema.optional(),
  jobs: z.record(JobSchema),
  permissions: z.any().optional(),
  concurrency: z.any().optional(),
  defaults: z.any().optional(),
}).passthrough();

export type Workflow = z.infer<typeof WorkflowSchema>;

// --- Parse and validate a workflow YAML string ---

export function parseWorkflow(yamlText: string): Workflow {
  const raw = Bun.YAML.parse(yamlText);
  return WorkflowSchema.parse(raw);
}

// --- Normalize the `on` field to a record ---

export function normalizeOn(on: Workflow["on"]): Record<string, object | null> {
  if (typeof on === "string") {
    return { [on]: null };
  }
  if (Array.isArray(on)) {
    const result: Record<string, null> = {};
    for (const event of on) {
      result[event] = null;
    }
    return result;
  }
  return on as Record<string, object | null>;
}

// --- Check if a workflow triggers on a given event ---

export function matchesEvent(workflow: Workflow, eventName: string): boolean {
  const events = normalizeOn(workflow.on);
  return eventName in events;
}

// --- Convert parsed workflow steps to runner protocol format ---

export function workflowStepsToRunnerSteps(
  steps: Step[],
  scriptStep: (script: string, displayName?: string, opts?: { condition?: string; continueOnError?: boolean; environment?: Record<string, string> }) => object,
  actionStep: (action: string, ref: string, displayName?: string, inputs?: Record<string, string>, opts?: { condition?: string; continueOnError?: boolean; environment?: Record<string, string> }) => object,
): object[] {
  return steps.map((step) => {
    const opts = {
      condition: step.if,
      continueOnError: step["continue-on-error"] === true || step["continue-on-error"] === "true",
      environment: step.env,
    };

    if (step.uses) {
      // Parse action reference: owner/repo@ref or owner/repo/path@ref
      const atIndex = step.uses.lastIndexOf("@");
      if (atIndex === -1) {
        throw new Error(`Invalid action reference (missing @version): ${step.uses}`);
      }
      const actionPath = step.uses.slice(0, atIndex);
      const ref = step.uses.slice(atIndex + 1);

      // Convert `with` values to strings
      const inputs = step.with
        ? Object.fromEntries(
            Object.entries(step.with).map(([k, v]) => [k, String(v)])
          )
        : undefined;

      return actionStep(actionPath, ref, step.name, inputs, opts);
    }

    if (step.run) {
      return scriptStep(step.run, step.name, opts);
    }

    throw new Error(`Step must have either 'uses' or 'run': ${JSON.stringify(step)}`);
  });
}
