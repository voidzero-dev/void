import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- Containment checks require host-native filesystem paths, not Vite identifiers.
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    out: { type: 'string' },
    archives: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(
    'Usage: node measure-install.mjs --repo <Void checkout> --out <new directory> [--archives <captured cohort>]',
  );
} else {
  try {
    await measure();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function measure() {
  assert(values.repo && values.out, '--repo and --out are required; use --help.');
  const repository = realpathSync(resolve(values.repo));
  // Resolve existing ancestors too: /var and /private/var alias on macOS.
  let ancestor = resolve(values.out);
  const suffix = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    assert.notEqual(parent, ancestor, 'Cannot resolve output directory.');
    ancestor = parent;
  }
  const output = join(realpathSync(ancestor), ...suffix);
  const within = relative(repository, output);
  assert(
    within.startsWith('..' + sep) || within === '..' || isAbsolute(within),
    '--out must be outside the checkout.',
  );
  assert(
    !existsSync(output),
    '--out must be a new directory; existing results are never overwritten.',
  );
  const registryModule = join(repository, '.github/scripts/packed-registry.mjs');
  assert(existsSync(registryModule), 'Not a Void checkout: packed registry helper missing.');
  const { inspectPackage, startPackedRegistry } = await import(pathToFileURL(registryModule));
  const publicPackages = readdirSync(join(repository, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      cwd: join(repository, 'packages', entry.name),
      manifest: JSON.parse(
        readFileSync(join(repository, 'packages', entry.name, 'package.json'), 'utf8'),
      ),
    }))
    .filter((pkg) => pkg.manifest.private !== true);
  const archives = values.archives
    ? realpathSync(resolve(values.archives))
    : join(output, 'archives');
  mkdirSync(output, { recursive: true });
  if (!values.archives) {
    mkdirSync(archives);
    for (const { cwd, manifest } of publicPackages) {
      execFileSync(
        'vp',
        ['pm', 'pack', '--out', join(archives, `${manifest.name.replaceAll('/', '-')}.tgz`)],
        { cwd, stdio: 'pipe' },
      );
    }
  }
  const packages = readdirSync(archives)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => inspectPackage(join(archives, name)));
  for (const { manifest } of publicPackages) {
    assert(
      packages.some((pkg) => pkg.manifest.name === manifest.name),
      `Incomplete cohort: missing ${manifest.name}.`,
    );
  }
  const version = packages.find((pkg) => pkg.manifest.name === 'void')?.manifest.version;
  assert(version, 'Captured cohort must include void.');
  assert(
    packages.some((pkg) => pkg.manifest.name === '@void/platform'),
    'Captured cohort must include @void/platform.',
  );
  for (const pkg of packages) {
    if (pkg.manifest.name === 'void' || pkg.manifest.name.startsWith('@void/')) {
      assert.equal(
        pkg.manifest.version,
        version,
        `${pkg.manifest.name}: inconsistent release cohort version.`,
      );
    }
  }
  const registry = await startPackedRegistry(packages);
  try {
    const config = join(output, '.npmrc');
    writeFileSync(
      join(output, 'package.json'),
      JSON.stringify({ private: true, dependencies: { void: version } }, null, 2) + '\n',
    );
    writeFileSync(
      config,
      `registry=${registry.origin}\naudit=false\nfund=false\nengine-strict=true\n`,
    );
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (
        /^(VOID_|VP_|CLOUDFLARE_|CF_|WRANGLER_|NPM_TOKEN$|NODE_AUTH_TOKEN$|npm_config_)/i.test(key)
      ) {
        delete environment[key];
      }
    }
    environment.npm_config_userconfig = config;
    console.log(`Installing captured cohort: void@${version}, npm --omit=dev`);
    await new Promise((done, fail) => {
      const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: output,
        env: environment,
        stdio: 'inherit',
        timeout: 300_000,
      });
      child.on('error', fail);
      child.on('exit', (code, signal) =>
        code === 0 ? done() : fail(new Error(`npm install failed: ${signal ?? code}`)),
      );
    });
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { findPackageJSON } from 'node:module';
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const file = findPackageJSON('@void/platform', import.meta.resolve('void'));
      const entry = JSON.parse(readFileSync(file, 'utf8')).exports['./installer'].import;
      const { resolvePlatformRuntime } = await import(new URL(entry, pathToFileURL(file)));
      if (resolvePlatformRuntime().manifest.platformVersion !== ${JSON.stringify(version)}) throw new Error('Packaged runtime version mismatch.');
    `,
      ],
      { cwd: output, env: environment, stdio: 'inherit' },
    );

    let uniqueBytes = 0;
    let logicalBytes = 0;
    const seen = new Set();
    const runtimes = [];
    const largeFiles = [];
    const runtimeNames = new Set([
      'cf',
      'miniflare',
      'workerd',
      'wrangler',
      '@cloudflare/runtime-types',
      '@cloudflare/vite-plugin',
    ]);
    function walk(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(file);
        } else if (entry.isFile()) {
          const stat = lstatSync(file);
          const inode = `${stat.dev}:${stat.ino}`;
          logicalBytes += stat.size;
          if (!seen.has(inode)) {
            seen.add(inode);
            uniqueBytes += stat.size;
          }
          if (stat.size > 10 * 1024 * 1024) {
            largeFiles.push({ path: relative(output, file), bytes: stat.size, inode });
          }
          if (entry.name === 'package.json') {
            // Bundled fixtures can contain non-manifest package.json files.
            let manifest;
            try {
              manifest = JSON.parse(readFileSync(file, 'utf8'));
            } catch {
              continue;
            }
            if (runtimeNames.has(manifest.name)) {
              runtimes.push({
                name: manifest.name,
                version: manifest.version,
                path: relative(output, file),
              });
            }
          }
        }
      }
    }
    walk(join(output, 'node_modules'));
    let diskMiB = null;
    if (process.platform !== 'win32') {
      const du = execFileSync('du', ['-sk', join(output, 'node_modules')], { encoding: 'utf8' });
      diskMiB = Number(du.trim().split(/\s+/)[0]) / 1024;
    }
    const result = {
      capturedAt: new Date().toISOString(),
      repositoryCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim(),
      version,
      node: process.version,
      npm: execFileSync('npm', ['--version'], { env: environment, encoding: 'utf8' }).trim(),
      platform: process.platform,
      arch: process.arch,
      archives,
      install: 'npm install --omit=dev (fresh local cohort, no consumer overrides)',
      uniqueBytes,
      uniqueMiB: uniqueBytes / 1024 / 1024,
      logicalBytes,
      logicalMiB: logicalBytes / 1024 / 1024,
      diskMiB,
      runtimes,
      largeFiles,
    };
    writeFileSync(join(output, 'footprint.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await registry.close();
  }
}
