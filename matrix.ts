/**
 * Matrix strategy expansion and filtering for GitHub Actions workflows.
 *
 * Supports:
 * - Simple key→array definitions (Cartesian product)
 * - `include` entries (add or augment combinations)
 * - `exclude` entries (remove matching combinations)
 * - CLI `--matrix key:value` filtering
 */

export type MatrixCombination = Record<string, string>;

export interface MatrixConfig {
  include?: MatrixCombination[];
  exclude?: MatrixCombination[];
  [key: string]: unknown;
}

/**
 * Expand a strategy.matrix config into an array of combinations.
 */
export function expandMatrix(matrix: MatrixConfig | undefined | null): MatrixCombination[] {
  if (!matrix || typeof matrix !== "object") return [];

  const { include, exclude, ...dimensions } = matrix;

  // Build Cartesian product of all dimension arrays
  const dimEntries = Object.entries(dimensions).filter(
    ([, v]) => Array.isArray(v),
  ) as [string, unknown[]][];

  let combinations: MatrixCombination[] = [];

  if (dimEntries.length > 0) {
    combinations = cartesian(dimEntries);
  }

  // Apply exclude: remove combinations that match all keys in an exclude entry
  if (Array.isArray(exclude)) {
    combinations = combinations.filter(
      (combo) => !exclude.some((ex) => matchesCombination(combo, ex)),
    );
  }

  // Apply include: add new combinations or augment existing ones
  if (Array.isArray(include)) {
    for (const inc of include) {
      // Check if this include entry matches an existing combination on the
      // dimension keys. If so, merge extra keys into that combination.
      // Otherwise, add it as a new standalone combination.
      const dimKeys = dimEntries.map(([k]) => k);
      const matchesDimensions = dimKeys.length > 0 && dimKeys.every((k) => k in inc);

      if (matchesDimensions) {
        let matched = false;
        for (const combo of combinations) {
          if (dimKeys.every((k) => String(combo[k]) === String(inc[k]))) {
            Object.assign(combo, stringifyValues(inc));
            matched = true;
          }
        }
        if (!matched) {
          combinations.push(stringifyValues(inc));
        }
      } else {
        combinations.push(stringifyValues(inc));
      }
    }
  }

  return combinations;
}

/**
 * Filter matrix combinations by `--matrix key:value` CLI args.
 */
export function filterMatrix(
  combinations: MatrixCombination[],
  filters: string[],
): MatrixCombination[] {
  if (filters.length === 0) return combinations;

  const parsed = filters.map((f) => {
    const colon = f.indexOf(":");
    if (colon === -1) {
      throw new Error(`Invalid --matrix filter '${f}', expected key:value format`);
    }
    return { key: f.slice(0, colon), value: f.slice(colon + 1) };
  });

  return combinations.filter((combo) =>
    parsed.every(({ key, value }) => combo[key] === value),
  );
}

/**
 * Format a matrix combination for display, e.g. "(node: 18, os: ubuntu-latest)"
 */
export function formatMatrixCombo(combo: MatrixCombination): string {
  const parts = Object.entries(combo).map(([k, v]) => `${k}: ${v}`);
  return `(${parts.join(", ")})`;
}

function cartesian(dims: [string, unknown[]][]): MatrixCombination[] {
  if (dims.length === 0) return [{}];

  const [first, ...rest] = dims;
  const [key, values] = first!;
  const restCombos = cartesian(rest);

  const result: MatrixCombination[] = [];
  for (const val of values) {
    for (const combo of restCombos) {
      result.push({ [key]: String(val), ...combo });
    }
  }
  return result;
}

function matchesCombination(combo: MatrixCombination, pattern: MatrixCombination): boolean {
  return Object.entries(pattern).every(
    ([k, v]) => String(combo[k]) === String(v),
  );
}

function stringifyValues(obj: Record<string, unknown>): MatrixCombination {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, String(v)]),
  );
}
