import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { resolveDistDir, resolveWorkerDirName } from '../../src/cli/build-output-dir.ts';
import type { PlatformClient, ProjectResponse } from '../../src/cli/client.ts';
import {
  ensurePreviouslyDeployedLiveBindingConfig,
  generateDeployWrapperIfNeeded,
  resolveDeployLiveBindingConfig,
  resolveDeployWorkerMain,
  resolveDeployWranglerCompat,
  resolveFullDeployBuildCommand,
  resolveStaticDeployPreset,
  resolveStaticBuildCommand,
  toManifestSchedulesAndQueues,
} from '../../src/cli/deploy-helpers.ts';
import {
  formatProjectCommand,
  resolveProjectCommand,
  FRAMEWORK_PRESETS,
} from '../../src/cli/preset.ts';
import {
  getRequestedProjectSlug,
  inferDefaultSlug,
  resolveProjectBySlug,
} from '../../src/cli/resolve-project.ts';

const tempDirs: Array<string> = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getRequestedProjectSlug', () => {
  afterEach(() => {
    delete process.env.VOID_PROJECT;
  });

  it('prefers CLI project slug over env var', () => {
    process.env.VOID_PROJECT = 'from-env';
    expect(getRequestedProjectSlug({ projectSlug: 'from-cli' })).toBe('from-cli');
  });

  it('uses env var when CLI slug is missing', () => {
    process.env.VOID_PROJECT = 'from-env';
    expect(getRequestedProjectSlug()).toBe('from-env');
  });

  it('returns null when no override exists', () => {
    expect(getRequestedProjectSlug()).toBeNull();
  });
});

describe('resolveProjectBySlug', () => {
  it('returns project config for a matching slug', () => {
    const config = resolveProjectBySlug(
      [
        {
          id: 'proj_1',
          user_id: 'user_1',
          slug: 'my-app',
          type: 'worker',
          created_at: '2026-02-15T00:00:00.000Z',
          custom_domain: null,
          role: 'owner',
        },
      ],
      'my-app',
    );

    expect(config).toEqual({
      projectId: 'proj_1',
      slug: 'my-app',
    });
  });

  it('returns null when slug does not match any project', () => {
    const projects = [
      { id: 'proj_1', slug: 'app-one' },
      { id: 'proj_2', slug: 'app-two' },
    ] as Array<ProjectResponse>;
    expect(resolveProjectBySlug(projects, 'missing')).toBeNull();
  });
});

describe('inferDefaultSlug', () => {
  it('derives slug from a scoped package name', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@acme/my-app' }));

    expect(inferDefaultSlug(root)).toBe('my-app');
  });

  it('uses fallback values when package name is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({}));

    expect(inferDefaultSlug(root)).toBe('my-app');
  });
});

describe('resolveDistDir', () => {
  it('returns dist/ for non-framework deploys', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'dist'), { recursive: true });

    expect(resolveDistDir(root)).toBe(toSlash(join(root, 'dist')));
  });

  it('returns dist/ for tanstack-start preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'dist'), { recursive: true });

    expect(resolveDistDir(root, FRAMEWORK_PRESETS['tanstack-start'])).toBe(
      toSlash(join(root, 'dist')),
    );
  });

  it('returns build/ for react-router preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'build'), { recursive: true });

    expect(resolveDistDir(root, FRAMEWORK_PRESETS['react-router'])).toBe(
      toSlash(join(root, 'build')),
    );
  });

  it('throws with framework-specific message when build dir missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);

    expect(() => resolveDistDir(root, FRAMEWORK_PRESETS['react-router'])).toThrow(
      "deploy: Build output directory 'build' not found",
    );
  });

  it('uses the resolved build command in framework error messages', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);

    expect(() => resolveDistDir(root, FRAMEWORK_PRESETS.sveltekit, 'vp build')).toThrow(
      "Run 'vp build' first.",
    );
  });
});

describe('resolveDeployWranglerCompat', () => {
  it('does not pin compatibility_date for non-Cloudflare targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);

    expect(resolveDeployWranglerCompat(root, { target: 'node' }, join(root, 'dist', 'ssr'))).toBe(
      undefined,
    );
    expect(existsSync(join(root, 'void.json'))).toBe(false);
  });

  it('upgrades auth deploy manifests to nodejs_compat even when root wrangler flags win', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        compatibility_date: '2026-04-01',
        compatibility_flags: ['custom_flag', 'nodejs_als'],
      }),
    );
    const buildDir = join(root, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({
        compatibility_date: '2026-04-01',
        compatibility_flags: ['nodejs_compat'],
      }),
    );

    expect(
      resolveDeployWranglerCompat(root, { auth: { providers: ['email'] } }, buildDir, {
        authEnabled: true,
      }),
    ).toEqual({
      compatibilityDate: '2026-04-01',
      compatibilityFlags: ['custom_flag', 'nodejs_compat'],
    });
  });
});

describe('resolveDeployWorkerMain', () => {
  it('uses the build output wrangler main for non-framework Void deploys', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const buildDir = join(root, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({
        main: 'index.mjs',
      }),
    );

    expect(resolveDeployWorkerMain({}, buildDir)).toBe('index.mjs');
  });

  it('does not set a Workers main module for non-Cloudflare deploy targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const buildDir = join(root, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({
        main: 'index.mjs',
      }),
    );

    expect(resolveDeployWorkerMain({ target: 'node' }, buildDir)).toBeUndefined();
  });
});

describe('ensurePreviouslyDeployedLiveBindingConfig', () => {
  it('restores the active deployment live binding into wrangler config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const client = {
      async listDeployments() {
        return {
          activeDeploymentId: 'dpl_live',
          deployments: [
            {
              id: 'dpl_live',
              status: 'live',
              source: null,
              commit: null,
              manifest: JSON.stringify({
                version: 3,
                bindings: {},
                live: {
                  bindingName: 'VOID_LIVE_a1b2c3d4',
                  className: 'VoidLiveStreamDurableObject_a1b2c3d4',
                  storage: 'sqlite',
                  classes: ['VoidLiveStreamDurableObject_a1b2c3d4'],
                },
              }),
              error_message: null,
              retained: true,
              applied_migrations: null,
              created_at: '2026-05-12T00:00:00.000Z',
              deployed_at: '2026-05-12T00:00:00.000Z',
            },
          ],
        };
      },
    } as unknown as PlatformClient;

    await expect(ensurePreviouslyDeployedLiveBindingConfig(root, client, 'proj_1')).resolves.toBe(
      true,
    );

    const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8'));
    expect(wrangler.durable_objects.bindings).toContainEqual({
      name: 'VOID_LIVE_a1b2c3d4',
      class_name: 'VoidLiveStreamDurableObject_a1b2c3d4',
    });
    expect(wrangler.migrations).toContainEqual({
      tag: 'live-v1',
      new_sqlite_classes: ['VoidLiveStreamDurableObject_a1b2c3d4'],
    });
  });
});

describe('resolveDeployLiveBindingConfig', () => {
  it('does not restore or activate live bindings when current source no longer needs live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        durable_objects: {
          bindings: [
            {
              name: 'VOID_LIVE_a1b2c3d4',
              class_name: 'VoidLiveStreamDurableObject_a1b2c3d4',
            },
          ],
        },
      }),
    );
    const client = {
      async listDeployments() {
        throw new Error('listDeployments should not be called');
      },
    } as unknown as PlatformClient;

    await expect(
      resolveDeployLiveBindingConfig(root, client, 'proj_1', {
        isFrameworkMode: false,
        needsLive: false,
        webSockets: [],
      }),
    ).resolves.toBeUndefined();

    const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8'));
    expect(wrangler.migrations).toBeUndefined();
  });

  it('restores the active deployment live binding only when current source still needs live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const client = {
      async listDeployments() {
        return {
          activeDeploymentId: 'dpl_live',
          deployments: [
            {
              id: 'dpl_live',
              status: 'live',
              source: null,
              commit: null,
              manifest: JSON.stringify({
                version: 3,
                bindings: {},
                live: {
                  bindingName: 'VOID_LIVE_a1b2c3d4',
                  className: 'VoidLiveStreamDurableObject_a1b2c3d4',
                },
              }),
              error_message: null,
              retained: true,
              applied_migrations: null,
              created_at: '2026-05-12T00:00:00.000Z',
              deployed_at: '2026-05-12T00:00:00.000Z',
            },
          ],
        };
      },
    } as unknown as PlatformClient;

    await expect(
      resolveDeployLiveBindingConfig(root, client, 'proj_1', {
        isFrameworkMode: false,
        needsLive: true,
        webSockets: [],
      }),
    ).resolves.toEqual({
      bindingName: 'VOID_LIVE_a1b2c3d4',
      className: 'VoidLiveStreamDurableObject_a1b2c3d4',
    });
  });
});

describe('resolveStaticBuildCommand', () => {
  it('uses inference.build when provided', () => {
    expect(
      resolveStaticBuildCommand(
        {
          buildCommand: 'vite build',
          outputDir: '/tmp/dist',
          appType: 'static',
        },
        'pnpm build',
      ),
    ).toBe('pnpm build');
  });

  it('keeps explicit --dir deploys buildless even when inference.build is set', () => {
    expect(
      resolveStaticBuildCommand(
        {
          buildCommand: null,
          outputDir: '/tmp/dist',
          appType: 'static',
        },
        'pnpm build',
        true,
      ),
    ).toBeNull();
  });
});

describe('resolveFullDeployBuildCommand', () => {
  const root = '/tmp/void-full-deploy-build-cmd';

  it('uses inference.build verbatim when set', () => {
    expect(resolveFullDeployBuildCommand(root, 'vitepress build && vite build')).toEqual({
      label: 'vitepress build && vite build',
      command: 'vitepress build && vite build',
    });
  });

  it('prefers inference.build over a framework build fallback', () => {
    expect(
      resolveFullDeployBuildCommand(root, 'vp build', FRAMEWORK_PRESETS.nuxt.buildCommand),
    ).toEqual({ label: 'vp build', command: 'vp build' });
  });

  it.each([undefined, ''])(
    'falls back to the built-in vite build for inference.build %j',
    (build) => {
      expect(resolveFullDeployBuildCommand(root, build)).toEqual({
        label: formatProjectCommand(root, 'vite build'),
        command: resolveProjectCommand(root, 'vite build'),
      });
    },
  );

  it('uses a framework build command as the fallback when provided', () => {
    expect(
      resolveFullDeployBuildCommand(root, undefined, FRAMEWORK_PRESETS.nuxt.buildCommand),
    ).toEqual({
      label: formatProjectCommand(root, FRAMEWORK_PRESETS.nuxt.buildCommand),
      command: resolveProjectCommand(root, FRAMEWORK_PRESETS.nuxt.buildCommand),
    });
  });
});

describe('resolveStaticDeployPreset', () => {
  it('treats --dir as a static deploy override even in framework-shaped projects', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sveltejs/kit': 'latest' } }),
    );

    expect(resolveStaticDeployPreset(root, {}, { dir: 'public' })).toEqual({
      buildCommand: null,
      outputDir: toSlash(join(root, 'public')),
      appType: 'static',
    });
  });

  it('treats explicit static app type as an override before framework detection', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sveltejs/kit': 'latest' } }),
    );

    expect(resolveStaticDeployPreset(root, { inference: { appType: 'static' } })).toEqual({
      buildCommand: null,
      outputDir: toSlash(join(root, 'dist')),
      appType: 'static',
    });
  });

  it('does not classify ordinary framework auto-detection as a static override', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sveltejs/kit': 'latest', vite: 'latest' } }),
    );

    expect(resolveStaticDeployPreset(root, {})).toBeNull();
  });
});

describe('resolveWorkerDirName', () => {
  it('returns preset worker subdir for react-router', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const buildDir = join(root, 'build');
    mkdirSync(join(buildDir, 'server'), { recursive: true });

    expect(resolveWorkerDirName(buildDir, FRAMEWORK_PRESETS['react-router'])).toBe('server');
  });

  it('returns preset worker subdir for tanstack-start', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'server'), { recursive: true });

    expect(resolveWorkerDirName(dist, FRAMEWORK_PRESETS['tanstack-start'])).toBe('server');
  });

  it('probes for ssr/ without a preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'ssr'), { recursive: true });

    expect(resolveWorkerDirName(dist)).toBe('ssr');
  });

  it('throws with framework-specific message when worker dir missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const buildDir = join(root, 'build');
    mkdirSync(buildDir, { recursive: true });

    expect(() => resolveWorkerDirName(buildDir, FRAMEWORK_PRESETS['react-router'])).toThrow(
      "deploy: Worker output 'build/server' not found",
    );
  });

  it('uses the resolved build command when worker output is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });

    expect(() => resolveWorkerDirName(dist, FRAMEWORK_PRESETS.sveltekit, 'vp build')).toThrow(
      "Run 'vp build' first.",
    );
  });

  it('throws when no worker dir exists without preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });

    expect(() => resolveWorkerDirName(dist)).toThrow('Worker output not found');
  });
});

describe('generateDeployWrapperIfNeeded', () => {
  it('wraps class-a framework worker output when migrations are present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-test-'));
    tempDirs.push(root);
    const workerDir = join(root, 'dist', 'server');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.js'),
      'export default { fetch() { return Response.json({ status: 500, unhandled: true, message: "HTTPError" }, { status: 500 }); } };',
    );
    mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
    writeFileSync(join(root, 'db', 'migrations', '001_init.sql'), 'CREATE TABLE users (id INT);');

    const wrapped = await generateDeployWrapperIfNeeded(root, workerDir, 'index.js', {
      crons: [],
      queues: [],
      hasMigrations: true,
      migrationDialect: 'postgresql',
    });

    expect(wrapped).toBe(true);
    expect(existsSync(join(workerDir, '__original.js'))).toBe(true);
    expect(existsSync(join(workerDir, '__void_migration_handler.mjs'))).toBe(true);
    const wrapper = readFileSync(join(workerDir, 'index.js'), 'utf-8');
    expect(wrapper).toContain('import original from "./__original.js"');
    expect(wrapper).toContain('createMigrationHandler');
    expect(wrapper).toContain('/__void/migrate');
    const handler = readFileSync(join(workerDir, '__void_migration_handler.mjs'), 'utf-8');
    expect(handler).toContain('VALUES ($1, $2)');
  });
});

describe('toManifestSchedulesAndQueues', () => {
  it('keeps queue retry options, including zero', () => {
    const { queues } = toManifestSchedulesAndQueues(
      [],
      [
        {
          filePath: 'emails.ts',
          name: 'emails',
          bindingName: 'QUEUE_EMAILS',
          maxBatchSize: 50,
          maxBatchTimeout: 10,
          maxRetries: 0,
          retryDelay: 30,
        },
        { filePath: 'jobs.ts', name: 'jobs', bindingName: 'QUEUE_JOBS' },
      ],
    );
    expect(queues).toEqual([
      {
        name: 'emails',
        bindingName: 'QUEUE_EMAILS',
        maxBatchSize: 50,
        maxBatchTimeout: 10,
        maxRetries: 0,
        retryDelay: 30,
      },
      { name: 'jobs', bindingName: 'QUEUE_JOBS' },
    ]);
    expect(Object.keys(queues[1]!)).toEqual(['name', 'bindingName']);
  });
});
