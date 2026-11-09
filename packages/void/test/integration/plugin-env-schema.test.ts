import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, createBuilder, resolveConfig, type InlineConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { envClientFoldPlugin } from '../../src/plugin-env-client-fold.ts';
import { envSchemaPlugin } from '../../src/plugin-env-schema.ts';

const roots: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-plugin-env-'));
  roots.push(root);
  return root;
}

async function runConfig(plugin: ReturnType<typeof envSchemaPlugin>): Promise<void> {
  const hook = plugin.config as unknown;
  if (typeof hook === 'function') {
    // The hook is called by vite with (config, env) — pass stubs.
    await (hook as (c: unknown, e: unknown) => unknown).call({}, {}, { mode: 'development' });
    return;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    const handler = (hook as { handler: (c: unknown, e: unknown) => unknown }).handler;
    await handler.call({}, {}, { mode: 'development' });
  }
}

async function runConfigResolved(
  plugin: ReturnType<typeof envSchemaPlugin>,
  resolved: Record<string, unknown>,
): Promise<void> {
  const hook = plugin.configResolved as unknown;
  if (typeof hook === 'function') {
    await (hook as (c: unknown) => unknown).call({}, resolved);
    return;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    const handler = (hook as { handler: (c: unknown) => unknown }).handler;
    await handler.call({}, resolved);
  }
}

async function buildEntry(
  root: string,
  config: Pick<InlineConfig, 'envDir' | 'envPrefix'> & { app?: boolean } = {},
): Promise<string> {
  const { app, ...rest } = config;
  const inline: InlineConfig = {
    ...rest,
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [envSchemaPlugin(root)],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: join(root, 'entry.js'), preserveEntrySignatures: 'strict' },
    },
  };
  // The app builder resolves the config again for each environment, in the
  // same process, as `vite build` does with the Cloudflare plugin.
  const output = app
    ? await createBuilder({ ...inline, builder: {} }).then((builder) =>
        builder.build(builder.environments.client!),
      )
    : await build(inline);
  return [output]
    .flat()
    .flatMap((result) => ('output' in result ? result.output : []))
    .map((chunk) => ('code' in chunk ? chunk.code : ''))
    .join('\n');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('envSchemaPlugin auto-discovery', () => {
  it.each([undefined, 'Build shell'])(
    'folds settled production values after concurrent config hooks (shell: %s)',
    async (shellValue) => {
      const { defineEnv } = await import('../../src/runtime/env-public.ts');
      const { string } = await import('../../src/runtime/env-helpers.ts');
      const root = createTempRoot();
      writeFileSync(join(root, 'env.ts'), 'export default {};\n');
      writeFileSync(join(root, '.env'), 'VITE_TITLE=Local only\n');
      vi.stubEnv('VITE_TITLE', shellValue);
      defineEnv({ VITE_TITLE: string().default('Production default') });

      const fold = envClientFoldPlugin();
      const resolved = await resolveConfig(
        { root, configFile: false, plugins: [envSchemaPlugin(root), fold] },
        'build',
      );
      const transform = fold.transform as unknown as (
        this: { environment: { name: string } },
        code: string,
        id: string,
      ) => Promise<{ code: string }>;
      const result = await transform.call(
        { environment: { name: 'client' } },
        'import { env } from "void/env"; export const title = env.VITE_TITLE;',
        join(root, 'client.ts'),
      );

      const expected = shellValue ?? 'Production default';
      expect(resolved.env.VITE_TITLE).toBe(expected);
      expect(result.code).toContain(JSON.stringify(expected));
      expect(result.code).not.toContain('Local only');
    },
  );

  it('writes .void/env.d.ts when env.ts exists at the project root', async () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'env.ts'),
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ STRIPE_KEY: string(), PUBLIC_URL: string() });\n',
    );

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    const dtsPath = join(root, '.void', 'env.d.ts');
    expect(existsSync(dtsPath)).toBe(true);

    const dts = readFileSync(dtsPath, 'utf-8');
    // `export {}` makes the file an augmentation instead of an ambient module.
    expect(dts).toContain('export {}');
    expect(dts).toContain('declare module "void/env"');
    expect(dts).toContain('declare module "void/handler"');
    expect(dts).toContain('interface ValidatedEnv extends _VoidEnvShape');
    expect(dts).toContain('interface CloudBindings extends _VoidEnvShape');
    expect(dts).toContain('typeof import("../env.ts")');
  });

  it('discovers env.ts nested under src/ and resolves the import path correctly', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'env.ts'),
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ API_KEY: string() });\n',
    );

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    const dts = readFileSync(join(root, '.void', 'env.d.ts'), 'utf-8');
    // Relative path from .void/ to src/env.ts.
    expect(dts).toContain('typeof import("../src/env.ts")');
  });

  it('is a no-op when no env.ts exists (no .void/env.d.ts is written)', async () => {
    const root = createTempRoot();

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    expect(existsSync(join(root, '.void', 'env.d.ts'))).toBe(false);
  });

  it('rejects legacy dotenv variants when env.ts exists', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    writeFileSync(join(root, '.env.production'), 'API_URL=https://example.com\n');

    await expect(runConfig(envSchemaPlugin(root))).rejects.toThrow('supports one local file: .env');
    await expect(runConfig(envSchemaPlugin(root))).rejects.not.toThrow('env.ts lists the keys');
  });

  it('points .env.example users at env.ts', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, '.env.example'), 'API_URL=\n');

    await expect(runConfig(envSchemaPlugin(root))).rejects.toThrow(
      'Remove .env.example and follow the env migration guide. env.ts lists the keys',
    );
  });

  it('removes local .env client values from production builds', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    writeFileSync(join(root, '.env'), 'VITE_TITLE=Local only\n');

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);
    defineEnv({ VITE_TITLE: string() });
    const resolved = {
      command: 'build',
      mode: 'production',
      envDir: root,
      envPrefix: 'VITE_',
      env: { VITE_TITLE: 'Local only' },
      define: {},
    };

    await expect(runConfigResolved(plugin, resolved)).rejects.toThrow('VITE_TITLE is required');
    expect(resolved.env.VITE_TITLE).toBeUndefined();
  });

  it('keeps every local .env client value out of a production client build', async () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, '.env'),
      [
        'export VITE_B=local-export',
        // Vite drops the inline comment.
        'VITE_C=local-comment # note',
        'VITE_D=local-plain',
        // Vite reads this key; Void's own parser skips it.
        'VITE_E.F=local-dot',
        'MODE=local-mode',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, 'entry.js'), 'export const env = import.meta.env;\n');
    for (const key of ['VITE_B', 'VITE_C', 'VITE_D', 'VITE_E.F', 'MODE']) {
      vi.stubEnv(key, undefined);
    }

    const code = await buildEntry(root);

    expect(code).not.toContain('local-');
    expect(code).toContain('"production"');
  });

  it('keeps a shell value for a key that is also in .env', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, '.env'), 'VITE_API=local-api\n');
    writeFileSync(join(root, 'entry.js'), 'export const api = import.meta.env.VITE_API;\n');
    vi.stubEnv('VITE_API', 'shell-api');

    const code = await buildEntry(root);

    expect(code).toContain('"shell-api"');
    expect(code).not.toContain('local-api');
  });

  it('strips local client values when Vite canonicalizes the root casing', async (context) => {
    const root = createTempRoot();
    const aliasedRoot = join(dirname(root), basename(root).toUpperCase());
    if (!existsSync(aliasedRoot)) {
      context.skip();
    }
    writeFileSync(join(root, '.env'), 'VITE_API=local-api\n');
    writeFileSync(join(root, 'entry.js'), 'export const api = import.meta.env.VITE_API;\n');
    vi.stubEnv('VITE_API', undefined);

    const code = await buildEntry(aliasedRoot);

    expect(code).not.toContain('local-api');
  });

  it('keeps a .env NODE_ENV out of a production client build', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, '.env'), 'NODE_ENV=local-node-env\n');
    writeFileSync(join(root, 'entry.js'), 'export const env = import.meta.env;\n');
    vi.stubEnv('VITE_USER_NODE_ENV', undefined);

    const code = await buildEntry(root);

    expect(code).not.toContain('local-node-env');
    expect(code).not.toContain('VITE_USER_NODE_ENV');
  });

  it('keeps .env BROWSER values out when envPrefix matches them', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, '.env'), 'BROWSER=local-browser\nBROWSER_ARGS=local-args\n');
    writeFileSync(join(root, 'entry.js'), 'export const env = import.meta.env;\n');
    vi.stubEnv('BROWSER', undefined);
    vi.stubEnv('BROWSER_ARGS', undefined);

    const code = await buildEntry(root, { envPrefix: ['VITE_', 'BROWSER'] });

    expect(code).not.toContain('local-');
    expect(code).toContain('"production"');
  });

  it('keeps a shell BROWSER value when envPrefix matches it', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, '.env'), 'BROWSER=local-browser\n');
    writeFileSync(join(root, 'entry.js'), 'export const browser = import.meta.env.BROWSER;\n');
    vi.stubEnv('BROWSER', 'shell-browser');

    const code = await buildEntry(root, { envPrefix: ['VITE_', 'BROWSER'] });

    expect(code).toContain('"shell-browser"');
    expect(code).not.toContain('local-browser');
  });

  it('keeps .env values Vite copies to process.env out of every app build environment', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, '.env'), 'NODE_ENV=local-node-env\nBROWSER=local-browser\n');
    writeFileSync(join(root, 'entry.js'), 'export const env = import.meta.env;\n');
    vi.stubEnv('VITE_USER_NODE_ENV', undefined);
    vi.stubEnv('BROWSER', undefined);

    const code = await buildEntry(root, { envPrefix: ['VITE_', 'BROWSER'], app: true });

    expect(code).not.toContain('local-');
    expect(code).toContain('"production"');
  });

  it('keeps values Vite loads from another envDir', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'envs'));
    writeFileSync(join(root, '.env'), 'VITE_API=local-api\n');
    writeFileSync(join(root, 'envs', '.env.production'), 'VITE_API=prod-api\n');
    writeFileSync(join(root, 'entry.js'), 'export const api = import.meta.env.VITE_API;\n');
    vi.stubEnv('VITE_API', undefined);

    const code = await buildEntry(root, { envDir: 'envs' });

    expect(code).toContain('"prod-api"');
  });

  it('reports server and required names without values', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    defineEnv({
      API_TOKEN: string(),
      OPTIONAL_REGION: string().optional(),
      VITE_TITLE: string(),
    });
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
    const facts: Array<unknown> = [];

    const plugin = envSchemaPlugin(root, { onSchema: (value) => facts.push(value) });
    const configHook = plugin.config as (config: Record<string, unknown>, env: unknown) => unknown;
    await configHook.call({}, { envPrefix: 'PUBLIC_' }, { mode: 'production' });

    expect(facts.at(-1)).toEqual({
      keys: ['API_TOKEN', 'OPTIONAL_REGION', 'VITE_TITLE'],
      clientKeys: ['VITE_TITLE'],
      serverKeys: ['API_TOKEN', 'OPTIONAL_REGION'],
      requiredServerKeys: ['API_TOKEN'],
    });
  });

  // Register via defineEnv: jiti's env.ts module instance is invisible to Vitest.
  it('warns when vite `define` shadows a schema env key', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    defineEnv({ STRIPE_KEY: string(), VITE_TITLE: string() });

    const root = createTempRoot();
    writeFileSync(
      join(root, 'env.ts'),
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ STRIPE_KEY: string(), VITE_TITLE: string() });\n',
    );

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin); // sets envFile so configResolved emits the warning

    // voidWarn writes via console.log (with ANSI yellow), not console.warn.
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigResolved(plugin, {
      mode: 'development',
      envDir: root,
      define: {
        'process.env.STRIPE_KEY': '"shadowed"',
        'import.meta.env.VITE_TITLE': '"hello"',
        // unrelated define — should not be flagged
        __BUILD_VERSION__: '"1.2.3"',
      },
    });

    const calls = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
    warnSpy.mockRestore();
    const joined = calls.join('\n');
    expect(joined).toContain('shadowing schema env keys');
    expect(joined).toContain('STRIPE_KEY');
    expect(joined).toContain('VITE_TITLE');
    expect(joined).not.toContain('__BUILD_VERSION__');
  });

  it('does not warn when define has no overlap with the schema', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    defineEnv({ STRIPE_KEY: string() });

    const root = createTempRoot();
    writeFileSync(
      join(root, 'env.ts'),
      'import { defineEnv, string } from "void/env";\n' +
        'export default defineEnv({ STRIPE_KEY: string() });\n',
    );

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);

    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigResolved(plugin, {
      mode: 'development',
      envDir: root,
      define: {
        'process.env.UNRELATED': '"x"',
        __BUILD_VERSION__: '"1.2.3"',
      },
    });

    const calls = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
    warnSpy.mockRestore();
    const joined = calls.join('\n');
    expect(joined).not.toContain('shadowing schema env keys');
  });

  it('adds client-exposed schema defaults to Vite env', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { number, string } = await import('../../src/runtime/env-helpers.ts');
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);
    defineEnv({ VITE_GIT_SHA: string().default('abc123'), PORT: number().default(3000) });

    const resolved = {
      mode: 'development',
      envDir: root,
      envPrefix: 'VITE_',
      env: {},
      define: {},
    };
    await runConfigResolved(plugin, resolved);

    expect(resolved.env).toEqual({ VITE_GIT_SHA: 'abc123' });
    expect('PORT' in resolved.env).toBe(false);
  });

  it('does not overwrite a Vite env value with a schema default', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);
    defineEnv({ VITE_TITLE: string().default('Default') });

    const resolved = {
      mode: 'development',
      envDir: root,
      envPrefix: 'VITE_',
      env: { VITE_TITLE: 'FromEnv' },
      define: {},
    };
    await runConfigResolved(plugin, resolved);

    expect(resolved.env.VITE_TITLE).toBe('FromEnv');
  });

  it('uses VITE_ even when Vite has a custom envPrefix', async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    const { string } = await import('../../src/runtime/env-helpers.ts');
    const root = createTempRoot();
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');

    const plugin = envSchemaPlugin(root);
    await runConfig(plugin);
    defineEnv({
      PUBLIC_TITLE: string().default('Public'),
      VITE_TITLE: string().default('Vite'),
    });

    const resolved = {
      mode: 'development',
      envDir: root,
      envPrefix: ['PUBLIC_'],
      env: {},
      define: {},
    };
    await runConfigResolved(plugin, resolved);

    expect(resolved.env).toEqual({ VITE_TITLE: 'Vite' });
  });
});

describe('envSchemaPlugin reserved __VOID_ names', () => {
  async function runConfigFor(root: string, command: 'serve' | 'build'): Promise<void> {
    const handler = envSchemaPlugin(root).config as (c: unknown, e: unknown) => Promise<void>;
    await handler.call(
      {},
      {},
      { command, mode: command === 'build' ? 'production' : 'development' },
    );
  }

  afterEach(async () => {
    const { defineEnv } = await import('../../src/runtime/env-public.ts');
    defineEnv({});
  });

  // The .env check does not depend on the command, so serve covers it.
  for (const withEnvTs of [false, true]) {
    it.each(['__VOID_PROXY_TOKEN', '__VOID_EMAIL_FROM'])(
      `rejects %s in .env (env.ts: ${withEnvTs})`,
      async (key) => {
        const root = createTempRoot();
        if (withEnvTs) {
          writeFileSync(join(root, 'env.ts'), 'export default {};\n');
        }
        writeFileSync(join(root, '.env'), `API_URL=http://localhost\n${key}=local\n`);

        await expect(runConfigFor(root, 'serve')).rejects.toThrow(
          `.env defines names reserved for Void: ${key}. Void sets these itself; remove them. ` +
            'To trigger crons or queues locally, use the x-void-dev-trigger header printed at dev start.',
        );
      },
    );
  }

  // Wrangler loads these forms into the dev Worker too.
  it.each([
    ['export __VOID_PROXY_TOKEN=x', '__VOID_PROXY_TOKEN'],
    ['__VOID_EMAIL_FROM: a@b.c', '__VOID_EMAIL_FROM'],
  ])('rejects the Wrangler-only line %s in .env', async (line, key) => {
    const root = createTempRoot();
    writeFileSync(join(root, '.env'), `API_URL=http://localhost\n${line}\n`);

    await expect(runConfigFor(root, 'serve')).rejects.toThrow(
      `.env defines names reserved for Void: ${key}.`,
    );
  });

  it('ignores __VOID_ in a comment or a value', async () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, '.env'),
      '# __VOID_X=1\nAPI_URL=http://localhost/__VOID_X\nNOTE: __VOID_Y=2\n',
    );

    await expect(runConfigFor(root, 'serve')).resolves.toBeUndefined();
  });

  it('accepts a normal .env and a reserved name set only in the shell', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, '.env'), 'API_URL=http://localhost\n');
    vi.stubEnv('__VOID_PROXY_TOKEN', 'from-shell');

    await expect(runConfigFor(root, 'serve')).resolves.toBeUndefined();
  });

  it.each(['serve', 'build'] as const)(
    'rejects a reserved name declared in env.ts (%s)',
    async (command) => {
      const { defineEnv } = await import('../../src/runtime/env-public.ts');
      const { string } = await import('../../src/runtime/env-helpers.ts');
      const root = createTempRoot();
      writeFileSync(join(root, 'env.ts'), 'export default {};\n');
      defineEnv({ API_URL: string(), __VOID_X: string().optional() });

      await expect(runConfigFor(root, command)).rejects.toThrow(
        'env.ts declares names reserved for Void: __VOID_X.',
      );
    },
  );
});

describe('envSchemaPlugin with "sideEffects": false', () => {
  const publicEnvUrl = pathToFileURL(
    join(import.meta.dirname, '../../src/runtime/env-public.ts'),
  ).href;

  /** Build an app that declares no side effects, with an entry that imports env.ts for its side effect. */
  async function buildEntryImportingEnv(
    consumer: 'server' | 'client',
    options: { symlinkTo?: string } = {},
  ): Promise<string> {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', sideEffects: false }),
    );
    const schemaFile = join(root, options.symlinkTo ?? 'env.ts');
    writeFileSync(
      schemaFile,
      `import { defineEnv, number } from ${JSON.stringify(publicEnvUrl)};\n` +
        'export default defineEnv({ SCHEMA_DEFAULT: number().default(48213) });\n',
    );
    if (options.symlinkTo) {
      symlinkSync(schemaFile, join(root, 'env.ts'));
    }
    writeFileSync(join(root, 'entry.js'), 'import "./env.ts";\nexport const ready = true;\n');
    const entry = join(root, 'entry.js');
    const output = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [envSchemaPlugin(root)],
      build: {
        ssr: consumer === 'server' ? entry : false,
        write: false,
        minify: false,
        rollupOptions: {
          ...(consumer === 'client' && { input: entry }),
          external: ['cloudflare:workers'],
        },
      },
    });
    return [output]
      .flat()
      .flatMap((result) => ('output' in result ? result.output : []))
      .map((chunk) => ('code' in chunk ? chunk.code : ''))
      .join('\n');
  }

  // Void's server entries import env.ts to register its schema.
  it('keeps env.ts in a server build', async () => {
    expect(await buildEntryImportingEnv('server')).toContain('48213');
  });

  // Vite loads a symlinked env.ts under its target's path. Windows needs privileges for a file
  // symlink.
  it.skipIf(process.platform === 'win32')(
    'keeps a symlinked env.ts whose target has another name',
    async () => {
      expect(await buildEntryImportingEnv('server', { symlinkTo: 'shared-schema.ts' })).toContain(
        '48213',
      );
    },
  );

  it('leaves client builds to the side effects that the app declares', async () => {
    expect(await buildEntryImportingEnv('client')).not.toContain('48213');
  });
});
