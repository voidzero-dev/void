import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vite-plus/test';
import type { FixtureApp } from '../../../../test/fixture-app.ts';

const repository = join(import.meta.dirname, '../../../..');
let root: string;
let fixture: FixtureApp;
let initialHtml: string;

function writeInputs(): void {
  writeFileSync(join(root, 'fixture.json'), JSON.stringify(fixture));
}

function build() {
  writeInputs();
  const result = spawn.sync('vp', ['run', 'build'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: undefined, NO_COLOR: '1', FORCE_COLOR: undefined },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: stripVTControlCharacters(`${result.stdout ?? ''}${result.stderr ?? ''}`),
  };
}

function succeed() {
  const result = build();
  expect(result.status, result.output).toBe(0);
  return result.output;
}

function html(page = 'index'): string {
  return readFileSync(join(root, 'app/dist/client', `${page}.html`), 'utf8');
}

function expectBuildHit(output: string): void {
  expect(
    output
      .replaceAll('\\', '/')
      .split('\n')
      .some((line) => line.includes('app/build.mjs') && line.includes('cache hit')),
    output,
  ).toBe(true);
}

function baseline(): FixtureApp {
  return {
    framework: 'react',
    name: 'cache-contract',
    files: {
      'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }),
      'pages/index.island.tsx': `import { message } from '../message';
export default function Page() { return <><h1>{message}</h1><p>{__FIXTURE_LABEL__}</p></>; }`,
      'vite.config.mjs': `import { voidPlugin } from 'void';
import { voidReact } from '@void/react/plugin';
import { voidMarkdown } from '@void/md/plugin';
import { loadEnv } from 'vite';
export default ({ mode }) => ({ plugins: [voidPlugin(), voidReact(), voidMarkdown()],
  define: { __FIXTURE_LABEL__: JSON.stringify(loadEnv(mode, process.cwd(), 'VITE_').VITE_FIXTURE_LABEL ?? '') }
});`,
      'message.ts': "export const message = 'original fixture';",
      'pages/removed.island.tsx': 'export default function Removed() { return <h1>Removed</h1>; }',
    },
  };
}

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'void-build-cache-')));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(
    realpathSync(join(repository, 'node_modules/vite-plus')),
    join(root, 'node_modules/vite-plus'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  writeFileSync(join(root, '.node-version'), readFileSync(join(repository, '.node-version')));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'void-build-cache-contract', private: true, type: 'module' }),
  );
  writeFileSync(
    join(root, 'vite.config.mjs'),
    `export default { run: { tasks: {
  prepare: { command: 'node prepare.mjs', cache: false },
  build: { command: 'node app/build.mjs', dependsOn: ['prepare'] },
} } };
`,
  );
  const materializer = pathToFileURL(join(repository, 'test/fixture-app.ts')).href;
  writeFileSync(
    join(root, 'prepare.mjs'),
    `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareFixture } from ${JSON.stringify(materializer)};
prepareFixture(JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8')),
  fileURLToPath(new URL('./app', import.meta.url)));
`,
  );
  fixture = baseline();
  succeed();
  initialHtml = html();
});

beforeEach(() => {
  fixture = baseline();
});

afterAll(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

it('restores deleted production artifacts byte-for-byte without compiling again', () => {
  rmSync(join(root, 'app/dist'), { recursive: true, force: true });
  rmSync(join(root, 'app/.cloudflare'), { recursive: true, force: true });
  expectBuildHit(succeed());
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  expect(digest(html())).toBe(digest(initialHtml));
  expect(existsSync(join(root, 'app/.cloudflare/output/v1/config.json'))).toBe(true);
});

it('invalidates a transitive source dependency', () => {
  fixture.files = {
    ...fixture.files,
    'message.ts': "export const message = 'changed dependency';",
  };
  succeed();
  expect(html()).toContain('changed dependency');
  expect(html()).not.toContain('original fixture');
});

it('discovers a newly added route', () => {
  fixture.files = {
    ...fixture.files,
    'pages/added.island.tsx': 'export default function Added() { return <h1>Added route</h1>; }',
  };
  succeed();
  expect(html('added')).toContain('Added route');
});

it('removes deleted source and its old generated output', () => {
  const files = { ...fixture.files };
  delete files['pages/removed.island.tsx'];
  fixture.files = files;
  succeed();
  expect(existsSync(join(root, 'app/pages/removed.island.tsx'))).toBe(false);
  expect(existsSync(join(root, 'app/dist/client/removed.html'))).toBe(false);
});

it('rebuilds after application configuration changes', () => {
  fixture.files = {
    ...fixture.files,
    'void.config.ts': `import { defineConfig } from 'void/config';
export default defineConfig({ output: 'static', head: { title: 'Changed fixture title' },
  worker: { compatibility_date: '2026-02-24' } });`,
  };
  succeed();
  expect(html()).toContain('<title>Changed fixture title</title>');
});

it('tracks environment files that were absent during the previous build', () => {
  succeed();
  fixture.files = {
    ...fixture.files,
    '.env': 'VITE_FIXTURE_LABEL=fixture environment',
  };
  succeed();
  expect(html()).toContain('fixture environment');
  fixture.files = { ...fixture.files, '.env': 'VITE_FIXTURE_LABEL=updated environment' };
  succeed();
  expect(html()).toContain('updated environment');
});

it('never turns a failed build into a cache hit and recovers after its inputs are fixed', () => {
  fixture.files = {
    ...fixture.files,
    'vite.config.mjs': "throw new Error('fixture build rejected');",
  };
  const failed = build();
  expect(failed.status).not.toBe(0);
  expect(failed.output).toContain('fixture build rejected');
  const retry = build();
  expect(retry.status).not.toBe(0);
  expect(retry.output).not.toMatch(/app\/build\.mjs.*cache hit/);
  fixture = baseline();
  succeed();
  const recovered = html();
  expectBuildHit(succeed());
  expect(html()).toBe(recovered);
  expect(html()).toContain('original fixture');
});
