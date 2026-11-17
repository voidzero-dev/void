import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { fixtureBuildCacheArgs, linkFixtureDependencies } from './integration-helpers.ts';

export type FixtureFramework = 'react' | 'vue' | 'svelte' | 'solid';
export type FixtureApp = {
  framework: FixtureFramework;
  name: string;
  files: Readonly<Record<string, string>>;
};

const repository = fileURLToPath(new URL('../', import.meta.url));
const plugins = {
  react: 'voidReact',
  vue: 'voidVue',
  svelte: 'voidSvelte',
  solid: 'voidSolid',
} as const;
const ownershipFile = '.void-test-fixture.json';
const generated = new Set([
  ownershipFile,
  'node_modules',
  'dist',
  '.cloudflare',
  '.void',
  '.wrangler',
  '.vite',
]);

export function fixtureBuildRoot(fixture: FixtureApp): string {
  return join(
    repository,
    'playground-local',
    '.build-fixtures',
    `${fixture.framework}-${fixture.name}`,
  );
}

/** Materialize inputs before Vite Task checks the build cache. No build results are cached here. */
export function prepareFixture(
  fixture: FixtureApp,
  root: string = fixtureBuildRoot(fixture),
): void {
  mkdirSync(root, { recursive: true });
  root = realpathSync.native(root);
  const ownership = JSON.stringify({ framework: fixture.framework, name: fixture.name });
  const marker = join(root, ownershipFile);
  if (existsSync(marker)) {
    if (readFileSync(marker, 'utf8') !== ownership) {
      throw new Error(`Fixture directory belongs to a different application: ${root}`);
    }
  } else {
    if (readdirSync(root).length) {
      throw new Error(`Refusing to replace files in an unowned fixture directory: ${root}`);
    }
    writeFileSync(marker, ownership, { flag: 'wx' });
  }
  // This directory belongs to the fixture. Preserve outputs so Vite Task can validate/restore
  // them, but replace the complete authored input tree, including deleted routes.
  for (const entry of readdirSync(root)) {
    if (!generated.has(entry)) {
      rmSync(join(root, entry), { recursive: true, force: true });
    }
  }
  const packageRoot = join(repository, 'packages', fixture.framework);
  linkFixtureDependencies(packageRoot, root, {
    void: join(repository, 'packages/void'),
    [`@void/${fixture.framework}`]: packageRoot,
    '@void/md': join(repository, 'packages/md'),
  });
  const plugin = plugins[fixture.framework];
  const files = {
    'package.json': JSON.stringify({
      name: `void-test-${fixture.framework}-${fixture.name}`,
      private: true,
      type: 'module',
      dependencies: {
        void: 'workspace:*',
        [`@void/${fixture.framework}`]: 'workspace:*',
        '@void/md': 'workspace:*',
      },
    }),
    'vite.config.mjs': `import { voidPlugin } from 'void';
import { ${plugin} } from '@void/${fixture.framework}/plugin';
import { voidMarkdown } from '@void/md/plugin';
export default { plugins: [voidPlugin(), ${plugin}(), voidMarkdown()] };
`,
    'void.config.ts': `import { defineConfig } from 'void/config';
export default defineConfig({ output: 'static', worker: { compatibility_date: '2026-02-24' } });
`,
    // Use the fixture's installed Vite instance and its public builder API. Running another
    // task-runner CLI here would make workspace discovery part of this build's inputs.
    'build.mjs': `import { realpathSync } from 'node:fs';
process.env.NODE_ENV = 'production';
process.chdir(realpathSync.native(import.meta.dirname));
const { createBuilder } = await import('vite');
const builder = await createBuilder({ configLoader: 'native' });
await builder.buildApp();
`,
    'pages/about.md': '---\ntitle: About\n---\n\n# About\n',
    ...fixture.files,
  };
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

export type BuiltFixture = {
  root: string;
  page(file: string): { html: string; css: string };
  output(dir: 'client' | 'ssr'): Map<string, string>;
  cleanup(): void;
};

/** One immutable cached build can supply separate writable runtime copies. */
export function buildFixture(fixture: FixtureApp): BuiltFixture {
  prepareFixture(fixture);
  const result = spawn.sync(
    'vp',
    [
      'run',
      '--ignore-depends-on',
      ...fixtureBuildCacheArgs(),
      `@void/${fixture.framework}#build:test:${fixture.name}`,
    ],
    {
      cwd: repository,
      env: { ...process.env, NODE_ENV: undefined },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Fixture build failed.\n${result.stdout ?? ''}${result.stderr ?? ''}`, {
      cause: result.error,
    });
  }
  const runs = join(repository, 'playground-local', '.test-fixtures');
  mkdirSync(runs, { recursive: true });
  const root = mkdtempSync(join(runs, `${fixture.framework}-${fixture.name}-`));
  try {
    prepareFixture(fixture, root);
    const built = fixtureBuildRoot(fixture);
    for (const directory of ['dist', '.cloudflare']) {
      if (existsSync(join(built, directory))) {
        cpSync(join(built, directory), join(root, directory), { recursive: true });
      }
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const client = join(root, 'dist/client');
  return {
    root,
    page(file) {
      const html = readFileSync(join(client, file), 'utf8');
      const css = html
        .split('<link rel="stylesheet" href="')
        .slice(1)
        .map((rest) => rest.slice(0, rest.indexOf('"')))
        .map((href) => readFileSync(join(client, href), 'utf8'))
        .join('\n');
      return { html, css };
    },
    output(dir) {
      const output = join(root, 'dist', dir);
      const files = new Map<string, string>();
      for (const file of readdirSync(output, { recursive: true, encoding: 'utf8' })) {
        if (/\.(js|css|html)$/.test(file)) {
          files.set(file, readFileSync(join(output, file), 'utf8'));
        }
      }
      return files;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}
