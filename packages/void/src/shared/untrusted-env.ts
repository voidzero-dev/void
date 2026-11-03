import { join } from 'pathslash';

/** Authentication inputs that Wrangler may consume from the environment. */
export const WRANGLER_AUTH_CREDENTIAL_ENV_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CF_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CF_EMAIL',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
  'WRANGLER_CF_AUTHORIZATION_TOKEN',
  'WRANGLER_R2_SQL_AUTH_TOKEN',
  'CLOUDFLARE_ACCESS_CLIENT_ID',
  'CLOUDFLARE_ACCESS_CLIENT_SECRET',
  'CF_ACCESS_TOKEN',
] as const;

/** Credentials owned by the deploy orchestrator, never by project code. */
export const UNTRUSTED_PROJECT_CODE_ENV_VARS: ReadonlyArray<string> = [
  ...WRANGLER_AUTH_CREDENTIAL_ENV_VARS,
  'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET',
  'VOID_ACCESS_CREDENTIALS',
  'VOID_ACCESS_ORIGIN',
  'CF_ACCESS_READINESS_ORIGIN',
  'VOID_TOKEN',
  'DATABASE_URL',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
];

export function scrubEnvironmentVariables(
  env: NodeJS.ProcessEnv,
  names: ReadonlyArray<string>,
): void {
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  for (const key of Object.keys(env)) {
    if (blocked.has(key.toLowerCase())) {
      delete env[key];
    }
  }
}

/** Build an environment safe for a child that imports or executes project code. */
export function buildEnv(
  extra?: Record<string, string>,
  options?: { localBinRoot?: string },
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  scrubEnvironmentVariables(env, UNTRUSTED_PROJECT_CODE_ENV_VARS);
  if (options?.localBinRoot === undefined) {
    return env;
  }
  const binDir = join(options.localBinRoot, 'node_modules', '.bin');
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const existing = env[pathKey];
  env[pathKey] = existing ? `${binDir}${delimiter}${existing}` : binDir;
  return env;
}
