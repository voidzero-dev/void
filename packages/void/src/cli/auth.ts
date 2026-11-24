import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { browserPageLead, browserPageStatus, renderBrowserPage } from '@void/platform/browser-page';
import { join } from 'pathslash';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensurePlatformAccessToken } from './cf-access.ts';
import { deleteKeyringPassword, readKeyringPassword, writeKeyringPassword } from './keyring.ts';
import {
  getActivePlatformConnection,
  listPlatformConnections,
  normalizePlatformApiUrl,
  platformCredentialAccount,
} from './platform-registry.ts';
import { readProjectConfig, readProjectPlatformUrl } from './project.ts';

const CONFIG_DIR = join(homedir(), '.void');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const KEYRING_SERVICE = 'dev.void.cli';

function keyringGet(account: string): string | null {
  return readKeyringPassword(KEYRING_SERVICE, account);
}

function keyringSet(account: string, password: string): boolean {
  return writeKeyringPassword(KEYRING_SERVICE, account, password);
}

function keyringDelete(account: string): boolean {
  return deleteKeyringPassword(KEYRING_SERVICE, account);
}

// Legacy origin-scoped tokens, moved to the keychain when read.
type Config = {
  tokens?: Record<string, string>;
};

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function readOriginScopedToken(apiUrl: string, config: Config): string | null {
  const normalizedApiUrl = normalizePlatformApiUrl(apiUrl);
  const account = platformCredentialAccount(normalizedApiUrl);
  const keyringToken = keyringGet(account);
  if (keyringToken) {
    return keyringToken;
  }

  const fileToken = config.tokens?.[normalizedApiUrl];
  if (!fileToken) {
    return null;
  }
  if (keyringSet(account, fileToken)) {
    delete config.tokens![normalizedApiUrl];
    if (Object.keys(config.tokens!).length === 0) {
      delete config.tokens;
    }
    try {
      writeConfig(config);
    } catch {
      // Migration is best-effort; the file remains a usable fallback.
    }
  }
  return fileToken;
}

function connectedPlatform(apiUrl: string | null | undefined) {
  if (!apiUrl) {
    throw new Error('platform: No Void platform connected. Run `void connect <url>` first.');
  }
  const origin = normalizePlatformApiUrl(apiUrl);
  const connection = listPlatformConnections().find((entry) => entry.apiUrl === origin);
  if (!connection) {
    throw new Error(`platform: No connection to ${origin}. Run \`void connect ${origin}\` first.`);
  }
  return connection;
}

export function getSiteDomain(root: string = process.cwd()): string {
  const connection = connectedPlatform(getApiUrl(root));
  if (!connection.applicationDomain) {
    throw new Error(
      `platform: Missing application domain. Run \`void connect ${connection.apiUrl}\` to refresh the connection.`,
    );
  }
  return connection.applicationDomain;
}

/**
 * Read the deploy token.
 * Priority: origin-bound VOID_TOKEN > system keychain > migrated config.
 * Environment tokens must name their recipient with VOID_API_URL.
 */
export function getToken(root: string = process.cwd()): string | null {
  const envToken = process.env.VOID_TOKEN;
  let apiUrl: string;
  try {
    apiUrl = getApiUrl(root);
  } catch (error) {
    if (envToken) {
      throw error;
    }
    return null;
  }
  const config = readConfig();
  return readTokenForOrigin(apiUrl, config);
}

/** Account actions follow the selected connection, independently of application metadata. */
export function getAccountCredential(): { apiUrl: string; token: string | null } {
  const config = readConfig();
  const apiUrl = connectedPlatform(
    process.env.VOID_API_URL || getActivePlatformConnection()?.apiUrl,
  ).apiUrl;
  return {
    apiUrl,
    token: readTokenForOrigin(apiUrl, config),
  };
}

function readTokenForOrigin(apiUrl: string, config: Config): string | null {
  const envToken = process.env.VOID_TOKEN;
  if (envToken) {
    if (!process.env.VOID_API_URL) {
      throw new Error(
        'auth: Set VOID_API_URL alongside VOID_TOKEN to identify the connected platform that issued it.',
      );
    }
    const tokenOrigin = normalizePlatformApiUrl(process.env.VOID_API_URL);
    if (apiUrl !== tokenOrigin) {
      throw new Error(
        `auth: VOID_TOKEN is not bound to ${apiUrl}. Set VOID_API_URL to this platform's URL with its matching token, or unset VOID_TOKEN to use the saved login.`,
      );
    }
    return envToken;
  }
  return readOriginScopedToken(apiUrl, config);
}

export function getTokenSource(): 'ci' | 'manual' {
  return process.env.VOID_TOKEN ? 'ci' : 'manual';
}

export function readPlatformToken(apiUrl: string): string | null {
  return readOriginScopedToken(apiUrl, readConfig());
}

export function savePlatformToken(token: string, origin: string): void {
  const apiUrl = normalizePlatformApiUrl(origin);
  const account = platformCredentialAccount(apiUrl);
  if (keyringSet(account, token)) {
    return;
  }
  throw new Error(
    'auth: The system keychain is unavailable. Refusing to store your platform token in plaintext. Configure a system keychain, or set VOID_TOKEN from a secret manager in headless environments.',
  );
}

export function removeToken(root: string = process.cwd()): boolean {
  const apiUrl = getApiUrl(root);
  const account = platformCredentialAccount(apiUrl);
  let removed = false;

  if (keyringDelete(account)) {
    removed = true;
  }
  try {
    const config = readConfig();
    let configChanged = false;
    if (config.tokens?.[apiUrl]) {
      delete config.tokens[apiUrl];
      if (Object.keys(config.tokens).length === 0) {
        delete config.tokens;
      }
      configChanged = true;
      removed = true;
    }
    if (configChanged) {
      writeConfig(config);
    }
  } catch {
    // ignore
  }

  return removed;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

async function exchangeLoginCode(
  apiUrl: string,
  code: string,
  state: string,
  codeVerifier: string,
): Promise<string> {
  ensurePlatformAccessToken(apiUrl);
  const res = await fetch(`${apiUrl}/auth/cli/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cfAccessHeaders(process.env, apiUrl) },
    body: JSON.stringify({
      code,
      state,
      code_verifier: codeVerifier,
    }),
    redirect: 'manual',
  });

  if (!res.ok) {
    throw new Error(`auth: Failed to exchange login code (${res.status}). Try logging in again.`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('auth: Login code exchange returned an invalid response.');
  }

  if (
    !body ||
    typeof body !== 'object' ||
    !('token' in body) ||
    typeof body.token !== 'string' ||
    body.token.length === 0
  ) {
    throw new Error('auth: Login code exchange did not return a token.');
  }

  return body.token;
}

/** Environment and project selections must refer to a verified local connection. */
export function getApiUrl(root: string = process.cwd()): string {
  const projectApiUrl = readProjectPlatformUrl(root);
  if (readProjectConfig(root) && !projectApiUrl) {
    throw new Error(
      'platform: This project link has no platform URL. Run `void connect <url>`, then `void project link` to choose its destination.',
    );
  }
  return connectedPlatform(
    process.env.VOID_API_URL || projectApiUrl || getActivePlatformConnection()?.apiUrl,
  ).apiUrl;
}

export function getProxyUrl(root: string = process.cwd()): string {
  // The project file is repository-controlled and therefore cannot be trusted
  // to choose the origin that receives a user's platform credential. Resolve
  // the proxy from the selected API's trusted local registry entry instead.
  // VOID_PROXY_URL remains an explicit operator override for CI and recovery.
  const apiUrl = getApiUrl(root);
  if (process.env.VOID_PROXY_URL) {
    return normalizePlatformApiUrl(process.env.VOID_PROXY_URL);
  }

  const proxyUrl = listPlatformConnections().find(
    (connection) => connection.apiUrl === apiUrl,
  )?.proxyUrl;
  if (proxyUrl === null || proxyUrl === undefined) {
    throw new Error(
      `platform: No verified proxy is registered for ${apiUrl}. Reconnect with \`void connect ${apiUrl}\` or set VOID_PROXY_URL explicitly.`,
    );
  }
  return proxyUrl;
}

function page(title: string, message: string): string {
  return renderBrowserPage({
    title,
    content:
      browserPageStatus(title === 'Login failed' ? 'error' : 'success') +
      browserPageLead(title, message),
  });
}

// Launch via argv (execFile), never a shell: the URL is passed as a single
// argument so shell metacharacters in it can't be interpreted as commands.
const ignore = (): void => {};

export function openBrowser(url: string, run: typeof execFile = execFile): void {
  if (process.platform === 'win32') {
    // Avoid cmd.exe interpreting URL query separators such as & as shell commands.
    run('rundll32.exe', ['url.dll,FileProtocolHandler', url], ignore);
    return;
  }
  if (process.platform === 'darwin') {
    run('open', [url], ignore);
    return;
  }
  // Linux — including WSL2 where `xdg-open` typically has no usable handler.
  // Try `wslview` (wslu), then fall back to the Windows URL handler.
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    run('wslview', [url], (error) => {
      if (error) {
        run('rundll32.exe', ['url.dll,FileProtocolHandler', url], ignore);
      }
    });
    return;
  }
  run('xdg-open', [url], ignore);
}

/**
 * Serve `http://localhost:PORT/callback`, open the browser at the caller's
 * authorize URL, and settle with `finalize`'s result. The server closes before settling.
 */
export async function awaitBrowserCallback<T>(options: {
  /** Caller-generated; appended to the callback URL and validated on the incoming request. */
  state: string;
  /** Given `http://localhost:PORT/callback?state=…`, return the URL to open. */
  buildAuthUrl: (callback: URL) => Promise<string> | string;
  /**
   * Runs inside the request handler, so the browser sees the success page only
   * after it resolves; a throw renders the failure page and rejects.
   */
  finalize: (params: URLSearchParams) => Promise<T>;
  /** Name the completed action in the browser. Defaults to sign-in. */
  successTitle?: string;
  /** Map an `?error=…` query to a user message (return null to ignore). */
  describeError?: (params: URLSearchParams) => string | null;
  /** Return a message to answer 400 and keep listening for a valid callback, or null to accept. */
  validate?: (params: URLSearchParams) => string | null;
  /** Invoked with the authorize URL before the browser opens, for a manual fallback. */
  onUrl?: (url: string) => void;
  /** Default 5 minutes. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to `node:child_process` `execFile`. */
  execFile?: typeof execFile;
}): Promise<T> {
  const http = await import('node:http');
  const { state, buildAuthUrl, finalize, describeError, validate, onUrl } = options;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      reject(error);
    };

    const succeed = (result: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      resolve(result);
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', 'Invalid login callback. Please try again.'));
        return;
      }

      const errorMessage = describeError?.(url.searchParams);
      if (errorMessage) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', errorMessage));
        fail(new Error(errorMessage));
        return;
      }

      const invalidMessage = validate?.(url.searchParams);
      if (invalidMessage) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', invalidMessage));
        return;
      }

      // The timeout may settle while finalize is in flight.
      let result: T;
      try {
        result = await finalize(url.searchParams);
      } catch (err) {
        if (settled) {
          return;
        }
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Login failed', 'Could not complete login. Please try again.'));
        fail(err instanceof Error ? err : new Error('auth: Failed to complete login.'));
        return;
      }

      if (settled) {
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        page(
          options.successTitle ?? 'Signed in to Void',
          'You can close this tab and return to the terminal.',
        ),
      );
      succeed(result);
    });

    // Close immediately after callback — don't wait for keep-alive timeout
    server.on('connection', (socket) => socket.unref());

    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        fail(new Error('auth: Failed to start local callback server.'));
        return;
      }

      const port = addr.port;
      const callback = new URL(`http://localhost:${port}/callback`);
      callback.searchParams.set('state', state);

      let authUrl: string;
      try {
        authUrl = await buildAuthUrl(callback);
      } catch (err) {
        fail(err instanceof Error ? err : new Error('auth: Failed to build authorize URL.'));
        return;
      }

      onUrl?.(authUrl);
      openBrowser(authUrl, options.execFile);
    });

    const timeout = setTimeout(() => {
      fail(new Error('auth: Login timed out after 5 minutes. Try again.'));
    }, timeoutMs);
    timeout.unref();
  });
}

/** The CLI exchanges the code itself, so the localhost callback never accepts bearer tokens. */
export async function runPlatformLogin(
  origin: string,
  provider = 'github',
  onUrl?: (url: string) => void,
): Promise<string> {
  const apiUrl = normalizePlatformApiUrl(origin);
  const state = randomBytes(32).toString('hex');
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  return awaitBrowserCallback<string>({
    state,
    onUrl,
    buildAuthUrl: (callback) => {
      const loginUrl = new URL(`${apiUrl}/auth/login`);
      loginUrl.searchParams.set('redirect', callback.href);
      loginUrl.searchParams.set('provider', provider);
      loginUrl.searchParams.set('code_challenge', codeChallenge);
      loginUrl.searchParams.set('code_challenge_method', 'S256');
      return loginUrl.href;
    },
    describeError: (p) =>
      p.get('error') === 'signup_restricted'
        ? 'Signup restricted: your email is not on the approved list for this environment.'
        : null,
    validate: (p) => {
      if (p.has('token')) {
        return 'Invalid login callback. Please try again.';
      }
      if (!p.get('code')) {
        return 'No authorization code received. Please try again.';
      }
      return null;
    },
    finalize: (params) => exchangeLoginCode(apiUrl, params.get('code')!, state, codeVerifier),
  });
}
