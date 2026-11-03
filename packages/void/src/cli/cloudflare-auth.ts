import { execFile, spawn } from 'node:child_process';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import {
  createCloudflareProcessRunner,
  encodeCloudflareOperation,
  decodeCloudflareOperationResult,
  isCleanCloudflareExit,
} from './cloudflare-process.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';

export type CloudflareAccount = Readonly<{
  id: string;
  name: string;
}>;

export type CloudflareAuthRunResult = Readonly<{
  status: number | null;
  data?: unknown;
  stderr: string;
  stdout: string;
  signal?: NodeJS.Signals | null;
  error?: string | null;
}>;

export type CloudflareAuthRunner = (
  operation: CloudflareOperation,
  capture: boolean,
) => CloudflareAuthRunResult | Promise<CloudflareAuthRunResult>;

export type CloudflareAuthSession = Readonly<{
  accounts: ReadonlyArray<CloudflareAccount>;
  email?: string;
  authType?: string;
}>;

export type EnsureCloudflareAuthenticationOptions = Readonly<{
  /**
   * Treat an explicit API token as sufficient for a pinned, non-discovery operation.
   * The operation itself remains the authoritative permission and validity check.
   */
  acceptApiToken?: boolean;
  /** Explicit login must authenticate again, even when an existing session works. */
  forceLogin?: boolean;
  beforeRun?: () => boolean;
  interactive?: boolean;
  /** Require whoami JSON to contain at least one account (account onboarding). */
  requireAccounts?: boolean;
  runWrangler: CloudflareAuthRunner;
  configPath?: string;
}>;

export class CloudflareAuthenticationError extends Error {
  override name = 'CloudflareAuthenticationError';
  readonly reason: 'login' | 'not-authenticated' | 'uploader-changed' | 'environment-credentials';

  constructor(message: string, reason: CloudflareAuthenticationError['reason']) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Authenticate with Cloudflare through Void's bundled deployment tooling.
 *
 * The caller owns the runner so deploy can retain its pinned account, API base,
 * config, and uploader-integrity boundary. Interactive sessions recover from an
 * expired or missing OAuth session in-process; CI remains token-only.
 */
export async function ensureCloudflareAuthentication(
  options: EnsureCloudflareAuthenticationOptions,
): Promise<CloudflareAuthSession> {
  if (options.forceLogin) {
    const overrides = cloudflareCredentialOverrides();
    if (overrides.length > 0) {
      throw new CloudflareAuthenticationError(
        `Cloudflare browser login cannot replace credentials supplied by ${overrides.join(', ')}. Remove these overrides from this shell and rerun \`void cloudflare login\`.`,
        'environment-credentials',
      );
    }
  }
  if (
    options.acceptApiToken &&
    !options.requireAccounts &&
    (process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim())
  ) {
    return { accounts: [] };
  }
  const run = async (
    operation: CloudflareOperation,
    capture: boolean,
  ): Promise<CloudflareAuthRunResult> => {
    if (options.beforeRun && !options.beforeRun()) {
      throw new CloudflareAuthenticationError('', 'uploader-changed');
    }
    return await options.runWrangler(operation, capture);
  };
  const whoami: CloudflareOperation = {
    type: 'auth.whoami',
    ...(options.configPath ? { configPath: options.configPath } : {}),
  };
  const readSession = async (): Promise<CloudflareAuthSession | null> => {
    const result = await run(whoami, true);
    if (!isCleanCloudflareExit(result)) {
      return null;
    }
    const session = parseCloudflareAuthSession(result.data);
    if (options.requireAccounts) {
      return session && session.accounts.length > 0 ? session : null;
    }
    return session;
  };

  const existing = options.forceLogin ? null : await readSession();
  if (existing) {
    return existing;
  }

  const interactive = options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new CloudflareAuthenticationError(
      'Cloudflare authentication is required. Set CLOUDFLARE_API_TOKEN in CI, or run `void cloudflare login` in an interactive terminal.',
      'not-authenticated',
    );
  }

  const login = await run({ type: 'auth.login' }, false);
  if (!isCleanCloudflareExit(login)) {
    throw new CloudflareAuthenticationError(
      'Cloudflare browser sign-in did not complete. Run `void cloudflare login` to try again.',
      'login',
    );
  }

  const authenticated = await readSession();
  if (!authenticated) {
    throw new CloudflareAuthenticationError(
      'Cloudflare sign-in completed without a usable session. Run `void cloudflare login` to try again.',
      'not-authenticated',
    );
  }
  return authenticated;
}

/** Credential names only: never include their values in diagnostics. */
export function cloudflareCredentialOverrides(
  source: NodeJS.ProcessEnv = process.env,
): Array<string> {
  const tokens = ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'].filter((key) => Boolean(source[key]));
  const key = ['CLOUDFLARE_API_KEY', 'CF_API_KEY'].find((key) => Boolean(source[key]));
  const email = ['CLOUDFLARE_EMAIL', 'CF_EMAIL'].find((key) => Boolean(source[key]));
  return [...tokens, ...(key && email ? [key, email] : [])];
}

export function parseCloudflareAuthSession(value: unknown): CloudflareAuthSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.loggedIn !== true || !Array.isArray(record.accounts)) {
    return null;
  }

  const accounts: Array<CloudflareAccount> = [];
  for (const account of record.accounts) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      continue;
    }
    const item = account as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      continue;
    }
    accounts.push({
      id: item.id,
      name:
        typeof item.name === 'string' && item.name.length > 0 ? item.name : 'Cloudflare account',
    });
  }
  return {
    accounts,
    ...(typeof record.email === 'string' && record.email ? { email: record.email } : {}),
    ...(typeof record.authType === 'string' && record.authType
      ? { authType: record.authType }
      : {}),
  };
}

export function createBundledCloudflareAuthRunner(root: string): CloudflareAuthRunner {
  const run = createCloudflareProcessRunner({
    root,
    env: cloudflareAuthEnvironment,
    timeoutMs: 10 * 60 * 1000,
  });
  return (operation, capture) => run(operation, { capture });
}

/** Run a captured auth command without blocking terminal input or exposing credentials. */
export function runCloudflareAuthCommand(
  root: string,
  operation: CloudflareOperation,
  signal?: AbortSignal,
): Promise<CloudflareAuthRunResult> {
  const [command, ...prefix] = resolveCloudflareOperationArgv();
  const args = encodeCloudflareOperation(operation);
  if (cloudflareAuthNeedsTerminal(operation)) {
    // cf can prompt or print a device code while the browser login is active.
    return new Promise((resolve) => {
      const child = spawn(command!, [...prefix, ...args], {
        cwd: root,
        env: cloudflareAuthEnvironment(),
        shell: false,
        signal,
        stdio: 'inherit',
        timeout: 10 * 60 * 1000,
        windowsHide: true,
      });
      child.once('error', (error) => {
        resolve({ status: null, stdout: '', stderr: '', error: error.message });
      });
      child.once('close', (status, signal) => {
        resolve({ status, signal, stdout: '', stderr: '' });
      });
    });
  }
  return new Promise((resolve) => {
    const child = execFile(
      command!,
      [...prefix, ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: cloudflareAuthEnvironment(),
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        signal,
        timeout: 10 * 60 * 1000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve(
          decodeCloudflareOperationResult({
            status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
            stderr,
            stdout,
            signal: error?.signal,
            error: error?.message,
          }),
        );
      },
    );
    child.stdin?.end();
  });
}

/** Browser login must display cf's prompts before it completes. */
function cloudflareAuthNeedsTerminal(operation: CloudflareOperation): boolean {
  return operation.type === 'auth.login';
}

export function cloudflareAuthEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  const scrubbedKeys = new Set([
    'WRANGLER_OUTPUT_FILE_DIRECTORY',
    'WRANGLER_OUTPUT_FILE_PATH',
    'WRANGLER_LOG_SANITIZE',
    'CLOUDFLARE_AUTH_USE_KEYRING',
  ]);
  for (const key of Object.keys(env)) {
    if (
      /^VOID_PLATFORM_/i.test(key) ||
      /^(?:DATABASE_URL|CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET|CF_ACCESS_TOKEN|CF_ACCESS_READINESS_ORIGIN|VOID_ACCESS_CREDENTIALS|VOID_ACCESS_ORIGIN)$/i.test(
        key,
      ) ||
      scrubbedKeys.has(key.toUpperCase())
    ) {
      delete env[key];
    }
  }
  // Deploy uses the encrypted cf store. Login and status must read that same
  // store: cf migrates plaintext credentials into it and removes the old file.
  env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
  return env;
}
