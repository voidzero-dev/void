import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vite-plus/test';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
const apiRoot = join(repositoryRoot, 'platform/packages/api');
const dockerfile = readFileSync(join(apiRoot, 'container/Dockerfile'), 'utf8');
const copies = Array.from(
  dockerfile.matchAll(/^COPY (\S+) (\S+)$/gm),
  ([, source, destination]) => ({ source, destination }),
);

it.each(['0.20.0', '0.20.1', '0.21.0-rc.2'])(
  'packages the agent with the release manifest, without a checkout or node_modules (%s)',
  (version) => {
    const directory = mkdtempSync(join(tmpdir(), 'void-build-image-'));
    try {
      expect(copies.map((copy) => copy.source).sort()).toEqual([
        'packages/void/package.json',
        'platform/packages/api/container/build-agent.mjs',
      ]);
      for (const { source, destination } of copies) {
        const target = join(directory, destination);
        mkdirSync(dirname(target), { recursive: true });
        if (source === 'packages/void/package.json') {
          const manifest = JSON.parse(readFileSync(join(repositoryRoot, source), 'utf8'));
          writeFileSync(target, JSON.stringify({ ...manifest, version }));
        } else {
          copyFileSync(join(repositoryRoot, source), target);
        }
      }
      const entrypoint = JSON.parse(/^CMD (.+)$/m.exec(dockerfile)![1]) as Array<string>;
      expect(entrypoint[0]).toBe('node');
      const agentUrl = pathToFileURL(join(directory, entrypoint[1])).href;
      // The fallback must not depend on cwd or the application's package version.
      const untrusted = join(directory, 'app');
      mkdirSync(untrusted);
      writeFileSync(
        join(untrusted, 'package.json'),
        JSON.stringify({ name: 'void', version: '99.0.0' }),
      );
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `const agent = await import(${JSON.stringify(agentUrl)}); process.stdout.write(agent.DEFAULT_VOID_CLI_VERSION);`,
        ],
        {
          cwd: untrusted,
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            WINDIR: process.env.WINDIR,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(version);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('uses the root build context in every configured container and in CI', () => {
  const wrangler = readFileSync(join(apiRoot, 'wrangler.jsonc'), 'utf8');
  const contexts = Array.from(
    wrangler.matchAll(/"image": "\.\/container\/Dockerfile",\s*"image_build_context": "([^"]+)"/g),
    (match) => match[1],
  );
  // Both container sizes in the base, staging and production configurations.
  expect(contexts).toHaveLength(6);
  expect(contexts.every((context) => resolve(apiRoot, context) === repositoryRoot)).toBe(true);
  const workflow = readFileSync(join(repositoryRoot, '.github/workflows/platform-ci.yml'), 'utf8');
  expect(workflow).toContain('--file platform/packages/api/container/Dockerfile .');
});

it('allows only the public manifest and container sources into the root build context', () => {
  // The uploader pipes its Dockerfile on stdin, so a Dockerfile-specific ignore
  // file would not protect local credentials or node_modules in the checkout.
  const patterns = readFileSync(join(repositoryRoot, '.dockerignore'), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));
  expect(patterns).toEqual([
    '**',
    '!packages/void/package.json',
    '!platform/packages/api/container/build-agent.mjs',
    '!platform/packages/api/container/Dockerfile',
  ]);
});
