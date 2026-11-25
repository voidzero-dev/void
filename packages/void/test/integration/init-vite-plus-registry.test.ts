import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crossSpawn from 'cross-spawn';
import { expect, it } from 'vite-plus/test';
import { configureVitePlusScaffold } from '../../src/cli/init-vite-plus.ts';
import { SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } from '../../src/cli/template.ts';

it('installs the tested Vite+ pair even when newer CLI and core releases are available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-vite-plus-registry-'));
  const tested = JSON.parse(
    readFileSync(new URL(import.meta.resolve('vite-plus/package.json')), 'utf8'),
  ) as { version: string; dependencies: { vite: string } };
  const coreName = '@voidzero-dev/vite-plus-core';
  const coreVersion = tested.dependencies.vite.slice(`npm:${coreName}@`.length);
  const newerCli = `${Number(tested.version.split('.')[0])}.999.0`;
  const newerCore = `${Number(coreVersion.split('.')[0]) + 1}.0.0`;
  const patchCore = coreVersion.replace(/\d+$/, (patch: string) => String(Number(patch) + 1));
  const releases = [
    {
      name: 'vite-plus',
      version: tested.version,
      dependencies: { vite: tested.dependencies.vite },
    },
    {
      name: 'vite-plus',
      version: newerCli,
      dependencies: { vite: `npm:${coreName}@${newerCore}` },
    },
    ...[coreVersion, patchCore, newerCore].map((version) => ({ name: coreName, version })),
  ];
  const archives = releases.map((manifest, index) => {
    const directory = join(root, `release-${index}`);
    mkdirSync(join(directory, 'package'), { recursive: true });
    writeFileSync(join(directory, 'package/package.json'), JSON.stringify(manifest));
    const archive = join(directory, 'package.tgz');
    execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
    return readFileSync(archive);
  });
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname);
    if (pathname.startsWith('/archive/')) {
      const archive = archives[Number(pathname.slice('/archive/'.length))];
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(archive);
      return;
    }
    const name = pathname.slice(1);
    const matches = releases.filter((release) => release.name === name);
    if (!matches.length) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        name,
        'dist-tags': { latest: matches.at(-1)!.version },
        versions: Object.fromEntries(
          matches.map((manifest) => {
            const index = releases.indexOf(manifest);
            return [
              manifest.version,
              {
                ...manifest,
                dist: {
                  tarball: `${origin}/archive/${index}`,
                  integrity: `sha512-${createHash('sha512').update(archives[index]).digest('base64')}`,
                },
              },
            ];
          }),
        ),
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP registry');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const project = join(root, 'app');
    mkdirSync(project);
    const manifest = { private: true, devDependencies: { ...SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } };
    configureVitePlusScaffold(project, 'npm', manifest);
    writeFileSync(join(project, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'npmrc'), '');
    const child = crossSpawn(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        origin,
        '--cache',
        join(root, 'cache'),
        '--userconfig',
        join(root, 'npmrc'),
        '--globalconfig',
        join(root, 'npmrc-global'),
      ],
      { cwd: project, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'pipe' },
    );
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    const timeout = setTimeout(() => child.kill(), 30_000);
    try {
      const [code] = await once(child, 'close');
      expect(code, output).toBe(0);
    } finally {
      clearTimeout(timeout);
    }
    const installed = (name: string) =>
      JSON.parse(readFileSync(join(project, 'node_modules', name, 'package.json'), 'utf8')) as {
        version: string;
        dependencies?: Record<string, string>;
      };
    expect(installed('vite-plus').version).toBe(tested.version);
    expect(installed('vite').version).toBe(coreVersion);
    expect(installed('vite-plus').dependencies?.vite).toBe(
      `npm:${coreName}@${installed('vite').version}`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(root, { recursive: true, force: true });
  }
});
