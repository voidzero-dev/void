import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isCancel, log as clackLog, text } from '@voidzero-dev/vite-plus-prompts';
import { join, resolve } from 'pathslash';
import { findEnvFile } from '../codegen/env-types.ts';
import { type DatabaseDialect, type VoidConfig, isNodeTarget } from '../config.ts';
import type { JobDefinition } from '../crons/scan.ts';
import {
  assertJournalCoherence,
  validateMigrations,
  type MigrationFile,
} from '../migrations/validate.ts';
import type { QueueDefinition } from '../queues/scan.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { PlatformClient, type DeploymentResponse, type ProjectResponse } from './client.ts';
import { formatCloudflareUserMessage } from './cloudflare-user-output.ts';
import { promptAndCreateProject, reportProjectCreationWarnings } from './create-project.ts';
import {
  type PrerenderSourceInputs,
  type NonPageBackendInputs,
  type ResourceSummary,
  type RunDeployOptions,
} from './deploy-types.ts';
import { fetchRemoteSecretNames, formatEnvReport, validateProdEnv } from './env-validation.ts';
import { type CliLogger } from './log-file.ts';
import { formatCount, getErrorMessage, pc } from './output.ts';
import {
  detectPreset,
  formatProjectCommand,
  resolveProjectCommand,
  type StaticPreset,
} from './preset.ts';
import {
  attachSelectedPlatform,
  shouldLinkDeployProject,
  writeProjectConfig,
  type ProjectConfig,
} from './project.ts';
import { promptProjectSelection, promptProjectSetupAction } from './prompt.ts';
import type { DeployManifest, QueueMeta, ScheduleMeta } from './types.ts';
import {
  readExistingLiveBindingConfig,
  normalizeWranglerCompatibilityFlags,
  ensureWranglerCompat,
  resolveLiveBindingConfig,
  syncWranglerBindings,
  type LiveBindingConfig,
  type WranglerCompat,
} from './wrangler.ts';
import type { WrapperFeatures } from './wrapper.ts';
import { needsWrapper, generateWrapper } from './wrapper.ts';

export const log: Record<
  'error' | 'info' | 'message' | 'step' | 'warn',
  (message: string) => void
> = {
  error: (message: string) => clackLog.error(formatCloudflareUserMessage(message)),
  info: (message: string) => clackLog.info(formatCloudflareUserMessage(message)),
  message: (message: string) => clackLog.message(formatCloudflareUserMessage(message)),
  step: (message: string) => clackLog.step(formatCloudflareUserMessage(message)),
  warn: (message: string) => clackLog.warn(formatCloudflareUserMessage(message)),
};

export class DeployEventError extends Error {}

export async function generateDeployWrapperIfNeeded(
  root: string,
  workerDir: string,
  workerMain: string,
  features: WrapperFeatures,
): Promise<boolean> {
  if (!needsWrapper(features)) {
    return false;
  }
  await generateWrapper(workerDir, workerMain, root, features);
  return true;
}

const EMPTY_BINDINGS = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
};

function readLiveBindingConfigFromDeployment(
  deployment: DeploymentResponse | undefined,
): LiveBindingConfig | undefined {
  if (!deployment?.manifest) {
    return undefined;
  }
  let manifest: DeployManifest;
  try {
    manifest = JSON.parse(deployment.manifest) as DeployManifest;
  } catch {
    return undefined;
  }
  if (
    typeof manifest.live?.bindingName !== 'string' ||
    typeof manifest.live.className !== 'string'
  ) {
    return undefined;
  }
  return {
    bindingName: manifest.live.bindingName,
    className: manifest.live.className,
  };
}

export async function ensurePreviouslyDeployedLiveBindingConfig(
  root: string,
  client: PlatformClient,
  projectId: string,
  cliLog?: CliLogger,
): Promise<boolean> {
  if (readExistingLiveBindingConfig(root)) {
    return false;
  }

  const { deployments, activeDeploymentId } = await client.listDeployments(projectId);
  const live = readLiveBindingConfigFromDeployment(
    deployments.find((deployment) => deployment.id === activeDeploymentId),
  );
  if (!live) {
    return false;
  }

  const synced = syncWranglerBindings(root, { ...EMPTY_BINDINGS, needsLive: true }, { live });
  if (synced) {
    cliLog?.info('live_binding_restored', {
      bindingName: live.bindingName,
      className: live.className,
    });
  }
  return synced;
}

export async function resolveDeployLiveBindingConfig(
  root: string,
  client: PlatformClient,
  projectId: string,
  opts: {
    isFrameworkMode: boolean;
    needsLive: boolean | undefined;
    webSockets: Array<{ bindingName: string; className: string }>;
    sandboxClassName?: string;
    cliLog?: CliLogger;
  },
): Promise<LiveBindingConfig | undefined> {
  if (opts.isFrameworkMode || !opts.needsLive) {
    return undefined;
  }

  await ensurePreviouslyDeployedLiveBindingConfig(root, client, projectId, opts.cliLog);
  return resolveLiveBindingConfig(root, {
    reservedBindings: opts.webSockets.map((route) => route.bindingName),
    reservedClasses: [...opts.webSockets.map((route) => route.className), opts.sandboxClassName],
  });
}

export function getExitCode(error: unknown): number {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status;
  }
  return 1;
}

export function resolveDeployWranglerCompat(
  root: string,
  config: VoidConfig,
  buildOutputDir: string,
  requirements?: {
    authEnabled?: boolean;
    dialect?: DatabaseDialect;
    needsSandbox?: boolean;
  },
): WranglerCompat | undefined {
  if (isNodeTarget(config.target)) {
    return undefined;
  }
  const compat = ensureWranglerCompat(root, config, buildOutputDir);
  const compatibilityFlags = normalizeWranglerCompatibilityFlags(compat.compatibilityFlags, {
    needsNodejsCompat:
      requirements?.authEnabled === true ||
      (requirements?.dialect !== undefined && requirements.dialect !== 'sqlite') ||
      requirements?.needsSandbox === true,
  });
  return compatibilityFlags === compat.compatibilityFlags
    ? compat
    : { ...compat, compatibilityFlags };
}

export function resolveDeployWorkerMain(
  config: VoidConfig,
  buildOutputDir: string,
): string | undefined {
  if (isNodeTarget(config.target)) {
    return undefined;
  }
  try {
    const wrangler = JSON.parse(readFileSync(join(buildOutputDir, 'wrangler.json'), 'utf-8')) as {
      main?: unknown;
    };
    return typeof wrangler.main === 'string' && wrangler.main.length > 0
      ? wrangler.main
      : undefined;
  } catch {
    return undefined;
  }
}

export function assertWorkerMainUploaded(
  workerFiles: Map<string, Buffer>,
  workerMain: string | undefined,
): void {
  if (!workerMain || workerFiles.size === 0) {
    return;
  }
  if (!workerFiles.has(workerMain)) {
    throw new Error(
      `deploy: Worker entry '${workerMain}' from wrangler.json was not found in uploaded worker modules.`,
    );
  }
}

export function assertProjectDeployAccess(project: ProjectResponse | undefined): void {
  // The API remains authoritative for every deploy.
  if (project?.role === 'reader') {
    throw new Error(
      `deploy: You have reader access to "${project.slug}" and cannot deploy. ` +
        'Ask a project admin or owner to grant collaborator access, or choose another project with `--project <slug>`.',
    );
  }
}

export async function promptDeployProjectConfig(
  root: string,
  client: PlatformClient,
  cliLog?: CliLogger,
): Promise<ProjectConfig> {
  const projects = await client.listProjectChoices();
  const link = shouldLinkDeployProject(root, client.apiUrl);
  const deployableProjects = projects.filter((project) => project.role !== 'reader');
  if (deployableProjects.length !== projects.length) {
    log.warn(
      'Projects with reader access are hidden from deploy selection. Ask a project admin or owner to grant collaborator access to deploy to them.',
    );
  }
  const action = await promptProjectSetupAction('Set up a Void project for deploy:', {
    includeLink: deployableProjects.length > 0,
    ...(link ? {} : { link: false }),
  });

  if (action === 'create') {
    return promptAndCreateProject(root, client, {
      link,
    });
  }

  // Project names are only shown after the user opts into linking.
  const result = await promptProjectSelection(
    deployableProjects,
    'Select a project to deploy to:',
    root,
    { confirmExisting: true, includeCreate: false, ...(link ? {} : { link: false }) },
  );

  if (result.action === 'create') {
    throw new Error('Unexpected project selection result.');
  }
  const config = { projectId: result.project.id, slug: result.project.slug };
  if (link) {
    writeProjectConfig(root, attachSelectedPlatform(config, client.apiUrl));
    log.step(`Linked to ${pc.blue(config.slug)}`);
    cliLog?.info('project_linked', { projectId: config.projectId, slug: config.slug });
  } else {
    log.step(`Using ${pc.blue(config.slug)} for this deployment. Saved destination unchanged.`);
  }
  return config;
}

export function resolveStaticBuildCommand(
  preset: StaticPreset,
  buildOverride?: string,
  hasExplicitDir = false,
): string | null {
  if (hasExplicitDir) {
    return null;
  }
  return buildOverride ?? preset.buildCommand;
}

/**
 * Resolve the build command for a FULL (Class A / Void app) deploy.
 *
 * `inference.build` wins when set, matching `runFrameworkDeploy` and the static
 * path's `resolveStaticBuildCommand`, so an app that needs more than one build
 * step (an SSG that emits the site, then Void's build packaging it via
 * `publicDir` alongside the worker) can express it.
 *
 * The two returned strings are deliberately different for the FALLBACK: `label`
 * goes to the user (`formatProjectCommand` rewrites `vite` → `vp` without
 * expanding an absolute bin path), `command` is what actually runs
 * (`resolveProjectCommand` expands to the local bin). A configured command is
 * the user's own text and is used verbatim for both, so what is printed is
 * exactly what is executed.
 */
export function resolveFullDeployBuildCommand(
  root: string,
  buildOverride?: string,
  fallbackBuildCommand = 'vite build',
): { label: string; command: string } {
  if (buildOverride) {
    return { label: buildOverride, command: buildOverride };
  }
  return {
    label: formatProjectCommand(root, fallbackBuildCommand),
    command: resolveProjectCommand(root, fallbackBuildCommand),
  };
}

/**
 * Whether the built worker's `__voidCollectPrerenderPaths` can return anything
 * at all. When it cannot, booting it is pure cost and the deploy skips it.
 *
 * These three are exactly — and only — the sources `compilePrerenderCollector`
 * (`router/compile.ts`) emits a `paths.push(...)` for:
 *   1. `scan.pages.pages` — static patterns + dynamic pages' `getPrerenderPaths()`
 *   2. the custom SSR entry's top-level `getPrerenderPaths()` (`ssr` argument)
 *   3. `options.explicitPrerenderPaths` — void.config.ts `routing.prerender`
 * With none of them present the collector is a generated function whose body
 * returns `[...new Set([])]`, so skipping is result-identical.
 *
 * Skipping matters beyond speed. `collectPrerenderPaths` boots the worker in
 * Miniflare without remote production secrets, and the generated fetch handler
 * validates `env.ts` at boot. An app with nothing to prerender should not fail
 * merely because that unnecessary worker boot cannot access the remote store.
 */
export function hasPrerenderSources(inputs: PrerenderSourceInputs): boolean {
  return inputs.hasPages || inputs.hasSsrEntry || (inputs.explicitPrerenderPaths?.length ?? 0) > 0;
}

/**
 * Whether the project needs a worker for something other than its pages.
 *
 * An `output: "static"` project whose pages all prerender takes the static-site
 * path, which uploads assets and NO worker script. Every worker surface that is
 * not a page has to be listed here, because a missing one is not a failed
 * deploy — it is a successful deploy with that feature silently absent.
 *
 * `email` belongs here for the same reason `hasRoutes` does: an `email/`
 * handler compiles to the worker's `email()` export (`router/compile.ts`), and
 * the platform dispatches inbound mail through that export. With no worker, the
 * mail bounces at the proxy with `project has no email handler`.
 *
 * Schedules and queues are deliberately NOT folded in. They are checked at the
 * call site against their own resolved lists, not against a scan flag.
 */
export function hasNonPageBackend(inputs: NonPageBackendInputs): boolean {
  return (
    inputs.hasRoutes ||
    inputs.hasMiddleware ||
    inputs.hasWebSockets ||
    inputs.hasEmail ||
    inputs.authEnabled ||
    inputs.hasLive
  );
}

export function resolveStaticDeployPreset(
  root: string,
  voidConfig: VoidConfig,
  options?: Pick<RunDeployOptions, 'dir' | 'spa'>,
): StaticPreset | null {
  if (options?.dir) {
    return detectPreset(root, { dir: options.dir, spa: options.spa });
  }

  const appType = voidConfig.inference?.appType;
  if (appType === 'static' || appType === 'spa') {
    const outputDir = voidConfig.inference?.outputDir;
    const preset: StaticPreset = {
      buildCommand: null,
      outputDir: outputDir ? resolve(root, outputDir) : join(root, 'dist'),
      appType,
    };

    // Re-detect build command (config stores app type, not command).
    const detectedPreset = detectPreset(root, { spa: options?.spa });
    if (detectedPreset) {
      preset.buildCommand = detectedPreset.buildCommand;
      if (!outputDir) {
        preset.outputDir = detectedPreset.outputDir;
      }
    }
    return preset;
  }

  return null;
}

export async function createProjectFromSlug(
  root: string,
  client: PlatformClient,
  slug: string,
  cliLog?: CliLogger,
): Promise<ProjectConfig> {
  log.step(`Creating project ${pc.blue(slug)}...`);
  cliLog?.info('project_create_start', { slug });
  const project = await client.createProject(slug);
  const config = { projectId: project.id, slug: project.slug };
  if (shouldLinkDeployProject(root, client.apiUrl)) {
    writeProjectConfig(root, attachSelectedPlatform(config, client.apiUrl));
  }
  log.step(`Project created: ${pc.blue(config.slug)}`);
  reportProjectCreationWarnings(project);
  cliLog?.info('project_create_success', { projectId: config.projectId, slug: config.slug });
  return config;
}

export function getGitCommit(root: string): string | null {
  try {
    const githubSha = process.env.GITHUB_SHA?.trim();
    if (githubSha && /^[0-9a-f]{7,64}$/i.test(githubSha)) {
      return githubSha;
    }

    // `git status` can run a repo-configured `core.fsmonitor` hook, so scrub
    // credentials like the build spawns. No `localBinRoot`: `git` must never
    // resolve to a binary shipped in the project's node_modules/.bin.
    const gitEnv = buildEnv();
    // Check if in a git repo
    execSync('git rev-parse --is-inside-work-tree', { cwd: root, stdio: 'ignore', env: gitEnv });
    // Check if working tree is clean
    const status = execSync('git status --porcelain', {
      cwd: root,
      encoding: 'utf-8',
      env: gitEnv,
    }).trim();
    if (status !== '') {
      return null;
    }
    // Get current commit hash
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8', env: gitEnv }).trim();
  } catch {
    return null;
  }
}

/**
 * Check journal coherence and validate the checked-in migrations of a managed
 * deploy. Logs and exits on failure; returns `undefined` when there are none.
 */
export function validateDeployMigrations(
  migrationsDir: string,
  rawMigrations: Array<{ name: string; sql: string }>,
  sourceRelative?: (path: string) => string,
): Array<MigrationFile> | undefined {
  try {
    assertJournalCoherence(migrationsDir, rawMigrations, sourceRelative);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }
  if (rawMigrations.length === 0) {
    return undefined;
  }
  try {
    const validated = validateMigrations(rawMigrations);
    log.info(`Found ${formatCount(validated.length, 'migration')}`);
    return validated;
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }
}

/**
 * Ensure a managed external SQL project has Hyperdrive, prompting for the
 * connection string when it is missing.
 */
export async function ensureManagedHyperdrive(
  client: PlatformClient,
  projectId: string,
  dialect: Exclude<DatabaseDialect, 'sqlite'>,
): Promise<void> {
  let resources: Array<ResourceSummary> | null = null;
  try {
    resources = await client.getResources(projectId);
  } catch {
    // Best effort: the platform checks Hyperdrive again during the deploy.
  }
  if (!resources || resources.some((resource) => resource.type === 'hyperdrive')) {
    return;
  }
  const connectionString = await text({
    message: `Your project uses ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'}. Enter your connection string:`,
    placeholder:
      dialect === 'mysql'
        ? 'mysql://user:pass@host:3306/dbname'
        : 'postgresql://user:pass@host:5432/dbname',
    validate(value) {
      const valid =
        dialect === 'mysql'
          ? value?.startsWith('mysql://')
          : value?.startsWith('postgres://') || value?.startsWith('postgresql://');
      if (!valid) {
        return dialect === 'mysql'
          ? 'Must start with "mysql://"'
          : 'Must start with "postgres://" or "postgresql://"';
      }
    },
  });
  if (isCancel(connectionString)) {
    log.info('Deploy cancelled.');
    process.exit(0);
  }
  await client.provisionDatabase(projectId, connectionString as string);
  log.step('Hyperdrive provisioned.');
}

/** Convert scanned cron jobs and queues into deploy-manifest entries. */
export function toManifestSchedulesAndQueues(
  jobs: Array<JobDefinition>,
  queues: Array<QueueDefinition>,
): { schedules: Array<ScheduleMeta>; queues: Array<QueueMeta> } {
  return {
    schedules: jobs.flatMap((job) => job.crons.map((cron) => ({ name: job.name, cron }))),
    queues: queues.map((q) => ({
      name: q.name,
      bindingName: q.bindingName,
      ...(q.maxBatchSize != null && { maxBatchSize: q.maxBatchSize }),
      ...(q.maxBatchTimeout != null && { maxBatchTimeout: q.maxBatchTimeout }),
      ...(q.maxRetries != null && { maxRetries: q.maxRetries }),
      ...(q.retryDelay != null && { retryDelay: q.retryDelay }),
    })),
  };
}

/**
 * If the project has an `env.ts`, validate its schema against the union of
 * build-shell public values and remote secret names. Hard-error before upload so
 * deploys never ship missing required env vars.
 */
export async function assertEnvSchemaValid(
  root: string,
  client: PlatformClient,
  projectId: string,
  workerVars: Record<string, string> | undefined,
): Promise<void> {
  // Skip the remote secret round-trip when the project has no typed env schema.
  if (findEnvFile(root) == null) {
    return;
  }

  const remoteSecrets = await fetchRemoteSecretNames(client, projectId);
  const { hasSchema, report } = await validateProdEnv(root, {
    productionOnly: true,
    remoteSecrets,
    workerVars,
  });
  if (!hasSchema || report.valid) {
    return;
  }

  const formatted = formatEnvReport(report);
  log.error(`Env validation failed:\n${formatted}`);
  if (report.missing.length > 0) {
    log.info(
      'Upload missing server values with `void secret put <NAME>`; set VITE_* values in the build shell or schema defaults.',
    );
  }
  throw new DeployEventError('deploy: Aborting because env.ts schema is not satisfied.');
}
