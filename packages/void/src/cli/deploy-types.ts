import {
  activateCloudflareVersion,
  readExistingCloudflareWorker,
  assertCloudflareDurableObjectLifecycleSupported,
  type CloudflareCommandResult,
  type CloudflareOperation,
} from '@void/deploy-cloudflare';
import { type VoidConfig } from '../config.ts';
import { runMySqlMigrations } from '../migrations/runner-mysql.ts';
import { runPgMigrations } from '../migrations/runner-pg.ts';
import { type EmailHandlersScan } from '../router/email.ts';
import { verifyGeneratedDeployConfig } from './deploy-artifact-validation.ts';
import { ensureCloudflareAuthSecret } from './deploy-cloudflare-auth.ts';
import { prepareCloudflareFrameworkArtifact } from './deploy-cloudflare-static.ts';
import {
  assertRemoteMigrationsDeployable,
  checkWranglerMigrationApplySet,
  validateAuthMigrationSchema,
} from './deploy-migrations.ts';
import { renderAddressMap, type EmailDns, type EmailFetch } from './email-cloudflare.ts';
import type {
  EnvSchemaProbeInput,
  EnvSchemaProbeResult,
  EnvSchemaValidateResult,
} from './env-schema-probe.ts';
import { dischargeSelfHostEnvContext, type EmittedWorkerVarsResult } from './env-validation.ts';
import { type CliLogger } from './log-file.ts';
import { type DeploymentPlatform } from './project.ts';
import type { provisionCloudflareResources } from './provision.ts';
import type { DeployEvent, DeployTargetAdapter } from './types.ts';

export type RunDeployOptions = {
  /** Accepted the existing-Worker handoff in this invocation. */
  reuseExistingWorker?: boolean;
  projectSlug?: string;
  dir?: string;
  spa?: boolean;
  skipBuild?: boolean;
  debug?: boolean;
  platform?: Exclude<DeploymentPlatform, 'none'>;
  provision?: boolean;
  /**
   * Native Cloudflare email: fail the deploy — before any upload — instead of continuing
   * without email when the mail domain is not set up and the step cannot finish it
   * (CI / non-TTY, a blocker, a declined prompt). `--platform cloudflare` only.
   */
  requireEmail?: boolean;
  /** Publish an existing Durable Object Worker atomically after explicit operator choice. */
  atomic?: boolean;
  /**
   * `CF_ACCESS_READINESS_ORIGIN` as recorded before project code ran (`null` when unset).
   * `--platform cloudflare` only.
   */
  readinessAccessOrigin?: string | null;
};

type DeployDoneEvent = Extract<DeployEvent, { event: 'done' }>;

export type StreamDeployResult = DeployDoneEvent;

export type ResourceSummary = {
  type?: string;
};

/**
 * A pin of every desired id-bearing binding's IDENTITY, keyed `<field>:<binding>` (the config
 * section joined to the binding — both fixed/identifier-shaped, so the pair never collides),
 * captured from the root config AFTER provision/drift resolves every real id and BEFORE the
 * untrusted `vite build` runs. The remote-migrate assert and the emitted-config check both
 * compare against THIS map, so the id defense is symmetric with the pinned `account_id` — see
 * {@link snapshotBindingIdentities}.
 */
export type BindingIdentitySnapshot = Map<string, string>;

/** Result of one orchestrator-owned wrangler invocation (whoami/migrate/deploy). */
export type DeployWranglerRunResult = CloudflareCommandResult;

export type DeployWranglerRun = (
  operation: CloudflareOperation,
  opts: { capture: boolean; input?: string },
) => DeployWranglerRunResult | Promise<DeployWranglerRunResult>;

/**
 * Injectable seams for {@link runCloudflareDeploy}, so the whole orchestration
 * is unit-testable with NO real wrangler / network / Cloudflare account — the
 * same pattern the provisioner (`cli/provision.ts`) and the self-host secret
 * units (`cli/env-validation.ts`) use.
 */
export interface CloudflareDeployDeps {
  /** Interactive migration choice; persisted in void.config.ts before provisioning. */
  confirmIsrSetup?: (message: string) => Promise<boolean>;
  readExistingWorker?: typeof readExistingCloudflareWorker;
  /** Fail closed on a pending existing-Worker Durable Object class migration. */
  assertDurableObjectLifecycle?: typeof assertCloudflareDurableObjectLifecycleSupported;
  /** wrangler runner for the orchestrator's own whoami/migrate/deploy calls. */
  runWrangler?: DeployWranglerRun;
  /** Run the project's `vite build` (inherited stdio). Throws on a nonzero build. */
  runBuild?: (env: NodeJS.ProcessEnv) => void;
  /** Run a static/SPA/SSG preset build command. */
  runStaticBuild?: (command: string, env: NodeJS.ProcessEnv) => void;
  /** Prepare a standalone framework Worker/config after its native build. */
  prepareFrameworkArtifact?: typeof prepareCloudflareFrameworkArtifact;
  /** Upload, readiness-probe, and activate the verified Worker Version. */
  activateVersion?: typeof activateCloudflareVersion;
  /**
   * Wrangler-uploader content-hash seam (default: {@link hashWranglerUploader}). Snapshotted
   * BEFORE the build and re-checked AFTER, so a build that overwrote the wrangler bundle the
   * credentialed remote migrate / deploy execute fails closed before either runs.
   */
  hashWranglerUploader?: (root: string) => string | undefined;
  /** Provisioner seam (default: `provisionCloudflareResources`). */
  provision?: typeof provisionCloudflareResources;
  /** Parent-side secret-gate discharge seam (default: {@link dischargeSelfHostEnvContext}). */
  dischargeSelfHostEnv?: typeof dischargeSelfHostEnvContext;
  /** Persistent Better Auth secret seam (default: {@link ensureCloudflareAuthSecret}). */
  ensureAuthSecret?: typeof ensureCloudflareAuthSecret;
  /** Generated-deploy-config verification seam (default: {@link verifyGeneratedDeployConfig}). */
  verifyDeployConfig?: typeof verifyGeneratedDeployConfig;
  /** Resolve the generated config selected by the fresh deploy pointer. */
  resolveGeneratedConfigPath?: (root: string) => string;
  /** Pre-remote-migrate gate seam (default: {@link assertRemoteMigrationsDeployable}). */
  assertMigrationsDeployable?: typeof assertRemoteMigrationsDeployable;
  /** Migration apply-set equality gate seam (default: {@link checkWranglerMigrationApplySet}). */
  checkMigrationApplySet?: typeof checkWranglerMigrationApplySet;
  /** PostgreSQL migration runner (default: {@link runPgMigrations}). */
  applyPostgresMigrations?: typeof runPgMigrations;
  /** MySQL migration runner (default: {@link runMySqlMigrations}). */
  applyMySqlMigrations?: typeof runMySqlMigrations;
  /**
   * Auth-schema validation seam (default: {@link validateAuthMigrationSchema}).
   * Runs POST-build: reads the generated auth schema the build emitted
   * (`.void/better-auth-schema.ts`) and asserts the checked-in migrations produce it.
   */
  validateAuthMigrations?: typeof validateAuthMigrationSchema;
  /**
   * Isolated env-schema probe seam (default: the {@link EnvSchemaProbeInput}
   * subprocess). Receives a scrubbed env and returns the env-INSENSITIVE schema facts
   * (server and required key names), derived by importing env.ts in the
   * child, so the parent runs no project code. A `schema-error` (env.ts failed to
   * evaluate, or a validator threw) fails the deploy closed.
   */
  resolveSchemaFacts?: (
    input: EnvSchemaProbeInput,
    env: NodeJS.ProcessEnv,
  ) => EnvSchemaProbeResult | Promise<EnvSchemaProbeResult>;
  /**
   * Isolated emitted-var validation seam (default: the {@link EnvSchemaProbeInput}
   * subprocess in `validate-emitted` mode). Runs POST-build: validates the REAL emitted
   * worker `vars` against the schema's validators in the child and returns the FAILING
   * key NAMES only, which fold into the secret-gate context so a malformed required
   * value fails the deploy closed before any remote mutation.
   */
  validateEmittedVars?: (
    input: EnvSchemaProbeInput,
    env: NodeJS.ProcessEnv,
  ) => EnvSchemaValidateResult | Promise<EnvSchemaValidateResult>;
  /**
   * Emitted-worker-vars read seam (default: {@link readEmittedWorkerVars}).
   * Runs POST-build: reads the REAL `vars` map the build baked into
   * `dist/ssr/wrangler.json` — the ground truth the plaintext-server-key + secret gate
   * validate.
   */
  readEmittedWorkerVars?: (root: string) => EmittedWorkerVarsResult;
  /**
   * Override CI / non-interactive detection for the email step prompt (default: wrangler's
   * own {@link isWranglerNonInteractiveOrCI}, so Void and wrangler call the same run
   * interactive).
   */
  isCI?: boolean;
  /**
   * The one-Enter email prompt (default: clack `confirm`, default Yes). Receives the question
   * and resolves the answer; a cancelled prompt is `false`.
   */
  confirmEmailSetup?: (message: string) => Promise<boolean>;
  /** Public-DNS probes for the email preflight (default: `node:dns/promises`). */
  emailDns?: EmailDns;
  /** `fetch` for the two bearer calls wrangler has no command for (default: global `fetch`). */
  emailFetch?: EmailFetch;
  /** Override `process.exit` (tests assert the exit code without halting). */
  exit?: (code: number) => never;
}

export type CloudflareAuthSecretFailureReason =
  | 'uploader-changed'
  | 'list-failed'
  | 'put-failed'
  | 'verification-failed';

/** A column the emitted auth schema requires, with the constraints that carry correctness. */
export type RequiredAuthColumn = {
  column: string;
  /** The emitted field is `unique: true` — a duplicate row here is a duplicate auth identity. */
  unique: boolean;
  /**
   * The emitted field is `required: true` — the column must be NOT NULL. `PRAGMA
   * table_info.notnull` answers this directly, with one exception: the `INTEGER PRIMARY KEY`
   * rowid alias reports `notnull = 0` yet SQLite assigns a rowid on a NULL insert, so it can
   * never hold NULL and must not be rejected. A true alias is identified by the ABSENCE of an
   * `origin = 'pk'` row in `PRAGMA index_list`, not by its declared type — `INTEGER PRIMARY
   * KEY DESC` declares the same type but is no alias and really does store NULL.
   */
  required?: boolean;
  /**
   * This is the table's implicit `id` — the row identity every auth foreign key points at.
   * SQLite requires a PARENT KEY to be uniquely constrained (a PRIMARY KEY or a UNIQUE
   * constraint/index), so an `id` that is an ordinary column cannot carry the auth schema's
   * foreign keys. `PRAGMA foreign_key_check` is the authority on whether an EXISTING foreign
   * key's parent key is usable, but it only validates foreign keys that were actually
   * declared — a child table that declares none at all comes back clean. This flag is
   * therefore asserted on its own, so a non-unique `id` is caught even before any child
   * references it.
   */
  primaryKey?: boolean;
  /** The emitted field carries `references` — the parent table + column it must point at. */
  references?: { table: string; column: string };
};

/**
 * One row of `PRAGMA table_info`. `type` is the type the migration DECLARED, echoed back — one
 * of the conditions for recognizing the `INTEGER PRIMARY KEY` rowid alias, which no column of
 * this PRAGMA distinguishes from an ordinary nullable primary key on its own (`PRAGMA
 * index_list` supplies the discriminator).
 */
export type TableInfoRow = { name: string; type: string | null; notnull: number; pk: number };

/** One table of the emitted auth schema, reduced to what the migrations must reproduce. */
export type RequiredAuthTable = {
  table: string;
  columns: Array<RequiredAuthColumn>;
};

/** What the post-deploy address map prints — the input of {@link renderAddressMap}. */
export type EmailAddressMapInput = Parameters<typeof renderAddressMap>[0];

export interface CloudflareEmailStepInput {
  root: string;
  configPath: string;
  voidConfig: VoidConfig;
  /** The pre-probe root config (step 3) — `send_email` / `addresses` are read from it. */
  rootConfig: Record<string, unknown>;
  handlers: EmailHandlersScan;
  workerName: string;
  accountId: string;
  /** The ONE pinned transport (3a) — the two bearer `fetch` calls follow it like every wrangler child. */
  apiBaseUrl: string;
  runWrangler: DeployWranglerRun;
  /** wrangler's gate ({@link isWranglerNonInteractiveOrCI}) or the test override. */
  nonInteractive: boolean;
  confirm: (message: string) => Promise<boolean>;
  fetchImpl: EmailFetch;
  dns: EmailDns;
}

export interface CloudflareEmailStepResult {
  /**
   * True when the step FINISHED: every row read ready, or the one Enter applied the rest.
   * What `--require-email` gates on. A worker can still SHIP with email (the `SEND_EMAIL`
   * binding committed) on a branch that returns false — `map` says so.
   */
  satisfied: boolean;
  /** True when the root wrangler config was rewritten — the caller re-parses `rootConfig`. */
  configWritten: boolean;
  /** Stop before project code, the build, or upload; used for an ambiguous DNS handoff. */
  abortDeploy?: true;
  /** The post-deploy address map, when the worker ships with the binding; `null` otherwise. */
  map: EmailAddressMapInput | null;
}

export type RunDeployTargetAdapter = DeployTargetAdapter<RunDeployOptions, CliLogger>;

export type PrerenderSourceInputs = {
  /** `pages/` exists — file-based pages contribute static + `getPrerenderPaths()` paths. */
  hasPages: boolean;
  /** A custom SSR entry exists — it may export a top-level `getPrerenderPaths()`. */
  hasSsrEntry: boolean;
  /** `routing.prerender` from void.config.ts — compiled in as explicit paths. */
  explicitPrerenderPaths: ReadonlyArray<string> | undefined;
};

export type NonPageBackendInputs = {
  hasRoutes: boolean;
  hasMiddleware: boolean;
  hasWebSockets: boolean;
  hasEmail: boolean;
  authEnabled: boolean;
  hasLive: boolean;
};

export type ApplyDeployEventResult =
  | { kind: 'continue' }
  | { kind: 'start'; deploymentId: string }
  | { kind: 'done'; event: DeployDoneEvent }
  | { kind: 'error'; message: string };
