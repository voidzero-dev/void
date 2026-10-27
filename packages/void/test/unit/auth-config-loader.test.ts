import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunnableDevEnvironment, createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_CONFIG_ENVIRONMENT,
  devAuthConfigImporter,
  loadVoidAuthConfig,
  projectAuthConfigImporter,
} from '../../src/auth/config.ts';

const tempDirs: Array<string> = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'void-auth-config-'));
  tempDirs.push(dir);
  return dir;
}

describe('loadVoidAuthConfig', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('returns undefined without a config file', async () => {
    const importModule = vi.fn();
    expect(await loadVoidAuthConfig(null, importModule)).toBeUndefined();
    expect(importModule).not.toHaveBeenCalled();
  });

  it('reads the default export', async () => {
    const dir = createTempDir();
    const path = join(dir, 'auth.ts');
    writeFileSync(path, "export default { marker: 'default' };");
    expect(await loadVoidAuthConfig(path, projectAuthConfigImporter(dir))).toEqual({
      marker: 'default',
    });
  });

  // The Worker imports only the default export.
  it.each(['auth', 'config'])('rejects a config with only an `%s` export', async (name) => {
    const dir = createTempDir();
    const path = join(dir, 'auth.ts');
    writeFileSync(path, `export const ${name} = { marker: 'named' };`);
    await expect(loadVoidAuthConfig(path, projectAuthConfigImporter(dir))).rejects.toThrow(
      `${path} has no default export. Export the auth config with \`export default defineAuth(...)\`.`,
    );
  });

  // Vitest resolves the native `import()` itself; plain Node is what `void prepare` runs in.
  // `void prepare` boots no Vite: it never evaluates vite.config, whose plugins write files
  // when constructed. `@fields` comes from tsconfig `paths`, `@schema` from Void's own alias.
  it('resolves extensionless, tsconfig paths and @schema imports in void prepare without vite.config', () => {
    const root = createTempDir();
    mkdirSync(join(root, 'lib'));
    mkdirSync(join(root, 'fields'));
    mkdirSync(join(root, 'db'));
    const marker = join(root, 'vite-config-loaded');
    writeFileSync(
      join(root, 'vite.config.ts'),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(marker)}, '');`,
        'export default {};',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@fields/*': ['./fields/*'] } } }),
    );
    writeFileSync(
      join(root, 'auth.ts'),
      [
        "import type { VoidAuthConfig } from 'void/auth';",
        "import { nickname } from './lib/nickname';",
        "import { pronouns } from '@fields/pronouns';",
        "import { website } from '@schema';",
        'export default { user: { additionalFields: { nickname, pronouns, website } } } satisfies VoidAuthConfig;',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'lib', 'nickname.ts'),
      "export const nickname = { type: 'string', required: false } as const;",
    );
    writeFileSync(
      join(root, 'fields', 'pronouns.ts'),
      "export const pronouns = { type: 'string', required: false } as const;",
    );
    writeFileSync(
      join(root, 'db', 'schema.ts'),
      "export const website = { type: 'string', required: false } as const;",
    );

    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const { prepareProject } = await import(process.argv[1]); await prepareProject(process.argv[2]);',
        fileURLToPath(new URL('../../src/codegen/prepare.ts', import.meta.url)),
        root,
      ],
      { stdio: 'pipe' },
    );

    const schema = readFileSync(join(root, '.void', 'better-auth-schema.ts'), 'utf8');
    expect(schema).toContain('nickname');
    expect(schema).toContain('pronouns');
    expect(schema).toContain('website');
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('evaluates the config through the module importer it is given', async () => {
    const importModule = vi.fn(async () => ({ default: { marker: 'runner' } }));
    expect(await loadVoidAuthConfig('/app/auth.ts', importModule)).toEqual({ marker: 'runner' });
    expect(importModule).toHaveBeenCalledWith('/app/auth.ts');
  });

  it("imports through the dev server's auth config environment, or with its aliases", async () => {
    const dir = createTempDir();
    const path = join(dir, 'auth.ts');
    writeFileSync(path, "export default { marker: 'first' };");
    const server = await createServer({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, watch: null },
      environments: {
        [AUTH_CONFIG_ENVIRONMENT]: {
          consumer: 'server',
          dev: { createEnvironment: (name, config) => createRunnableDevEnvironment(name, config) },
        },
      },
    });
    try {
      const importModule = devAuthConfigImporter(server);
      expect(await loadVoidAuthConfig(path, importModule)).toEqual({ marker: 'first' });
    } finally {
      await server.close();
    }
    mkdirSync(join(dir, 'fields'));
    writeFileSync(join(dir, 'fields', 'marker.ts'), "export const marker = 'alias';");
    writeFileSync(path, "import { marker } from '@fields/marker';\nexport default { marker };");
    const plain = await createServer({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: { '@fields': join(dir, 'fields') } },
      server: { middlewareMode: true, ws: false, watch: null },
    });
    try {
      expect(await loadVoidAuthConfig(path, devAuthConfigImporter(plain))).toEqual({
        marker: 'alias',
      });
    } finally {
      await plain.close();
    }
  });
});
