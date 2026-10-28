import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { resolve as resolvePosixPath } from 'node:path/posix';
import { resolve as resolveWindowsPath } from 'node:path/win32';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { isRecord } from '@void/deploy-core';
import { parse, type ParseError } from 'jsonc-parser';
import { basename, dirname, join, normalize, resolve } from 'pathslash';
import lockfile from 'proper-lockfile';
import { voidLog, voidWarn } from '../log.ts';
import type { CloudflareQueueNames } from '../queues/cloudflare-names.ts';
import { scanWranglerDotenvKeys } from '../shared/dotenv.ts';
import {
  encodeCloudflareOperation,
  decodeCloudflareOperationResult,
} from './cloudflare-process.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';
import {
  assertNoDuplicateMembers,
  persistMaterializedWranglerConfig,
  readProvisionedBindingEntry,
  writeProvisionedWranglerConfig,
  type WriteProvisionedWranglerResult,
} from './wrangler.ts';

/** The Cloudflare resources an app needs, computed by the deploy orchestrator. */
export interface DesiredResourceSet {
  /** `migrationsDir` is config-relative and defaults to `./db/migrations`. */
  d1?: { binding: string; name: string; migrationsDir?: string };
  /** KV namespaces (app KV + `ISR_CACHE`). Titles are NOT account-unique. */
  kvNamespaces: Array<{ binding: string; title: string }>;
  /** R2 bucket — bucket names ARE account-unique. */
  r2?: { binding: string; bucketName: string };
  /** Queue resource NAMES to ensure exist (account-unique). */
  queues: Array<string>;
  /** Each `queues/` name to its entry in `queues`; set by `void deploy`. */
  queueNames?: CloudflareQueueNames;
  /** Hyperdrive config — a connection string is required only to CREATE one. */
  hyperdrive?: { binding: string; name: string; connectionString: string };
}

/** One DESIRED id-bearing resource absent (or placeholder-only) in the config. */
export interface ProvisionDriftEntry {
  /** Binding name (`DB`, `KV`, `ISR_CACHE`, `STORAGE`, `HYPERDRIVE`). */
  binding: string;
  kind: 'd1' | 'kv' | 'r2' | 'hyperdrive';
  /** Resource name / KV title / bucket name the deploy wants. */
  name: string;
}

export interface ProvisionDriftResult {
  /** Desired id-bearing resources not yet provisioned (real-id) in the config. */
  missing: Array<ProvisionDriftEntry>;
}

/**
 * Desired id-bearing resources whose binding has no real id in the root config, using the
 * same rule as read-first. Reads only the local config; queues have no id and are skipped.
 */
export function checkCloudflareProvisionDrift(
  configPath: string,
  desired: DesiredResourceSet,
): ProvisionDriftResult {
  const config = readRootConfig(configPath);
  const missing: Array<ProvisionDriftEntry> = [];
  const isProvisioned = (
    field: string,
    binding: string,
    hasRealId: (entry: Record<string, unknown>) => boolean,
  ): boolean => {
    const entry = readProvisionedBindingEntry(config, field, binding, configPath);
    return entry !== undefined && hasRealId(entry);
  };
  if (desired.d1) {
    if (!isProvisioned('d1_databases', desired.d1.binding, (e) => isRealD1Id(e.database_id))) {
      missing.push({ binding: desired.d1.binding, kind: 'd1', name: desired.d1.name });
    }
  }
  for (const kv of desired.kvNamespaces) {
    if (!isProvisioned('kv_namespaces', kv.binding, (e) => isRealKvId(e.id))) {
      missing.push({ binding: kv.binding, kind: 'kv', name: kv.title });
    }
  }
  if (desired.r2) {
    if (
      !isProvisioned('r2_buckets', desired.r2.binding, (e) =>
        isRealStoredR2BucketName(e.bucket_name, desired.r2?.bucketName),
      )
    ) {
      missing.push({ binding: desired.r2.binding, kind: 'r2', name: desired.r2.bucketName });
    }
  }
  if (desired.hyperdrive) {
    if (!isProvisioned('hyperdrive', desired.hyperdrive.binding, (e) => isRealHyperdriveId(e.id))) {
      missing.push({
        binding: desired.hyperdrive.binding,
        kind: 'hyperdrive',
        name: desired.hyperdrive.name,
      });
    }
  }
  return { missing };
}

/**
 * Result of one Cloudflare operation. A non-null `signal` or `error` means the child did not
 * finish, so its output is never read as success or absence ({@link isHardFailure}).
 */
export type RunWranglerResult = {
  data?: unknown;
  errorCode?: number;
  failure?: 'not-found' | 'durable-migration' | 'containers-unavailable';
  stdout: string;
  stderr: string;
  status: number;
  /** Non-null only when the child was killed by a signal. */
  signal?: NodeJS.Signals | null;
  /** The spawn-error message when the child could not be started — a HARD failure. */
  error?: string | null;
};

/**
 * Transport context passed to every Cloudflare operation. `accountId` is the one account this
 * provision is pinned to; an injected runner must use the same account.
 */
export interface WranglerCallContext {
  /** The reconciled effective Cloudflare account (never empty for a real call). */
  accountId: string;
  /** The pinned API base URL, shared with the Hyperdrive REST lister. */
  apiBaseUrl?: string;
  /** Pin the operator credential selected by the caller for every subprocess. */
  apiToken?: string;
  cwd?: string;
  input?: string;
  /** Keep borrowed OAuth bearer values out of Wrangler's on-disk logs. */
  suppressLogs?: boolean;
}

/**
 * Returns a Promise, or a plain value from a test stub. The default runner is async so a slow
 * call never blocks the event loop and starves the lock heartbeat.
 */
export type RunWrangler = (
  args: CloudflareOperation,
  opts: WranglerCallContext,
) => RunWranglerResult | Promise<RunWranglerResult>;

/** A Cloudflare Hyperdrive config as returned by the account-list existence check. */
export interface HyperdriveConfig {
  id: string;
  name: string;
}

/**
 * Lists the account's Hyperdrive configs. There is no machine-readable Hyperdrive list
 * command, so the default uses the REST API. It always receives the pinned account and base.
 */
export type ListHyperdriveConfigs = (ctx: {
  accountId: string;
  apiBaseUrl: string;
  /** Aborts at the overall lister deadline; the caller also races the call against it. */
  signal: AbortSignal;
}) => Promise<Array<HyperdriveConfig>>;

/** Per-resource outcome, so the orchestrator can log what happened. */
export interface ProvisionOutcome {
  kind: 'd1' | 'kv' | 'r2' | 'hyperdrive' | 'queue';
  /** Binding name (absent for queue resources, which are not bindings here). */
  binding?: string;
  /** Resource name / KV title / bucket name / queue name. */
  name: string;
  action: 'created' | 'reused' | 'adopted' | 'skipped';
  /** Real resource id captured on adopt (and reuse, when known). */
  id?: string;
  /** Reason, set only when `action === 'skipped'`. */
  reason?: string;
}

export interface ProvisionResult {
  resources: Array<ProvisionOutcome>;
  /** The root wrangler config the writer/wrangler operated on. */
  configPath: string;
  /** True when top-level `account_id` was written from `opts.accountId`. */
  accountIdWritten: boolean;
}

type PinnedRunWrangler = (
  args: CloudflareOperation,
  callOpts?: { cwd?: string; suppressLogs?: boolean; input?: string },
) => Promise<RunWranglerResult>;

type ProvisionConfigWriter = (
  patch: Parameters<typeof writeProvisionedWranglerConfig>[1],
) => WriteProvisionedWranglerResult;

export interface ProvisionLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Where Void keeps D1 migrations — written as `migrations_dir` on the D1 entry. */
const D1_MIGRATIONS_DIR = './db/migrations';

/** UTF-8 byte-order mark. Node's utf-8 read preserves a leading one. */
const UTF8_BOM = '﻿';

// Placeholders `syncWranglerBindings` writes for a not-yet-provisioned binding. Each belongs
// to its own field only: `local` is a valid R2 bucket name.
const D1_ID_PLACEHOLDER = 'local';
const KV_ID_PLACEHOLDER = 'local';
const R2_BUCKET_NAME_PLACEHOLDER = 'default';

// Cloudflare id formats; a placeholder or malformed id never counts as provisioned.
//   - D1 `database_id`: a hyphenated UUID.
//   - KV namespace and Hyperdrive `id`: 32 hex chars, no hyphens.
//   - R2 identity is the `bucket_name`.
const D1_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_ID_RE = /^[0-9a-f]{32}$/i;
/** R2 bucket-name grammar (wrangler's `isValidR2BucketName`). */
const R2_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** A real (non-placeholder) D1 `database_id`. */
export function isRealD1Id(value: unknown): value is string {
  return typeof value === 'string' && value !== D1_ID_PLACEHOLDER && D1_ID_RE.test(value);
}
/** A real (non-placeholder) KV namespace `id`. */
export function isRealKvId(value: unknown): value is string {
  return typeof value === 'string' && value !== KV_ID_PLACEHOLDER && HEX32_ID_RE.test(value);
}
/** A Hyperdrive config `id` that is a real 32-hex string (no placeholder exists). */
export function isRealHyperdriveId(value: unknown): value is string {
  return typeof value === 'string' && HEX32_ID_RE.test(value);
}
/** An R2 `bucket_name` satisfying wrangler's bucket-name GRAMMAR (format only). */
function isValidR2BucketNameFormat(value: unknown): value is string {
  return typeof value === 'string' && R2_BUCKET_NAME_RE.test(value);
}
/**
 * A stored R2 `bucket_name` naming a real bucket: any non-empty string except the `default`
 * placeholder (unless desired). Grammar is not checked, so a contradicting name still fails.
 */
function isRealStoredR2BucketName(value: unknown, desiredName?: string): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (value !== R2_BUCKET_NAME_PLACEHOLDER || value === desiredName)
  );
}

const defaultLogger: ProvisionLogger = {
  info: (msg) => voidLog(msg),
  warn: (msg) => voidWarn(msg),
};

/**
 * Env vars that move the Cloudflare CLI's API transport to another endpoint or select another
 * config env. Provisioning pins one base ({@link provisionEnv}) and rejects them in project
 * dotenv.
 */
const TRANSPORT_REDIRECT_ENV_VARS = [
  'CLOUDFLARE_API_BASE_URL',
  'CF_API_BASE_URL',
  'WRANGLER_API_ENVIRONMENT',
  'CLOUDFLARE_COMPLIANCE_REGION',
  'CLOUDFLARE_ENV',
] as const;

/**
 * Session-output file variables. Provisioning keeps operation output off disk, so they are
 * scrubbed from the child env and rejected in project dotenv. Secrets travel over stdin.
 */
const OUTPUT_FILE_ENV_VARS = [
  'WRANGLER_OUTPUT_FILE_PATH',
  'WRANGLER_OUTPUT_FILE_DIRECTORY',
] as const;

/**
 * The one API base URL this provision uses, resolved like wrangler's `getCloudflareApiBaseUrl`
 * so the Hyperdrive REST lister and the Cloudflare CLI agree:
 *   1. a present `CLOUDFLARE_API_BASE_URL` (then `CF_API_BASE_URL`) is used as-is, even empty;
 *   2. otherwise the staging and compliance selectors derive it, and invalid values fail;
 *   3. the config's `compliance_region` is always validated.
 */
export function resolvePinnedApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  configComplianceRegion?: string,
): string {
  const configRegion =
    configComplianceRegion !== undefined
      ? assertComplianceChoice(configComplianceRegion, 'the Cloudflare config "compliance_region"')
      : undefined;
  const direct =
    env.CLOUDFLARE_API_BASE_URL !== undefined ? env.CLOUDFLARE_API_BASE_URL : env.CF_API_BASE_URL;
  if (direct !== undefined) {
    return direct;
  }
  const region = resolveComplianceRegion(env, configRegion);
  const fed = region === 'fedramp_high' ? '.fed' : '';
  const staging = resolveApiEnvironment(env) === 'staging' ? '.staging' : '';
  return `https://api${fed}${staging}.cloudflare.com/client/v4`;
}

/** `WRANGLER_API_ENVIRONMENT` like wrangler: absent means production; other values fail. */
function resolveApiEnvironment(env: NodeJS.ProcessEnv): 'production' | 'staging' {
  const raw = env.WRANGLER_API_ENVIRONMENT;
  if (raw === undefined) {
    return 'production';
  }
  if (raw !== 'production' && raw !== 'staging') {
    throw new Error(
      `provision: the WRANGLER_API_ENVIRONMENT environment variable must be one of ` +
        `"production" or "staging", got ${JSON.stringify(raw)}. The Cloudflare tooling rejects ` +
        `this value, so provisioning refuses to guess an endpoint; fix or unset it and retry.`,
    );
  }
  return raw;
}

/** Compliance-region values wrangler accepts. */
const COMPLIANCE_REGIONS = ['public', 'fedramp_high'] as const;
type ComplianceRegion = (typeof COMPLIANCE_REGIONS)[number];

function assertComplianceChoice(value: string, source: string): ComplianceRegion {
  if (value !== 'public' && value !== 'fedramp_high') {
    throw new Error(
      `provision: ${source} must be one of ${COMPLIANCE_REGIONS.map((c) => JSON.stringify(c)).join(
        ' or ',
      )}, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/** Effective compliance region like wrangler: values are validated and a conflict fails. */
function resolveComplianceRegion(
  env: NodeJS.ProcessEnv,
  configRegion: ComplianceRegion | undefined,
): ComplianceRegion {
  const rawEnv = env.CLOUDFLARE_COMPLIANCE_REGION;
  const envRegion =
    rawEnv !== undefined
      ? assertComplianceChoice(rawEnv, 'the CLOUDFLARE_COMPLIANCE_REGION environment variable')
      : undefined;
  if (envRegion !== undefined && configRegion !== undefined && envRegion !== configRegion) {
    throw new Error(
      `provision: the Cloudflare compliance region is set to conflicting values — the ` +
        `CLOUDFLARE_COMPLIANCE_REGION environment variable is ${JSON.stringify(envRegion)} but the ` +
        `Cloudflare config "compliance_region" is ${JSON.stringify(configRegion)}. The Cloudflare ` +
        `tooling refuses to run with a mismatched compliance region; reconcile them (remove one, or ` +
        `set them equal) and retry.`,
    );
  }
  return envRegion ?? configRegion ?? 'public';
}

/** Project dotenv files the fence scans for `env`; provisioning selects no named env (`''`). */
function defaultWranglerEnvFiles(env: string): Array<string> {
  return ['.env', '.env.local', `.env.${env}`, `.env.${env}.local`];
}

/**
 * Fail when a project dotenv file sets a transport-redirect or session-output variable.
 * Cloudflare tooling reads these files from the project, which would move its authenticated
 * transport away from the pinned base. Values exported in the shell are honored instead.
 */
export function assertNoTransportRedirectInProjectDotenv(
  root: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // Scan the project dotenv and dev-vars files with these case rules:
  //   - all four dotenv files; keys fold case only on win32;
  //   - `.dev.vars.` if present, else `.dev.vars`; keys are always case-sensitive.
  const dotenvCaseInsensitive = platform === 'win32';
  const devVarsFile = existsSync(join(root, '.dev.vars.')) ? '.dev.vars.' : '.dev.vars';
  const files: Array<{ file: string; caseInsensitive: boolean }> = [
    ...defaultWranglerEnvFiles('').map((file) => ({
      file,
      caseInsensitive: dotenvCaseInsensitive,
    })),
    { file: devVarsFile, caseInsensitive: false },
  ];
  for (const { file, caseInsensitive } of files) {
    const keys = scanWranglerDotenvKeys(join(root, file));
    const lowerKeys = caseInsensitive
      ? new Set([...keys].map((key) => key.toLowerCase()))
      : undefined;
    const declares = (name: string): boolean =>
      lowerKeys !== undefined ? lowerKeys.has(name.toLowerCase()) : keys.has(name);
    const offenders = TRANSPORT_REDIRECT_ENV_VARS.filter(declares);
    if (offenders.length > 0) {
      throw new Error(
        `provision: refusing to provision — the project file "${file}" sets ` +
          `${offenders.join(', ')}, which Cloudflare tooling reads from project files and would redirect its ` +
          `authenticated Cloudflare API transport (and credentials) to a different endpoint/account ` +
          `than this provision is pinned to (the Hyperdrive existence check would then run against a ` +
          `DIFFERENT endpoint, risking cross-environment writes or duplicate resources). Remove ` +
          `${offenders.join(', ')} from "${file}" and, if you truly need a non-default endpoint, ` +
          `export it in your shell/CI environment instead — that pin IS honored for both the ` +
          `Cloudflare operations and the existence check.`,
      );
    }
    // Session output files are not allowed while provisioning.
    const outputOffenders = OUTPUT_FILE_ENV_VARS.filter(declares);
    if (outputOffenders.length > 0) {
      throw new Error(
        `provision: refusing to provision — the project file "${file}" sets ` +
          `${outputOffenders.join(', ')}. Void does not allow Cloudflare session output files ` +
          `during provisioning. Remove ${outputOffenders.join(', ')} from "${file}".`,
      );
    }
  }
}

/**
 * Delete `name` from `env` in place. Windows env keys are case-insensitive, so every spelling
 * is removed there; elsewhere only the exact key.
 */
export function deleteEnvVarCaseAware(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    delete env[name];
    return;
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) {
      delete env[key];
    }
  }
}

/**
 * Child env for a Cloudflare operation. CF Access credentials, transport selectors and output
 * sinks are scrubbed; the account, API base and sanitized logging are pinned.
 */
export function provisionEnv(ctx?: {
  accountId?: string;
  apiBaseUrl?: string;
  apiToken?: string;
  /** Test seam for the win32 case rule; production always uses the real platform. */
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const platform = ctx?.platform ?? process.platform;
  const scrub = (name: string): void => deleteEnvVarCaseAware(env, name, platform);
  scrub('CF_ACCESS_CLIENT_ID');
  scrub('CF_ACCESS_CLIENT_SECRET');
  scrub('CF_ACCESS_TOKEN');
  scrub('VOID_ACCESS_CREDENTIALS');
  scrub('VOID_ACCESS_ORIGIN');
  for (const name of TRANSPORT_REDIRECT_ENV_VARS) {
    scrub(name);
  }
  // Scrub output sinks and pin sanitized logging (a truthy value survives the dotenv reload).
  for (const name of OUTPUT_FILE_ENV_VARS) {
    scrub(name);
  }
  scrub('WRANGLER_LOG_SANITIZE');
  env.WRANGLER_LOG_SANITIZE = 'true';
  // Pinned by presence: an empty base stays empty, so wrangler fails the same way.
  if (ctx?.apiBaseUrl !== undefined) {
    env.CLOUDFLARE_API_BASE_URL = ctx.apiBaseUrl;
  }
  // Pin the account so wrangler never prompts or falls back to an ambient account.
  if (ctx?.accountId) {
    scrub('CLOUDFLARE_ACCOUNT_ID');
    env.CLOUDFLARE_ACCOUNT_ID = ctx.accountId;
  }
  if (ctx?.apiToken) {
    for (const name of [
      'CLOUDFLARE_API_TOKEN',
      'CF_API_TOKEN',
      'CLOUDFLARE_API_KEY',
      'CF_API_KEY',
      'CLOUDFLARE_EMAIL',
      'CF_EMAIL',
    ]) {
      scrub(name);
    }
    env.CLOUDFLARE_API_TOKEN = ctx.apiToken;
  }
  return env;
}

/** Per-command timeout; the default runner SIGKILLs a child that runs longer. */
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * After a SIGKILL, how long to wait for both `close` and the whole process group to be gone.
 * If that cannot be confirmed, the runner rejects with {@link WranglerQuarantineError}.
 */
const CONFIRM_KILL_GRACE_MS = 5_000;
/** The pid-poll interval while confirming post-SIGKILL termination. */
const CONFIRM_KILL_POLL_MS = 20;
/** Extra time a signal teardown allows beyond a runner's confirmation window. */
const SIGNAL_TEARDOWN_DEADLINE_MARGIN_MS = 5_000;

/** ESRCH means the group already exited; any other kill error is a real failure. */
export function isAlreadyGoneKillError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH';
}

/**
 * The runner could not confirm that a spawned child and its process group are dead. The child
 * may still be creating resources, so the provision lock is kept instead of released.
 */
export class WranglerQuarantineError extends Error {
  readonly quarantine = true as const;
  readonly pid: number | undefined;
  constructor(pid: number | undefined, detail: string) {
    const pidLabel = pid !== undefined ? ` (pid ${pid})` : '';
    super(
      `provision: the spawned Cloudflare operation process could not be confirmed terminated${pidLabel} — ${detail}. ` +
        `It may still be running and creating resources, so the cross-process provision lock is ` +
        `intentionally RETAINED (not released) and its owner is recorded in a quarantine sidecar ` +
        `("<Cloudflare config>.void-provision.lock.quarantine.json") that blocks concurrent ` +
        `provisions. Recovery: verify the process${pidLabel} is dead (e.g. \`kill -0 <pid>\`; ` +
        `terminate it if not) — the NEXT provision then confirms the recorded group is gone and ` +
        `clears the quarantine automatically. To clear it manually instead, remove the sidecar ` +
        `and the "<Cloudflare config>.void-provision.lock.lock" directory, then re-run.`,
    );
    this.name = 'WranglerQuarantineError';
    this.pid = pid;
  }
}

/** Quarantine owner metadata: the child's pid (its process-group id on POSIX) and a reason. */
export interface QuarantineInfo {
  pid?: number;
  reason: string;
}

// At most one provision runs per process, so the signal coordinator manages at most one
// {child group, provision lock} pair. Other processes are serialized by the on-disk lock.
let activeProvisionSlot: symbol | undefined;

function acquireProcessProvisionSlot(): () => void {
  if (activeProvisionSlot !== undefined) {
    throw new Error(
      'provision: a provision is already active in this process — run provisions ' +
        'sequentially. provisionCloudflareResources supports at most one concurrent ' +
        'provision per process; concurrent provisions across PROCESSES are serialized ' +
        'by the on-disk provision lock instead.',
    );
  }
  // A previous provision's watchdog still holds a lock that is not durably quarantined.
  if (retentionWatchdog !== undefined) {
    throw new Error(
      'provision: a previous provision in this process is still retaining its lock — an ' +
        `unconfirmed Cloudflare operation process` +
        `${retentionWatchdog.info.pid !== undefined ? ` (pid ${retentionWatchdog.info.pid})` : ''} ` +
        'could not be quarantined durably yet. No new provision may start until that ' +
        'retention resolves (the child is confirmed dead, or the quarantine metadata ' +
        'persists durably).',
    );
  }
  const token = Symbol('void-provision-slot');
  activeProvisionSlot = token;
  return () => {
    if (activeProvisionSlot === token) {
      activeProvisionSlot = undefined;
    }
  };
}

/**
 * The active provision's lock-quarantine hook. A child captures it at registration, so a
 * failed teardown quarantines only its own provision lock with its own pid.
 */
let activeProvisionQuarantineHook: ((info: QuarantineInfo) => void) | undefined;

/** True when `error` is a quarantine failure whose provision lock must stay retained. */
export function isQuarantineError(error: unknown): error is WranglerQuarantineError {
  return (
    error instanceof WranglerQuarantineError ||
    (error as { quarantine?: boolean } | null)?.quarantine === true
  );
}

// Process-wide signal coordinator. On the first SIGINT/SIGTERM it forwards the signal to the
// registered child group, waits (bounded) for confirmed termination, quarantines the lock if
// that fails, then re-raises once. Repeated signals are coalesced and new spawns are rejected.

/** What a runner registers with the coordinator for its child's lifetime. */
interface TerminationRegistrant {
  /** The child's pid (its process-GROUP id on POSIX), for quarantine metadata. */
  pid: () => number | undefined;
  /** Forward `signal` to the child's whole process group (see the runner's signalGroup). */
  signalGroup: (signal: NodeJS.Signals) => 'signaled' | 'gone' | { error: Error };
  /** Record that the group is already confirmed gone (an ESRCH outcome of the forward). */
  markGroupGone: () => void;
  /** Start the runner's bounded both-facts confirmation; exactly one callback fires. */
  awaitConfirmedDead: (
    onDone: (outcome: { confirmed: true } | { confirmed: false; detail: string }) => void,
  ) => void;
  /** Reject the runner promise with a quarantine error (idempotent once settled). */
  quarantine: (detail: string) => void;
  /** After this deadline the coordinator quarantines the pair itself. */
  teardownDeadlineMs: number;
}

/** A registrant bound to its owning provision lock's quarantine hook. */
interface ActiveRegistration {
  registrant: TerminationRegistrant;
  lockQuarantine: ((info: QuarantineInfo) => void) | undefined;
  parallelWorkerUpload: boolean;
}

interface CoordinatorTeardown {
  signal: NodeJS.Signals;
  /** Pre-accounted from the registration snapshot BEFORE dispatch. */
  pending: number;
  /** True while the initial dispatch is still running (finish latch). */
  dispatching: boolean;
  persistFailed: boolean;
  finished: boolean;
  /** The coordinator-wide deadline backstop (referenced; cleared at finish). */
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  /** Expire every still-pending pair at the deadline (each has its own done flag). */
  expirePendingPairs: Array<(detail: string) => void>;
}

/** Concurrent registrations are allowed only for two immutable Worker uploads. */
const activeRegistrations = new Map<TerminationRegistrant, ActiveRegistration>();
let coordinatorListenersInstalled = false;
let activeTeardown: CoordinatorTeardown | undefined;
let reRaisedOnce = false;

const onCoordinatorSigint = (): void => coordinatorHandleSignal('SIGINT');
const onCoordinatorSigterm = (): void => coordinatorHandleSignal('SIGTERM');

function installCoordinatorListeners(): void {
  if (coordinatorListenersInstalled) {
    return;
  }
  coordinatorListenersInstalled = true;
  process.on('SIGINT', onCoordinatorSigint);
  process.on('SIGTERM', onCoordinatorSigterm);
}

function removeCoordinatorListeners(): void {
  if (!coordinatorListenersInstalled) {
    return;
  }
  coordinatorListenersInstalled = false;
  process.removeListener('SIGINT', onCoordinatorSigint);
  process.removeListener('SIGTERM', onCoordinatorSigterm);
}

function canRegisterRunner(parallelWorkerUpload: boolean): boolean {
  return (
    activeRegistrations.size === 0 ||
    (parallelWorkerUpload &&
      activeProvisionQuarantineHook === undefined &&
      activeRegistrations.size < 2 &&
      [...activeRegistrations.values()].every((entry) => entry.parallelWorkerUpload))
  );
}

function registerRunner(registrant: TerminationRegistrant, parallelWorkerUpload: boolean): void {
  // The pre-spawn check and registration run in one synchronous block.
  if (!canRegisterRunner(parallelWorkerUpload)) {
    throw new Error(
      'provision: internal invariant violated — a Cloudflare child tried to register outside its concurrency limit',
    );
  }
  activeRegistrations.set(registrant, {
    registrant,
    // Undefined outside a provision: there is no lock to retain.
    lockQuarantine: activeProvisionQuarantineHook,
    parallelWorkerUpload,
  });
  installCoordinatorListeners();
}

function deregisterRunner(registrant: TerminationRegistrant): void {
  activeRegistrations.delete(registrant);
  // Keep listeners during a teardown (to coalesce signals) and while a watchdog holds a lock.
  if (
    activeRegistrations.size === 0 &&
    activeTeardown === undefined &&
    retentionWatchdog === undefined
  ) {
    removeCoordinatorListeners();
  }
}

function coordinatorHandleSignal(signal: NodeJS.Signals): void {
  // Coalesce repeated signals during a teardown.
  if (activeTeardown !== undefined) {
    return;
  }
  // Dying now would let the exit sweep release a lock the watchdog must keep.
  if (retentionWatchdog !== undefined && activeRegistrations.size === 0) {
    process.stderr.write(
      `provision: ignoring ${signal} — a provision lock is retained while an unconfirmed ` +
        `Cloudflare operation process may live and its quarantine metadata is not yet durable. The ` +
        `process exits once the child is confirmed dead or the metadata persists.\n`,
    );
    return;
  }
  const teardown: CoordinatorTeardown = {
    signal,
    pending: 0,
    dispatching: true,
    persistFailed: false,
    finished: false,
    deadlineTimer: undefined,
    expirePendingPairs: [],
  };
  activeTeardown = teardown;
  // Count every registrant before dispatch, so a synchronous settle cannot finish early.
  const snapshot = [...activeRegistrations.values()];
  teardown.pending = snapshot.length;
  if (snapshot.length > 0) {
    // Backstop: quarantine any pair still unconfirmed at the deadline. Referenced on purpose.
    const deadlineMs = Math.max(...snapshot.map((r) => r.registrant.teardownDeadlineMs));
    teardown.deadlineTimer = setTimeout(() => {
      for (const expire of teardown.expirePendingPairs) {
        expire(
          `the coordinator-wide ${deadlineMs}ms teardown deadline expired before the process ` +
            `group's termination was confirmed`,
        );
      }
    }, deadlineMs);
  }
  for (const registration of snapshot) {
    coordinatorTearDownRegistrant(teardown, registration);
  }
  teardown.dispatching = false;
  maybeFinishCoordinatorTeardown(teardown);
}

/** Finish after dispatch completes and every registrant is resolved. */
function maybeFinishCoordinatorTeardown(teardown: CoordinatorTeardown): void {
  if (!teardown.dispatching && teardown.pending === 0) {
    finishCoordinatorTeardown(teardown);
  }
}

function coordinatorTearDownRegistrant(
  teardown: CoordinatorTeardown,
  registration: ActiveRegistration,
): void {
  const { registrant, lockQuarantine } = registration;
  let done = false;
  const complete = (): void => {
    if (done) {
      return;
    }
    done = true;
    teardown.pending -= 1;
    maybeFinishCoordinatorTeardown(teardown);
  };
  const quarantinePair = (detail: string): void => {
    if (done) {
      return;
    }
    // Synchronous: the sidecar must persist before a re-raise can end the process.
    if (lockQuarantine !== undefined) {
      try {
        lockQuarantine({
          pid: registrant.pid(),
          reason:
            `the spawned Cloudflare operation process could not be confirmed terminated after a forwarded ` +
            `${teardown.signal} — ${detail}`,
        });
      } catch (failure) {
        // Not durable: the watchdog now owns the lock, so the finish must not re-raise.
        teardown.persistFailed = true;
        process.stderr.write(`provision: ${(failure as Error).message}\n`);
      }
    }
    const pid = registrant.pid();
    process.stderr.write(
      `provision: warning — the Cloudflare operation process group` +
        `${typeof pid === 'number' ? ` (pid ${pid})` : ''} could not be confirmed terminated ` +
        `after ${teardown.signal} (${detail}). It may still be running; the provision lock is ` +
        `retained (quarantined) — verify the process is dead before re-running provision.\n`,
    );
    registrant.quarantine(detail);
    complete();
  };
  // The coordinator-wide deadline expires the pair through the same idempotent path.
  teardown.expirePendingPairs.push(quarantinePair);
  const outcome = registrant.signalGroup(teardown.signal);
  if (typeof outcome === 'object') {
    quarantinePair(`the process group could not be signalled: ${outcome.error.message}`);
    return;
  }
  if (outcome === 'gone') {
    registrant.markGroupGone();
  }
  registrant.awaitConfirmedDead((result) => {
    if (result.confirmed) {
      complete();
    } else {
      quarantinePair(result.detail);
    }
  });
}

function finishCoordinatorTeardown(teardown: CoordinatorTeardown): void {
  if (teardown.finished) {
    return;
  }
  teardown.finished = true;
  if (teardown.deadlineTimer !== undefined) {
    clearTimeout(teardown.deadlineTimer);
  }
  // Remove the listeners so the re-raise takes Node's default action.
  removeCoordinatorListeners();
  if (teardown.persistFailed || retentionWatchdog !== undefined) {
    // A lock is not durably quarantined; re-raising would let the exit sweep release it.
    activeTeardown = undefined;
    installCoordinatorListeners();
    process.stderr.write(
      `provision: NOT re-raising ${teardown.signal} — a provision lock's quarantine ` +
        `metadata could not be persisted, so the lock is intentionally still held by this ` +
        `process to keep it from being stolen while the unconfirmed Cloudflare operation ` +
        `process may live.\n`,
    );
    return;
  }
  // Re-raise exactly once.
  if (reRaisedOnce) {
    return;
  }
  reRaisedOnce = true;
  process.kill(process.pid, teardown.signal);
  // Signals arrive asynchronously; keep the loop alive so the process cannot exit 0 first.
  setTimeout(() => {}, 2_000);
}

// Retention watchdog for a quarantine that could not be persisted. The lock stays tracked,
// but proper-lockfile's exit sweep would remove it, so a referenced timer keeps the process
// alive. Each tick releases normally if the group is gone, else retries persisting the sidecar.

const RETENTION_RETRY_MIN_MS = 250;
const RETENTION_RETRY_MAX_MS = 5_000;

interface RetentionWatchdogState {
  lock: ProvisionLock;
  info: QuarantineInfo;
  timer: ReturnType<typeof setTimeout>;
}

let retentionWatchdog: RetentionWatchdogState | undefined;

/** Quarantine `lock`; if persisting fails, arm the retention watchdog before rethrowing. */
function retainQuarantinedLock(lock: ProvisionLock, info: QuarantineInfo): void {
  try {
    lock.quarantine(info);
  } catch (error) {
    armRetentionWatchdog(lock, info);
    throw error;
  }
}

function armRetentionWatchdog(lock: ProvisionLock, info: QuarantineInfo): void {
  // At most one provision per process → at most one retention; re-arming is a no-op.
  if (retentionWatchdog !== undefined) {
    return;
  }
  // Surface the retained state LOUDLY, once, naming the pid and the lock path.
  process.stderr.write(
    `provision: warning — quarantine metadata for the unconfirmed Cloudflare operation process` +
      `${info.pid !== undefined ? ` (pid ${info.pid})` : ''} could not be persisted, so the ` +
      `provision lock "${lock.lockTargetPath}.lock" is RETAINED by this process, which stays ` +
      `alive until the child is confirmed dead or the metadata persists durably.\n`,
  );
  installCoordinatorListeners();
  let attempt = 0;
  const resolveWatchdog = (): void => {
    if (retentionWatchdog !== undefined) {
      clearTimeout(retentionWatchdog.timer);
    }
    retentionWatchdog = undefined;
    if (activeRegistrations.size === 0 && activeTeardown === undefined) {
      removeCoordinatorListeners();
    }
  };
  const tick = (): void => {
    // A dead group needs no quarantine: release normally.
    if (info.pid !== undefined) {
      let dead = false;
      try {
        process.kill(process.platform === 'win32' ? info.pid : -info.pid, 0);
      } catch (error) {
        dead = isAlreadyGoneKillError(error);
      }
      if (dead) {
        lock.release().then(
          () => resolveWatchdog(),
          (error: unknown) => {
            process.stderr.write(
              `provision: the retained provision lock could not be released after the ` +
                `child's death was confirmed (${(error as Error).message}); the mutex ` +
                `self-heals once stale.\n`,
            );
            resolveWatchdog();
          },
        );
        return;
      }
    }
    // Retry durable persistence.
    try {
      lock.quarantine(info);
      resolveWatchdog();
      return;
    } catch {
      // Still failing — keep holding the process open and retry with backoff.
    }
    attempt += 1;
    const delay = Math.min(RETENTION_RETRY_MIN_MS * 2 ** attempt, RETENTION_RETRY_MAX_MS);
    if (retentionWatchdog !== undefined) {
      retentionWatchdog.timer = setTimeout(tick, delay); // REFERENCED — holds the process
    }
  };
  retentionWatchdog = { lock, info, timer: setTimeout(tick, RETENTION_RETRY_MIN_MS) };
}

/**
 * Default runner: spawns the typed operation entry ({@link resolveCloudflareOperationArgv})
 * without a shell; secrets go through stdin. It is async so the lock heartbeat keeps running.
 */
export function createDefaultRunWrangler(
  root: string,
  options?: {
    /** Only immutable platform Worker version uploads may share the process with another upload. */
    parallelWorkerUpload?: boolean;
    /** Test seam — the argv launcher. Defaults to the typed operation entry. */
    launcher?: Array<string>;
    /** Test seam — the per-command timeout. Defaults to {@link COMMAND_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Test seam for `process.kill` (a negative pid targets the group). */
    killProcessGroup?: (target: number, signal: NodeJS.Signals) => void;
    /** Test seam for {@link CONFIRM_KILL_GRACE_MS}. */
    confirmKillGraceMs?: number;
    /** Test seam for the coordinator-wide teardown deadline. */
    signalTeardownDeadlineMs?: number;
    /** Test seam to observe the spawned child. */
    onSpawnedChild?: (child: ChildProcess) => void;
  },
): RunWrangler {
  const launcher = options?.launcher ?? resolveCloudflareOperationArgv();
  const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const confirmGraceMs = options?.confirmKillGraceMs ?? CONFIRM_KILL_GRACE_MS;
  const killProcessGroup =
    options?.killProcessGroup ??
    ((target: number, signal: NodeJS.Signals) => process.kill(target, signal));
  const [command, ...prefix] = launcher;
  // POSIX: the child leads its own process group, so a group kill also reaches grandchildren.
  const isWindows = process.platform === 'win32';
  const teardownDeadlineMs =
    options?.signalTeardownDeadlineMs ?? confirmGraceMs + SIGNAL_TEARDOWN_DEADLINE_MARGIN_MS;
  return (args, opts) =>
    new Promise<RunWranglerResult>((resolvePromise, rejectPromise) => {
      const parallelWorkerUpload =
        options?.parallelWorkerUpload === true && args.type === 'versions.upload';
      // The Cloudflare CLI asks only when both its input and output are a terminal.
      const interactive =
        (args.type === 'versions.upload' || args.type === 'worker.deploy') &&
        args.interactive === true;
      // A fatal-signal teardown is in progress: start no new work.
      if (activeTeardown !== undefined) {
        rejectPromise(
          new Error(
            `provision: refusing to spawn a Cloudflare operation process — a fatal ` +
              `${activeTeardown.signal} is being handled and this process is terminating; no new ` +
              `Cloudflare operation may start.`,
          ),
        );
        return;
      }
      // Only two immutable Worker uploads may overlap. This check, the spawn and the
      // registration run in one synchronous block.
      if (!canRegisterRunner(parallelWorkerUpload)) {
        rejectPromise(
          new Error(
            'provision: refusing to spawn a Cloudflare operation process — another one is already ' +
              'active in this process (only two immutable Worker uploads may overlap; all other ' +
              'Cloudflare commands and provisions remain sequential).',
          ),
        );
        return;
      }
      const child = spawn(command, [...prefix, ...encodeCloudflareOperation(args)], {
        cwd: opts.cwd ?? root,
        shell: false,
        env: {
          ...provisionEnv({
            accountId: opts.accountId,
            apiBaseUrl: opts.apiBaseUrl,
            apiToken: opts.apiToken,
          }),
          ...(opts.suppressLogs ? { WRANGLER_WRITE_LOGS: 'false' } : {}),
        },
        stdio: interactive
          ? 'inherit'
          : [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWindows,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let spawned = false;
      let postSpawnError: Error | undefined;
      // Every outcome settles only after two facts: `closed` (the close event fired) and
      // `groupGone` (the whole process group is gone). Otherwise the runner quarantines.
      let closed = false;
      let groupGone = false;
      child.once('spawn', () => {
        spawned = true;
      });
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      // Signal the whole process group; ESRCH counts as already gone.
      const signalGroup = (signal: NodeJS.Signals): 'signaled' | 'gone' | { error: Error } => {
        try {
          if (!isWindows && typeof child.pid === 'number') {
            killProcessGroup(-child.pid, signal); // negative pid → the whole group
            return 'signaled';
          }
          if (isWindows && typeof child.pid === 'number') {
            // Windows has no process groups. Check Node's exit bookkeeping first: until it is
            // set, libuv still holds the process handle, so the pid cannot have been reused.
            if (child.exitCode !== null || child.signalCode !== null) {
              return 'gone';
            }
            // `process.kill` reports ESRCH and EPERM separately; `child.kill()` returns false for both.
            killProcessGroup(child.pid, signal);
            return 'signaled';
          }
          if (child.kill(signal)) {
            return 'signaled';
          }
          // `false` means the signal was not delivered, unless the child already exited.
          if (child.exitCode !== null || child.signalCode !== null) {
            return 'gone';
          }
          return {
            error: new Error(`child.kill(${signal}) returned false (signal not delivered)`),
          };
        } catch (error) {
          return isAlreadyGoneKillError(error) ? 'gone' : { error: error as Error };
        }
      };

      /** True when the whole process group no longer exists (`kill(-pid, 0)` → ESRCH). */
      const probeGroupGone = (): boolean => {
        if (groupGone) {
          return true;
        }
        if (typeof child.pid !== 'number') {
          groupGone = true;
          return true;
        }
        if (isWindows) {
          // libuv's `kill(pid, 0)` is a real liveness check on Windows, and descendants die
          // with libuv's job object. Prefer Node's exit bookkeeping when it is set.
          if (child.exitCode !== null || child.signalCode !== null) {
            groupGone = true;
            return true;
          }
          try {
            process.kill(child.pid, 0);
          } catch (error) {
            groupGone = isAlreadyGoneKillError(error);
          }
          return groupGone;
        }
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          // EPERM: a member exists but cannot be signalled, so it counts as alive.
          groupGone = isAlreadyGoneKillError(error);
        }
        return groupGone;
      };

      const timeoutStderr = (extra?: string): string =>
        [
          stderr,
          `provision: the Cloudflare operation process exceeded the ${timeoutMs}ms command timeout`,
          extra,
        ]
          .filter(Boolean)
          .join('\n');

      const deregisterSelf = (): void => deregisterRunner(registrant);

      const finish = (result: RunWranglerResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(commandTimer);
        deregisterSelf();
        // An interactive process writes to the terminal, so it has no result envelope.
        resolvePromise(interactive ? result : decodeCloudflareOperationResult(result));
      };

      // Reject with a quarantine error: the child could not be confirmed dead.
      const quarantine = (detail: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(commandTimer);
        deregisterSelf();
        rejectPromise(new WranglerQuarantineError(child.pid, detail));
      };

      // Bounded confirmation loop shared by the settle side and the signal side. Poll timers
      // are referenced so the process cannot exit mid-confirmation.
      const confirmPollNudges: Array<() => void> = [];
      const nudgeConfirmPolls = (): void => {
        // A poll never registers new waiters while running, so direct iteration is safe.
        for (const poll of confirmPollNudges) {
          poll();
        }
      };
      const awaitConfirmedDead = (handlers: {
        stopWhenSettled: boolean;
        onConfirmed: () => void;
        onExpiry: () => void;
      }): void => {
        const deadline = Date.now() + confirmGraceMs;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const poll = (): void => {
          clearTimeout(pollTimer); // idempotent under an external nudge
          if (handlers.stopWhenSettled && settled) {
            return;
          }
          if (closed && probeGroupGone()) {
            handlers.onConfirmed();
            return;
          }
          if (Date.now() >= deadline) {
            handlers.onExpiry();
            return;
          }
          pollTimer = setTimeout(poll, CONFIRM_KILL_POLL_MS);
        };
        confirmPollNudges.push(poll);
        poll();
      };

      // Confirm both facts, then resolve; quarantine when the window expires.
      const confirmThenSettle = (makeResult: () => RunWranglerResult, what: string): void => {
        awaitConfirmedDead({
          stopWhenSettled: true,
          onConfirmed: () => finish(makeResult()),
          onExpiry: () =>
            quarantine(
              `the process group could not be confirmed terminated within ${confirmGraceMs}ms ` +
                `of ${what}`,
            ),
        });
      };

      // The signal coordinator forwards parent signals to the group through this registrant.
      const registrant: TerminationRegistrant = {
        pid: () => child.pid,
        signalGroup,
        teardownDeadlineMs,
        markGroupGone: () => {
          // ESRCH ⇒ the whole group already exited — only `close` remains to be seen.
          groupGone = true;
        },
        awaitConfirmedDead: (onDone) => {
          awaitConfirmedDead({
            stopWhenSettled: false,
            onConfirmed: () => onDone({ confirmed: true }),
            onExpiry: () =>
              onDone({
                confirmed: false,
                detail:
                  `the process group did not terminate within ${confirmGraceMs}ms of the ` +
                  `forwarded signal`,
              }),
          });
        },
        quarantine,
      };

      // Hard timeout: SIGKILL the group, then confirm termination before settling.
      const commandTimer = setTimeout(() => {
        timedOut = true;
        const outcome = signalGroup('SIGKILL');
        if (typeof outcome === 'object') {
          // A real kill failure: the child may still be running.
          quarantine(`the process group could not be killed: ${outcome.error.message}`);
          return;
        }
        if (outcome === 'gone') {
          groupGone = true;
        }
        confirmThenSettle(
          () =>
            normalizeRunWranglerResult({
              stdout,
              stderr: timeoutStderr(),
              status: null,
              signal: 'SIGKILL',
            }),
          `the timeout SIGKILL (${timeoutStderr()})`,
        );
      }, timeoutMs);
      // The timer stays referenced, so the process cannot exit 0 mid-command.

      // Node can emit `error` after a successful spawn. Only a genuine pre-spawn failure (no
      // pid, `spawn` never fired) settles directly; any other error goes through confirmation.
      const handleProcessError = (error: Error): void => {
        if (!spawned && typeof child.pid !== 'number') {
          finish(normalizeRunWranglerResult({ stdout, stderr, status: null, signal: null, error }));
          return;
        }
        if (settled || timedOut || postSpawnError !== undefined) {
          // Already settling through another path.
          return;
        }
        postSpawnError = error;
        clearTimeout(commandTimer);
        const outcome = signalGroup('SIGKILL');
        if (typeof outcome === 'object') {
          quarantine(
            `a post-spawn child error (${error.message}) was followed by a failed ` +
              `process-group kill: ${outcome.error.message}`,
          );
          return;
        }
        if (outcome === 'gone') {
          groupGone = true;
        }
        confirmThenSettle(
          () =>
            normalizeRunWranglerResult({
              stdout,
              stderr: [
                stderr,
                `provision: the spawned Cloudflare operation process emitted an error after spawn: ` +
                  `${error.message}`,
              ]
                .filter(Boolean)
                .join('\n'),
              status: null,
              signal: 'SIGKILL',
            }),
          `a post-spawn child error (${error.message}; the group was SIGKILLed)`,
        );
      };
      child.on('error', handleProcessError);
      child.stdin?.on('error', handleProcessError);
      child.on('close', (code, signal) => {
        closed = true;
        if (timedOut || postSpawnError !== undefined) {
          // That path settles once the group is also gone; nudge its poll.
          nudgeConfirmPolls();
          return;
        }
        clearTimeout(commandTimer);
        // `close` alone is not enough: a grandchild with its own stdio can outlive the leader.
        // Settle only once the group is gone, killing any survivors first.
        const makeResult = (): RunWranglerResult =>
          normalizeRunWranglerResult({ stdout, stderr, status: code, signal });
        if (probeGroupGone()) {
          finish(makeResult());
          return;
        }
        const outcome = signalGroup('SIGKILL');
        if (typeof outcome === 'object') {
          quarantine(
            `the child exited (status ${String(code)}) but its process group is still alive ` +
              `and could not be killed: ${outcome.error.message}`,
          );
          return;
        }
        if (outcome === 'gone') {
          groupGone = true;
        }
        confirmThenSettle(
          makeResult,
          `the child's exit (status ${String(code)}; surviving process-group members were ` +
            `SIGKILLed)`,
        );
        // Let the signal-side poll (if any) observe `closed` promptly too.
        nudgeConfirmPolls();
      });

      // Register last, in the same synchronous block as the pre-spawn checks.
      registerRunner(registrant, parallelWorkerUpload);
      options?.onSpawnedChild?.(child);
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input);
      }
    });
}

/**
 * Normalize a finished child into a {@link RunWranglerResult}. A signal, a spawn error or a
 * non-numeric status is a non-zero failure, never success.
 */
export function normalizeRunWranglerResult(result: {
  stdout?: string | null;
  stderr?: string | null;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}): RunWranglerResult {
  const stdout = result.stdout ?? '';
  const notes: Array<string> = [];
  if (result.signal != null) {
    notes.push(
      `provision: the Cloudflare operation process was terminated by signal ${result.signal}`,
    );
  }
  if (result.error != null) {
    notes.push(
      `provision: the Cloudflare operation process could not be spawned: ${result.error.message}`,
    );
  }
  const failed = typeof result.status !== 'number' || result.signal != null || result.error != null;
  // A failure must be non-zero. Keep a genuine non-zero exit code when present;
  // otherwise synthesize `1` (a null/absent status under a signal/spawn error).
  const status = failed
    ? typeof result.status === 'number' && result.status !== 0
      ? result.status
      : 1
    : (result.status as number);
  const baseStderr = result.stderr ?? '';
  const stderr = notes.length > 0 ? [baseStderr, ...notes].filter(Boolean).join('\n') : baseStderr;
  // Keep provenance structured so classifiers can tell a clean failure from a kill.
  return {
    stdout,
    stderr,
    status,
    signal: result.signal ?? null,
    error: result.error != null ? result.error.message : null,
  };
}

/** A signal-killed or unspawned child: its output is never read as success or absence. */
function isHardFailure(result: RunWranglerResult): boolean {
  return result.signal != null || result.error != null;
}

/** The child ran to completion and reported SUCCESS (a clean numeric exit 0). */
function isCleanSuccess(result: RunWranglerResult): boolean {
  return !isHardFailure(result) && result.status === 0;
}

/** A completed child with a non-zero exit: the only result that may mean "not found". */
function isCleanFailure(result: RunWranglerResult): boolean {
  return !isHardFailure(result) && Number.isSafeInteger(result.status) && result.status > 0;
}

/** Overall deadline for the Hyperdrive lister, so a stalled list cannot hold the lock forever. */
const HYPERDRIVE_LIST_TIMEOUT_MS = 60_000;

/** Run `start` under an overall deadline: abort and reject at `ms`, even if it ignores the signal. */
function withListerDeadline<T>(start: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`the existence check exceeded the ${ms}ms deadline`));
    }, ms);
    // Referenced until settled: the lock heartbeat is unref'd, so an unref'd timer could let
    // the process exit 0 while a lister never settles.
    // Defer `start` into the promise chain so a synchronous throw is captured as a rejection.
    Promise.resolve()
      .then(() => start(controller.signal))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * API token for the Hyperdrive REST check: the caller's, else `CLOUDFLARE_API_TOKEN`. Shared by
 * the up-front fence and the default lister so they always agree.
 */
function resolveHyperdriveApiToken(apiToken?: string): string | undefined {
  const token = apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Default Hyperdrive lister over the REST API. Returns `undefined` without a token, so the
 * caller fails closed before a blind create.
 */
function createDefaultListHyperdriveConfigs(apiToken?: string): ListHyperdriveConfigs | undefined {
  const token = resolveHyperdriveApiToken(apiToken);
  if (!token) {
    return undefined;
  }
  return async ({ accountId, apiBaseUrl, signal }) => {
    // Concatenate exactly like wrangler (no trimming, no encoding), so both hit the same URL.
    const perPage = 100;
    const listUrl = (page: number): string =>
      `${apiBaseUrl}/accounts/${accountId}/hyperdrive/configs?page=${page}&per_page=${perPage}`;
    // Read every page and prove the list is complete against `result_info.total_count`. A
    // malformed payload, missing metadata, duplicate id or early empty page fails closed.
    const byId = new Map<string, HyperdriveConfig>();
    let expectedTotal: number | undefined;
    for (let page = 1; ; page++) {
      const res = await fetch(listUrl(page), {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!res.ok) {
        throw new Error(`Cloudflare API returned HTTP ${res.status} listing Hyperdrive configs`);
      }
      const body = (await res.json()) as Record<string, unknown>;
      if (!isRecord(body) || body.success !== true || !Array.isArray(body.result)) {
        throw new Error(
          'Cloudflare API returned an unsuccessful or malformed Hyperdrive configs payload',
        );
      }
      const info = body.result_info;
      const totalCount =
        isRecord(info) && typeof info.total_count === 'number' && Number.isInteger(info.total_count)
          ? info.total_count
          : undefined;
      if (totalCount === undefined || totalCount < 0) {
        throw new Error(
          'Cloudflare API returned Hyperdrive configs without valid pagination metadata ' +
            '(result_info.total_count); cannot prove the list is complete',
        );
      }
      if (expectedTotal === undefined) {
        expectedTotal = totalCount;
      } else if (totalCount !== expectedTotal) {
        throw new Error(
          'Cloudflare API returned inconsistent Hyperdrive pagination totals across pages; ' +
            'cannot prove the list is complete',
        );
      }
      if (body.result.length === 0 && byId.size < expectedTotal) {
        throw new Error(
          'Cloudflare API returned an empty Hyperdrive page before all configs were listed; ' +
            'cannot prove the list is complete',
        );
      }
      for (const entry of body.result) {
        if (
          !isRecord(entry) ||
          typeof entry.id !== 'string' ||
          entry.id.length === 0 ||
          typeof entry.name !== 'string' ||
          entry.name.length === 0
        ) {
          throw new Error(
            'Cloudflare API returned a malformed Hyperdrive config entry (missing id/name)',
          );
        }
        if (byId.has(entry.id)) {
          throw new Error(
            'Cloudflare API returned a duplicate Hyperdrive config id across pages; ' +
              'cannot prove the list is complete',
          );
        }
        byId.set(entry.id, { id: entry.id, name: entry.name });
      }
      if (byId.size > expectedTotal) {
        throw new Error(
          'Cloudflare API returned more Hyperdrive configs than result_info.total_count; ' +
            'cannot prove the list is complete',
        );
      }
      // Each page adds at least one new id, so the loop ends.
      if (byId.size === expectedTotal) {
        break;
      }
    }
    return [...byId.values()];
  };
}

/**
 * Validate a Hyperdrive list from any lister and return the config named `name`, if any. A
 * malformed member, a bad or duplicate id, or more than one match fails closed.
 */
function selectHyperdriveMatch(
  configs: Array<unknown>,
  name: string,
  configPath: string,
): HyperdriveConfig | undefined {
  const seenIds = new Set<string>();
  const validated: Array<HyperdriveConfig> = [];
  for (const config of configs) {
    if (
      !isRecord(config) ||
      typeof config.id !== 'string' ||
      config.id.length === 0 ||
      typeof config.name !== 'string' ||
      config.name.length === 0
    ) {
      throw new Error(
        `provision: the Hyperdrive existence check returned a malformed config entry (each must be ` +
          `an object with a non-empty string id and name). Cannot verify whether ` +
          `${JSON.stringify(name)} already exists; refusing to create a possible duplicate.`,
      );
    }
    if (!isRealHyperdriveId(config.id)) {
      throw new Error(
        `provision: the Hyperdrive existence check returned a config ` +
          `${JSON.stringify(config.name)} with a malformed id ${JSON.stringify(config.id)} ` +
          `(expected a 32-character hex Hyperdrive id). Cannot verify whether ` +
          `${JSON.stringify(name)} already exists; refusing to create a possible duplicate.`,
      );
    }
    if (seenIds.has(config.id)) {
      throw new Error(
        `provision: the Hyperdrive existence check returned a duplicate config id ` +
          `${JSON.stringify(config.id)}. Cannot verify existing configs; refusing to create a ` +
          `possible duplicate.`,
      );
    }
    seenIds.add(config.id);
    validated.push({ id: config.id, name: config.name });
  }
  const named = validated.filter((c) => c.name === name);
  if (named.length > 1) {
    throw new Error(
      `provision: cannot adopt Hyperdrive config ${JSON.stringify(name)} — ${named.length} configs ` +
        `in this account share that name (ids: ${named.map((c) => c.id).join(', ')}). Hyperdrive ` +
        `names are not account-unique; remove the duplicates or pin the id in "${configPath}", then ` +
        `retry.`,
    );
  }
  return named[0];
}

// Cross-process lock held for the whole provision. It serializes account reconciliation and
// Hyperdrive list→create (names are not unique), so a second run sees the first run's writes.

interface ProvisionLock {
  /** The synthetic lock target (`<configPath>.void-provision.lock`), for diagnostics. */
  readonly lockTargetPath: string;
  /** Drop the mutex. Rejects on a real unlock failure; repeated calls share one promise. */
  release: () => Promise<void>;
  /**
   * Keep the mutex on disk past this process's exit, because a child could not be confirmed
   * dead. A durable sidecar is written first; if that fails this throws and the lock stays
   * tracked. Later acquisitions probe the recorded group before taking the lock.
   */
  quarantine: (info: QuarantineInfo) => void;
}

/** The quarantine sidecar path for a lock target. */
function quarantineSidecarPath(lockTarget: string): string {
  return `${lockTarget}.quarantine.json`;
}

/**
 * Persist quarantine metadata durably (temp file, fsync, rename, directory fsync), then read it
 * back. Throws on any failure.
 */
function writeQuarantineSidecar(
  sidecarPath: string,
  info: QuarantineInfo,
  dirDurability?: ProvisionLockOptions['dirDurability'],
): void {
  const payload = JSON.stringify(
    {
      pid: info.pid ?? null,
      pgid: process.platform === 'win32' ? null : (info.pid ?? null),
      reason: info.reason,
      quarantinedAt: new Date().toISOString(),
      quarantinedBy: process.pid,
      // A recovery may only clear the exact generation it inspected.
      generation: `${randomUUID()}.${process.hrtime.bigint().toString()}`,
    },
    null,
    2,
  );
  const tmpPath = `${sidecarPath}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmpPath, 'w');
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, sidecarPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort temp cleanup — the write failure below is the real signal.
    }
    throw error;
  }
  // Fsync the directory so the rename survives a crash. Errors that mean "directory fsync is
  // unsupported here" (Windows, some mounts) are ignored; any other error rolls back and throws.
  const dirOpen = dirDurability?.openSync ?? openSync;
  const dirFsync = dirDurability?.fsyncSync ?? fsyncSync;
  const dirClose = dirDurability?.closeSync ?? closeSync;
  try {
    const dirFd = dirOpen(dirname(sidecarPath), 'r');
    try {
      dirFsync(dirFd);
    } finally {
      dirClose(dirFd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'ENOSYS'].includes(code)) {
      try {
        unlinkSync(sidecarPath);
      } catch {
        // Best-effort rollback; a leftover sidecar only makes the gate stricter.
      }
      throw error;
    }
    // Platform-unsupported directory fsync — the read-back below is still required.
  }
  // VERIFY: the durable marker must be present and carry the recorded owner.
  const readBack: unknown = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
  if (
    !isRecord(readBack) ||
    readBack.pid !== (info.pid ?? null) ||
    readBack.reason !== info.reason
  ) {
    throw new Error(`the quarantine sidecar "${sidecarPath}" did not verify after writing`);
  }
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Quarantine gate, run under the recovery mutex before each lock attempt. With a sidecar
 * present, the recorded group is probed: confirmed dead clears the sidecar, alive or unknown
 * fails closed. Only the sidecar generation that was inspected is cleared; the mutex directory
 * is left for proper-lockfile's stale handling, since removing it by hand could race another
 * acquirer.
 */
function assertQuarantineClearedOrClear(lockTarget: string, onBeforeClear?: () => void): void {
  const sidecarPath = quarantineSidecarPath(lockTarget);
  if (!existsSync(sidecarPath)) {
    return;
  }
  let recorded: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    recorded = isRecord(parsed) ? parsed : undefined;
  } catch {
    recorded = undefined;
  }
  const pid = readPositiveInt(recorded?.pid);
  const pgid = readPositiveInt(recorded?.pgid);
  const reason = typeof recorded?.reason === 'string' ? recorded.reason : undefined;
  const quarantinedAt =
    typeof recorded?.quarantinedAt === 'string' ? recorded.quarantinedAt : undefined;
  // Probe the group (negative pid) on POSIX only: on win32 a negative pid reports ESRCH for
  // any process, which would clear a live quarantine.
  const probeTarget = pgid !== undefined && process.platform !== 'win32' ? -pgid : (pid ?? pgid);
  let confirmedDead = false;
  if (probeTarget !== undefined) {
    try {
      process.kill(probeTarget, 0);
      // Signal 0 succeeded — some member of the recorded group still exists → alive.
    } catch (error) {
      confirmedDead = isAlreadyGoneKillError(error);
      // EPERM/other — the probe could not be performed → treat as possibly alive.
    }
  }
  if (!confirmedDead) {
    const who =
      pid !== undefined || pgid !== undefined
        ? `process group ${String(pgid ?? pid)}`
        : 'an unrecorded process';
    throw new Error(
      `provision: refusing to provision — a previous provision QUARANTINED this config's lock ` +
        `because a spawned Cloudflare operation process could not be confirmed terminated (${who}` +
        `${quarantinedAt ? `, quarantined at ${quarantinedAt}` : ''}` +
        `${reason ? `; reason: ${reason}` : ''}). It may still be creating resources. Verify the ` +
        `process is dead (e.g. \`kill -0 ${String(pid ?? '<pid>')}\`; terminate it if not) and ` +
        `re-run — the quarantine then clears automatically. If you are CERTAIN the recorded ` +
        `process is unrelated (pid reuse) or gone, remove "${sidecarPath}" and the ` +
        `"${lockTarget}.lock" directory manually, then retry.`,
    );
  }
  // Clear only if the sidecar still has the generation inspected above: the current lock
  // holder may have written a newer one meanwhile.
  const inspectedGeneration =
    typeof recorded?.generation === 'string' ? recorded.generation : undefined;
  onBeforeClear?.();
  let current: Record<string, unknown> | undefined;
  try {
    const reread: unknown = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    current = isRecord(reread) ? reread : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Concurrently cleared — nothing left to remove; proceed to normal acquisition.
      return;
    }
    // Unreadable at the re-read → the generation cannot be verified → fail closed below.
    current = undefined;
  }
  const currentGeneration =
    typeof current?.generation === 'string' ? current.generation : undefined;
  if (current === undefined || currentGeneration !== inspectedGeneration) {
    throw new Error(
      `provision: refusing to clear the quarantine sidecar "${sidecarPath}" — it changed while ` +
        `this recovery decision was being made (a newer quarantine generation was persisted). ` +
        `Re-run to re-evaluate the current quarantine.`,
    );
  }
  try {
    unlinkSync(sidecarPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // Another acquirer cleared it concurrently — proceed to normal acquisition.
  }
}

/**
 * proper-lockfile's internal registry, used only to detach a quarantined lock from its exit
 * sweep and heartbeat. If the internals change, quarantine degrades to "retained until exit".
 */
type ProperLockfileInternals = {
  getLocks?: () => Record<
    string,
    { updateTimeout?: ReturnType<typeof setTimeout>; released?: boolean }
  >;
};

function loadProperLockfileInternals(): ProperLockfileInternals | undefined {
  try {
    return createRequire(import.meta.url)(
      'proper-lockfile/lib/lockfile.js',
    ) as ProperLockfileInternals;
  } catch {
    return undefined;
  }
}

/** `realpathSync` returns backslashes on Windows; normalize so one file has one spelling. */
function toPosixConfigPath(nativePath: string): string {
  return process.platform === 'win32' ? normalize(nativePath) : nativePath;
}

/**
 * Canonical config path, so symlink aliases share one lock identity. A dangling symlink is
 * followed; a missing file canonicalizes its parent directory instead.
 */
function canonicalizeConfigPath(absoluteConfigPath: string, depth = 0): string {
  try {
    return toPosixConfigPath(realpathSync(absoluteConfigPath));
  } catch (error) {
    // Only ENOENT means "not created yet"; other errors are real.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  let linkStat: ReturnType<typeof lstatSync> | undefined;
  try {
    linkStat = lstatSync(absoluteConfigPath);
  } catch {
    linkStat = undefined;
  }
  if (linkStat?.isSymbolicLink()) {
    if (depth >= 40) {
      throw Object.assign(
        new Error(`ELOOP: too many symbolic links while resolving "${absoluteConfigPath}"`),
        { code: 'ELOOP' },
      );
    }
    const target = readlinkSync(absoluteConfigPath);
    return canonicalizeConfigPath(resolve(dirname(absoluteConfigPath), target), depth + 1);
  }
  const dir = dirname(absoluteConfigPath);
  try {
    return join(realpathSync(dir), basename(absoluteConfigPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return absoluteConfigPath;
  }
}

/** proper-lockfile overrides for tests; production uses the defaults. */
export interface ProvisionLockOptions {
  stale?: number;
  update?: number;
  retries?: number | { retries: number; factor?: number; minTimeout?: number; maxTimeout?: number };
  fs?: unknown;
  /** Test seam: runs between a recovery decision and its sidecar clear. */
  onBeforeQuarantineClear?: () => void;
  /** Test seam for the sidecar directory fsync. */
  dirDurability?: {
    openSync?: typeof openSync;
    fsyncSync?: typeof fsyncSync;
    closeSync?: typeof closeSync;
  };
}

/**
 * A lock not refreshed for this long counts as abandoned. A live owner refreshes it every
 * {@link LOCK_UPDATE_MS}; this needs a free event loop, which is why the runner is async.
 */
const LOCK_STALE_MS = 120_000;
/** Refresh interval keeping a live owner's lock fresh (must be < {@link LOCK_STALE_MS}). */
const LOCK_UPDATE_MS = 20_000;
/** Backoff while waiting for a held lock (about a minute). */
const LOCK_RETRIES = { retries: 100, factor: 1.5, minTimeout: 200, maxTimeout: 2_000 } as const;

/** Stale window of the short-lived recovery mutex. */
const RECOVERY_LOCK_STALE_MS = 6_000;

/** Backoff schedule for our own retry loop (proper-lockfile runs with `retries: 0`). */
function normalizeLockRetries(retries: ProvisionLockOptions['retries']): {
  retries: number;
  factor: number;
  minTimeout: number;
  maxTimeout: number;
} {
  if (typeof retries === 'number') {
    return { ...LOCK_RETRIES, retries };
  }
  return {
    retries: retries?.retries ?? LOCK_RETRIES.retries,
    factor: retries?.factor ?? LOCK_RETRIES.factor,
    minTimeout: retries?.minTimeout ?? LOCK_RETRIES.minTimeout,
    maxTimeout: retries?.maxTimeout ?? LOCK_RETRIES.maxTimeout,
  };
}

/** The registry key proper-lockfile uses with `realpath: false` (native separators). */
export function resolveProperLockfileKey(
  file: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? resolveWindowsPath(file) : resolvePosixPath(file);
}

/**
 * Acquire the provision lock (`<configPath>.void-provision.lock.lock`). The lock targets are
 * synthetic paths, so `realpath: false` avoids creating marker files; the config path is
 * already canonical. A compromised lock throws.
 *
 * Each attempt runs under a short recovery mutex: quarantine gate, one non-retrying
 * acquisition, then the gate again under ownership. This loop owns retries, so the gate runs
 * on every attempt and a quarantined lock is never taken over by age.
 */
export async function acquireProvisionLock(
  configPath: string,
  lockOptions?: ProvisionLockOptions,
): Promise<ProvisionLock> {
  const lockTarget = `${configPath}.void-provision.lock`;
  const recoveryTarget = `${lockTarget}.recovery`;
  const staleMs = lockOptions?.stale ?? LOCK_STALE_MS;
  const retryCfg = normalizeLockRetries(lockOptions?.retries);
  const isElocked = (error: unknown): boolean =>
    (error as { code?: string } | null)?.code === 'ELOCKED';
  const backoffDelay = (attempt: number): Promise<void> =>
    new Promise((resolveSleep) =>
      setTimeout(
        resolveSleep,
        Math.min(retryCfg.minTimeout * retryCfg.factor ** attempt, retryCfg.maxTimeout),
      ),
    );
  const acquireOnce = (): ReturnType<typeof lockfile.lock> =>
    lockfile.lock(lockTarget, {
      stale: staleMs,
      update: lockOptions?.update ?? LOCK_UPDATE_MS,
      retries: 0,
      realpath: false,
      ...(lockOptions?.fs !== undefined ? { fs: lockOptions.fs as never } : {}),
      onCompromised: (error) => {
        throw error;
      },
    });
  // The recovery mutex always uses the default fs, never the test seam.
  const acquireRecoveryOnce = (): ReturnType<typeof lockfile.lock> =>
    lockfile.lock(recoveryTarget, {
      stale: RECOVERY_LOCK_STALE_MS,
      retries: 0,
      realpath: false,
      onCompromised: (error) => {
        throw error;
      },
    });
  let release: Awaited<ReturnType<typeof lockfile.lock>> | undefined;
  for (let attempt = 0; ; attempt++) {
    // (0) Recovery mutex; back off while another process holds it.
    let releaseRecovery: Awaited<ReturnType<typeof lockfile.lock>>;
    try {
      releaseRecovery = await acquireRecoveryOnce();
    } catch (error) {
      if (isElocked(error) && attempt < retryCfg.retries) {
        await backoffDelay(attempt);
        continue;
      }
      throw error;
    }
    let mainHeldByOther = false;
    try {
      // (1) Quarantine gate.
      assertQuarantineClearedOrClear(lockTarget, lockOptions?.onBeforeQuarantineClear);
      // (2) One acquisition attempt; a held mutex backs off and loops.
      try {
        release = await acquireOnce();
      } catch (error) {
        if (isElocked(error) && attempt < retryCfg.retries) {
          mainHeldByOther = true; // back off AFTER releasing the recovery mutex
        } else {
          throw error;
        }
      }
      if (!mainHeldByOther) {
        // (3) Revalidate under ownership: the previous holder may have quarantined after
        // the gate ran.
        try {
          assertQuarantineClearedOrClear(lockTarget, lockOptions?.onBeforeQuarantineClear);
        } catch (gateError) {
          let revalidateReleaseError: unknown;
          try {
            await release!();
          } catch (error) {
            revalidateReleaseError = error;
          }
          release = undefined;
          if (revalidateReleaseError !== undefined) {
            throw new AggregateError(
              [gateError, revalidateReleaseError],
              `provision: a quarantine was found right after acquiring the provision lock AND the ` +
                `fresh lock could not be released afterward. Quarantine: ` +
                `${(gateError as Error).message}; release error: ` +
                `${(revalidateReleaseError as Error).message}`,
              { cause: gateError },
            );
          }
          throw gateError;
        }
      }
    } finally {
      try {
        await releaseRecovery();
      } catch {
        // The recovery mutex goes stale within seconds; never fail on its release.
      }
    }
    if (!mainHeldByOther) {
      break;
    }
    await backoffDelay(attempt);
  }
  // One shared release promise. A real unlock failure is surfaced, because the mutex
  // directory may remain; ERELEASED means it was already dropped and counts as success.
  const acquiredRelease = release!;
  let releasePromise: Promise<void> | undefined;
  const doRelease = async (): Promise<void> => {
    try {
      await acquiredRelease();
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'ERELEASED') {
        return;
      }
      throw new Error(
        `provision: failed to release the cross-process provision lock "${lockTarget}.lock" ` +
          `(${(error as Error).message}). The mutex directory may still exist and will block ` +
          `future provisions until it goes stale (~${Math.round(staleMs / 1000)}s). Remove it ` +
          `manually if it persists, then retry.`,
      );
    }
  };
  return {
    lockTargetPath: lockTarget,
    release: () => (releasePromise ??= doRelease()),
    // Detach the lock from proper-lockfile's tracking but keep the mutex directory, so the
    // exit sweep leaves it and the heartbeat stops; the sidecar then guards it.
    quarantine: (info: QuarantineInfo) => {
      // A no-op after a successful release (nothing to retain).
      if (releasePromise !== undefined) {
        return;
      }
      // The sidecar must be durable before detaching; otherwise the lock stays tracked.
      try {
        writeQuarantineSidecar(quarantineSidecarPath(lockTarget), info, lockOptions?.dirDurability);
      } catch (error) {
        throw new Error(
          `provision: could not persist quarantine metadata to ` +
            `"${quarantineSidecarPath(lockTarget)}" (${(error as Error).message}). The ` +
            `cross-process provision lock "${lockTarget}.lock" is intentionally STILL HELD by ` +
            `this process (tracked, heartbeat running) so it cannot go stale and be stolen ` +
            `while the unconfirmed Cloudflare operation process` +
            `${info.pid !== undefined ? ` (pid ${info.pid})` : ''} may still be running. ` +
            `Manual recovery: verify the process is dead` +
            `${info.pid !== undefined ? ` (e.g. \`kill -0 ${info.pid}\`)` : ''} and terminate ` +
            `it if not; the lock is freed when this process exits — remove the ` +
            `"${lockTarget}.lock" directory if it persists, then re-run.`,
        );
      }
      releasePromise = Promise.resolve(); // any later release() is a settled no-op
      const internals = loadProperLockfileInternals();
      const locks = internals?.getLocks?.();
      if (!locks) {
        return; // degraded: retained only until process exit (internals unavailable)
      }
      // Use the native key spelling proper-lockfile stores.
      const key = resolveProperLockfileKey(lockTarget);
      const tracked = locks[key];
      if (tracked) {
        // Mark it released first: an in-flight heartbeat callback then skips it instead of
        // reporting the retained lock as compromised (our onCompromised throws).
        tracked.released = true;
        if (tracked.updateTimeout !== undefined) {
          clearTimeout(tracked.updateTimeout);
        }
        delete locks[key];
      }
    },
  };
}

/** One binding entry, via the strict reader that fails on duplicate or colliding bindings. */
function readBindingEntry(
  configPath: string,
  field: string,
  binding: string,
): Record<string, unknown> | undefined {
  return readProvisionedBindingEntry(readRootConfig(configPath), field, binding, configPath);
}

/**
 * Read the root config fresh (wrangler edits it), without a BOM. A parse error or a non-object
 * fails; a missing file reads as `{}`.
 */
function readRootConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }
  const raw = readFileSync(configPath, 'utf-8');
  const content = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
  const errors: Array<ParseError> = [];
  const parsed = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `provision: cannot read "${configPath}" — it is not valid JSON/JSONC. Fix the file and retry.`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`provision: "${configPath}" must be a JSON object.`);
  }
  return parsed;
}

/** Throw unless a discovery call exited cleanly, so a failed list never means "absent". */
function assertDiscoverySucceeded(result: RunWranglerResult, label: string): void {
  if (!isCleanSuccess(result)) {
    throw new Error(
      `provision: ${label} failed (exit ${String(result.status)}): ` +
        `${result.stderr || result.stdout || 'no output'}. Cannot verify existing resources; ` +
        `refusing to create a possible duplicate.`,
    );
  }
}

/** Field spec describing a Cloudflare list member's required identity. */
interface ResourceListSpec {
  /** Human resource name for messages, e.g. `KV namespace` / `D1 database`. */
  resource: string;
  /** Operation label for messages, e.g. `Cloudflare kv namespace list`. */
  command: string;
  /** Identity check for every member, before name filtering. */
  hasValidId: (member: Record<string, unknown>) => boolean;
  /** Human description of the id requirement for the whole-list rejection message. */
  idRule: string;
  /** The member field carrying the account-matched name/title. */
  nameField: string;
  /** Grammatical label for the name field in messages: `titled` / `named`. */
  nameLabel: string;
}

/**
 * Reject the whole list if any member lacks a non-empty name or a valid id. A malformed member
 * could be the target, so it is never filtered out as "absent".
 */
function validateResourceList(
  list: Array<unknown>,
  spec: ResourceListSpec,
): Array<Record<string, unknown>> {
  const validated: Array<Record<string, unknown>> = [];
  for (const member of list) {
    if (!isRecord(member)) {
      throw new Error(
        `provision: ${spec.command} returned a malformed ${spec.resource} entry (not an object). ` +
          `Cannot verify existing resources; refusing to create a possible duplicate.`,
      );
    }
    const rawName = member[spec.nameField];
    const nameValid = typeof rawName === 'string' && rawName.length > 0;
    const idValid = spec.hasValidId(member);
    if (nameValid && !idValid) {
      throw new Error(
        `provision: ${spec.command} returned a ${spec.resource} ${spec.nameLabel} ` +
          `${JSON.stringify(rawName)} with no valid id (${spec.idRule}). Cannot verify existing ` +
          `resources; refusing to create a possible duplicate.`,
      );
    }
    if (!nameValid) {
      throw new Error(
        `provision: ${spec.command} returned a malformed ${spec.resource} entry with no valid ` +
          `${spec.nameField}. Cannot verify existing resources; refusing to create a possible duplicate.`,
      );
    }
    validated.push(member);
  }
  return validated;
}

/** D1 identity outcome: the requested database, another one, or an ambiguous claim. */
type D1Match = { kind: 'match'; id: string } | { kind: 'claimed-but-invalid' } | { kind: 'other' };

/**
 * Reconcile D1's two id aliases (`database_id`, `uuid`; empty means absent). Valid only when
 * every present alias is a real D1 UUID and all agree.
 */
type D1ReconciledId = { kind: 'id'; id: string } | { kind: 'absent' } | { kind: 'invalid' };

function reconcileD1IdAliases(entry: Record<string, unknown>): D1ReconciledId {
  const present = [entry.database_id, entry.uuid].filter(
    (value) => value !== undefined && value !== '',
  );
  if (present.length === 0) {
    return { kind: 'absent' };
  }
  const ids = new Set<string>();
  for (const value of present) {
    if (!isRealD1Id(value)) {
      return { kind: 'invalid' };
    }
    ids.add(value);
  }
  if (ids.size !== 1) {
    return { kind: 'invalid' };
  }
  return { kind: 'id', id: [...ids][0] };
}

/**
 * Strict D1 identity check shared by `d1 list` and `d1 info`. `other` when no name alias
 * (`name`, `database_name`) equals `requestedName`; `claimed-but-invalid` when one does but the
 * name or id aliases conflict; otherwise `match`.
 */
function normalizeD1(entry: Record<string, unknown> | undefined, requestedName: string): D1Match {
  if (entry === undefined) {
    return { kind: 'other' };
  }
  const names = [entry.name, entry.database_name].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (!names.includes(requestedName)) {
    return { kind: 'other' };
  }
  if (new Set(names).size > 1) {
    return { kind: 'claimed-but-invalid' };
  }
  const reconciled = reconcileD1IdAliases(entry);
  if (reconciled.kind !== 'id') {
    return { kind: 'claimed-but-invalid' };
  }
  return { kind: 'match', id: reconciled.id };
}

/** True when a `d1 create` failure means the name is already taken (code 7502). */
function isAlreadyExistsError(result: RunWranglerResult): boolean {
  return result.errorCode === 7502;
}

/**
 * True only for a completed non-zero probe with the provider's typed not-found result (R2
 * code 10006, or the queue operation's `not-found`). Nothing else counts as absence.
 */
function isConfirmedAbsent(result: RunWranglerResult, kind: 'r2' | 'queue'): boolean {
  return (
    isCleanFailure(result) &&
    (kind === 'r2' ? result.errorCode === 10006 : result.failure === 'not-found')
  );
}

/** Only a completed, typed not-found response confirms queue absence. */
export function isQueueConfirmedAbsent(result: RunWranglerResult): boolean {
  return isConfirmedAbsent(result, 'queue');
}

/** Reuse and post-create verification require clean success and the exact returned name. */
function queueInfoConfirmsExists(result: RunWranglerResult, name: string): boolean {
  return isCleanSuccess(result) && isRecord(result.data) && result.data.name === name;
}

/** Throw when the writer found no D1 entry to attach `migrations_dir` to. */
function assertD1MigrationsDirApplied(
  result: WriteProvisionedWranglerResult,
  binding: string,
  configPath: string,
): void {
  if (result.d1MigrationsDirSkipped) {
    throw new Error(
      `provision: could not set migrations_dir for D1 binding ${JSON.stringify(binding)} — no ` +
        `matching d1_databases entry exists in "${configPath}" after provisioning it. The D1 ` +
        `resource was not written to the config as expected; inspect the file and retry.`,
    );
  }
}

/** Which config field + id key a CONFIG-WRITING create must have populated. */
interface CreatePostcondition {
  /** Config array field the create's `--update-config` upserts into. */
  field: string;
  /** The member key that must hold a REAL (non-placeholder) id afterward. */
  idField: string;
  /** Resource-specific id format check. */
  idValidator: (value: unknown) => value is string;
  /** Field that must equal the requested name (R2 `bucket_name`, D1 `database_name`). */
  nameField?: string;
  /** Human resource name for the message. */
  resource: string;
  /** Operation label for the message. */
  command: string;
}

/**
 * After a create reports success, re-read the config and require a real id, plus the exact
 * name where the name is the identity. A success status alone is not trusted.
 */
function assertCreateWroteRealId(
  configPath: string,
  spec: CreatePostcondition,
  binding: string,
  name: string,
): void {
  const entry = readBindingEntry(configPath, spec.field, binding);
  const idOk = !!entry && spec.idValidator(entry[spec.idField]);
  const nameOk = spec.nameField === undefined || (!!entry && entry[spec.nameField] === name);
  if (!idOk || !nameOk) {
    throw new Error(
      `provision: ${spec.command} ${name} reported success but "${configPath}" does not hold the ` +
        `expected ${spec.resource} for binding ${JSON.stringify(binding)} afterward (need a real ` +
        `${spec.idField}${spec.nameField ? ` and ${spec.nameField} === ${JSON.stringify(name)}` : ''}). ` +
        `The create may have been interrupted or written a different resource. Refusing to record ` +
        `a wrong/unprovisioned resource; inspect the account/config and retry.`,
    );
  }
}

// Two separate name checks:
//   1. An option-injection guard for every argv positional: no empty value, leading `-` or
//      control character (queue names come from filenames).
//   2. Each resource's own Cloudflare naming grammar.

/** True when `value` contains an ASCII control character (0x00–0x1F or 0x7F). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** The universal option-injection guard for ANY Cloudflare operation ARGV positional. */
function assertNoOptionInjection(kind: string, name: string): void {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.startsWith('-') ||
    hasControlChar(name)
  ) {
    throw new Error(
      `provision: refusing to pass an unsafe ${kind} name ${JSON.stringify(name)} to a Cloudflare ` +
        `operation. A ` +
        `name may not be empty, begin with "-" (it would be parsed as a CLI flag), or contain ` +
        `control characters. Rename the resource and retry.`,
    );
  }
}

type ResourceNameKind = 'd1' | 'kvTitle' | 'r2' | 'hyperdrive' | 'queue';

/** Per-resource Cloudflare naming grammar. KV titles may contain spaces and mixed case. */
const RESOURCE_NAME_GRAMMARS: Record<
  ResourceNameKind,
  { re: RegExp; label: string; rule: string }
> = {
  r2: {
    re: R2_BUCKET_NAME_RE,
    label: 'R2 bucket',
    rule: 'be 3–63 characters, contain only lowercase letters, digits and "-", and begin and end with a letter or digit',
  },
  kvTitle: {
    // Control characters and a leading "-" are rejected by assertNoOptionInjection.
    re: /^[\s\S]{1,512}$/,
    label: 'KV namespace',
    rule: 'be 1–512 characters and contain no control characters (spaces are allowed)',
  },
  d1: {
    re: /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
    label: 'D1 database',
    rule: 'be 1–63 characters, start with a letter or digit, and contain only letters, digits, "-" or "_"',
  },
  hyperdrive: {
    re: /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
    label: 'Hyperdrive config',
    rule: 'be 1–63 characters, start with a letter or digit, and contain only letters, digits, "-" or "_"',
  },
  queue: {
    re: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
    label: 'queue',
    rule: 'be 1–63 characters, contain only letters, digits and "-", and begin and end with a letter or digit',
  },
};

/** Validate an argv positional: the option-injection guard, then the resource grammar. */
export function assertValidResourceName(kind: ResourceNameKind, name: string): void {
  assertNoOptionInjection(RESOURCE_NAME_GRAMMARS[kind].label, name);
  const grammar = RESOURCE_NAME_GRAMMARS[kind];
  if (!grammar.re.test(name)) {
    throw new Error(
      `provision: refusing to pass an invalid ${grammar.label} name ${JSON.stringify(name)} to ` +
        `a Cloudflare operation. A ${grammar.label} name must ${grammar.rule}. Rename the ` +
        `resource and retry.`,
    );
  }
}

/** Redactor that replaces the exact connection string and masks any URL userinfo password. */
function createSecretRedactor(connectionString?: string): (text: string) => string {
  return (text) => {
    let out = text;
    if (typeof connectionString === 'string' && connectionString.length > 0) {
      out = out.split(connectionString).join('[REDACTED]');
    }
    out = out.replace(/(\w[\w+.-]*:\/\/[^\s/@:]+:)[^\s@/]+(@)/g, '$1[REDACTED]$2');
    return out;
  };
}

/** Redact a runner rejection, keeping the same Error object so quarantine fields survive. */
function redactRejection(error: unknown, redactText: (text: string) => string): Error {
  if (!(error instanceof Error)) {
    return new Error(redactText(String(error)));
  }
  error.message = redactText(error.message);
  if (typeof error.stack === 'string') {
    error.stack = redactText(error.stack);
  }
  return error;
}

/**
 * Ensure every desired resource exists in the user's Cloudflare account and record its id in
 * the root config, creating or adopting as needed. A binding with a real id is left as is.
 */
export async function provisionCloudflareResources(
  root: string,
  rootWranglerPath: string,
  desired: DesiredResourceSet,
  opts?: ProvisionOptions,
): Promise<ProvisionResult> {
  // Taken synchronously, so two same-tick calls cannot both pass.
  const releaseProvisionSlot = acquireProcessProvisionSlot();
  try {
    return await provisionWithProcessSlot(root, rootWranglerPath, desired, opts);
  } finally {
    releaseProvisionSlot();
  }
}

/** The provision body, run while holding this process's single provision slot. */
async function provisionWithProcessSlot(
  root: string,
  rootWranglerPath: string,
  desired: DesiredResourceSet,
  opts?: ProvisionOptions,
): Promise<ProvisionResult> {
  // One absolute, canonical path for reads, writes, `-c` and the lock, resolved against
  // `root` (wrangler runs there) so symlink aliases share one lock.
  const configPath = canonicalizeConfigPath(resolve(root, rootWranglerPath));

  // One lock for the whole provision, keyed on the local config path. It does not
  // coordinate across machines; provisioning is a single-operator action.
  const lock = await acquireProvisionLock(configPath, opts?.lockOptions);
  // A fatal signal with an unconfirmed child quarantines this lock through the hook.
  const quarantineHook = (info: QuarantineInfo): void => retainQuarantinedLock(lock, info);
  activeProvisionQuarantineHook = quarantineHook;
  // Always release, and never hide a release failure; with a body error, keep both.
  let result: ProvisionResult | undefined;
  let threw = false;
  let bodyError: unknown;
  try {
    result = await provisionCloudflareResourcesLocked(root, configPath, desired, opts);
  } catch (error) {
    threw = true;
    bodyError = error;
  }
  // Every call has settled, so the hook is no longer needed.
  if (activeProvisionQuarantineHook === quarantineHook) {
    activeProvisionQuarantineHook = undefined;
  }
  if (threw) {
    // An unconfirmed child may still be running, so keep the lock.
    if (isQuarantineError(bodyError)) {
      try {
        retainQuarantinedLock(lock, {
          pid: typeof bodyError.pid === 'number' ? bodyError.pid : undefined,
          reason: typeof bodyError.message === 'string' ? bodyError.message : String(bodyError),
        });
      } catch (quarantineError) {
        // Not persisted: the watchdog keeps the lock held. Surface both errors.
        throw new AggregateError(
          [bodyError, quarantineError],
          `provision failed with an unconfirmed Cloudflare operation process AND its quarantine metadata ` +
            `could not be persisted — the cross-process provision lock is intentionally still ` +
            `held by this process (not released, not stealable) while the child may live. ` +
            `Primary error: ` +
            `${bodyError instanceof Error ? bodyError.message : String(bodyError)}; quarantine ` +
            `error: ` +
            `${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}.`,
          { cause: bodyError },
        );
      }
      throw bodyError;
    }
    // A release failure is surfaced together with the body error.
    let releaseError: unknown;
    try {
      await lock.release();
    } catch (error) {
      releaseError = error;
    }
    if (releaseError !== undefined) {
      throw new AggregateError(
        [bodyError, releaseError],
        `provision failed AND the cross-process provision lock could not be released afterward — a ` +
          `leaked mutex may block future provisions. Primary error: ` +
          `${bodyError instanceof Error ? bodyError.message : String(bodyError)}; release error: ` +
          `${releaseError instanceof Error ? releaseError.message : String(releaseError)}.`,
        { cause: bodyError },
      );
    }
    throw bodyError;
  }
  // Body succeeded: a genuine unlock failure (leaked mutex) rejects the provision.
  await lock.release();
  return result as ProvisionResult;
}

/** Injectable seams + settings for {@link provisionCloudflareResources}. */
export interface ProvisionOptions {
  runWrangler?: RunWrangler;
  accountId?: string;
  apiToken?: string;
  /** Test seam for the D1 database-level read-replication update. */
  enableD1ReadReplication?: (context: D1ReplicationContext) => Promise<void>;
  listHyperdriveConfigs?: ListHyperdriveConfigs;
  log?: ProvisionLogger;
  /** Test-only override of the `proper-lockfile` stale/update/retries/fs knobs. */
  lockOptions?: ProvisionLockOptions;
  /** Override the OVERALL Hyperdrive-lister deadline (ms). Defaults to {@link HYPERDRIVE_LIST_TIMEOUT_MS}. */
  listTimeoutMs?: number;
}

export type D1ReplicationContext = {
  databaseId: string;
  accountId: string;
  apiBaseUrl: string;
};

export async function enableD1ReadReplicationViaApi(
  context: D1ReplicationContext,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${context.apiBaseUrl}/accounts/${context.accountId}/d1/database/${context.databaseId}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ read_replication: { mode: 'auto' } }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const envelope = (await response.json().catch(() => null)) as { success?: unknown } | null;
  if (!response.ok || envelope?.success !== true) {
    throw new Error(
      `provision: could not enable D1 read replication for database ${context.databaseId} ` +
        `(Cloudflare API status ${response.status}). The credential needs D1 Edit permission.`,
    );
  }
}

async function reconcileD1(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  write: ProvisionConfigWriter,
  persistCreatedConfig: () => void,
  resources: Array<ProvisionOutcome>,
  log: ProvisionLogger,
  transportAccountId: string,
  transportApiBaseUrl: string,
  opts?: ProvisionOptions,
): Promise<void> {
  if (desired.d1) {
    const { binding, name } = desired.d1;
    const migrationsDir = desired.d1.migrationsDir ?? D1_MIGRATIONS_DIR;
    const entry = readBindingEntry(configPath, 'd1_databases', binding);
    if (entry && isRealD1Id(entry.database_id)) {
      // A stored name that differs from the desired one points at another database.
      const storedName = entry.database_name;
      if (storedName !== undefined && storedName !== name) {
        throw new Error(
          `provision: D1 binding ${JSON.stringify(binding)} in "${configPath}" stores ` +
            `database_name ${JSON.stringify(storedName)} (with a real database_id), but this ` +
            `deploy wants database ${JSON.stringify(name)}. Refusing to reuse a database that ` +
            `contradicts the desired name. Fix "${configPath}" — correct the entry's ` +
            `database_name/database_id (or remove the entry to re-provision) — or rename the ` +
            `desired database, then retry.`,
        );
      }
      // A crash after create may have skipped migrations_dir, so set it on every run.
      const res = write({ d1MigrationsDir: { binding, dir: migrationsDir } });
      assertD1MigrationsDirApplied(res, binding, configPath);
      resources.push({ kind: 'd1', binding, name, action: 'reused', id: entry.database_id });
    } else {
      const listResult = await runWrangler({ type: 'd1.list', configPath }, {});
      assertDiscoverySucceeded(listResult, 'Cloudflare d1 list');
      const rawList = listResult.data;
      if (!Array.isArray(rawList)) {
        throw new Error(
          `provision: Cloudflare d1 list did not return a JSON array; cannot verify whether ` +
            `D1 database ${JSON.stringify(name)} exists. Refusing to create a possible duplicate.`,
        );
      }
      const databases = validateResourceList(rawList, {
        resource: 'D1 database',
        command: 'Cloudflare d1 list',
        hasValidId: (member) => reconcileD1IdAliases(member).kind === 'id',
        idRule:
          'its uuid/database_id aliases must be present, well-formed D1 UUIDs agreeing on one id',
        nameField: 'name',
        nameLabel: 'named',
      });
      // Adopt a single valid claimant; several or an ambiguous one fail closed; none creates.
      const claimants = databases
        .map((db) => normalizeD1(db, name))
        .filter((m): m is Exclude<D1Match, { kind: 'other' }> => m.kind !== 'other');
      if (claimants.length > 1) {
        throw new Error(
          `provision: Cloudflare d1 list returned ${claimants.length} D1 databases named ` +
            `${JSON.stringify(name)}. D1 database names are account-unique, so this is ambiguous; ` +
            `cannot pick one to adopt and refusing to create a possible duplicate. Inspect the ` +
            `account and retry.`,
        );
      }
      if (claimants.length === 1 && claimants[0].kind === 'claimed-but-invalid') {
        throw new Error(
          `provision: Cloudflare d1 list returned a D1 database named ${JSON.stringify(name)} with ` +
            `an ambiguous or empty id (conflicting/blank uuid/database_id, or conflicting name ` +
            `aliases). Cannot adopt it, and refusing to create a possible duplicate; inspect the ` +
            `account and retry.`,
        );
      }
      // After the guards above, a lone claimant is necessarily a valid `match`.
      const existing =
        claimants.length === 1 && claimants[0].kind === 'match' ? claimants[0] : undefined;
      if (existing) {
        log.info(`adopted existing D1 database ${name} (${existing.id})`);
        const res = write({
          d1: { binding, databaseName: name, databaseId: existing.id },
          d1MigrationsDir: { binding, dir: migrationsDir },
        });
        assertD1MigrationsDirApplied(res, binding, configPath);
        resources.push({ kind: 'd1', binding, name, action: 'adopted', id: existing.id });
      } else {
        const created = await runWrangler({ type: 'd1.create', name: name, binding, configPath });
        if (isCleanSuccess(created)) {
          // Verify the id landed, then set migrations_dir.
          assertCreateWroteRealId(
            configPath,
            {
              field: 'd1_databases',
              idField: 'database_id',
              idValidator: isRealD1Id,
              nameField: 'database_name',
              resource: 'D1 database',
              command: 'Cloudflare d1 create',
            },
            binding,
            name,
          );
          persistCreatedConfig();
          const res = write({ d1MigrationsDir: { binding, dir: migrationsDir } });
          assertD1MigrationsDirApplied(res, binding, configPath);
          resources.push({ kind: 'd1', binding, name, action: 'created' });
        } else if (isCleanFailure(created) && isAlreadyExistsError(created)) {
          // Created between list and create (code 7502): adopt only an exact `d1 info` match.
          const infoResult = await runWrangler({ type: 'd1.info', name: name, configPath }, {});
          assertDiscoverySucceeded(infoResult, `Cloudflare d1 info ${name}`);
          const info = normalizeD1(isRecord(infoResult.data) ? infoResult.data : undefined, name);
          if (info.kind !== 'match') {
            throw new Error(
              `provision: Cloudflare d1 create ${name} reported the database already exists, ` +
                `but Cloudflare d1 info ${name} did not return a database with a matching ` +
                `name and an unambiguous id. Refusing to adopt an unverified database.`,
            );
          }
          log.info(`adopted existing D1 database ${name} (${info.id})`);
          const res = write({
            d1: { binding, databaseName: name, databaseId: info.id },
            d1MigrationsDir: { binding, dir: migrationsDir },
          });
          assertD1MigrationsDirApplied(res, binding, configPath);
          resources.push({ kind: 'd1', binding, name, action: 'adopted', id: info.id });
        } else {
          throw new Error(
            `provision: Cloudflare d1 create ${name} failed: ${created.stderr || created.stdout}`,
          );
        }
      }
    }

    // The database-level setting is separate from the Worker binding. A reused
    // database may predate this feature, so converge it on every provision run.
    const databaseId = readBindingEntry(configPath, 'd1_databases', binding)?.database_id;
    if (!isRealD1Id(databaseId)) {
      throw new Error(`provision: D1 binding ${binding} has no real database id after setup.`);
    }
    const context: D1ReplicationContext = {
      databaseId,
      accountId: transportAccountId,
      apiBaseUrl: transportApiBaseUrl,
    };
    if (opts?.enableD1ReadReplication) {
      await opts.enableD1ReadReplication(context);
    } else {
      let token = opts?.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
      if (!token) {
        const auth = await runWrangler({ type: 'auth.token', configPath }, { suppressLogs: true });
        const parsed = isCleanSuccess(auth) && isRecord(auth.data) ? auth.data : undefined;
        if (
          (parsed?.type === 'oauth' || parsed?.type === 'api_token') &&
          typeof parsed.token === 'string'
        ) {
          token = parsed.token;
        }
      }
      if (!token) {
        throw new Error(
          'provision: D1 read replication requires a Cloudflare API bearer with D1 Edit permission. ' +
            'Run `void cloudflare login`, or set CLOUDFLARE_API_TOKEN, then retry.',
        );
      }
      await enableD1ReadReplicationViaApi(context, token);
    }
  }
}

async function reconcileKv(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  write: ProvisionConfigWriter,
  persistCreatedConfig: () => void,
  resources: Array<ProvisionOutcome>,
  log: ProvisionLogger,
): Promise<void> {
  for (const { binding, title } of desired.kvNamespaces) {
    const entry = readBindingEntry(configPath, 'kv_namespaces', binding);
    if (entry && isRealKvId(entry.id)) {
      resources.push({ kind: 'kv', binding, name: title, action: 'reused', id: entry.id });
      continue;
    }
    // KV titles are not unique and create never dedupes, so this list is the only orphan guard.
    const listResult = await runWrangler({ type: 'kv.namespace.list', configPath }, {});
    assertDiscoverySucceeded(listResult, 'Cloudflare kv namespace list');
    const rawList = listResult.data;
    if (!Array.isArray(rawList)) {
      throw new Error(
        `provision: Cloudflare kv namespace list did not return a JSON array; cannot verify whether ` +
          `KV namespace ${JSON.stringify(title)} exists. Refusing to create a possible duplicate.`,
      );
    }
    const namespaces = validateResourceList(rawList, {
      resource: 'KV namespace',
      command: 'Cloudflare kv namespace list',
      hasValidId: (member) => isRealKvId(member.id),
      idRule: 'its id is missing or not a well-formed 32-hex namespace id',
      nameField: 'title',
      nameLabel: 'titled',
    });
    // validateResourceList already required a real KV id on every member.
    const matches = namespaces
      .filter((ns) => ns.title === title)
      .map((ns) => ({ id: ns.id as string }));
    if (matches.length > 0) {
      // Pick the smallest id so re-runs adopt the same namespace.
      const chosen = matches.reduce((min, ns) => (ns.id < min.id ? ns : min));
      if (matches.length > 1) {
        log.warn(
          `multiple KV namespaces titled "${title}" (${matches
            .map((m) => m.id)
            .join(', ')}); adopting the lexicographically-smallest id ${chosen.id}`,
        );
      }
      log.info(`adopted existing KV namespace ${title} (${chosen.id})`);
      write({ kv: { binding, id: chosen.id } });
      resources.push({ kind: 'kv', binding, name: title, action: 'adopted', id: chosen.id });
    } else {
      const created = await runWrangler({
        type: 'kv.namespace.create',
        name: title,
        binding,
        configPath,
      });
      if (!isCleanSuccess(created)) {
        throw new Error(
          `provision: Cloudflare kv namespace create ${title} failed: ${created.stderr || created.stdout}`,
        );
      }
      assertCreateWroteRealId(
        configPath,
        {
          field: 'kv_namespaces',
          idField: 'id',
          idValidator: isRealKvId,
          resource: 'KV namespace',
          command: 'Cloudflare kv namespace create',
        },
        binding,
        title,
      );
      persistCreatedConfig();
      resources.push({ kind: 'kv', binding, name: title, action: 'created' });
    }
  }
}

async function reconcileR2(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  write: ProvisionConfigWriter,
  persistCreatedConfig: () => void,
  resources: Array<ProvisionOutcome>,
  log: ProvisionLogger,
): Promise<void> {
  if (desired.r2) {
    const { binding, bucketName } = desired.r2;
    const entry = readBindingEntry(configPath, 'r2_buckets', binding);
    // `bucket_name` is the identity: a stored real name that differs is a contradiction.
    const storedBucketName = entry?.bucket_name;
    if (entry && isRealStoredR2BucketName(storedBucketName, bucketName)) {
      if (storedBucketName !== bucketName) {
        throw new Error(
          `provision: R2 binding ${JSON.stringify(binding)} in "${configPath}" stores ` +
            `bucket_name ${JSON.stringify(storedBucketName)}, but this deploy wants bucket ` +
            `${JSON.stringify(bucketName)}. bucket_name IS the R2 identity, so this entry ` +
            `contradicts the desired bucket. Fix "${configPath}" — correct the entry's ` +
            `bucket_name (or remove the entry to re-provision) — or rename the desired bucket, ` +
            `then retry.`,
        );
      }
      resources.push({ kind: 'r2', binding, name: bucketName, action: 'reused' });
    } else {
      // Bucket names are account-unique, so probe by name.
      const info = await runWrangler({ type: 'r2.bucket.info', name: bucketName, configPath }, {});
      if (isCleanSuccess(info)) {
        // Adopt only when the payload names this bucket.
        const payload = info.data;
        if (!isRecord(payload) || payload.name !== bucketName) {
          throw new Error(
            `provision: Cloudflare r2 bucket info ${bucketName} exited 0 but did not identify ` +
              `the requested bucket (expected name ${JSON.stringify(bucketName)}). Refusing to adopt an ` +
              `unverified bucket. Output: ${info.stdout || info.stderr}`,
          );
        }
        log.info(`adopted existing R2 bucket ${bucketName}`);
        write({ r2: { binding, bucketName } });
        resources.push({ kind: 'r2', binding, name: bucketName, action: 'adopted' });
      } else if (isConfirmedAbsent(info, 'r2')) {
        const created = await runWrangler({
          type: 'r2.bucket.create',
          name: bucketName,
          binding,
          configPath,
        });
        if (!isCleanSuccess(created)) {
          throw new Error(
            `provision: Cloudflare r2 bucket create ${bucketName} failed: ${created.stderr || created.stdout}`,
          );
        }
        // No placeholder rule here: a bucket really named `default` is valid.
        assertCreateWroteRealId(
          configPath,
          {
            field: 'r2_buckets',
            idField: 'bucket_name',
            idValidator: isValidR2BucketNameFormat,
            nameField: 'bucket_name',
            resource: 'R2 bucket',
            command: 'Cloudflare r2 bucket create',
          },
          binding,
          bucketName,
        );
        // For a bucket named `default`, the config cannot tell a real create from the
        // placeholder, so confirm remotely.
        if (bucketName === R2_BUCKET_NAME_PLACEHOLDER) {
          const verify = await runWrangler(
            { type: 'r2.bucket.info', name: bucketName, configPath },
            {},
          );
          if (
            !isCleanSuccess(verify) ||
            !isRecord(verify.data) ||
            verify.data.name !== bucketName
          ) {
            throw new Error(
              `provision: Cloudflare r2 bucket create ${bucketName} reported success but a ` +
                `follow-up Cloudflare r2 bucket info ${bucketName} did not confirm the bucket ` +
                `exists. The create may have been interrupted, and the config entry is ` +
                `indistinguishable from the local-dev placeholder for this name. Refusing to ` +
                `record an unprovisioned bucket; inspect the account and retry.`,
            );
          }
        }
        persistCreatedConfig();
        resources.push({ kind: 'r2', binding, name: bucketName, action: 'created' });
      } else {
        // Any other failure: the bucket may exist, so do not create.
        throw new Error(
          `provision: Cloudflare r2 bucket info ${bucketName} failed: ${info.stderr || info.stdout}. ` +
            `Cannot determine whether the bucket exists; refusing to create a possible duplicate.`,
        );
      }
    }
  }
}

async function reconcileHyperdrive(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  write: ProvisionConfigWriter,
  persistCreatedConfig: () => void,
  resources: Array<ProvisionOutcome>,
  log: ProvisionLogger,
  transportAccountId: string,
  transportApiBaseUrl: string,
  redactSecrets: (value: string) => string,
  opts?: ProvisionOptions,
): Promise<void> {
  // Hyperdrive create duplicates same-named configs and there is no machine-readable list, so
  // existence is checked through the REST lister. Adoption needs no connection string.
  if (desired.hyperdrive) {
    const { binding, name, connectionString } = desired.hyperdrive;
    const entry = readBindingEntry(configPath, 'hyperdrive', binding);
    if (entry && isRealHyperdriveId(entry.id)) {
      resources.push({ kind: 'hyperdrive', binding, name, action: 'reused', id: entry.id });
    } else {
      const lister =
        opts?.listHyperdriveConfigs ?? createDefaultListHyperdriveConfigs(opts?.apiToken);
      // Existence stays unknown until the lister returns a real array.
      let validatedConfigs: Array<unknown> | undefined;
      let existenceUnknown = true;
      if (lister) {
        try {
          const result = await withListerDeadline(
            (signal) =>
              lister({
                accountId: transportAccountId,
                apiBaseUrl: transportApiBaseUrl,
                signal,
              }),
            opts?.listTimeoutMs ?? HYPERDRIVE_LIST_TIMEOUT_MS,
          );
          if (!Array.isArray(result)) {
            throw new Error(
              `the existence check returned a ${result === null ? 'null' : typeof result} result ` +
                `instead of an array`,
            );
          }
          validatedConfigs = result;
          existenceUnknown = false;
        } catch (error) {
          // A network error can echo a URL carrying userinfo credentials.
          log.warn(
            `Hyperdrive existence check for ${name} failed: ` +
              redactSecrets(error instanceof Error ? error.message : String(error)),
          );
          existenceUnknown = true;
          validatedConfigs = undefined;
        }
      }
      // Validate outside the try, so a malformed list is a hard failure, not "unknown".
      const existing =
        validatedConfigs !== undefined
          ? selectHyperdriveMatch(validatedConfigs, name, configPath)
          : undefined;
      if (existing) {
        log.info(`adopted existing Hyperdrive config ${name} (${existing.id})`);
        write({ hyperdrive: { binding, id: existing.id } });
        resources.push({ kind: 'hyperdrive', binding, name, action: 'adopted', id: existing.id });
      } else if (!connectionString) {
        // Without a connection string we can never create, so skip.
        const reason = 'no connection string provided';
        log.warn(`skipping Hyperdrive config ${name}: ${reason}`);
        resources.push({ kind: 'hyperdrive', binding, name, action: 'skipped', reason });
      } else if (existenceUnknown) {
        // We would create but cannot check for a duplicate.
        throw new Error(
          `provision: could not check whether Hyperdrive config ${JSON.stringify(name)} already ` +
            `exists (see the warning above). A create would duplicate a config with the same ` +
            `name, so Void did not create it. Check that CLOUDFLARE_API_TOKEN can read ` +
            `Hyperdrive configs, then retry.`,
        );
      } else {
        const created = await runWrangler(
          { type: 'hyperdrive.create', name: name, binding, configPath },
          { input: connectionString },
        );
        if (!isCleanSuccess(created)) {
          throw new Error(
            `provision: Cloudflare hyperdrive create ${name} failed: ${created.stderr || created.stdout}`,
          );
        }
        assertCreateWroteRealId(
          configPath,
          {
            field: 'hyperdrive',
            idField: 'id',
            idValidator: isRealHyperdriveId,
            resource: 'Hyperdrive config',
            command: 'Cloudflare hyperdrive create',
          },
          binding,
          name,
        );
        persistCreatedConfig();
        resources.push({ kind: 'hyperdrive', binding, name, action: 'created' });
      }
    }
  }
}

async function reconcileQueues(
  desired: DesiredResourceSet,
  configPath: string,
  runWrangler: PinnedRunWrangler,
  resources: Array<ProvisionOutcome>,
): Promise<void> {
  // Only ensures each queue exists; the deploy orchestrator writes the queue bindings.
  for (const name of desired.queues) {
    const info = await runWrangler({ type: 'queues.info', name: name, configPath });
    // Reuse only when the probe names this queue; a bare exit 0 is not trusted.
    if (queueInfoConfirmsExists(info, name)) {
      resources.push({ kind: 'queue', name, action: 'reused' });
      continue;
    }
    // Create only on a typed not-found; anything else fails closed.
    if (!isConfirmedAbsent(info, 'queue')) {
      throw new Error(
        `provision: Cloudflare queues info ${name} failed or did not confirm the queue exists: ` +
          `${info.stderr || info.stdout || 'no output'}`,
      );
    }
    const created = await runWrangler({ type: 'queues.create', name: name, configPath });
    if (!isCleanSuccess(created)) {
      throw new Error(
        `provision: Cloudflare queues create ${name} failed: ${created.stderr || created.stdout}`,
      );
    }
    // Queue creates write no config, so re-probe to confirm.
    const verify = await runWrangler({ type: 'queues.info', name: name, configPath });
    if (!queueInfoConfirmsExists(verify, name)) {
      throw new Error(
        `provision: Cloudflare queues create ${name} reported success but Cloudflare queues info ` +
          `${name} did not confirm the queue exists afterward. The create may have been ` +
          `interrupted. Refusing to record an unprovisioned queue; inspect the account and retry.`,
      );
    }
    resources.push({ kind: 'queue', name, action: 'created' });
  }
}

/** The provision body, run under the lock with the canonical config path. */
async function provisionCloudflareResourcesLocked(
  root: string,
  configPath: string,
  desired: DesiredResourceSet,
  opts?: ProvisionOptions,
): Promise<ProvisionResult> {
  // jsonc-parser accepts duplicate members, so reject them before any remote work.
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const content = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
    assertNoDuplicateMembers(content, configPath);
  }

  // Validate every argv name before any remote work.
  if (desired.d1) {
    assertValidResourceName('d1', desired.d1.name);
  }
  for (const { title } of desired.kvNamespaces) {
    assertValidResourceName('kvTitle', title);
  }
  if (desired.r2) {
    assertValidResourceName('r2', desired.r2.bucketName);
  }
  if (desired.hyperdrive) {
    assertValidResourceName('hyperdrive', desired.hyperdrive.name);
  }
  for (const queueName of desired.queues) {
    assertValidResourceName('queue', queueName);
  }

  // Effective account: config `account_id`, then `opts.accountId`, then CLOUDFLARE_ACCOUNT_ID.
  // Wrangler prefers the config value, so a config/option mismatch fails closed.
  const rootConfig = readRootConfig(configPath);
  const rawConfigAccountId = rootConfig.account_id;
  const configAccountId =
    typeof rawConfigAccountId === 'string' && rawConfigAccountId.length > 0
      ? rawConfigAccountId
      : undefined;
  // `compliance_region` selects the public or FedRAMP API base.
  const rawComplianceRegion = rootConfig.compliance_region;
  if (rawComplianceRegion !== undefined && typeof rawComplianceRegion !== 'string') {
    throw new Error(
      `provision: "${configPath}" has a non-string "compliance_region"; it must be "public" or ` +
        `"fedramp_high". Fix the config and retry.`,
    );
  }
  // Passed through as-is so an invalid value fails like it does in wrangler.
  const configComplianceRegion =
    typeof rawComplianceRegion === 'string' ? rawComplianceRegion : undefined;
  if (configAccountId && opts?.accountId && configAccountId !== opts.accountId) {
    throw new Error(
      `provision: Cloudflare account mismatch — "${configPath}" pins account_id ` +
        `${JSON.stringify(configAccountId)} but deploy requested ${JSON.stringify(opts.accountId)}. ` +
        `Reconcile them (correct or remove the config's account_id, or deploy to the pinned account) ` +
        `and retry.`,
    );
  }
  const ambientAccountId =
    typeof process.env.CLOUDFLARE_ACCOUNT_ID === 'string' &&
    process.env.CLOUDFLARE_ACCOUNT_ID.length > 0
      ? process.env.CLOUDFLARE_ACCOUNT_ID
      : undefined;
  const effectiveAccountId = configAccountId ?? opts?.accountId ?? ambientAccountId;

  const log = opts?.log ?? defaultLogger;
  const resources: Array<ProvisionOutcome> = [];
  const write = (
    patch: Parameters<typeof writeProvisionedWranglerConfig>[1],
  ): WriteProvisionedWranglerResult => writeProvisionedWranglerConfig(root, patch, { configPath });
  const persistCreatedConfig = (): void => persistMaterializedWranglerConfig(configPath);

  // Any resource to ensure implies remote work (list/info/create/REST).
  const hasRemoteWork =
    !!desired.d1 ||
    desired.kvNamespaces.length > 0 ||
    !!desired.r2 ||
    !!desired.hyperdrive ||
    desired.queues.length > 0;

  // Remote work needs a pinned account; otherwise a retry under another account could
  // rebind these resources.
  if (hasRemoteWork && !effectiveAccountId) {
    throw new Error(
      `provision: no Cloudflare account is resolvable. Set \`cloudflare.account_id\` in ` +
        `void.config.ts or export CLOUDFLARE_ACCOUNT_ID, then rerun \`void deploy\`. Void does ` +
        `not provision resources without a pinned account.`,
    );
  }

  // Cloudflare tooling reads project dotenv files; reject transport redirects first.
  if (hasRemoteWork) {
    assertNoTransportRedirectInProjectDotenv(root);
  }

  // The Hyperdrive existence check needs an API token (browser OAuth cannot call it). Stop
  // before the account pin and any create when no route can reach a real Hyperdrive id: a
  // connection string without a token, or neither a string nor a way to look it up.
  if (desired.hyperdrive && !opts?.listHyperdriveConfigs) {
    const { binding, name, connectionString } = desired.hyperdrive;
    const entry = readBindingEntry(configPath, 'hyperdrive', binding);
    const alreadyProvisioned = entry !== undefined && isRealHyperdriveId(entry.id);
    // An already-provisioned Hyperdrive needs no token.
    if (!alreadyProvisioned && !resolveHyperdriveApiToken(opts?.apiToken)) {
      if (connectionString) {
        throw new Error(
          `provision: Hyperdrive config ${JSON.stringify(name)} has no ID yet. Before Void ` +
            `creates one, it checks for an existing config with the Cloudflare API. That check ` +
            `needs an API token; a browser login cannot call it. Without the check, a create ` +
            `could duplicate an existing config with the same name, so nothing was ` +
            `provisioned. Either (a) export CLOUDFLARE_API_TOKEN with Hyperdrive ` +
            `edit permission and rerun, or (b) create the Hyperdrive config in the Cloudflare ` +
            `dashboard and add its ID to the ${JSON.stringify(binding)} entry in ` +
            `\`cloudflare.hyperdrive\` in void.config.ts. Deploying an already-provisioned ` +
            `Hyperdrive needs no token.`,
        );
      }
      // This run could only skip, which deploy treats as fatal. DATABASE_URL must come from
      // the shell: project dotenv is read only inside the credential-scrubbed build.
      throw new Error(
        `provision: Hyperdrive config ${JSON.stringify(name)} has no ID yet, and ` +
          `there is no DATABASE_URL to create it from. Nothing was provisioned. ` +
          `Either (a) export DATABASE_URL with your PostgreSQL connection string and rerun ` +
          `(Void reads it from the shell — a value in .env/.env.local is NOT used here, so it ` +
          `never ships as a plaintext worker var), or (b) create the Hyperdrive config in the ` +
          `Cloudflare dashboard and add its ID to the ${JSON.stringify(binding)} entry in ` +
          `\`cloudflare.hyperdrive\` in void.config.ts. Deploying an already-provisioned ` +
          `Hyperdrive needs neither DATABASE_URL nor an API token.`,
      );
    }
  }

  // Persist account_id before any create, so a retry under another account fails the
  // reconciliation above instead of rebinding these ids.
  let accountIdWritten = false;
  if (effectiveAccountId && configAccountId !== effectiveAccountId) {
    write({ accountId: effectiveAccountId });
    accountIdWritten = true;
  }

  // The account fence above guarantees a value whenever a runner is called.
  const transportAccountId = effectiveAccountId!;
  // One API base for the runner and the Hyperdrive REST lister.
  const transportApiBaseUrl = resolvePinnedApiBaseUrl(process.env, configComplianceRegion);

  const selectedRunWrangler = opts?.runWrangler ?? createDefaultRunWrangler(root);
  // Every result and rejection is redacted here, so no error or log carries the connection
  // string.
  const redactSecrets = createSecretRedactor(desired.hyperdrive?.connectionString);
  const redactResult = (result: RunWranglerResult): RunWranglerResult => ({
    ...result,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    error: result.error != null ? redactSecrets(result.error) : result.error,
  });
  // Every call gets the pinned account and API base.
  const runWrangler = (
    args: CloudflareOperation,
    callOpts?: { cwd?: string; suppressLogs?: boolean; input?: string },
  ): Promise<RunWranglerResult> =>
    Promise.resolve(
      selectedRunWrangler(args, {
        ...callOpts,
        accountId: transportAccountId,
        apiBaseUrl: transportApiBaseUrl,
      }),
    ).then(redactResult, (error: unknown) => {
      throw redactRejection(error, redactSecrets);
    });

  await reconcileD1(
    desired,
    configPath,
    runWrangler,
    write,
    persistCreatedConfig,
    resources,
    log,
    transportAccountId,
    transportApiBaseUrl,
    opts,
  );

  await reconcileKv(desired, configPath, runWrangler, write, persistCreatedConfig, resources, log);

  await reconcileR2(desired, configPath, runWrangler, write, persistCreatedConfig, resources, log);

  await reconcileHyperdrive(
    desired,
    configPath,
    runWrangler,
    write,
    persistCreatedConfig,
    resources,
    log,
    transportAccountId,
    transportApiBaseUrl,
    redactSecrets,
    opts,
  );

  await reconcileQueues(desired, configPath, runWrangler, resources);

  return { resources, configPath, accountIdWritten };
}
