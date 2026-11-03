/** Env-schema validation for `void env check`, `void secret`, and both deploy paths. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  parseRootWranglerConfig,
  readWranglerTopLevelString,
  type CloudflareOperation,
} from '@void/deploy-cloudflare';
import { dirname, join, resolve } from 'pathslash';
import { findEnvFile } from '../codegen/env-types.ts';
import { loadUserEnvFile } from '../host/load-user-env.ts';
import { voidWarn } from '../log.ts';
import type { EnvValidationReport } from '../runtime/env-public.ts';
import { scanWranglerDotenvKeys } from '../shared/dotenv.ts';
import {
  findLegacyEnvFiles,
  findReservedEnvKeys,
  isClientEnvKey,
  loadLocalEnv,
  LOCAL_ENV_FILE,
  reservedEnvKeysMessage,
} from '../shared/env.ts';
import type { StandardSchemaV1 } from '../standard-schema.ts';
import type { PlatformClient } from './client.ts';
import {
  encodeCloudflareOperation,
  decodeCloudflareOperationResult,
} from './cloudflare-process.ts';
import { readGeneratedWranglerConfigFile } from './generated-wrangler-config.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';

type EnvPublicModule = Pick<
  typeof import('../runtime/env-public.ts'),
  '_getRegisteredSchema' | '_hasRegisteredSchema' | '_getSchemaDefaults' | 'validateAllEnv'
>;

/**
 * Validate plaintext while it is still available to `void secret put/sync`.
 * Existing remote values remain unreadable and are validated again at worker boot.
 */
export async function validateSecretValues(
  root: string,
  entries: Array<{ name: string; value: string }>,
): Promise<void> {
  const envFile = findEnvFile(root);
  if (!envFile) {
    throw new Error('secret: env.ts is required before setting production values.');
  }
  const mod = await loadSchema(envFile);
  const schema = mod?._getRegisteredSchema();
  if (!schema) {
    throw new Error('secret: env.ts did not register a schema with defineEnv().');
  }

  for (const { name, value } of entries) {
    if (isClientEnvKey(name)) {
      throw new Error(
        `secret: ${name} is client-exposed. Set it in the build shell or give it a schema default.`,
      );
    }
    const validator = schema[name];
    if (!validator) {
      throw new Error(`secret: ${name} is not declared in env.ts.`);
    }
    const result = validator['~standard'].validate(value);
    const resolved = result instanceof Promise ? await result : result;
    if (resolved.issues) {
      throw new Error(`secret: ${name} failed env.ts validation.`);
    }
  }
}

/** Load the registered schema by importing the user's env.ts. */
async function loadSchema(envFile: string): Promise<EnvPublicModule | null> {
  await loadUserEnvFile(envFile);
  const mod = await import('../runtime/env-public.ts');
  if (!mod._hasRegisteredSchema()) {
    return null;
  }
  return mod;
}

export type ValidateProdEnvOptions = {
  /** When true, validate build-shell + remote state and never read `.env`. */
  productionOnly: boolean;
  /** Optional remote secret list (names only). Treated as "value present". */
  remoteSecrets?: Array<string>;
  /** Explicit public vars included in a managed deployment. Never satisfy server schema keys. */
  workerVars?: Record<string, string>;
};

export type ProdEnvValidationResult = {
  hasSchema: boolean;
  report: EnvValidationReport;
};

function emptyReport(): EnvValidationReport {
  return { valid: true, missing: [], invalid: [], values: new Map() };
}

/**
 * Validate local development against `.env` + the shell, or production
 * against the build shell + remote secret names. `.env` is never a
 * production source.
 */
export async function validateProdEnv(
  root: string,
  options: ValidateProdEnvOptions,
): Promise<ProdEnvValidationResult> {
  const legacyFiles = findLegacyEnvFiles(root);
  if (legacyFiles.length > 0) {
    throw new Error(
      `env: only .env is supported for local development. Remove ${legacyFiles.join(', ')} and follow the env migration guide.`,
    );
  }
  // Same rule as the Vite plugin, which stops dev and build on these names.
  // Production validation never reads .env; the build itself reports it.
  const reservedInDotenv = options.productionOnly
    ? []
    : findReservedEnvKeys(scanWranglerDotenvKeys(join(root, LOCAL_ENV_FILE)));
  if (reservedInDotenv.length > 0) {
    throw new Error(`env: ${reservedEnvKeysMessage('.env', reservedInDotenv)}`);
  }
  const envFile = findEnvFile(root);
  if (!envFile) {
    return { hasSchema: false, report: emptyReport() };
  }
  const mod = await loadSchema(envFile);
  if (!mod) {
    return { hasSchema: false, report: emptyReport() };
  }
  const reservedInSchema = findReservedEnvKeys(Object.keys(mod._getRegisteredSchema() ?? {}));
  if (reservedInSchema.length > 0) {
    throw new Error(`env: ${reservedEnvKeysMessage('env.ts', reservedInSchema)}`);
  }
  const serverVarKeys = Object.keys(mod._getRegisteredSchema() ?? {}).filter(
    (key) => !isClientEnvKey(key) && Object.hasOwn(options.workerVars ?? {}, key),
  );
  if (serverVarKeys.length > 0) {
    throw new Error(
      `env: Server env keys cannot be Worker plaintext vars: ${serverVarKeys.join(', ')}. ` +
        'Remove them from worker.vars and set them with the remote secret store.',
    );
  }

  const local = options.productionOnly
    ? {}
    : loadLocalEnv(root, { onWarn: (message) => voidWarn(message) });
  const shell = options.productionOnly
    ? Object.fromEntries(Object.entries(process.env).filter(([key]) => isClientEnvKey(key)))
    : process.env;
  const merged: Record<string, unknown> = { ...local, ...shell };

  const report = await mod.validateAllEnv(merged);
  // Remote secret values are unreadable here, so a missing server key that exists
  // remotely passes; the Worker validates the real value at boot.
  const remoteSet = new Set(options.remoteSecrets ?? []);
  if (remoteSet.size > 0 && report.missing.length > 0) {
    report.missing = report.missing.filter((key) => isClientEnvKey(key) || !remoteSet.has(key));
    if (report.missing.length === 0 && report.invalid.length === 0) {
      report.valid = true;
    }
  }
  return { hasSchema: true, report };
}

export function formatEnvReport(report: EnvValidationReport): string {
  const lines: Array<string> = [];
  if (report.missing.length > 0) {
    lines.push('Missing required env vars:');
    for (const key of report.missing) {
      lines.push(`  • ${key}`);
    }
  }
  if (report.invalid.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Invalid env vars:');
    for (const { key, messages } of report.invalid) {
      lines.push(`  • ${key}: ${messages.join('; ')}`);
    }
  }
  return lines.join('\n');
}

/** Convenience: fetch remote secret names from the platform. */
export async function fetchRemoteSecretNames(
  client: PlatformClient,
  projectId: string,
): Promise<Array<string>> {
  try {
    const secrets = await client.listSecrets(projectId);
    return secrets.map((s) => s.name);
  } catch {
    return [];
  }
}

// Self-host (`void deploy --platform cloudflare`) secret gate. It checks the vars the
// build emitted and the remote secret names. Its errors name keys only, never values.

type SchemaProbe = StandardSchemaV1<unknown, unknown>['~standard'];

/**
 * A key is required when its validator rejects `undefined`. Do not judge by `""`:
 * a bare `z.string()` accepts it but is still required. Validators are user code,
 * so call this inside {@link withSchemaBoundary}.
 */
async function requiredSchemaKeys(schema: Record<string, unknown>): Promise<Set<string>> {
  const required = new Set<string>();
  for (const [key, validator] of Object.entries(schema)) {
    const probe = (validator as { '~standard': SchemaProbe })['~standard'];
    const resultMaybe = probe.validate(undefined);
    const result = resultMaybe instanceof Promise ? await resultMaybe : resultMaybe;
    if ((result as { issues?: unknown }).issues) {
      required.add(key);
    }
  }
  return required;
}

/** Only `status === 0` with no `signal` or `error` may be parsed as a list. */
export type SecretListRunResult = {
  data?: unknown;
  errorCode?: number;
  failure?: 'not-found' | 'durable-migration' | 'containers-unavailable';
  stdout: string;
  stderr: string;
  status: number;
  signal?: NodeJS.Signals | null;
  error?: string | null;
};

export type RunSecretList = (
  args: CloudflareOperation,
) => SecretListRunResult | Promise<SecretListRunResult>;

type SecretListFailureReason = 'spawn-error' | 'nonzero-exit' | 'signal' | 'malformed-output';

type SecretListFailureDetail = { exitCode?: number; signal?: string };

/**
 * The remote secret names could not be read, so the gate fails closed. Messages never
 * include provider output: the child inherits `process.env` and can echo a value.
 */
export class SelfHostSecretListError extends Error {
  override name = 'SelfHostSecretListError';
}

/** The Worker has not been deployed yet, so its secrets cannot be listed. */
export class SelfHostFirstDeployError extends SelfHostSecretListError {
  override name = 'SelfHostFirstDeployError';
}

/** Required keys are missing or shipped values are invalid. */
export class SelfHostEnvValidationError extends Error {
  override name = 'SelfHostEnvValidationError';
}

export type SelfHostSchemaFailureReason = 'schema-load-failed' | 'schema-validation-error';

/** env.ts or a validator threw. The original error is dropped: it can embed a value. */
export class SelfHostSchemaError extends Error {
  override name = 'SelfHostSchemaError';
  readonly reason: SelfHostSchemaFailureReason;
  // Explicit fields (not TS parameter properties) so this module type-strips under
  // plain Node — the env-schema probe child imports it.
  constructor(message: string, reason: SelfHostSchemaFailureReason) {
    super(message);
    this.reason = reason;
  }
}

export function selfHostSchemaFailureMessage(reason: SelfHostSchemaFailureReason): string {
  switch (reason) {
    case 'schema-load-failed':
      return (
        'env: the project env schema could not be loaded (reason: schema-load-failed). ' +
        'Check that env.ts evaluates without error, then run the deploy again.'
      );
    case 'schema-validation-error':
      return (
        'env: an env schema validator raised an error while checking production values ' +
        '(reason: schema-validation-error). Re-run the validator locally to see its own diagnostics.'
      );
  }
}

/** Replace any error from user code with a values-free {@link SelfHostSchemaError}. */
async function withSchemaBoundary<T>(
  reason: SelfHostSchemaFailureReason,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new SelfHostSchemaError(selfHostSchemaFailureMessage(reason), reason);
  }
}

export type SelfHostEnvContext = {
  hasSchema: boolean;
  /** Required keys not in the emitted vars. Only a remote secret can satisfy them. */
  absentRequired: Array<string>;
  /** Keys whose emitted value failed the schema. A remote secret cannot fix these. */
  invalidKeys: Array<string>;
};

/** Schema structure the gate needs, read once in the env-schema probe child. */
export type SelfHostSchemaFacts = {
  hasSchema: boolean;
  /** Server-only keys. These may never be emitted as plaintext vars. */
  serverKeys: Array<string>;
  requiredKeys: Array<string>;
};

/** Imports the user's env.ts, so callers run it in the env-schema probe child. */
export async function deriveSelfHostSchemaFacts(root: string): Promise<SelfHostSchemaFacts> {
  const envFile = findEnvFile(root);
  if (envFile == null) {
    return { hasSchema: false, serverKeys: [], requiredKeys: [] };
  }
  const mod = await withSchemaBoundary('schema-load-failed', () => loadSchema(envFile));
  if (!mod) {
    return { hasSchema: false, serverKeys: [], requiredKeys: [] };
  }
  const schema = mod._getRegisteredSchema() ?? {};
  const serverKeys = Object.keys(schema).filter((key) => !isClientEnvKey(key));
  const required = await withSchemaBoundary('schema-validation-error', () =>
    requiredSchemaKeys(schema),
  );
  const requiredKeys = [...required].filter((key) => !isClientEnvKey(key));
  return { hasSchema: true, serverKeys, requiredKeys };
}

/**
 * Build the gate context from the emitted vars. The caller has already rejected
 * server keys emitted as plaintext vars, so a required key here is only absent or not.
 */
export function deriveSelfHostEnvContextFromVars(
  emittedVars: Record<string, unknown>,
  facts: SelfHostSchemaFacts,
): SelfHostEnvContext {
  if (!facts.hasSchema) {
    return { hasSchema: false, absentRequired: [], invalidKeys: [] };
  }
  return {
    hasSchema: true,
    absentRequired: facts.requiredKeys.filter((key) => !Object.hasOwn(emittedVars, key)),
    invalidKeys: [],
  };
}

export type EmittedWorkerVarsResult =
  | { ok: true; vars: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Follow the CF plugin's deploy pointer (`.wrangler/deploy/config.json`) to the
 * generated config. Returns a fail-closed reason instead of throwing.
 */
function readGeneratedWranglerConfig(
  root: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; reason: string } {
  const deployConfigPath = join(root, '.wrangler', 'deploy', 'config.json');
  if (!existsSync(deployConfigPath)) {
    return {
      ok: false,
      reason: `the CF plugin's deploy pointer at ${deployConfigPath} was not written by the build.`,
    };
  }
  let redirectedPath: string;
  try {
    const parsed = JSON.parse(readFileSync(deployConfigPath, 'utf-8')) as { configPath?: unknown };
    if (typeof parsed.configPath !== 'string' || parsed.configPath.length === 0) {
      return { ok: false, reason: `${deployConfigPath} has no "configPath" pointer.` };
    }
    redirectedPath = resolve(dirname(deployConfigPath), parsed.configPath);
  } catch {
    return { ok: false, reason: `${deployConfigPath} is not valid JSON.` };
  }
  if (!existsSync(redirectedPath)) {
    return { ok: false, reason: `generated wrangler config ${redirectedPath} does not exist.` };
  }
  try {
    const config = readGeneratedWranglerConfigFile(redirectedPath);
    return { ok: true, config };
  } catch {
    return {
      ok: false,
      reason: `generated wrangler config ${redirectedPath} is not valid JSON/JSONC.`,
    };
  }
}

/** Read the `vars` the build emitted into the generated Worker config. */
export function readEmittedWorkerVars(root: string): EmittedWorkerVarsResult {
  const resolved = readGeneratedWranglerConfig(root);
  if (!resolved.ok) {
    return resolved;
  }
  const vars = resolved.config.vars;
  // A malformed `vars` must fail closed: read as `{}`, every required key would look
  // absent and a remote secret could satisfy it.
  if (vars === undefined) {
    return { ok: true, vars: {} };
  }
  if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
    return {
      ok: false,
      reason: 'the generated wrangler config has a malformed "vars" field (expected an object).',
    };
  }
  return { ok: true, vars: vars as Record<string, unknown> };
}

/**
 * Validate the emitted vars and return the failing key names. `validateAllEnv` reports
 * a rejected `""` or `null` as missing, so a missing key that was shipped counts as
 * invalid; a key that was not shipped is left for the remote-secret check. Runs user
 * validators, so callers run it in the env-schema probe child.
 */
export async function computeInvalidEmittedKeys(
  root: string,
  emittedVars: Record<string, unknown>,
): Promise<Array<string>> {
  const envFile = findEnvFile(root);
  if (envFile == null) {
    return [];
  }
  const mod = await withSchemaBoundary('schema-load-failed', () => loadSchema(envFile));
  if (!mod) {
    return [];
  }
  const report = await withSchemaBoundary('schema-validation-error', () =>
    mod.validateAllEnv(emittedVars),
  );
  const invalid = new Set<string>(report.invalid.map((entry) => entry.key));
  for (const key of report.missing) {
    if (Object.hasOwn(emittedVars, key)) {
      invalid.add(key);
    }
  }
  return Array.from(invalid).sort((a, b) => a.localeCompare(b));
}

/**
 * Fail unless every required key is shipped or set as a remote secret, and no shipped
 * value is invalid. Lists remote secrets only when a required key is absent.
 */
export async function dischargeSelfHostEnvContext(
  context: SelfHostEnvContext,
  options: {
    root: string;
    configPath: string;
    accountId?: string;
    /** The Worker name the deploy pinned; the config's `name` must still match it. */
    workerName?: string;
    runWrangler?: RunSecretList;
  },
): Promise<void> {
  if (!context.hasSchema) {
    return;
  }
  const remote =
    context.absentRequired.length > 0
      ? new Set(await listSelfHostSecretNames(options, context.absentRequired))
      : new Set<string>();
  const missing = context.absentRequired.filter((key) => !remote.has(key));
  if (missing.length > 0 || context.invalidKeys.length > 0) {
    throw selfHostEnvError(missing, context.invalidKeys);
  }
}

/**
 * Fail closed when the config pins a different account than the deploy, since the
 * list could then read another account's secrets. Returns the account to pin.
 */
function reconcileSelfHostAccount(
  configPath: string,
  requestedAccountId: string | undefined,
): string | undefined {
  const configAccountId = readWranglerTopLevelString(
    parseRootWranglerConfig(configPath),
    'account_id',
  );
  if (configAccountId && requestedAccountId && configAccountId !== requestedAccountId) {
    throw new SelfHostSecretListError(
      `env: Cloudflare account mismatch — "${configPath}" pins account_id ` +
        `${JSON.stringify(configAccountId)} but the deploy targets ` +
        `${JSON.stringify(requestedAccountId)}. wrangler resolves the config's account_id before ` +
        `CLOUDFLARE_ACCOUNT_ID, so \`wrangler secret list\` would consult ` +
        `${JSON.stringify(configAccountId)} while the deploy expects ` +
        `${JSON.stringify(requestedAccountId)} — a same-named secret there could falsely pass this ` +
        `preflight. Reconcile them (correct or remove the config's account_id, or deploy to the ` +
        `pinned account) and retry.`,
    );
  }
  return configAccountId ?? requestedAccountId;
}

/**
 * The list resolves the Worker from the config's `name`. If project code changed it
 * after the deploy pinned it, the list would read another Worker's secrets.
 */
function reconcileSelfHostWorkerName(
  configPath: string,
  pinnedWorkerName: string | undefined,
): void {
  const configName = readWranglerTopLevelString(parseRootWranglerConfig(configPath), 'name');
  if (configName && pinnedWorkerName && configName !== pinnedWorkerName) {
    throw new SelfHostSecretListError(
      `env: Cloudflare worker name mismatch — "${configPath}" declares name ` +
        `${JSON.stringify(configName)} but the deploy pinned ${JSON.stringify(pinnedWorkerName)}. ` +
        `wrangler resolves the worker name from the config's \`name\`, so \`wrangler secret list\` ` +
        `would consult ${JSON.stringify(configName)} while the deploy ships ` +
        `${JSON.stringify(pinnedWorkerName)} — a same-named secret there could falsely pass this ` +
        `preflight. The config's name was changed after it was pinned; rebuild from a clean ` +
        `checkout, then rerun.`,
    );
  }
}

/** Shown instead of validator messages, which can embed the rejected value. */
const SELF_HOST_INVALID_REASON = 'failed schema validation';

function selfHostEnvError(
  missingKeys: Array<string>,
  invalidKeys: Array<string>,
): SelfHostEnvValidationError {
  const sortNames = (names: Array<string>): Array<string> =>
    [...names].sort((a, b) => a.localeCompare(b));
  const missing = sortNames(missingKeys);
  const invalid = sortNames(invalidKeys);

  const lines: Array<string> = [];
  if (missing.length > 0) {
    lines.push('Missing required env vars:');
    for (const key of missing) {
      lines.push(`  • ${key}`);
    }
  }
  if (invalid.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Invalid env vars:');
    for (const key of invalid) {
      lines.push(`  • ${key} (${SELF_HOST_INVALID_REASON})`);
    }
  }
  if (missing.length > 0) {
    lines.push('', 'Set each missing production secret with `void secret put <NAME>`.');
  }
  return new SelfHostEnvValidationError(lines.join('\n'));
}

function firstDeployMessage(missingKeys: Array<string>): string {
  const sorted = [...missingKeys].sort((a, b) => a.localeCompare(b));
  const names = sorted.length > 0 ? sorted : ['<NAME>'];
  return [
    'This Worker has not been deployed yet, so its remote secrets could not be listed.',
    '',
    'Required production secrets still unset locally:',
    ...sorted.map((key) => `  • ${key}`),
    '',
    'Bootstrap them on the draft Worker before deploying:',
    ...names.map((key) => `  void secret put ${key}`),
  ].join('\n');
}

function secretListOperation(configPath: string): CloudflareOperation {
  return { type: 'secret.list', configPath };
}

function secretListFailureMessage(
  reason: SecretListFailureReason,
  detail: SecretListFailureDetail,
): string {
  const base = 'env: `wrangler secret list` could not confirm the remote secrets';
  switch (reason) {
    case 'spawn-error':
      return (
        `${base} (reason: spawn-error) — the wrangler process could not be started. ` +
        'Check that wrangler is installed and the pinned config path is valid.'
      );
    case 'signal':
      return (
        `${base} (reason: signal) — the process was terminated by ` +
        `${detail.signal ?? 'a signal'} before completing.`
      );
    case 'nonzero-exit':
      return (
        `${base} (reason: nonzero-exit, status ${detail.exitCode ?? 'unknown'}). ` +
        'Run `void secret list` to retry through Void and see the Cloudflare diagnostics.'
      );
    case 'malformed-output':
      return (
        `${base} (reason: malformed-output) — \`wrangler secret list --format=json\` ` +
        'did not return the expected JSON array of secret objects.'
      );
  }
}

function secretListError(
  reason: SecretListFailureReason,
  detail: SecretListFailureDetail = {},
): SelfHostSecretListError {
  return new SelfHostSecretListError(secretListFailureMessage(reason, detail));
}

/**
 * Run the list and parse it strictly: any failure throws rather than reading as
 * "no secrets". Runner and provider text is never surfaced, since it can embed values.
 */
async function fetchSelfHostSecretNames(
  run: RunSecretList,
  configPath: string,
  missingKeys: Array<string>,
): Promise<Array<string>> {
  let result: SecretListRunResult;
  try {
    result = await Promise.resolve(run(secretListOperation(configPath)));
  } catch {
    throw secretListError('spawn-error');
  }
  if (result.error != null && result.error !== '') {
    throw secretListError('spawn-error');
  }
  if (result.signal != null) {
    throw secretListError('signal', { signal: String(result.signal) });
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    const exitCode = typeof result.status === 'number' ? result.status : undefined;
    // Only a completed provider failure may identify a missing Worker.
    if (
      Number.isSafeInteger(result.status) &&
      result.status! > 0 &&
      ([10007, 10090].includes(result.errorCode ?? 0) || result.failure === 'not-found')
    ) {
      throw new SelfHostFirstDeployError(firstDeployMessage(missingKeys));
    }
    throw secretListError('nonzero-exit', { exitCode });
  }
  const parsed = result.data;
  if (!Array.isArray(parsed)) {
    throw secretListError('malformed-output');
  }
  const names: Array<string> = [];
  for (const member of parsed) {
    // One malformed member fails the whole list: a partial list could vouch for
    // secrets that were never seen.
    const name =
      member !== null && typeof member === 'object' && !Array.isArray(member)
        ? (member as { name?: unknown }).name
        : undefined;
    if (typeof name !== 'string' || name.length === 0) {
      throw secretListError('malformed-output');
    }
    names.push(name);
  }
  return names;
}

/** List the pinned Worker's remote secret names after checking the config's identity. */
export async function listSelfHostSecretNames(
  options: {
    root: string;
    configPath: string;
    accountId?: string;
    workerName?: string;
    runWrangler?: RunSecretList;
  },
  missingKeys: Array<string> = [],
): Promise<Array<string>> {
  reconcileSelfHostWorkerName(options.configPath, options.workerName);
  const effectiveAccountId = reconcileSelfHostAccount(options.configPath, options.accountId);
  const run =
    options.runWrangler ??
    createDefaultSecretListRunner(options.root, { accountId: effectiveAccountId });
  return fetchSelfHostSecretNames(run, options.configPath, missingKeys);
}

/** A hung list must not hang the deploy. */
const SECRET_LIST_TIMEOUT_MS = 120_000;

/**
 * Default {@link RunSecretList}: spawn the Cloudflare operation process without a
 * shell. A timeout SIGKILLs a hung child; anything but a clean exit 0 fails closed.
 */
export function createDefaultSecretListRunner(
  root: string,
  options?: {
    accountId?: string;
    /** Test seam for the argv launcher. */
    launcher?: Array<string>;
    timeoutMs?: number;
  },
): RunSecretList {
  const launcher = options?.launcher ?? resolveCloudflareOperationArgv();
  const timeoutMs = options?.timeoutMs ?? SECRET_LIST_TIMEOUT_MS;
  const [command, ...prefix] = launcher;
  return (args) =>
    new Promise<SecretListRunResult>((resolvePromise) => {
      const child = spawn(command as string, [...prefix, ...encodeCloudflareOperation(args)], {
        cwd: root,
        shell: false,
        env: secretListEnv(options?.accountId),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let killFallbackTimer: ReturnType<typeof setTimeout> | undefined;
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const settle = (result: SecretListRunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(commandTimer);
        clearTimeout(killFallbackTimer);
        resolvePromise(decodeCloudflareOperationResult(result));
      };
      const timeoutNote = `env: wrangler secret list exceeded the ${timeoutMs}ms timeout`;
      // Referenced timers keep the process alive until the outcome is known.
      const commandTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // The fallback timer below settles as a hard failure.
        }
        // If `close` never fires, settle as a hard failure rather than hang.
        killFallbackTimer = setTimeout(() => {
          settle({
            stdout,
            stderr: [stderr, timeoutNote].filter(Boolean).join('\n'),
            status: -1,
            signal: 'SIGKILL',
            error: 'timed out and termination could not be confirmed',
          });
        }, 5_000);
      }, timeoutMs);
      child.on('error', (error: Error) => {
        settle({ stdout, stderr, status: -1, signal: null, error: error.message });
      });
      child.on('close', (code, signal) => {
        settle({
          stdout,
          stderr: timedOut ? [stderr, timeoutNote].filter(Boolean).join('\n') : stderr,
          // A signal-killed child reports `code: null`; keep it nonzero.
          status: typeof code === 'number' ? code : -1,
          signal: signal ?? (timedOut ? 'SIGKILL' : null),
        });
      });
    });
}

/**
 * Child env for the default runner: drops the CF Access credentials (Void API only),
 * forces sanitized logs, and pins the account. Ambient transport env such as
 * `CLOUDFLARE_API_BASE_URL` is kept so a staging or FedRAMP endpoint still applies.
 * Windows env keys are case-insensitive, so there every case variant is removed.
 */
export function secretListEnv(accountId?: string, platform?: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const caseInsensitive = (platform ?? process.platform) === 'win32';
  const scrub = (name: string): void => {
    if (!caseInsensitive) {
      delete env[name];
      return;
    }
    const lower = name.toLowerCase();
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === lower) {
        delete env[key];
      }
    }
  };
  scrub('CF_ACCESS_CLIENT_ID');
  scrub('CF_ACCESS_CLIENT_SECRET');
  scrub('VOID_ACCESS_CREDENTIALS');
  scrub('VOID_ACCESS_ORIGIN');
  scrub('CF_ACCESS_READINESS_ORIGIN');
  scrub('WRANGLER_LOG_SANITIZE');
  env.WRANGLER_LOG_SANITIZE = 'true';
  if (accountId) {
    scrub('CLOUDFLARE_ACCOUNT_ID');
    env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }
  return env;
}
