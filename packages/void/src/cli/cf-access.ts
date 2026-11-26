import { spawnSync } from 'node:child_process';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { readKeyringPassword, writeKeyringPassword } from './keyring.ts';
import { Buffer } from './node-buffer.ts';
import { normalizePlatformApiUrl, platformCredentialAccount } from './platform-registry.ts';
import { isStdoutReservedForResults } from './stdout-results.ts';

const ACCESS_KEYRING_SERVICE = 'dev.void.cli.access';
const keyringTokens = new Map<string, string | null>();

function usableToken(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' && payload.exp > Date.now() / 1000 + 60;
  } catch {
    return false;
  }
}

function readOriginCredentials(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('platform: VOID_ACCESS_CREDENTIALS must contain an origin-keyed JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function rememberOriginToken(origin: string, token: string): void {
  const raw = process.env.VOID_ACCESS_CREDENTIALS;
  process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify({
    ...(raw ? readOriginCredentials(raw) : {}),
    [origin]: { CF_ACCESS_TOKEN: token },
  });
}

function forgetOriginToken(origin: string): void {
  const raw = process.env.VOID_ACCESS_CREDENTIALS;
  if (!raw) {
    return;
  }
  const entries = { ...readOriginCredentials(raw) };
  delete entries[origin];
  process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify(entries);
}

export function isCloudflareAccessChallenge(response: Response): boolean {
  const location = response.headers.get('Location');
  if (!location || response.status < 300 || response.status >= 400) {
    return false;
  }
  try {
    const target = new URL(location);
    return (
      target.protocol === 'https:' &&
      !target.username &&
      !target.password &&
      /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(target.hostname) &&
      target.pathname.startsWith('/cdn-cgi/access/login')
    );
  } catch {
    return false;
  }
}

/** Called for a selected origin, never for a redirect destination. */
export function ensurePlatformAccessToken(
  apiUrl: string,
  challenged = false,
  required = false,
  rejectedToken?: string,
): void {
  const origin = normalizePlatformApiUrl(apiUrl);
  if (!origin.startsWith('https://')) {
    return;
  }
  const headers = cfAccessHeaders(process.env, origin);
  if (headers['CF-Access-Client-Id']) {
    return;
  }
  if (!challenged && headers['cf-access-token'] && usableToken(headers['cf-access-token'])) {
    return;
  }
  const account = platformCredentialAccount(origin);
  if (!keyringTokens.has(origin)) {
    if (keyringTokens.size >= 64) {
      const oldest = keyringTokens.keys().next();
      if (!oldest.done) {
        keyringTokens.delete(oldest.value);
      }
    }
    keyringTokens.set(origin, readKeyringPassword(ACCESS_KEYRING_SERVICE, account));
  }
  const stored = keyringTokens.get(origin);
  if (!challenged && stored && usableToken(stored)) {
    rememberOriginToken(origin, stored);
    return;
  }
  if (!challenged && !required && !stored && !headers['cf-access-token']) {
    return;
  }
  const rejectedTokens = new Set(
    [headers['cf-access-token'], stored, rejectedToken].filter(
      (token): token is string => typeof token === 'string' && token.length > 0,
    ),
  );
  if (challenged && rejectedTokens.size > 0) {
    forgetOriginToken(origin);
    keyringTokens.set(origin, null);
    if (!canSignIn()) {
      throw new Error(
        `platform: Cloudflare Access rejected the cached credential for ${origin}. Re-run this command in an interactive terminal to renew it.`,
      );
    }
    console.error(`Renew Cloudflare Access authentication for ${origin}.`);
    runCloudflaredLogin(origin);
  }
  let token = runCloudflared(['access', 'token', `-app=${origin}`]);
  if (token && rejectedTokens.has(token)) {
    token = null;
  }
  if ((!token || !usableToken(token)) && canSignIn()) {
    console.error(`Authenticate to Cloudflare Access for ${origin}.`);
    runCloudflaredLogin(origin);
    token = runCloudflared(['access', 'token', `-app=${origin}`]);
  }
  if (!token || !usableToken(token)) {
    throw new Error(
      'platform: Cloudflare Access authentication is required. Install cloudflared and sign in interactively, or set VOID_ACCESS_ORIGIN with scoped CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET credentials for CI.',
    );
  }
  rememberOriginToken(origin, token);
  keyringTokens.set(origin, token);
  // Keychain failure keeps the credential only in process memory, never in a plaintext file.
  writeKeyringPassword(ACCESS_KEYRING_SERVICE, account, token);
}

/**
 * The terminal a browser sign-in writes to: stdout, or stderr while stdout is redirected or kept
 * for a command's result (`void db execute --json | jq`). Undefined when neither is a terminal
 * it may use, or stdin is not one, so no sign-in can run.
 */
function signInOutput(): 1 | 2 | undefined {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  if (process.stdout.isTTY && !isStdoutReservedForResults()) {
    return 1;
  }
  return process.stderr.isTTY ? 2 : undefined;
}

function canSignIn(): boolean {
  return signInOutput() !== undefined;
}

/** Sign in through the browser. `--quiet` keeps the JWT off the terminal. */
function runCloudflaredLogin(origin: string): void {
  runCloudflared(['access', 'login', '--quiet', origin], {
    output: signInOutput(),
    timeoutMs: 120_000,
  });
}

function runCloudflared(
  args: Array<string>,
  opts?: { output?: 1 | 2; timeoutMs?: number },
): string | null {
  try {
    const result = spawnSync('cloudflared', args, {
      encoding: 'utf8',
      stdio: opts?.output ? ['inherit', opts.output, 'inherit'] : ['ignore', 'pipe', 'pipe'],
      timeout: opts?.timeoutMs ?? 5000,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const out = (result.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** A protected API and proxy have separate audiences and separately scoped credentials. */
export function ensurePlatformProxyAccess(apiUrl: string, proxyUrl: string): void {
  ensurePlatformAccessToken(apiUrl);
  ensurePlatformAccessToken(
    proxyUrl,
    false,
    Object.keys(cfAccessHeaders(process.env, apiUrl)).length > 0,
  );
}
