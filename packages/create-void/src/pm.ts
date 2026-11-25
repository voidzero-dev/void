import { spawn } from 'node:child_process';

export type PM = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function detectPM(): PM {
  const agent = process.env.npm_config_user_agent;
  if (agent) {
    if (agent.startsWith('pnpm/')) {
      return 'pnpm';
    }
    if (agent.startsWith('yarn/')) {
      return 'yarn';
    }
    if (agent.startsWith('bun/')) {
      return 'bun';
    }
  }
  return 'npm';
}

export function pmInstall(pm: PM): ReadonlyArray<string> {
  // Scaffolding changes package.json, so CI's default frozen install cannot
  // be used until the initializer has generated the final lockfile.
  return pm === 'pnpm' ? [pm, 'install', '--no-frozen-lockfile'] : [pm, 'install'];
}

export function pmExec(pm: PM): ReadonlyArray<string> {
  switch (pm) {
    case 'npm':
      return ['npx'];
    case 'pnpm':
      return ['pnpm', 'exec'];
    case 'yarn':
      return ['yarn', 'exec'];
    case 'bun':
      return ['bunx'];
  }
}

function isYarnClassic(userAgent = process.env.npm_config_user_agent): boolean {
  return /^yarn\/1(?:\.|$)/.test(userAgent ?? '');
}

/** Run the matching Void CLI without adding it to the generated project. */
export function pmDlx(pm: PM, version: string): ReadonlyArray<string> {
  const pkg = `void@${version}`;
  switch (isYarnClassic() ? 'npm' : pm) {
    case 'npm':
      return ['npm', 'exec', '--yes', `--package=${pkg}`, '--', 'void'];
    case 'pnpm':
      return ['pnpm', 'dlx', pkg];
    case 'yarn':
      return ['yarn', 'dlx', pkg];
    case 'bun':
      return ['bunx', pkg];
  }
}

export function pmInitCommand(
  pm: PM,
  version: string,
  initArgs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [...pmDlx(pm, version), 'init', '--package-manager', pm, ...initArgs];
}

export type InitCommandRunner = (argv: ReadonlyArray<string>, cwd?: string) => Promise<void>;

export function runVoidInit(
  pm: PM,
  version: string,
  initArgs: ReadonlyArray<string>,
  cwd: string,
  runner: InitCommandRunner = run,
): Promise<void> {
  return runner(pmInitCommand(pm, version, initArgs), cwd);
}

export function run(argv: ReadonlyArray<string>, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    // On Windows the package-manager entry points (npm, npx, pnpm, yarn, bunx)
    // are .cmd/.ps1 shims that spawn() cannot resolve without a shell, so it
    // throws ENOENT. Enable a shell only on win32; every arg here is a fixed
    // literal or a plain flag checked by parseCreateArgs, so there is no
    // injection surface.
    const child = spawn(cmd, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`create-void: '${cmd}' exited with code ${code}.`));
      }
    });
    child.on('error', reject);
  });
}
