import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { analyzeApplicationSync } from '../../../../packages/void/src/application-analysis.ts';
import { readConfig } from '../../../../packages/void/src/config.ts';
import { hasEmailHandlers } from '../../../../packages/void/src/router/email.ts';
import { prepareKitchenSinkPlatformFixture } from '../../../scripts/kitchen-sink-platform-fixture.ts';

// The CLI manifest builder runs in Node; keep its Node types out of the API's Worker context.
function readDeployManifest(root: string) {
  const result = spawn.sync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { analyzeApplicationSync } from './packages/void/src/application-analysis.ts';
import { buildVoidManifest } from './packages/void/src/cli/package.ts';
import { readConfig } from './packages/void/src/config.ts';
import { hasEmailHandlers } from './packages/void/src/router/email.ts';
const root = process.argv[1];
const application = analyzeApplicationSync(root, { config: readConfig(root), environment: 'prod' });
console.log(JSON.stringify(buildVoidManifest({
  bindings: application.bindings,
  hasEmailHandlers: hasEmailHandlers(application.email),
})));`,
      root,
    ],
    {
      cwd: resolve(import.meta.dirname, '../../../..'),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as ReturnType<
    typeof import('../../../../packages/void/src/cli/package.ts').buildVoidManifest
  >;
}

describe('hosted kitchen-sink smoke fixture', () => {
  let fixture: ReturnType<typeof prepareKitchenSinkPlatformFixture>;

  beforeAll(() => {
    fixture = prepareKitchenSinkPlatformFixture();
  });

  afterAll(() => fixture?.cleanup());

  it('omits inbound email from the default hosted manifest while preserving authentication', () => {
    const config = readConfig(fixture.root);
    const application = analyzeApplicationSync(fixture.root, { config, environment: 'prod' });
    expect(application.email).toEqual({ addresses: [], defaultHandler: undefined });
    expect(hasEmailHandlers(application.email)).toBe(false);
    expect(config.auth).toEqual({ providers: ['email'] });
    const manifest = readDeployManifest(fixture.root);
    expect(manifest.auth).toBe(true);
    expect(manifest.emailProtocolVersion).toBeUndefined();
    for (const path of ['email/_default.ts', 'email/support+[ticket].ts']) {
      expect(existsSync(resolve(fixture.root, path))).toBe(false);
      expect(
        existsSync(resolve(import.meta.dirname, '../../../../playground/kitchen-sink', path)),
      ).toBe(true);
    }
  });

  it('preserves outbound email inference without requiring an inbound recipient', () => {
    const senderFixture = prepareKitchenSinkPlatformFixture();
    try {
      writeFileSync(
        resolve(senderFixture.root, 'routes/api/sender.ts'),
        `import { sendEmail } from 'void/email';
export const POST = () => sendEmail({ to: 'test@example.com', subject: 'Test', text: 'Test' });`,
      );
      const application = analyzeApplicationSync(senderFixture.root, {
        config: readConfig(senderFixture.root),
        environment: 'prod',
      });
      expect(application.bindings.needsEmail).toBe(true);
      const manifest = readDeployManifest(senderFixture.root);
      expect(manifest.auth).toBe(true);
      expect(manifest.emailProtocolVersion).toBeUndefined();
    } finally {
      senderFixture.cleanup();
    }
  });

  it('preserves the native Sandbox example while removing its hosted routes and links', () => {
    for (const path of ['routes/api/sandbox.ts', 'pages/sandbox.vue', 'pages/sandbox.server.ts']) {
      expect(existsSync(resolve(fixture.root, path))).toBe(false);
      expect(
        existsSync(resolve(import.meta.dirname, '../../../../playground/kitchen-sink', path)),
      ).toBe(true);
    }
    for (const path of ['pages/layout.vue', 'pages/index.vue']) {
      expect(readFileSync(resolve(fixture.root, path), 'utf8')).not.toContain('href="/sandbox"');
    }
  });

  it('includes the Sandbox example when explicitly enabled without copying local secrets', () => {
    const sandboxFixture = prepareKitchenSinkPlatformFixture({ sandbox: true });
    try {
      for (const path of [
        'routes/api/sandbox.ts',
        'pages/sandbox.vue',
        'pages/sandbox.server.ts',
        'lib/sandbox-demo.ts',
        'routes/api/acceptance/sandbox.ts',
      ]) {
        expect(existsSync(resolve(sandboxFixture.root, path))).toBe(true);
      }
      for (const path of ['pages/layout.vue', 'pages/index.vue']) {
        expect(readFileSync(resolve(sandboxFixture.root, path), 'utf8')).toContain(
          'href="/sandbox"',
        );
      }
      expect(existsSync(resolve(sandboxFixture.root, '.env'))).toBe(false);
    } finally {
      sandboxFixture.cleanup();
    }
  });

  it('adds email sending and inbound acceptance routes only when explicitly enabled', () => {
    expect(existsSync(resolve(fixture.root, 'routes/api/acceptance/email.ts'))).toBe(false);
    const emailFixture = prepareKitchenSinkPlatformFixture({ email: true });
    try {
      for (const path of [
        'routes/api/acceptance/email.ts',
        'lib/email-acceptance.ts',
        'email/support.ts',
        'email/support+[ticket].ts',
        'email/support+vip.ts',
        'email/_default.ts',
      ]) {
        expect(existsSync(resolve(emailFixture.root, path))).toBe(true);
      }
      expect(
        readFileSync(resolve(emailFixture.root, 'routes/api/acceptance/email.ts'), 'utf8'),
      ).toContain("typeof secret !== 'string' || !secret");
      expect(existsSync(resolve(emailFixture.root, '.env'))).toBe(false);
      const application = analyzeApplicationSync(emailFixture.root, {
        config: readConfig(emailFixture.root),
        environment: 'prod',
      });
      expect(application.bindings.needsEmail).toBe(true);
      expect(hasEmailHandlers(application.email)).toBe(true);
      expect(readDeployManifest(emailFixture.root).emailProtocolVersion).toBe(1);
    } finally {
      emailFixture.cleanup();
    }
  });

  it('adds isolated retry and runtime probes only when explicitly enabled', () => {
    expect(existsSync(resolve(fixture.root, 'queues/acceptance-queue.ts'))).toBe(false);
    const runtimeFixture = prepareKitchenSinkPlatformFixture({ runtime: true });
    try {
      for (const path of [
        'queues/acceptance-queue.ts',
        'lib/queue-acceptance.ts',
        'routes/api/acceptance/queue.ts',
        'routes/api/acceptance/runtime.ts',
        'routes/ws/acceptance.ws.ts',
      ]) {
        expect(existsSync(resolve(runtimeFixture.root, path))).toBe(true);
      }
    } finally {
      runtimeFixture.cleanup();
    }
  });

  it('builds the hosted app with its supported bindings and no Sandbox container', () => {
    const build = spawn.sync('vp', ['build'], {
      cwd: fixture.root,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const config = JSON.parse(
      readFileSync(resolve(fixture.root, 'dist/ssr/wrangler.json'), 'utf8'),
    );
    expect(config.containers ?? []).toEqual([]);
    expect(config.durable_objects?.bindings ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'SANDBOX' }),
    );
    expect(config.d1_databases).toContainEqual(expect.objectContaining({ binding: 'DB' }));
    expect(config.kv_namespaces).toContainEqual(expect.objectContaining({ binding: 'KV' }));
    expect(config.r2_buckets).toContainEqual(expect.objectContaining({ binding: 'STORAGE' }));
    expect(config.ai).toEqual({ binding: 'AI' });
    expect(config.queues.producers.length).toBeGreaterThan(0);
  }, 120_000);

  it('builds and typechecks the opt-in Sandbox and email acceptance app', () => {
    const acceptanceFixture = prepareKitchenSinkPlatformFixture({
      sandbox: true,
      email: true,
      runtime: true,
    });
    try {
      for (const args of [['build'], ['exec', 'tsrs', '--noEmit']]) {
        const result = spawn.sync('vp', args, {
          cwd: acceptanceFixture.root,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, VOID_DEPLOY_PROJECT_ID: 'runtime-acceptance' },
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      }
      const config = JSON.parse(
        readFileSync(resolve(acceptanceFixture.root, 'dist/ssr/wrangler.json'), 'utf8'),
      );
      expect(config.secrets.required).toContain('SECRET_KEY');
      expect(config.queues.consumers).toContainEqual(
        expect.objectContaining({ queue: 'acceptance-queue', max_batch_size: 1, max_retries: 1 }),
      );
      expect(config.durable_objects.bindings).toContainEqual(
        expect.objectContaining({ name: 'SANDBOX', class_name: 'SandboxV1' }),
      );
    } finally {
      acceptanceFixture.cleanup();
    }
  }, 120_000);
});
