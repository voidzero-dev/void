#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setGlobalProxyFromEnv } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
/**
 * Execute typed Cloudflare operations using the pinned provider CLI and API.
 * Secret values arrive on stdin; captured results use one structured envelope.
 */
import type {
  CloudflareCommandResult as Result,
  CloudflareOperation,
} from '@void/deploy-cloudflare';
import { parse } from 'jsonc-parser';
import { dirname, join, resolve } from 'pathslash';
import {
  CF_VERSION_SOURCE_MAX_OUTPUT_BYTES,
  isD1Bookmark,
  readCfUploadOutput,
  safePositional,
} from './cf-command-values.ts';
import { persistCfKeyringPreference, readCfSessionCredential } from './cf-session.ts';
import { getCfCliVersion, getVoidUserAgent } from './cf-user-agent.ts';
import { publishCloudflareObservability } from './cf-worker-settings.ts';
import {
  cloudflareDeviceCode,
  cloudflareVerificationUrl,
  printCloudflareLoginLink,
  printCloudflareLoginPrompt,
} from './cloudflare-login-output.ts';
import { platformWorkerUploadAttribution } from './platform-worker-user-agent.ts';
import { sanitizeTerminalLogText } from './terminal-log-text.ts';

type Json = Record<string, unknown>;

const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
const operation = (() => {
  try {
    return JSON.parse(process.argv[2] ?? 'null');
  } catch {
    return null;
  }
})() as CloudflareOperation;
// This dedicated transport process uses the same OAuth store for login,
// deployment, and ancillary API calls. API-token overrides still win.
process.env.CLOUDFLARE_AUTH_USE_KEYRING ??= 'true';
// Proxy configuration is scoped to this disposable transport process.
if (hasProxyEnvironment(process.env)) {
  setGlobalProxyFromEnv();
}

function hasProxyEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy);
}

function apiBaseUrl(): string {
  return (process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4').replace(
    /\/$/,
    '',
  );
}

function cfEnvironment(): NodeJS.ProcessEnv {
  // The pinned bin otherwise delegates to any cf installed by the project.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CF_DELEGATION: '1',
    CLI_VERSION: getCfCliVersion(
      operation.type === 'versions.upload' || operation.type === 'worker.deploy'
        ? platformWorkerUploadAttribution(config())
        : undefined,
    ),
    CF_SEND_TELEMETRY: 'false',
    CF_NO_OSC_PROGRESS: '1',
    CLOUDFLARE_AUTH_USE_KEYRING: process.env.CLOUDFLARE_AUTH_USE_KEYRING,
  };
  // cf uses Node's built-in fetch for API operations. Node does not consult
  // HTTP(S)_PROXY for fetch unless its environment proxy support is enabled.
  // Match the proxy handling of our direct API reads below.
  if (hasProxyEnvironment(env)) {
    env.NODE_USE_ENV_PROXY = '1';
  }
  for (const [canonical, alias] of [
    ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'],
    ['CLOUDFLARE_API_KEY', 'CF_API_KEY'],
    ['CLOUDFLARE_EMAIL', 'CF_EMAIL'],
    ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'],
  ]) {
    if (!env[canonical] && env[alias]) {
      env[canonical] = env[alias];
    }
  }
  return env;
}

function result(status: number, stdout = '', stderr = '', data?: unknown): Result {
  const code = /\[(?:code:\s*)?(\d{4,})\]/.exec(stderr);
  const errorCode = code ? Number(code[1]) : undefined;
  return {
    status,
    stdout,
    stderr,
    ...(data !== undefined ? { data } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...([10006, 10007, 10090].includes(errorCode ?? 0) ? { failure: 'not-found' as const } : {}),
  };
}

function runCf(
  command: Array<string>,
  cwd = process.cwd(),
  bounds?: { timeoutMs: number; maxOutputBytes: number },
  interactive = false,
): Result {
  const env = cfEnvironment();
  env.CF_QUIET = '1';
  const child = spawnSync(process.execPath, [cf, ...command], {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: bounds?.maxOutputBytes ?? 32 * 1024 * 1024,
    ...(bounds ? { timeout: bounds.timeoutMs } : {}),
    // An interactive command shares this process's terminal, so cf can ask there.
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [
    child.stderr || '',
    child.error?.message || '',
    child.signal ? `Cloudflare CLI terminated by ${child.signal}.` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .replace(/\[(\d{4,})\]/g, '[code: $1]');
  if (child.signal || child.error || child.status === null) {
    return {
      status: 1,
      stdout: '',
      stderr,
      signal: child.signal,
      error:
        child.error?.message ??
        (child.signal ? undefined : 'Cloudflare CLI did not report an exit status.'),
    };
  }
  return result(child.status, child.stdout ?? '', stderr);
}

function runInteractiveCf(command: Array<string>): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cf, ...command, '--quiet'], {
      cwd: process.cwd(),
      env: { ...cfEnvironment(), CF_QUIET: '1' },
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let announced = false;
    let announcedLink = false;
    let settled = false;
    const finish = (value: Result) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32_768);
      if (!announced) {
        const code = cloudflareDeviceCode(output);
        if (code) {
          announced = true;
          printCloudflareLoginPrompt(code);
        }
      }
      if (!announcedLink) {
        const url = cloudflareVerificationUrl(output);
        if (url) {
          announcedLink = true;
          printCloudflareLoginLink(url);
        }
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => finish(result(1, '', error.message)));
    child.once('close', (status, signal) => {
      if (status === 0) {
        if (!announced) {
          printCloudflareLoginPrompt(null);
        }
        finish(result(0));
      } else {
        finish(
          result(
            status ?? 1,
            '',
            output.trim() || `Cloudflare login ended${signal ? ` (${signal})` : ''}.`,
          ),
        );
      }
    });
  });
}

async function withBuildOutput(
  raw: Json,
  sourceMain: string | null,
  action: (directory: string) => Result,
): Promise<Result> {
  const scratch = mkdtempSync(join(tmpdir(), 'void-cf-command-'));
  try {
    const main = 'index.js';
    if (sourceMain) {
      copyFileSync(sourceMain, join(scratch, main));
    } else {
      const { VOID_SECRET_DRAFT_SOURCE } = await import('@void/deploy-cloudflare');
      writeFileSync(join(scratch, main), VOID_SECRET_DRAFT_SOURCE);
    }
    writeFileSync(
      join(scratch, 'wrangler.json'),
      JSON.stringify({ ...raw, main, compatibility_date: raw.compatibility_date ?? '2025-01-01' }),
      { mode: 0o600 },
    );
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? raw.account_id;
    if (typeof accountId !== 'string' || !accountId) {
      throw new Error('Cloudflare account is not pinned for Worker deployment.');
    }
    const { prepareCfBuildOutput } = await import('./cf-build-output.ts');
    const output = await prepareCfBuildOutput(scratch, accountId);
    if (!output) {
      throw new Error('Could not prepare the Cloudflare Worker build output.');
    }
    try {
      await assertExistingProvisionableResources(output.directory, accountId);
      return action(output.directory);
    } finally {
      await output.dispose();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parsedJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloudflare returned an unexpected response.');
  }
  return value as Json;
}

function configPath(): string | undefined {
  return 'configPath' in operation ? operation.configPath : undefined;
}
function config(): Json {
  const path = configPath();
  if (!path) {
    throw new Error('Cloudflare config path is required for this operation.');
  }
  return object(parse(readFileSync(path, 'utf8')));
}
function workerName(): string {
  const name = ('workerName' in operation ? operation.workerName : undefined) ?? config().name;
  if (typeof name !== 'string' || !name) {
    throw new Error('Cloudflare Worker name is missing from the generated config.');
  }
  return name;
}

function updateBinding(section: string, binding: string, values: Json): void {
  const path = configPath();
  if (!path || !binding) {
    throw new Error('Cloudflare resource binding and config are required.');
  }
  const current = config();
  const previous = Array.isArray(current[section]) ? current[section] : [];
  const existing = previous.map(object).find((entry) => entry.binding === binding);
  current[section] = [
    ...previous.filter((entry) => object(entry).binding !== binding),
    { ...existing, binding, ...values },
  ];
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}

function d1Database(token: string): { id: string; dir: string; table: string; pattern?: string } {
  const entries = config().d1_databases;
  if (!Array.isArray(entries)) {
    throw new Error('D1 database binding is unavailable.');
  }
  const selected = entries
    .map(object)
    .find(
      (entry) =>
        entry.database_id === token || entry.database_name === token || entry.binding === token,
    );
  if (!selected || typeof selected.database_id !== 'string') {
    throw new Error('D1 database binding is unavailable.');
  }
  return {
    id: selected.database_id,
    dir: typeof selected.migrations_dir === 'string' ? selected.migrations_dir : './migrations',
    ...(typeof selected.migrations_pattern === 'string'
      ? { pattern: selected.migrations_pattern }
      : {}),
    table:
      typeof selected.migrations_table === 'string' ? selected.migrations_table : 'd1_migrations',
  };
}

function previousD1Bookmark(stdout: string): string | undefined {
  try {
    const previous = object(parsedJson(stdout)).previous_bookmark;
    return isD1Bookmark(previous) ? previous : undefined;
  } catch {
    return undefined;
  }
}

function cleanJson(command: Array<string>, transform?: (value: unknown) => unknown): Result {
  const called = runCf(command);
  if (called.status !== 0 || !transform) {
    return called;
  }
  return result(0, `${JSON.stringify(transform(parsedJson(called.stdout)))}\n`, called.stderr);
}

function accountId(): string {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? config().account_id;
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('Cloudflare account is not pinned for API inspection.');
  }
  return accountId;
}

async function cloudflareApiGet(
  path: string,
  failure: string,
  extraHeaders: Record<string, string> = {},
): Promise<Json> {
  const url = `${apiBaseUrl()}${path}`;
  const response = await fetch(url, {
    headers: { ...(await apiHeaders()), ...extraHeaders },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const body = object(await response.json());
  if (!response.ok || body.success !== true) {
    throw new Error(`${failure} (HTTP ${response.status})`);
  }
  return body;
}

async function clearWorkerCronSchedules(worker: string): Promise<Result> {
  const endpoint = `${apiBaseUrl()}/accounts/${encodeURIComponent(accountId())}/workers/scripts/${encodeURIComponent(worker)}/schedules`;
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { ...(await apiHeaders()), 'Content-Type': 'application/json' },
    body: '[]',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const body = object(await response.json());
  const schedules = object(body.result).schedules;
  if (
    !response.ok ||
    body.success !== true ||
    !Array.isArray(schedules) ||
    schedules.length !== 0
  ) {
    throw new Error(`Cloudflare did not clear the Worker Cron Triggers (HTTP ${response.status}).`);
  }
  return result(0);
}

async function clearWorkerCustomDomains(worker: string): Promise<Result> {
  const endpoint = `${apiBaseUrl()}/accounts/${encodeURIComponent(accountId())}/workers/scripts/${encodeURIComponent(worker)}/domains/records`;
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { ...(await apiHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      override_scope: true,
      override_existing_origin: false,
      override_existing_dns_record: false,
      origins: [],
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare rejected the empty custom-domain set (HTTP ${response.status}).`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Cloudflare returned HTTP ${response.status} with a non-JSON custom-domain response.`,
    );
  }
  if (object(body).success !== true) {
    throw new Error(`Cloudflare rejected the empty custom-domain set (HTTP ${response.status}).`);
  }
  return result(0);
}

async function assertExistingProvisionableResources(
  directory: string,
  account: string,
): Promise<void> {
  // cf 1.0.0-beta.5 turns on Wrangler's automatic provisioning for every
  // prebuilt upload, with no exposed flag to turn it off. A named R2 bucket,
  // Queue, or dispatch namespace may otherwise be created during an upload.
  const { readBuildOutput } = await import('@cloudflare/build-output-utils');
  const built = await readBuildOutput(directory);
  const bindings = built.workers.default.config.env ?? {};
  const queueNames = new Set<string>();
  const accountPath = `/accounts/${encodeURIComponent(account)}`;
  for (const [bindingName, value] of Object.entries(bindings)) {
    const binding = object(value);
    const identifier = (key: string): string => {
      const id = binding[key];
      if (typeof id !== 'string' || !id) {
        throw new Error(
          `Cloudflare binding ${bindingName} has no ${key}; refusing automatic provisioning.`,
        );
      }
      return id;
    };
    if (binding.type === 'kv' || binding.type === 'd1') {
      identifier('id');
    } else if (binding.type === 'r2') {
      const name = identifier('name');
      const jurisdiction = binding.jurisdiction;
      if (jurisdiction !== undefined && typeof jurisdiction !== 'string') {
        throw new Error(`Cloudflare R2 binding ${bindingName} has an invalid jurisdiction.`);
      }
      await cloudflareApiGet(
        `${accountPath}/r2/buckets/${encodeURIComponent(name)}`,
        `Cloudflare R2 bucket ${name} is unavailable; refusing automatic provisioning.`,
        jurisdiction ? { 'cf-r2-jurisdiction': jurisdiction } : {},
      );
    } else if (binding.type === 'queue') {
      queueNames.add(identifier('name'));
    } else if (binding.type === 'dispatch-namespace') {
      const name = identifier('namespace');
      await cloudflareApiGet(
        `${accountPath}/workers/dispatch/namespaces/${encodeURIComponent(name)}`,
        `Cloudflare dispatch namespace ${name} is unavailable; refusing automatic provisioning.`,
      );
    } else if (binding.type === 'ai-search-namespace') {
      const name = identifier('namespace');
      await cloudflareApiGet(
        `${accountPath}/ai-search/namespaces/${encodeURIComponent(name)}`,
        `Cloudflare AI Search namespace ${name} is unavailable; refusing automatic provisioning.`,
      );
    } else if (binding.type === 'agent-memory') {
      const name = identifier('namespace');
      await cloudflareApiGet(
        `${accountPath}/agent-memory/namespaces/${encodeURIComponent(name)}`,
        `Cloudflare Agent Memory namespace ${name} is unavailable; refusing automatic provisioning.`,
      );
    } else if (binding.type === 'flagship') {
      identifier('id');
    }
  }
  if (queueNames.size > 0) {
    const existing = new Set((await readAllQueues()).map((queue) => queue.queue_name));
    for (const name of queueNames) {
      if (!existing.has(name)) {
        throw new Error(
          `Cloudflare Queue ${name} is unavailable; refusing automatic provisioning.`,
        );
      }
    }
  }
}

async function readVersionResources(worker: string, versionId: string): Promise<Json> {
  const body = await cloudflareApiGet(
    `/accounts/${encodeURIComponent(accountId())}/workers/scripts/${encodeURIComponent(worker)}/versions/${encodeURIComponent(versionId)}`,
    'Cloudflare did not return Worker version resources.',
  );
  const resources = object(object(body.result).resources);
  if (!Array.isArray(resources.bindings) || !resources.script || !resources.script_runtime) {
    throw new Error('Cloudflare Worker version resources were incomplete.');
  }
  return resources;
}

let cachedApiHeaders: Promise<Record<string, string>> | undefined;

/** This process runs one operation, so the credential is read once. */
function apiHeaders(): Promise<Record<string, string>> {
  cachedApiHeaders ??= readApiHeaders();
  return cachedApiHeaders;
}

async function readApiHeaders(): Promise<Record<string, string>> {
  const key = process.env.CLOUDFLARE_API_KEY ?? process.env.CF_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL ?? process.env.CF_EMAIL;
  if (key && email) {
    return { 'User-Agent': getVoidUserAgent(), 'X-Auth-Key': key, 'X-Auth-Email': email };
  }
  const credential = await sessionCredential();
  if (!credential) {
    throw new Error('Cloudflare session bearer is unavailable.');
  }
  return { 'User-Agent': getVoidUserAgent(), Authorization: `Bearer ${credential.token}` };
}

async function withSecretFile(
  content: string,
  action: (path: string) => Result | Promise<Result>,
): Promise<Result> {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-secret-'));
  try {
    const path = join(directory, 'body.json');
    writeFileSync(path, content, { mode: 0o600 });
    return await action(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function sessionCredential(): Promise<{ type: 'oauth' | 'api_token'; token: string } | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (token) {
    return { type: 'api_token', token };
  }
  const identity = runCf(['auth', 'whoami']);
  if (identity.status !== 0) {
    return null;
  }
  const state = object(parsedJson(identity.stdout));
  if (state.authenticated !== true || state.tokenValid !== true) {
    return null;
  }
  const credential = readCfSessionCredential(process.cwd(), state);
  return credential ? { type: 'oauth', token: credential } : null;
}

async function auth(): Promise<Result> {
  if (operation.type === 'auth.login') {
    const loggedIn = await runInteractiveCf(['auth', 'login', '--force']);
    if (loggedIn.status === 0) {
      persistCfKeyringPreference(process.cwd());
    }
    return loggedIn;
  }
  if (operation.type === 'auth.logout') {
    return runCf(['auth', 'logout']);
  }
  if (operation.type === 'auth.whoami') {
    const called = runCf(['auth', 'whoami']);
    if (called.status !== 0) {
      return called;
    }
    const identity = object(parsedJson(called.stdout));
    if (identity.authenticated !== true || identity.tokenValid !== true) {
      return result(1, '', 'Cloudflare authentication is required.', { loggedIn: false });
    }
    if (String(identity.authSource).startsWith('OAuth token from ')) {
      persistCfKeyringPreference(process.cwd());
    }
    return result(0, '', called.stderr, {
      loggedIn: true,
      accounts: identity.accounts,
      email: identity.email,
      tokenPermissions: identity.scopes,
      authType:
        process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY
          ? 'Global API Key'
          : String(identity.authSource).startsWith('OAuth token')
            ? 'OAuth Token'
            : 'API Token',
    });
  }
  if (operation.type !== 'auth.token') {
    throw new Error('Unsupported Cloudflare authentication operation.');
  }
  const credential = await sessionCredential();
  return credential
    ? result(0, '', '', credential)
    : result(1, '', 'Cloudflare session has no OAuth bearer.');
}

function listAllResourcePages(command: Array<string>, extraFlags: Array<string> = []): Result {
  const pageSize = 100;
  const entries: Array<unknown> = [];
  for (let page = 1; page <= 100; page++) {
    const listed = runCf([
      ...command,
      '--page',
      String(page),
      '--per-page',
      String(pageSize),
      ...extraFlags,
    ]);
    if (listed.status !== 0) {
      return listed;
    }
    const items = parsedJson(listed.stdout);
    if (!Array.isArray(items) || items.length > pageSize) {
      throw new Error(`Cloudflare returned an invalid ${command.join(' ')} page.`);
    }
    entries.push(...items);
    if (items.length < pageSize) {
      return result(0, `${JSON.stringify(entries)}\n`);
    }
  }
  throw new Error(`Cloudflare ${command.join(' ')} exceeded the supported page limit.`);
}

/**
 * Each consumer's Worker script name, or null for one that is not a Worker (HTTP pull).
 * Undefined when the list is incomplete or unreadable; only queue naming needs it.
 */
function queueConsumerWorkers(queue: Json): Array<string | null> | undefined {
  const consumers = queue.consumers;
  if (
    !Array.isArray(consumers) ||
    (queue.consumers_total_count !== undefined && queue.consumers_total_count !== consumers.length)
  ) {
    return undefined;
  }
  const workers: Array<string | null> = [];
  for (const entry of consumers) {
    const consumer = object(entry);
    const { script_name: scriptName, script } = consumer;
    // The same identity rules as consumer removal: any doubt leaves the list unread.
    if (
      (scriptName !== undefined && (typeof scriptName !== 'string' || !scriptName)) ||
      (script !== undefined && (typeof script !== 'string' || !script)) ||
      (scriptName !== undefined && script !== undefined && scriptName !== script)
    ) {
      return undefined;
    }
    const name = scriptName ?? script;
    if (typeof name === 'string' && (consumer.type === undefined || consumer.type === 'worker')) {
      workers.push(name);
    } else if (name === undefined && consumer.type === 'http_pull') {
      workers.push(null);
    } else {
      return undefined;
    }
  }
  return workers;
}

async function readAllQueues(): Promise<Array<Json>> {
  // cf queues list has no page option, so read the API's paginated response directly.
  const queues: Array<Json> = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 1000; page++) {
    const body = await cloudflareApiGet(
      `/accounts/${encodeURIComponent(accountId())}/queues?page=${page}`,
      'Cloudflare did not return the Queue list.',
    );
    const entries = body.result;
    const info = object(body.result_info);
    if (
      !Array.isArray(entries) ||
      !Number.isSafeInteger(info.page) ||
      info.page !== page ||
      !Number.isSafeInteger(info.total_pages) ||
      (info.total_pages as number) < 0 ||
      (info.total_pages as number) > 1000
    ) {
      throw new Error('Cloudflare returned incomplete Queue pagination.');
    }
    for (const entry of entries) {
      const queue = object(entry);
      if (
        typeof queue.queue_id !== 'string' ||
        typeof queue.queue_name !== 'string' ||
        seen.has(queue.queue_id)
      ) {
        throw new Error('Cloudflare returned an invalid Queue list.');
      }
      seen.add(queue.queue_id);
      queues.push(queue);
    }
    if (page >= (info.total_pages as number)) {
      return queues;
    }
  }
  throw new Error('Cloudflare Queue list exceeded the supported page limit.');
}

async function resources(): Promise<Result> {
  switch (operation.type) {
    case 'd1.execute': {
      const database = d1Database(operation.database);
      // One argv item, so cf cannot read SQL that starts with "-" (such as a comment) as a flag.
      return runCf(['d1', 'query', database.id, `--sql=${operation.sql}`]);
    }
    case 'd1.migrations.list':
    case 'd1.migrations.apply': {
      const database = d1Database(operation.database);
      const verb = operation.type === 'd1.migrations.list' ? 'list' : 'apply';
      const called = runCf([
        'd1',
        'migrations',
        verb,
        database.id,
        '--dir',
        database.dir,
        ...(database.pattern ? ['--pattern', database.pattern] : []),
        '--table',
        database.table,
      ]);
      if (called.status !== 0 || verb !== 'list') {
        return called;
      }
      const pending = parsedJson(called.stdout);
      if (
        !Array.isArray(pending) ||
        pending.some((item) => typeof object(item).Name !== 'string')
      ) {
        throw new Error('D1 migration list was malformed.');
      }
      return result(0, '', called.stderr, { pending: pending.map((item) => object(item).Name) });
    }
    case 'd1.time-travel.bookmark': {
      const database = d1Database(operation.database);
      const called = runCf(['d1', 'time-travel', 'get-bookmark', database.id]);
      if (called.status !== 0) {
        return called;
      }
      const bookmark = object(parsedJson(called.stdout)).bookmark;
      if (!isD1Bookmark(bookmark)) {
        throw new Error('D1 Time Travel bookmark was malformed.');
      }
      return result(0, '', called.stderr, { bookmark });
    }
    case 'd1.time-travel.restore': {
      const database = d1Database(operation.database);
      if ('bookmark' in operation.target && !isD1Bookmark(operation.target.bookmark)) {
        throw new Error('D1 Time Travel bookmark was malformed.');
      }
      // One argv item each, so cf cannot read the value as a flag.
      const target =
        'bookmark' in operation.target
          ? `--bookmark=${operation.target.bookmark}`
          : `--timestamp=${operation.target.timestamp}`;
      // Void asks before it restores. cf cannot ask in this non-interactive child, so it would
      // refuse without --force.
      const called = runCf(['d1', 'time-travel', 'restore', database.id, target, '--force']);
      if (called.status !== 0) {
        return called;
      }
      // The database is restored now, so a response without the previous bookmark is not a failure.
      return result(0, '', called.stderr, { previousBookmark: previousD1Bookmark(called.stdout) });
    }
    case 'containers.list':
      return runCf(['containers', 'applications', 'list']);
    case 'd1.list':
      return listAllResourcePages(['d1', 'list']);
    case 'd1.info': {
      const listed = listAllResourcePages(['d1', 'list']);
      if (listed.status !== 0) {
        return listed;
      }
      const list = parsedJson(listed.stdout);
      if (!Array.isArray(list)) {
        throw new Error('D1 list was malformed.');
      }
      const value = list.find((item) => object(item).name === operation.name);
      return value === undefined
        ? { ...result(1, '', 'D1 database does not exist.'), failure: 'not-found' }
        : result(0, '', '', value);
    }
    case 'd1.create': {
      const created = runCf(['d1', 'create', '--name', operation.name]);
      if (created.status !== 0) {
        return created;
      }
      const database = object(parsedJson(created.stdout));
      if (typeof database.uuid !== 'string') {
        throw new Error('D1 creation returned no database ID.');
      }
      updateBinding('d1_databases', operation.binding, {
        database_name: operation.name,
        database_id: database.uuid,
      });
      return created;
    }
    case 'kv.namespace.list':
      return listAllResourcePages(
        ['kv', 'namespaces', 'list'],
        ['--order', 'id', '--direction', 'asc'],
      );
    case 'kv.namespace.create': {
      const created = runCf(['kv', 'namespaces', 'create', '--title', operation.name]);
      if (created.status !== 0) {
        return created;
      }
      const namespace = object(parsedJson(created.stdout));
      if (typeof namespace.id !== 'string') {
        throw new Error('KV creation returned no namespace ID.');
      }
      updateBinding('kv_namespaces', operation.binding, { id: namespace.id });
      return created;
    }
    case 'r2.bucket.info':
      return runCf(['r2', 'buckets', 'get', operation.name]);
    case 'r2.bucket.create': {
      const created = runCf(['r2', 'buckets', 'create', '--name', operation.name]);
      if (created.status === 0) {
        updateBinding('r2_buckets', operation.binding, { bucket_name: operation.name });
      }
      return created;
    }
    case 'hyperdrive.create': {
      const url = new URL(readFileSync(0, 'utf8'));
      const name = operation.name;
      const created = await withSecretFile(
        JSON.stringify({
          name,
          origin: {
            host: url.hostname,
            port: Number(url.port || (url.protocol.startsWith('mysql') ? 3306 : 5432)),
            database: decodeURIComponent(url.pathname.replace(/^\//, '')),
            scheme: url.protocol.replace(':', ''),
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
          },
        }),
        (path) => runCf(['hyperdrive', 'create', '--body', '@' + path]),
      );
      if (created.status !== 0) {
        return { ...created, stdout: '', stderr: 'Hyperdrive creation failed.' };
      }
      const hyperdrive = object(parsedJson(created.stdout));
      if (typeof hyperdrive.id !== 'string') {
        throw new Error('Hyperdrive creation returned no ID.');
      }
      updateBinding('hyperdrive', operation.binding, { id: hyperdrive.id });
      return result(0, '', '', { id: hyperdrive.id, name });
    }
    case 'queues.create':
      return runCf(['queues', 'create', '--queue-name', operation.name]);
    case 'queues.info': {
      const queue = (await readAllQueues()).find((item) => item.queue_name === operation.name);
      const consumers = queue && queueConsumerWorkers(queue);
      return queue
        ? result(0, '', '', {
            id: queue.queue_id,
            name: queue.queue_name,
            ...(consumers ? { consumers } : {}),
          })
        : { ...result(1, '', 'Cloudflare Queue does not exist.'), failure: 'not-found' };
    }
    default:
      throw new Error('Unsupported Cloudflare resource operation.');
  }
}

function emailZone(domain: string): string {
  const labels = domain.split('.');
  for (let offset = 0; offset <= labels.length - 2; offset++) {
    const candidate = labels.slice(offset).join('.');
    const read = runCf(['email-routing', 'settings', 'get', '--zone', candidate]);
    if (read.status === 0) {
      return candidate;
    }
    if (read.signal || read.error || !/Zone not found:/.test(read.stderr)) {
      throw new Error('Cloudflare could not resolve the Email zone.');
    }
  }
  throw new Error(`Cloudflare Email zone for ${domain} was not found.`);
}

function email(): Result {
  if (!('domain' in operation)) {
    throw new Error('Cloudflare Email domain is missing.');
  }
  const domain = operation.domain;
  switch (operation.type) {
    case 'email.routing.settings': {
      const read = runCf(['email-routing', 'settings', 'get', '--zone', domain]);
      return read.status !== 0 && !read.signal && !read.error && /Zone not found:/.test(read.stderr)
        ? result(0, '', '', null)
        : read;
    }
    case 'email.routing.enable':
      return runCf(['email-routing', 'enable', '--zone', domain, '--name', domain]);
    case 'email.routing.rules.list':
      return listAllResourcePages(['email-routing', 'rules', 'list-account'], ['--zone', domain]);
    case 'email.sending.settings': {
      const listed = runCf(['email-sending', 'subdomains', 'list', '--zone', emailZone(domain)]);
      if (listed.status !== 0) {
        return listed;
      }
      const values = parsedJson(listed.stdout);
      if (!Array.isArray(values)) {
        throw new Error('Email Sending subdomains were malformed.');
      }
      return result(0, '', '', values.map(object).find((item) => item.name === domain) ?? null);
    }
    case 'email.sending.enable':
      return runCf([
        'email-sending',
        'subdomains',
        'create',
        '--zone',
        emailZone(domain),
        '--name',
        domain,
      ]);
    default:
      throw new Error('Unsupported Cloudflare Email operation.');
  }
}

async function secrets(): Promise<Result> {
  const worker = workerName();
  const apply = async (action: () => Result): Promise<Result> => {
    const first = action();
    if (first.status === 0 || first.errorCode !== 10007) {
      return first;
    }
    const raw = {
      name: worker,
      account_id: process.env.CLOUDFLARE_ACCOUNT_ID ?? config().account_id,
      compatibility_date: config().compatibility_date ?? '2025-01-01',
      workers_dev: false,
      preview_urls: false,
    };
    const draft = await withBuildOutput(raw, null, (directory) =>
      runCf(['deploy', '--prebuilt', '--message', 'void:secret-draft'], directory),
    );
    return draft.status === 0 ? action() : draft;
  };
  switch (operation.type) {
    case 'secret.list':
      return runCf(['workers', 'secrets', 'list', '--worker', worker]);
    case 'secret.put': {
      const value = readFileSync(0, 'utf8').replace(/\n$/, '');
      const name = operation.name;
      return withSecretFile(JSON.stringify({ name, text: value, type: 'secret_text' }), (path) =>
        apply(() =>
          runCf(['workers', 'secrets', 'update', name, '--worker', worker, '--body', '@' + path]),
        ),
      );
    }
    case 'secret.bulk': {
      const values = object(parsedJson(readFileSync(0, 'utf8')));
      const patch = Object.fromEntries(
        Object.entries(values).map(([name, text]) => [name, { type: 'secret_text', text }]),
      );
      return withSecretFile(JSON.stringify(patch), (path) =>
        apply(() => runCf(['workers', 'secrets', 'bulk', '--worker', worker, '--file', path])),
      );
    }
    case 'secret.delete':
      return runCf(['workers', 'secrets', 'delete', operation.name, '--worker', worker, '--force']);
    default:
      throw new Error('Unsupported Cloudflare secret operation.');
  }
}

async function workerHistory(): Promise<Result> {
  const worker = workerName();
  switch (operation.type) {
    case 'deployments.status':
    case 'deployments.list': {
      const called = runCf(['workers', 'deployments', 'list', '--worker', worker]);
      if (called.status !== 0) {
        return called;
      }
      const deployments = object(parsedJson(called.stdout)).deployments;
      if (!Array.isArray(deployments)) {
        throw new Error('Worker deployments were malformed.');
      }
      return operation.type === 'deployments.list'
        ? result(0, '', called.stderr, deployments)
        : deployments[0]
          ? result(0, '', called.stderr, deployments[0])
          : result(1, '', 'Worker has no active deployment.');
    }
    case 'versions.list':
      return cleanJson(['workers', 'versions', 'list', '--worker-id', worker], (value) => {
        if (!Array.isArray(value)) {
          throw new Error('Worker versions were malformed.');
        }
        return value.map((entry) => {
          const version = object(entry);
          return { ...version, metadata: { created_on: version.created_on } };
        });
      });
    case 'versions.view': {
      const versionId = operation.versionId;
      const called = runCf(
        [
          'workers',
          'versions',
          'get',
          versionId,
          '--worker-id',
          worker,
          ...(operation.includeSource ? ['--include', 'modules'] : []),
        ],
        process.cwd(),
        operation.includeSource
          ? { timeoutMs: 30_000, maxOutputBytes: CF_VERSION_SOURCE_MAX_OUTPUT_BYTES }
          : undefined,
      );
      if (called.status !== 0) {
        return called;
      }
      const version = object(parsedJson(called.stdout));
      if (version.id !== versionId || !Array.isArray(version.bindings)) {
        throw new Error('Worker version bindings were malformed.');
      }
      if (operation.includeSource) {
        return result(0, '', called.stderr, version);
      }
      const resources = await readVersionResources(worker, versionId);
      return result(0, '', called.stderr, { ...version, resources });
    }
    case 'versions.deploy': {
      const versions = operation.versions.map((value) => ({
        version_id: value.versionId,
        percentage: value.percentage,
      }));
      if (
        !versions.length ||
        versions.some(
          (value) =>
            !/^[-a-f\d]{36}$/i.test(value.version_id) ||
            !Number.isFinite(value.percentage) ||
            value.percentage < 0 ||
            value.percentage > 100,
        ) ||
        Math.abs(versions.reduce((sum, value) => sum + value.percentage, 0) - 100) > 0.001
      ) {
        throw new Error('Cloudflare deployment percentages must total 100.');
      }
      return runCf([
        'workers',
        'deployments',
        'create',
        '--worker',
        worker,
        '--body',
        JSON.stringify({
          strategy: 'percentage',
          versions,
          ...(operation.message ? { annotations: { 'workers/message': operation.message } } : {}),
        }),
        ...(operation.bypassDeploymentChecks ? ['--bypass-deployment-checks'] : []),
      ]);
    }
    default:
      throw new Error('Unsupported Cloudflare Worker history operation.');
  }
}

async function workerChanges(): Promise<Result> {
  if (operation.type === 'queues.consumer.remove') {
    const queue = (await readAllQueues()).find((item) => item.queue_name === operation.queueName);
    if (!queue || typeof queue.queue_id !== 'string') {
      return { ...result(1, '', 'Cloudflare Queue does not exist.'), failure: 'not-found' };
    }
    const consumers = runCf(['queues', 'consumers', 'list', '--queue-id', queue.queue_id]);
    if (consumers.status !== 0) {
      return consumers;
    }
    const members = parsedJson(consumers.stdout);
    if (!Array.isArray(members)) {
      throw new Error('Queue consumer list was malformed.');
    }
    const matching = members.map(object).filter((entry) => {
      const name = entry.script_name ?? entry.script;
      if (
        (entry.script_name !== undefined &&
          (typeof entry.script_name !== 'string' || !entry.script_name)) ||
        (entry.script !== undefined && (typeof entry.script !== 'string' || !entry.script)) ||
        (entry.script_name !== undefined &&
          entry.script !== undefined &&
          entry.script_name !== entry.script) ||
        (entry.type === 'worker' && name === undefined)
      ) {
        throw new Error('Queue consumer Worker identity is ambiguous.');
      }
      return name === operation.workerName;
    });
    if (matching.length > 1) {
      throw new Error('Queue consumer Worker identity is ambiguous.');
    }
    for (const item of matching) {
      if (
        !safePositional(item.consumer_id) ||
        /\s/.test(item.consumer_id) ||
        (item.type !== undefined && item.type !== 'worker')
      ) {
        throw new Error('Queue consumer ID or type is invalid.');
      }
      const deleted = runCf([
        'queues',
        'consumers',
        'delete',
        item.consumer_id,
        '--queue-id',
        queue.queue_id,
        '--force',
      ]);
      if (deleted.status !== 0) {
        return deleted;
      }
    }
    return result(0);
  }
  const raw = config();
  const name = workerName();
  if (raw.name !== name) {
    throw new Error('Cloudflare Worker target changed.');
  }
  if (operation.type === 'triggers.clear-crons' || operation.type === 'triggers.clear-domains') {
    if (raw.account_id !== undefined && raw.account_id !== accountId()) {
      throw new Error('Cloudflare trigger target changed.');
    }
    return operation.type === 'triggers.clear-crons'
      ? clearWorkerCronSchedules(name)
      : clearWorkerCustomDomains(name);
  }
  if (operation.type === 'triggers.deploy') {
    const deployed = await withBuildOutput(raw, null, (directory) =>
      runCf(['workers', 'triggers', 'deploy', '--prebuilt'], directory),
    );
    if (deployed.status === 0 && raw.observability !== undefined) {
      await publishCloudflareObservability({
        apiBaseUrl: apiBaseUrl(),
        accountId: accountId(),
        workerName: name,
        observability: raw.observability,
        headers: await apiHeaders(),
      });
    }
    return deployed;
  }
  if (operation.type === 'versions.upload' || operation.type === 'worker.deploy') {
    const path = configPath()!;
    if (typeof raw.main !== 'string' || !raw.main || raw.no_bundle !== true) {
      throw new Error('Cloudflare Worker upload requires a prebuilt platform Worker.');
    }
    const source = resolve(dirname(path), raw.main);
    const request = operation;
    const called = await withBuildOutput(raw, source, (directory) =>
      runCf(
        [
          ...(request.type === 'worker.deploy' ? ['deploy'] : ['workers', 'versions', 'create']),
          '--prebuilt',
          // One argv item, so a message that starts with "-" is not read as a flag.
          ...(request.message ? [`--message=${request.message}`] : []),
          ...(request.secretsFilePath ? ['--secrets-file', request.secretsFilePath] : []),
        ],
        directory,
        undefined,
        request.interactive === true,
      ),
    );
    // cf wrote an interactive upload to the terminal, so only its exit status is known.
    if (called.status !== 0 || request.interactive === true) {
      return called;
    }
    // cf renders uploads for the terminal; decode once at the process boundary.
    // Callers receive an identity and URLs, never a fabricated CLI transcript.
    let uploaded: Json = {};
    try {
      uploaded = object(parsedJson(called.stdout));
    } catch {
      /* Human upload presentation. */
    }
    const printed = readCfUploadOutput(called.stdout);
    const versionId = uploaded.version_id ?? uploaded.id ?? uploaded.versionId ?? printed.versionId;
    if (typeof versionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(versionId)) {
      throw new Error('Cloudflare did not return the uploaded Worker version ID.');
    }
    const previewUrl =
      typeof uploaded.preview_url === 'string' ? uploaded.preview_url : printed.previewUrl;
    const workersDevUrl =
      typeof uploaded.workers_dev_url === 'string'
        ? uploaded.workers_dev_url
        : printed.workersDevUrl;
    return result(0, '', called.stderr, {
      versionId,
      ...(previewUrl ? { previewUrl } : {}),
      ...(workersDevUrl ? { workersDevUrl } : {}),
    });
  }
  throw new Error('Unsupported Cloudflare Worker operation.');
}

async function tail(): Promise<Result> {
  if (operation.type !== 'tail') {
    throw new Error('Cloudflare tail operation is required.');
  }
  const worker = workerName();
  const raw = config();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? raw.account_id;
  if (!worker || typeof accountId !== 'string' || !accountId || worker !== raw.name) {
    throw new Error('Cloudflare tail target is not pinned.');
  }
  const filters: Array<Json> = [];
  if (operation.search) {
    filters.push({ query: operation.search });
  }
  if (operation.versionId) {
    filters.push({ scriptVersion: operation.versionId });
  }
  if (operation.status === 'error') {
    filters.push({ outcome: ['exception', 'exceededCpu', 'exceededMemory', 'unknown'] });
  }
  const endpoint = `${apiBaseUrl()}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(worker)}/tails`;
  const headers = { ...(await apiHeaders()), 'Content-Type': 'application/json' };
  const stopped = new AbortController();
  let socket: WebSocket | undefined;
  let finish: (() => void) | undefined;
  const stop = () => {
    stopped.abort();
    socket?.close();
    finish?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let record: Json | undefined;
  try {
    const created = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ filters }),
      signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(30_000)]),
    });
    const body = object(await created.json());
    if (!created.ok || body.success !== true) {
      return result(1, '', 'Could not start the Cloudflare Worker tail.');
    }
    record = object(body.result);
    if (typeof record.id !== 'string' || typeof record.url !== 'string') {
      throw new Error('Cloudflare Worker tail response was incomplete.');
    }
    const tailUrl = record.url;
    if (stopped.signal.aborted) {
      return result(0);
    }
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      let pendingMessages = Promise.resolve();
      socket = new WebSocket(tailUrl, 'trace-v1');
      socket.addEventListener('open', () => {
        socket!.send(JSON.stringify({ debug: false }));
      });
      socket.addEventListener('message', (event) => {
        pendingMessages = pendingMessages
          .then(async () => {
            const data: unknown = event.data;
            const text =
              typeof data === 'string'
                ? data
                : data instanceof Blob
                  ? await data.text()
                  : data instanceof ArrayBuffer
                    ? new TextDecoder().decode(data)
                    : null;
            if (text === null) {
              throw new Error('Unsupported Cloudflare tail frame.');
            }
            const log = object(parsedJson(text));
            const detail = object(log.event ?? {});
            const request = object(detail.request ?? {});
            const prefix =
              typeof request.url === 'string'
                ? `${request.method ?? 'GET'} ${request.url}`
                : typeof detail.queue === 'string'
                  ? `Queue ${detail.queue}`
                  : typeof detail.mailFrom === 'string'
                    ? `Email from ${detail.mailFrom}`
                    : 'Worker event';
            // Request URLs, log lines and exceptions carry data from app visitors,
            // so terminal control sequences are dropped before printing.
            process.stdout.write(
              `${sanitizeTerminalLogText(prefix)} - ${log.outcome ?? 'unknown'} @ ${new Date(Number(log.eventTimestamp)).toLocaleString()}\n`,
            );
            if (Array.isArray(log.logs)) {
              for (const line of log.logs.map(object)) {
                const message = Array.isArray(line.message) ? line.message.join(' ') : '';
                process.stdout.write(
                  `  (${line.level ?? 'log'}) ${sanitizeTerminalLogText(message)}\n`,
                );
              }
            }
            if (Array.isArray(log.exceptions)) {
              for (const exception of log.exceptions.map(object)) {
                process.stderr.write(
                  `  ${sanitizeTerminalLogText(`${exception.name ?? 'Error'}: ${exception.message ?? ''}`)}\n`,
                );
              }
            }
          })
          .catch(() => {
            process.stderr.write('Cloudflare returned a malformed tail event.\n');
          });
      });
      socket.addEventListener('error', () =>
        reject(new Error('Cloudflare Worker tail connection failed.')),
      );
      socket.addEventListener('close', () => void pendingMessages.then(resolve));
      if (stopped.signal.aborted) {
        resolve();
      }
    });
  } catch (error) {
    if (stopped.signal.aborted) {
      return result(0);
    }
    throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    socket?.close();
    if (record && typeof record.id === 'string') {
      await fetch(`${endpoint}/${encodeURIComponent(record.id)}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }
    // Node's WebSocket can remain in CLOSING after the remote tail is deleted.
    // This is a dedicated CLI process, so leave promptly after Ctrl+C.
    if (stopped.signal.aborted) {
      process.exit(0);
    }
  }
  return result(0);
}

async function main(): Promise<Result> {
  if (process.argv.length !== 3) {
    throw new Error('Exactly one typed Cloudflare operation is required.');
  }
  if (!operation || typeof operation !== 'object' || typeof operation.type !== 'string') {
    throw new Error('Cloudflare operation is required.');
  }
  if (operation.type.startsWith('auth.')) {
    return auth();
  }
  if (operation.type.startsWith('secret.')) {
    return secrets();
  }
  if (operation.type === 'tail') {
    return tail();
  }
  if (operation.type.startsWith('email.')) {
    return email();
  }
  if (
    operation.type.startsWith('deployments.') ||
    (operation.type.startsWith('versions.') && operation.type !== 'versions.upload')
  ) {
    return workerHistory();
  }
  if (
    operation.type.startsWith('triggers.') ||
    operation.type === 'worker.deploy' ||
    operation.type === 'versions.upload' ||
    operation.type === 'queues.consumer.remove'
  ) {
    return workerChanges();
  }
  return resources();
}

// Login, tail and an interactive upload write to the terminal, not a result envelope.
const terminalOperation =
  operation?.type === 'auth.login' ||
  operation?.type === 'tail' ||
  ((operation?.type === 'versions.upload' || operation?.type === 'worker.deploy') &&
    operation.interactive === true);
try {
  const output = await main();
  if (!terminalOperation) {
    let data = output.data;
    let humanOutput = '';
    if (data === undefined && output.stdout.trim()) {
      try {
        data = parsedJson(output.stdout);
      } catch {
        humanOutput = output.stdout;
      }
    }
    process.stdout.write(
      JSON.stringify({
        operationResult: 1,
        ...(output.signal ? { signal: output.signal } : {}),
        ...(output.error ? { error: output.error } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(output.errorCode !== undefined ? { errorCode: output.errorCode } : {}),
        ...(output.failure ? { failure: output.failure } : {}),
        ...(output.stderr ? { errors: [{ code: output.errorCode, message: output.stderr }] } : {}),
        ...(humanOutput ? { output: humanOutput } : {}),
      }) + '\n',
    );
  }
  if (output.stderr) {
    process.stderr.write(output.stderr);
  }
  process.exitCode = output.status;
} catch (error) {
  const message = error instanceof Error ? error.message : 'Cloudflare operation failed.';
  if (!terminalOperation) {
    process.stdout.write(JSON.stringify({ operationResult: 1, errors: [{ message }] }) + '\n');
  }
  process.stderr.write(message);
  process.exitCode = 1;
}
