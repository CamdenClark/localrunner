import { $ } from "bun";
import { existsSync } from "fs";
import { parseEnvFile } from "./secrets";

export interface ResolveVariablesOpts {
  varArgs?: string[];
  varFile?: string;
}

export async function resolveVariables(opts: ResolveVariablesOpts): Promise<Record<string, string>> {
  const variables: Record<string, string> = {};

  // 1. Auto-fetch from gh CLI
  try {
    const ghVars = await $`gh variable list --json name,value`.json() as { name: string; value: string }[];
    for (const v of ghVars) {
      variables[v.name] = v.value;
    }
  } catch {
    // gh CLI not available or no variables configured — continue silently
  }

  // 2. Variable file (explicit or default .vars)
  const varFilePath = opts.varFile ?? (existsSync(".vars") ? ".vars" : undefined);
  if (varFilePath && existsSync(varFilePath)) {
    const fileVars = await parseEnvFile(varFilePath);
    Object.assign(variables, fileVars);
  }

  // 3. Inline --var KEY=VALUE overrides
  if (opts.varArgs) {
    for (const arg of opts.varArgs) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex === -1) {
        console.warn(`Warning: invalid variable format '${arg}', expected KEY=VALUE`);
        continue;
      }
      const key = arg.slice(0, eqIndex);
      const value = arg.slice(eqIndex + 1);
      variables[key] = value;
    }
  }

  return variables;
}
