import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import {
  CloudflareWorkerInspectionError,
  parseCloudflareVersionMessage,
  parseRootWranglerConfig,
  type CloudflareOperation,
} from '@void/deploy-cloudflare';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { toSlash } from 'pathslash';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { activateCloudflareVersion as activateCloudflareVersionPrimitive } from '../../../deploy-cloudflare/src/index.ts';
import {
  operationFixture,
  operationFixtureRequest,
} from '../../../deploy-cloudflare/test/operation-fixture.ts';
import { readCloudflareLink } from '../../src/cli/cloudflare-link.ts';
import { verifyGeneratedDeployConfig } from '../../src/cli/deploy-artifact-validation.ts';
import {
  assertWranglerUploaderUnchanged,
  DEPLOY_PASSTHROUGH_EXCLUDE_FIELDS,
  hashWranglerUploader,
  reconstructExpectedDurableObjectState,
  snapshotBindingIdentities,
  snapshotPassthroughIdentities,
  snapshotPassthroughRawFields,
} from '../../src/cli/deploy-binding-snapshot.ts';
import {
  ensureCloudflareAuthSecret,
  runWranglerAuthToken,
} from '../../src/cli/deploy-cloudflare-auth.ts';
import { formatCloudflareActivationError } from '../../src/cli/deploy-cloudflare-helpers.ts';
import { prepareCloudflareFrameworkArtifact } from '../../src/cli/deploy-cloudflare-static.ts';
import { runCloudflareDeploy } from '../../src/cli/deploy-cloudflare.ts';
import {
  assertMigrationsProduceAuthSchema,
  checkWranglerMigrationApplySet,
  compareWranglerMigrationPaths,
  validateAuthMigrationSchema,
} from '../../src/cli/deploy-migrations.ts';
import { computeDesiredCloudflareResources } from '../../src/cli/deploy-resources.ts';
import {
  assertNoConfigOverrideInProjectDotenv,
  deployChildEnv,
} from '../../src/cli/deploy-transport.ts';
import type {
  CloudflareDeployDeps,
  DeployWranglerRun,
  DeployWranglerRunResult,
} from '../../src/cli/deploy-types.ts';
import { SENDING_FREE_PLAN_HINT, type EmailDns } from '../../src/cli/email-cloudflare.ts';
import { runEmailCloudflareCommand } from '../../src/cli/email.ts';
import {
  resolveEnvSchemaFactsViaSubprocess,
  validateEmittedVarsViaSubprocess,
  type EnvSchemaProbeResult,
  type EnvSchemaProbeSpawnResult,
} from '../../src/cli/env-schema-probe.ts';
import {
  dischargeSelfHostEnvContext,
  type EmittedWorkerVarsResult,
  type SelfHostEnvContext,
  type SelfHostSchemaFacts,
} from '../../src/cli/env-validation.ts';
import type { CliLogger } from '../../src/cli/log-file.ts';
import { migrateLegacyVoidConfig } from '../../src/cli/migrate.ts';
import { FRAMEWORK_PRESETS } from '../../src/cli/preset.ts';
import { provisionCloudflareResources, type ProvisionResult } from '../../src/cli/provision.ts';
import {
  FRIENDLY_BINDING_NAMES,
  readWranglerManagedQueueCleanupCandidates,
  readWranglerPublishedTrafficSnapshot,
  writeWranglerPublishedTrafficSnapshot,
  writeProvisionedWranglerConfig,
} from '../../src/cli/wrangler.ts';
import { readConfig } from '../../src/config.ts';

const tmpDir = join(import.meta.dirname, '.tmp-cf-deploy-test');

function removeProjectFixture(): void {
  // Windows can briefly retain handles opened by the real env-schema probe subprocesses.
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Write a project fixture: a map of relative path → file contents. */
function makeProject(files: Record<string, string>): string {
  removeProjectFixture();
  mkdirSync(tmpDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmpDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return tmpDir;
}

afterEach(() => {
  removeProjectFixture();
  vi.unstubAllEnvs();
});

const silentCliLog: CliLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  path: null,
  close: async () => {},
};

/** Capture the real renderer so successful native deploys must emit an enclosed summary. */
async function captureDeployOutput(run: () => Promise<void>): Promise<string> {
  const chunks: Array<string> = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await run();
  } finally {
    write.mockRestore();
  }
  return stripVTControlCharacters(chunks.join(''));
}

/** Synthetic real ids (shape-valid) for drift/provision fixtures. */
const REAL_D1_ID = '52b3bbc7-c473-4b26-9486-1345f5de61c4';
/** A second shape-valid D1 id, so a tampered config can point at a DIFFERENT database. */
const OTHER_D1_ID = '11111111-2222-3333-4444-555555555555';
const REAL_KV_ID = '7c07b54c9f2a4d1e8b3f6a0c153aa11a';
/** A second shape-valid KV id, so a two-namespace config can be distinct. */
const OTHER_KV_ID = '3f9a1c2d4e5b6a7c8d9e0f1a2b3c4d5e';

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit(${code})`);
  }
}

const cleanExit: DeployWranglerRunResult = {
  status: 0,
  stdout: '',
  stderr: '',
  signal: null,
  error: null,
};

describe('Cloudflare activation diagnostics', () => {
  it.each(['worker', 'static'] as const)(
    'flushes the %s upload diagnostic before exiting',
    async (kind) => {
      const root = makeProject({
        'package.json': JSON.stringify({ name: 'site', dependencies: { void: '*' } }),
        'void.json': '{}',
        'routes/index.ts': 'export const GET = () => "site";',
        'public/index.html': '<h1>Site</h1>',
        'wrangler.jsonc': JSON.stringify({
          name: 'site',
          account_id: 'personal',
          compatibility_date: '2026-02-24',
        }),
      });
      const order: Array<string> = [];
      const diagnostic = 'Compatibility flag specified multiple times: nodejs_als';
      const error = vi.fn(() => {
        order.push('error');
      });
      const logger: CliLogger = {
        ...silentCliLog,
        path: '/tmp/deploy-diagnostic.jsonl',
        error,
        close: async () => {
          order.push('close');
        },
      };
      const output = vi.spyOn(log, 'error').mockImplementation(() => {});
      const { deps } = harness({
        activateVersion: async () => ({
          ok: false,
          reason: 'upload-failed',
          status: 1,
          cloudflareErrorCode: 10021,
          diagnostic,
        }),
        exit: (code) => {
          order.push('exit');
          throw new ExitError(code);
        },
      });
      try {
        await expect(
          runCloudflareDeploy(root, kind === 'static' ? { dir: 'public' } : {}, logger, deps),
        ).rejects.toBeInstanceOf(ExitError);
        expect(order).toEqual(['error', 'close', 'exit']);
        expect(error).toHaveBeenCalledWith(
          'cloudflare_deploy_failed',
          expect.objectContaining({ message: expect.stringContaining(diagnostic) }),
        );
        expect(output).toHaveBeenCalledWith(expect.stringContaining(diagnostic));
        expect(output).toHaveBeenCalledWith(
          expect.stringContaining('Detailed log: /tmp/deploy-diagnostic.jsonl'),
        );
      } finally {
        output.mockRestore();
      }
    },
  );

  it.each(['upload-failed', 'bootstrap-failed', 'readiness-staging-failed'] as const)(
    'prints the underlying diagnostic for %s',
    (reason) => {
      const message = formatCloudflareActivationError({
        ok: false,
        reason,
        status: 1,
        cloudflareErrorCode: 10021,
        diagnostic: 'Uncaught TypeError: Cannot read properties of undefined\n  at index.js:42:1',
      });
      expect(message).toContain('Cloudflare error code: 10021');
      expect(message).toContain('Uncaught TypeError: Cannot read properties of undefined');
      expect(message).toContain('at index.js:42:1');
    },
  );

  it('suggests explicit atomic publication for a Durable Object staging conflict', () => {
    const message = formatCloudflareActivationError({
      ok: false,
      reason: 'readiness-staging-failed',
      status: 1,
      cloudflareErrorCode: 10210,
      diagnostic: 'The version depends on Durable Object migration fate-live-v1.',
    });
    expect(message).toContain('void deploy --platform cloudflare --atomic');
    expect(message).toContain('deploy.cloudflare.mode');
  });

  it('suggests one atomic publication when the versions declare different exports', () => {
    const message = formatCloudflareActivationError({
      ok: false,
      reason: 'readiness-staging-failed',
      status: 1,
      cloudflareErrorCode: 100405,
      diagnostic:
        '[100405] All versions in a multi-version deployment must declare identical `exports`.',
    });
    expect(message).toContain('production traffic is unchanged');
    expect(message).toContain('declares different exports from the live version');
    expect(message).toContain('Run `void deploy --platform cloudflare --atomic` once');
  });

  it('reports readiness restoration outcomes without claiming uncertain traffic is unchanged', () => {
    expect(
      formatCloudflareActivationError({
        ok: false,
        reason: 'readiness-access-denied',
        rollback: 'succeeded',
      }),
    ).toContain('traffic was restored to the previous version');
    expect(
      formatCloudflareActivationError({
        ok: false,
        reason: 'readiness-failed',
        rollback: 'failed',
      }),
    ).toContain('Automatic traffic restoration failed');
    expect(
      formatCloudflareActivationError({
        ok: false,
        reason: 'readiness-failed',
        rollback: 'unsafe',
      }),
    ).toContain('did not invoke the changed Wrangler binary');
  });

  it('explains the account default-deny case when first-deploy readiness is blocked', () => {
    const message = formatCloudflareActivationError({
      ok: false,
      reason: 'bootstrap-readiness-access-denied',
    });
    expect(message).toContain('error 1050');
    expect(message).toContain('create an Access application');
  });

  it.each(['bootstrap-readiness-failed', 'atomic-readiness-failed'] as const)(
    'prints Custom Domain propagation retry guidance after %s',
    (reason) => {
      const message = formatCloudflareActivationError({
        ok: false,
        reason,
        diagnostic: 'Check DNS and TLS, then retry `void deploy --platform cloudflare`.',
      });
      expect(message).toContain('Worker');
      expect(message).toContain('Check DNS and TLS');
      expect(message).toContain('retry `void deploy --platform cloudflare`');
    },
  );

  it('distinguishes opaque trigger recovery from a first deployment', () => {
    const opaque = formatCloudflareActivationError({
      ok: false,
      reason: 'triggers-failed',
      rollback: 'unavailable',
      previousVersionId: '11111111-1111-4111-8111-111111111111',
    });
    expect(opaque).toContain('Traffic or trigger restoration could not be completed');
    expect(opaque).not.toContain('Traffic was restored');
    expect(opaque).not.toContain('first deployment');

    expect(
      formatCloudflareActivationError({
        ok: false,
        reason: 'triggers-failed',
        rollback: 'unavailable',
        previousVersionId: null,
      }),
    ).toContain('This was the first deployment');
  });

  it('reports uncertain status after publication without claiming nothing was uploaded', () => {
    const published = formatCloudflareActivationError({
      ok: false,
      reason: 'status-failed',
      versionId: '22222222-2222-4222-8222-222222222222',
      status: 1,
    });
    expect(published).toContain('was published');
    expect(published).toContain('Inspect `void project status` before retrying');
    expect(published).not.toContain('no version was uploaded');
    expect(
      formatCloudflareActivationError({ ok: false, reason: 'status-failed', status: 1 }),
    ).toContain('no version was uploaded');
  });
});

/** No-schema (nothing-to-gate) env-insensitive facts. */
const NO_SCHEMA_FACTS: SelfHostSchemaFacts = { hasSchema: false, serverKeys: [], requiredKeys: [] };

/** A default-passing env-schema probe result (no schema → nothing to gate). */
function okSchemaFacts(overrides: Partial<SelfHostSchemaFacts> = {}): EnvSchemaProbeResult {
  return { kind: 'ok', facts: { ...NO_SCHEMA_FACTS, ...overrides } };
}

/** A default emitted-vars read (empty vars — a worker that ships no plaintext vars). */
function emittedVars(vars: Record<string, unknown> = {}): EmittedWorkerVarsResult {
  return { ok: true, vars };
}

/**
 * `file://` URLs for the runtime imports inside spawned-child env.ts fixtures. These are ESM
 * SPECIFIERS, not filesystem paths: an absolute Windows path (`D:/…`, as `pathslash` spells it)
 * parses as a URL whose protocol is `d:`, so Node rejects it with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME and the child's env.ts never evaluates — the probe then
 * reports `schema-error` for reasons that have nothing to do with the schema.
 * `pathToFileURL` is the same form `loadUserEnvFile` uses for real user env files.
 */
const srcFileUrl = (...segments: Array<string>): string =>
  pathToFileURL(join(import.meta.dirname, '..', '..', 'src', ...segments)).href;
const srcEnvPublic = srcFileUrl('runtime', 'env-public.ts');
const srcEnvHelpers = srcFileUrl('runtime', 'env-helpers.ts');

/**
 * Cloudflare credentials the parent may hold: Wrangler's names, their `CF_*` aliases and Void's
 * readiness JWT. Children that run project code must see none of them.
 */
const WRANGLER_AUTH_VARS = [
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
];

/** Set every Cloudflare credential on the parent; the top-level `afterEach` restores them. */
function stubWranglerCredentials(): void {
  for (const name of WRANGLER_AUTH_VARS) {
    vi.stubEnv(name, `secret-${name}`);
  }
}

/**
 * A field of the emitted auth schema: a bare name, or the `required` / `unique` / `references`
 * metadata the real build emits. `required` defaults to true, as it does for most build fields.
 */
type AuthSchemaField =
  | string
  | {
      name: string;
      required?: boolean;
      unique?: boolean;
      references?: { table: string; field: string; onDelete?: string };
    };

/**
 * Write a `.void/better-auth-schema.ts` fixture in the shape the build emits, so the post-build
 * auth check reads it as it would after a real build.
 */
function writeAuthSchemaArtifact(
  root: string,
  tables: Array<{ name: string; fields: Array<AuthSchemaField> }>,
): void {
  const migrationSchema = {
    dialect: 'sqlite',
    idStrategy: 'text',
    tables: tables.map((t, i) => ({
      name: t.name,
      order: i + 1,
      fields: Object.fromEntries(
        t.fields.map((f) => {
          const field = typeof f === 'string' ? { name: f } : f;
          return [
            field.name,
            {
              type: 'string',
              required: field.required !== false,
              unique: field.unique === true,
              index: false,
              bigint: false,
              ...(field.references ? { references: field.references } : {}),
            },
          ];
        }),
      ),
    })),
  };
  const dir = join(root, '.void');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'better-auth-schema.ts'),
    `// Auto-generated fixture\nexport const migrationSchema = ${JSON.stringify(migrationSchema, null, 2)} as const;\n`,
  );
}

/** Deploy seams that all pass by default and record a call trace; tests override single seams. */
function harness(overrides: Partial<CloudflareDeployDeps> = {}): {
  deps: CloudflareDeployDeps;
  trace: Array<string>;
  wranglerArgs: Array<Array<string>>;
  exitCalls: Array<number>;
} {
  const trace: Array<string> = [];
  const wranglerArgs: Array<Array<string>> = [];
  const exitCalls: Array<number> = [];
  const runWrangler: DeployWranglerRun = operationFixture((args) => {
    wranglerArgs.push(args);
    trace.push(`wrangler:${args[0]}`);
    if (args[0] === 'whoami') {
      return { ...cleanExit, stdout: '{"loggedIn":true,"accounts":[]}' };
    }
    // The post-apply pending check requires this affirmative "no pending" marker.
    if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'list') {
      return { ...cleanExit, stdout: '✅ No migrations to apply!\n' };
    }
    return cleanExit;
  });
  const deps: CloudflareDeployDeps = {
    exit: (code: number) => {
      exitCalls.push(code);
      throw new ExitError(code);
    },
    runWrangler,
    runBuild: () => {
      trace.push('build');
    },
    prepareFrameworkArtifact: async () => {
      trace.push('prepare-framework');
    },
    // One `deploy` call through the runner the deploy passed in, so a test that swaps the runner
    // still sees whether the upload happened. packages/deploy-cloudflare tests the real activation.
    activateVersion: async (options) => {
      if (!options.verifyUploader()) {
        return { ok: false, reason: 'uploader-changed' };
      }
      const result = await Promise.resolve(
        options.runWrangler(
          operationFixtureRequest([
            'deploy',
            ...(options.configPath ? ['-c', options.configPath] : []),
            ...(options.assetsDirectoryOverride
              ? ['--assets', options.assetsDirectoryOverride]
              : []),
            '--env=',
            '--experimental-provision=false',
            '--experimental-auto-create=false',
            '--autoconfig=false',
          ]),
          { capture: false },
        ),
      );
      if (result.status !== 0 || result.signal != null || result.error) {
        return { ok: false, reason: 'upload-failed', status: result.status };
      }
      return {
        ok: true,
        versionId: '22222222-2222-4222-8222-222222222222',
        previewUrl: 'https://preview.example.workers.dev',
        previousVersionId: null,
      };
    },
    // A constant hash: the uploader never changes unless a test says so.
    hashWranglerUploader: () => 'uploader-hash-unchanged',
    provision: (async (_root, configPath): Promise<ProvisionResult> => {
      trace.push('provision');
      return { resources: [], configPath, accountIdWritten: false };
    }) as CloudflareDeployDeps['provision'],
    resolveSchemaFacts: (() => okSchemaFacts()) as CloudflareDeployDeps['resolveSchemaFacts'],
    validateEmittedVars: (async () => ({
      kind: 'invalid-keys',
      invalidKeys: [],
    })) as CloudflareDeployDeps['validateEmittedVars'],
    readEmittedWorkerVars: (() => emittedVars()) as CloudflareDeployDeps['readEmittedWorkerVars'],
    dischargeSelfHostEnv: (async () => {
      trace.push('gate');
    }) as CloudflareDeployDeps['dischargeSelfHostEnv'],
    ensureAuthSecret: (async () => {
      trace.push('auth-secret');
      return { created: false };
    }) as CloudflareDeployDeps['ensureAuthSecret'],
    assertDurableObjectLifecycle: async () => {},
    // The stubbed build writes no generated config, so the real verifier would have nothing to read.
    verifyDeployConfig: () => ({ ok: true }),
    resolveGeneratedConfigPath: (root) => join(root, 'dist/ssr/wrangler.json'),
    assertMigrationsDeployable: () => {
      trace.push('migrate-gate');
    },
    checkMigrationApplySet: async () => ({ ok: true }),
    applyPostgresMigrations: async () => {
      trace.push('postgres-migrate');
      return [];
    },
    validateAuthMigrations: async () => {},
    ...overrides,
  };
  return { deps, trace, wranglerArgs, exitCalls };
}

describe('existing Cloudflare site handoff', () => {
  const existing = {
    versionId: 'original',
    bindings: [],
    runtime: { compatibility_date: '2026-02-24', compatibility_flags: ['nodejs_compat'] },
    script: { handlers: ['fetch', 'scheduled'] },
  };
  function site() {
    return makeProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { void: '*' } }),
      'void.json': '{}',
      'routes/index.ts': 'export const GET = () => "site";',
      'wrangler.jsonc': JSON.stringify({
        name: 'site',
        account_id: 'personal',
        compatibility_date: '2026-02-24',
        compatibility_flags: ['nodejs_compat'],
      }),
    });
  }
  /** The site after the deploy target moved its settings into void.config.ts. */
  function migratedSite() {
    const root = site();
    migrateLegacyVoidConfig(root);
    return root;
  }
  function build(root: string) {
    const typed = existsSync(join(root, 'void.config.ts'));
    const config = parseRootWranglerConfig(
      join(root, typed ? '.void-wrangler.jsonc' : 'wrangler.jsonc'),
    );
    config.triggers = { crons: [] };
    config.queues = { consumers: [], producers: [] };
    config.durable_objects = { bindings: [] };
    mkdirSync(join(root, 'dist/ssr'), { recursive: true });
    mkdirSync(join(root, '.wrangler/deploy'), { recursive: true });
    writeFileSync(join(root, 'dist/ssr/wrangler.json'), JSON.stringify(config));
    writeFileSync(
      join(root, '.wrangler/deploy/config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
    );
  }
  async function withTerminal<T>(interactive: boolean, action: () => Promise<T>): Promise<T> {
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: interactive });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: interactive });
    try {
      return await action();
    } finally {
      for (const [stream, descriptor] of [
        [process.stdin, stdin],
        [process.stdout, stdout],
      ] as const) {
        if (descriptor) {
          Object.defineProperty(stream, 'isTTY', descriptor);
        } else {
          Reflect.deleteProperty(stream, 'isTTY');
        }
      }
    }
  }
  function workerReadFailureHarness(
    recheck: DeployWranglerRunResult = {
      ...cleanExit,
      status: 1,
      stdout: '{"loggedIn":false}',
      stderr: 'Cloudflare authentication is required.',
    },
  ) {
    const readExistingWorker = vi
      .fn()
      .mockRejectedValueOnce(
        new CloudflareWorkerInspectionError('Could not verify existing Worker'),
      )
      .mockResolvedValue(existing);
    const { deps, wranglerArgs } = harness({ readExistingWorker });
    const originalRunner = deps.runWrangler!;
    let whoamiCalls = 0;
    deps.runWrangler = operationFixture((args, options) => {
      if (args[0] === 'whoami') {
        whoamiCalls++;
        return whoamiCalls === 1
          ? { ...cleanExit, stdout: '{"loggedIn":true,"accounts":[{"id":"personal"}]}' }
          : whoamiCalls === 2
            ? recheck
            : { ...cleanExit, stdout: '{"loggedIn":true,"accounts":[{"id":"personal"}]}' };
      }
      if (args[0] === 'login') {
        wranglerArgs.push(args);
        return cleanExit;
      }
      return originalRunner(operationFixtureRequest(args), options);
    });
    return { deps, readExistingWorker, wranglerArgs, getWhoamiCalls: () => whoamiCalls };
  }
  it('signs in inside a TTY deploy and retries the existing Worker read once', async () => {
    const root = site();
    const { deps, readExistingWorker, wranglerArgs, getWhoamiCalls } = workerReadFailureHarness();
    deps.runBuild = () => build(root);
    await withTerminal(true, () =>
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    );
    expect(readExistingWorker).toHaveBeenCalledTimes(2);
    expect(wranglerArgs.filter((args) => args[0] === 'login')).toHaveLength(1);
    expect(getWhoamiCalls()).toBe(3);
  });
  it('gives a login instruction without retrying in a non-TTY deploy', async () => {
    const root = site();
    const { deps, readExistingWorker, wranglerArgs } = workerReadFailureHarness();
    await expect(
      withTerminal(false, () =>
        runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
      ),
    ).rejects.toThrow('Run `void cloudflare login`');
    expect(readExistingWorker).toHaveBeenCalledTimes(1);
    expect(wranglerArgs.some((args) => args[0] === 'login')).toBe(false);
  });
  it('signs in once when the current OAuth user cannot access the pinned account', async () => {
    const root = site();
    const { deps, readExistingWorker, wranglerArgs } = workerReadFailureHarness({
      ...cleanExit,
      stdout: '{"loggedIn":true,"accounts":[{"id":"other"}]}',
    });
    deps.runBuild = () => build(root);
    await withTerminal(true, () =>
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    );
    expect(readExistingWorker).toHaveBeenCalledTimes(2);
    expect(wranglerArgs.filter((args) => args[0] === 'login')).toHaveLength(1);
  });
  it('does not open browser login for an invalid environment token', async () => {
    const root = site();
    const { deps, readExistingWorker, wranglerArgs } = workerReadFailureHarness();
    const originalRunner = deps.runWrangler!;
    deps.runWrangler = operationFixture((args, options) =>
      args[0] === 'whoami'
        ? {
            ...cleanExit,
            status: 1,
            stdout: '{"loggedIn":false}',
            stderr: 'Cloudflare authentication is required.',
          }
        : originalRunner(operationFixtureRequest(args), options),
    );
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-invalid-token');
    await expect(
      withTerminal(true, () =>
        runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
      ),
    ).rejects.toThrow('Cloudflare credentials from CLOUDFLARE_API_TOKEN were rejected');
    expect(readExistingWorker).toHaveBeenCalledTimes(1);
    expect(wranglerArgs.some((args) => args[0] === 'login')).toBe(false);
  });
  it('does not repeat login when the Worker read still fails after sign-in', async () => {
    const root = site();
    const { deps, readExistingWorker, wranglerArgs } = workerReadFailureHarness();
    readExistingWorker.mockRejectedValueOnce(
      new CloudflareWorkerInspectionError('Could not verify existing Worker'),
    );
    await expect(
      withTerminal(true, () =>
        runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
      ),
    ).rejects.toThrow('Could not verify existing Worker');
    expect(readExistingWorker).toHaveBeenCalledTimes(2);
    expect(wranglerArgs.filter((args) => args[0] === 'login')).toHaveLength(1);
  });
  it('preserves the Worker error when the fresh identity check is valid', async () => {
    const root = site();
    const { deps, readExistingWorker, wranglerArgs } = workerReadFailureHarness();
    const originalRunner = deps.runWrangler!;
    deps.runWrangler = operationFixture((args, options) =>
      args[0] === 'whoami'
        ? { ...cleanExit, stdout: '{"loggedIn":true,"accounts":[{"id":"personal"}]}' }
        : originalRunner(operationFixtureRequest(args), options),
    );
    await expect(
      withTerminal(true, () =>
        runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
      ),
    ).rejects.toThrow('Could not verify existing Worker');
    expect(readExistingWorker).toHaveBeenCalledTimes(1);
    expect(wranglerArgs.some((args) => args[0] === 'login')).toBe(false);
  });
  it('reuses the target and completes the same invocation without provisioning or secret writes', async () => {
    const root = site();
    const activateVersion = vi
      .fn<NonNullable<CloudflareDeployDeps['activateVersion']>>()
      .mockResolvedValue({
        ok: true,
        versionId: 'new',
        previousVersionId: 'original',
        previewUrl: 'https://site.example.com',
      });
    const { deps, trace, wranglerArgs } = harness({
      readExistingWorker: async () => existing,
      runBuild: () => build(root),
      activateVersion,
    });
    await runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps);
    expect(activateVersion).toHaveBeenCalledWith(
      expect.objectContaining({ preserveTriggers: true, expectedPreviousVersionId: 'original' }),
    );
    expect(trace).not.toContain('provision');
    expect(trace).not.toContain('auth-secret');
    expect(wranglerArgs.some((args) => ['d1', 'secret', 'containers'].includes(args[0]!))).toBe(
      false,
    );
    expect(JSON.parse(readFileSync(join(root, '.void/project.json'), 'utf8')).platform).toBe(
      'cloudflare',
    );
    expect(existsSync(join(root, '.void/cloudflare-link.json'))).toBe(false);
  });
  it('accepts comments in the generated config during an existing site deploy', async () => {
    const root = site();
    const { deps } = harness({
      readExistingWorker: async () => existing,
      runBuild: () => {
        build(root);
        const generatedPath = join(root, 'dist/ssr/wrangler.json');
        writeFileSync(
          generatedPath,
          `// generated from wrangler.jsonc\n${readFileSync(generatedPath, 'utf8')}`,
        );
      },
    });

    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).resolves.toBeUndefined();
  });
  it('records the resolved traffic snapshot across ordinary deployments', async () => {
    const root = site();
    const trafficConfig = {
      workers_dev: false,
      preview_urls: true,
      routes: [{ pattern: 'site.example.com', custom_domain: true }],
    };
    writeWranglerPublishedTrafficSnapshot(join(root, 'wrangler.jsonc'), trafficConfig);
    const activateVersion = vi
      .fn<NonNullable<CloudflareDeployDeps['activateVersion']>>()
      .mockImplementation(async (options) => {
        expect(options.previousTrafficConfig).toEqual(trafficConfig);
        return {
          ok: true,
          versionId: 'new',
          previousVersionId: 'original',
          previewUrl: 'https://site.example.com',
          trafficConfig,
        };
      });
    const { deps } = harness({
      runBuild: () => build(root),
      activateVersion,
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(readWranglerPublishedTrafficSnapshot(join(root, 'wrangler.jsonc'))).toEqual(
      trafficConfig,
    );
    expect(activateVersion).toHaveBeenCalledTimes(2);
  });

  it('normalizes duplicate flags emitted by an older project plugin before upload', async () => {
    const root = site();
    const configPath = join(root, 'wrangler.jsonc');
    const activateVersion = vi
      .fn<NonNullable<CloudflareDeployDeps['activateVersion']>>()
      .mockImplementation(async (options) => {
        expect(parseRootWranglerConfig(options.configPath!).compatibility_flags).toEqual([
          'nodejs_compat',
        ]);
        return {
          ok: true,
          versionId: 'new',
          previousVersionId: 'original',
          previewUrl: 'https://site.example.com',
        };
      });
    const { deps } = harness({
      readExistingWorker: async () => existing,
      runBuild: () => {
        build(root);
        const generatedPath = join(root, 'dist/ssr/wrangler.json');
        const generated = parseRootWranglerConfig(generatedPath);
        generated.compatibility_flags = ['nodejs_compat', 'nodejs_compat'];
        writeFileSync(generatedPath, JSON.stringify(generated));
      },
      verifyDeployConfig: verifyGeneratedDeployConfig,
      activateVersion,
    });

    await runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps);

    expect(activateVersion).toHaveBeenCalledOnce();
    expect(parseRootWranglerConfig(configPath).compatibility_flags).toEqual(['nodejs_compat']);
    expect(readCloudflareLink(root)).toBeNull();
  });
  it('retains the link guard after a failed build and verifies the Worker again on retry', async () => {
    const root = migratedSite();
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/index.tsx'), 'export default () => null;');
    writeFileSync(join(root, 'pages/index.server.ts'), 'export const prerender = true;');
    const readExistingWorker = vi.fn().mockResolvedValue(existing);
    const confirmIsrSetup = vi.fn().mockResolvedValue(false);
    const { deps } = harness({
      readExistingWorker,
      isCI: false,
      confirmIsrSetup,
      runBuild: () => {
        throw new Error('build failed');
      },
    });
    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(existsSync(join(root, '.void/cloudflare-link.json'))).toBe(true);
    deps.runBuild = () => build(root);
    await runCloudflareDeploy(root, {}, silentCliLog, deps);
    expect(readExistingWorker).toHaveBeenCalledTimes(2);
    expect(confirmIsrSetup).toHaveBeenCalledOnce();
    expect(existsSync(join(root, '.void/cloudflare-link.json'))).toBe(false);
  });
  it('retries only through candidates recorded after uploaded Worker validation', async () => {
    const root = site();
    const activateVersion = vi
      .fn<NonNullable<CloudflareDeployDeps['activateVersion']>>()
      .mockImplementationOnce(async (options) => {
        await options.validateUploadedVersion?.('candidate');
        await options.recordVerifiedCandidate?.('candidate', 'original');
        return {
          ok: false,
          reason: 'readiness-failed',
          versionId: 'candidate',
          previousVersionId: 'original',
          rollback: 'not-needed',
        };
      })
      .mockImplementationOnce(async (options) => {
        expect(options.trustedInheritanceVersionIds).toEqual(['candidate']);
        return {
          ok: true,
          versionId: 'retry',
          previousVersionId: 'original',
          previewUrl: 'https://site.example.com',
        };
      });
    const { deps } = harness({
      readExistingWorker: async () => existing,
      runBuild: () => build(root),
      activateVersion,
    });
    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(readCloudflareLink(root)?.candidateReceipt).toEqual({
      parentVersionId: 'original',
      versionIds: ['candidate'],
    });
    await runCloudflareDeploy(root, {}, silentCliLog, deps);
    expect(activateVersion).toHaveBeenCalledTimes(2);
    expect(readCloudflareLink(root)).toBeNull();
  });

  it('keeps a normal Cloudflare upload receipt after staging fails and clears it on retry', async () => {
    const root = site();
    const activateVersion = vi
      .fn<NonNullable<CloudflareDeployDeps['activateVersion']>>()
      .mockImplementationOnce(async (options) => {
        await options.recordVerifiedCandidate?.('candidate', 'original');
        return {
          ok: false,
          reason: 'readiness-staging-failed',
          versionId: 'candidate',
          previousVersionId: 'original',
          rollback: 'not-needed',
        };
      })
      .mockImplementationOnce(async (options) => {
        expect(options.trustedInheritanceVersionIds).toEqual(['candidate']);
        return {
          ok: true,
          versionId: 'retry',
          previousVersionId: 'original',
          previewUrl: 'https://site.example.com',
        };
      });
    const { deps } = harness({ runBuild: () => build(root), activateVersion });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(existsSync(join(root, '.void/cloudflare-candidate.json'))).toBe(true);
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(existsSync(join(root, '.void/cloudflare-candidate.json'))).toBe(false);
  });

  it('allows an explicit atomic deploy after the Durable Object migration preflight', async () => {
    const root = site();
    const configPath = join(root, 'wrangler.jsonc');
    const config = parseRootWranglerConfig(configPath);
    config.migrations = [{ tag: 'v1', new_sqlite_classes: ['Room'] }];
    writeFileSync(configPath, JSON.stringify(config));
    const assertDurableObjectLifecycle = vi.fn().mockResolvedValue(undefined);
    const activateVersion = vi
      .fn<NonNullable<CloudflareDeployDeps['activateVersion']>>()
      .mockResolvedValue({
        ok: true,
        versionId: 'new',
        previousVersionId: 'original',
        previewUrl: 'https://site.example.com',
      });
    const { deps } = harness({
      runBuild: () => build(root),
      assertDurableObjectLifecycle,
      activateVersion,
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare', atomic: true }, silentCliLog, deps);
    expect(assertDurableObjectLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ allowPendingAtomicMigration: true }),
    );
    expect(activateVersion).toHaveBeenCalledWith(expect.objectContaining({ atomic: true }));
  });

  it('uses the project Cloudflare deploy mode on subsequent plain deploys', async () => {
    const root = site();
    const configPath = join(root, 'wrangler.jsonc');
    const config = parseRootWranglerConfig(configPath);
    config.migrations = [{ tag: 'v1', new_sqlite_classes: ['Room'] }];
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ deploy: { cloudflare: { mode: 'atomic' } } }),
    );
    const assertDurableObjectLifecycle = vi.fn().mockResolvedValue(undefined);
    const activateVersion = vi
      .fn<NonNullable<CloudflareDeployDeps['activateVersion']>>()
      .mockResolvedValue({
        ok: true,
        versionId: 'new',
        previousVersionId: 'original',
        previewUrl: 'https://site.example.com',
      });
    const { deps } = harness({
      runBuild: () => build(root),
      assertDurableObjectLifecycle,
      activateVersion,
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(assertDurableObjectLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ allowPendingAtomicMigration: true }),
    );
    expect(activateVersion).toHaveBeenCalledWith(expect.objectContaining({ atomic: true }));
  });

  it('clears the old upload receipt when atomic publication succeeds but readiness fails', async () => {
    const root = site();
    const configPath = join(root, 'wrangler.jsonc');
    const config = parseRootWranglerConfig(configPath);
    config.migrations = [{ tag: 'v1', new_sqlite_classes: ['Room'] }];
    writeFileSync(configPath, JSON.stringify(config));
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(
      join(root, '.void/cloudflare-candidate.json'),
      JSON.stringify({
        accountId: 'personal',
        workerName: 'site',
        parentVersionId: 'original',
        versionIds: ['candidate'],
      }),
    );
    const { deps } = harness({
      runBuild: () => build(root),
      activateVersion: async (options) => {
        expect(options.trustedInheritanceVersionIds).toEqual(['candidate']);
        return {
          ok: false,
          reason: 'atomic-readiness-failed',
          versionId: 'published',
          previousVersionId: 'original',
          rollback: 'unavailable',
        };
      },
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare', atomic: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(existsSync(join(root, '.void/cloudflare-candidate.json'))).toBe(false);
  });
  it('rejects a forged candidate receipt written by the Worker schema probe', async () => {
    const root = site();
    const { deps, trace } = harness({
      readExistingWorker: async () => existing,
      resolveSchemaFacts: () => {
        mkdirSync(join(root, '.void'), { recursive: true });
        writeFileSync(
          join(root, '.void/cloudflare-link.json'),
          JSON.stringify({
            accountId: 'personal',
            workerName: 'site',
            candidateReceipt: { parentVersionId: 'original', versionIds: ['forged'] },
          }),
        );
        return okSchemaFacts();
      },
    });
    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toThrow('handoff changed while project code was running');
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
  });
  it('rejects a newly inferred resource before provisioning and build', async () => {
    const root = site();
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/index.md'), '# Home');
    writeFileSync(
      join(root, 'routes/index.ts'),
      'import { kv } from "void/kv"; export const GET = () => kv.get("key");',
    );
    const { deps, trace } = harness({ readExistingWorker: async () => existing });
    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toThrow(/cannot provision[\s\S]*KV \(KV namespace\)[\s\S]*app uses env.KV/);
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('provision');
  });

  it.each(['prerender', 'markdown', 'revalidate'])(
    'keeps the declined ISR choice on subsequent deploys for a %s site',
    async (mode) => {
      const root = migratedSite();
      mkdirSync(join(root, 'pages'));
      if (mode === 'markdown') {
        writeFileSync(join(root, 'pages/index.md'), '# Home');
      } else {
        writeFileSync(join(root, 'pages/index.tsx'), 'export default () => null;');
        writeFileSync(
          join(root, 'pages/index.server.ts'),
          mode === 'prerender'
            ? 'export const prerender = true; export const loader = () => ({});'
            : 'export const revalidate = 60; export const loader = () => ({});',
        );
      }
      const confirmIsrSetup = vi.fn().mockResolvedValue(false);
      const { deps, trace, wranglerArgs } = harness({
        isCI: false,
        confirmIsrSetup,
        readExistingWorker: async () => existing,
        runBuild: () => build(root),
        verifyDeployConfig: verifyGeneratedDeployConfig,
      });

      await runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps);

      expect(trace).toContain('wrangler:deploy');
      expect(trace).not.toContain('provision');
      expect(wranglerArgs.some((args) => ['kv', 'containers', 'secret'].includes(args[0]!))).toBe(
        false,
      );
      expect(
        parseRootWranglerConfig(join(root, '.void-wrangler.jsonc')).kv_namespaces,
      ).toBeUndefined();
      expect(
        parseRootWranglerConfig(join(root, 'dist/ssr/wrangler.json')).kv_namespaces,
      ).toBeUndefined();
      expect(readCloudflareLink(root)).toBeNull();

      expect(readConfig(root).routing?.isr).toBe(false);
      await runCloudflareDeploy(root, {}, silentCliLog, deps);
      expect(confirmIsrSetup).toHaveBeenCalledOnce();
      expect(trace).not.toContain('provision');
      // Completing the handoff must not change the saved cache policy.
      const { desired } = await computeDesiredCloudflareResources(
        root,
        readConfig(root),
        join(root, '.void-wrangler.jsonc'),
      );
      expect(desired.kvNamespaces).toEqual([]);
    },
  );

  it('keeps an existing ISR namespace during handoff', async () => {
    const root = site();
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/index.md'), '# Home');
    const configPath = join(root, 'wrangler.jsonc');
    const config = parseRootWranglerConfig(configPath);
    config.kv_namespaces = [{ binding: 'ISR_CACHE', id: REAL_KV_ID }];
    writeFileSync(configPath, JSON.stringify(config));
    const verify = vi.fn(verifyGeneratedDeployConfig);
    const { deps, trace } = harness({
      readExistingWorker: async () => ({
        ...existing,
        bindings: [{ name: 'ISR_CACHE', type: 'kv_namespace', namespace_id: REAL_KV_ID }],
      }),
      runBuild: () => build(root),
      verifyDeployConfig: verify,
    });

    await runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps);

    expect(trace).toContain('wrangler:deploy');
    expect(trace).not.toContain('provision');
    expect(verify).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        desired: expect.objectContaining({
          kvNamespaces: [{ binding: 'ISR_CACHE', title: 'site-isr-cache' }],
        }),
      }),
    );
    expect(parseRootWranglerConfig(configPath).kv_namespaces).toEqual(config.kv_namespaces);
  });

  it('requires an application KV binding named ISR_CACHE', async () => {
    const root = site();
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ inference: { bindings: { kv: 'ISR_CACHE' } } }),
    );
    const { deps, trace } = harness({ readExistingWorker: async () => existing });

    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toThrow(/cannot provision[\s\S]*ISR_CACHE \(KV namespace\)/);
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('provision');
  });

  it('rejects an ISR namespace added by the build during handoff', async () => {
    const root = migratedSite();
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/index.md'), '# Home');
    const { deps, trace } = harness({
      isCI: false,
      confirmIsrSetup: async () => false,
      readExistingWorker: async () => existing,
      runBuild: () => {
        build(root);
        const generatedPath = join(root, 'dist/ssr/wrangler.json');
        const generated = parseRootWranglerConfig(generatedPath);
        generated.kv_namespaces = [{ binding: 'ISR_CACHE', id: REAL_KV_ID }];
        writeFileSync(generatedPath, JSON.stringify(generated));
      },
    });

    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toThrow('Linking cannot add or replace kv_namespaces');
    expect(trace).not.toContain('provision');
    expect(trace).not.toContain('wrangler:deploy');
  });

  it.each([false, true])(
    'enables ISR during the first handoff (configured opt-in: %s)',
    async (configured) => {
      const root = site();
      mkdirSync(join(root, 'pages'));
      writeFileSync(join(root, 'pages/index.md'), '# Home');
      if (configured) {
        writeFileSync(join(root, 'void.json'), JSON.stringify({ routing: { isr: true } }));
      }
      migrateLegacyVoidConfig(root);
      const confirmIsrSetup = vi.fn().mockResolvedValue(true);
      const provision = vi
        .fn<NonNullable<CloudflareDeployDeps['provision']>>()
        .mockImplementation(async (_root, configPath, desired) => {
          expect(readConfig(root).routing?.isr).toBe(true);
          expect(desired).toEqual({
            kvNamespaces: [{ binding: 'ISR_CACHE', title: 'site-isr-cache' }],
            queues: [],
          });
          writeProvisionedWranglerConfig(
            root,
            { kv: { binding: 'ISR_CACHE', id: REAL_KV_ID } },
            { configPath },
          );
          return {
            configPath,
            accountIdWritten: false,
            resources: [
              {
                kind: 'kv',
                binding: 'ISR_CACHE',
                name: 'site-isr-cache',
                action: 'created',
                id: REAL_KV_ID,
              },
            ],
          };
        });
      const activateVersion = vi
        .fn<NonNullable<CloudflareDeployDeps['activateVersion']>>()
        .mockImplementation(async (options) => {
          expect(parseRootWranglerConfig(options.configPath!).kv_namespaces).toEqual([
            { binding: 'ISR_CACHE', id: REAL_KV_ID },
          ]);
          await options.validateUploadedVersion?.('candidate');
          return {
            ok: true,
            versionId: 'candidate',
            previousVersionId: 'original',
            previewUrl: 'https://site.example.com',
          };
        });
      const { deps, wranglerArgs } = harness({
        isCI: configured,
        confirmIsrSetup,
        provision,
        readExistingWorker: async ({ versionId }) =>
          versionId
            ? {
                ...existing,
                versionId,
                bindings: [{ name: 'ISR_CACHE', type: 'kv_namespace', namespace_id: REAL_KV_ID }],
              }
            : existing,
        runBuild: () => build(root),
        verifyDeployConfig: verifyGeneratedDeployConfig,
        activateVersion,
      });

      await runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps);
      expect(provision).toHaveBeenCalledOnce();
      expect(confirmIsrSetup).toHaveBeenCalledTimes(configured ? 0 : 1);
      expect(activateVersion).toHaveBeenCalledOnce();
      expect(wranglerArgs.some((args) => ['d1', 'secret', 'containers'].includes(args[0]!))).toBe(
        false,
      );
      expect(readCloudflareLink(root)).toBeNull();
      await runCloudflareDeploy(root, {}, silentCliLog, deps);
      expect(provision).toHaveBeenCalledOnce();
      expect(confirmIsrSetup).toHaveBeenCalledTimes(configured ? 0 : 1);
    },
  );

  it('reuses the cache recorded before a provisioning failure when retrying the handoff', async () => {
    const root = migratedSite();
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/index.md'), '# Home');
    const confirmIsrSetup = vi.fn().mockResolvedValue(true);
    const provision = vi
      .fn<NonNullable<CloudflareDeployDeps['provision']>>()
      .mockImplementation(async (_root, configPath) => {
        writeProvisionedWranglerConfig(
          root,
          { kv: { binding: 'ISR_CACHE', id: REAL_KV_ID } },
          { configPath },
        );
        throw new Error('provisioning interrupted after config update');
      });
    const { deps, trace } = harness({
      isCI: false,
      confirmIsrSetup,
      provision,
      readExistingWorker: async () => existing,
      runBuild: () => build(root),
    });
    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toThrow('provisioning interrupted');
    expect(readCloudflareLink(root)).not.toBeNull();
    expect(readConfig(root).routing?.isr).toBe(true);
    await runCloudflareDeploy(root, {}, silentCliLog, deps);
    expect(trace).toContain('wrangler:deploy');
    expect(provision).toHaveBeenCalledOnce();
    expect(confirmIsrSetup).toHaveBeenCalledOnce();
    expect(readCloudflareLink(root)).toBeNull();
  });

  it('requires a configured ISR choice for non-interactive migration', async () => {
    const root = site();
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/index.md'), '# Home');
    const confirmIsrSetup = vi.fn();
    const { deps, trace } = harness({
      isCI: true,
      confirmIsrSetup,
      readExistingWorker: async () => existing,
    });
    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toThrow('Set routing.isr to true');
    expect(confirmIsrSetup).not.toHaveBeenCalled();
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('provision');
    expect(readConfig(root).routing?.isr).toBeUndefined();
  });

  it.each([undefined, './migrations', 'db/migrations', './db/migrations'])(
    'preserves an existing D1 binding with migrations_dir %s without provisioning',
    async (migrationsDir) => {
      const root = site();
      const databaseId = '11111111-1111-4111-8111-111111111111';
      const configPath = join(root, 'wrangler.jsonc');
      const config = parseRootWranglerConfig(configPath);
      const database = {
        binding: 'DB',
        database_name: 'existing-db',
        database_id: databaseId,
        ...(migrationsDir === undefined ? {} : { migrations_dir: migrationsDir }),
      };
      config.d1_databases = [database];
      writeFileSync(configPath, JSON.stringify(config));
      writeFileSync(
        join(root, 'routes/index.ts'),
        'export const GET = (c) => c.env.DB.prepare("SELECT 1").first();',
      );
      const { deps, trace, wranglerArgs } = harness({
        readExistingWorker: async () => ({
          ...existing,
          bindings: [{ name: 'DB', type: 'd1', id: databaseId }],
        }),
        runBuild: () => build(root),
      });

      await runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps);

      expect(trace).toContain('wrangler:deploy');
      expect(trace).not.toContain('provision');
      expect(wranglerArgs.some((args) => args[0] === 'd1')).toBe(false);
      expect(parseRootWranglerConfig(configPath).d1_databases).toEqual([database]);
      expect(readCloudflareLink(root)).toBeNull();
    },
  );
});

describe('ensureCloudflareAuthSecret', () => {
  function authSecretProject(): string {
    return makeProject({
      'package.json': JSON.stringify({ name: 'authapp' }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'authapp' }),
    });
  }

  it('preserves an existing remote secret without writing it again', async () => {
    const root = authSecretProject();
    const calls: Array<Array<string>> = [];
    const result = await ensureCloudflareAuthSecret({
      root,
      configPath: join(root, 'wrangler.jsonc'),
      accountId: 'acc123',
      workerName: 'authapp',
      runWrangler: operationFixture((args) => {
        calls.push(args);
        return {
          ...cleanExit,
          stdout: JSON.stringify([{ name: 'BETTER_AUTH_SECRET', type: 'secret_text' }]),
        };
      }),
    });

    expect(result).toEqual({ created: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'secret',
      'list',
      '--format=json',
      '-c',
      join(root, 'wrangler.jsonc'),
      '--env=',
    ]);
  });

  it('creates a missing secret through stdin and verifies it before returning', async () => {
    const root = authSecretProject();
    const calls: Array<{
      args: Array<string>;
      opts: Parameters<DeployWranglerRun>[1];
    }> = [];
    let listCount = 0;
    const result = await ensureCloudflareAuthSecret({
      root,
      configPath: join(root, 'wrangler.jsonc'),
      accountId: 'acc123',
      workerName: 'authapp',
      runWrangler: operationFixture((args, opts) => {
        calls.push({ args, opts });
        if (args[1] === 'list') {
          listCount++;
          return {
            ...cleanExit,
            stdout: listCount === 1 ? '[]' : JSON.stringify([{ name: 'BETTER_AUTH_SECRET' }]),
          };
        }
        return cleanExit;
      }),
    });

    expect(result).toEqual({ created: true });
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
      ['secret', 'list', '--format=json'],
      ['secret', 'put', 'BETTER_AUTH_SECRET'],
      ['secret', 'list', '--format=json'],
    ]);
    const put = calls[1]!;
    expect(put.opts.capture).toBe(true);
    expect(put.opts.input).toMatch(/^[0-9a-f]{64}\n$/);
    expect(put.args.join(' ')).not.toContain(put.opts.input!.trim());
  });

  it('bootstraps the secret when the Worker has not been deployed yet', async () => {
    const root = authSecretProject();
    let call = 0;
    const result = await ensureCloudflareAuthSecret({
      root,
      configPath: join(root, 'wrangler.jsonc'),
      accountId: 'acc123',
      workerName: 'authapp',
      runWrangler: operationFixture((args) => {
        call++;
        if (call === 1) {
          return {
            ...cleanExit,
            status: 1,
            stderr: [
              'Worker "authapp" not found.',
              'If this is a new Worker, run `wrangler deploy` first to create it.',
              "Otherwise, check that the Worker name is correct and you're logged into the right account.",
            ].join('\n'),
          };
        }
        if (args[1] === 'list') {
          return { ...cleanExit, stdout: JSON.stringify([{ name: 'BETTER_AUTH_SECRET' }]) };
        }
        return cleanExit;
      }),
    });

    expect(result).toMatchObject({ created: true, workerWasMissing: true });
    expect(result.candidateSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(call).toBe(1);
  });

  it('fails closed when secret creation fails without surfacing the generated value', async () => {
    const root = authSecretProject();
    let generated = '';
    const promise = ensureCloudflareAuthSecret({
      root,
      configPath: join(root, 'wrangler.jsonc'),
      accountId: 'acc123',
      workerName: 'authapp',
      runWrangler: operationFixture((args, opts) => {
        if (args[1] === 'list') {
          return { ...cleanExit, stdout: '[]' };
        }
        generated = opts.input?.trim() ?? '';
        return { ...cleanExit, status: 1, stderr: `unsafe diagnostic ${generated}` };
      }),
    });

    await expect(promise).rejects.toMatchObject({ reason: 'put-failed' });
    await expect(promise).rejects.not.toThrow(generated);
  });

  it('fails closed when the secret is still absent after a successful put', async () => {
    const root = authSecretProject();
    await expect(
      ensureCloudflareAuthSecret({
        root,
        configPath: join(root, 'wrangler.jsonc'),
        accountId: 'acc123',
        workerName: 'authapp',
        runWrangler: operationFixture((args) =>
          args[1] === 'list' ? { ...cleanExit, stdout: '[]' } : cleanExit,
        ),
      }),
    ).rejects.toMatchObject({ reason: 'verification-failed' });
  });
});

/** A worker-bearing D1 app fixture with a fully-provisioned wrangler.jsonc. */
function d1Project(
  wrangler: Record<string, unknown>,
  extraFiles: Record<string, string> = {},
): string {
  return makeProject({
    'package.json': JSON.stringify({ name: 'myapp' }),
    'void.json': JSON.stringify({}),
    'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
    'wrangler.jsonc': JSON.stringify(wrangler, null, 2),
    ...extraFiles,
  });
}

/** A minimal worker-bearing app whose source inference enables `void/sandbox`. */
function sandboxProject(): string {
  return makeProject({
    'package.json': JSON.stringify({ name: 'sandbox-app' }),
    'void.json': JSON.stringify({}),
    'routes/index.ts': [
      `import { getSandbox } from 'void/sandbox';`,
      `export const GET = () => Response.json({ sandbox: Boolean(getSandbox) });`,
    ].join('\n'),
    'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'sandbox-app' }, null, 2),
  });
}

/** One non-destructive checked-in migration so the remote migrate path runs. */
const INIT_MIGRATION = {
  'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
};

const PROVISIONED_D1 = {
  account_id: 'acc123',
  name: 'myapp',
  d1_databases: [
    {
      binding: 'DB',
      database_name: 'myapp-db',
      database_id: REAL_D1_ID,
      migrations_dir: './db/migrations',
    },
  ],
};

/**
 * The non-id bindings a real Class-A build emits into `dist/ssr/wrangler.json` (see
 * `playground/kitchen-sink/dist/ssr/wrangler.json`): `ai`, `queues`, `durable_objects`,
 * `migrations`, `new_sqlite_classes`, `containers`, `vars`, `assets`, `triggers`, `rules`,
 * `observability`, `main`, `compatibility_date/flags`, plus the ~20 empty arrays wrangler
 * always materializes. The binding-identity check MUST ignore every one of these and inspect
 * ONLY the four id-bearing arrays (`d1_databases`/`kv_namespaces`/`r2_buckets`/`hyperdrive`).
 */
const KITCHEN_SINK_NON_ID_BINDINGS = {
  ai: { binding: 'AI' },
  queues: {
    producers: [{ binding: 'JOBS', queue: 'jobs' }],
    consumers: [{ queue: 'jobs', max_batch_size: 10 }],
  },
  durable_objects: {
    bindings: [
      { name: 'SANDBOX', class_name: 'Sandbox' },
      { name: 'WS', class_name: 'ChatRoom' },
    ],
  },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Sandbox'] }],
  containers: [{ class_name: 'Sandbox', image: './Dockerfile' }],
  vars: { __VOID_AI_GATEWAY: 'my-gateway', PUBLIC_FLAG: 'on' },
  assets: { directory: './dist/client', binding: 'ASSETS' },
  triggers: { crons: ['0 0 * * *'] },
  rules: [{ type: 'ESModule', globs: ['**/*.js'] }],
  observability: { enabled: true },
  main: './dist/ssr/index.js',
  compatibility_date: '2025-01-01',
  compatibility_flags: ['nodejs_compat'],
  services: [],
  vectorize: [],
  workflows: [],
  dispatch_namespaces: [],
  analytics_engine_datasets: [],
  hyperdrive: [],
};

// ---------------------------------------------------------------------------
// Desired set (from source, pre-build)
// ---------------------------------------------------------------------------

describe('computeDesiredCloudflareResources — desired set from source', () => {
  it('does not provision resources used only by a dev route', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': '{}',
      'routes/api/debug.dev.ts': `export const GET = (c) => {
        c.env.DB.prepare('SELECT 1');
        c.env.KV.get('key');
        c.env.STORAGE.get('key');
        return new Response('ok');
      };`,
    });
    const { desired, reasons } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );

    expect(desired.d1).toBeUndefined();
    expect(desired.kvNamespaces).toEqual([]);
    expect(desired.r2).toBeUndefined();
    expect(reasons.has('DB')).toBe(false);
    expect(reasons.has('KV')).toBe(false);
    expect(reasons.has('STORAGE')).toBe(false);
  });

  it('expects one native trigger for jobs sharing an expression', async () => {
    const source = 'export const cron = "* * * * *"; export default () => {};';
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'shared-crons' }),
      'void.json': '{}',
      'crons/first.ts': source,
      'crons/second.ts': source,
    });
    const result = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(result.expectedCrons).toEqual(['* * * * *']);
  });

  it('maps D1/KV/R2 from the import walk and queues from the scanner', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = async (c) => {
        await c.env.KV.get('k');
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
      'queues/jobs.ts': `export default {};`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toEqual({
      binding: 'DB',
      name: 'myapp-db',
      migrationsDir: './db/migrations',
    });
    expect(desired.kvNamespaces).toEqual([{ binding: 'KV', title: 'myapp-kv' }]);
    expect(desired.r2).toEqual({ binding: 'STORAGE', bucketName: 'myapp-storage' });
    expect(desired.queues).toEqual(['jobs']);
    expect(desired.hyperdrive).toBeUndefined();
  });

  it('keeps an explicitly configured R2 bucket named default', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': '{}',
      'routes/index.ts': `export const GET = (c) => c.env.STORAGE.get('item');`,
      'wrangler.jsonc': JSON.stringify({
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }],
      }),
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.r2).toEqual({ binding: 'STORAGE', bucketName: 'default' });
  });

  it('distinguishes an authored default bucket from a generated typed-config placeholder', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': '{}',
      'routes/index.ts': `export const GET = (c) => c.env.STORAGE.get('item');`,
      '.void-wrangler.jsonc': JSON.stringify({
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }],
      }),
    });
    const configPath = join(root, '.void-wrangler.jsonc');
    const generated = await computeDesiredCloudflareResources(root, readConfig(root), configPath);
    expect(generated.desired.r2?.bucketName).toBe('myapp-storage');

    const authored = await computeDesiredCloudflareResources(
      root,
      {
        ...readConfig(root),
        cloudflare: { r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }] },
      },
      configPath,
    );
    expect(authored.desired.r2?.bucketName).toBe('default');
  });

  it('desires Hyperdrive (not D1) for a PostgreSQL app', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'pgapp' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toBeUndefined();
    expect(desired.hyperdrive?.binding).toBe('HYPERDRIVE');
    expect(desired.hyperdrive?.name).toBe('pgapp-hyperdrive');
  });

  it('desires ISR_CACHE (KV) when a page uses `revalidate`', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'israpp' }),
      'void.json': JSON.stringify({}),
      'pages/index.tsx': `export default () => null;`,
      'pages/index.server.ts': `export const revalidate = 60;\nexport const loader = () => ({});`,
    });
    const { desired, reasons } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.kvNamespaces.map((k) => k.binding)).toContain('ISR_CACHE');
    expect(reasons.get('ISR_CACHE')).toMatch(/revalidate/);
  });

  it('reuses the stored database_name from wrangler.jsonc', async () => {
    const root = d1Project({
      d1_databases: [{ binding: 'DB', database_name: 'legacy-db', database_id: REAL_D1_ID }],
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1?.name).toBe('legacy-db');
  });

  it('ignores a synced placeholder database_name paired with the local id', async () => {
    // A not-yet-provisioned entry: `database_id: "local"` with a placeholder name.
    // The stored name must NOT become the prod DB identity — derive the worker name.
    const root = d1Project({
      d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1?.name).toBe('myapp-db');
  });

  it('uses an explicitly configured D1 name before its remote ID is pinned', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.config.ts': `export default { cloudflare: { name: 'myapp', d1_databases: [{ binding: 'DB', database_name: 'codiff-public' }] } };`,
      'routes/index.ts': `export const GET = ({ env }: { env: { DB: unknown } }) => env.DB;`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, '.void-wrangler.jsonc'),
    );
    expect(desired.d1?.name).toBe('codiff-public');
  });

  it('honors inference.bindings overrides (disabled D1, custom KV, forced R2)', async () => {
    // Route uses env.DB/KV/STORAGE, but void.json disables D1 and renames KV — the
    // desired set must match the build (which consumes the same overrides), so D1 is
    // absent and KV uses the custom binding name.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({
        inference: { bindings: { db: false, kv: 'MYKV', storage: true } },
      }),
      'routes/index.ts': `export const GET = async (c) => {
        await c.env.KV.get('k');
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toBeUndefined();
    expect(desired.kvNamespaces).toEqual([{ binding: 'MYKV', title: 'myapp-kv' }]);
    expect(desired.r2).toEqual({ binding: 'STORAGE', bucketName: 'myapp-storage' });
  });

  it('forces D1 with a custom binding via inference.bindings', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({ inference: { bindings: { db: 'MYDB' } } }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toEqual({
      binding: 'MYDB',
      name: 'myapp-db',
      migrationsDir: './db/migrations',
    });
  });

  it('carries a custom Workers AI name into deploy verification expectations', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({ inference: { bindings: { ai: 'MY_AI' } } }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const resources = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(resources.needsAI).toBe(true);
    expect(resources.aiBindingName).toBe('MY_AI');
  });

  it('desires D1 for a migration-only SQLite app (no env.DB use, no auth)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'db/migrations/0000_init.sql': `CREATE TABLE t (id INTEGER PRIMARY KEY);`,
    });
    const { desired, reasons } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toEqual({
      binding: 'DB',
      name: 'myapp-db',
      migrationsDir: './db/migrations',
    });
    expect(reasons.get('DB')).toMatch(/migrations/);
  });

  it('does not require Hyperdrive for a pg app with no DB use, auth, or migrations', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'pgapp' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.hyperdrive).toBeUndefined();
    expect(desired.d1).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL checked-in migrations: direct Cloudflare deploy validates and applies
// them transactionally before uploading the Worker.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — PostgreSQL checked-in migrations', () => {
  /** A worker-bearing pg app with a provisioned Hyperdrive config (drift-clean). */
  function pgProject(extraFiles: Record<string, string> = {}): string {
    return makeProject({
      'package.json': JSON.stringify({ name: 'pgapp' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'pgapp',
          hyperdrive: [{ binding: 'HYPERDRIVE', id: REAL_KV_ID }],
        },
        null,
        2,
      ),
      ...extraFiles,
    });
  }

  it('requires DATABASE_URL before any account operation when pg migrations are checked in', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    const root = pgProject({
      'db/migrations/0000_init.sql': 'CREATE TABLE notes (id integer primary key);',
    });
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs).toEqual([]);
    expect(trace).toEqual([]);
  });

  it('validates and applies pg migrations before uploading the Worker', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://prod.example/app');
    const root = pgProject({
      'db/migrations/0000_init.sql': 'CREATE TABLE notes (id integer primary key);',
    });
    const applied: Array<{ dir: string; url: string }> = [];
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      applyPostgresMigrations: async (dir, url) => {
        applied.push({ dir, url });
        trace.push('postgres-migrate');
        return ['0000_init.sql'];
      },
    });
    const output = await captureDeployOutput(() =>
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    );
    expect(exitCalls).toEqual([]);
    expect(applied).toEqual([
      { dir: toSlash(join(root, 'db', 'migrations')), url: 'postgresql://prod.example/app' },
    ]);
    expect(trace.indexOf('migrate-gate')).toBeLessThan(trace.indexOf('postgres-migrate'));
    expect(trace.indexOf('postgres-migrate')).toBeLessThan(trace.indexOf('wrangler:deploy'));
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(output).toMatch(/[│|]\s+1 migration applied\s+[│|]/);
    expect(output).not.toContain('D1 migrations up to date');
  });

  it('still deploys a pg app WITHOUT checked-in migrations (external schema — no false-reject)', async () => {
    const root = pgProject();
    const { deps, wranglerArgs, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    // Reached the upload, and no D1 command ran (a pg app has no desired.d1).
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
  });

  it('applies a pg migration added by the build before uploading', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://prod.example/app');
    const root = pgProject();
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      runBuild: () => {
        mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
        writeFileSync(
          join(root, 'db', 'migrations', '0000_injected.sql'),
          'CREATE TABLE notes (id integer primary key);',
        );
      },
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(trace).toContain('postgres-migrate');
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(false);
  });

  it('leaves a D1/SQLite app with checked-in migrations on the remote-D1 migrate path', async () => {
    // The guard keys on the postgresql dialect, so a SQLite app with migrations is untouched.
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suffixed resource names: the `-kv` / `-isr-cache` suffix carries the whole
// distinction between the two KV namespaces, so the 63-char cap must eat the
// worker name, never the suffix.
// ---------------------------------------------------------------------------

/** A deterministic worker name of `length` chars from the repeating [a-z0-9] alphabet. */
function workerNameOfLength(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join('');
}

/** Cloudflare's rule for these names: lowercase [a-z0-9-], no leading/trailing dash, ≤63. */
const CF_NAME_RULE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** A KV + ISR app (both namespaces desired) whose root config pins `workerName`. */
function kvAndIsrProject(workerName: string, wrangler: Record<string, unknown> = {}): string {
  return makeProject({
    'package.json': JSON.stringify({ name: 'longapp' }),
    'void.json': JSON.stringify({}),
    'wrangler.jsonc': JSON.stringify(
      { account_id: 'acc123', name: workerName, ...wrangler },
      null,
      2,
    ),
    'routes/index.ts': `export const GET = (c) => c.env.KV.get('k');`,
    'pages/index.tsx': `export default () => null;`,
    'pages/index.server.ts': `export const revalidate = 60;\nexport const loader = () => ({});`,
  });
}

describe('computeDesiredCloudflareResources — suffixed names survive the 63-char cap', () => {
  // From 61 chars the cap must trim the worker name, not the suffix, or `KV` and `ISR_CACHE`
  // would ask for one title and land on one namespace.
  for (const length of [61, 62, 63, 70, 100]) {
    it(`keeps KV and ISR_CACHE on distinct titles for a ${length}-char worker name`, async () => {
      const workerName = workerNameOfLength(length);
      const root = kvAndIsrProject(workerName);
      const { desired } = await computeDesiredCloudflareResources(
        root,
        readConfig(root),
        join(root, 'wrangler.jsonc'),
      );
      const titles = new Map(desired.kvNamespaces.map((kv) => [kv.binding, kv.title]));
      // The base is trimmed to whatever the suffix (plus its dash) leaves of the 63.
      expect(titles.get('KV')).toBe(`${workerName.slice(0, 63 - 'kv'.length - 1)}-kv`);
      expect(titles.get('ISR_CACHE')).toBe(
        `${workerName.slice(0, 63 - 'isr-cache'.length - 1)}-isr-cache`,
      );
      expect(titles.get('KV')).not.toBe(titles.get('ISR_CACHE'));
      for (const title of titles.values()) {
        expect(title).toMatch(CF_NAME_RULE);
        expect(title.length).toBe(63);
      }
    });
  }

  it('caps the D1 / R2 / Hyperdrive names too, keeping each suffix intact', async () => {
    const workerName = workerNameOfLength(80);
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'longapp' }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: workerName }, null, 2),
      'routes/index.ts': `export const GET = async (c) => {
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1?.name).toBe(`${workerName.slice(0, 63 - 'db'.length - 1)}-db`);
    expect(desired.r2?.bucketName).toBe(
      `${workerName.slice(0, 63 - 'storage'.length - 1)}-storage`,
    );
    for (const name of [desired.d1?.name, desired.r2?.bucketName]) {
      expect(name).toMatch(CF_NAME_RULE);
      expect(name?.length).toBe(63);
    }

    const pgRoot = makeProject({
      'package.json': JSON.stringify({ name: 'longpg' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: workerName }, null, 2),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
    });
    const pg = await computeDesiredCloudflareResources(
      pgRoot,
      readConfig(pgRoot),
      join(pgRoot, 'wrangler.jsonc'),
    );
    expect(pg.desired.hyperdrive?.name).toBe(
      `${workerName.slice(0, 63 - 'hyperdrive'.length - 1)}-hyperdrive`,
    );
    expect(pg.desired.hyperdrive?.name).toMatch(CF_NAME_RULE);
  });

  it('leaves a normal (short) worker name byte-for-byte as it was', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = async (c) => {
        await c.env.KV.get('k');
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
      'pages/index.tsx': `export default () => null;`,
      'pages/index.server.ts': `export const revalidate = 60;\nexport const loader = () => ({});`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.kvNamespaces).toEqual([
      { binding: 'KV', title: 'myapp-kv' },
      { binding: 'ISR_CACHE', title: 'myapp-isr-cache' },
    ]);
    expect(desired.d1?.name).toBe('myapp-db');
    expect(desired.r2?.bucketName).toBe('myapp-storage');
  });
});

describe('computeDesiredCloudflareResources — KV bindings may not share a namespace', () => {
  it('fails closed when two KV bindings already point at one namespace id', async () => {
    const root = kvAndIsrProject(workerNameOfLength(70), {
      kv_namespaces: [
        { binding: 'KV', id: REAL_KV_ID },
        { binding: 'ISR_CACHE', id: REAL_KV_ID },
      ],
    });
    const error = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    ).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('"KV"');
    expect(error?.message).toContain('"ISR_CACHE"');
    expect(error?.message).toContain(REAL_KV_ID);
    expect(error?.message).toMatch(/share one namespace/);
    expect(error?.message).toMatch(/fresh namespace/);
  });

  it('accepts two KV bindings on distinct namespace ids', async () => {
    const root = kvAndIsrProject(workerNameOfLength(70), {
      kv_namespaces: [
        { binding: 'KV', id: REAL_KV_ID },
        { binding: 'ISR_CACHE', id: OTHER_KV_ID },
      ],
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.kvNamespaces.map((kv) => kv.binding)).toEqual(['KV', 'ISR_CACHE']);
  });

  it('ignores unprovisioned placeholder ids (a synced local-dev config is not a collision)', async () => {
    const root = kvAndIsrProject(workerNameOfLength(70), {
      kv_namespaces: [
        { binding: 'KV', id: 'local' },
        { binding: 'ISR_CACHE', id: 'local' },
      ],
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.kvNamespaces).toHaveLength(2);
  });
});

describe('computeDesiredCloudflareResources — provisioned resources are never re-created', () => {
  it('reuses the ids/names already in the config for a long-named app (no wrangler call)', async () => {
    // The derivation changed for long worker names, so prove the renamed desired set
    // still resolves to the SAME resources through the provisioner's read-first.
    const workerName = workerNameOfLength(70);
    const root = kvAndIsrProject(workerName, {
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'legacy-db',
          database_id: REAL_D1_ID,
          migrations_dir: './db/migrations',
        },
      ],
      kv_namespaces: [
        { binding: 'KV', id: REAL_KV_ID },
        { binding: 'ISR_CACHE', id: OTHER_KV_ID },
      ],
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'legacy-bucket' }],
    });
    writeFileSync(
      join(root, 'routes/index.ts'),
      `export const GET = async (c) => {
        await c.env.KV.get('k');
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
    );
    const configPath = join(root, 'wrangler.jsonc');
    const { desired } = await computeDesiredCloudflareResources(root, readConfig(root), configPath);
    // Stored names win over the derivation, so nothing points at a new resource.
    expect(desired.d1?.name).toBe('legacy-db');
    expect(desired.r2?.bucketName).toBe('legacy-bucket');

    const calls: Array<Array<string>> = [];
    const result = await provisionCloudflareResources(root, configPath, desired, {
      runWrangler: operationFixture((args) => {
        calls.push(args);
        return { stdout: '', stderr: '', status: 0 };
      }),
      enableD1ReadReplication: async () => {},
      log: { info: () => {}, warn: () => {} },
    });
    // Read-first everywhere: no list, no create — the recorded resources are kept.
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'legacy-db', action: 'reused', id: REAL_D1_ID },
      {
        kind: 'kv',
        binding: 'KV',
        name: `${workerName.slice(0, 60)}-kv`,
        action: 'reused',
        id: REAL_KV_ID,
      },
      {
        kind: 'kv',
        binding: 'ISR_CACHE',
        name: `${workerName.slice(0, 53)}-isr-cache`,
        action: 'reused',
        id: OTHER_KV_ID,
      },
      { kind: 'r2', binding: 'STORAGE', name: 'legacy-bucket', action: 'reused' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Orchestration flow
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — static, SPA, and SSG apps', () => {
  const generatedStaticConfig = (root: string) =>
    join(root, '.void/deploy/cloudflare/wrangler-static.json');

  it('links an assets-only SPA and validates the static adapter before activation, including retries', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'site' }),
      'void.json': JSON.stringify({ inference: { appType: 'spa' } }),
      'wrangler.jsonc': JSON.stringify({
        name: 'site',
        account_id: 'personal',
        compatibility_date: '2026-02-24',
        assets: { directory: 'dist', not_found_handling: 'single-page-application' },
      }),
      'dist/index.html': '<!doctype html><div id="app"></div>',
    });
    const existing = {
      versionId: 'original',
      bindings: [],
      script: { handlers: null },
      runtime: { compatibility_date: '2026-02-24', assets: {} },
    };
    const uploaded = {
      ...existing,
      versionId: 'new',
      bindings: [{ type: 'assets', name: 'ASSETS' }],
      script: { handlers: ['fetch'] },
    };
    const readExistingWorker = vi
      .fn<NonNullable<CloudflareDeployDeps['readExistingWorker']>>()
      .mockImplementation(async ({ versionId }) => (versionId ? uploaded : existing));
    let attempts = 0;
    const activateVersion = vi
      .fn<NonNullable<CloudflareDeployDeps['activateVersion']>>()
      .mockImplementation(async (options) => {
        expect(options.preserveTriggers).toBe(true);
        expect(options.expectedPreviousVersionId).toBe('original');
        expect(options.validateUploadedVersion).toBeTypeOf('function');
        expect(parseRootWranglerConfig(options.configPath!)).toMatchObject({
          keep_vars: true,
          assets: { binding: 'ASSETS', not_found_handling: 'single-page-application' },
        });
        await options.validateUploadedVersion!('new');
        await options.recordVerifiedCandidate!('new', 'original');
        if (attempts++ === 0) {
          return { ok: false, reason: 'readiness-failed', rollback: 'succeeded' };
        }
        expect(options.trustedInheritanceVersionIds).toEqual(['new']);
        return {
          ok: true,
          versionId: 'new',
          previousVersionId: 'original',
          previewUrl: 'https://site.example.com',
        };
      });
    const { deps, trace } = harness({ readExistingWorker, activateVersion });
    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(readCloudflareLink(root)?.candidateReceipt).toEqual({
      parentVersionId: 'original',
      versionIds: ['new'],
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(readCloudflareLink(root)).toBeNull();
    expect(activateVersion).toHaveBeenCalledTimes(2);
    expect(readExistingWorker).toHaveBeenCalledTimes(4);
    expect(trace).not.toContain('provision');
    expect(trace).not.toContain('auth-secret');
  });

  it('rejects a static-looking non-Cloudflare runtime before any account operation', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'node-static', dependencies: { vite: '6.0.0' } }),
      'void.json': JSON.stringify({ target: 'node' }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'index.html': '<!doctype html><div id="app"></div>',
    });
    const { deps, trace, exitCalls } = harness();

    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);

    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('deploys a configured SPA through the thin edge Worker', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'spaapp' }),
      'void.json': JSON.stringify({ inference: { appType: 'spa' } }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'dist/index.html': '<!doctype html><div id="app"></div>',
    });
    const { deps, wranglerArgs, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.map((args) => args[0])).toEqual(['whoami', 'deploy']);
    expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc'))).toEqual({
      account_id: 'acc123',
    });
    const config = parseRootWranglerConfig(generatedStaticConfig(root));
    expect(config).toMatchObject({
      name: 'spaapp',
      account_id: 'acc123',
      version_metadata: { binding: '__VOID_VERSION_METADATA' },
      main: 'static-edge.mjs',
      assets: {
        directory: '../../../dist',
        binding: 'ASSETS',
        run_worker_first: true,
        not_found_handling: 'single-page-application',
      },
    });
    expect(readFileSync(join(root, '.void/deploy/cloudflare/static-edge.mjs'), 'utf-8')).toContain(
      'void/edge',
    );
    expect(wranglerArgs.at(-1)).toContain(toSlash(join(root, '.void/deploy/cloudflare/assets')));
  });

  it('preserves canonical Worker configuration when deploying static assets', async () => {
    const canonical = `{
  // Hand-authored Worker configuration must survive a temporary static deploy.
  "account_id": "acc123",
  "name": "switchable-app",
  "main": "src/worker.ts",
  "durable_objects": { "bindings": [{ "name": "STATE", "class_name": "State" }] },
  "queues": {
    "producers": [{ "binding": "BILLING", "queue": "billing" }],
    "consumers": [{ "queue": "billing" }]
  },
  "workflows": [{ "name": "billing-flow", "class_name": "BillingFlow" }]
}\n`;
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'switchable-app' }),
      'void.json': JSON.stringify({ inference: { appType: 'spa' } }),
      'wrangler.jsonc': canonical,
      'dist/index.html': '<h1>Static</h1>',
    });
    const { deps, exitCalls } = harness();

    const output = await captureDeployOutput(() =>
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    );

    expect(exitCalls).toEqual([]);
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(canonical);
    const generated = parseRootWranglerConfig(generatedStaticConfig(root));
    expect(generated.durable_objects).toEqual({ bindings: [] });
    expect(generated.queues).toEqual({ producers: [], consumers: [] });
    expect(generated.workflows).toEqual([]);
    expect(output).toMatch(/[╭+].*https:\/\/preview\.example\.workers\.dev.*[╮+]/);
    expect(output).toContain('switchable-app → Cloudflare');
    expect(output.indexOf('switchable-app → Cloudflare')).toBeLessThan(
      output.indexOf('Preparing deployment'),
    );
    expect(output).toContain('Worker: switchable-app');
    expect(output).toMatch(/[│|]\s+Static SPA\s+[│|]/);
    expect(output).toContain('✓ Successfully deployed!');
    expect(output).not.toContain('Done!');
    expect(output).not.toContain('Deployed!');
    expect(output.indexOf('✓ Successfully deployed!')).toBeGreaterThan(output.indexOf('╰'));
    expect(output.match(/Successfully deployed!/g)).toHaveLength(1);
  });

  it('passes a complete Access service-token pair to the readiness probe', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'access-app' }),
      'void.json': JSON.stringify({ inference: { appType: 'spa' } }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'dist/index.html': '<h1>Access</h1>',
    });
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'service-id');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'service-secret');
    let readinessHeaders: Readonly<Record<string, string>> | undefined;
    const { deps, exitCalls } = harness({
      activateVersion: async (options) => {
        readinessHeaders = options.readinessHeaders;
        expect(options.requireVersionMetadata).toBe(true);
        expect(options.requirePreviewForReadiness).toBe(false);
        return {
          ok: true,
          versionId: '22222222-2222-4222-8222-222222222222',
          previewUrl: 'https://preview.example.workers.dev',
          previousVersionId: null,
        };
      },
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(readinessHeaders).toEqual({
      'CF-Access-Client-Id': 'service-id',
      'CF-Access-Client-Secret': 'service-secret',
    });
  });

  it('passes a short-lived Access user JWT to the guarded readiness probe', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'access-user-app' }),
      'void.json': JSON.stringify({ inference: { appType: 'spa' } }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'dist/index.html': '<h1>Access</h1>',
    });
    vi.stubEnv('CF_ACCESS_CLIENT_ID', undefined);
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', undefined);
    vi.stubEnv('CF_ACCESS_TOKEN', 'short-lived-user-jwt');
    vi.stubEnv('CLOUDFLARE_WORKERS_SUBDOMAIN', 'developer-platform-experience');
    let readinessHeaders: Readonly<Record<string, string>> | undefined;
    let readinessHeadersWorkersDevSubdomain: string | undefined;
    const { deps, exitCalls } = harness({
      activateVersion: async (options) => {
        readinessHeaders = options.readinessHeaders;
        readinessHeadersWorkersDevSubdomain = options.readinessHeadersWorkersDevSubdomain;
        return {
          ok: true,
          versionId: '22222222-2222-4222-8222-222222222222',
          previewUrl: 'https://preview.example.workers.dev',
          previousVersionId: null,
        };
      },
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(readinessHeaders).toEqual({ 'cf-access-token': 'short-lived-user-jwt' });
    expect(readinessHeadersWorkersDevSubdomain).toBe('developer-platform-experience');
  });

  it('builds and deploys an unconfigured Vite SPA', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'viteapp', dependencies: { vite: '6.0.0' } }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'index.html': '<!doctype html><div id="app"></div>',
    });
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      runStaticBuild: () => {
        trace.push('static-build');
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, 'dist/index.html'), '<!doctype html><div id="app"></div>');
      },
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(exitCalls).toEqual([]);
    expect(trace).toEqual(['wrangler:whoami', 'static-build', 'wrangler:deploy']);
    expect(wranglerArgs.at(-1)).toContain(toSlash(generatedStaticConfig(root)));
  });

  it('scrubs stale managed markers from a native static build', async () => {
    vi.stubEnv('VOID_DEPLOY_PROJECT_ID', 'stale-managed-project');
    vi.stubEnv('VOID_DEPLOY_BUILD', '1');
    let buildEnvSeen: NodeJS.ProcessEnv = {};
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'viteapp', dependencies: { vite: '6.0.0' } }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'index.html': '<!doctype html><div id="app"></div>',
    });
    const { deps } = harness({
      runStaticBuild: (_command, env) => {
        buildEnvSeen = { ...env };
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, 'dist/index.html'), '<h1>Built</h1>');
      },
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(buildEnvSeen.VOID_DEPLOY_PROJECT_ID).toBeUndefined();
    expect(buildEnvSeen.VOID_DEPLOY_BUILD).toBeUndefined();
  });

  it('rejects a forged candidate receipt written by a static build hook', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'site', dependencies: { vite: '6.0.0' } }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': JSON.stringify({
        account_id: 'personal',
        name: 'site',
        compatibility_date: '2026-02-24',
      }),
      'index.html': '<!doctype html><div id="app"></div>',
    });
    const { deps, trace, wranglerArgs } = harness({
      readExistingWorker: async () => ({
        versionId: 'original',
        bindings: [],
        runtime: { compatibility_date: '2026-02-24', compatibility_flags: [] },
        script: { handlers: ['fetch'] },
      }),
      runStaticBuild: () => {
        trace.push('static-build');
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, 'dist/index.html'), '<h1>Built</h1>');
        writeFileSync(
          join(root, '.void/cloudflare-link.json'),
          JSON.stringify({
            accountId: 'personal',
            workerName: 'site',
            candidateReceipt: { parentVersionId: 'original', versionIds: ['forged'] },
          }),
        );
      },
    });
    await expect(
      runCloudflareDeploy(root, { reuseExistingWorker: true }, silentCliLog, deps),
    ).rejects.toThrow('handoff changed while project code was running');
    expect(trace).toContain('static-build');
    expect(wranglerArgs.some((args) => args[0] === 'deploy')).toBe(false);
  });

  it('authenticates an env-pinned static deploy before its config file exists', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'env-account');
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'static-env-app' }),
      'void.json': JSON.stringify({}),
      'public/index.html': '<h1>Static</h1>',
    });
    const { deps, wranglerArgs, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare', dir: 'public' }, silentCliLog, deps);

    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.find((args) => args[0] === 'whoami')).toEqual([
      'whoami',
      '--json',
      '--env=',
    ]);
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
    expect(existsSync(generatedStaticConfig(root))).toBe(true);
  });

  it('rejects a static build that rewrites the root Wrangler config', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'viteapp', dependencies: { vite: '6.0.0' } }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'index.html': '<!doctype html><div id="app"></div>',
    });
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      runStaticBuild: () => {
        trace.push('static-build');
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, 'dist/index.html'), '<h1>Built</h1>');
        writeFileSync(
          join(root, 'wrangler.jsonc'),
          JSON.stringify({ account_id: 'acc123', services: [{ binding: 'INJECTED' }] }),
        );
      },
    });

    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);

    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual(['wrangler:whoami', 'static-build']);
    expect(wranglerArgs.some((args) => args[0] === 'deploy')).toBe(false);
  });

  it('rejects a bare --spa deploy before any account op', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'app' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare', spa: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('deploys an explicit pre-built directory without running a build', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'app' }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'public/index.html': '<h1>Static</h1>',
      'public/_headers': '/*\n  X-Test: yes\n',
      'public/_redirects': '/* /index.html 200\n',
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare', dir: 'public' }, silentCliLog, deps);

    expect(exitCalls).toEqual([]);
    expect(trace).toEqual(['wrangler:whoami', 'wrangler:deploy']);
    expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc'))).toEqual({
      account_id: 'acc123',
    });
    expect(parseRootWranglerConfig(generatedStaticConfig(root))).toMatchObject({
      assets: { directory: '../../../public', not_found_handling: '404-page' },
    });
    const stagedAssets = join(root, '.void/deploy/cloudflare/assets');
    expect(readFileSync(join(stagedAssets, 'index.html'), 'utf-8')).toBe('<h1>Static</h1>');
    expect(existsSync(join(stagedAssets, '_headers'))).toBe(false);
    expect(existsSync(join(stagedAssets, '_redirects'))).toBe(false);
    expect(wranglerArgs.at(-1)).toContain(toSlash(stagedAssets));
  });

  it('rejects a bare project with no Void backend files (positive full-Void assertion)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'bare' }),
      'void.json': JSON.stringify({}),
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('deploys a PostgreSQL app with auth after migrations and secret setup', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://prod.example/app');
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'pgauth' }),
      'void.json': JSON.stringify({ database: 'pg', auth: {} }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'db/migrations/0000_auth.sql': 'CREATE TABLE "user" (id text primary key);',
      'wrangler.jsonc': JSON.stringify({
        account_id: 'acc123',
        name: 'pgauth',
        hyperdrive: [{ binding: 'HYPERDRIVE', id: REAL_KV_ID }],
      }),
    });
    const { deps, trace, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(trace.indexOf('auth-secret')).toBeLessThan(trace.indexOf('postgres-migrate'));
    expect(trace.indexOf('postgres-migrate')).toBeLessThan(trace.indexOf('wrangler:deploy'));
  });

  it('deploys a fully prerenderable output:"static" Pages app through the thin edge Worker', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'ssgapp' }),
      'void.json': JSON.stringify({
        output: 'static',
        worker: { compatibility_date: '2026-02-12' },
      }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'pages/index.vue': `<template><div>hi</div></template>`,
      'pages/index.server.ts': `export const loader = () => ({});`,
    });
    const { deps, trace, exitCalls } = harness({
      runStaticBuild: () => {
        trace.push('static-build');
        mkdirSync(join(root, 'dist/client'), { recursive: true });
        writeFileSync(join(root, 'dist/client/index.html'), '<h1>Prerendered</h1>');
      },
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(exitCalls).toEqual([]);
    expect(trace).toEqual(['wrangler:whoami', 'static-build', 'wrangler:deploy']);
    expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc'))).toEqual({
      account_id: 'acc123',
    });
    expect(parseRootWranglerConfig(generatedStaticConfig(root))).toMatchObject({
      main: 'static-edge.mjs',
      assets: { directory: '../../../dist/client', not_found_handling: '404-page' },
    });
  });

  it.each(['first deployment', 'update'] as const)(
    'validates static candidate history through real activation on %s',
    async (scenario) => {
      const root = makeProject({
        'package.json': JSON.stringify({ name: 'static-app' }),
        'void.json': JSON.stringify({ output: 'static' }),
        'wrangler.jsonc': JSON.stringify({
          account_id: 'acc123',
          workers_dev: true,
          preview_urls: true,
          routes: [],
        }),
        'pages/index.vue': '<template><div>Static</div></template>',
      });
      const current = '11111111-1111-4111-8111-111111111111';
      const next = '22222222-2222-4222-8222-222222222222';
      let active: string | null = scenario === 'update' ? current : null;
      const history = scenario === 'update' ? [{ id: current, number: 1 }] : [];
      const operations: Array<CloudflareOperation> = [];
      const runWrangler: DeployWranglerRun = (operation) => {
        operations.push(operation);
        if (operation.type === 'auth.whoami') {
          return { ...cleanExit, data: { loggedIn: true, accounts: [] } };
        }
        if (operation.type === 'deployments.status') {
          return {
            ...cleanExit,
            data: { versions: active ? [{ version_id: active, percentage: 100 }] : [] },
          };
        }
        if (operation.type === 'versions.list') {
          return { ...cleanExit, data: history.map((version) => ({ ...version })) };
        }
        if (operation.type === 'versions.view') {
          return { ...cleanExit, data: { id: operation.versionId, resources: { bindings: [] } } };
        }
        if (operation.type === 'versions.upload') {
          if (scenario === 'first deployment') {
            return { ...cleanExit, status: 1, failure: 'not-found', errorCode: 10007 };
          }
          history.push({ id: next, number: 2 });
          return {
            ...cleanExit,
            data: {
              versionId: next,
              previewUrl: `https://${next.slice(0, 8)}-static-app.example.workers.dev`,
            },
          };
        }
        if (operation.type === 'worker.deploy') {
          active = next;
          history.push({ id: next, number: 1 });
          return {
            ...cleanExit,
            data: { versionId: next, workersDevUrl: 'https://static-app.example.workers.dev' },
          };
        }
        if (operation.type === 'versions.deploy') {
          active = operation.versions[0]!.versionId;
          return cleanExit;
        }
        if (operation.type === 'triggers.deploy' || operation.type === 'triggers.clear-crons') {
          expect(active).toBe(next);
          return cleanExit;
        }
        throw new Error(`Unexpected Cloudflare operation: ${operation.type}`);
      };
      const { deps, exitCalls } = harness({
        runWrangler,
        runStaticBuild: () => {
          mkdirSync(join(root, 'dist/client'), { recursive: true });
          writeFileSync(join(root, 'dist/client/index.html'), '<h1>Static</h1>');
        },
        activateVersion: (options) =>
          activateCloudflareVersionPrimitive({
            ...options,
            fetch: async () => {
              if (scenario === 'update') {
                expect(
                  JSON.parse(readFileSync(join(root, '.void/cloudflare-candidate.json'), 'utf8')),
                ).toMatchObject({ parentVersionId: current, versionIds: [next] });
              }
              return Response.json({ ready: true, versionId: next });
            },
          }),
      });

      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

      expect(exitCalls).toEqual([]);
      expect(active).toBe(next);
      const operationTypes = operations.map((operation) => operation.type);
      expect(operationTypes.indexOf('versions.list')).toBeLessThan(
        operationTypes.indexOf('versions.upload'),
      );
      if (scenario === 'update') {
        expect(operationTypes.lastIndexOf('versions.list')).toBeGreaterThan(
          operationTypes.indexOf('versions.upload'),
        );
      }
      expect(existsSync(join(root, '.void/cloudflare-candidate.json'))).toBe(false);
    },
  );

  it('keeps an output:"static" app with a dynamic page on the full Worker path', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'hybrid-ssg' }),
      'void.json': JSON.stringify({ output: 'static' }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123' }),
      'pages/[id].vue': `<template><div>dynamic</div></template>`,
      'pages/[id].server.ts': `export const loader = ({ params }) => ({ id: params.id });`,
    });
    const { deps, trace, exitCalls } = harness();

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(exitCalls).toEqual([]);
    expect(trace).toEqual(['wrangler:whoami', 'build', 'gate', 'wrangler:deploy']);
  });

  // An `email/` handler compiles to the worker's `email()` export. The thin static edge
  // Worker exports none, so routing an email-bearing `output: "static"` app there would
  // drop every inbound handler with no deploy-time error — the same class of miss
  // `hasNonPageBackend` closes on the managed path.
  it('keeps an output:"static" app with an email/ handler on the full Worker path', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'email-ssg' }),
      'void.json': JSON.stringify({ output: 'static' }),
      // A prerendered page carries the max `revalidate`, so the worker path desires
      // ISR_CACHE; pre-provision it so the stubbed provisioner has nothing to create.
      'wrangler.jsonc': JSON.stringify({
        account_id: 'acc123',
        kv_namespaces: [{ binding: 'ISR_CACHE', id: REAL_KV_ID }],
      }),
      'pages/index.vue': `<template><div>hi</div></template>`,
      'pages/index.server.ts': `export const loader = () => ({});`,
      'email/support.ts': `export default async () => {};`,
    });
    const { deps, trace, exitCalls } = harness();

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(exitCalls).toEqual([]);
    expect(trace).toEqual(['wrangler:whoami', 'build', 'gate', 'wrangler:deploy']);
  });

  it('accepts a valid custom migrations_pattern', async () => {
    const root = d1Project({
      ...PROVISIONED_D1,
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'myapp-db',
          database_id: REAL_D1_ID,
          migrations_dir: './db/migrations',
          migrations_pattern: 'db/migrations/**/*.sql',
        },
      ],
    });
    const { deps, trace, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(trace).toContain('wrangler:deploy');
  });

  it('rejects a PRESENT-but-EMPTY migrations_pattern ("") before any account op', async () => {
    // Wrangler treats any pattern other than `undefined` as custom, so an empty one diverges from
    // the flat `*.sql` set this backend validates.
    const root = d1Project({
      ...PROVISIONED_D1,
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'myapp-db',
          database_id: REAL_D1_ID,
          migrations_dir: './db/migrations',
          migrations_pattern: '',
        },
      ],
    });
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Reached NO whoami / provision / migration / build seam — rejected pre-account.
    expect(trace).toEqual([]);
    expect(wranglerArgs).toEqual([]);
  });

  it('rejects migrations_pattern without an explicit migrations_dir before any account op', async () => {
    const root = d1Project({
      ...PROVISIONED_D1,
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'myapp-db',
          database_id: REAL_D1_ID,
          migrations_pattern: 'db/migrations/**/*.sql',
        },
      ],
    });
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
    expect(wranglerArgs).toEqual([]);
  });

  it('appends a WebSocket migration when a later deploy adds a route', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'wsapp' }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': `{
  // Preserve this user-owned configuration.
  "account_id": "acc123",
  "vars": { "FEATURE": "on" }
}`,
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'routes/chat/[room].ws.ts': `import { defineRoom } from 'void/ws';\nexport default defineRoom({});`,
    });
    const first = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, first.deps);

    expect(first.exitCalls).toEqual([]);
    expect(first.trace).toEqual(['wrangler:whoami', 'build', 'gate', 'wrangler:deploy']);
    expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc'))).toMatchObject({
      migrations: [{ tag: 'void-ws-v1', new_sqlite_classes: ['ChatRoomWs'] }],
    });

    writeFileSync(
      join(root, 'routes/notifications.ws.ts'),
      `import { defineWebSocket } from 'void/ws';\nexport default defineWebSocket({});`,
    );
    const second = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, second.deps);

    expect(second.exitCalls).toEqual([]);
    expect(second.trace).toEqual(['wrangler:whoami', 'build', 'gate', 'wrangler:deploy']);
    const raw = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    expect(raw).toContain('// Preserve this user-owned configuration.');
    expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc'))).toMatchObject({
      vars: { FEATURE: 'on' },
      durable_objects: {
        bindings: [
          { name: 'ChatRoomWs', class_name: 'ChatRoomWs' },
          { name: 'NotificationsWs', class_name: 'NotificationsWs' },
        ],
      },
      migrations: [
        { tag: 'void-ws-v1', new_sqlite_classes: ['ChatRoomWs'] },
        { tag: 'void-ws-v1-2', new_sqlite_classes: ['NotificationsWs'] },
      ],
    });
  });

  it('does not reject a dev-only WebSocket route (.dev.ws.ts) — it never reaches production', async () => {
    // The production scan ignores a dev-only route, so no Durable Object is emitted.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'wsapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'routes/chat/[room].dev.ws.ts': `import { defineRoom } from 'void/ws';\nexport default defineRoom({});`,
    });
    const errors: Array<string> = [];
    const errorSpy = vi.spyOn(log, 'error').mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const { deps } = harness();
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps).catch(
        () => undefined,
      );
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors.some((message) => message.includes('WebSocket / Durable Object routes'))).toBe(
      false,
    );
  });
});

describe('runCloudflareDeploy — preflight', () => {
  it('exits when wrangler is unauthenticated (whoami --json nonzero)', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      runWrangler: operationFixture((args) => {
        trace.push(`wrangler:${args[0]}`);
        if (args[0] === 'whoami') {
          return { status: 1, stdout: '{"loggedIn":false}', stderr: '', signal: null, error: null };
        }
        return cleanExit;
      }),
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual(['wrangler:whoami']); // stopped right after the auth probe
  });

  it('exits when no account is pinned (no account_id, no CLOUDFLARE_ACCOUNT_ID)', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', undefined);
    const root = d1Project({ ...PROVISIONED_D1, account_id: undefined });
    const { deps, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
  });

  it('authenticates an env-pinned Worker deploy before its config file exists', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'env-account');
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'worker-env-app' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { deps, wranglerArgs, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.find((args) => args[0] === 'whoami')).toEqual([
      'whoami',
      '--json',
      '--env=',
    ]);
    expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc')).account_id).toBe('env-account');
  });

  it('verifies Cloudflare Containers before building a Sandbox app', async () => {
    const root = sandboxProject();
    const { deps, trace, wranglerArgs } = harness();

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(wranglerArgs).toContainEqual([
      'containers',
      'list',
      '--json',
      '-c',
      toSlash(join(root, 'wrangler.jsonc')),
      '--env=',
    ]);
    expect(trace.indexOf('wrangler:whoami')).toBeLessThan(trace.indexOf('wrangler:containers'));
    expect(trace.indexOf('wrangler:containers')).toBeLessThan(trace.indexOf('build'));
  });

  it('fails before provisioning or building when Sandbox Containers are unavailable', async () => {
    const root = sandboxProject();
    const errors: Array<string> = [];
    const errorSpy = vi.spyOn(log, 'error').mockImplementation((message) => {
      errors.push(String(message));
    });
    const { deps, trace, exitCalls } = harness({
      runWrangler: operationFixture((args) => {
        trace.push(`wrangler:${args[0]}`);
        if (args[0] === 'whoami') {
          return { ...cleanExit, stdout: '{"loggedIn":true,"accounts":[]}' };
        }
        if (args[0] === 'containers') {
          return { ...cleanExit, status: 1, stderr: 'HTTP 403' };
        }
        return cleanExit;
      }),
    });

    try {
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      errorSpy.mockRestore();
    }

    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual(['wrangler:whoami', 'wrangler:containers']);
    expect(errors.join('\n')).toContain('Cloudflare Containers require the Workers Paid plan');
    expect(errors.join('\n')).toContain('/:account/workers/plans');
    expect(errors.join('\n')).toContain('Containers: Edit');
    expect(errors.join('\n')).toContain('Cloudchamber: Edit');
  });

  it('does not probe Containers when the app does not use Sandbox', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs } = harness();

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(wranglerArgs.some((args) => args[0] === 'containers')).toBe(false);
  });

  it.each([
    { tag: 'occupied', new_classes: ['SandboxV1'] },
    {
      tag: 'transfer',
      transferred_classes: [{ from_script: 'foreign', from: 'Original', to: 'SandboxV1' }],
    },
    { tag: 'void-sandbox-v2', new_sqlite_classes: ['Unrelated'] },
  ])(
    'rejects incompatible Sandbox history before account probes, resource provisioning or build',
    async (migration) => {
      const root = sandboxProject();
      const configPath = join(root, 'wrangler.jsonc');
      const original = JSON.stringify({
        ...parseRootWranglerConfig(configPath),
        migrations: [migration],
      });
      writeFileSync(configPath, original);
      const { deps, trace, exitCalls } = harness();
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare', provision: true }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(exitCalls).toEqual([1]);
      expect(trace).toEqual([]);
      expect(readFileSync(configPath, 'utf8')).toBe(original);
    },
  );

  it('translates a Sandbox upload entitlement error into Workers Paid guidance', async () => {
    const root = sandboxProject();
    const errors: Array<string> = [];
    const errorSpy = vi.spyOn(log, 'error').mockImplementation((message) => {
      errors.push(String(message));
    });
    const { deps, exitCalls } = harness({
      activateVersion: async () => ({
        ok: false,
        reason: 'upload-failed',
        status: 1,
        containersUnavailable: true,
      }),
    });

    try {
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      errorSpy.mockRestore();
    }

    expect(exitCalls).toEqual([1]);
    expect(errors.join('\n')).toContain('Cloudflare Containers require the Workers Paid plan');
    expect(errors.join('\n')).toContain('The Sandbox container was not deployed');
  });

  it('discovers and persists the only account on a first deploy', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', undefined);
    const root = d1Project({ ...PROVISIONED_D1, account_id: undefined });
    const { deps, exitCalls, wranglerArgs } = harness({
      runWrangler: operationFixture((args) => {
        wranglerArgs.push([...args]);
        if (args[0] === 'whoami') {
          return {
            ...cleanExit,
            stdout: JSON.stringify({
              loggedIn: true,
              accounts: [{ id: 'discovered-account', name: 'My account' }],
            }),
          };
        }
        return cleanExit;
      }),
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(exitCalls).toEqual([]);
    expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc'))).toMatchObject({
      account_id: 'discovered-account',
    });
    expect(wranglerArgs.filter((args) => args[0] === 'whoami')).toHaveLength(2);
  });
});

describe('runCloudflareDeploy — resource provisioning', () => {
  it('automatically provisions a missing D1 database and continues the deploy', async () => {
    const root = d1Project({ account_id: 'acc123', name: 'myapp' });
    let capturedDesired: Parameters<NonNullable<CloudflareDeployDeps['provision']>>[2] | undefined;
    const provisionTrace: Array<string> = [];
    const { deps, trace } = harness({
      provision: (async (_root, configPath, desired): Promise<ProvisionResult> => {
        provisionTrace.push('provision');
        capturedDesired = desired;
        writeFileSync(configPath, JSON.stringify(PROVISIONED_D1, null, 2));
        return {
          resources: [
            {
              kind: 'd1',
              binding: 'DB',
              name: desired.d1!.name,
              action: 'created',
              id: REAL_D1_ID,
            },
          ],
          configPath,
          accountIdWritten: false,
        };
      }) as CloudflareDeployDeps['provision'],
    });

    const output = await captureDeployOutput(() =>
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    );

    expect(capturedDesired?.d1).toMatchObject({ binding: 'DB', name: 'myapp-db' });
    expect(provisionTrace).toEqual(['provision']);
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
    expect(output).toMatch(/[╭+].*https:\/\/preview\.example\.workers\.dev.*[╮+]/);
    expect(output).toContain('myapp → Cloudflare');
    expect(output.startsWith('myapp → Cloudflare\n\n')).toBe(true);
    expect(output).toContain('Worker: myapp');
    expect(output).not.toContain('D1 migrations up to date');
    expect(output).toContain('✓ Successfully deployed!');
    expect(output).not.toContain('Done!');
    expect(output).not.toContain('Deployed!');
    expect(output.indexOf('✓ Successfully deployed!')).toBeGreaterThan(output.indexOf('╰'));
    expect(output.match(/Successfully deployed!/g)).toHaveLength(1);
  });

  it('reconciles D1 replication before build, gate, migrations and deploy when fully provisioned', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
    });
    const { deps, trace, wranglerArgs } = harness();
    const output = await captureDeployOutput(() =>
      runCloudflareDeploy(root, { platform: 'cloudflare', provision: true }, silentCliLog, deps),
    );
    expect(output).toContain('D1 migrations up to date');
    expect(output).not.toMatch(/\d+ migrations? applied/);
    // The BUILD runs BEFORE the secret gate (ground-truth validation reads the real emitted
    // artifact); the LOCAL migration gate runs AFTER the build (against the post-build files),
    // and the REMOTE D1 apply runs after that (a failed gate never mutates D1).
    expect(trace).toEqual([
      'wrangler:whoami',
      'provision',
      'build',
      'gate',
      'migrate-gate',
      'wrangler:d1', // migrations list (is a restore point needed?)
      'wrangler:d1', // migrations apply (after the gate)
      'wrangler:d1', // migrations list (pending verify)
      'wrangler:deploy',
    ]);
    // migrate targets the stored db name with --remote + pinned config
    const d1Calls = wranglerArgs.filter((a) => a[0] === 'd1');
    // the pre-apply list reads the pending set of the same target
    expect(d1Calls.shift()).toEqual([
      'd1',
      'migrations',
      'list',
      'myapp-db',
      '--remote',
      '-c',
      toSlash(join(root, 'wrangler.jsonc')),
      '--env=',
    ]);
    expect(d1Calls[0]).toEqual([
      'd1',
      'migrations',
      'apply',
      'myapp-db',
      '--remote',
      '-c',
      toSlash(join(root, 'wrangler.jsonc')),
      '--env=',
    ]);
    // the post-apply pending verification lists remote migrations for the same target
    expect(d1Calls[1]).toEqual([
      'd1',
      'migrations',
      'list',
      'myapp-db',
      '--remote',
      '-c',
      toSlash(join(root, 'wrangler.jsonc')),
      '--env=',
    ]);
    // Upload and trigger synchronization use the exact generated config that was
    // verified above, rather than letting triggers fall back to the root config.
    expect(wranglerArgs.find((a) => a[0] === 'deploy')).toEqual([
      'deploy',
      '-c',
      join(root, 'dist/ssr/wrangler.json'),
      '--env=',
      '--experimental-provision=false',
      '--experimental-auto-create=false',
      '--autoconfig=false',
    ]);
  });
});

describe('runCloudflareDeploy — provision path', () => {
  it('calls the provisioner with the correctly-built desired set', async () => {
    let captured: unknown;
    const root = d1Project(PROVISIONED_D1);
    const { deps } = harness({
      provision: (async (_root, configPath, desired): Promise<ProvisionResult> => {
        captured = desired;
        return { resources: [], configPath, accountIdWritten: false };
      }) as CloudflareDeployDeps['provision'],
    });
    await runCloudflareDeploy(
      root,
      { platform: 'cloudflare', provision: true },
      silentCliLog,
      deps,
    );
    expect(captured).toMatchObject({
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [],
      queues: [],
    });
  });
});

describe('runCloudflareDeploy — backwards-compatible provision flag', () => {
  it('still provisions an incomplete config when the legacy flag is present', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.KV.get('k');`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
    });
    const provisionTrace: Array<string> = [];
    const { deps, trace } = harness({
      provision: (async (_root, configPath, desired): Promise<ProvisionResult> => {
        provisionTrace.push('provision');
        writeFileSync(
          configPath,
          JSON.stringify(
            { ...PROVISIONED_D1, kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }] },
            null,
            2,
          ),
        );
        return {
          resources: [
            {
              kind: 'kv',
              binding: 'KV',
              name: desired.kvNamespaces[0].title,
              action: 'created',
              id: REAL_KV_ID,
            },
          ],
          configPath,
          accountIdWritten: false,
        };
      }) as CloudflareDeployDeps['provision'],
    });
    await runCloudflareDeploy(
      root,
      { platform: 'cloudflare', provision: true },
      silentCliLog,
      deps,
    );
    expect(provisionTrace).toEqual(['provision']);
    expect(trace).toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — secrets gate', () => {
  it('blocks with exit(1) when the gate discharge throws (missing required secret); never deploys or migrates remote', async () => {
    const { SelfHostEnvValidationError } = await import('../../src/cli/env-validation.ts');
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      dischargeSelfHostEnv: (async () => {
        trace.push('gate');
        throw new SelfHostEnvValidationError('env: missing required secret STRIPE_KEY');
      }) as CloudflareDeployDeps['dischargeSelfHostEnv'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The build ran BEFORE the gate (ground truth), but the gate failing blocks the REMOTE D1
    // apply AND the deploy — no account mutation past the build.
    expect(trace).toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
  });

  it('renders the first-deploy structured error and exits', async () => {
    const { SelfHostFirstDeployError } = await import('../../src/cli/env-validation.ts');
    const root = d1Project(PROVISIONED_D1);
    const { deps, exitCalls } = harness({
      dischargeSelfHostEnv: (async () => {
        throw new SelfHostFirstDeployError('worker not deployed yet');
      }) as CloudflareDeployDeps['dischargeSelfHostEnv'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
  });

  it("bootstraps an initial Durable Object migration after a required secret created Wrangler's draft", async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'secret-do-app' }),
      'void.json': '{}',
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify({
        account_id: 'acc123',
        name: 'secret-do-app',
        durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      }),
    });
    const current = '11111111-1111-4111-8111-111111111111';
    const next = '22222222-2222-4222-8222-222222222222';
    let active = current;
    const operations: Array<CloudflareOperation> = [];
    const runWrangler: DeployWranglerRun = (operation) => {
      operations.push(operation);
      if (operation.type === 'auth.whoami') {
        return { ...cleanExit, data: { loggedIn: true, accounts: [] } };
      }
      if (operation.type === 'deployments.status') {
        return {
          ...cleanExit,
          data: { versions: [{ version_id: active, percentage: 100 }] },
        };
      }
      if (operation.type === 'versions.list') {
        return {
          ...cleanExit,
          data: [
            {
              id: current,
              number: 1,
              annotations: { 'workers/triggered_by': 'secret' },
              resources: {
                bindings: [{ name: 'API_TOKEN', type: 'secret_text' }],
                script: {
                  etag: 'draft',
                  handlers: ['fetch'],
                  last_deployed_from: 'wrangler',
                },
                script_runtime: { usage_model: 'standard', limits: {} },
              },
            },
          ],
        };
      }
      if (operation.type === 'versions.upload') {
        return {
          ...cleanExit,
          status: 1,
          failure: 'durable-migration',
          errorCode: 10211,
          stderr: 'Durable Object migrations require deploy. [code: 10211]',
        };
      }
      if (operation.type === 'worker.deploy') {
        active = next;
        return {
          ...cleanExit,
          data: {
            versionId: next,
            workersDevUrl: 'https://secret-do-app.example.workers.dev',
          },
        };
      }
      if (operation.type === 'triggers.deploy' || operation.type === 'triggers.clear-crons') {
        expect(active).toBe(next);
        return cleanExit;
      }
      throw new Error(`Unexpected Cloudflare operation: ${operation.type}`);
    };
    let explicitBootstrapProof: boolean | undefined;
    const { deps } = harness({
      runWrangler,
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          serverKeys: ['API_TOKEN'],
          requiredKeys: ['API_TOKEN'],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      dischargeSelfHostEnv: async () => {},
      activateVersion: async (options) => {
        explicitBootstrapProof = options.allowFirstDeploymentBootstrap;
        return activateCloudflareVersionPrimitive({
          ...options,
          fetch: async () => {
            expect(operations.at(-2)?.type).toBe('triggers.clear-crons');
            expect(operations.at(-1)?.type).toBe('deployments.status');
            return Response.json({ ready: true, versionId: active });
          },
        });
      },
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(explicitBootstrapProof).not.toBe(true);
    expect(
      operations
        .map((operation) => operation.type)
        .filter(
          (type) =>
            type !== 'auth.whoami' && type !== 'deployments.status' && type !== 'versions.list',
        ),
    ).toEqual(['versions.upload', 'worker.deploy', 'triggers.deploy', 'triggers.clear-crons']);
    expect(active).toBe(next);
  });
});

describe('runCloudflareDeploy — D1 migrations_dir gate', () => {
  it('does not reprovision an already configured D1 database on a normal deploy', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace } = harness();

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(trace).not.toContain('provision');
    expect(trace).toContain('wrangler:deploy');
  });

  it('automatically reconciles a missing migrations_dir before applying D1 migrations', async () => {
    const root = d1Project(
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      },
      INIT_MIGRATION,
    );
    const provisionTrace: Array<string> = [];
    const { deps, wranglerArgs, trace, exitCalls } = harness({
      provision: (async (_root, configPath): Promise<ProvisionResult> => {
        provisionTrace.push('provision');
        writeFileSync(configPath, JSON.stringify(PROVISIONED_D1, null, 2));
        return {
          resources: [
            {
              kind: 'd1',
              binding: 'DB',
              name: 'myapp-db',
              action: 'reused',
              id: REAL_D1_ID,
            },
          ],
          configPath,
          accountIdWritten: false,
        };
      }) as CloudflareDeployDeps['provision'],
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(provisionTrace).toEqual(['provision']);
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(true);
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
  });

  /** A D1 app whose wrangler.jsonc sets `migrations_dir`; `<root>` becomes the project path. */
  function d1ProjectWithDir(migrationsDir: string, sourceDir?: string, pattern?: string): string {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify(sourceDir ? { sourceDir } : {}),
      [`${sourceDir ? `${sourceDir}/` : ''}routes/index.ts`]: `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
    });
    const config = structuredClone(PROVISIONED_D1);
    config.d1_databases[0]!.migrations_dir = migrationsDir.replace('<root>', root);
    if (pattern) {
      Object.assign(config.d1_databases[0]!, {
        migrations_pattern: pattern.replace('<root>', root),
      });
    }
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
    return root;
  }

  it.each([
    ['db/migrations', undefined],
    ['db/migrations/', undefined],
    ['./db/migrations/', undefined],
    ['db\\migrations', undefined],
    ['<root>/db/migrations', undefined],
    ['src/db/migrations', 'src'],
  ])('accepts migrations_dir %s naming the same folder without provisioning', async (dir, src) => {
    const root = d1ProjectWithDir(dir, src);
    const { deps, trace, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(trace).not.toContain('provision');
    expect(trace).toContain('wrangler:deploy');
  });

  it('checks a custom migrations_pattern against migrations_dir as written', async () => {
    const root = d1ProjectWithDir(
      '<root>/db/migrations',
      undefined,
      '<root>/db/migrations/**/*.sql',
    );
    const { deps, trace, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(trace).toContain('wrangler:deploy');
  });

  /** Run a deploy that must stop on the migrations_dir check; returns the logged errors. */
  async function rejectedDeployMessages(root: string): Promise<Array<string>> {
    const messages: Array<string> = [];
    const restore = log.error;
    log.error = (message: string) => messages.push(message);
    try {
      const { deps, trace, wranglerArgs } = harness();
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare', provision: true }, silentCliLog, deps),
      ).rejects.toMatchObject({ code: 1 });
      expect(trace).not.toContain('provision');
      expect(trace).not.toContain('build');
      expect(wranglerArgs).toEqual([]);
    } finally {
      log.error = restore;
    }
    return messages;
  }

  it.each([
    ['wrangler.jsonc', undefined, 'd1_databases of wrangler.jsonc'],
    ['wrangler.jsonc', 'src', 'd1_databases of wrangler.jsonc'],
    ['void.config.ts', undefined, 'cloudflare.d1_databases of void.config.ts'],
  ])(
    'rejects a migrations_dir for another folder in %s (sourceDir %s) before any account call',
    async (file, sourceDir, where) => {
      const database = {
        binding: 'DB',
        database_name: 'myapp-db',
        database_id: REAL_D1_ID,
        migrations_dir: 'drizzle',
      };
      const root = makeProject({
        'package.json': JSON.stringify({ name: 'myapp' }),
        [`${sourceDir ? `${sourceDir}/` : ''}routes/index.ts`]: `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
        ...(file === 'void.config.ts'
          ? {
              'void.config.ts': `export default { cloudflare: ${JSON.stringify({ account_id: 'acc123', name: 'myapp', d1_databases: [database] })} };`,
            }
          : {
              'void.json': JSON.stringify(sourceDir ? { sourceDir } : {}),
              'wrangler.jsonc': JSON.stringify(
                { account_id: 'acc123', name: 'myapp', d1_databases: [database] },
                null,
                2,
              ),
            }),
      });
      const expected = sourceDir ? `./${sourceDir}/db/migrations` : './db/migrations';
      expect(await rejectedDeployMessages(root)).toContain(
        `deploy: D1 binding "DB" sets migrations_dir "drizzle", but Void generates and applies migrations from "${expected}". Set migrations_dir to "${expected}" in ${where}, or remove it and Void will fill it in.`,
      );
    },
  );

  it('does not offer removal when the other folder comes only from void.lock.json', async () => {
    const cloudflare = {
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    };
    const resolved = structuredClone(PROVISIONED_D1);
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.config.ts': `export default { sourceDir: 'src', cloudflare: ${JSON.stringify(cloudflare)} };`,
      'void.lock.json': JSON.stringify({
        version: 1,
        source: cloudflare,
        resolved,
        text: `${JSON.stringify(resolved, null, 2)}\n`,
      }),
      'src/routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
    });
    expect(await rejectedDeployMessages(root)).toContain(
      'deploy: D1 binding "DB" sets migrations_dir "./db/migrations", but Void generates and applies migrations from "./src/db/migrations". Set migrations_dir to "./src/db/migrations" in cloudflare.d1_databases of void.config.ts.',
    );
  });

  it('provisions a void.config.ts D1 binding with migrations_dir "db/migrations", then deploys without provisioning', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.config.ts': `export default { cloudflare: { account_id: 'acc123', name: 'myapp', d1_databases: [{ binding: 'DB', database_name: 'myapp-db', migrations_dir: 'db/migrations' }] } };`,
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      ...INIT_MIGRATION,
    });
    for (const expectedProvisions of [1, 0]) {
      let provisions = 0;
      const { deps, trace, exitCalls, wranglerArgs } = harness({
        // Adopt the database the way the provisioner does; the writer keeps the spelling.
        provision: (async (_root, configPath): Promise<ProvisionResult> => {
          provisions++;
          writeProvisionedWranglerConfig(
            root,
            {
              d1: { binding: 'DB', databaseName: 'myapp-db', databaseId: REAL_D1_ID },
              d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
            },
            { configPath },
          );
          return { resources: [], configPath, accountIdWritten: false };
        }) as CloudflareDeployDeps['provision'],
      });
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
      expect(exitCalls).toEqual([]);
      expect(provisions).toBe(expectedProvisions);
      expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(true);
      expect(trace).toContain('wrangler:deploy');
      expect(
        parseRootWranglerConfig(join(root, '.void-wrangler.jsonc')).d1_databases,
      ).toMatchObject([{ database_id: REAL_D1_ID, migrations_dir: 'db/migrations' }]);
    }
  });
});

describe('runCloudflareDeploy — full Void app queues', () => {
  it('rejects configured Void routing rules for a Class-A framework before account mutation', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'fwapp',
        dependencies: { '@tanstack/react-start': '1.0.0' },
      }),
      'void.json': JSON.stringify({ routing: { rewrites: { '/old': '/new' } } }),
      'queues/jobs.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'fwapp' }, null, 2),
    });
    const messages: Array<string> = [];
    const restore = log.error;
    log.error = (message: string) => messages.push(message);
    try {
      const { deps, trace, wranglerArgs } = harness();
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(trace).toEqual([]);
      expect(wranglerArgs).toEqual([]);
    } finally {
      log.error = restore;
    }
    expect(messages.join('\n')).toMatch(/cannot apply Void routing[\s\S]*framework owns/);
  });

  it('deploys a Class-A framework queue through the verified artifact', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'fwapp',
        dependencies: { '@tanstack/react-start': '1.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'queues/jobs.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'fwapp' }, null, 2),
    });
    const { deps, trace, exitCalls } = harness();
    await runCloudflareDeploy(
      root,
      { platform: 'cloudflare', provision: true },
      silentCliLog,
      deps,
    );
    expect(exitCalls).toEqual([]);
    expect(trace).toContain('provision');
    expect(trace).toContain('wrangler:deploy');
  });

  it('lets a full Void app with a queue proceed (queues wire through the build)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'qapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'queues/jobs.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'qapp' }, null, 2),
    });
    const { deps, trace } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — pre-build queue existence probe', () => {
  /** A worker-bearing app desiring exactly one queue (`jobs`), fully config-provisioned. */
  function queueProject(): string {
    return makeProject({
      'package.json': JSON.stringify({ name: 'qapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'queues/jobs.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'qapp' }, null, 2),
    });
  }

  /**
   * The default harness plus a scripted `queues info` reply, so a test drives the
   * REAL classifier with the exact output wrangler would print. Every other wrangler
   * call keeps the harness behaviour (and its arg/trace recording).
   */
  function queueHarness(
    probe: (name: string) => DeployWranglerRunResult,
    overrides: Partial<CloudflareDeployDeps> = {},
  ): ReturnType<typeof harness> {
    const h = harness(overrides);
    const base = h.deps.runWrangler as DeployWranglerRun;
    h.deps.runWrangler = operationFixture((args, opts) => {
      const passthrough = base(operationFixtureRequest(args), opts);
      return args[0] === 'queues' && args[1] === 'info' ? probe(args[2] as string) : passthrough;
    });
    return h;
  }

  it('probes each desired queue by name before the build', async () => {
    const root = queueProject();
    const { deps, wranglerArgs, trace } = queueHarness((name) => ({
      ...cleanExit,
      stdout: `Queue Name: ${name}\n`,
    }));
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    const probeArgs = wranglerArgs.find((a) => a[0] === 'queues');
    expect(probeArgs).toEqual([
      'queues',
      'info',
      'jobs',
      '-c',
      toSlash(join(root, 'wrangler.jsonc')),
      '--env=',
    ]);
    // The probe runs before the build and everything after it.
    expect(trace.indexOf('wrangler:queues')).toBeLessThan(trace.indexOf('build'));
    expect(trace).toContain('wrangler:deploy');
  });

  it('automatically provisions a queue when the probe confirms it does not exist', async () => {
    const root = queueProject();
    const { deps, trace, exitCalls } = queueHarness((name) => ({
      ...cleanExit,
      status: 1,
      stderr: `✘ [ERROR] Queue "${name}" does not exist.\n`,
    }));
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(trace).toContain('wrangler:queues');
    expect(trace).toContain('provision');
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
  });

  it('proceeds when the probe fails for a reason other than the queue being absent', async () => {
    const root = queueProject();
    // An auth failure is NOT absence — blocking here would be a false positive, and
    // `wrangler deploy` still rejects a genuinely missing queue before uploading.
    const { deps, trace } = queueHarness(() => ({
      ...cleanExit,
      status: 1,
      stderr: '✘ [ERROR] A request to the Cloudflare API failed [code: 10000]\n',
    }));
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
  });

  it('proceeds when a killed probe merely buffered a not-found line', async () => {
    const root = queueProject();
    // A signal-killed child never ran to completion, so its buffered text is not proof.
    const { deps, trace } = queueHarness((name) => ({
      ...cleanExit,
      status: 1,
      signal: 'SIGKILL',
      stderr: `✘ [ERROR] Queue "${name}" does not exist.\n`,
    }));
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
  });

  it('never probes when the app desires no queues', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
  });

  it('never probes under --provision (the provisioner creates the queue itself)', async () => {
    const root = queueProject();
    const { deps, wranglerArgs, trace } = queueHarness(() => ({
      ...cleanExit,
      status: 1,
      stderr: '✘ [ERROR] Queue "jobs" does not exist.\n',
    }));
    await runCloudflareDeploy(
      root,
      { platform: 'cloudflare', provision: true },
      silentCliLog,
      deps,
    );
    expect(trace).toContain('provision');
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
    expect(trace).toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — pre-build queue name validation', () => {
  /**
   * A worker-bearing app whose desired queues come from the given `queues/` filenames.
   * Queue names are derived from those paths (`queues/scan.ts` strips the extension and joins
   * nested segments with `-`), so this fixture is how an adversarial name actually reaches deploy.
   */
  function queueNameProject(...fileNames: Array<string>): string {
    return makeProject({
      'package.json': JSON.stringify({ name: 'qapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'qapp' }, null, 2),
      ...Object.fromEntries(fileNames.map((f) => [`queues/${f}`, `export default {};`])),
    });
  }

  /** Run the deploy capturing `log.error` output, restoring the real logger after. */
  async function runCapturingErrors(
    root: string,
    deps: CloudflareDeployDeps,
  ): Promise<Array<string>> {
    const messages: Array<string> = [];
    const restore = log.error;
    log.error = (msg: string) => {
      messages.push(msg);
    };
    try {
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      log.error = restore;
    }
    return messages;
  }

  it('fails closed on a leading-dash name before the build, the D1 apply, or the probe', async () => {
    // `queues/--help.ts` yields the literal name `--help`, which wrangler would parse as a
    // FLAG: `queues info --help` exits 0 printing usage, which the probe reads as
    // inconclusive and waves through. The name gate must stop it before that.
    const root = queueNameProject('--help.ts');
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    const messages = await runCapturingErrors(root, deps);

    expect(exitCalls).toEqual([1]);
    const joined = messages.join('\n');
    expect(joined).toContain('--help');
    expect(joined).toContain('queues/');
    expect(joined).toContain('begin and end with a letter or digit');
    // Nothing past the gate ran: no probe, no build, no remote D1 apply, no upload.
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toEqual(['wrangler:whoami']);
  });

  it('rejects a shell-significant name by the grammar', async () => {
    // The runner uses `spawnSync` with `shell: false`, so `$(touch marker)` was never
    // executable — the point is that an invalid name can no longer reach wrangler's argv
    // or the printed `wrangler queues create <name>` guidance at all.
    const root = queueNameProject('$(touch marker).ts');
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    const messages = await runCapturingErrors(root, deps);

    expect(exitCalls).toEqual([1]);
    const joined = messages.join('\n');
    expect(joined).toContain('$(touch marker)');
    // The absent-queue branch's `wrangler queues create <name>` guidance is never reached.
    expect(joined).not.toContain('wrangler queues create');
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
    expect(trace).toEqual(['wrangler:whoami']);
    // Belt and braces: no subshell ever ran.
    expect(existsSync(join(root, 'marker'))).toBe(false);
  });

  it('reports every invalid queue name together rather than dying on the first', async () => {
    const root = queueNameProject('--help.ts', '$(touch marker).ts', 'jobs.ts');
    const { deps, wranglerArgs, exitCalls } = harness();
    const messages = await runCapturingErrors(root, deps);

    expect(exitCalls).toEqual([1]);
    // ONE batched message naming BOTH offenders — and not the valid sibling.
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message).toContain('  • --help (queue)');
    expect(message).toContain('  • $(touch marker) (queue)');
    expect(message).not.toContain('• jobs');
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
  });

  it('lets a valid queue name through to the probe unchanged', async () => {
    const root = queueNameProject('jobs.ts');
    const { deps, wranglerArgs, trace } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    // The gate is transparent to a legal name: the probe still runs, pre-build, for `jobs`.
    expect(wranglerArgs.find((a) => a[0] === 'queues')).toEqual([
      'queues',
      'info',
      'jobs',
      '-c',
      toSlash(join(root, 'wrangler.jsonc')),
      '--env=',
    ]);
    expect(trace.indexOf('wrangler:queues')).toBeLessThan(trace.indexOf('build'));
    expect(trace).toContain('wrangler:deploy');
  });

  it('probes a nested queue using its normalized Cloudflare resource name', async () => {
    const root = queueNameProject('order/notifications.ts');
    const { deps, wranglerArgs, trace } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(wranglerArgs.find((args) => args[0] === 'queues')).toEqual([
      'queues',
      'info',
      'order-notifications',
      '-c',
      toSlash(join(root, 'wrangler.jsonc')),
      '--env=',
    ]);
    expect(trace.indexOf('wrangler:queues')).toBeLessThan(trace.indexOf('build'));
    expect(trace).toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — skipped desired resource is fatal', () => {
  it('fails closed when the provisioner skips a desired Hyperdrive; never builds/deploys', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'pgapp' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'pgapp' }, null, 2),
    });
    const { deps, trace, exitCalls } = harness({
      provision: (async (_root, configPath): Promise<ProvisionResult> => {
        trace.push('provision');
        return {
          resources: [
            {
              kind: 'hyperdrive',
              binding: 'HYPERDRIVE',
              name: 'pgapp-hyperdrive',
              action: 'skipped',
              reason: 'no connection string provided',
            },
          ],
          configPath,
          accountIdWritten: false,
        };
      }) as CloudflareDeployDeps['provision'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare', provision: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toContain('provision');
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — non-Cloudflare target guard', () => {
  for (const target of ['node', 'bun', 'deno'] as const) {
    it(`rejects the "${target}" target before any account/provision op`, async () => {
      const root = makeProject({
        'package.json': JSON.stringify({ name: 'nodeapp' }),
        'void.json': JSON.stringify({ target }),
        'routes/index.ts': `export const GET = () => new Response('ok');`,
        'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'nodeapp' }, null, 2),
      });
      const { deps, trace, exitCalls } = harness();
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare', provision: true }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(exitCalls).toEqual([1]);
      // Rejected before the desired set + any wrangler/provision call.
      expect(trace).toEqual([]);
    });
  }
});

describe('runCloudflareDeploy — worker-name override (WRANGLER_CI_OVERRIDE_NAME)', () => {
  it('fails closed when a project dotenv declares WRANGLER_CI_OVERRIDE_NAME', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
      '.env': 'WRANGLER_CI_OVERRIDE_NAME=other-worker\n',
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Fenced during preflight (before whoami) — nothing ran.
    expect(trace).toEqual([]);
  });

  it('ignores an ambient WRANGLER_CI_OVERRIDE_NAME — deploys the derived (non-override) name', async () => {
    vi.stubEnv('WRANGLER_CI_OVERRIDE_NAME', 'evil-name');
    // Root config has NO top-level name → the worker name is derived from package.json,
    // NOT the ambient override.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'myapp-db',
              database_id: REAL_D1_ID,
              migrations_dir: './db/migrations',
            },
          ],
        },
        null,
        2,
      ),
    });
    let deployedWorker: unknown;
    const cliLog: CliLogger = {
      ...silentCliLog,
      info(event: string, fields?: Record<string, unknown>) {
        if (event === 'cloudflare_deploy_end') {
          deployedWorker = fields?.worker;
        }
      },
    };
    const { deps, trace } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, cliLog, deps);
    expect(trace).toContain('wrangler:deploy');
    expect(deployedWorker).toBe('myapp');
    // The pinned root config name is the derived name, never the override.
    const written = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')) as {
      name?: string;
    };
    expect(written.name).toBe('myapp');
  });
});

describe('runCloudflareDeploy — build-config override fences', () => {
  it('fails closed when .env.production declares CLOUDFLARE_ENV', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
      '.env.production': 'CLOUDFLARE_ENV=staging\n',
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('fails closed when .env.production declares CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
      '.env.production': 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=./alt.jsonc\n',
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('fails closed on a .env. transport redirect (reused provisioner fence)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
      '.env.': 'CLOUDFLARE_API_BASE_URL=https://evil.example.com\n',
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('fails closed on an ambient CLOUDFLARE_ENV (non-top-level target)', async () => {
    vi.stubEnv('CLOUDFLARE_ENV', 'staging');
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });
});

describe('assertNoConfigOverrideInProjectDotenv', () => {
  it('rejects WRANGLER_CI_OVERRIDE_NAME in a wrangler --env= dotenv file', () => {
    const root = makeProject({ '.env': 'WRANGLER_CI_OVERRIDE_NAME=x\n' });
    expect(() => assertNoConfigOverrideInProjectDotenv(root, 'linux')).toThrow(
      /WRANGLER_CI_OVERRIDE_NAME/,
    );
  });

  it('rejects CLOUDFLARE_ENV / CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH in the vite production set', () => {
    const rootA = makeProject({ '.env.production': 'CLOUDFLARE_ENV=prod\n' });
    expect(() => assertNoConfigOverrideInProjectDotenv(rootA, 'linux')).toThrow(/CLOUDFLARE_ENV/);
    const rootB = makeProject({
      '.env.production.local': 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=./alt.jsonc\n',
    });
    expect(() => assertNoConfigOverrideInProjectDotenv(rootB, 'linux')).toThrow(
      /CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH/,
    );
  });

  it('passes when no override selectors are declared', () => {
    const root = makeProject({ '.env': 'FOO=bar\n', '.env.production': 'BAZ=qux\n' });
    expect(() => assertNoConfigOverrideInProjectDotenv(root, 'linux')).not.toThrow();
  });
});

describe('runCloudflareDeploy — D1 migrate targets the unique validated entry', () => {
  it('fails closed when an earlier alias entry shares the migrate token', async () => {
    // Two D1 entries share database_name "myapp-db" with DIFFERENT migrations_dir. The
    // gate validated binding DB, but wrangler would first-match the earlier OLD entry.
    const root = d1Project(
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [
          {
            binding: 'OLD',
            database_name: 'myapp-db',
            database_id: REAL_D1_ID,
            migrations_dir: './legacy',
          },
          {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: REAL_D1_ID,
            migrations_dir: './db/migrations',
          },
        ],
      },
      INIT_MIGRATION,
    );
    const { deps, wranglerArgs, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The migrate-target gate runs post-build, before any `d1 migrations apply` or deploy.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('migrates by the unique token even when the validated entry is not first', async () => {
    const root = d1Project(
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [
          {
            binding: 'OLD',
            database_name: 'legacy-db',
            database_id: REAL_D1_ID,
            migrations_dir: './legacy',
          },
          {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: REAL_D1_ID,
            migrations_dir: './db/migrations',
          },
        ],
      },
      INIT_MIGRATION,
    );
    const { deps, wranglerArgs, trace } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    // Targets the validated entry's own unique database_name (resolves to DB, not OLD).
    expect(wranglerArgs.filter((a) => a[0] === 'd1').every((a) => a[3] === 'myapp-db')).toBe(true);
    expect(wranglerArgs.find((a) => a[0] === 'd1' && a[2] === 'apply')).toEqual([
      'd1',
      'migrations',
      'apply',
      'myapp-db',
      '--remote',
      '-c',
      toSlash(join(root, 'wrangler.jsonc')),
      '--env=',
    ]);
    expect(trace).toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — wrangler implicit provisioning disabled on deploy', () => {
  it('passes both disable-flags for an R2 app that passes local drift (no auto-create)', async () => {
    // R2 bucket_name present locally (drift passes) but may be absent remotely — deploy
    // must NOT let wrangler auto-create it.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'r2app' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.STORAGE.put('a', 'b');`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'r2app',
          r2_buckets: [{ binding: 'STORAGE', bucket_name: 'r2app-storage' }],
        },
        null,
        2,
      ),
    });
    const { deps, wranglerArgs } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(wranglerArgs.find((a) => a[0] === 'deploy')).toEqual([
      'deploy',
      '-c',
      join(root, 'dist/ssr/wrangler.json'),
      '--env=',
      '--experimental-provision=false',
      '--experimental-auto-create=false',
      '--autoconfig=false',
    ]);
  });
});

// The pass-through assert-set is every registry field minus these exclusions, so a typo here
// would silently assert a field Void emits.
describe('DEPLOY_PASSTHROUGH_EXCLUDE_FIELDS', () => {
  it('every excluded field is a REAL registry key (no typos)', () => {
    for (const field of DEPLOY_PASSTHROUGH_EXCLUDE_FIELDS) {
      expect(FRIENDLY_BINDING_NAMES).toHaveProperty(field);
    }
  });
});

describe('verifyGeneratedDeployConfig', () => {
  function deployConfigProject(generated: Record<string, unknown>): string {
    return makeProject({
      '.wrangler/deploy/config.json': JSON.stringify({
        configPath: '../../dist/ssr/wrangler.json',
      }),
      'dist/ssr/wrangler.json': JSON.stringify(generated),
    });
  }

  it('accepts comments and trailing commas in a generated JSONC config', () => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    writeFileSync(
      join(root, 'dist/ssr/wrangler.json'),
      '{ // project config\n "account_id": "acc123", "name": "myapp", }',
    );
    expect(verifyGeneratedDeployConfig(root, { accountId: 'acc123', workerName: 'myapp' })).toEqual(
      {
        ok: true,
      },
    );
  });

  it('requires every schema-declared server secret to be inherited', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      secrets: { required: ['API_TOKEN'] },
    });
    expect(
      verifyGeneratedDeployConfig(root, {
        accountId: 'acc123',
        workerName: 'myapp',
        requiredSecretNames: ['API_TOKEN'],
      }),
    ).toEqual({ ok: true });
    const missing = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      requiredSecretNames: ['API_TOKEN', 'REMOTE_ONLY'],
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/REMOTE_ONLY.*secrets\.required/);
  });

  it('fails when the generated account_id differs (named-env redirect)', () => {
    const root = deployConfigProject({ account_id: 'other-acc', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, { accountId: 'acc123', workerName: 'myapp' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/account_id/);
  });

  it('fails when the generated worker name differs (e.g. env-suffixed name)', () => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp-prod' });
    const result = verifyGeneratedDeployConfig(root, { accountId: 'acc123', workerName: 'myapp' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/worker name/);
  });

  it('requires auth-enabled builds to inherit BETTER_AUTH_SECRET', () => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      authEnabled: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/BETTER_AUTH_SECRET.*secrets\.required/);
  });

  it('accepts auth inheritance while preserving other required secrets', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      secrets: { required: ['API_KEY', 'BETTER_AUTH_SECRET'] },
    });
    expect(
      verifyGeneratedDeployConfig(root, {
        accountId: 'acc123',
        workerName: 'myapp',
        authEnabled: true,
      }),
    ).toEqual({ ok: true });
  });

  it('fails closed when the deploy config was not emitted', () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'myapp' }) });
    const result = verifyGeneratedDeployConfig(root, { accountId: 'acc123', workerName: 'myapp' });
    expect(result.ok).toBe(false);
  });

  it('fails when the generated binding identity differs from the pinned snapshot', () => {
    // Same account_id + name, but the generated D1 database_id differs from the identity
    // pinned before the build — a flattened named-env / alternate-config binding set, OR a
    // build that rewrote the id. The snapshot (not a root re-read) is the ground truth.
    const desired = { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] };
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: OTHER_D1_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired,
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/identity|flattened|tampered/);
  });

  it('fails when the generated config drops a pinned binding entirely', () => {
    const desired = { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] };
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp', d1_databases: [] });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired,
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/);
  });

  it('passes when the generated binding identities match the pinned snapshot', () => {
    const desired = {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
      queues: [],
    };
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired,
      bindingIdentitySnapshot: snapshot,
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails when a non-D1 binding identity (R2 / Hyperdrive) differs from the snapshot', () => {
    // R2 (bucket_name) and Hyperdrive (id) are pinned the same way D1 is — the snapshot +
    // verify logic is uniform across kinds, so both must be caught.
    const r2Desired = {
      r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
      kvNamespaces: [],
      queues: [],
    };
    const r2Snapshot = snapshotBindingIdentities({
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-storage' }],
    });
    const r2Root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'someone-elses-bucket' }],
    });
    expect(
      verifyGeneratedDeployConfig(r2Root, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: r2Desired,
        bindingIdentitySnapshot: r2Snapshot,
      }).ok,
    ).toBe(false);

    const hyperDesired = {
      hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hyperdrive', connectionString: '' },
      kvNamespaces: [],
      queues: [],
    };
    const hyperSnapshot = snapshotBindingIdentities({
      hyperdrive: [{ binding: 'HYPERDRIVE', id: REAL_KV_ID }],
    });
    const hyperRoot = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      hyperdrive: [{ binding: 'HYPERDRIVE', id: OTHER_KV_ID }],
    });
    expect(
      verifyGeneratedDeployConfig(hyperRoot, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: hyperDesired,
        bindingIdentitySnapshot: hyperSnapshot,
      }).ok,
    ).toBe(false);
  });

  it('passes with the full non-id binding set a real build emits (allow-list is exercised)', () => {
    // Every id-bearing binding matches the snapshot, and the artifact also carries the non-id
    // bindings a real Class-A build emits. None of those is in the snapshot; none may be rejected.
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-storage' }],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      ...KITCHEN_SINK_NON_ID_BINDINGS,
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-storage' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: {
        d1: { binding: 'DB', name: 'myapp-db' },
        kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
        r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
        queues: ['jobs'],
      },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails when the artifact declares an id-bearing binding absent from the snapshot (build ADD)', () => {
    // Only DB was pinned pre-build; the artifact ADDS an EXTRA_KV the snapshot never saw. The
    // per-desired loop only walks {DB}, so completeness is what rejects this.
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'EXTRA_KV', id: OTHER_KV_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EXTRA_KV/);
  });

  it('fails when a NON-desired binding id in the artifact diverges from the snapshot', () => {
    // A hand-declared, non-desired EXTRA_DB is pinned pre-build; the artifact rewrites its id.
    // The desired loop never inspects EXTRA_DB — completeness catches the divergence.
    const snapshot = snapshotBindingIdentities({
      d1_databases: [
        { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: REAL_D1_ID },
      ],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [
        { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: OTHER_D1_ID },
      ],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EXTRA_DB/);
  });

  it('passes when a NON-desired binding present in the snapshot is unchanged in the artifact', () => {
    // The legitimate-extra case: a user hand-declared EXTRA_DB, it was pinned pre-build, and the
    // build left it untouched — completeness must NOT false-positive on a legitimate extra.
    const snapshot = snapshotBindingIdentities({
      d1_databases: [
        { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: OTHER_D1_ID },
      ],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [
        { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: OTHER_D1_ID },
      ],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails closed when the build DROPS a non-desired root id-bearing binding (EXTRA_DB)', () => {
    // A hand-declared, NON-desired EXTRA_DB is pinned pre-build; the emitted artifact keeps the
    // desired DB but no longer declares EXTRA_DB. The desired loop only inspects DB, and the
    // completeness loop only walks what the artifact declares — neither sees the omission. The
    // reverse-presence loop must reject it (a dropped id-binding silently strips a capability).
    const snapshot = snapshotBindingIdentities({
      d1_databases: [
        { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: OTHER_D1_ID },
      ],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EXTRA_DB/);
    expect(result.reason).toMatch(/dropped/);
  });

  it('fails closed when the build drops a pinned id-bearing binding by removing the whole field', () => {
    // The KV field is present pre-build (one pinned namespace) but the emitted artifact omits the
    // `kv_namespaces` field entirely. A removed field means every pinned binding in it is missing —
    // the reverse-presence loop rejects it while the D1 binding still passes.
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'EXTRA_KV', id: REAL_KV_ID }],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EXTRA_KV/);
  });

  // --- Pass-through bindings (fields Void never emits) and queues ---

  it('fails closed when the build injects a services binding absent from the root snapshot', () => {
    // Root had no `services` pre-build; the artifact adds one binding to another same-account
    // worker — a capability the source never asked for.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      services: [{ binding: 'EVIL', service: 'someone-elses-worker' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/services/);
    expect(result.reason).toMatch(/injected/);
  });

  it('fails closed when the build injects a secrets_store_secrets or dispatch_namespaces entry', () => {
    for (const field of ['secrets_store_secrets', 'dispatch_namespaces'] as const) {
      const root = deployConfigProject({
        account_id: 'acc123',
        name: 'myapp',
        [field]: [{ binding: 'INJECTED' }],
      });
      const result = verifyGeneratedDeployConfig(root, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: { kvNamespaces: [], queues: [] },
        passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(new RegExp(field));
    }
  });

  // --- Reverse-presence: a root-declared pass-through binding the build DROPPED is rejected ---

  it('fails closed when the build DROPS a root-declared services binding from the emitted config', () => {
    // The source declared a `services` binding pre-build; the emitted artifact no longer carries it
    // (the build removed it). The forward loop only walks emitted entries, so it cannot see the
    // omission — the reverse-presence loop must reject it.
    const rootConfig = { services: [{ binding: 'MY_SVC', service: 'my-other-worker' }] };
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/services/);
    expect(result.reason).toMatch(/MY_SVC/);
  });

  it('fails closed when the build drops one of several pinned passthrough bindings', () => {
    // Two root-declared bindings across two fields; the emitted config keeps `mtls_certificates` but
    // drops the `services` one. The surviving binding passes the forward loop, but the reverse loop
    // catches the dropped one.
    const rootConfig = {
      services: [{ binding: 'SVC', service: 'worker-a' }],
      mtls_certificates: [{ binding: 'CERT', certificate_id: 'cert-1' }],
    };
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      mtls_certificates: [{ binding: 'CERT', certificate_id: 'cert-1' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/services/);
    expect(result.reason).toMatch(/SVC/);
  });

  it('passes when every pinned passthrough binding is still present in the emitted config', () => {
    // Every root-declared pass-through binding survives the build byte-identical.
    const rootConfig = {
      services: [{ binding: 'SVC', service: 'worker-a' }],
      mtls_certificates: [{ binding: 'CERT', certificate_id: 'cert-1' }],
    };
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp', ...rootConfig });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails closed when the build injects a queue producer not in desired.queues', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      queues: { producers: [{ binding: 'Q', queue: 'exfil' }], consumers: [] },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/queue/);
    expect(result.reason).toMatch(/exfil/);
  });

  it('passes emitted queues whose producer AND consumer names are all in desired.queues', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      queues: {
        producers: [{ binding: 'JOBS', queue: 'jobs' }],
        consumers: [{ queue: 'jobs', max_batch_size: 10 }],
      },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: ['jobs'] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails closed when a desired queue is DROPPED (the emitted queues field is absent)', () => {
    // `mergeBindings` emits every desired queue as both a producer AND a consumer, so a desired
    // queue with NO emitted `queues` field at all is a queue binding the build dropped — the worker
    // would lose message processing and leave `QUEUE_jobs` undefined. The emitted ⊆ desired check
    // waves this through (nothing emitted); the per-group presence check must reject it.
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: ['jobs'] },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/jobs/);
    expect(result.reason).toMatch(/producer and a consumer/);
  });

  it('fails closed when a desired queue keeps only the producer (consumer dropped)', () => {
    // The artifact retains the producer but drops the consumer — the worker can still enqueue but
    // never processes. Per-group presence is why the merged reader cannot catch this: `jobs` is
    // still in the merged name set, so only checking each group separately rejects it.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      queues: { producers: [{ binding: 'JOBS', queue: 'jobs' }], consumers: [] },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: ['jobs'] },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/jobs/);
    expect(result.reason).toMatch(/producer and a consumer/);
  });

  it('does NOT reject an unknown/future resource field the emitted artifact declares (fail-open)', () => {
    // A field not in the assert-set must never false-positive — a future wrangler resource field
    // Void does not know about is simply not asserted.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      some_future_resource: [{ binding: 'NEW_THING' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result).toEqual({ ok: true });
  });

  it('does NOT reject durable_objects / containers in the emitted artifact (DO/sandbox out of scope)', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      durable_objects: { bindings: [{ name: 'WS', class_name: 'ChatRoom' }] },
      containers: [{ class_name: 'Sandbox', image: './Dockerfile' }],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Sandbox'] }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result).toEqual({ ok: true });
  });

  // --- Pass-through TARGET pin: same binding name, rewritten target/config ---

  it('fails closed when the build keeps a services binding NAME but rewrites its target service', () => {
    // Root pinned MY_SVC → my-worker; the build kept the name but retargeted it to evil-worker.
    // Name-only pinning would pass this; the exact entry pin catches the rewrite.
    const rootConfig = { services: [{ binding: 'MY_SVC', service: 'my-worker' }] };
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      services: [{ binding: 'MY_SVC', service: 'evil-worker' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/services/);
    expect(result.reason).toMatch(/MY_SVC/);
    expect(result.reason).toMatch(/rewrote|differs/);
  });

  it('fails closed when the build ADDS an entrypoint/environment to a pinned services entry', () => {
    // A real `vite build` adds NOTHING to a present pass-through entry (verified against the real
    // toolchain), so an added `entrypoint`/`environment` — which wrangler uploads, retargeting the
    // service to a named entrypoint/environment — is a build rewrite the exact entry pin catches.
    const rootConfig = { services: [{ binding: 'MY_SVC', service: 'my-worker' }] };
    for (const added of [{ entrypoint: 'EvilEntry' }, { environment: 'staging' }]) {
      const root = deployConfigProject({
        account_id: 'acc123',
        name: 'myapp',
        services: [{ binding: 'MY_SVC', service: 'my-worker', ...added }],
      });
      const result = verifyGeneratedDeployConfig(root, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: { kvNamespaces: [], queues: [] },
        passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/services/);
      expect(result.reason).toMatch(/MY_SVC/);
      expect(result.reason).toMatch(/rewrote|differs/);
    }
  });

  // --- Capability singletons + the `unsafe` escape hatch ---

  it('fails closed when the build injects a capability singleton absent from the root', () => {
    for (const field of ['browser', 'images', 'stream', 'media', 'websearch'] as const) {
      const root = deployConfigProject({
        account_id: 'acc123',
        name: 'myapp',
        [field]: { binding: 'INJECTED' },
      });
      const result = verifyGeneratedDeployConfig(root, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: { kvNamespaces: [], queues: [] },
        passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(new RegExp(field));
      expect(result.reason).toMatch(/injected/);
    }
  });

  it('accepts clean artifacts without optional bindings or traffic attachments', () => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
    });
    expect(result).toEqual({ ok: true });
  });

  // --- Normalizer defaults that must keep passing ---

  it('passes empty-array assert fields the normalizer default-fills (services:[] / vectorize:[] / …)', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      services: [],
      vectorize: [],
      dispatch_namespaces: [],
      analytics_engine_datasets: [],
      send_email: [],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes logfwdr:{bindings:[]} (always emitted, empty bindings) with none in root', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      logfwdr: { bindings: [] },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result).toEqual({ ok: true });
  });

  // --- Whole-object fields: `unsafe` (wrangler applies its metadata over every uploaded binding),
  // the traffic attachment and tail consumers. None is an entry the binding pin can see. ---

  it.each<{
    change: string;
    rootConfig: Record<string, unknown>;
    emitted: Record<string, unknown>;
    reason: RegExp;
  }>([
    {
      change: 'injects an `unsafe` object (metadata bindings)',
      rootConfig: {},
      emitted: {
        unsafe: { metadata: { bindings: [{ name: 'X', type: 'service', service: 'evil' }] } },
      },
      reason: /unsafe/,
    },
    {
      change: 'rewrites a root-declared `unsafe` object',
      rootConfig: { unsafe: { bindings: [{ name: 'X', type: 'secret_text' }] } },
      emitted: { unsafe: { bindings: [{ name: 'X', type: 'plain_text' }] } },
      reason: /unsafe/,
    },
    {
      change: 'empties a root-declared `unsafe` object',
      rootConfig: { unsafe: { bindings: [{ name: 'X', type: 'plain_text' }] } },
      emitted: { unsafe: { bindings: [] } },
      reason: /unsafe/,
    },
    {
      change: 'injects a routes entry',
      rootConfig: {},
      emitted: { routes: [{ pattern: 'victim.example.com/*', zone_name: 'victim.example.com' }] },
      reason: /routes/,
    },
    {
      change: 'injects a single `route` string',
      rootConfig: {},
      emitted: { route: 'victim.example.com/*' },
      reason: /route/,
    },
    {
      // `false` is a declared value, so flipping it is compared, not treated as empty.
      change: 'flips a root-declared workers_dev from false to true',
      rootConfig: { workers_dev: false },
      emitted: { workers_dev: true },
      reason: /workers_dev/,
    },
    {
      change: 'injects workers_dev:true',
      rootConfig: {},
      emitted: { workers_dev: true },
      reason: /workers_dev/,
    },
    {
      change: 'injects preview_urls:true',
      rootConfig: {},
      emitted: { preview_urls: true },
      reason: /preview_urls/,
    },
    {
      change: 'injects a tail_consumers entry',
      rootConfig: {},
      emitted: { tail_consumers: [{ service: 'evil-log-collector' }] },
      reason: /tail_consumers/,
    },
    {
      change: 'injects a streaming_tail_consumers entry',
      rootConfig: {},
      emitted: { streaming_tail_consumers: [{ service: 'evil-log-collector' }] },
      reason: /streaming_tail_consumers/,
    },
    {
      // An emitted `[]` is uploaded as-is, which would silently disable the forwarding.
      change: 'empties a root-declared tail_consumers',
      rootConfig: { tail_consumers: [{ service: 'audit-collector' }] },
      emitted: { tail_consumers: [] },
      reason: /tail_consumers/,
    },
    {
      change: 'empties a root-declared streaming_tail_consumers',
      rootConfig: { streaming_tail_consumers: [{ service: 'audit-collector' }] },
      emitted: { streaming_tail_consumers: [] },
      reason: /streaming_tail_consumers/,
    },
  ])('fails closed when the build $change', ({ rootConfig, emitted, reason }) => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp', ...emitted });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
      passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  it.each<{ value: string; rootConfig: Record<string, unknown>; emitted: Record<string, unknown> }>(
    [
      {
        value: 'a root-declared `unsafe` object emitted byte-identical',
        rootConfig: {
          unsafe: {
            metadata: { bindings: [{ name: 'X', type: 'service', service: 'my-worker' }] },
          },
        },
        emitted: {
          unsafe: {
            metadata: { bindings: [{ name: 'X', type: 'service', service: 'my-worker' }] },
          },
        },
      },
      {
        value: 'root-declared routes emitted byte-identical',
        rootConfig: { routes: [{ pattern: 'app.example.com/*', zone_name: 'app.example.com' }] },
        emitted: { routes: [{ pattern: 'app.example.com/*', zone_name: 'app.example.com' }] },
      },
      {
        value: 'a root-declared workers_dev:false and preview_urls:false emitted byte-identical',
        rootConfig: { workers_dev: false, preview_urls: false },
        emitted: { workers_dev: false, preview_urls: false },
      },
      {
        value: 'a root-declared tail_consumers emitted byte-identical',
        rootConfig: { tail_consumers: [{ service: 'my-log-collector' }] },
        emitted: { tail_consumers: [{ service: 'my-log-collector' }] },
      },
      {
        value: 'a root-declared streaming_tail_consumers emitted byte-identical',
        rootConfig: { streaming_tail_consumers: [{ service: 'my-log-collector' }] },
        emitted: { streaming_tail_consumers: [{ service: 'my-log-collector' }] },
      },
      {
        value: 'an emitted tail_consumers default-filled to an empty array',
        rootConfig: {},
        emitted: { tail_consumers: [] },
      },
      {
        value: 'an emitted streaming_tail_consumers default-filled to an empty array',
        rootConfig: {},
        emitted: { streaming_tail_consumers: [] },
      },
    ],
  )('passes $value', ({ rootConfig, emitted }) => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp', ...emitted });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
      passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
    });
    expect(result).toEqual({ ok: true });
  });

  // --- External Durable Object (`script_name` targets another worker's DOs) ---

  it('fails closed when the build injects an external durable_object (script_name) absent from root', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      durable_objects: {
        bindings: [{ name: 'EXT', class_name: 'Other', script_name: 'someone-elses-worker' }],
      },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/durable_objects/);
    expect(result.reason).toMatch(/EXT/);
  });

  it('fails closed when the build adds an `environment` to a durable_object binding', () => {
    // `environment` narrows a cross-script DO to a named environment — external-targeting.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      durable_objects: {
        bindings: [{ name: 'EXT', class_name: 'Other', environment: 'staging' }],
      },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/durable_objects/);
  });

  it('passes Void-style LOCAL durable_objects (`{name, class_name}`, no script_name)', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      durable_objects: {
        bindings: [
          { name: 'SANDBOX', class_name: 'Sandbox' },
          { name: 'WS', class_name: 'ChatRoom' },
        ],
      },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes a root-declared external durable_object emitted byte-identical', () => {
    const rootConfig = {
      durable_objects: {
        bindings: [{ name: 'EXT', class_name: 'Other', script_name: 'my-other-worker' }],
      },
    };
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp', ...rootConfig });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
    });
    expect(result).toEqual({ ok: true });
  });

  // --- AI binding (must be Void's own {binding:'AI'}, the root's, or absent) ---

  it("passes Void's own emitted ai binding {binding:'AI'} with none in root when the source uses AI", () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      ai: { binding: 'AI' },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
      needsAI: true,
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes a configured custom emitted ai binding when the source uses AI', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      ai: { binding: 'MY_AI' },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
      needsAI: true,
      aiBindingName: 'MY_AI',
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails closed when the build injects Void's own {binding:'AI'} but the source does not use AI", () => {
    // No root ai + needsAI false: a real build never emits `{binding:'AI'}` here, so an emitted one
    // is a build-injected billable Workers AI binding.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      ai: { binding: 'AI' },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
      needsAI: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ai binding/);
  });

  it('passes an emitted ai binding byte-identical to the root ai binding', () => {
    const rootConfig = { ai: { binding: 'AI_EXTRA' } };
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp', ...rootConfig });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails closed when the build rewrites a custom root ai binding down to the default', () => {
    // The root declared a custom ai binding; the emitted one must equal it EXACTLY. Rewriting it
    // to `{binding:'AI'}` (or any other shape) is a build tampering with the ai target — reject
    // even when needsAI is true, since the root's own binding is the ground truth.
    const rootConfig = { ai: { binding: 'AI', gateway: { id: 'my-own-gateway' } } };
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      ai: { binding: 'AI' },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
      needsAI: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ai binding/);
  });

  it('fails closed when the build injects an ai binding that is neither Void’s own nor the root’s', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      ai: { binding: 'AI', gateway: { id: 'exfil-gateway' } },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ai binding/);
  });

  it('fails closed when the build REMOVES a root-declared ai binding (emitted ai absent)', () => {
    // The source declared its own `ai` binding pre-build; the emitted config drops it entirely. The
    // check reads the root ai FIRST, so a removed root ai — not just a rewrite — is rejected. Without
    // this, the deploy would ship a worker missing the configured AI binding.
    const rootConfig = { ai: { binding: 'CUSTOM_AI' } };
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ai binding/);
  });

  // --- Complete Durable Object and migration pins ---

  it('rejects a build-injected local Durable Object binding', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      durable_objects: { bindings: [{ name: 'INJECTED', class_name: 'InjectedObject' }] },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughRawFields: snapshotPassthroughRawFields({}),
      expectedDurableObjectBindings: [],
      expectedMigrations: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/durable_objects/);
  });

  it('rejects a build that drops a root Durable Object binding', () => {
    const rootBinding = { name: 'ROOM', class_name: 'Room' };
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughRawFields: snapshotPassthroughRawFields({
        durable_objects: { bindings: [rootBinding] },
      }),
      expectedDurableObjectBindings: [rootBinding],
      expectedMigrations: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/durable_objects/);
  });

  it('rejects a build-injected creation-only Durable Object migration', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      migrations: [{ tag: 'injected', new_sqlite_classes: ['InjectedObject'] }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughRawFields: snapshotPassthroughRawFields({}),
      expectedDurableObjectBindings: [],
      expectedMigrations: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/migrations/);
  });

  it('rejects a build that retargets a root creation migration', () => {
    const rootMigration = { tag: 'v1', new_sqlite_classes: ['Room'] };
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      migrations: [{ tag: 'v1', new_sqlite_classes: ['InjectedObject'] }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughRawFields: snapshotPassthroughRawFields({ migrations: [rootMigration] }),
      expectedDurableObjectBindings: [],
      expectedMigrations: [rootMigration],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/migrations/);
  });

  it('accepts exactly the sandbox and live bindings and migrations reconstructed before build', () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': '{}',
      'routes/index.ts': 'export const GET = () => new Response("ok");',
    });
    const state = reconstructExpectedDurableObjectState(
      { sandbox: true },
      root,
      {},
      {
        needsSandbox: true,
        needsLive: true,
      },
    );
    expect(state.bindings).toEqual([
      { name: 'SANDBOX', class_name: 'SandboxV1' },
      { name: 'VOID_LIVE', class_name: 'VoidLiveStreamDurableObject' },
    ]);
    expect(state.migrations).toEqual([
      { tag: 'void-sandbox-v2', new_sqlite_classes: ['SandboxV1'] },
      { tag: 'live-v1', new_sqlite_classes: ['VoidLiveStreamDurableObject'] },
    ]);
    const emitted = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      durable_objects: { bindings: state.bindings },
      migrations: state.migrations,
    });
    expect(
      verifyGeneratedDeployConfig(emitted, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: { kvNamespaces: [], queues: [] },
        passthroughRawFields: snapshotPassthroughRawFields({}),
        expectedDurableObjectBindings: state.bindings,
        expectedMigrations: state.migrations,
      }),
    ).toEqual({ ok: true });
  });

  it('preserves pre-build Durable Object bindings and migrations without duplicating sandbox state', () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': '{}',
      'routes/index.ts': 'export const GET = () => new Response("ok");',
    });
    const rootConfig = {
      durable_objects: {
        bindings: [
          { name: 'ROOM', class_name: 'Room' },
          { name: 'SANDBOX', class_name: 'SandboxV1' },
        ],
      },
      migrations: [
        { tag: 'room-v1', new_sqlite_classes: ['Room'] },
        { tag: 'void-sandbox-v2', new_sqlite_classes: ['SandboxV1'] },
      ],
    };
    const state = reconstructExpectedDurableObjectState({ sandbox: true }, root, rootConfig, {
      needsSandbox: true,
      needsLive: false,
    });
    expect(state.bindings).toEqual(rootConfig.durable_objects.bindings);
    expect(state.migrations).toEqual(rootConfig.migrations);
  });

  // --- Destructive Durable Object migrations (a build-injected delete/rename/transfer) ---

  it('fails closed when the build injects a migration with deleted_classes absent from root', () => {
    // A build appends a `{tag, deleted_classes:["ProdDO"]}` migration; `wrangler deploy` would run it
    // and DELETE the production Durable Object's data. The root declared no such migration.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['Sandbox'] },
        { tag: 'evil', deleted_classes: ['ProdDO'] },
      ],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/destructive/);
    expect(result.reason).toMatch(/evil/);
  });

  it('fails closed for each destructive migration key the build could inject', () => {
    for (const key of [
      'deleted_classes',
      'renamed_classes',
      'transferred_classes',
      'transferred_classes_from_script',
    ] as const) {
      const root = deployConfigProject({
        account_id: 'acc123',
        name: 'myapp',
        migrations: [{ tag: 'x', [key]: ['ProdDO'] }],
      });
      const result = verifyGeneratedDeployConfig(root, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: { kvNamespaces: [], queues: [] },
        passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
        passthroughRawFields: snapshotPassthroughRawFields({}),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/destructive/);
    }
  });

  it("passes Void's own creation-only migrations (new_sqlite_classes) — never inspected", () => {
    // Void emits migrations carrying only creation keys; those are never checked against root, so an
    // app whose root declared no `migrations` still deploys cleanly.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      migrations: [{ tag: 'void-sandbox-v1', new_sqlite_classes: ['Sandbox'] }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields({}),
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes a root-declared destructive migration emitted byte-identical (a legit rename)', () => {
    // A user's own checked-in destructive migration is pinned from the pre-build root and survives
    // the build byte-for-byte, so it passes — only an entry ABSENT from root is rejected.
    const rootConfig = {
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['Room'] },
        { tag: 'v2', renamed_classes: [{ from: 'Room', to: 'ChatRoom' }] },
      ],
    };
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp', ...rootConfig });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
    });
    expect(result).toEqual({ ok: true });
  });

  // --- FALSE-POSITIVE LOCK: the full kitchen-sink shape passes WITH the raw-field pin active ---

  it('passes the full kitchen-sink shape with the whole-object + DO + ai pins active', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      ...KITCHEN_SINK_NON_ID_BINDINGS,
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: ['jobs'] },
      bindingIdentitySnapshot: snapshotBindingIdentities({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      }),
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(KITCHEN_SINK_NON_ID_BINDINGS),
      passthroughRawFields: snapshotPassthroughRawFields(KITCHEN_SINK_NON_ID_BINDINGS),
    });
    expect(result).toEqual({ ok: true });
  });

  // --- Container applications: a bare `wrangler deploy` PROVISIONS a container application from the
  // emitted `containers` array (billable, runs the image), so an injected / dropped / retargeted
  // container must fail closed. The expected set is reconstructed pre-build and passed in. ---

  const SANDBOX_CONTAINER = {
    name: 'void-sandbox',
    class_name: 'Sandbox',
    image: '/abs/node_modules/@cloudflare/sandbox/Dockerfile',
  };

  it('fails closed when the build RETARGETS the sandbox container image', () => {
    // The Void `Sandbox` DO + migration are legit, but the emitted container's `image` was rewritten
    // to an attacker image — `wrangler deploy` would roll out the attacker image.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      containers: [{ ...SANDBOX_CONTAINER, image: '/attacker/Dockerfile' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedContainers: [SANDBOX_CONTAINER],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Sandbox/);
    expect(result.reason).toMatch(/retargeted/);
  });

  it('fails closed when the build INJECTS a container into a no-sandbox app', () => {
    // The source needs no sandbox (expected set empty), yet the artifact injects a container
    // application alongside an otherwise-accepted local DO + creation-only migration.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      containers: [{ name: 'evil', class_name: 'Evil', image: '/attacker/Dockerfile' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedContainers: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Evil/);
    expect(result.reason).toMatch(/injected/);
  });

  it('fails closed when the build DROPS the expected sandbox container', () => {
    // The source needs the sandbox (expected set has one container), but the emitted `containers`
    // field is absent — read defensively as empty, so the drop is caught.
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedContainers: [SANDBOX_CONTAINER],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Sandbox/);
    expect(result.reason).toMatch(/dropped/);
  });

  it('passes when the emitted sandbox container matches the reconstruction exactly', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      containers: [SANDBOX_CONTAINER],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedContainers: [SANDBOX_CONTAINER],
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes a no-sandbox app whose emitted containers field is absent (both-empty)', () => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedContainers: [],
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes a root-declared container preserved verbatim in the emitted config', () => {
    // A user's own container (present in the root wrangler config, spread verbatim by the build)
    // survives — including an optional field — while the drift checks stay quiet.
    const rootContainer = {
      name: 'my-app',
      class_name: 'MyApp',
      image: './Dockerfile',
      instance_type: 'standard',
    };
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      containers: [rootContainer],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedContainers: [rootContainer],
    });
    expect(result).toEqual({ ok: true });
  });

  // --- Cron Triggers: a bare `wrangler deploy` reading `dist/ssr/wrangler.json` INSTALLS the
  // worker's Cron Triggers from the emitted `triggers.crons` array, so an injected / dropped /
  // retargeted schedule must fail closed. The expected schedules are reconstructed pre-build from
  // the SAME `scanJobsSync` scan and compared as an order-independent, count-aware multiset. ---

  it('fails closed when the build INJECTS a cron trigger schedule the source never declared', () => {
    // A no-cron app (expected empty) whose emitted config carries a schedule — attacker code would
    // run on a billable schedule the credentialed `wrangler deploy` installs.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      triggers: { crons: ['* * * * *'] },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedCrons: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\* \* \* \* \*/);
    expect(result.reason).toMatch(/injected/);
  });

  it('fails closed when the build DROPS a cron trigger schedule the source declared', () => {
    // The source declares a schedule (expected has one), but the emitted `triggers` is absent — the
    // worker would silently lose the scheduled behavior the source asked for.
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedCrons: ['0 0 * * *'],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/0 0 \* \* \*/);
    expect(result.reason).toMatch(/dropped/);
  });

  it('fails closed when the build RETARGETS a cron trigger schedule', () => {
    // The source declares `0 0 * * *` (daily), but the emitted schedule is `* * * * *` (every
    // minute) — caught as a drop of the old string plus an injection of the new one.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      triggers: { crons: ['* * * * *'] },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedCrons: ['0 0 * * *'],
    });
    expect(result.ok).toBe(false);
    // The unexpected new schedule is reported first (the injection check runs before the drop check).
    expect(result.reason).toMatch(/injected/);
  });

  it('passes when the emitted schedules multiset-equal the expected set in a different order', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      triggers: { crons: ['0 12 * * *', '0 0 * * *', '*/5 * * * *'] },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedCrons: ['*/5 * * * *', '0 0 * * *', '0 12 * * *'],
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes a no-cron app whose emitted triggers field is absent (both-empty)', () => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedCrons: [],
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes a no-cron app whose emitted triggers is the empty object the CF plugin materializes', () => {
    // A real no-cron build emits `triggers: {}` (the CF plugin materializes the empty object) rather
    // than omitting the field — the defensive read treats a `crons`-less object as no schedules, so
    // it stays symmetric-empty instead of false-positiving.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      triggers: {},
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      expectedCrons: [],
    });
    expect(result).toEqual({ ok: true });
  });
});

// The id-bearing binding identities are pinned after provisioning and before the untrusted
// build. A build can only edit files, so the remote migrate and the emitted-config check
// compare against that pre-build snapshot rather than the (rewritable) root config.

describe('runCloudflareDeploy — id-bearing binding identity pin', () => {
  /** The deploy pointer + emitted top-level config the CF plugin leaves behind after a build. */
  function writeEmittedDeployArtifact(root: string, generated: Record<string, unknown>): void {
    mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(
      join(root, '.wrangler', 'deploy', 'config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
    );
    writeFileSync(join(root, 'dist', 'ssr', 'wrangler.json'), JSON.stringify(generated));
  }

  /** Read → mutate → rewrite the root wrangler.jsonc, standing in for a tampering build plugin. */
  function rewriteRootConfig(
    root: string,
    mutate: (config: Record<string, unknown>) => void,
  ): void {
    const configPath = join(root, 'wrangler.jsonc');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    mutate(config);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  /** The emitted top-level config a non-tampered build of PROVISIONED_D1 would leave. */
  const EMITTED_D1 = {
    account_id: 'acc123',
    name: 'myapp',
    d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
  };

  it('fails closed BEFORE the remote migrate when the build rewrites the D1 database_id', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => {
        // Keep binding + database_name + migrations_dir; swap ONLY the id — the token still
        // resolves, so wrangler would migrate a DIFFERENT same-account database.
        rewriteRootConfig(root, (c) => {
          (c.d1_databases as Array<Record<string, unknown>>)[0].database_id = OTHER_D1_ID;
        });
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: OTHER_D1_ID }],
        });
      },
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // No `d1 migrations apply` / `list` ran against the swapped database, and nothing deployed.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed at the emitted-config check when the build rewrites the D1 id in BOTH the root config and the artifact', async () => {
    // No checked-in migrations, so only the emitted-config check can catch it. A consistent
    // rewrite would fool a post-build root re-read; the pre-build snapshot still catches it.
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => {
        rewriteRootConfig(root, (c) => {
          (c.d1_databases as Array<Record<string, unknown>>)[0].database_id = OTHER_D1_ID;
        });
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: OTHER_D1_ID }],
        });
      },
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed at the emitted-config check when the build consistently rewrites a KV namespace id', async () => {
    // KV is pinned the same way as D1.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.KV.get('k') ?? c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'myapp',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'myapp-db',
              database_id: REAL_D1_ID,
              migrations_dir: './db/migrations',
            },
          ],
          kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
        },
        null,
        2,
      ),
    });
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => {
        rewriteRootConfig(root, (c) => {
          (c.kv_namespaces as Array<Record<string, unknown>>)[0].id = OTHER_KV_ID;
        });
        writeEmittedDeployArtifact(root, {
          account_id: 'acc123',
          name: 'myapp',
          d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
          kv_namespaces: [{ binding: 'KV', id: OTHER_KV_ID }],
        });
      },
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('still rejects a build that swaps the account_id in the emitted config (account pin intact)', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => writeEmittedDeployArtifact(root, { ...EMITTED_D1, account_id: 'other-acc' }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('passes a normal deploy whose artifact carries supported non-id bindings', async () => {
    // The pinned DB id is unchanged and the artifact carries the non-id bindings this source emits.
    // `queues/jobs.ts` makes `jobs` a derived queue, and `routes/ai.ts` authorizes the AI binding.
    const root = d1Project(PROVISIONED_D1, {
      ...INIT_MIGRATION,
      'queues/jobs.ts': 'export default {};',
      'routes/ai.ts':
        "import { ai } from 'void/ai';\nexport const GET = () => ai.run('@cf/x', {});",
    });
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        // No sandbox, Durable Objects or crons in this source, so drop those fixture fields.
        writeEmittedDeployArtifact(root, {
          ...KITCHEN_SINK_NON_ID_BINDINGS,
          durable_objects: undefined,
          migrations: undefined,
          containers: undefined,
          triggers: undefined,
          ...EMITTED_D1,
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });

  it('passes when a user-declared EXTRA id-bearing binding is present pre-build and unchanged', async () => {
    // A hand-declared, non-desired EXTRA_KV is in the root config BEFORE the build (so the widened
    // snapshot pins it) and the build leaves it untouched — the deploy must NOT be blocked.
    const root = d1Project({
      ...PROVISIONED_D1,
      kv_namespaces: [{ binding: 'EXTRA_KV', id: REAL_KV_ID }],
    });
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          kv_namespaces: [{ binding: 'EXTRA_KV', id: REAL_KV_ID }],
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });

  it('fails closed at the emitted-config check when the build ADDS an id-bearing binding absent from the snapshot', async () => {
    // The snapshot has only DB; the build injects an EXTRA_KV the deployed worker would gain.
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          kv_namespaces: [{ binding: 'EXTRA_KV', id: OTHER_KV_ID }],
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The deploy seam was NOT invoked — the injected binding never reached `wrangler deploy`.
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed at the emitted-config check when the build injects a services binding', async () => {
    // The root has no services; the build injects a binding to another same-account worker.
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          services: [{ binding: 'EVIL', service: 'someone-elses-worker' }],
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The deploy seam was NOT invoked — the injected binding never reached `wrangler deploy`.
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed at the emitted-config check when the build injects a queue not in the desired set', async () => {
    // No queues/ source, so desired.queues is empty.
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          queues: { producers: [{ binding: 'Q', queue: 'exfil' }], consumers: [] },
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('passes when a user hand-declared passthrough binding (services) is present pre-build and unchanged', async () => {
    const root = d1Project({
      ...PROVISIONED_D1,
      services: [{ binding: 'MY_SVC', service: 'my-other-worker' }],
    });
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          services: [{ binding: 'MY_SVC', service: 'my-other-worker' }],
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });

  it('fails closed at the emitted-config check when the build injects an unsafe object', async () => {
    // Proves the whole-object pin is wired end to end from the pre-build root config.
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          unsafe: { metadata: { bindings: [{ name: 'X', type: 'service', service: 'evil' }] } },
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed when the build modifies the wrangler uploader (before any credentialed run)', async () => {
    // The post-build uploader hash differs from the pre-build one, so no credentialed run happens.
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    let built = false;
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => {
        built = true;
        writeEmittedDeployArtifact(root, EMITTED_D1);
      },
      verifyDeployConfig: verifyGeneratedDeployConfig,
      hashWranglerUploader: () => (built ? 'after-build-tampered' : 'before-build-clean'),
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed when the wrangler uploader cannot be hashed (unverifiable binary)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => writeEmittedDeployArtifact(root, EMITTED_D1),
      verifyDeployConfig: verifyGeneratedDeployConfig,
      hashWranglerUploader: () => undefined,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed BEFORE the remote D1 migrate when a post-build step mutates the uploader', async () => {
    // Project code after the build (modelled by the migration gate) overwrites the uploader; the
    // re-check right before `d1 migrations apply` catches it.
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    let uploaderTampered = false;
    const { deps, wranglerArgs, exitCalls } = harness({
      hashWranglerUploader: () => (uploaderTampered ? 'tampered' : 'clean'),
      assertMigrationsDeployable: () => {
        uploaderTampered = true;
      },
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Neither the credentialed remote migrate nor the deploy ran.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed BEFORE the deploy when a post-build step mutates the uploader (no-migration app)', async () => {
    // Without migrations the upload is the first credentialed run after the build.
    const root = d1Project(PROVISIONED_D1);
    let uploaderTampered = false;
    const { deps, wranglerArgs, exitCalls } = harness({
      hashWranglerUploader: () => (uploaderTampered ? 'tampered' : 'clean'),
      assertMigrationsDeployable: () => {
        uploaderTampered = true;
      },
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('proceeds through every credentialed spawn when the uploader stays unchanged', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => writeEmittedDeployArtifact(root, EMITTED_D1),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'list')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });

  it('fails closed BEFORE whoami when the pre-build env-schema probe mutates the uploader', async () => {
    // The uploader baseline is taken before the env-schema probe runs project code, so a probe
    // that overwrites the uploader is caught before `whoami`, the first credentialed run.
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    let probed = false;
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      // The env-schema probe stands in for pre-build project code overwriting the bundle.
      resolveSchemaFacts: (() => {
        probed = true;
        return okSchemaFacts();
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
      hashWranglerUploader: () => (probed ? 'tampered-by-probe' : 'clean-at-start'),
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // whoami never ran — the deploy refused before the first credentialed call.
    expect(trace).not.toContain('wrangler:whoami');
    expect(wranglerArgs.some((a) => a[0] === 'whoami')).toBe(false);
  });

  it('fails closed BEFORE the provisioner when the uploader changes after whoami (--provision)', async () => {
    // The uploader changes after `whoami`; the re-check right before provisioning catches it.
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    let tampered = false;
    const { deps, trace, exitCalls } = harness({
      hashWranglerUploader: () => (tampered ? 'tampered' : 'clean'),
      // whoami is the last step before provision; flip the bundle as it returns so the assert
      // immediately before the provision call catches it.
      runWrangler: operationFixture((args) => {
        trace.push(`wrangler:${args[0]}`);
        if (args[0] === 'whoami') {
          tampered = true;
          return { ...cleanExit, stdout: '{"loggedIn":true,"accounts":[]}' };
        }
        return cleanExit;
      }),
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare', provision: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Reached whoami, but refused before provisioning ran.
    expect(trace).toContain('wrangler:whoami');
    expect(trace).not.toContain('provision');
  });
});

// Probes that run project code around the build may rewrite the root config: the pre-build
// env-schema probe before any credentialed command, and the post-build emitted-var probe before
// the secrets gate resolves the worker name.

describe('runCloudflareDeploy — config laundering by a build-adjacent probe', () => {
  /** Read → mutate → rewrite the root wrangler.jsonc, standing in for a tampering probe. */
  function rewriteRootConfig(
    root: string,
    mutate: (config: Record<string, unknown>) => void,
  ): void {
    const configPath = join(root, 'wrangler.jsonc');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    mutate(config);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  // --- The pre-build probe rewrites the root config ---

  it('fails closed before whoami when the pre-build probe SWAPS a binding id', async () => {
    // The env-schema probe rewrites the provisioned DB id in the root config. Reject it before the
    // config reaches any authenticated Cloudflare command or becomes a trusted build baseline.
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      resolveSchemaFacts: (() => {
        rewriteRootConfig(root, (c) => {
          (c.d1_databases as Array<Record<string, unknown>>)[0].database_id = OTHER_D1_ID;
        });
        return okSchemaFacts();
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('wrangler:whoami');
    expect(trace).not.toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('automatic provisioning rejects a probe rewrite before creating resources', async () => {
    const root = d1Project({ account_id: 'acc123', name: 'myapp' });
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      resolveSchemaFacts: (() => {
        rewriteRootConfig(root, (c) => {
          c.services = [{ binding: 'EVIL', service: 'someone-elses-worker' }];
        });
        return okSchemaFacts();
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('wrangler:whoami');
    expect(trace).not.toContain('provision');
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  // --- The post-build probe rewrites the pinned worker name ---

  // One required secret absent from the emitted vars, so the real gate reaches the remote list.
  function requiredSecretFacts(): EnvSchemaProbeResult {
    return okSchemaFacts({
      hasSchema: true,
      serverKeys: ['STRIPE_KEY'],
      requiredKeys: ['STRIPE_KEY'],
    });
  }

  // The real gate with a remote secret list that reports the secret present for any worker, so
  // only the worker-name check can stop a deploy against the wrong worker.
  const dischargeWithSecretPresent = ((
    ctx: SelfHostEnvContext,
    opts: Parameters<typeof dischargeSelfHostEnvContext>[1],
  ) =>
    dischargeSelfHostEnvContext(ctx, {
      ...opts,
      runWrangler: operationFixture(() => ({
        stdout: JSON.stringify([{ name: 'STRIPE_KEY', type: 'secret_text' }]),
        stderr: '',
        status: 0,
      })),
    })) as CloudflareDeployDeps['dischargeSelfHostEnv'];

  it('fails closed BEFORE deploy when the post-build probe rewrites the pinned worker name', async () => {
    // The deploy pinned "myapp"; the probe renames the root config worker to "evil-worker".
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      resolveSchemaFacts: (() =>
        requiredSecretFacts()) as CloudflareDeployDeps['resolveSchemaFacts'],
      validateEmittedVars: (async () => {
        rewriteRootConfig(root, (c) => {
          c.name = 'evil-worker';
        });
        return { kind: 'invalid-keys', invalidKeys: [] };
      }) as CloudflareDeployDeps['validateEmittedVars'],
      dischargeSelfHostEnv: dischargeWithSecretPresent,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The build ran (the rewrite is post-build) but nothing deployed.
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('passes when the post-build probe leaves the pinned worker name intact', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      resolveSchemaFacts: (() =>
        requiredSecretFacts()) as CloudflareDeployDeps['resolveSchemaFacts'],
      dischargeSelfHostEnv: dischargeWithSecretPresent,
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });
});

describe('runCloudflareDeploy — env-schema probe loads lazily', () => {
  const deploySource = readdirSync(join(import.meta.dirname, '../../src/cli'))
    .filter((file) => file === 'deploy.ts' || (file.startsWith('deploy-') && file.endsWith('.ts')))
    .map((file) => readFileSync(join(import.meta.dirname, '../../src/cli', file), 'utf-8'))
    .join('\n');

  it('loads the env-schema probe via a dynamic import() (never a static module-scope import)', () => {
    // deploy.ts must only `import type` from the probe at module scope; the runtime helper
    // loads via dynamic import() inside the fork, so a managed deploy never pulls the probe in.
    const staticImports = [
      ...deploySource.matchAll(/^import\s+([^']*?)\s+from\s+'\.\/env-schema-probe\.ts';/gm),
    ];
    for (const [, clause] of staticImports) {
      expect(clause.startsWith('type')).toBe(true);
    }
    expect(deploySource).toMatch(/await import\('\.\/env-schema-probe\.ts'\)/);
  });

  it('the env-schema probe imports env-validation only dynamically and no backend statically', () => {
    // The probe is imported (dynamically) during a self-host deploy, but a plain LIBRARY import of
    // it (the parent-side helper) must not eagerly evaluate env-validation (which pulls Vite / the
    // env stack), and it must never statically pull Vite / provision / Better Auth / proper-lockfile
    // into any bundle.
    const probeSource = readFileSync(
      join(import.meta.dirname, '../../src/cli/env-schema-probe.ts'),
      'utf-8',
    );
    // env-validation is loaded dynamically only — its static import is TYPE-only.
    const staticEnvValidation = new RegExp(
      "^import\\s+(?!type\\b)[^;]*?\\s+from\\s+'\\./env-validation\\.ts';",
      'gm',
    );
    expect(probeSource).not.toMatch(staticEnvValidation);
    expect(probeSource).toContain("await import('./env-validation.ts')");
    // No static backend imports at all (Vite / provision / Better Auth / proper-lockfile).
    expect(probeSource).not.toMatch(/from\s+'vite'/);
    expect(probeSource).not.toMatch(/from\s+'\.\/provision\.ts'/);
    expect(probeSource).not.toMatch(/better-auth/);
    expect(probeSource).not.toMatch(/proper-lockfile/);
  });
});

// ---------------------------------------------------------------------------
// Framework-class guard: only Class-A framework SSR coheres with
// this backend (full Void plugin stack + CF Vite plugin). Class B/C get a
// lighter Void composition that emits no worker artifact here — reject early.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — framework artifact guard', () => {
  it('deploys a Class B/C framework through its prepared Worker output', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'skapp',
        dependencies: { '@sveltejs/kit': '2.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'skapp' }, null, 2),
    });
    let requiredSecretNames: ReadonlyArray<string> | undefined;
    const { deps, trace, exitCalls } = harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          serverKeys: ['API_TOKEN'],
          requiredKeys: ['API_TOKEN'],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      prepareFrameworkArtifact: (async (options) => {
        trace.push('prepare-framework');
        requiredSecretNames = options.requiredSecretNames;
      }) as CloudflareDeployDeps['prepareFrameworkArtifact'],
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(trace).toContain('build');
    expect(trace).toContain('prepare-framework');
    expect(requiredSecretNames).toEqual(['API_TOKEN']);
    expect(trace).toContain('wrangler:deploy');
  });

  it('deploys a Class-A framework through its Cloudflare Vite artifact', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'tsapp',
        dependencies: { '@tanstack/react-start': '1.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'tsapp' }, null, 2),
    });
    const { deps, trace, exitCalls } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
  });

  it('persists framework queue bindings before building', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'skapp',
        dependencies: { '@sveltejs/kit': '2.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'queues/email.ts': [
        'export const maxBatchSize = 25;',
        'export const maxBatchTimeout = 10;',
        'export const maxRetries = 4;',
        'export const retryDelay = 30;',
        'export default async function email() {}',
      ].join('\n'),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'skapp' }, null, 2),
    });
    const { deps } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc'))).toMatchObject({
      queues: {
        producers: [{ binding: 'QUEUE_EMAIL', queue: 'email' }],
        consumers: [
          {
            queue: 'email',
            max_batch_size: 25,
            max_batch_timeout: 10,
            max_retries: 4,
            retry_delay: 30,
          },
        ],
      },
    });
  });

  it('carries removed framework consumers through activation and acknowledges cleanup', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'skapp',
        dependencies: { '@sveltejs/kit': '2.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'queues/email.ts': 'export default async function email() {}',
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'skapp' }, null, 2),
    });
    const cleanupSnapshots: Array<ReadonlyArray<string> | undefined> = [];
    const { deps } = harness({
      activateVersion: async (options) => {
        cleanupSnapshots.push(options.queueConsumerCleanup);
        if (cleanupSnapshots.length === 2) {
          return {
            ok: false,
            reason: 'triggers-failed',
            status: 1,
            rollback: 'succeeded',
          };
        }
        return {
          ok: true,
          versionId: '22222222-2222-4222-8222-222222222222',
          previewUrl: 'https://preview.example.workers.dev',
          previousVersionId: null,
        };
      },
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    rmSync(join(root, 'queues/email.ts'));
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(readWranglerManagedQueueCleanupCandidates(join(root, 'wrangler.jsonc'))).toEqual([
      'email',
    ]);
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(cleanupSnapshots).toEqual([['email'], ['email'], ['email']]);
    expect(readWranglerManagedQueueCleanupCandidates(join(root, 'wrangler.jsonc'))).toEqual([]);
  });

  it('prepares a standalone framework Worker with cron and queue handlers', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'skapp',
        dependencies: { '@sveltejs/kit': '2.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': `{
  // keep this comment
  "name": "skapp",
  "account_id": "acc123",
  "compatibility_flags": ["custom_flag"],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }]
}\n`,
      '.svelte-kit/cloudflare/_worker.js':
        'export default { fetch() { return new Response("ok") } };\n',
      '.svelte-kit/cloudflare/_app/immutable/app.js': 'console.log("client");\n',
      'crons/hourly.ts': [
        'import { defineScheduled } from "void";',
        'export const cron = "0 * * * *";',
        'export default defineScheduled(async function hourly() {});',
      ].join('\n'),
      'queues/email.ts': [
        'import { defineQueue } from "void";',
        'export default defineQueue(async function email() {});',
      ].join('\n'),
    });

    await prepareCloudflareFrameworkArtifact({
      root,
      configPath: join(root, 'wrangler.jsonc'),
      accountId: 'acc123',
      workerName: 'skapp',
      voidConfig: readConfig(root),
      framework: { name: 'sveltekit', class: 'b' },
      preset: FRAMEWORK_PRESETS.sveltekit,
      requiredSecretNames: ['API_TOKEN'],
      ai: { binding: 'AI' },
    });

    const wrapper = readFileSync(join(root, '.svelte-kit/cloudflare/_worker.js'), 'utf-8');
    expect(wrapper).toContain('import original from "./__original.js";');
    expect(wrapper).toContain('scheduled: handleScheduled');
    expect(wrapper).toContain('queue: handleQueue');
    expect(existsSync(join(root, '.svelte-kit/cloudflare/__void_handlers.mjs'))).toBe(true);
    expect(readFileSync(join(root, '.svelte-kit/cloudflare/.assetsignore'), 'utf-8')).toContain(
      '__void_handlers.mjs',
    );
    const config = parseRootWranglerConfig(join(root, 'wrangler.jsonc'));
    expect(config).toMatchObject({
      main: '.svelte-kit/cloudflare/_worker.js',
      no_bundle: false,
      compatibility_flags: ['custom_flag', 'nodejs_als'],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      assets: {
        directory: '.svelte-kit/cloudflare',
        binding: 'ASSETS',
        run_worker_first: true,
      },
      triggers: { crons: ['0 * * * *'] },
      secrets: { required: ['API_TOKEN'] },
      ai: { binding: 'AI' },
    });
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toContain('// keep this comment');
  });

  it('prepares Class A wrapper handlers without replacing its generated config pointer', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'tanstack-app',
        dependencies: { '@tanstack/react-start': '1.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'tanstack-app' }),
      'dist/server/index.js': 'export default { fetch() { return new Response("ok") } };\n',
      'dist/client/app.js': 'console.log("client");\n',
      '.wrangler/deploy/config.json': '{"configPath":"../../../dist/server/wrangler.json"}\n',
      'crons/hourly.ts': [
        'import { defineScheduled } from "void";',
        'export const cron = "0 * * * *";',
        'export default defineScheduled(async function hourly() {});',
      ].join('\n'),
      'queues/email.ts': [
        'import { defineQueue } from "void";',
        'export default defineQueue(async function email() {});',
      ].join('\n'),
    });
    const pointerBefore = readFileSync(join(root, '.wrangler/deploy/config.json'), 'utf-8');

    await prepareCloudflareFrameworkArtifact({
      root,
      configPath: join(root, 'wrangler.jsonc'),
      accountId: 'acc123',
      workerName: 'tanstack-app',
      voidConfig: readConfig(root),
      framework: { name: 'tanstack-start', class: 'a' },
      preset: FRAMEWORK_PRESETS['tanstack-start'],
    });

    expect(readFileSync(join(root, '.wrangler/deploy/config.json'), 'utf-8')).toBe(pointerBefore);
    expect(readFileSync(join(root, 'dist/server/index.js'), 'utf-8')).toContain(
      'scheduled: handleScheduled',
    );
    expect(readFileSync(join(root, 'dist/server/index.js'), 'utf-8')).toContain(
      'queue: handleQueue',
    );
    const handlers = readFileSync(join(root, 'dist/server/__void_handlers.mjs'), 'utf-8');
    expect(handlers).not.toContain('@napi-rs/keyring');
    expect(handlers).not.toContain('@cloudflare/vite-plugin');
    expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc'))).not.toHaveProperty('main');
  });

  it.each([
    'tanstack-start',
    'react-router',
    'vinext-app',
    'vinext-pages',
    'sveltekit',
    'nuxt',
    'analog',
    'astro',
  ])(
    'adds ISR to the direct Cloudflare %s worker when revalidation is configured',
    async (name) => {
      const preset = FRAMEWORK_PRESETS[name]!;
      const root = makeProject({
        'void.json': JSON.stringify({ routing: { revalidate: { '/news/*': 60 } } }),
        'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'framework-app' }),
        [`${preset.workerDir}/${preset.workerMain}`]:
          'export default { fetch() { return new Response("<html>page</html>", { headers: { "content-type": "text/html" } }); } };',
        [`${preset.assetsDir}/client.js`]: 'console.log("client");',
      });

      await prepareCloudflareFrameworkArtifact({
        root,
        configPath: join(root, 'wrangler.jsonc'),
        accountId: 'acc123',
        workerName: 'framework-app',
        voidConfig: readConfig(root),
        framework: {
          name,
          class: ['tanstack-start', 'react-router', 'vinext-app', 'vinext-pages'].includes(name)
            ? 'a'
            : name === 'sveltekit'
              ? 'b'
              : 'c',
        },
        preset,
      });

      const entry = readFileSync(join(root, preset.workerDir, preset.workerMain), 'utf8');
      expect(entry).toContain('handleFrameworkIsr');
      expect(entry).toContain('from "./__void_isr.mjs"');
      const isrModule = join(root, preset.workerDir, '__void_isr.mjs');
      expect(existsSync(isrModule)).toBe(true);
      expect(readFileSync(isrModule, 'utf8')).not.toMatch(/from ["']@void\//);
      expect(entry).toContain('"/news/*":60');
      expect(entry).toContain('__VOID_ISR_DEPLOYMENT_ID');
      expect(entry).toContain('return original.fetch(request, env, ctx)');
      if (preset.workerDir === preset.assetsDir) {
        expect(readFileSync(join(root, preset.workerDir, '.assetsignore'), 'utf8')).toContain(
          '__void_isr*.mjs',
        );
      }
    },
  );

  // The PostgreSQL and MySQL drivers import workerd's Node modules, as a managed deploy knows.
  it.each([
    ['pg', ['nodejs_als', 'nodejs_compat']],
    ['mysql', ['nodejs_als', 'nodejs_compat']],
    ['d1', ['nodejs_als']],
  ])(
    'gives a %s Nuxt Worker the compatibility flags its database needs',
    async (database, flags) => {
      const preset = FRAMEWORK_PRESETS.nuxt!;
      const root = makeProject({
        'void.json': JSON.stringify(database === 'd1' ? {} : { database }),
        'wrangler.jsonc': JSON.stringify({
          account_id: 'acc123',
          name: 'nuxt-app',
          compatibility_flags: ['nodejs_als'],
        }),
        [`${preset.workerDir}/${preset.workerMain}`]:
          'export default { fetch() { return new Response("page"); } };',
        [`${preset.assetsDir}/client.js`]: 'console.log("client");',
      });
      await prepareCloudflareFrameworkArtifact({
        root,
        configPath: join(root, 'wrangler.jsonc'),
        accountId: 'acc123',
        workerName: 'nuxt-app',
        voidConfig: readConfig(root),
        framework: { name: 'nuxt', class: 'c' },
        preset,
      });
      expect(parseRootWranglerConfig(join(root, 'wrangler.jsonc')).compatibility_flags).toEqual(
        flags,
      );
    },
  );

  it('does not add ISR to a framework worker when routing.isr is false', async () => {
    const preset = FRAMEWORK_PRESETS['tanstack-start']!;
    const root = makeProject({
      'void.json': JSON.stringify({ routing: { revalidate: 60, isr: false } }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'framework-app' }),
      [`${preset.workerDir}/${preset.workerMain}`]:
        'export default { fetch() { return new Response("page"); } };',
      [`${preset.assetsDir}/client.js`]: 'console.log("client");',
    });
    await prepareCloudflareFrameworkArtifact({
      root,
      configPath: join(root, 'wrangler.jsonc'),
      accountId: 'acc123',
      workerName: 'framework-app',
      voidConfig: readConfig(root),
      framework: { name: 'tanstack-start', class: 'a' },
      preset,
    });
    const entry = readFileSync(join(root, preset.workerDir, preset.workerMain), 'utf8');
    expect(entry).not.toContain('handleFrameworkIsr');
  });

  it('fails closed when a framework build omits its Worker or assets', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'nuxt-app', dependencies: { nuxt: '4.0.0' } }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'nuxt-app' }),
    });
    const prepare = () =>
      prepareCloudflareFrameworkArtifact({
        root,
        configPath: join(root, 'wrangler.jsonc'),
        accountId: 'acc123',
        workerName: 'nuxt-app',
        voidConfig: readConfig(root),
        framework: { name: 'nuxt', class: 'c' },
        preset: FRAMEWORK_PRESETS.nuxt,
      });
    await expect(prepare()).rejects.toThrow('did not emit its Worker entry');

    mkdirSync(join(root, '.output/server'), { recursive: true });
    writeFileSync(join(root, '.output/server/index.mjs'), 'export default {};\n');
    await expect(prepare()).rejects.toThrow('did not emit its asset directory');
  });
});

// ---------------------------------------------------------------------------
// Stale deploy pointer: the pointer is deleted before building, so a
// build that emits no fresh one (auto-static / Class B/C) can never upload old
// code — the verification fails closed on the missing pointer.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — stale deploy pointer', () => {
  it('fails closed (no deploy) when the build emits no fresh pointer over a stale one', async () => {
    const root = d1Project(PROVISIONED_D1);
    // Plant a STALE pointer + target that WOULD pass the account/name identity check.
    mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'ssr', 'wrangler.json'),
      JSON.stringify({ account_id: 'acc123', name: 'myapp' }),
    );
    writeFileSync(
      join(root, '.wrangler', 'deploy', 'config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
    );
    // A build that does NOT re-create the pointer (a non-CF/static build class).
    const { deps, trace, exitCalls } = harness({
      runBuild: () => {
        trace.push('build');
      },
      // Use the REAL verifier so the deleted-then-not-recreated pointer fails closed.
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('wrangler:deploy');
  });
});

// ---------------------------------------------------------------------------
// Env-only account pin: the CF plugin copies account_id only from the
// root config, so the reconciled account is persisted there before the build —
// making the documented CLOUDFLARE_ACCOUNT_ID pin actually reach deploy.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — env-only account pin', () => {
  it('persists CLOUDFLARE_ACCOUNT_ID into the root config and reaches deploy without --provision', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'env-acc-999');
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      // Root config has NO account_id — only the env var pins the account.
      'wrangler.jsonc': JSON.stringify(
        {
          name: 'myapp',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'myapp-db',
              database_id: REAL_D1_ID,
              migrations_dir: './db/migrations',
            },
          ],
        },
        null,
        2,
      ),
    });
    const { deps, trace } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    // Reaches deploy (does not false-stop on a missing generated account_id)...
    expect(trace).toContain('wrangler:deploy');
    // ...because the env pin was persisted into the root config the build reads.
    const written = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')) as {
      account_id?: string;
    };
    expect(written.account_id).toBe('env-acc-999');
  });
});

// ---------------------------------------------------------------------------
// Migrations dir/intent + auth tables
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — migrations dir / count / auth', () => {
  it('carries the sourceDir-aware config-relative migrations_dir into the desired set', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({ sourceDir: 'src' }),
      'src/routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify({ name: 'myapp' }, null, 2),
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1?.migrationsDir).toBe('./src/db/migrations');
  });

  it('runs the drift/journal gate but skips the wrangler apply when a D1 app has no migrations', async () => {
    const root = d1Project(PROVISIONED_D1); // migrations_dir set, but NO .sql files
    const { deps, wranglerArgs, trace } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    // The drift/journal gate runs for every D1 app, but wrangler fails on an empty or absent
    // migrations folder, so the apply/list is skipped.
    expect(trace).toContain('migrate-gate');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toContain('wrangler:deploy');
  });

  it('fails closed for an auth app whose auth tables are not in checked-in migrations', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'authapp' }),
      'void.json': JSON.stringify({ auth: {} }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'authapp',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'authapp-db',
              database_id: REAL_D1_ID,
              migrations_dir: './db/migrations',
            },
          ],
        },
        null,
        2,
      ),
    });
    // Simulate the build's generated auth schema (ground truth) requiring a `user` table, with
    // NO checked-in migration to create it → the REAL post-build auth check fails closed
    // (applying the migrations to in-memory SQLite leaves `user` absent).
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['email'] }]);
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      validateAuthMigrations: validateAuthMigrationSchema,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The auth check runs POST-build (against ground truth); it blocks the remote migrate + deploy.
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('lets an auth app proceed when its migrations produce the required auth schema', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'authapp' }),
      'void.json': JSON.stringify({ auth: {} }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'db/migrations/0000_auth.sql': `CREATE TABLE "user" (id text primary key);`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'authapp',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'authapp-db',
              database_id: REAL_D1_ID,
              migrations_dir: './db/migrations',
            },
          ],
        },
        null,
        2,
      ),
    });
    // The schema validator is stubbed (harness default) — dedicated tests exercise the real
    // schema check; here we assert the guard lets a satisfied auth app proceed to deploy.
    const { deps, trace } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('auth-secret');
    expect(trace.indexOf('auth-secret')).toBeLessThan(trace.indexOf('wrangler:d1'));
    expect(trace).toContain('wrangler:deploy');
  });

  it('asks to repair invalid existing SQL instead of regenerating from its snapshot', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'authapp' }),
      'void.json': JSON.stringify({ auth: {} }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'db/migrations/0000_auth.sql': 'CREATE TABLE session (id TEXT PRIMARY KEY);',
      'db/migrations/0001_auth.sql': 'SELECT "impersonatedBy" FROM session;',
      'wrangler.jsonc': JSON.stringify({
        account_id: 'acc123',
        name: 'authapp',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'authapp-db',
            database_id: REAL_D1_ID,
            migrations_dir: './db/migrations',
          },
        ],
      }),
    });
    writeAuthSchemaArtifact(root, [{ name: 'session', fields: ['impersonatedBy'] }]);
    const { deps, wranglerArgs, trace } = harness({
      validateAuthMigrations: validateAuthMigrationSchema,
    });
    const output = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('0001_auth.sql'));
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('Repair the unapplied migration'),
      );
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('cannot repair existing invalid SQL'),
      );
      expect(wranglerArgs.some((args) => args[0] === 'd1')).toBe(false);
      expect(trace).not.toContain('wrangler:deploy');
    } finally {
      output.mockRestore();
    }
  });

  it('allows the DO bootstrap when first-secret provisioning proved the Worker was absent', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'authapp' }),
      'void.json': JSON.stringify({ auth: {} }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'db/migrations/0000_auth.sql': `CREATE TABLE "user" (id text primary key);`,
      'wrangler.jsonc': JSON.stringify({
        account_id: 'acc123',
        name: 'authapp',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'authapp-db',
            database_id: REAL_D1_ID,
            migrations_dir: './db/migrations',
          },
        ],
      }),
    });
    let allowed = false;
    const { deps } = harness({
      ensureAuthSecret: async () => ({ created: true, workerWasMissing: true }),
      activateVersion: async (options) => {
        allowed = options.allowFirstDeploymentBootstrap === true;
        return {
          ok: true,
          versionId: '22222222-2222-4222-8222-222222222222',
          previewUrl: 'https://preview.example.workers.dev',
          previousVersionId: null,
        };
      },
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(allowed).toBe(true);
  });
});

// The auth schema is checked by applying the migrations to an in-memory SQLite database.

describe('assertMigrationsProduceAuthSchema', () => {
  /** A required column with no constraint attached — presence is all that is asserted. */
  const col = (column: string): { column: string; unique: boolean } => ({ column, unique: false });

  const required = [
    { table: 'user', columns: [col('id'), col('email'), col('name')] },
    { table: 'session', columns: [col('id'), col('userId')] },
  ];

  it('passes when every required table + column is produced by the migrations', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE user (id text primary key, email text, name text);\nCREATE TABLE session (id text primary key, userId text);',
        },
      ],
      required,
    );
    // no throw
  });

  it('rejects when a required table is missing (token search would miss a renamed/commented one)', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [{ name: '0000.sql', sql: 'CREATE TABLE user (id text, email text, name text);' }],
        required,
      ),
    ).rejects.toThrow(/session/);
  });

  it('rejects when a required column is missing (only presence of the table is not enough)', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql: 'CREATE TABLE user (id text, email text, name text);\nCREATE TABLE session (id text);',
          },
        ],
        required,
      ),
    ).rejects.toThrow(/session.*userId|userId/);
  });

  it('is not fooled by a CREATE TABLE inside a comment or string (real apply, not a regex)', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql: `CREATE TABLE user (id text, email text, name text);\n-- CREATE TABLE session (id text, userId text);`,
          },
        ],
        required,
      ),
    ).rejects.toThrow(/session/);
  });

  it('rejects when a migration cannot be applied to a fresh SQLite database', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [{ name: '0000.sql', sql: 'THIS IS NOT VALID SQL;' }],
        required,
      ),
    ).rejects.toThrow(/could not be applied/);
  });

  // -------------------------------------------------------------------------
  // Constraints, not just names. Void ships no auth migration scaffolder, so a
  // hand-written `db/schema.ts` + `void db generate` can produce every correct
  // NAME while omitting Drizzle's opt-in `.unique()` / `.references()`.
  // -------------------------------------------------------------------------

  /** `user.email` unique + `session.userId` → `user.id`, as the real build emits them. */
  const constrained = [
    {
      table: 'user',
      columns: [col('id'), { column: 'email', unique: true }, col('name')],
    },
    {
      table: 'session',
      columns: [
        col('id'),
        { column: 'userId', unique: false, references: { table: 'user', column: 'id' } },
      ],
    },
  ];

  const USER_WITH_UNIQUE_EMAIL =
    'CREATE TABLE "user" (id text primary key, email text UNIQUE, name text);';
  const SESSION_WITH_FK =
    'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user"(id) ON DELETE CASCADE);';

  it('names the offending table and column when the UNIQUE constraint is missing', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
              SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/table "user" is missing a UNIQUE constraint on column\(s\): email/);
  });

  it('accepts a column-level UNIQUE (the spelling Drizzle emits inline)', async () => {
    await assertMigrationsProduceAuthSchema(
      [{ name: '0000.sql', sql: `${USER_WITH_UNIQUE_EMAIL}\n${SESSION_WITH_FK}` }],
      constrained,
    );
  });

  it('accepts a separate CREATE UNIQUE INDEX (the spelling the managed path emits)', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
            'CREATE UNIQUE INDEX "user_email_unique_idx" ON "user" (email);\n' +
            SESSION_WITH_FK,
        },
      ],
      constrained,
    );
  });

  it('does not require a particular unique index name', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
            'CREATE UNIQUE INDEX "totally_unrelated_name" ON "user" (email);\n' +
            SESSION_WITH_FK,
        },
      ],
      constrained,
    );
  });

  it('does not accept a NON-unique index as satisfying a UNIQUE requirement', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
              'CREATE INDEX "user_email_idx" ON "user" (email);\n' +
              SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/UNIQUE constraint on column\(s\): email/);
  });

  it('does not accept a COMPOSITE unique index as making the column unique on its own', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
              'CREATE UNIQUE INDEX "user_email_name_idx" ON "user" (email, name);\n' +
              SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/UNIQUE constraint on column\(s\): email/);
  });

  it('rejects when the session foreign key to user is missing', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${USER_WITH_UNIQUE_EMAIL}\n` +
              'CREATE TABLE "session" (id text primary key, userId text);',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(
      /table "session" column "userId" is missing a foreign key referencing "user"\."id"/,
    );
  });

  it('rejects a foreign key that points at the wrong parent table', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${USER_WITH_UNIQUE_EMAIL}\n` +
              'CREATE TABLE "account" (id text primary key);\n' +
              'CREATE TABLE "session" (id text primary key, userId text REFERENCES "account"(id));',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/table "session" column "userId" is missing a foreign key/);
  });

  it('accepts an implicit REFERENCES to the parent primary key (no column named)', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${USER_WITH_UNIQUE_EMAIL}\n` +
            'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user");',
        },
      ],
      constrained,
    );
  });

  it('does not assert the onDelete action (ON DELETE SET NULL still satisfies the reference)', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${USER_WITH_UNIQUE_EMAIL}\n` +
            'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user"(id) ON DELETE SET NULL);',
        },
      ],
      constrained,
    );
  });

  it('does not assert column TYPE (SQLite is dynamically typed — a valid schema must not be rejected)', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text primary key, email blob UNIQUE, name numeric);\n' +
            SESSION_WITH_FK,
        },
      ],
      constrained,
    );
  });

  it('reports every constraint problem at once, naming each table.column', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
              'CREATE TABLE "session" (id text primary key, userId text);',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/user.*email[\s\S]*session.*userId|session.*userId[\s\S]*user.*email/);
  });

  // -------------------------------------------------------------------------
  // Identifier CASING. SQLite resolves identifiers case-insensitively, but
  // `sqlite_master.name` and every PRAGMA echo back the casing the migration
  // DECLARED. A migration written as `CREATE TABLE "User" ("Email" TEXT UNIQUE)`
  // is fully functional — lowercase SELECTs resolve, the UNIQUE constraint
  // enforces — so the gate must not reject it as missing.
  // -------------------------------------------------------------------------

  const CASED_USER = 'CREATE TABLE "User" ("Id" text primary key, "Email" text, "Name" text);';
  const CASED_USER_UNIQUE_EMAIL =
    'CREATE TABLE "User" ("Id" text primary key, "Email" text UNIQUE, "Name" text);';
  const CASED_SESSION_WITH_FK =
    'CREATE TABLE "Session" ("Id" text primary key, "UserId" text REFERENCES "User"("Id"));';

  it('accepts tables and columns declared in a different case than the emitted schema', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql: `${CASED_USER}\nCREATE TABLE "Session" ("Id" text primary key, "UserId" text);`,
        },
      ],
      required,
    );
  });

  it('accepts a column-level UNIQUE declared on a differently-cased column', async () => {
    await assertMigrationsProduceAuthSchema(
      [{ name: '0000.sql', sql: `${CASED_USER_UNIQUE_EMAIL}\n${CASED_SESSION_WITH_FK}` }],
      constrained,
    );
  });

  it('accepts a separate CREATE UNIQUE INDEX over a differently-cased column', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${CASED_USER}\n` +
            'CREATE UNIQUE INDEX "User_Email_Unique" ON "User" ("Email");\n' +
            `${CASED_SESSION_WITH_FK}`,
        },
      ],
      constrained,
    );
  });

  it('accepts a differently-cased single-column PRIMARY KEY as satisfying UNIQUE', async () => {
    // `Email` carries the PRIMARY KEY here — that is what makes it satisfy the `unique`
    // requirement, and it is the point of this test. `Id` is then declared UNIQUE so the
    // session foreign key still has a valid parent key to point at; without that the
    // migration would produce a schema SQLite rejects at runtime, which is a different
    // failure and is covered by its own tests below.
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "User" ("Id" text UNIQUE, "Email" text primary key, "Name" text);\n' +
            `${CASED_SESSION_WITH_FK}`,
        },
      ],
      constrained,
    );
  });

  it('still fails closed on a genuinely missing table, naming it as the schema declares it', async () => {
    await expect(
      assertMigrationsProduceAuthSchema([{ name: '0000.sql', sql: CASED_USER }], required),
    ).rejects.toThrow(/table "session" is not created by any checked-in migration/);
  });

  it('still fails closed on a genuinely missing column, naming it as the schema declares it', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql: `${CASED_USER}\nCREATE TABLE "Session" ("Id" text primary key);`,
          },
        ],
        required,
      ),
    ).rejects.toThrow(/table "session" is missing column\(s\): userId/);
  });

  it('still fails closed on a missing UNIQUE constraint when only the casing differs', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [{ name: '0000.sql', sql: `${CASED_USER}\n${CASED_SESSION_WITH_FK}` }],
        constrained,
      ),
    ).rejects.toThrow(/table "user" is missing a UNIQUE constraint on column\(s\): email/);
  });

  it('still fails closed on a missing foreign key when only the casing differs', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${CASED_USER_UNIQUE_EMAIL}\n` +
              'CREATE TABLE "Session" ("Id" text primary key, "UserId" text);',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(
      /table "session" column "userId" is missing a foreign key referencing "user"\."id"/,
    );
  });

  // A parent key must be a PRIMARY KEY or a UNIQUE index matching the reference (collation
  // included). Otherwise `CREATE TABLE` accepts the foreign key, but every statement on the child
  // fails at prepare time under `foreign_keys=ON`. SQLite itself decides (`foreign_key_check`).

  /** The parent key is a UNIQUE index, but declared under a DIFFERENT collation. */
  it('fails closed when the parent id is only unique under a differing COLLATE', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text NOT NULL, email text UNIQUE, name text);\n' +
              'CREATE UNIQUE INDEX "user_id_nocase" ON "user" (id COLLATE NOCASE);\n' +
              SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/foreign key mismatch/);
  });

  it('fails closed when the parent id is an ordinary, non-unique column', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql: 'CREATE TABLE "user" (id text, email text UNIQUE, name text);\n' + SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/foreign key mismatch/);
  });

  it('fails closed on an implicit REFERENCES to a parent that is UNIQUE but not the PRIMARY KEY', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text NOT NULL UNIQUE, email text UNIQUE, name text);\n' +
              'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user");',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/foreign key mismatch/);
  });

  it('accepts a parent that is UNIQUE (not PRIMARY KEY) with an explicit reference', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text NOT NULL UNIQUE, email text UNIQUE, name text);\n' +
            SESSION_WITH_FK,
        },
      ],
      constrained,
    );
  });

  it('accepts an INTEGER PRIMARY KEY rowid alias as the parent key', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id integer primary key, email text UNIQUE, name text);\n' +
            'CREATE TABLE "session" (id text primary key, userId integer REFERENCES "user"(id));',
        },
      ],
      constrained,
    );
  });

  // An auth reference must be its own single-column foreign key: under MATCH SIMPLE a composite
  // key is skipped whenever any child column is NULL. `foreign_key_list` lists one row per column
  // and `foreign_key_check` only finds orphaned rows, so neither catches it on an empty database.

  const COMPOSITE_PARENT =
    'CREATE TABLE "user" (id text NOT NULL, tenant text, email text UNIQUE, name text, ' +
    'PRIMARY KEY (id, tenant));';

  it('fails closed when the reference is only covered by a multi-column foreign key', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${COMPOSITE_PARENT}\n` +
              'CREATE TABLE "session" (id text primary key, userId text NOT NULL, tenant text, ' +
              'FOREIGN KEY (userId, tenant) REFERENCES "user"(id, tenant));',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(
      /table "session" column "userId" references "user"\."id" only as part of a MULTI-COLUMN foreign key/,
    );
  });

  it('explains that a composite foreign key is skipped when a child column is NULL', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${COMPOSITE_PARENT}\n` +
              'CREATE TABLE "session" (id text primary key, userId text NOT NULL, tenant text, ' +
              'FOREIGN KEY (userId, tenant) REFERENCES "user"(id, tenant));',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(
      /skips a composite foreign key entirely when any of its child columns is NULL[\s\S]*needs its own single-column foreign key on "userId"/,
    );
  });

  it('accepts a single-column foreign key on a table that also declares a composite one', async () => {
    // The composite constraint is unrelated to the auth reference; the single-column foreign
    // key on `userId` is what satisfies it, and grouping by constraint id must not lose it.
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${USER_WITH_UNIQUE_EMAIL}\n` +
            'CREATE TABLE "tenant" (org text NOT NULL, region text NOT NULL, PRIMARY KEY (org, region));\n' +
            'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user"(id), ' +
            'org text, region text, FOREIGN KEY (org, region) REFERENCES "tenant"(org, region));',
        },
      ],
      constrained,
    );
  });

  it('does not fail on an unrelated application table with its own broken foreign key', async () => {
    // The gate is scoped to the auth tables; a user's own schema problem elsewhere is not
    // this check's business and must not block a deploy on the auth path.
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${USER_WITH_UNIQUE_EMAIL}\n${SESSION_WITH_FK}\n` +
            'CREATE TABLE "widget" (id text primary key, tag text);\n' +
            'CREATE TABLE "widget_tag" (id text primary key, tag text REFERENCES "widget"(tag));',
        },
      ],
      constrained,
    );
  });
});

// ---------------------------------------------------------------------------
// The post-build auth-schema check reads the schema the BUILD generated
// (`.void/better-auth-schema.ts`, ground truth) and asserts the checked-in
// migrations produce it — applied to in-memory SQLite, not a token search.
// ---------------------------------------------------------------------------

describe("validateAuthMigrationSchema — reads the build's generated auth schema", () => {
  // The real build emits every auth column NOT NULL except a handful of optional ones (see
  // `playground/kitchen-sink/.void/better-auth-schema.ts`), and always
  // `.primaryKey().notNull()` for `id` — so these fixtures spell that out.
  const USER =
    'CREATE TABLE "user" (id text primary key not null, email text not null UNIQUE, name text not null);';
  const SESSION_EXPLICIT_FK =
    'CREATE TABLE "session" (id text primary key not null, userId text not null REFERENCES "user"(id));';
  const SESSION_IMPLICIT_FK =
    'CREATE TABLE "session" (id text primary key not null, userId text not null REFERENCES "user");';

  it('passes when the checked-in migrations produce the emitted schema', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['email', 'name'] }]);
    // Applying the migration to in-memory SQLite yields `user(id, email, name)` — the exact
    // emitted schema — so the check resolves (no throw).
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id text primary key not null, email text not null, name text not null);',
      },
    ]);
  });

  it('fails closed when a required column is missing from the checked-in migrations', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['email', 'name'] }]);
    await expect(
      // Creates `user` WITHOUT the required `name` column → fails closed against ground truth.
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE "user" (id text primary key not null, email text not null);',
        },
      ]),
    ).rejects.toThrow(/table "user" is missing column\(s\): name/);
  });

  it('fails closed when the build did not emit the auth-schema artifact', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    // No writeAuthSchemaArtifact — the build produced no schema to read as ground truth.
    await expect(validateAuthMigrationSchema(root, [])).rejects.toThrow(
      /did not emit|better-auth-schema/,
    );
  });

  /** The emitted artifact as the real build writes it: unique email + session → user FK. */
  function writeConstrainedAuthArtifact(root: string): void {
    writeAuthSchemaArtifact(root, [
      { name: 'user', fields: [{ name: 'email', unique: true }, 'name'] },
      {
        name: 'session',
        fields: [
          { name: 'userId', references: { table: 'user', field: 'id', onDelete: 'cascade' } },
        ],
      },
    ]);
  }

  it('fails closed when the migrations create every name but drop the unique email constraint', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // Every table and column name is correct — only `.unique()` was never applied.
          sql:
            'CREATE TABLE "user" (id text primary key not null, email text not null, name text not null);\n' +
            SESSION_EXPLICIT_FK,
        },
      ]),
    ).rejects.toThrow(/table "user" is missing a UNIQUE constraint on column\(s\): email/);
  });

  // -------------------------------------------------------------------------
  // The implicit `id`. It is absent from the emitted artifact's `fields` (see
  // `playground/kitchen-sink/.void/better-auth-schema.ts` — `user` starts at `name`),
  // so the synthesized descriptor is the only thing representing it. SQLite only
  // accepts a UNIQUELY CONSTRAINED parent key: point a foreign key at an ordinary
  // column and `CREATE TABLE` succeeds, `PRAGMA foreign_key_list` still reports the
  // constraint, and then every statement touching the child fails at prepare time
  // with `foreign key mismatch` under `foreign_keys=ON` — which D1 always enforces.
  // -------------------------------------------------------------------------

  const ID_MUST_BE_UNIQUE = /table "user" column "id" must be the PRIMARY KEY/;

  it('fails closed when an auth table id is an ordinary column (its foreign keys would be dead)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // Every name, the unique email and the session FK are all present — only `user.id`
          // was never marked `.primaryKey()`, which SQLite accepts at DDL time and rejects
          // at runtime.
          sql:
            'CREATE TABLE "user" (id text not null, email text not null UNIQUE, name text not null);\n' +
            SESSION_EXPLICIT_FK,
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_UNIQUE);
  });

  it("names SQLite's runtime failure mode so the message is actionable", async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        { name: '0000.sql', sql: 'CREATE TABLE "user" (id text not null, name text not null);' },
      ]),
    ).rejects.toThrow(/foreign key mismatch/);
  });

  it('accepts `id text primary key not null` (the spelling the real build emits)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await validateAuthMigrationSchema(root, [
      { name: '0000.sql', sql: `${USER}\n${SESSION_EXPLICIT_FK}` },
    ]);
  });

  it('accepts a UNIQUE id — SQLite takes any unique parent key, not only a PRIMARY KEY', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql:
          'CREATE TABLE "user" (id text not null unique, email text not null UNIQUE, name text not null);\n' +
          SESSION_EXPLICIT_FK,
      },
    ]);
  });

  it('accepts the `integer primary key` rowid alias (which materializes no index_list row)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id integer primary key, name text not null);',
      },
    ]);
  });

  it('does not accept a COMPOSITE unique index as making id a usable parent key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text not null, name text not null);\n' +
            'CREATE UNIQUE INDEX "user_id_name_idx" ON "user" (id, name);',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_UNIQUE);
  });

  it('does not accept a PARTIAL unique index as making id a usable parent key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text not null, name text not null);\n' +
            'CREATE UNIQUE INDEX "user_id_idx" ON "user" (id) WHERE name IS NOT NULL;',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_UNIQUE);
  });

  it('fails closed when the migrations create every name but drop the session foreign key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: `${USER}\nCREATE TABLE "session" (id text primary key not null, userId text not null);`,
        },
      ]),
    ).rejects.toThrow(
      /table "session" column "userId" is missing a foreign key referencing "user"\."id"/,
    );
  });

  it('passes when the migrations reproduce the emitted constraints', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql:
          `${USER}\n` +
          'CREATE TABLE "session" (id text primary key not null, userId text not null REFERENCES "user"(id) ON DELETE CASCADE);',
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // An omitted foreign-key target column (`REFERENCES "user"`). SQLite resolves it
  // ONLY to the parent's single-column PRIMARY KEY — a merely UNIQUE parent key works
  // for an EXPLICIT `REFERENCES "user"(id)` but not for the shorthand, and a composite
  // PRIMARY KEY cannot serve as the target either. `PRAGMA foreign_key_list` reports
  // `to: null` in every one of those cases with no indication that anything is wrong,
  // so the parent's own `table_info` is the only place the answer lives.
  // -------------------------------------------------------------------------

  const IMPLICIT_FK_NOT_PK = /references "user" without naming a target column/;

  it('fails closed on an implicit REFERENCES when the parent id is UNIQUE but not the PRIMARY KEY', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // `user.id` is a perfectly good parent key for an explicit reference, but the
          // shorthand below resolves to a PRIMARY KEY that does not exist.
          sql:
            'CREATE TABLE "user" (id text not null unique, email text not null UNIQUE, name text not null);\n' +
            SESSION_IMPLICIT_FK,
        },
      ]),
    ).rejects.toThrow(IMPLICIT_FK_NOT_PK);
  });

  it('accepts an implicit REFERENCES when the parent id IS the primary key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await validateAuthMigrationSchema(root, [
      { name: '0000.sql', sql: `${USER}\n${SESSION_IMPLICIT_FK}` },
    ]);
  });

  it('fails closed on an implicit REFERENCES to a parent with a COMPOSITE primary key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // `id` carries its own UNIQUE constraint, so it passes the identity check — the
          // only problem left is that the shorthand cannot resolve to `PRIMARY KEY (id, name)`.
          sql:
            'CREATE TABLE "user" (id text not null unique, email text not null UNIQUE, ' +
            'name text not null, PRIMARY KEY (id, name));\n' +
            SESSION_IMPLICIT_FK,
        },
      ]),
    ).rejects.toThrow(IMPLICIT_FK_NOT_PK);
  });

  // -------------------------------------------------------------------------
  // NOT NULL. SQLite permits NULL in any PRIMARY KEY column that is not the INTEGER
  // rowid alias — a file-format compatibility quirk — so `id text primary key` alone
  // accepts rows with no identity, and more than one of them, because NULLs never
  // collide under a unique constraint.
  // -------------------------------------------------------------------------

  const ID_MUST_BE_NOT_NULL = /table "user" column "id" must be declared NOT NULL/;

  it('fails closed when the id is a nullable PRIMARY KEY (SQLite accepts NULL identities)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE "user" (id text primary key, name text not null);',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_NOT_NULL);
  });

  it('accepts `id text primary key not null`', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id text primary key not null, name text not null);',
      },
    ]);
  });

  it('accepts `id integer primary key asc` — also a true rowid alias', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    // `ASC` on an INTEGER PRIMARY KEY is the plain alias spelled out; SQLite materializes no
    // primary-key index for it and assigns a rowid on a NULL insert.
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id integer primary key asc, name text not null);',
      },
    ]);
  });

  it('fails closed on `id integer primary key desc` — declared INTEGER, but not the rowid alias', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    // A SQLite quirk: `DESC` makes this an ORDINARY primary key, so a NULL insert stores NULL
    // and the table accepts rows with no identity. `PRAGMA table_info` reports it exactly like
    // the real alias (`type = INTEGER`, `pk = 1`, `notnull = 0`) — only the `origin = 'pk'`
    // row SQLite materializes in `PRAGMA index_list` tells them apart.
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE "user" (id integer primary key desc, name text not null);',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_NOT_NULL);
  });

  it('does not extend the rowid-alias exception to `int primary key` (which really does store NULL)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    // Only an exact `INTEGER` declared type makes a primary key the rowid alias.
    await expect(
      validateAuthMigrationSchema(root, [
        { name: '0000.sql', sql: 'CREATE TABLE "user" (id int primary key, name text not null);' },
      ]),
    ).rejects.toThrow(ID_MUST_BE_NOT_NULL);
  });

  it('does not extend the rowid-alias exception to `bigint primary key`', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE "user" (id bigint primary key, name text not null);',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_NOT_NULL);
  });

  it('still treats `id integer primary key` as the alias when the table carries other unique indexes', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [
      { name: 'user', fields: [{ name: 'email', unique: true }, 'name'] },
    ]);
    // The discriminator is the index ORIGIN, not the index COUNT: a column-level UNIQUE adds an
    // `origin = 'u'` row and a `CREATE UNIQUE INDEX` an `origin = 'c'` row, neither of which
    // stops the primary key from being the rowid alias.
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql:
          'CREATE TABLE "user" (id integer primary key, email text not null UNIQUE, name text not null);\n' +
          'CREATE UNIQUE INDEX "user_name_idx" ON "user" (name);',
      },
    ]);
  });

  it('fails closed when a required emitted field is declared nullable', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [
      { name: 'user', fields: [{ name: 'email', unique: true }, 'name'] },
    ]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // `email` keeps its UNIQUE constraint and its name — only NOT NULL was dropped.
          sql: 'CREATE TABLE "user" (id text primary key not null, email text UNIQUE, name text not null);',
        },
      ]),
    ).rejects.toThrow(
      /table "user" is missing a NOT NULL constraint on column\(s\): email \(the emitted auth schema marks them required\)/,
    );
  });

  it('does not require NOT NULL for a field the emitted schema marks optional', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    // `user.image` is `required: false` in the real artifact.
    writeAuthSchemaArtifact(root, [
      { name: 'user', fields: ['name', { name: 'image', required: false }] },
    ]);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id text primary key not null, name text not null, image text);',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Remote D1 migration safety gates
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — remote migration gates', () => {
  it('fails closed before applying when the deploy migration gate throws (drift/journal/destructive)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, trace, exitCalls } = harness({
      assertMigrationsDeployable: () => {
        throw new Error('Schema drift detected between your Drizzle schema and db/migrations/.');
      },
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The gate runs post-build against the live files, before the remote apply.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('fails closed when remote still has pending migrations after apply (declined prompt)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const localTrace: Array<string> = [];
    const { deps, exitCalls } = harness({
      runWrangler: operationFixture((args) => {
        localTrace.push(`wrangler:${args[0]}:${args[2] ?? ''}`);
        if (args[0] === 'whoami') {
          return { ...cleanExit, stdout: '{"loggedIn":true,"accounts":[]}' };
        }
        // `apply` exits 0 (a declined no-op); `list` still reports pending.
        if (args[0] === 'd1' && args[2] === 'list') {
          return { ...cleanExit, stdout: 'Migrations to be applied:\n0000_init' };
        }
        if (args[0] === 'd1' && args[1] === 'time-travel') {
          return {
            ...cleanExit,
            stdout: JSON.stringify({ bookmark: '00000085-0000024c' }),
          };
        }
        return cleanExit;
      }),
      runBuild: () => {
        localTrace.push('build');
      },
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Reached the post-apply list, then failed closed before the deploy.
    expect(localTrace).toContain('wrangler:d1:apply');
    expect(localTrace).toContain('wrangler:d1:list');
    expect(localTrace).toContain('build');
    expect(localTrace).not.toContain('wrangler:deploy');
  });

  it('fails closed when the pending-verify prints NO recognizable marker (reduced log level)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const localTrace: Array<string> = [];
    const { deps, exitCalls } = harness({
      runWrangler: operationFixture((args) => {
        localTrace.push(`wrangler:${args[0]}:${args[2] ?? ''}`);
        if (args[0] === 'whoami') {
          return { ...cleanExit, stdout: '{"loggedIn":true,"accounts":[]}' };
        }
        // The pre-apply list sees the pending migration, so a restore point is saved.
        if (args[0] === 'd1' && args[2] === 'list' && !localTrace.includes('wrangler:d1:apply')) {
          return { ...cleanExit, stdout: 'Migrations to be applied:\n0000_init' };
        }
        if (args[0] === 'd1' && args[1] === 'time-travel') {
          return { ...cleanExit, stdout: JSON.stringify({ bookmark: '00000085-0000024c' }) };
        }
        // `apply` and the post-apply `list` exit 0 with EMPTY stdout — the failure mode when an
        // ambient WRANGLER_LOG suppressed the sentinel. Require the affirmative marker.
        return cleanExit;
      }),
      runBuild: () => {
        localTrace.push('build');
      },
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Never trusts an absent marker — fails closed before DEPLOY (the build already ran).
    expect(localTrace.filter((entry) => entry.startsWith('wrangler:d1:'))).toEqual([
      'wrangler:d1:list',
      'wrangler:d1:info',
      'wrangler:d1:list',
      'wrangler:d1:apply',
      'wrangler:d1:list',
    ]);
    expect(localTrace).toContain('build');
    expect(localTrace).not.toContain('wrangler:deploy');
  });

  describe('a failure after the D1 migrations were applied', () => {
    const bookmark = '00000085-0000024c';

    // Pending until the apply runs, then current.
    function migratingWrangler(pending: boolean): DeployWranglerRun {
      let applied = false;
      return operationFixture((args) => {
        if (args[0] === 'whoami') {
          return { ...cleanExit, stdout: '{"loggedIn":true,"accounts":[]}' };
        }
        if (args[0] === 'd1' && args[2] === 'apply') {
          applied = true;
        }
        if (args[0] === 'd1' && args[2] === 'list') {
          return {
            ...cleanExit,
            stdout:
              pending && !applied
                ? 'Migrations to be applied:\n0000_init'
                : '✅ No migrations to apply!\n',
          };
        }
        if (args[0] === 'd1' && args[1] === 'time-travel') {
          return { ...cleanExit, stdout: JSON.stringify({ bookmark }) };
        }
        return cleanExit;
      });
    }

    function restoreErrors(output: { mock: { calls: Array<Array<unknown>> } }): Array<string> {
      return output.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('applied before the deploy stopped'));
    }

    it('names the restore point again when the upload fails', async () => {
      const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
      const order: Array<string> = [];
      const output = vi.spyOn(log, 'error').mockImplementation((message) => {
        if (String(message).includes('applied before the deploy stopped')) {
          order.push('restore');
        }
      });
      const { deps } = harness({
        runWrangler: migratingWrangler(true),
        activateVersion: async () => ({ ok: false, reason: 'upload-failed', status: 1 }),
        // process.exit never returns, so the restore point must be named before it.
        exit: (code) => {
          order.push('exit');
          throw new ExitError(code);
        },
      });
      try {
        await expect(
          runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
        ).rejects.toBeInstanceOf(ExitError);
        const reported = restoreErrors(output);
        expect(order).toEqual(['restore', 'exit']);
        expect(reported).toHaveLength(1);
        expect(reported[0]).toContain('Fix the error and deploy again.');
        // The test project saves no platform, so the command names it.
        expect(reported[0]).toContain(
          `void db restore --platform cloudflare --bookmark=${bookmark}`,
        );
      } finally {
        output.mockRestore();
      }
    });

    it('names the restore point again when the built config fails its check', async () => {
      const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
      const output = vi.spyOn(log, 'error').mockImplementation(() => {});
      const { deps } = harness({
        runWrangler: migratingWrangler(true),
        verifyDeployConfig: () => ({ ok: false, reason: 'different account' }),
      });
      try {
        await expect(
          runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
        ).rejects.toBeInstanceOf(ExitError);
        expect(restoreErrors(output)).toHaveLength(1);
      } finally {
        output.mockRestore();
      }
    });

    it('names the restore point again when publishing throws', async () => {
      const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
      const output = vi.spyOn(log, 'error').mockImplementation(() => {});
      const { deps } = harness({
        runWrangler: migratingWrangler(true),
        activateVersion: async () => {
          throw new Error('connection reset');
        },
      });
      try {
        await expect(
          runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
        ).rejects.toThrow('connection reset');
        expect(restoreErrors(output)).toHaveLength(1);
      } finally {
        output.mockRestore();
      }
    });

    it('names no restore point when the deploy applied no migration', async () => {
      const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
      const output = vi.spyOn(log, 'error').mockImplementation(() => {});
      const { deps } = harness({
        runWrangler: migratingWrangler(false),
        activateVersion: async () => ({ ok: false, reason: 'upload-failed', status: 1 }),
      });
      try {
        await expect(
          runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
        ).rejects.toBeInstanceOf(ExitError);
        expect(restoreErrors(output)).toEqual([]);
        expect(output.mock.calls.join('\n')).not.toContain('void db restore');
      } finally {
        output.mockRestore();
      }
    });
  });
});

// The exact set wrangler will apply must equal the gated source set.

describe('checkWranglerMigrationApplySet', () => {
  function configFor(dir: string, pattern?: string): Record<string, unknown> {
    const entry: Record<string, unknown> = { binding: 'DB', migrations_dir: dir };
    // `!== undefined` (not truthiness) so an explicit EMPTY pattern (`""`) is set —
    // a present-but-empty pattern is still custom and must be rejected.
    if (pattern !== undefined) {
      entry.migrations_pattern = pattern;
    }
    return { d1_databases: [entry] };
  }

  it('passes when the configured dir + files equal the gated set', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
      'db/migrations/0001_more.sql': 'CREATE TABLE b (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      [
        { name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' },
        { name: '0001_more.sql', sql: 'CREATE TABLE b (id integer);' },
      ],
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an extra seed.sql wrangler would apply that the gated set excludes', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
      'db/migrations/seed.sql': 'INSERT INTO a VALUES (1);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('seed.sql');
    }
  });

  it('rejects when the configured migrations_dir does not exist', async () => {
    const root = makeProject({ 'wrangler.jsonc': '{}' });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./nope'),
      'DB',
      './nope',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('does not exist');
    }
  });

  it('rejects when a file content differs between the config dir and the gated copy', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id text);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('content differs');
    }
  });

  it('rejects when wrangler would apply in a DIFFERENT order (unpadded numeric prefix)', async () => {
    // `2_*.sql` and `10_*.sql` sort DIFFERENTLY for wrangler (numeric: 2 < 10) than for Void's
    // collectMigrations (lexicographic: "10" < "2"). The set is equal but the apply ORDER
    // diverges, so remote D1 would receive them out of the validated order — reject.
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/2_early.sql': 'CREATE TABLE a (id integer);',
      'db/migrations/10_late.sql': 'CREATE TABLE b (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      // collectMigrations' lexicographic order: 10_late before 2_early.
      [
        { name: '10_late.sql', sql: 'CREATE TABLE b (id integer);' },
        { name: '2_early.sql', sql: 'CREATE TABLE a (id integer);' },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('DIFFERENT order');
    }
  });

  it('passes with zero-padded prefixes (numeric order == lexicographic order)', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0002_early.sql': 'CREATE TABLE a (id integer);',
      'db/migrations/0010_late.sql': 'CREATE TABLE b (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      [
        { name: '0002_early.sql', sql: 'CREATE TABLE a (id integer);' },
        { name: '0010_late.sql', sql: 'CREATE TABLE b (id integer);' },
      ],
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a custom pattern whose exact result matches the validated set', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations', 'db/migrations/**/*.sql'),
      'DB',
      './db/migrations',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' }],
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a custom pattern when migrations_dir is implicit', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      {
        d1_databases: [
          {
            binding: 'DB',
            migrations_pattern: 'db/migrations/**/*.sql',
          },
        ],
      },
      'DB',
      './db/migrations',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('requires an explicit migrations_dir');
    }
  });

  it('fails closed (defense in depth) on a PRESENT-but-EMPTY migrations_pattern ("")', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations', ''),
      'DB',
      './db/migrations',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('must be a non-empty string');
    }
  });

  it('rejects a custom pattern whose exact result omits a validated migration', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
      'db/migrations/0001_more.sql': 'CREATE TABLE b (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations', 'db/migrations/0000_*.sql'),
      'DB',
      './db/migrations',
      [
        { name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' },
        { name: '0001_more.sql', sql: 'CREATE TABLE b (id integer);' },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('0001_more.sql');
    }
  });

  it('rejects a custom pattern outside migrations_dir before enumeration', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations', 'other/*.sql'),
      'DB',
      './db/migrations',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('must start with');
    }
  });
});

describe('compareWranglerMigrationPaths (wrangler 4.131 numeric-prefix comparator)', () => {
  it('sorts by leading numeric prefix (2 before 10), matching wrangler', () => {
    const sorted = ['10_b.sql', '2_a.sql', '1_z.sql'].sort(compareWranglerMigrationPaths);
    expect(sorted).toEqual(['1_z.sql', '2_a.sql', '10_b.sql']);
  });

  it('places a non-numeric segment (seed.sql) after all numeric-prefixed ones', () => {
    const sorted = ['seed.sql', '0001_a.sql', '0000_b.sql'].sort(compareWranglerMigrationPaths);
    expect(sorted).toEqual(['0000_b.sql', '0001_a.sql', 'seed.sql']);
  });
});

// ---------------------------------------------------------------------------
// Post-build ground-truth secret gate: the parent builds the values-free context
// from the REAL emitted `vars` + the env-insensitive required names, then
// discharges it. A server key shipped as a plaintext var fails closed post-build; a
// pre-build schema-probe failure fails closed before any account op.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — post-build ground-truth secret gate', () => {
  it('rejects a pending Durable Object class migration before database or secret mutation', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace, wranglerArgs } = harness({
      assertDurableObjectLifecycle: async () => {
        trace.push('do-lifecycle');
        throw new Error('pending class migration');
      },
    });

    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(trace).toContain('build');
    expect(trace).toContain('do-lifecycle');
    expect(wranglerArgs.some((args) => args[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('auth-secret');
    expect(trace).not.toContain('schema-secrets');
    expect(trace).not.toContain('wrangler:deploy');
  });

  it.each([
    { shipped: 'a value', value: 'secret' },
    { shipped: 'an empty value', value: '' },
    { shipped: 'a null value', value: null },
  ])(
    'rejects a schema-declared server key emitted as a plaintext Worker var with $shipped',
    async ({ value }) => {
      const root = d1Project(PROVISIONED_D1);
      // The plaintext server-key gate checks presence, so empty and null values fail closed too.
      const { deps, trace, wranglerArgs, exitCalls } = harness({
        resolveSchemaFacts: (() =>
          okSchemaFacts({
            hasSchema: true,
            requiredKeys: ['API_TOKEN'],
            serverKeys: ['API_TOKEN'],
          })) as CloudflareDeployDeps['resolveSchemaFacts'],
        readEmittedWorkerVars: (() =>
          emittedVars({ API_TOKEN: value })) as CloudflareDeployDeps['readEmittedWorkerVars'],
      });

      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(exitCalls).toEqual([1]);
      expect(trace).toContain('build');
      expect(trace).not.toContain('wrangler:deploy');
      expect(wranglerArgs.some((a) => a[0] === 'secret')).toBe(false);
    },
  );

  it('allows an emitted VITE_* client value', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace } = harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          serverKeys: [],
          requiredKeys: [],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      readEmittedWorkerVars: (() =>
        emittedVars({
          VITE_APP_TITLE: 'Public title',
        })) as CloudflareDeployDeps['readEmittedWorkerVars'],
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('wrangler:deploy');
  });

  it('passes schema-required keys to generated config verification', async () => {
    const root = d1Project(PROVISIONED_D1);
    let requiredSecretNames: Array<string> | undefined;
    const { deps } = harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          serverKeys: ['API_TOKEN'],
          requiredKeys: ['API_TOKEN'],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      verifyDeployConfig: ((_root, options) => {
        requiredSecretNames = options.requiredSecretNames;
        return { ok: true };
      }) as CloudflareDeployDeps['verifyDeployConfig'],
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(requiredSecretNames).toEqual(['API_TOKEN']);
  });

  it('rejects a plaintext BETTER_AUTH_SECRET before provisioning or upload', async () => {
    const root = d1Project(PROVISIONED_D1, {
      'void.json': JSON.stringify({ auth: {} }),
    });
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      readEmittedWorkerVars: (() =>
        emittedVars({
          BETTER_AUTH_SECRET: 'plaintext-secret',
        })) as CloudflareDeployDeps['readEmittedWorkerVars'],
    });

    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toContain('build');
    expect(trace).not.toContain('auth-secret');
    expect(trace).not.toContain('wrangler:deploy');
    expect(wranglerArgs.some((args) => args[0] === 'secret')).toBe(false);
  });

  it('removes BETTER_AUTH_SECRET from the generic schema gate because deploy owns it', async () => {
    const root = d1Project(PROVISIONED_D1, {
      'void.json': JSON.stringify({ auth: {} }),
    });
    let captured: SelfHostEnvContext | undefined;
    const { deps, trace } = harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          requiredKeys: ['BETTER_AUTH_SECRET'],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      validateEmittedVars: (async () => ({
        kind: 'invalid-keys',
        invalidKeys: ['BETTER_AUTH_SECRET'],
      })) as CloudflareDeployDeps['validateEmittedVars'],
      dischargeSelfHostEnv: (async (ctx: SelfHostEnvContext) => {
        captured = ctx;
      }) as CloudflareDeployDeps['dischargeSelfHostEnv'],
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(captured?.absentRequired).toEqual([]);
    expect(captured?.invalidKeys).toEqual([]);
    expect(trace).toContain('auth-secret');
    expect(trace).toContain('wrangler:deploy');
  });

  it('discharges a context DERIVED from the REAL emitted vars + env-insensitive required names', async () => {
    const root = d1Project(PROVISIONED_D1);
    let captured: SelfHostEnvContext | undefined;
    const { deps, trace } = harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          requiredKeys: ['STRIPE_KEY'],
          serverKeys: ['STRIPE_KEY'],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      readEmittedWorkerVars: (() =>
        emittedVars({ APP_NAME: 'demo' })) as CloudflareDeployDeps['readEmittedWorkerVars'],
      dischargeSelfHostEnv: (async (ctx: SelfHostEnvContext) => {
        trace.push('gate');
        captured = ctx;
      }) as CloudflareDeployDeps['dischargeSelfHostEnv'],
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    // STRIPE_KEY is absent from the emitted vars → the gate sees it as absentRequired (the
    // remote secret discharges it); nothing is invalid.
    expect(captured).toEqual({
      hasSchema: true,
      absentRequired: ['STRIPE_KEY'],
      invalidKeys: [],
    });
    expect(trace).toContain('wrangler:deploy');
  });

  it('fails closed when the build emits a MALFORMED vars field (array/scalar)', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      // A present-but-non-object `vars` must fail closed, never normalize to an empty map.
      readEmittedWorkerVars: (() => ({
        ok: false,
        reason: 'the generated wrangler config has a malformed "vars" field (expected an object).',
      })) as CloudflareDeployDeps['readEmittedWorkerVars'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('fails closed pre-build when the env-schema probe throws (never validates a wrong schema)', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      resolveSchemaFacts: (() => {
        throw new Error('cannot import env.ts');
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Derived pre-build — before whoami / provision / build.
    expect(trace).toEqual([]);
  });

  it('fails closed (values-free) pre-build when the probe reports a schema-load failure', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      resolveSchemaFacts: (() => ({
        kind: 'schema-error',
        reason: 'schema-load-failed',
      })) as CloudflareDeployDeps['resolveSchemaFacts'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NODE_ENV pin — the facts probe evaluates env.ts under the build's environment
// (NODE_ENV=production), so a required set conditioned on NODE_ENV matches the
// built worker's, and the parent passes that pinned env to the probe.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — schema probe runs under the build NODE_ENV', () => {
  it('passes NODE_ENV=production to the probe env', async () => {
    const root = d1Project(PROVISIONED_D1);
    let capturedNodeEnv: string | undefined = 'UNSET';
    const { deps } = harness({
      resolveSchemaFacts: ((_input, env) => {
        capturedNodeEnv = env.NODE_ENV;
        return okSchemaFacts();
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    // The build sets NODE_ENV=production; the probe env is pinned to match so a schema
    // conditioned on NODE_ENV derives the SAME required set the build would.
    expect(capturedNodeEnv).toBe('production');
  });

  it('pins NODE_ENV=production for the BUILD too (vite only defaults it when unset)', async () => {
    // An ambient NODE_ENV=development would otherwise make `vite build` evaluate a development
    // schema while the probe (pinned production) derives a production one.
    vi.stubEnv('NODE_ENV', 'development');
    let buildNodeEnv: string | undefined = 'UNSET';
    const root = d1Project(PROVISIONED_D1);
    const { deps } = harness({
      runBuild: (env) => {
        buildNodeEnv = env.NODE_ENV;
      },
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(buildNodeEnv).toBe('production');
  });

  it('marks both schema probes and the build as a Cloudflare deploy build', async () => {
    const root = d1Project(PROVISIONED_D1);
    let probeMarker: string | undefined;
    let buildMarker: string | undefined;
    const { deps } = harness({
      resolveSchemaFacts: ((_input, env) => {
        probeMarker = env.VOID_CLOUDFLARE_DEPLOY_BUILD;
        return okSchemaFacts();
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
      runBuild: (env) => {
        buildMarker = env.VOID_CLOUDFLARE_DEPLOY_BUILD;
      },
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    expect(probeMarker).toBe('1');
    expect(buildMarker).toBe('1');
  });

  it('scrubs stale managed markers from native probes and the build', async () => {
    vi.stubEnv('VOID_DEPLOY_PROJECT_ID', 'stale-managed-project');
    vi.stubEnv('VOID_DEPLOY_BUILD', '1');
    let probeEnvSeen: NodeJS.ProcessEnv = {};
    let buildEnvSeen: NodeJS.ProcessEnv = {};
    const root = d1Project(PROVISIONED_D1);
    const { deps } = harness({
      resolveSchemaFacts: ((_input, env) => {
        probeEnvSeen = { ...env };
        return okSchemaFacts();
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
      runBuild: (env) => {
        buildEnvSeen = { ...env };
      },
    });

    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);

    for (const env of [probeEnvSeen, buildEnvSeen]) {
      expect(env.VOID_DEPLOY_PROJECT_ID).toBeUndefined();
      expect(env.VOID_DEPLOY_BUILD).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// `vite build` runs UNTRUSTED project code (the user's config, every plugin, env.ts)
// and authenticates against nothing, so it gets the same credential scrub as the
// isolated probes. The wrangler runner must keep them — whoami / d1 migrations apply
// / deploy are the calls that actually need an account credential.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — wrangler credentials reach only the wrangler runner', () => {
  it('the BUILD child env carries none of the wrangler auth credentials', async () => {
    let buildEnvSeen: NodeJS.ProcessEnv = {};
    stubWranglerCredentials();
    vi.stubEnv('DATABASE_URL', 'postgres://production-secret');
    vi.stubEnv('VOID_TOKEN', 'managed-platform-token');
    const root = d1Project(PROVISIONED_D1);
    const { deps } = harness({
      runBuild: (env) => {
        buildEnvSeen = { ...env };
      },
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    for (const name of WRANGLER_AUTH_VARS) {
      expect(buildEnvSeen[name]).toBeUndefined();
    }
    expect(buildEnvSeen.DATABASE_URL).toBeUndefined();
    expect(buildEnvSeen.VOID_TOKEN).toBeUndefined();
  });

  it('the wrangler runner keeps Wrangler auth but not Void readiness credentials', () => {
    stubWranglerCredentials();
    const runnerEnv = deployChildEnv('acc123', 'https://api.cloudflare.com/client/v4');
    for (const name of WRANGLER_AUTH_VARS) {
      if (name === 'CF_ACCESS_TOKEN') {
        expect(runnerEnv[name]).toBeUndefined();
      } else {
        expect(runnerEnv[name]).toBe(`secret-${name}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Emitted-value validation (invalid required value) — a required var shipped with
// a MALFORMED value fails the deploy closed BEFORE any remote mutation, not only at
// worker boot.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — invalid emitted value fails closed pre-remote', () => {
  const invalidPortHarness = (overrides: Partial<CloudflareDeployDeps> = {}) =>
    harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          serverKeys: [],
          requiredKeys: [],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      readEmittedWorkerVars: (() =>
        emittedVars({
          VITE_PORT: 'not-a-number',
        })) as CloudflareDeployDeps['readEmittedWorkerVars'],
      // Use the REAL discharge so the invalidKeys folded in by the probe actually fail closed.
      dischargeSelfHostEnv: undefined,
      ...overrides,
    });

  it('fails closed (no remote apply / deploy) when a required emitted value is schema-invalid', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace, wranglerArgs, exitCalls } = invalidPortHarness({
      // The probe reports the client build value invalid.
      validateEmittedVars: (async () => ({
        kind: 'invalid-keys',
        invalidKeys: ['VITE_PORT'],
      })) as CloudflareDeployDeps['validateEmittedVars'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Caught POST-build (ground truth) but BEFORE any remote D1 apply, secret list, or deploy.
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(wranglerArgs.some((a) => a[0] === 'secret')).toBe(false);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('proceeds when the required emitted value is schema-valid', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace } = invalidPortHarness({
      readEmittedWorkerVars: (() =>
        emittedVars({ VITE_PORT: '8080' })) as CloudflareDeployDeps['readEmittedWorkerVars'],
      // No key is invalid, so the gate makes no wrangler call.
      validateEmittedVars: (async () => ({
        kind: 'invalid-keys',
        invalidKeys: [],
      })) as CloudflareDeployDeps['validateEmittedVars'],
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('wrangler:deploy');
  });

  it('fails closed when the emitted-value validation probe reports a schema error', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = invalidPortHarness({
      validateEmittedVars: (async () => ({
        kind: 'schema-error',
        reason: 'schema-validation-error',
      })) as CloudflareDeployDeps['validateEmittedVars'],
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('wrangler:deploy');
  });
});

// ---------------------------------------------------------------------------
// Post-build migration re-check — the local migration gates run AFTER the build,
// against the LIVE post-build files, so a build that adds/rewrites migration SQL
// can never reach remote D1 ungated.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — migration gates re-checked post-build', () => {
  it('catches a migration the build REWRITES to be destructive (fails closed before remote apply)', async () => {
    const root = d1Project(PROVISIONED_D1, {
      // Pre-build the migration is a clean, non-destructive CREATE TABLE — it would pass a
      // pre-build gate. No db/schema.ts, so the drift check short-circuits (no drizzle-kit).
      'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
    });
    // Use the REAL migration gate (not the harness stub) so the post-build destructive check runs.
    const { deps, wranglerArgs, trace, exitCalls } = harness({
      assertMigrationsDeployable: undefined,
      runBuild: () => {
        trace.push('build');
        // A build plugin rewrites the migration to a destructive, un-pragma'd DROP AFTER the
        // pre-build point — exactly the window the post-build re-check closes.
        writeFileSync(join(root, 'db/migrations/0000_init.sql'), 'DROP TABLE notes;');
      },
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The build ran, but the post-build gate rejected the destructive migration before the
    // remote D1 apply and before the deploy.
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('catches a stray .sql the build ADDS to migrations_dir (apply-set mismatch, fails closed)', async () => {
    const root = d1Project(PROVISIONED_D1, {
      'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
    });
    // Use the REAL apply-set gate so it enumerates the LIVE dir after the build.
    const { deps, wranglerArgs, trace, exitCalls } = harness({
      checkMigrationApplySet: checkWranglerMigrationApplySet,
      runBuild: () => {
        trace.push('build');
        // The build adds a stray seed.sql: collectMigrations skips it but wrangler's *.sql glob
        // would apply it — the post-build apply-set check catches the extra file.
        writeFileSync(join(root, 'db/migrations/seed.sql'), 'INSERT INTO notes VALUES (1);');
      },
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('applies the post-build migrations in the normal case (build leaves them untouched)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    // REAL migration gate; the untouched migration passes post-build and is applied.
    const { deps, wranglerArgs, trace } = harness({ assertMigrationsDeployable: undefined });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('build');
    const d1Calls = wranglerArgs.filter((a) => a[0] === 'd1');
    expect(d1Calls.map((a) => a.slice(0, 3))).toContainEqual(['d1', 'migrations', 'apply']);
    expect(trace).toContain('wrangler:deploy');
  });
});

// ---------------------------------------------------------------------------
// The REAL env-schema probe subprocess. The parent runs NO project code —
// importing the user's env.ts happens in the child, whose framed result is
// written to a DEDICATED fd (fd 3) so noisy stdout can't truncate it, and the
// child sees ONLY the passed (scrubbed) env — never the parent's credentials.
// ---------------------------------------------------------------------------

describe('env-schema probe (real subprocess)', () => {
  // The probe spawns a plain `node` on this repo's source `.ts`, so its runtime imports must use
  // type-strippable syntax supported by Node without extra NODE_OPTIONS flags.

  it('does not start a child when no schema exists', async () => {
    const root = makeProject({ 'package.json': '{"type":"module"}' });
    const spawn = vi.fn();
    expect(await resolveEnvSchemaFactsViaSubprocess({ root }, {}, spawn)).toEqual({
      kind: 'ok',
      facts: { hasSchema: false, serverKeys: [], requiredKeys: [] },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['env.ts', 'env.mts', 'env.js', 'env.mjs'])(
    'still isolates %s under a configured source directory',
    async (filename) => {
      const root = makeProject({
        'void.json': '{"sourceDir":"app"}',
        [`app/${filename}`]: 'throw new Error("must never run in parent");',
      });
      const spawn = vi.fn(() => ({
        status: 0,
        fd3: JSON.stringify({
          kind: 'ok',
          facts: { hasSchema: true, serverKeys: [], requiredKeys: [] },
        }),
        error: null,
        signal: null,
      }));
      expect((await resolveEnvSchemaFactsViaSubprocess({ root }, {}, spawn)).kind).toBe('ok');
      expect(spawn).toHaveBeenCalledOnce();
    },
  );

  it('derives server + required facts and the fd-3 result survives noisy stdout', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        // A huge stdout write proves the fd-3 result channel is not truncated by env.ts noise.
        `console.log('x'.repeat(200000));`,
        `export default defineEnv({ STRIPE_KEY: string(), API_URL: string(), VITE_TITLE: string() });`,
      ].join('\n'),
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, { ...process.env });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.facts.hasSchema).toBe(true);
      expect(r.facts.requiredKeys).toContain('STRIPE_KEY');
      expect(r.facts.requiredKeys).toContain('API_URL');
      expect(r.facts.serverKeys).toEqual(['STRIPE_KEY', 'API_URL']);
    }
  });

  it('runs env.ts under the PASSED env — a scrubbed env hides CF Access from project code', async () => {
    const leakFile = join(tmpDir, 'env-leak.json');
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(leakFile)}, JSON.stringify({`,
        `  token: process.env.CLOUDFLARE_API_TOKEN ?? null,`,
        `  id: process.env.CF_ACCESS_CLIENT_ID ?? null,`,
        `}));`,
        `export default defineEnv({ FOO: string() });`,
      ].join('\n'),
    });
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CF_ACCESS_CLIENT_ID;
    await resolveEnvSchemaFactsViaSubprocess({ root }, env);
    const leaked = JSON.parse(readFileSync(leakFile, 'utf-8')) as {
      token: string | null;
      id: string | null;
    };
    // The child only ever sees the PASSED env — the scrubbed keys read as null.
    expect(leaked.token).toBeNull();
    expect(leaked.id).toBeNull();
  });

  it('the orchestrator scrubs CLOUDFLARE_API_TOKEN + CF Access before spawning the probe', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'super-secret-token');
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'super-secret-id');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'super-secret-secret');
    const leakFile = join(tmpDir, 'orchestrator-leak.json');
    // The env.ts LEAKS the three parent creds to a file; the orchestrator spawns the REAL
    // probe (resolveSchemaFacts undefined → default subprocess seam) under a scrubbed env.
    const root = d1Project(PROVISIONED_D1, {
      'package.json': JSON.stringify({ name: 'myapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(leakFile)}, JSON.stringify({`,
        `  token: process.env.CLOUDFLARE_API_TOKEN ?? null,`,
        `  id: process.env.CF_ACCESS_CLIENT_ID ?? null,`,
        `  secret: process.env.CF_ACCESS_CLIENT_SECRET ?? null,`,
        `}));`,
        `export default defineEnv({ FOO: string() });`,
      ].join('\n'),
    });
    await runCloudflareDeploy(
      root,
      { platform: 'cloudflare' },
      silentCliLog,
      harness({ resolveSchemaFacts: undefined }).deps,
    );
    const leaked = JSON.parse(readFileSync(leakFile, 'utf-8')) as {
      token: string | null;
      id: string | null;
      secret: string | null;
    };
    // The child (project env.ts) ran under the scrubbed env — none of the parent's creds.
    expect(leaked.token).toBeNull();
    expect(leaked.id).toBeNull();
    expect(leaked.secret).toBeNull();
  });

  it('a broken env.ts fails closed with a VALUES-FREE classification — no raw child output echoed', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': `throw new Error('SUPER_SECRET_LEAK_9999');\nexport default {};`,
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, { ...process.env });
    expect(r.kind).toBe('schema-error');
    // The values-free boundary drops the original message, so the leak never reaches the result.
    expect(JSON.stringify(r)).not.toContain('SUPER_SECRET_LEAK_9999');
  });

  it('parses ONLY the dedicated fd-3 result channel (injected spawn)', async () => {
    const root = makeProject({ 'env.ts': 'export default {};' });
    const facts = { hasSchema: true, serverKeys: ['X'], requiredKeys: ['X'] };
    const okSpawn = (): EnvSchemaProbeSpawnResult => ({
      status: 0,
      fd3: JSON.stringify({ kind: 'ok', facts }),
      error: null,
      signal: null,
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, { ...process.env }, okSpawn);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.facts).toEqual(facts);
    }
    // A nonzero child exit fails closed (values-free) — the parent never trusts a partial result.
    const failSpawn = (): EnvSchemaProbeSpawnResult => ({
      status: 1,
      fd3: '',
      error: null,
      signal: null,
    });
    await expect(
      resolveEnvSchemaFactsViaSubprocess({ root }, { ...process.env }, failSpawn),
    ).rejects.toThrow(/exited with code/);
  });

  it('derives facts without resolving the Vite config', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        `export default defineEnv({ API_URL: string() });`,
      ].join('\n'),
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, { ...process.env });
    expect(r.kind).toBe('ok');
  });

  it('derives the required set under the PASSED NODE_ENV (matches the production build)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        // PROD_SECRET is required only when NODE_ENV === 'production' — exactly the vector the
        // pinned probe env closes.
        `const prod = process.env.NODE_ENV === 'production' ? { PROD_SECRET: string() } : {};`,
        `export default defineEnv({ API_URL: string(), ...prod });`,
      ].join('\n'),
    });
    const under = async (nodeEnv: string): Promise<Array<string>> => {
      const env = { ...process.env, NODE_ENV: nodeEnv };
      const r = await resolveEnvSchemaFactsViaSubprocess({ root }, env);
      return r.kind === 'ok' ? [...r.facts.requiredKeys].sort() : [`<${r.kind}>`];
    };
    // Under production (the pinned build env), PROD_SECRET is required — matching the worker.
    expect(await under('production')).toEqual(['API_URL', 'PROD_SECRET']);
    // Under a non-production env it would NOT be — proving the pin is what makes them agree.
    expect(await under('development')).toEqual(['API_URL']);
  });

  it('validate-emitted: reports the schema-INVALID emitted values by key name only', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { number, string } from ${JSON.stringify(srcEnvHelpers)};`,
        `export default defineEnv({ PORT: number(), API_URL: string() });`,
      ].join('\n'),
      // The build's emitted worker vars: PORT is present but malformed, API_URL is fine.
      '.wrangler/deploy/config.json': JSON.stringify({
        configPath: '../../dist/ssr/wrangler.json',
      }),
      'dist/ssr/wrangler.json': JSON.stringify({
        vars: { PORT: 'not-a-number', API_URL: 'https://example.com' },
      }),
    });
    const r = await validateEmittedVarsViaSubprocess({ root }, { ...process.env });
    expect(r.kind).toBe('invalid-keys');
    if (r.kind === 'invalid-keys') {
      expect(r.invalidKeys).toEqual(['PORT']);
    }
  });

  it('validate-emitted: no invalid keys when every emitted value validates', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { number } from ${JSON.stringify(srcEnvHelpers)};`,
        `export default defineEnv({ PORT: number() });`,
      ].join('\n'),
      '.wrangler/deploy/config.json': JSON.stringify({
        configPath: '../../dist/ssr/wrangler.json',
      }),
      'dist/ssr/wrangler.json': JSON.stringify({ vars: { PORT: '8080' } }),
    });
    const r = await validateEmittedVarsViaSubprocess({ root }, { ...process.env });
    expect(r.kind).toBe('invalid-keys');
    if (r.kind === 'invalid-keys') {
      expect(r.invalidKeys).toEqual([]);
    }
  });

  it('the child env carries NONE of the full wrangler-auth credential set (all aliases scrubbed)', async () => {
    // Every Cloudflare credential is set on the parent; the app's env.ts leaks what it sees.
    stubWranglerCredentials();
    const authVars = WRANGLER_AUTH_VARS;
    const leakFile = join(tmpDir, 'auth-scrub-leak.json');
    const root = d1Project(PROVISIONED_D1, {
      'package.json': JSON.stringify({ name: 'myapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(leakFile)}, JSON.stringify({`,
        ...authVars.map((name) => `  ${name}: process.env[${JSON.stringify(name)}] ?? null,`),
        `}));`,
        `export default defineEnv({ FOO: string() });`,
      ].join('\n'),
    });
    await runCloudflareDeploy(
      root,
      { platform: 'cloudflare' },
      silentCliLog,
      harness({ resolveSchemaFacts: undefined }).deps,
    );
    const leaked = JSON.parse(readFileSync(leakFile, 'utf-8')) as Record<string, string | null>;
    // The probe needs no credentials — the child sees none of them, canonical OR alias.
    for (const name of authVars) {
      expect(leaked[name]).toBeNull();
    }
  });

  it('a child that prints secrets to stdout AND stderr cannot leak them — the fd-3 result still parses', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        // Both channels are IGNORED by the parent (stdio fds 1+2), so this noise reaches nothing.
        `console.log('STDOUT_SECRET_7777');`,
        `console.error('STDERR_SECRET_8888');`,
        `export default defineEnv({ API_URL: string() });`,
      ].join('\n'),
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, { ...process.env });
    // fd 3 is a separate pipe, so the result parses cleanly despite the stdout/stderr noise…
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.facts.requiredKeys).toContain('API_URL');
    }
    // …and neither printed secret rides along in the framed result.
    expect(JSON.stringify(r)).not.toContain('STDOUT_SECRET_7777');
    expect(JSON.stringify(r)).not.toContain('STDERR_SECRET_8888');
  });
});

// ---------------------------------------------------------------------------
// `--skip-build` — every gate on this path reads the artifact `vite build`
// emits, so there is nothing to validate without a build. Reject the combination
// instead of silently ignoring the flag.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — --skip-build is rejected', () => {
  it('rejects --skip-build pre-account — no whoami / provision / build / migrate / deploy', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare', skipBuild: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Pre-account: no seam ran at all.
    expect(trace).toEqual([]);
    expect(wranglerArgs).toEqual([]);
  });

  it('rejects --skip-build even with --provision (nothing is provisioned)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(
        root,
        { platform: 'cloudflare', skipBuild: true, provision: true },
        silentCliLog,
        deps,
      ),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
    expect(wranglerArgs).toEqual([]);
  });

  it('explains that this backend validates the build artifact', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const messages: Array<string> = [];
    const restore = log.error;
    log.error = (msg: string) => {
      messages.push(msg);
    };
    try {
      const { deps } = harness();
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare', skipBuild: true }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      log.error = restore;
    }
    const joined = messages.join('\n');
    expect(joined).toContain('--skip-build');
    expect(joined).toContain('--platform cloudflare');
    expect(joined).toMatch(/validat/i);
  });
});

describe('runCloudflareDeploy — wrangler autoconfig disabled', () => {
  it('always passes --autoconfig=false so a framework marker cannot delegate the deploy', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'onext' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      // An OpenNext-style marker: wrangler's autoconfig would otherwise delegate the
      // deploy to another tool. --autoconfig=false makes that impossible.
      'open-next.config.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'onext' }, null, 2),
    });
    const { deps, wranglerArgs } = harness();
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    const deployArgs = wranglerArgs.find((a) => a[0] === 'deploy');
    expect(deployArgs).toContain('--autoconfig=false');
  });
});

// ---------------------------------------------------------------------------
// Wrangler-uploader hash pin: the credentialed remote migrate / deploy execute the
// resolved `wrangler-dist/cli.js` bundle (plus the sibling chunks it loads). The build
// runs untrusted project code that can only edit FILES — including that bundle — so the
// deploy snapshots its content hash before the build and re-checks it after, failing
// closed if it changed or cannot be verified.
// ---------------------------------------------------------------------------

describe('hashWranglerUploader — content hash of the wrangler uploader bundle dir', () => {
  const distDir = join(tmpDir, 'fake-wrangler-dist');

  /** Build a fake `wrangler-dist` dir and a resolver whose LAST argv element is its cli.js. */
  function makeFakeUploader(files: Record<string, string>): (root: string) => Array<string> {
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const abs = join(distDir, name);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    return () => [process.execPath, join(distDir, 'cli.js')];
  }

  it('is stable when nothing changes', () => {
    const resolveArgv = makeFakeUploader({ 'cli.js': 'entry', 'ProxyWorker.js': 'sibling' });
    const first = hashWranglerUploader(tmpDir, resolveArgv);
    expect(typeof first).toBe('string');
    expect(hashWranglerUploader(tmpDir, resolveArgv)).toBe(first);
  });

  it('changes when cli.js itself is overwritten', () => {
    const resolveArgv = makeFakeUploader({ 'cli.js': 'original' });
    const before = hashWranglerUploader(tmpDir, resolveArgv);
    writeFileSync(join(distDir, 'cli.js'), 'overwritten-by-build');
    expect(hashWranglerUploader(tmpDir, resolveArgv)).not.toBe(before);
  });

  it('changes when a SIBLING chunk cli.js loads is overwritten (whole-dir surface)', () => {
    const resolveArgv = makeFakeUploader({ 'cli.js': 'entry', 'ProxyWorker.js': 'sibling' });
    const before = hashWranglerUploader(tmpDir, resolveArgv);
    // cli.js is untouched; only the sibling changes — still caught.
    writeFileSync(join(distDir, 'ProxyWorker.js'), 'tampered-sibling');
    expect(hashWranglerUploader(tmpDir, resolveArgv)).not.toBe(before);
  });

  it('hashes linked files and tolerates a broken symlink without weakening pinning', () => {
    const resolveArgv = makeFakeUploader({ 'cli.js': 'entry', 'chunk.js': 'original' });
    symlinkSync('chunk.js', join(distDir, 'linked.js'));
    symlinkSync('missing.js', join(distDir, 'optional.js'));
    const before = hashWranglerUploader(tmpDir, resolveArgv);
    expect(before).toBeDefined();
    expect(hashWranglerUploader(tmpDir, resolveArgv)).toBe(before);
    writeFileSync(join(distDir, 'chunk.js'), 'changed');
    expect(hashWranglerUploader(tmpDir, resolveArgv)).not.toBe(before);
  });

  it('fails closed for a linked directory cycle', () => {
    const resolveArgv = makeFakeUploader({ 'cli.js': 'entry' });
    symlinkSync('.', join(distDir, 'loop'));
    expect(hashWranglerUploader(tmpDir, resolveArgv)).toBeUndefined();
  });

  it('returns undefined when the resolver throws (wrangler unresolvable → fail closed)', () => {
    const result = hashWranglerUploader(tmpDir, () => {
      throw new Error('cannot resolve wrangler');
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when the resolved entry does not exist', () => {
    const result = hashWranglerUploader(tmpDir, () => [
      process.execPath,
      join(tmpDir, 'nonexistent', 'cli.js'),
    ]);
    expect(result).toBeUndefined();
  });
});

describe('assertWranglerUploaderUnchanged', () => {
  it('passes when the before/after hashes match', () => {
    expect(assertWranglerUploaderUnchanged('abc123', 'abc123')).toEqual({ ok: true });
  });

  it('fails closed when the hash changed across the build', () => {
    const result = assertWranglerUploaderUnchanged('abc123', 'xyz789');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/modified the Cloudflare uploader/);
  });

  it('fails closed when the pre-build hash is undefined (unverifiable binary)', () => {
    const result = assertWranglerUploaderUnchanged(undefined, 'abc123');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cannot be verified/);
  });

  it('fails closed when the post-build hash is undefined', () => {
    const result = assertWranglerUploaderUnchanged('abc123', undefined);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cannot be verified/);
  });
});

// ---------------------------------------------------------------------------
// Native Cloudflare email step. The email module itself is unit-tested in
// email-cloudflare.test.ts on fakes; these tests pin the ORCHESTRATION: where the step sits,
// what it spawns, what it writes, what it prints, and what it never leaks.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — native Cloudflare email step', () => {
  const ZONE_ID = '5b66f5cb84fd7dcfdd0170515e622181';
  const BEARER = 'cfoa-SECRET-BEARER-TOKEN-0123456789abcdef';
  const BETA_WARNING = '▲ [WARNING] 🚧 `wrangler email x` is an open beta command.\n';

  /** A worker-bearing D1 app with one inbound handler and `email.from` on a subdomain. */
  function emailProject(
    wrangler: Record<string, unknown> = PROVISIONED_D1,
    extraFiles: Record<string, string> = {},
    voidJson: Record<string, unknown> = { email: { from: 'noreply@mail.acme.com' } },
  ): string {
    return makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify(voidJson),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'email/support+[ticket].ts': `export default async () => {};`,
      'wrangler.jsonc': JSON.stringify(wrangler, null, 2),
      ...INIT_MIGRATION,
      ...extraFiles,
    });
  }

  function readRootConfig(root: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')) as Record<
      string,
      unknown
    >;
  }

  const whoamiWithScopes = JSON.stringify({
    loggedIn: true,
    email: 'dev@acme.com',
    accounts: [{ id: 'acc123', name: 'Acme' }],
    tokenPermissions: ['account:read', 'email_routing:write', 'email_sending:write'],
  });

  function routingSettings(name: string, status: string): DeployWranglerRunResult {
    return {
      ...cleanExit,
      stdout: JSON.stringify({ name, enabled: true, status, tag: ZONE_ID }),
      stderr: BETA_WARNING,
    };
  }
  const zoneNotFound = (name: string): DeployWranglerRunResult => ({
    ...cleanExit,
    status: 1,
    stderr: `${BETA_WARNING}✘ [ERROR] Could not find zone for \`${name}\`. Make sure the domain exists in your account.\n`,
  });
  const noRules: DeployWranglerRunResult = {
    ...cleanExit,
    stdout: JSON.stringify([
      { enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] },
    ]),
    stderr: BETA_WARNING,
  };
  const myRule: DeployWranglerRunResult = {
    ...cleanExit,
    stdout: JSON.stringify([
      {
        id: '1a2b3c',
        name: 'support',
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: 'support@mail.acme.com' }],
        actions: [{ type: 'worker', value: ['myapp'] }],
      },
      { enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] },
    ]),
    stderr: BETA_WARNING,
  };
  const sendingNotFound: DeployWranglerRunResult = {
    ...cleanExit,
    status: 1,
    stderr: `${BETA_WARNING}✘ [ERROR] No sending subdomain found for \`mail.acme.com\`. Run \`wrangler email sending list mail.acme.com\` to see configured subdomains.\n`,
  };
  const sendingEnabled: DeployWranglerRunResult = {
    ...cleanExit,
    stdout: JSON.stringify({
      name: 'mail.acme.com',
      enabled: true,
      tag: '19af4fdbee924a92916afea0de5a8fdd',
    }),
    stderr: BETA_WARNING,
  };

  type Spawn = { args: Array<string>; opts: { capture: boolean } };

  /**
   * A deploy runner keyed on the wrangler argv WITHOUT the `-c <cfg> --env=` context (asserted
   * separately): the `whoami` / `auth token` / `email …` table for a first deploy,
   * overridable per test. Unknown commands exit clean, as the base harness does.
   */
  function emailRunner(
    overrides: Record<string, DeployWranglerRunResult>,
    spawns: Array<Spawn>,
    trace: Array<string>,
  ): DeployWranglerRun {
    const table: Record<string, DeployWranglerRunResult> = {
      'whoami --json': { ...cleanExit, stdout: whoamiWithScopes },
      'auth token --json': {
        ...cleanExit,
        stdout: JSON.stringify({ type: 'oauth', token: BEARER }, null, 2),
      },
      'email routing settings mail.acme.com': zoneNotFound('mail.acme.com'),
      'email routing settings acme.com': routingSettings('acme.com', 'ready'),
      'email routing rules list acme.com': noRules,
      'email sending settings mail.acme.com': sendingNotFound,
      'email sending enable mail.acme.com': { ...cleanExit, stderr: BETA_WARNING },
      ...overrides,
    };
    return operationFixture((args, opts) => {
      spawns.push({ args: [...args], opts: { ...opts } });
      trace.push(`wrangler:${args.slice(0, 2).join(' ')}`);
      const bare: Array<string> = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '-c') {
          i += 1;
          continue;
        }
        if (args[i] === '--env=') {
          continue;
        }
        bare.push(args[i] as string);
      }
      const hit = table[bare.join(' ')];
      if (hit) {
        return hit;
      }
      if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'list') {
        return { ...cleanExit, stdout: '✅ No migrations to apply!\n' };
      }
      return cleanExit;
    });
  }

  type FetchCall = { method: string; path: string; body: string | undefined; auth: string };

  /** The two bearer calls (+ the two preflight GETs), keyed `METHOD /zones…`; 200s by default. */
  function emailFetch(
    calls: Array<FetchCall>,
    overrides: Record<string, () => Response> = {},
    subaddressing = false,
  ): typeof fetch {
    const ok = (result: unknown) => () =>
      new Response(JSON.stringify({ success: true, result }), { status: 200 });
    const table: Record<string, () => Response> = {
      'GET /zones?name=acme.com': ok([
        { id: ZONE_ID, name: 'acme.com', type: 'full', account: { id: 'acc123' } },
      ]),
      [`GET /zones/${ZONE_ID}/email/routing`]: ok({
        enabled: true,
        support_subaddress: subaddressing,
      }),
      [`POST /zones/${ZONE_ID}/email/routing/dns`]: ok({ enabled: true }),
      [`PATCH /zones/${ZONE_ID}/email/routing`]: ok({ support_subaddress: true }),
      ...overrides,
    };
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.slice(url.indexOf('/zones'));
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method,
        path,
        body: typeof init?.body === 'string' ? init.body : undefined,
        auth: headers.Authorization ?? '',
      });
      const hit = table[`${method} ${path}`];
      if (!hit) {
        throw new Error(`unexpected fetch: ${method} ${path}`);
      }
      return hit();
    }) as typeof fetch;
  }

  /** Public DNS for a first deploy: Google MX on the apex, nothing on the subdomain yet. */
  function emailDns(mx: Record<string, Array<string>> = {}): EmailDns {
    const noData = (): Error => Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    const records: Record<string, Array<string>> = {
      'acme.com': ['aspmx.l.google.com'],
      ...mx,
    };
    return {
      resolveMx: async (name) => {
        const list = records[name];
        if (!list || list.length === 0) {
          throw noData();
        }
        return list.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
      },
      resolveTxt: async () => {
        throw noData();
      },
    };
  }

  /** Capture EVERYTHING the deploy prints (clack log + raw stdio) for leak / message asserts. */
  function captureOutput(): { lines: Array<string>; restore: () => void } {
    const lines: Array<string> = [];
    const spies = (['message', 'info', 'warn', 'error', 'success', 'step'] as const).map((level) =>
      vi.spyOn(log, level).mockImplementation(((...args: Array<unknown>) => {
        lines.push(args.map(String).join(' '));
      }) as never),
    );
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    return {
      lines,
      restore: () => {
        for (const spy of spies) {
          spy.mockRestore();
        }
        out.mockRestore();
        err.mockRestore();
      },
    };
  }

  /** The harness, with the email seams wired to these fakes. */
  function emailHarness(
    options: {
      runner?: Record<string, DeployWranglerRunResult>;
      fetchOverrides?: Record<string, () => Response>;
      subaddressing?: boolean;
      dns?: EmailDns;
      confirm?: (message: string) => Promise<boolean>;
      isCI?: boolean;
      deps?: Partial<CloudflareDeployDeps>;
    } = {},
  ) {
    const spawns: Array<Spawn> = [];
    const fetchCalls: Array<FetchCall> = [];
    const confirms: Array<string> = [];
    const trace: Array<string> = [];
    const base = harness({
      isCI: options.isCI ?? false,
      hashWranglerUploader: () => {
        trace.push('hash');
        return 'uploader-hash-unchanged';
      },
      resolveSchemaFacts: (() => {
        trace.push('probe');
        return okSchemaFacts();
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
      runBuild: () => {
        trace.push('build');
      },
      runWrangler: emailRunner(options.runner ?? {}, spawns, trace),
      emailFetch: emailFetch(fetchCalls, options.fetchOverrides, options.subaddressing),
      emailDns: options.dns ?? emailDns(),
      confirmEmailSetup:
        options.confirm ??
        (async (message) => {
          confirms.push(message);
          return true;
        }),
      ...options.deps,
    });
    return { ...base, spawns, fetchCalls, confirms, trace };
  }

  const configArgs = (root: string): Array<string> => [
    '-c',
    toSlash(join(root, 'wrangler.jsonc')),
    '--env=',
  ];

  it('first deploy, one Enter: preflight → checklist → confirm → apply → write → re-parse → deploy', async () => {
    const root = emailProject();
    const { deps, spawns, fetchCalls, confirms, trace, exitCalls } = emailHarness();
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);

    // ONE prompt, default-Yes wording, naming the mail domain.
    expect(confirms).toEqual(['Set up email on mail.acme.com?']);

    // Exact argv per branch — every email call carries the SAME `-c <cfg> --env=` context as
    // whoami / migrate / deploy, and is captured (its JSON is read, never streamed).
    const emailSpawns = spawns.filter((s) => s.args[0] === 'email');
    expect(emailSpawns.map((s) => s.args)).toEqual([
      ['email', 'routing', 'settings', 'mail.acme.com', ...configArgs(root)],
      ['email', 'routing', 'settings', 'acme.com', ...configArgs(root)],
      ['email', 'routing', 'rules', 'list', 'acme.com', ...configArgs(root)],
      ['email', 'sending', 'settings', 'mail.acme.com', ...configArgs(root)],
      ['email', 'sending', 'enable', 'mail.acme.com', ...configArgs(root)],
    ]);
    for (const spawn of emailSpawns) {
      expect(spawn.opts.capture).toBe(true);
    }
    // The two bearer writes wrangler has no command for (subdomain routing + subaddressing).
    expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([
      {
        method: 'POST',
        path: `/zones/${ZONE_ID}/email/routing/dns`,
        body: JSON.stringify({ name: 'mail.acme.com' }),
        auth: `Bearer ${BEARER}`,
      },
      {
        method: 'PATCH',
        path: `/zones/${ZONE_ID}/email/routing`,
        body: JSON.stringify({ support_subaddress: true }),
        auth: `Bearer ${BEARER}`,
      },
    ]);

    // The root config now carries the binding, the owned addresses array, and the sender var.
    const written = readRootConfig(root);
    expect(written.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect(written.addresses).toEqual(['support@mail.acme.com']);
    expect((written.vars as Record<string, string>).__VOID_EMAIL_FROM).toBe(
      'noreply@mail.acme.com',
    );
    // …and the deploy went through: `rootConfig` was re-parsed after the write, or the
    // laundering guard (6a) would have rejected `send_email` / `addresses` as probe-injected.
    expect(trace).toContain('build');
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);

    // The checklist, the apply rows, and the post-deploy address map were printed.
    const printed = output.lines.join('\n');
    expect(printed).toContain(
      'This changes YOUR Cloudflare account. acme.com itself is not touched.',
    );
    expect(printed).toContain('✔ routing   mail.acme.com enabled');
    expect(printed).toContain('✔ config    void.lock.json updated');
    expect(printed).toContain('inbound   support@mail.acme.com  →  email/support+[ticket].ts');
    expect(printed).toContain('outbound  sendEmail() from noreply@mail.acme.com');
  });

  it('runs AFTER the uploader hash and BEFORE the env-schema probe (no project code has run)', async () => {
    const root = emailProject();
    const { deps, trace } = emailHarness();
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    const firstEmailCall = trace.findIndex((t) => t.startsWith('wrangler:'));
    const lastEmailCall = trace.lastIndexOf('wrangler:email sending');
    expect(trace[firstEmailCall]).toBe('wrangler:whoami --json');
    expect(trace.indexOf('hash')).toBeLessThan(firstEmailCall);
    expect(lastEmailCall).toBeGreaterThan(firstEmailCall);
    // The probe (3c) — the first project-code execution — comes only after the whole step.
    expect(trace.indexOf('probe')).toBeGreaterThan(lastEmailCall);
    expect(trace.indexOf('probe')).toBeLessThan(trace.indexOf('build'));
  });

  it('borrows the bearer via `auth token --json` and never leaks it', async () => {
    const root = emailProject();
    const { deps, spawns, fetchCalls } = emailHarness();
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    const authSpawns = spawns.filter((s) => s.args[0] === 'auth');
    expect(authSpawns.length).toBeGreaterThan(0);
    for (const spawn of authSpawns) {
      expect(spawn.args).toEqual(['auth', 'token', '--json', ...configArgs(root)]);
      expect(spawn.opts).toEqual({ capture: true });
    }
    // The token reached the Authorization header — and NOTHING else.
    expect(fetchCalls.some((c) => c.auth === `Bearer ${BEARER}`)).toBe(true);
    expect(output.lines.join('\n')).not.toContain(BEARER);
    for (const spawn of spawns) {
      expect(JSON.stringify(spawn.args)).not.toContain(BEARER);
    }
    expect(
      Object.values(process.env).some((v) => typeof v === 'string' && v.includes(BEARER)),
    ).toBe(false);
  });

  it('a failed `auth token` yields no bearer: the dashboard fallback is printed, addresses withheld, deploy continues', async () => {
    const root = emailProject();
    const { deps, spawns, exitCalls } = emailHarness({
      runner: {
        'auth token --json': {
          ...cleanExit,
          status: 1,
          stderr: '✘ [ERROR] Not logged in. Please run `wrangler login` to authenticate.\n',
        },
      },
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    const printed = output.lines.join('\n');
    expect(printed).toContain('Email → Settings → Subdomains');
    expect(printed).toContain('addresses withheld this run');
    // Sending still onboarded, so the binding + sender var are written; the key is NOT.
    const written = readRootConfig(root);
    expect(written.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect(written.addresses).toBeUndefined();
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
  });

  it('--require-email fails when the apply wrote the binding but routing failed and addresses were withheld', async () => {
    // The SAME run as the test above, with the flag: `auth token` fails, so the subdomain
    // routing POST is never made and `addresses` is withheld. The worker would ship a
    // SEND_EMAIL binding with NO inbound rule behind it — binding presence is not "set up".
    const root = emailProject();
    const { deps, spawns, exitCalls, trace } = emailHarness({
      runner: {
        'auth token --json': {
          ...cleanExit,
          status: 1,
          stderr: '✘ [ERROR] Not logged in. Please run `wrangler login` to authenticate.\n',
        },
      },
    });
    const output = captureOutput();
    try {
      await expect(
        runCloudflareDeploy(
          root,
          { platform: 'cloudflare', requireEmail: true },
          silentCliLog,
          deps,
        ),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([1]);
    const printed = output.lines.join('\n');
    expect(printed).toContain('addresses withheld this run');
    expect(printed).toContain('--require-email');
    // Nothing was built or uploaded; the config still records what the apply did manage.
    expect(trace).not.toContain('probe');
    expect(trace).not.toContain('build');
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(false);
    const written = readRootConfig(root);
    expect(written.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect(written.addresses).toBeUndefined();
  });

  it('CI / non-TTY: prints the checklist + `void email setup` line, asks nothing, writes nothing, deploys without email', async () => {
    const root = emailProject();
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const { deps, spawns, fetchCalls, exitCalls, trace } = emailHarness({
      isCI: true,
      confirm: async () => {
        throw new Error('confirm must not be called in CI');
      },
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    const printed = output.lines.join('\n');
    expect(printed).toContain('This changes YOUR Cloudflare account.');
    expect(printed).toContain(
      'Run `void email setup --platform cloudflare` once locally, commit void.lock.json, then redeploy',
    );
    // No apply: no bearer writes, no `sending enable`, no config write.
    expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(spawns.some((s) => s.args[0] === 'email' && s.args[2] === 'enable')).toBe(false);
    // The deploy still pins name/account_id in the config, so compare the email keys, not the bytes.
    const after = readRootConfig(root);
    expect(after.send_email).toBeUndefined();
    expect(after.addresses).toBeUndefined();
    expect(after.vars).toBeUndefined();
    expect(JSON.parse(before)).toMatchObject({ name: 'myapp', account_id: 'acc123' });
    // The deploy itself went on.
    expect(trace).toContain('build');
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
    expect(printed).not.toContain('inbound   support@mail.acme.com');
  });

  it('--require-email in CI fails BEFORE the probe, the build, and any upload', async () => {
    const root = emailProject();
    const { deps, spawns, exitCalls, trace } = emailHarness({ isCI: true });
    const output = captureOutput();
    try {
      await expect(
        runCloudflareDeploy(
          root,
          { platform: 'cloudflare', requireEmail: true },
          silentCliLog,
          deps,
        ),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('probe');
    expect(trace).not.toContain('build');
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(false);
    expect(output.lines.join('\n')).toContain('--require-email');
  });

  it('--require-email also fails when the developer answers No at the prompt', async () => {
    const root = emailProject();
    const { deps, exitCalls, trace } = emailHarness({ confirm: async () => false });
    const output = captureOutput();
    try {
      await expect(
        runCloudflareDeploy(
          root,
          { platform: 'cloudflare', requireEmail: true },
          silentCliLog,
          deps,
        ),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('build');
    expect(readRootConfig(root).send_email).toBeUndefined();
  });

  it('a preflight blocker (session without the email scopes) prints why and deploys without email', async () => {
    const root = emailProject();
    const { deps, spawns, confirms, exitCalls } = emailHarness({
      runner: {
        'whoami --json': {
          ...cleanExit,
          stdout: JSON.stringify({
            loggedIn: true,
            accounts: [],
            email: 'dev@acme.com',
            tokenPermissions: [],
          }),
        },
      },
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(confirms).toEqual([]);
    const printed = output.lines.join('\n');
    expect(printed).toContain('email_routing:write + email_sending:write');
    // The checklist goes through `formatCloudflareUserMessage` on this path, which turns a
    // `wrangler …` command into "the underlying Cloudflare operation" — so the guidance must
    // already be a Void command at the source to survive as guidance.
    expect(printed).toContain('run `void cloudflare logout`, then `void cloudflare login`');
    expect(printed).not.toContain('underlying Cloudflare operation');
    expect(printed).toContain('deploying without email');
    // Nothing past whoami was asked of wrangler for email, and nothing was written.
    expect(spawns.some((s) => s.args[0] === 'email')).toBe(false);
    expect(readRootConfig(root).send_email).toBeUndefined();
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
  });

  it('no `email.from`: explains automatic setup is skipped (no wrangler email call)', async () => {
    const root = emailProject(PROVISIONED_D1, {}, {});
    const { deps, spawns, exitCalls } = emailHarness();
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(output.lines.join('\n')).toContain(
      'Set email.from to "you@mail.acme.com" in void.config.ts',
    );
    expect(spawns.some((s) => s.args[0] === 'email' || s.args[0] === 'auth')).toBe(false);
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
  });

  it('no email.from preserves restricted manual email configuration without claiming email is absent or ready', async () => {
    const root = emailProject(
      {
        ...PROVISIONED_D1,
        send_email: [
          {
            name: 'SEND_EMAIL',
            allowed_sender_addresses: ['support@mail.acme.com'],
            allowed_destination_addresses: ['owner@acme.com'],
          },
        ],
        addresses: ['support@mail.acme.com'],
        vars: { __VOID_EMAIL_FROM: 'support@mail.acme.com' },
      },
      {},
      {},
    );
    const before = readRootConfig(root);
    const { deps, spawns, fetchCalls, confirms, trace, exitCalls } = emailHarness();
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(confirms).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(spawns.some((spawn) => spawn.args[0] === 'email' || spawn.args[0] === 'auth')).toBe(
      false,
    );
    expect(trace).toContain('build');
    expect(spawns.some((spawn) => spawn.args[0] === 'deploy')).toBe(true);
    const after = readRootConfig(root);
    expect(after.send_email).toEqual(before.send_email);
    expect(after.addresses).toEqual(before.addresses);
    expect(after.vars).toEqual(before.vars);
    const printed = output.lines.join('\n');
    expect(printed).toContain('skipping automatic email setup');
    expect(printed).toContain('Existing Cloudflare email configuration is preserved.');
    expect(printed).not.toContain('deploying without email');
    expect(printed).not.toContain('email on mail.acme.com is ready');
  });

  it('require-email still refuses unverified manual configuration without email.from before build or upload', async () => {
    const root = emailProject(
      {
        ...PROVISIONED_D1,
        send_email: [
          {
            name: 'SEND_EMAIL',
            allowed_sender_addresses: ['support@mail.acme.com'],
            allowed_destination_addresses: ['owner@acme.com'],
          },
        ],
        addresses: ['support@mail.acme.com'],
      },
      {},
      {},
    );
    const before = readRootConfig(root);
    const { deps, spawns, fetchCalls, confirms, trace, exitCalls } = emailHarness();
    const output = captureOutput();
    try {
      await expect(
        runCloudflareDeploy(
          root,
          { platform: 'cloudflare', requireEmail: true },
          silentCliLog,
          deps,
        ),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([1]);
    expect(confirms).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(spawns.some((spawn) => spawn.args[0] === 'email' || spawn.args[0] === 'auth')).toBe(
      false,
    );
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('provision');
    expect(spawns.some((spawn) => spawn.args[0] === 'deploy')).toBe(false);
    expect(readRootConfig(root)).toEqual(before);
    const printed = output.lines.join('\n');
    expect(printed).toContain('Existing Cloudflare email configuration is preserved.');
    expect(printed).toContain('--require-email');
    expect(printed).toContain('Nothing was built or uploaded.');
  });

  it('second deploy, everything ready: no prompt, no write, no bearer write, address map printed', async () => {
    const root = emailProject({
      ...PROVISIONED_D1,
      send_email: [{ name: 'SEND_EMAIL' }],
      addresses: ['support@mail.acme.com'],
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
    });
    const before = readRootConfig(root);
    const { deps, spawns, fetchCalls, exitCalls } = emailHarness({
      runner: {
        'email routing rules list acme.com': myRule,
        'email sending settings mail.acme.com': sendingEnabled,
      },
      subaddressing: true,
      dns: emailDns({ 'mail.acme.com': ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'] }),
      confirm: async () => {
        throw new Error('confirm must not be called when every row is ready');
      },
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(spawns.some((s) => s.args[0] === 'email' && s.args[2] === 'enable')).toBe(false);
    const after = readRootConfig(root);
    expect(after.send_email).toEqual(before.send_email);
    expect(after.addresses).toEqual(before.addresses);
    expect(after.vars).toEqual(before.vars);
    const printed = output.lines.join('\n');
    expect(printed).not.toContain('This changes YOUR Cloudflare account');
    expect(printed).toContain('inbound   support@mail.acme.com  →  email/support+[ticket].ts');
    expect(printed).toContain('outbound  sendEmail() from noreply@mail.acme.com');
    expect(printed).not.toContain('verified destinations only');
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
  });

  it('a hand-written `addresses` array Void did not derive skips the step, array untouched', async () => {
    const root = emailProject({ ...PROVISIONED_D1, addresses: ['ceo@acme.com'] });
    const { deps, spawns, confirms, exitCalls } = emailHarness();
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(confirms).toEqual([]);
    expect(output.lines.join('\n')).toContain('ceo@acme.com');
    expect(readRootConfig(root).addresses).toEqual(['ceo@acme.com']);
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
  });

  /** The committed email config a first deploy leaves behind. */
  const COMMITTED_EMAIL = {
    ...PROVISIONED_D1,
    send_email: [{ name: 'SEND_EMAIL' }],
    addresses: ['support@mail.acme.com'],
    vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
  };
  /** Every account row ready: routing on the subdomain, subaddressing on, sending onboarded. */
  const readyRows = {
    runner: { 'email sending settings mail.acme.com': sendingEnabled },
    subaddressing: true,
    dns: emailDns({ 'mail.acme.com': ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'] }),
    confirm: async () => {
      throw new Error('confirm must not be called when every account row is ready');
    },
  };

  it('preserves setup output and stops before build while the local resolver still sees no subdomain MX', async () => {
    const root = emailProject();
    const setupSpawns: Array<Spawn> = [];
    const setupTrace: Array<string> = [];
    const setupFetchCalls: Array<FetchCall> = [];

    await runEmailCloudflareCommand(
      root,
      { subcommand: 'setup', platform: 'cloudflare' },
      {
        runWrangler: emailRunner({}, setupSpawns, setupTrace),
        fetchImpl: emailFetch(setupFetchCalls),
        dns: emailDns(),
        isInteractive: true,
        confirm: async () => true,
        print: () => {},
        exit: (code): never => {
          throw new ExitError(code);
        },
      },
    );

    expect(readRootConfig(root)).toMatchObject({
      send_email: [{ name: 'SEND_EMAIL' }],
      addresses: ['support@mail.acme.com'],
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
    });
    expect(
      setupFetchCalls.filter((call) => call.method !== 'GET').map((call) => call.method),
    ).toEqual(['POST', 'PATCH']);
    const afterSetup = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');

    const baseDns = emailDns();
    const dnsCases: Array<{ name: string; dns: EmailDns }> = [
      { name: 'ENODATA', dns: emailDns() },
      {
        name: 'lookup failure',
        dns: {
          ...baseDns,
          resolveMx: async (name) => {
            if (name === 'mail.acme.com') {
              throw new Error('SERVFAIL');
            }
            return baseDns.resolveMx(name);
          },
        },
      },
    ];
    for (const dnsCase of dnsCases) {
      // The setup calls returned success, but this process still cannot verify the new MX.
      const { deps, spawns, exitCalls, trace } = emailHarness({
        subaddressing: true,
        dns: dnsCase.dns,
        isCI: true,
      });
      const output = captureOutput();
      try {
        await expect(
          runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
        ).rejects.toBeInstanceOf(ExitError);
      } finally {
        output.restore();
      }

      expect(exitCalls, dnsCase.name).toEqual([1]);
      expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'), dnsCase.name).toBe(afterSetup);
      expect(trace, dnsCase.name).not.toContain('probe');
      expect(trace, dnsCase.name).not.toContain('build');
      expect(
        spawns.some((spawn) => spawn.args[0] === 'deploy'),
        dnsCase.name,
      ).toBe(false);
      const printed = output.lines.join('\n');
      expect(printed, dnsCase.name).toContain('cannot verify Email Routing on mail.acme.com');
      expect(printed, dnsCase.name).toContain(
        'existing addresses plan in wrangler.jsonc is preserved',
      );
      expect(printed, dnsCase.name).toContain(
        'DNS may still be propagating after `void email setup`',
      );
      expect(printed, dnsCase.name).toContain('Nothing was built or uploaded');
    }
  });

  it('an API-token session (CLOUDFLARE_API_TOKEN) in CI with a committed config: --require-email passes, no prompt, map printed', async () => {
    // The CI credential. wrangler reports no `tokenPermissions` for it (they come from the
    // stored login file), so gating on them would fail every CI deploy before the build.
    const root = emailProject(COMMITTED_EMAIL);
    const { deps, spawns, fetchCalls, exitCalls, trace } = emailHarness({
      ...readyRows,
      runner: {
        ...readyRows.runner,
        'whoami --json': {
          ...cleanExit,
          stdout: JSON.stringify({
            loggedIn: true,
            authType: 'User API Token',
            accounts: [{ id: 'acc123', name: 'Acme' }],
          }),
        },
        'auth token --json': {
          ...cleanExit,
          stdout: JSON.stringify({ type: 'api_token', token: BEARER }),
        },
        'email routing rules list acme.com': myRule,
      },
      isCI: true,
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(
        root,
        { platform: 'cloudflare', requireEmail: true },
        silentCliLog,
        deps,
      );
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(spawns.some((s) => s.args[0] === 'email' && s.args[2] === 'enable')).toBe(false);
    expect(trace).toContain('build');
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
    const printed = output.lines.join('\n');
    expect(printed).not.toContain('wrangler login');
    expect(printed).toContain('inbound   support@mail.acme.com  →  email/support+[ticket].ts');
  });

  it('committed config, rule not created yet (right after `void email setup`): CI + --require-email proceeds, the map says the deploy creates it', async () => {
    const root = emailProject(COMMITTED_EMAIL);
    const { deps, spawns, exitCalls, trace } = emailHarness({ ...readyRows, isCI: true });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(
        root,
        { platform: 'cloudflare', requireEmail: true },
        silentCliLog,
        deps,
      );
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(trace).toContain('build');
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
    const printed = output.lines.join('\n');
    expect(printed).not.toContain('deploying without email');
    expect(printed).not.toContain('This changes YOUR Cloudflare account');
    expect(printed).toContain(
      'inbound   support@mail.acme.com  →  email/support+[ticket].ts   (rule created by this deploy)',
    );
    expect(readRootConfig(root).addresses).toEqual(['support@mail.acme.com']);
  });

  /** wrangler's `sending enable` on Workers Free: the documented not-entitled code. */
  const sendingRefused: DeployWranglerRunResult = {
    ...cleanExit,
    status: 1,
    stderr: `${BETA_WARNING}✘ [ERROR] A request to the Cloudflare API (/zones/${ZONE_ID}/email/sending/subdomains) failed.\n\n  something went wrong [code: 10105]\n`,
  };

  it('--require-email passes on Workers Free: routing is up, `sending enable` answers 10105, the binding written alongside remembers it', async () => {
    // Every other row is ready; only Email Sending is refused (no entitlement). Inbound is
    // complete — replies go through the native `message.reply()`, never the binding — and
    // the apply writes the binding, which is what the NEXT preflight reads as the memory of
    // this refusal (binding present + sending pending is settled; the memory rule in
    // `preflightEmail`). So `satisfied` carries no sending term of its own: the deploy
    // proceeds, the hint is printed once, and the map says what sending can do.
    const root = emailProject();
    const { deps, spawns, exitCalls, trace } = emailHarness({
      ...readyRows,
      runner: { 'email sending enable mail.acme.com': sendingRefused },
      confirm: async () => true,
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(
        root,
        { platform: 'cloudflare', requireEmail: true },
        silentCliLog,
        deps,
      );
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    const printed = output.lines.join('\n');
    expect(printed).toContain('[code: 10105]');
    expect(printed).toContain(SENDING_FREE_PLAN_HINT);
    expect(printed).not.toContain('--require-email');
    expect(printed).toContain(
      'outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
    );
    expect(trace).toContain('build');
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
    // Inbound DID come up, and the config records it — with the binding that remembers.
    const written = readRootConfig(root);
    expect(written.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect(written.addresses).toEqual(['support@mail.acme.com']);
    expect(written.vars).toEqual({ __VOID_EMAIL_FROM: 'noreply@mail.acme.com' });
  });

  /**
   * A Workers Free account after the deploy above: the email config is committed and sending
   * still answers not-found. The committed binding records the refusal, so later deploys read
   * ready and never retry the onboarding; `void email setup` offers that retry.
   */
  const COMMITTED_ON_FREE = {
    ...readyRows,
    runner: {
      'email routing rules list acme.com': myRule,
      'email sending settings mail.acme.com': sendingNotFound,
    },
  };

  for (const [shell, isCI] of [
    ['CI', true],
    ['a TTY', false],
  ] as const) {
    it(`Workers Free, committed config, ${shell} + --require-email: the refusal is remembered — no prompt, no \`sending enable\`, the deploy proceeds`, async () => {
      const root = emailProject(COMMITTED_EMAIL);
      const before = readRootConfig(root);
      const { deps, spawns, fetchCalls, confirms, exitCalls, trace } = emailHarness({
        ...COMMITTED_ON_FREE,
        isCI,
        // Record the prompt instead of throwing on it, so the assertion names the failure.
        confirm: undefined,
      });
      const output = captureOutput();
      try {
        await runCloudflareDeploy(
          root,
          { platform: 'cloudflare', requireEmail: true },
          silentCliLog,
          deps,
        );
      } finally {
        output.restore();
      }
      expect(exitCalls).toEqual([]);
      expect(confirms).toEqual([]);
      // The probe of sending still runs (read-only); the onboarding is NOT retried.
      expect(spawns.some((s) => s.args[0] === 'email' && s.args[1] === 'sending')).toBe(true);
      expect(spawns.some((s) => s.args[0] === 'email' && s.args[2] === 'enable')).toBe(false);
      expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([]);
      const printed = output.lines.join('\n');
      expect(printed).not.toContain('This changes YOUR Cloudflare account');
      expect(printed).not.toContain('cannot ask');
      expect(printed).not.toContain('deploying without email');
      expect(printed).not.toContain('--require-email');
      expect(printed).not.toContain('[code: 10105]');
      expect(printed).toContain('inbound   support@mail.acme.com  →  email/support+[ticket].ts');
      expect(printed).toContain(
        'outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
      );
      expect(trace).toContain('build');
      expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
      // The committed config is left exactly as the refused run wrote it.
      const after = readRootConfig(root);
      expect(after.send_email).toEqual(before.send_email);
      expect(after.addresses).toEqual(before.addresses);
      expect(after.vars).toEqual(before.vars);
    });
  }

  it('--require-email passes on a fully ready second deploy: nothing to apply, zero keystrokes', async () => {
    // The headline flow. No apply runs, so readiness comes from the PREFLIGHT result.
    const root = emailProject(COMMITTED_EMAIL);
    const { deps, spawns, fetchCalls, confirms, exitCalls, trace } = emailHarness({
      ...readyRows,
      runner: { ...readyRows.runner, 'email routing rules list acme.com': myRule },
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(
        root,
        { platform: 'cloudflare', requireEmail: true },
        silentCliLog,
        deps,
      );
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(confirms).toEqual([]);
    expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(spawns.some((s) => s.args[0] === 'email' && s.args[2] === 'enable')).toBe(false);
    expect(trace).toContain('build');
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
    expect(output.lines.join('\n')).not.toContain('--require-email');
  });

  it('ready path: a committed `addresses` entry no longer in the pruned set is rewritten BEFORE `wrangler deploy`, without a prompt', async () => {
    // Deploy 1 wrote [support, billing]; billing@ was later re-pointed at a forward in the
    // dashboard. Left in the array it reaches wrangler's plan as a takeover `conflict`.
    const forwardedBilling: DeployWranglerRunResult = {
      ...myRule,
      stdout: JSON.stringify([
        ...JSON.parse(myRule.stdout),
        {
          id: '4d5e6f',
          name: '(none)',
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: 'billing@mail.acme.com' }],
          actions: [{ type: 'forward', value: ['ceo@gmail.com'] }],
        },
      ]),
    };
    const root = emailProject(
      { ...COMMITTED_EMAIL, addresses: ['support@mail.acme.com', 'billing@mail.acme.com'] },
      { 'email/billing.ts': 'export default async () => {};' },
    );
    const atDeploy: Array<unknown> = [];
    const { deps, spawns, fetchCalls, exitCalls } = emailHarness({
      ...readyRows,
      runner: { ...readyRows.runner, 'email routing rules list acme.com': forwardedBilling },
    });
    const inner = deps.runWrangler!;
    deps.runWrangler = (operation, opts) => {
      if (operation.type === 'worker.deploy') {
        atDeploy.push(readRootConfig(root).addresses);
      }
      return inner(operation, opts);
    };
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(spawns.some((s) => s.args[0] === 'email' && s.args[2] === 'enable')).toBe(false);
    // Rewritten to the pruned set, and already so when `wrangler deploy` read the config.
    expect(atDeploy).toEqual([['support@mail.acme.com']]);
    const after = readRootConfig(root);
    expect(after.addresses).toEqual(['support@mail.acme.com']);
    expect(after.send_email).toEqual(COMMITTED_EMAIL.send_email);
    expect(after.vars).toEqual(COMMITTED_EMAIL.vars);
    const printed = output.lines.join('\n');
    expect(printed).toContain('billing@mail.acme.com: already routed to forward:ceo@gmail.com');
    expect(printed).toContain('wrangler.jsonc updated (addresses: ["support@mail.acme.com"])');
    expect(printed).toContain('inbound   support@mail.acme.com  →  email/support+[ticket].ts');
  });

  it('ready path: after a worker rename every rule is foreign, so the `addresses` key is removed (never `[]`)', async () => {
    const root = emailProject({ ...COMMITTED_EMAIL, name: 'acme-mail' });
    const { deps, spawns, exitCalls } = emailHarness({
      ...readyRows,
      runner: { ...readyRows.runner, 'email routing rules list acme.com': myRule },
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    const after = readRootConfig(root);
    expect(after.addresses).toBeUndefined();
    expect(after.send_email).toEqual(COMMITTED_EMAIL.send_email);
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
    expect(output.lines.join('\n')).toContain('wrangler.jsonc updated (addresses removed)');
  });

  it('ready path: a changed `email.from` on the same domain rewrites `__VOID_EMAIL_FROM` without a prompt', async () => {
    // Only the root var reaches the worker on build; without the rewrite the worker keeps
    // sending as the old address while the map advertises the new one.
    const root = emailProject(COMMITTED_EMAIL, {}, { email: { from: 'hello@mail.acme.com' } });
    const { deps, spawns, fetchCalls, exitCalls } = emailHarness({
      ...readyRows,
      runner: { ...readyRows.runner, 'email routing rules list acme.com': myRule },
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(spawns.some((s) => s.args[0] === 'email' && s.args[2] === 'enable')).toBe(false);
    const after = readRootConfig(root);
    expect((after.vars as Record<string, string>).__VOID_EMAIL_FROM).toBe('hello@mail.acme.com');
    expect(after.addresses).toEqual(['support@mail.acme.com']);
    expect(after.send_email).toEqual(COMMITTED_EMAIL.send_email);
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
    const printed = output.lines.join('\n');
    expect(printed).toContain(
      'wrangler.jsonc updated (vars.__VOID_EMAIL_FROM: "hello@mail.acme.com")',
    );
    expect(printed).toContain('outbound  sendEmail() from hello@mail.acme.com');
  });

  it('a committed `addresses` array is still withdrawn when a separate blocker proves setup cannot proceed', async () => {
    // Left in place, wrangler's plan on it 400s (2062) AFTER the upload, on every deploy.
    // Deleting the KEY changes no rule (wrangler skips the plan on `undefined`).
    const root = emailProject(COMMITTED_EMAIL);
    const baseDns = emailDns();
    // Even with an unreadable MX, `unlocked` is independent evidence that this is not only a
    // propagating DNS answer, so the preservation exception must not hide the stable blocker.
    const { deps, spawns, fetchCalls, confirms, exitCalls, trace } = emailHarness({
      runner: { 'email routing settings acme.com': routingSettings('acme.com', 'unlocked') },
      dns: {
        ...baseDns,
        resolveMx: async (name) => {
          if (name === 'mail.acme.com') {
            throw new Error('SERVFAIL');
          }
          return baseDns.resolveMx(name);
        },
      },
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(confirms).toEqual([]);
    expect(fetchCalls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(spawns.some((spawn) => spawn.args[0] === 'email' && spawn.args[2] === 'enable')).toBe(
      false,
    );
    const after = readRootConfig(root);
    expect(after.addresses).toBeUndefined();
    expect(after.send_email).toEqual(COMMITTED_EMAIL.send_email);
    expect(after.vars).toEqual(COMMITTED_EMAIL.vars);
    expect(trace).toContain('build');
    expect(spawns.some((spawn) => spawn.args[0] === 'deploy')).toBe(true);
    const printed = output.lines.join('\n');
    expect(printed).toContain('addresses removed from wrangler.jsonc');
    expect(printed).toContain('support@mail.acme.com');
    // The binding is committed, so the deploy is WITH email — the wording and the map say so.
    expect(printed).not.toContain('deploying without email');
    expect(printed).toContain('deploying with the email setup wrangler.jsonc already carries');
    expect(printed).toContain('outbound  sendEmail() from noreply@mail.acme.com');
  });

  it('a committed `addresses` array Void did not derive stays untouched when routing is off too', async () => {
    const root = emailProject({ ...COMMITTED_EMAIL, addresses: ['ceo@acme.com'] });
    const { deps, spawns, confirms, exitCalls } = emailHarness({ isCI: true });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(confirms).toEqual([]);
    expect(readRootConfig(root).addresses).toEqual(['ceo@acme.com']);
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
  });

  it('refuses a config the writer could not update BEFORE the account is touched (binding-name collision)', async () => {
    // `vars.SEND_EMAIL` already exists: the write after the apply would fail, so the step is
    // blocked up front — no prompt, no bearer write, no `sending enable`.
    const root = emailProject({ ...PROVISIONED_D1, vars: { SEND_EMAIL: 'x' } });
    const { deps, spawns, fetchCalls, confirms, exitCalls } = emailHarness();
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(confirms).toEqual([]);
    expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(spawns.some((s) => s.args[0] === 'email' && s.args[2] === 'enable')).toBe(false);
    expect(output.lines.join('\n')).toContain(
      'already uses SEND_EMAIL as a Environment Variable binding',
    );
    expect(readRootConfig(root).send_email).toBeUndefined();
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
  });

  it('an app that stopped using email warns about the setup wrangler.jsonc still carries, and deploys as-is', async () => {
    // No `email/` directory and no `void/email` import, but the root still has what an earlier
    // email deploy wrote: wrangler keeps routing support@ to a worker with no `email()` export.
    const root = d1Project(COMMITTED_EMAIL, INIT_MIGRATION);
    const { deps, spawns, exitCalls } = emailHarness({
      confirm: async () => {
        throw new Error('confirm must not be called without email use');
      },
    });
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(spawns.some((s) => s.args[0] === 'auth' || s.args[0] === 'email')).toBe(false);
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
    expect(readRootConfig(root).addresses).toEqual(['support@mail.acme.com']);
    const printed = output.lines.join('\n');
    expect(printed).toContain('no longer declares email handlers');
    expect(printed).toContain('support@mail.acme.com — still routed to worker "myapp"');
    expect(printed).toContain('send_email SEND_EMAIL binding');
    // The detach guidance names the checked-in config and dashboard path.
    expect(printed).toContain(
      'remove `addresses`, `send_email`, and `vars.__VOID_EMAIL_FROM` from `resolved` in void.lock.json',
    );
    expect(printed).not.toContain('underlying Cloudflare operation');
  });

  it('last inbound handler removed, outbound `void/email` kept: the committed entry is a decision-13 blocker, the array stays, and the trigger snapshot still carries it (the ready-path `null` write is never reached)', async () => {
    // The inbound handler that produced COMMITTED_EMAIL is gone, but `void/email` is still
    // imported, so the email step runs with an empty derived set. The committed entry is one Void
    // did not derive, so the step skips and leaves the array, and the annotation replays it.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({ email: { from: 'noreply@mail.acme.com' } }),
      'routes/index.ts': [
        `import { sendEmail } from 'void/email';`,
        `export const GET = async (c) => {`,
        `  await sendEmail({ to: 'a@b.c', subject: 's', text: 't' });`,
        `  return c.env.DB.prepare('SELECT 1').first();`,
        `};`,
      ].join('\n'),
      'wrangler.jsonc': JSON.stringify(COMMITTED_EMAIL, null, 2),
      ...INIT_MIGRATION,
    });
    const snapshots: Array<unknown> = [];
    const { deps, spawns, confirms, exitCalls } = emailHarness({
      ...readyRows,
      runner: { ...readyRows.runner, 'email routing rules list acme.com': myRule },
      deps: {
        // The real build passes the root's `addresses` through verbatim (whole-object pinned);
        // mirror that so the annotation `activateVersion` receives is the one a deploy carries.
        runBuild: () => {
          const rootConfig = readRootConfig(root);
          mkdirSync(join(root, 'dist/ssr'), { recursive: true });
          writeFileSync(
            join(root, 'dist/ssr/wrangler.json'),
            JSON.stringify({
              name: 'myapp',
              account_id: 'acc123',
              ...(rootConfig.addresses === undefined ? {} : { addresses: rootConfig.addresses }),
            }),
          );
        },
      },
    });
    const inner = deps.activateVersion!;
    deps.activateVersion = async (options) => {
      snapshots.push(parseCloudflareVersionMessage(options.message));
      return inner(options);
    };
    const output = captureOutput();
    try {
      await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    } finally {
      output.restore();
    }
    expect(exitCalls).toEqual([]);
    expect(confirms).toEqual([]);
    // The email step RAN (preflight probes), then blocked — no write, array untouched.
    expect(spawns.some((s) => s.args[0] === 'email' && s.args[1] === 'routing')).toBe(true);
    expect(readRootConfig(root).addresses).toEqual(['support@mail.acme.com']);
    const printed = output.lines.join('\n');
    expect(printed).toContain(
      'addresses holds entries Void did not derive (support@mail.acme.com)',
    );
    expect(printed).not.toContain('addresses removed');
    // The snapshot replays the stale entry: `addresses` reaches wrangler's plan as-is.
    expect(spawns.some((s) => s.args[0] === 'deploy')).toBe(true);
    expect(snapshots).toEqual([
      expect.objectContaining({
        schema: 2,
        triggerConfig: expect.objectContaining({ addresses: ['support@mail.acme.com'] }),
      }),
    ]);
  });

  it('an app with no email use never touches the email step (no early whoami, no auth token)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, spawns, trace } = emailHarness({
      confirm: async () => {
        throw new Error('confirm must not be called without email use');
      },
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(spawns.some((s) => s.args[0] === 'auth' || s.args[0] === 'email')).toBe(false);
    // The only whoami is the deploy's own, after the env-schema probe.
    expect(trace.filter((t) => t === 'wrangler:whoami --json')).toHaveLength(1);
    expect(trace.indexOf('probe')).toBeLessThan(trace.indexOf('wrangler:whoami --json'));
  });
});

describe('runWranglerAuthToken — the session-bearer bridge, on its own', () => {
  type AuthCall = { args: Array<string>; opts: { capture: boolean } };
  const bridge = (result: DeployWranglerRunResult | (() => never)) => {
    const calls: Array<AuthCall> = [];
    const run: DeployWranglerRun = operationFixture((args, opts) => {
      calls.push({ args: [...args], opts });
      return typeof result === 'function' ? result() : result;
    });
    return { calls, token: runWranglerAuthToken(run, '/p/wrangler.jsonc') };
  };

  it('spawns exactly `auth token --json` in the deploy config context, captured', async () => {
    const { calls, token } = bridge({
      status: 0,
      stdout: `{\n  "type": "oauth",\n  "token": "cfoa.abc"\n}\n`,
      stderr: '',
      signal: null,
      error: null,
    });
    expect(await token).toBe('cfoa.abc');
    expect(calls).toEqual([
      {
        args: ['auth', 'token', '--json', '-c', '/p/wrangler.jsonc', '--env='],
        opts: { capture: true },
      },
    ]);
  });

  it('accepts an api_token session and refuses an api_key pair (no single bearer to borrow)', async () => {
    const ok = (stdout: string): DeployWranglerRunResult => ({
      status: 0,
      stdout,
      stderr: '',
      signal: null,
      error: null,
    });
    expect(await bridge(ok('{"type":"api_token","token":"abc"}')).token).toBe('abc');
    expect(
      await bridge(ok('{"type":"api_key","key":"k","email":"dev@example.com"}')).token,
    ).toBeNull();
    expect(await bridge(ok('{"type":"oauth"}')).token).toBeNull();
    expect(await bridge(ok('not json')).token).toBeNull();
  });

  it('resolves null on a failed, signal-killed, unspawnable, or throwing run — never throws', async () => {
    expect(
      await bridge({ status: 1, stdout: '', stderr: 'Not logged in.', signal: null, error: null })
        .token,
    ).toBeNull();
    expect(
      await bridge({ status: 0, stdout: '{}', stderr: '', signal: 'SIGKILL', error: null }).token,
    ).toBeNull();
    expect(
      await bridge({ status: 0, stdout: '{}', stderr: '', signal: null, error: 'ENOENT' }).token,
    ).toBeNull();
    expect(
      await bridge(() => {
        throw new Error('boom');
      }).token,
    ).toBeNull();
  });
});

describe('runCloudflareDeploy — `addresses` is whole-object pinned across the build', () => {
  function writeEmittedDeployArtifact(root: string, generated: Record<string, unknown>): void {
    mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(
      join(root, '.wrangler', 'deploy', 'config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
    );
    writeFileSync(join(root, 'dist', 'ssr', 'wrangler.json'), JSON.stringify(generated));
  }
  const EMITTED_D1 = {
    account_id: 'acc123',
    name: 'myapp',
    d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
  };

  it('fails closed when the build injects an `addresses` array the root never declared', async () => {
    // wrangler ≥ 4.113 would turn this into a routing rule sending the account's inbound mail for
    // `ceo@acme.com` to the deployed worker. No email step runs (no email use), so the pin alone
    // must catch it.
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, { ...EMITTED_D1, addresses: ['ceo@acme.com'] }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    const errors: Array<string> = [];
    const errorSpy = vi.spyOn(log, 'error').mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      await expect(
        runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      errorSpy.mockRestore();
    }
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
    expect(errors.join('\n')).toMatch(/addresses/);
  });

  it('fails closed when the build rewrites a root-declared `addresses` entry', async () => {
    const root = d1Project({ ...PROVISIONED_D1, addresses: ['support@acme.com'] }, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, { ...EMITTED_D1, addresses: ['attacker@acme.com'] }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('passes a root-declared `addresses` array the build passed through verbatim', async () => {
    const root = d1Project({ ...PROVISIONED_D1, addresses: ['support@acme.com'] }, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, { ...EMITTED_D1, addresses: ['support@acme.com'] }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await runCloudflareDeploy(root, { platform: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });

  it('verifyGeneratedDeployConfig: an emitted `addresses: []` with no root value FAILS (wrangler plans the deletion of every owned rule; the key is never default-filled), a root `[]` passes, a dropped root value fails', () => {
    const emptyRoot = makeProject({
      '.wrangler/deploy/config.json': JSON.stringify({
        configPath: '../../dist/ssr/wrangler.json',
      }),
      'dist/ssr/wrangler.json': JSON.stringify({
        account_id: 'acc123',
        name: 'myapp',
        addresses: [],
      }),
    });
    const injected = verifyGeneratedDeployConfig(emptyRoot, {
      accountId: 'acc123',
      workerName: 'myapp',
      passthroughRawFields: snapshotPassthroughRawFields({}),
    });
    expect(injected.ok).toBe(false);
    expect(injected.reason).toMatch(/addresses/);
    // A hand-written root `[]` passed through verbatim is the developer's own choice.
    expect(
      verifyGeneratedDeployConfig(emptyRoot, {
        accountId: 'acc123',
        workerName: 'myapp',
        passthroughRawFields: snapshotPassthroughRawFields({ addresses: [] }),
      }),
    ).toEqual({ ok: true });
    const dropped = verifyGeneratedDeployConfig(emptyRoot, {
      accountId: 'acc123',
      workerName: 'myapp',
      passthroughRawFields: snapshotPassthroughRawFields({ addresses: ['support@acme.com'] }),
    });
    expect(dropped.ok).toBe(false);
    expect(dropped.reason).toMatch(/addresses/);
  });
});
