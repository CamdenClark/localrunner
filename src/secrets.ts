import { existsSync } from "fs";

export async function parseEnvFile(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const text = await Bun.file(path).text();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function scanRequiredSecrets(yamlText: string): string[] {
  const matches = yamlText.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g);
  const names = new Set<string>();
  for (const m of matches) {
    names.add(m[1]!);
  }
  return [...names];
}

export interface ResolveSecretsOpts {
  token?: string;
  secretArgs?: string[];
  secretFile?: string;
  yamlText?: string;
}

export async function resolveSecrets(opts: ResolveSecretsOpts): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};

  // 1. GITHUB_TOKEN from repo context token
  if (opts.token) {
    secrets["GITHUB_TOKEN"] = opts.token;
  }

  // 2. Secret file (explicit or default .secrets)
  const secretFilePath = opts.secretFile ?? (existsSync(".secrets") ? ".secrets" : undefined);
  if (secretFilePath && existsSync(secretFilePath)) {
    const fileSecrets = await parseEnvFile(secretFilePath);
    Object.assign(secrets, fileSecrets);
  }

  // 3. Inline -s KEY=VALUE or -s KEY (env fallback)
  if (opts.secretArgs) {
    for (const arg of opts.secretArgs) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex === -1) {
        // -s KEY → read from process.env
        const envVal = process.env[arg];
        if (envVal !== undefined) {
          secrets[arg] = envVal;
        } else {
          console.warn(`Warning: secret '${arg}' not found in environment`);
        }
      } else {
        const key = arg.slice(0, eqIndex);
        const value = arg.slice(eqIndex + 1);
        secrets[key] = value;
      }
    }
  }

  // 4. Warn about unreferenced secrets
  if (opts.yamlText) {
    const required = scanRequiredSecrets(opts.yamlText);
    for (const name of required) {
      if (!(name in secrets)) {
        console.warn(`Warning: secret '${name}' referenced in workflow but not provided`);
      }
    }
  }

  return secrets;
}
