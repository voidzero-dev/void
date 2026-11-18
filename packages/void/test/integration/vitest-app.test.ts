import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const repository = join(import.meta.dirname, '../../../..');

// Run the app's tests as `vp test` runs them in the app's own terminal, not as part of this run.
const appTestEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('VITEST') && key !== 'TEST' && key !== 'NODE_ENV',
  ),
);

async function runAppTests(root: string, args: Array<string> = []) {
  const child = spawn('vp', ['test', 'run', ...args], {
    cwd: root,
    env: appTestEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, output };
}

function writeTest(root: string, source: string): void {
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests/app.test.ts'), source);
}

describe('vp test in a Void app', () => {
  let playground: IsolatedPlayground;

  beforeAll(() => {
    playground = createIsolatedPlayground(repository, 'playground/react-pages');
    writeTest(
      playground.root,
      `import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import * as schema from '@schema';
import { db } from 'void/db';
import { loader } from '../pages/index.server.ts';
import { GET } from '../routes/api/health.ts';

describe('app', () => {
  it('runs a route handler', async () => {
    const response = await new Hono().get('/api/health', GET).request('/api/health');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('imports a page loader', () => {
    expect(loader).toBeTypeOf('function');
  });

  it('imports the schema and void/db', () => {
    expect(Object.keys(schema)).toContain('users');
    expect(db).toBeDefined();
  });
});
`,
    );
  });

  afterAll(() => {
    playground?.cleanup();
  });

  it('runs the tests without starting the Worker or migrating the local database', async () => {
    const { code, output } = await runAppTests(playground.root);

    expect(code, output).toBe(0);
    expect(output).toContain('3 passed');
    expect(output).not.toMatch(/Applied \d+ migration/);
    expect(existsSync(join(playground.root, '.void/v3'))).toBe(false);
  });

  it('runs them with nodejs_compat and in another mode', async () => {
    const configPath = join(playground.root, 'void.config.ts');
    const config = readFileSync(configPath, 'utf8');
    const compatibilityDate = "compatibility_date: '2026-02-24',";
    expect(config).toContain(compatibilityDate);
    writeFileSync(
      configPath,
      config.replace(
        compatibilityDate,
        `${compatibilityDate}\n    compatibility_flags: ['nodejs_compat'],`,
      ),
    );

    const { code, output } = await runAppTests(playground.root, ['--mode', 'staging']);

    expect(code, output).toBe(0);
    expect(output).toContain('3 passed');
  });
});

describe('vp test in a framework app', () => {
  let playground: IsolatedPlayground;

  beforeAll(() => {
    // Void turns on nodejs_compat for TanStack Start, React Router and vinext apps.
    playground = createIsolatedPlayground(repository, 'playground/tanstack-start');
    writeTest(
      playground.root,
      `import { expect, it } from 'vite-plus/test';
import * as schema from '@schema';

it('imports the schema', () => {
  expect(Object.keys(schema)).toContain('users');
});
`,
    );
  });

  afterAll(() => {
    playground?.cleanup();
  });

  it('runs the tests', async () => {
    const { code, output } = await runAppTests(playground.root);

    expect(code, output).toBe(0);
    expect(output).toContain('1 passed');
  });
});
