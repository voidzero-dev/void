import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vite-plus/test';
import { prepareCompatibilityBuild } from '../../../../.github/scripts/schema-compat-tests.ts';

const exec = promisify(execFile);
const repository = join(import.meta.dirname, '../../../..');
const roots: Array<string> = [];

function workspace(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'void-shared-build-')));
  roots.push(root);
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(
    realpathSync.native(join(repository, 'node_modules/vite-plus')),
    join(root, 'node_modules/vite-plus'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/build-setup.ts'), '// This fixture uses the shared setup below.');
  writeFileSync(join(root, '.node-version'), readFileSync(join(repository, '.node-version')));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'void-shared-build-test', private: true, type: 'module' }),
  );
  writeFileSync(
    join(root, 'vite.config.mjs'),
    `export default {
  run: { tasks: { build: { command: 'node build.mjs', cache: false } } },
  test: { projects: [{ extends: false, test: {
    name: 'platform-api-integration-probe', include: ['probe.test.ts'], maxWorkers: 1,
    globalSetup: [${JSON.stringify(join(repository, 'test/build-setup.ts'))}]
  } }] }
};`,
  );
  writeFileSync(
    join(root, 'build.mjs'),
    `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const count=existsSync('build-count.txt')?Number(readFileSync('build-count.txt','utf8')):0;
writeFileSync('build-count.txt',String(count+1));
writeFileSync('artifact.txt','prepared');`,
  );
  writeFileSync(
    join(root, 'probe.test.ts'),
    `import {readFileSync} from 'node:fs';import {expect,it} from 'vite-plus/test';
it('consumes shared immutable artifacts',()=>{
  expect(readFileSync('artifact.txt','utf8')).toBe('prepared');
  expect(readFileSync('build-count.txt','utf8')).toBe('1');
});`,
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

it('prepares once before independent Vitest processes import the same artifacts', async () => {
  const root = workspace();
  const config = prepareCompatibilityBuild(root);
  expect(config).toBeDefined();
  await Promise.all(
    [0, 1].map(() =>
      exec('vp', ['test', 'run', '--config', config!], {
        cwd: root,
        env: { ...process.env, NODE_ENV: undefined },
      }),
    ),
  );
  expect(readFileSync(join(root, 'build-count.txt'), 'utf8')).toBe('1');
});

it('does not hand off a failed preparation as ready', () => {
  const root = workspace();
  writeFileSync(join(root, 'build.mjs'), "throw new Error('intentional preparation failure');");
  expect(() => prepareCompatibilityBuild(root)).toThrow('Could not prepare public artifacts');
  expect(existsSync(join(root, 'node_modules/.cache/void-schema-compat/vite.config.mjs'))).toBe(
    false,
  );
});

it('leaves older deployed test harnesses on their original configuration', () => {
  const root = workspace();
  rmSync(join(root, 'test/build-setup.ts'));
  expect(prepareCompatibilityBuild(root)).toBeUndefined();
  expect(existsSync(join(root, 'build-count.txt'))).toBe(false);
});
