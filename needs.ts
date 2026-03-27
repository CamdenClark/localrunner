/** Normalize job needs to an array */
export function normalizeNeeds(needs: string | string[] | undefined): string[] {
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/** Topological sort of jobs by `needs` dependencies. Returns job names in execution order. */
export function topologicalSortJobs(
  jobs: Record<string, { needs?: string | string[] }>,
): string[] {
  const jobNames = Object.keys(jobs);
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(name: string, stack: Set<string>) {
    if (visited.has(name)) return;
    if (stack.has(name)) {
      throw new Error(`Circular dependency detected in jobs: ${[...stack, name].join(" → ")}`);
    }
    stack.add(name);
    const deps = normalizeNeeds(jobs[name]?.needs);
    for (const dep of deps) {
      if (!jobs[dep]) {
        throw new Error(`Job '${name}' depends on unknown job '${dep}'`);
      }
      visit(dep, stack);
    }
    stack.delete(name);
    visited.add(name);
    result.push(name);
  }

  for (const name of jobNames) {
    visit(name, new Set());
  }

  return result;
}

/** Map runner conclusion to GitHub Actions needs.*.result value */
export function conclusionToResult(conclusion: string): string {
  switch (conclusion) {
    case "succeeded": return "success";
    case "failed": return "failure";
    case "cancelled": return "cancelled";
    case "skipped": return "skipped";
    default: return conclusion;
  }
}
