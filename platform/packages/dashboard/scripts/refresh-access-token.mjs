import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_FILE = join(process.cwd(), '.env');

function parseDotenv(contents) {
  const out = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isStagingApi(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.endsWith('.staging.void.cloud') || hostname.endsWith('.staging.void.app');
  } catch {
    return false;
  }
}

function tokenExpiry(token) {
  const [, payload] = token.split('.');
  if (!payload) {
    return null;
  }

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

function isUsableToken(token) {
  const exp = tokenExpiry(token);
  return exp !== null && exp > Math.floor(Date.now() / 1000) + 60;
}

function runCloudflared(args, options = {}) {
  const result = spawnSync('cloudflared', args, {
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 5000,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const out = result.stdout?.trim();
  return out ? out : null;
}

function removeDevVar(contents, key) {
  return contents.replaceAll(new RegExp(`^[\\t ]*${key}[\\t ]*=.*(?:\\r?\\n|$)`, 'gm'), '');
}

function setDevVar(contents, key, value) {
  const escaped = value.replaceAll('\\', String.raw`\\`).replaceAll('"', '\\\"');
  const line = `${key}="${escaped}"`;
  return `${removeDevVar(contents, key).replace(/\s*$/, '')}\n${line}\n`;
}

function writeEnvFile(contents) {
  writeFileSync(ENV_FILE, contents, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

const devVarsContents = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
const devVars = parseDotenv(devVarsContents);
const apiUrl = process.env.API_URL ?? devVars.API_URL;
// A persisted token belongs only to the API origin for which cloudflared
// returned it. Discard stale/unattributed file credentials before even the
// unprotected-host early exit: the dashboard reads this file after we finish.
let selectedOrigin;
try {
  selectedOrigin = new URL(apiUrl).origin;
} catch {
  selectedOrigin = null;
}
if (devVars.CF_ACCESS_TOKEN && devVars.CF_ACCESS_TOKEN_ORIGIN !== selectedOrigin) {
  writeEnvFile(
    removeDevVar(removeDevVar(devVarsContents, 'CF_ACCESS_TOKEN'), 'CF_ACCESS_TOKEN_ORIGIN'),
  );
  delete devVars.CF_ACCESS_TOKEN;
  delete devVars.CF_ACCESS_TOKEN_ORIGIN;
}

// Explicit opt-in for self-hosted APIs protected by Cloudflare Access. Keep
// the established Void Cloud staging behavior for existing local checkouts.
const accessAppUrl = process.env.CF_ACCESS_APP_URL ?? devVars.CF_ACCESS_APP_URL;

if (!apiUrl || (!accessAppUrl && !isStagingApi(apiUrl))) {
  process.exit(0);
}

let app;
try {
  const api = new URL(apiUrl);
  const accessApp = new URL(accessAppUrl || apiUrl);
  if (
    api.protocol !== 'https:' ||
    accessApp.protocol !== 'https:' ||
    api.username ||
    api.password ||
    api.pathname !== '/' ||
    api.search ||
    api.hash ||
    accessApp.username ||
    accessApp.password ||
    api.origin !== accessApp.origin ||
    accessApp.pathname !== '/' ||
    accessApp.search ||
    accessApp.hash
  ) {
    throw new Error('Access application must be the HTTPS origin of API_URL.');
  }
  app = api.origin;
} catch {
  console.error('[dashboard] CF_ACCESS_APP_URL must be the HTTPS origin of API_URL.');
  process.exit(1);
}

const accessClientId = process.env.CF_ACCESS_CLIENT_ID ?? devVars.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET ?? devVars.CF_ACCESS_CLIENT_SECRET;
if (accessClientId && accessClientSecret) {
  process.exit(0);
}

if (process.env.CF_ACCESS_TOKEN && isUsableToken(process.env.CF_ACCESS_TOKEN)) {
  process.exit(0);
}

if (
  devVars.CF_ACCESS_TOKEN &&
  devVars.CF_ACCESS_TOKEN_ORIGIN === app &&
  isUsableToken(devVars.CF_ACCESS_TOKEN)
) {
  process.exit(0);
}

let token = runCloudflared(['access', 'token', `-app=${app}`]);

if (!token && process.stdin.isTTY && process.stdout.isTTY) {
  console.log(`[dashboard] Cloudflare Access token for ${app} is missing or expired.`);
  runCloudflared(['access', 'login', app], { inherit: true, timeoutMs: 120_000 });
  token = runCloudflared(['access', 'token', `-app=${app}`]);
}

if (!token || !isUsableToken(token)) {
  console.warn(
    `[dashboard] Could not refresh Cloudflare Access token for ${app}. Run: cloudflared access login ${app}`,
  );
  process.exit(1);
}

const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
writeEnvFile(
  setDevVar(setDevVar(current, 'CF_ACCESS_TOKEN', token), 'CF_ACCESS_TOKEN_ORIGIN', app),
);
console.log(`[dashboard] Refreshed Cloudflare Access token for ${app}.`);
