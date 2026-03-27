// --- workflow_dispatch input validation ---

export interface InputDefinition {
  description?: string;
  required?: boolean;
  default?: string | boolean | number;
  type?: "string" | "boolean" | "choice" | "number" | "environment";
  options?: string[];
}

export interface ResolvedInputs {
  inputs: Record<string, string>;
}

/**
 * Parse --input KEY=VAL arguments into a record.
 */
export function parseInputArgs(args?: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!args) return result;
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      throw new Error(`Invalid --input format '${arg}', expected KEY=VALUE`);
    }
    result[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return result;
}

/**
 * Validate and resolve workflow_dispatch inputs.
 *
 * Merges CLI-provided values over defaults, validates types and required fields,
 * and returns the final input values as strings.
 */
export function validateInputs(
  definitions: Record<string, InputDefinition> | undefined,
  provided: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const errors: string[] = [];

  if (!definitions) {
    // No inputs defined — warn if values were provided
    if (Object.keys(provided).length > 0) {
      throw new Error(
        `Workflow does not define any inputs, but received: ${Object.keys(provided).join(", ")}`,
      );
    }
    return result;
  }

  // Check for unknown inputs
  for (const key of Object.keys(provided)) {
    if (!(key in definitions)) {
      errors.push(`Unknown input '${key}'. Defined inputs: ${Object.keys(definitions).join(", ")}`);
    }
  }

  for (const [name, def] of Object.entries(definitions)) {
    const type = def.type || "string";

    // Resolve value: CLI arg > default
    let value: string | undefined;
    if (name in provided) {
      value = provided[name];
    } else if (def.default !== undefined) {
      value = String(def.default);
    }

    // Check required
    if (def.required && value === undefined) {
      errors.push(`Input '${name}' is required but was not provided and has no default`);
      continue;
    }

    // If no value and not required, use empty string (GitHub behavior)
    if (value === undefined) {
      value = "";
    }

    // Type validation
    switch (type) {
      case "boolean": {
        const lower = value.toLowerCase();
        if (lower !== "true" && lower !== "false") {
          errors.push(`Input '${name}' must be a boolean ('true' or 'false'), got '${value}'`);
        }
        break;
      }
      case "number": {
        if (value !== "" && isNaN(Number(value))) {
          errors.push(`Input '${name}' must be a number, got '${value}'`);
        }
        break;
      }
      case "choice": {
        const options = def.options || [];
        if (options.length === 0) {
          errors.push(`Input '${name}' is type 'choice' but has no options defined`);
        } else if (!options.includes(value)) {
          errors.push(
            `Input '${name}' must be one of [${options.join(", ")}], got '${value}'`,
          );
        }
        break;
      }
      case "string":
      case "environment":
        // No additional validation needed
        break;
      default:
        errors.push(`Input '${name}' has unknown type '${type}'`);
    }

    result[name] = value;
  }

  if (errors.length > 0) {
    throw new Error(`Input validation failed:\n  - ${errors.join("\n  - ")}`);
  }

  return result;
}
