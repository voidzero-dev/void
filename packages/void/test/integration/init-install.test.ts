import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { installProjectDependencies, resolveProjectInstall } from '../../src/cli/init.ts';
import { SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } from '../../src/cli/template.ts';

let root: string;
let bin: string;
let callsFile: string;

function executable(name: string, status = 0): void {
  const script = join(bin, `${name}.cjs`);
  writeFileSync(
    script,
    `const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (!process.argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(`${name}: resolving packages\n`)});
  process.stderr.write(${JSON.stringify(`${name}: registry unreachable\n`)});
}
process.exitCode = process.argv.includes('--version') ? 0 : ${status};
`,
  );
  if (process.platform === 'win32') {
    writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, {
      mode: 0o755,
    });
  }
}

function calls(): Array<{ command: string; args: Array<string>; cwd: string }> {
  return readFileSync(callsFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** What init has printed in this test, without colors. */
function output(): string {
  return stripVTControlCharacters(
    vi
      .mocked(process.stdout.write)
      .mock.calls.map(([chunk]) => String(chunk))
      .join(''),
  );
}

/** Install as init does: decide how to, then run that. */
function install(
  directory: string,
  packageManager: Parameters<typeof resolveProjectInstall>[1] = 'pnpm',
): Promise<number> {
  return installProjectDependencies(directory, resolveProjectInstall(directory, packageManager));
}

beforeEach(() => {
  // The fake installers print, and init prints their output when they fail.
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'void-init-install-')));
  bin = join(root, 'bin');
  callsFile = join(root, 'calls.jsonl');
  mkdirSync(bin);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      packageManager: 'pnpm@12.4.1',
      devDependencies: { 'vite-plus': '^1.3.0' },
    }),
  );
  // The host's tools must not mask a missing vp or supply a newer pnpm.
  vi.stubEnv('PATH', bin);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('init dependency installation (real subprocesses)', () => {
  it('uses Vite+ instead of delegating a pnpm 12 pin to an older global pnpm', async () => {
    executable('vp');
    executable('pnpm', 1);

    await install(root);

    expect(calls()).toEqual([
      { command: 'vp', args: ['--version'], cwd: root },
      { command: 'vp', args: ['install', '--no-frozen-lockfile'], cwd: root },
    ]);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager).toBe(
      'pnpm@12.4.1',
    );
  });

  it.each(['1.6.0', '^1.3.0'])(
    'bootstraps the project-selected Vite+ %s without a local or global vp',
    async (version) => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      pkg.devDependencies['vite-plus'] = version;
      writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
      executable('npx');
      executable('pnpm', 1);

      await install(root);

      // Assert the received argv: Windows cmd.exe must preserve the semver caret.
      expect(calls()).toEqual([
        {
          command: 'npx',
          args: [
            '--yes',
            `--package=vite-plus@${version}`,
            'vp',
            'install',
            '--no-frozen-lockfile',
          ],
          cwd: root,
        },
      ]);
    },
  );

  it.each([
    ['pnpm', 'catalog:', 'catalog'],
    ['pnpm', 'catalog:', 'catalogs.default'],
    ['pnpm', 'catalog:default', 'catalog'],
    ['pnpm', 'catalog:default', 'catalogs.default'],
    ['pnpm', 'catalog:tools', 'catalogs.tools'],
    ['bun', 'catalog:', 'catalog'],
    ['bun', 'catalog:default', 'catalogs.default'],
    ['bun', 'catalog:tools', 'catalogs.tools'],
    ['yarn', 'catalog:', 'catalog'],
    ['yarn', 'catalog:tools', 'catalogs.tools'],
  ] as const)(
    'bootstraps the Vite+ version from the %s workspace catalog (%s in %s)',
    async (manager, spec, location) => {
      const member = join(root, 'packages/app');
      mkdirSync(member, { recursive: true });
      writeFileSync(
        join(member, 'package.json'),
        JSON.stringify({ devDependencies: { 'vite-plus': spec } }),
      );
      const entries = { 'vite-plus': '1.6.0' };
      const catalogs =
        location === 'catalog'
          ? { catalog: entries }
          : { catalogs: { [location.slice('catalogs.'.length)]: entries } };
      // YAML accepts JSON, so the YAML files can be written as JSON.
      if (manager === 'pnpm') {
        writeFileSync(
          join(root, 'pnpm-workspace.yaml'),
          JSON.stringify({ packages: ['packages/*'], ...catalogs }),
        );
      } else if (manager === 'bun') {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ workspaces: { packages: ['packages/*'], ...catalogs } }),
        );
      } else {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
        writeFileSync(join(root, '.yarnrc.yml'), JSON.stringify(catalogs));
      }
      executable('npx');
      await install(member, manager);
      expect(calls()).toEqual([
        {
          command: 'npx',
          args: ['--yes', '--package=vite-plus@1.6.0', 'vp', 'install', '--no-frozen-lockfile'],
          cwd: member,
        },
      ]);
    },
  );

  it('bootstraps with the CLI’s own Vite+ version when the catalog entry is missing', async () => {
    const member = join(root, 'packages/app');
    mkdirSync(member, { recursive: true });
    writeFileSync(
      join(member, 'package.json'),
      JSON.stringify({ devDependencies: { 'vite-plus': 'catalog:missing' } }),
    );
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      'packages: [packages/*]\ncatalog: { vite-plus: "1.6.0" }\n',
    );
    executable('npx');
    await install(member);
    expect(calls()).toEqual([
      {
        command: 'npx',
        args: [
          '--yes',
          `--package=vite-plus@${SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus']}`,
          'vp',
          'install',
          '--no-frozen-lockfile',
        ],
        cwd: member,
      },
    ]);
  });

  it('reports a Vite+ install failure without retrying through another installer', async () => {
    executable('vp', 7);
    executable('npx');
    executable('pnpm', 1);

    await expect(install(root)).rejects.toThrow('vp install failed with exit code 7');
    expect(calls()).toEqual([
      { command: 'vp', args: ['--version'], cwd: root },
      { command: 'vp', args: ['install', '--no-frozen-lockfile'], cwd: root },
    ]);
  });

  it('keeps the installer output off the terminal and returns how long it ran', async () => {
    executable('vp');

    expect(await install(root)).toBeGreaterThan(0);

    expect(output()).toContain('Installing dependencies with vp');
    expect(output()).not.toContain('vp: ');
  });

  it('prints what the installer wrote to stdout and stderr when it fails', async () => {
    executable('vp', 7);

    await expect(install(root)).rejects.toThrow('vp install failed with exit code 7');

    expect(output()).toContain('vp: resolving packages\n');
    expect(output()).toContain('vp: registry unreachable\n');
    // The line that names the failed step comes before the installer's output.
    expect(output().indexOf('Failed to install dependencies with vp')).toBeGreaterThan(-1);
    expect(output().indexOf('Failed to install dependencies with vp')).toBeLessThan(
      output().indexOf('vp: '),
    );
  });

  it('uses an installed project-local Vite+ without requiring tools on PATH', async () => {
    const vitePlus = join(root, 'node_modules', 'vite-plus');
    mkdirSync(join(vitePlus, 'bin'), { recursive: true });
    writeFileSync(join(vitePlus, 'package.json'), JSON.stringify({ name: 'vite-plus' }));
    executable('local-vp');
    writeFileSync(join(vitePlus, 'bin', 'vp'), readFileSync(join(bin, 'local-vp.cjs'), 'utf8'));

    await install(root);

    expect(calls()).toEqual([
      { command: 'local-vp', args: ['install', '--no-frozen-lockfile'], cwd: root },
    ]);
  });

  it('keeps plain Vite projects on their selected package manager', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
    executable('vp', 1);
    executable('pnpm');

    await install(root);

    expect(calls()).toEqual([
      { command: 'pnpm', args: ['install', '--no-frozen-lockfile'], cwd: root },
    ]);
  });

  describe('the command to install by hand', () => {
    it('allows refreshing pnpm’s lockfile on a manual retry with vp', () => {
      executable('vp');

      expect(resolveProjectInstall(root, 'pnpm').manualCommand).toBe(
        'vp install --no-frozen-lockfile',
      );
    });

    it('runs the project-local vp from a shell without vp on PATH', () => {
      const vitePlus = join(root, 'node_modules', 'vite-plus');
      mkdirSync(join(vitePlus, 'bin'), { recursive: true });
      writeFileSync(join(vitePlus, 'package.json'), JSON.stringify({ name: 'vite-plus' }));
      executable('local-vp');
      writeFileSync(join(vitePlus, 'bin', 'vp'), readFileSync(join(bin, 'local-vp.cjs'), 'utf8'));

      const { manualCommand } = resolveProjectInstall(root, 'pnpm');
      const retry = spawnSync(manualCommand, {
        cwd: root,
        shell: true,
        env: { ...process.env, PATH: [bin, dirname(process.execPath)].join(delimiter) },
        encoding: 'utf8',
      });

      expect(retry.status, retry.stderr).toBe(0);
      expect(calls()).toEqual([
        { command: 'local-vp', args: ['install', '--no-frozen-lockfile'], cwd: root },
      ]);
    });

    it.each([
      ['1.6.0', 'vite-plus@1.6.0'],
      // A shell can read the caret as a pattern or as an escape.
      ['^1.3.0', process.platform === 'win32' ? '"vite-plus@^1.3.0"' : "'vite-plus@^1.3.0'"],
    ])('gets Vite+ %s through npx without a local or global vp', (version, quoted) => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      pkg.devDependencies['vite-plus'] = version;
      writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
      executable('npx');

      expect(resolveProjectInstall(root, 'pnpm').manualCommand).toBe(
        `npx -p ${quoted} vp install --no-frozen-lockfile`,
      );
    });

    it('is the package manager for a plain Vite project', () => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));

      expect(resolveProjectInstall(root, 'pnpm').manualCommand).toBe(
        'pnpm install --no-frozen-lockfile',
      );
    });
  });

  // Windows has no process groups: init stops the installer there with `taskkill`.
  it.skipIf(process.platform === 'win32')(
    'stops the installer and what it started before init exits',
    async () => {
      // An installer that starts a lifecycle script. Both add a line to the
      // beats file every 10ms while they run.
      const beats = join(root, 'beats');
      const script = join(bin, 'vp.cjs');
      writeFileSync(
        script,
        `const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
if (process.argv.includes('--version')) {
  process.exit(0);
}
const role = process.argv[2] === 'postinstall' ? 'postinstall' : 'installer';
if (role === 'installer') {
  spawn(process.execPath, [__filename, 'postinstall'], { stdio: 'inherit' });
}
const beat = () => appendFileSync(${JSON.stringify(beats)}, role + '\\n');
beat();
setInterval(beat, 10);
`,
      );
      const launcher = `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`;
      writeFileSync(join(bin, 'vp'), launcher, { mode: 0o755 });
      const exitListeners = process.listeners('exit');
      const exitCode = process.exitCode;
      // Init exits, as on Ctrl+C at the spinner: run the listeners the install added.
      const exitInit = (): void => {
        for (const listener of process.listeners('exit')) {
          if (!exitListeners.includes(listener)) {
            listener(0);
          }
        }
      };
      // The stopped installer fails the install, which the end of the test checks.
      const outcome = install(root).then(
        () => 'installed',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      try {
        await vi.waitFor(() => expect(readFileSync(beats, 'utf8')).toContain('postinstall'), {
          timeout: 10_000,
        });

        exitInit();

        // Both processes had ended when the listeners returned.
        const atExit = readFileSync(beats, 'utf8');
        await new Promise((resolve) => {
          setTimeout(resolve, 150);
        });
        expect(readFileSync(beats, 'utf8')).toBe(atExit);
        expect(await outcome).toBe('vp install failed with exit code unknown');
      } finally {
        // After a failed assertion too, so that no process of this test remains.
        exitInit();
        await outcome;
        process.exitCode = exitCode;
      }
    },
  );
});
