import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'pathslash';
import { isMap, isScalar, parseDocument } from 'yaml';

export type PM = 'npm' | 'pnpm' | 'yarn' | 'bun';

const VOID_PNPM_ALLOWED_BUILDS = ['esbuild', 'sharp', 'workerd'] as const;

/**
 * Add Void's build-script policy to the pnpm workspace that owns `cwd`.
 * Existing workspace settings and allowBuilds entries are preserved.
 */
export function writePnpmBuildPolicy(root: string, pm: PM): void {
  if (pm !== 'pnpm') {
    return;
  }
  const policyPath = join(root, 'pnpm-workspace.yaml');
  const before = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : '';
  const after = mergePnpmBuildPolicy(before);
  if (after !== before) {
    writeFileSync(policyPath, after);
  }
}

function mergePnpmBuildPolicy(yaml: string): string {
  const doc = parseDocument(yaml || '{}');
  if (doc.errors.length > 0) {
    throw new Error(`create-void: Could not parse pnpm-workspace.yaml: ${doc.errors[0].message}`);
  }
  let allowBuilds = doc.get('allowBuilds', true);
  if (allowBuilds == null || (isScalar(allowBuilds) && allowBuilds.value === null)) {
    doc.set('allowBuilds', doc.createNode({}));
    allowBuilds = doc.get('allowBuilds', true);
  }
  if (!isMap(allowBuilds)) {
    throw new Error('create-void: pnpm-workspace.yaml `allowBuilds` must be a mapping.');
  }

  const required: ReadonlyArray<readonly [string, boolean]> = [
    ['better-sqlite3', false],
    ...VOID_PNPM_ALLOWED_BUILDS.map((name) => [name, true] as const),
  ];
  let changed = false;
  for (const [name, allowed] of required) {
    if (!allowBuilds.has(name)) {
      allowBuilds.set(name, allowed);
      changed = true;
    }
  }
  if (!changed && yaml !== '') {
    return yaml;
  }
  return doc.toString();
}

export function getPnpmWorkspaceRoot(cwd: string): string | undefined {
  const result = spawnSync('pnpm', ['--workspace-root', 'exec', 'node', '-p', 'process.cwd()'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (result.error || result.status !== 0) {
    return undefined;
  }

  const root = result.stdout.trim();
  return root;
}

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
  noInstall: boolean,
  initArgs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const command = noInstall ? pmDlx(pm, version) : [...pmExec(pm), 'void'];
  return [...command, 'init', ...initArgs, ...(noInstall ? ['--no-install'] : [])];
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
