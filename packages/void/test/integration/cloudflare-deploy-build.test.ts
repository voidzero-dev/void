import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { parseRootWranglerConfig } from '@void/deploy-cloudflare';
import spawn from 'cross-spawn';
import { toSlash } from 'pathslash';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { verifyGeneratedDeployConfig } from '../../src/cli/deploy-artifact-validation.ts';
import {
  reconstructExpectedContainers,
  snapshotBindingIdentities,
  snapshotPassthroughIdentities,
  snapshotPassthroughRawFields,
} from '../../src/cli/deploy-binding-snapshot.ts';
import { computeDesiredCloudflareResources } from '../../src/cli/deploy-resources.ts';
import { materializeCloudflareConfig } from '../../src/cloudflare-config.ts';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';
import {
  resolveSandboxConfig,
  sandboxContainerConfig,
  SANDBOX_MIGRATION_TAG,
} from '../../src/sandbox/config.ts';
import {
  CLOUDFLARE_DEPLOY_BUILD_ENV,
  CLOUDFLARE_QUEUE_NAMES_BUILD_ENV,
} from '../../src/shared/env.ts';

// A real build of kitchen-sink must pass the deploy guard unmodified. Unit tests use hand-written
// configs, so only this catches a plugin upgrade that emits a field the guard rejects.

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/kitchen-sink';
let playground: IsolatedPlayground;
let pg = '';

// The guard accepts only real-shaped ids (D1 UUID, 32-hex KV).
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const WORKER_NAME = 'void-kitchen-sink';
const REAL_D1_ID = '52b3bbc7-c473-4b26-9486-1345f5de61c4';
const REAL_KV_ID = '7c07b54c9f2a4d1e8b3f6a0c153aa11a';
const REAL_ISR_CACHE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const R2_BUCKET_NAME = 'void-kitchen-sink-storage';

const OVERLAY_WRANGLER = {
  name: WORKER_NAME,
  account_id: ACCOUNT_ID,
  compatibility_date: '2026-02-24',
  d1_databases: [{ binding: 'DB', database_name: 'void-kitchen-sink-db', database_id: REAL_D1_ID }],
  // kitchen-sink uses ISR, which adds the ISR_CACHE namespace.
  kv_namespaces: [
    { binding: 'KV', id: REAL_KV_ID },
    { binding: 'ISR_CACHE', id: REAL_ISR_CACHE_ID },
  ],
  r2_buckets: [{ binding: 'STORAGE', bucket_name: R2_BUCKET_NAME }],
};

type ExpectedPayload = Parameters<typeof verifyGeneratedDeployConfig>[1];

let pristineEmitted: Record<string, unknown> = {};
let expectedPayload: ExpectedPayload;

describe('playground/kitchen-sink --platform cloudflare real-build deploy guard', () => {
  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
    pg = playground.root;
    const typedPath = join(pg, 'void.config.ts');
    // A normal deploy syncs the inferred Sandbox before Vite resolves its config.
    // Exercise that existing entry, rather than only the initially empty config.
    const sandbox = resolveSandboxConfig({ sandbox: { instanceType: 'standard-1' } }, pg);
    writeFileSync(
      typedPath,
      renderVoidConfig({
        ...readConfig(pg),
        sandbox: { instanceType: 'standard-1' },
        cloudflare: {
          ...OVERLAY_WRANGLER,
          durable_objects: { bindings: [{ name: sandbox.binding, class_name: sandbox.className }] },
          migrations: [{ tag: SANDBOX_MIGRATION_TAG, new_sqlite_classes: [sandbox.className] }],
          containers: [sandboxContainerConfig(sandbox)],
        },
      }),
    );
    const configPath = materializeCloudflareConfig(pg);

    // The guard must follow only a deploy pointer this build wrote.
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler', 'deploy', 'config.json'), { force: true });

    // Build `expected` before the build, as runCloudflareDeploy does, so a build that rewrites the
    // root config cannot change what the guard expects.
    const voidConfig = readConfig(pg);
    const { desired, needsAI, needsSandbox, expectedCrons } =
      await computeDesiredCloudflareResources(pg, voidConfig, configPath);
    const rootConfig = parseRootWranglerConfig(configPath);
    expectedPayload = {
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      desired,
      bindingIdentitySnapshot: snapshotBindingIdentities(rootConfig),
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
      passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
      needsAI,
      expectedContainers: reconstructExpectedContainers(voidConfig, pg, rootConfig, needsSandbox),
      expectedCrons,
    };

    const result = spawn.sync('vp', ['build'], {
      cwd: pg,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        [CLOUDFLARE_DEPLOY_BUILD_ENV]: '1',
        // Preflight passes the names it chose; a new account gets the Worker-scoped ones.
        [CLOUDFLARE_QUEUE_NAMES_BUILD_ENV]: JSON.stringify(desired.queueNames),
      },
    });
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);

    pristineEmitted = JSON.parse(
      readFileSync(join(pg, 'dist', 'ssr', 'wrangler.json'), 'utf-8'),
    ) as Record<string, unknown>;
  });

  afterAll(() => {
    playground?.cleanup();
  });

  it('emits the CF-plugin deploy pointer the guard follows', () => {
    const pointer = JSON.parse(
      readFileSync(join(pg, '.wrangler', 'deploy', 'config.json'), 'utf-8'),
    ) as { configPath?: string };
    // The pointer uses the platform's path separator.
    expect(toSlash(normalize(pointer.configPath ?? ''))).toBe('../../dist/ssr/wrangler.json');
  });

  it('merges the pinned account, worker name, and real binding ids into the emitted artifact', () => {
    expect(pristineEmitted.account_id).toBe(ACCOUNT_ID);
    expect(pristineEmitted.name).toBe(WORKER_NAME);
    expect(pristineEmitted.d1_databases).toContainEqual(
      expect.objectContaining({ binding: 'DB', database_id: REAL_D1_ID }),
    );
    expect(pristineEmitted.kv_namespaces).toContainEqual(
      expect.objectContaining({ binding: 'KV', id: REAL_KV_ID }),
    );
    expect(pristineEmitted.kv_namespaces).toContainEqual(
      expect.objectContaining({ binding: 'ISR_CACHE', id: REAL_ISR_CACHE_ID }),
    );
    expect(pristineEmitted.r2_buckets).toContainEqual(
      expect.objectContaining({ binding: 'STORAGE', bucket_name: R2_BUCKET_NAME }),
    );
  });

  it('emits the sandbox container, injected AI binding, cron trigger, and queue bindings', () => {
    expect(pristineEmitted.containers).toHaveLength(1);
    expect(pristineEmitted.containers).toContainEqual(
      expect.objectContaining({ name: 'void-sandbox-v1', class_name: 'SandboxV1' }),
    );
    expect(pristineEmitted.ai).toEqual({ binding: 'AI' });
    expect(pristineEmitted.triggers).toEqual({ crons: ['* * * * *'] });
    const queues = pristineEmitted.queues as {
      producers: Array<{ queue: string }>;
      consumers: Array<{ queue: string }>;
    };
    expect(queues.producers).toContainEqual({
      binding: 'QUEUE_DEMO_QUEUE',
      queue: `${WORKER_NAME}-demo-queue`,
    });
    expect(queues.consumers).toContainEqual(
      expect.objectContaining({ queue: `${WORKER_NAME}-demo-queue` }),
    );
  });

  it('routes the Worker-scoped queue name to its handler by exact match', () => {
    const worker = readdirSync(join(pg, 'dist', 'ssr'), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(pg, 'dist', 'ssr', file), 'utf8'))
      .join('\n');
    expect(worker).toContain('__queueIndexByName');
    expect(worker).toContain(`"${WORKER_NAME}-demo-queue": 0`);
    expect(worker).not.toContain('queueName.endsWith("-" + name)');
  });

  it('the real emitted config passes verifyGeneratedDeployConfig unmodified', () => {
    expect(verifyGeneratedDeployConfig(pg, expectedPayload)).toEqual({ ok: true });
  });
});
