import type { SpawnSyncOptions } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { isRecord } from '@void/deploy-core';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { InitReport } from '../../src/cli/init-report.ts';
import {
  detectProjectState,
  ensureVoidWorkerCompatibilityDate,
  ensureVoidPlatformConnection,
  generateStarterMigration,
  getWorkflowYaml,
  isScaffoldableEmptyProject,
  isVoidResolvableFrom,
  parseInitArgs,
  runInitCommand,
} from '../../src/cli/init.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { readDeploymentPlatform } from '../../src/cli/project.ts';
import { SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } from '../../src/cli/template.ts';
import { extractPnpmWorkspacePackages } from '../../src/cli/workspace.ts';
import { LATEST_KNOWN_COMPAT_DATE } from '../../src/cli/wrangler.ts';
import { buildDrizzleKitSpawnEnv } from '../../src/cli/yarn-pnp.ts';
import { readConfig } from '../../src/config.ts';

type Prompts = typeof import('@voidzero-dev/vite-plus-prompts');
type PromptAnswer<T> = T | symbol | undefined | Promise<T | symbol | undefined>;

interface SpawnResult {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  hang?: boolean;
}

const mockSpawnSync =
  vi.fn<
    (command: string, args: Array<string>, options: SpawnSyncOptions) => SpawnResult | undefined
  >();
/** Ends each mocked `spawn` whose result sets `hang`. */
const hangingCommands: Array<() => void> = [];
const HANGING_COMMAND_PID = 0x7f_ff_ff_ff;
const mockSelect = vi.fn<(options: Parameters<Prompts['select']>[0]) => PromptAnswer<string>>();
const mockConfirm = vi.fn<(options: Parameters<Prompts['confirm']>[0]) => PromptAnswer<boolean>>();
const mockText =
  vi.fn<
    (options: {
      message: string;
      validate?: (value: string) => string | undefined;
    }) => PromptAnswer<string>
  >();
const mockNote = vi.fn<(...args: Array<unknown>) => void>();
const mockOutro = vi.fn<(...args: Array<unknown>) => void>();
const mockLogWarn = vi.fn<(...args: Array<unknown>) => void>();
const mockLogError = vi.fn<(...args: Array<unknown>) => void>();
const mockLogInfo = vi.fn<(...args: Array<unknown>) => void>();
const mockLogStep = vi.fn<(...args: Array<unknown>) => void>();
const mockLogMessage =
  vi.fn<(message: string | Array<string>, options?: { symbol?: string }) => void>();
const mockGetToken = vi.fn<typeof import('../../src/cli/auth.ts').getToken>();
const mockGetApiUrl = vi.fn<typeof import('../../src/cli/auth.ts').getApiUrl>();
const mockRunLogin = vi.fn<typeof import('../../src/cli/auth.ts').runPlatformLogin>();
const mockSaveToken = vi.fn<typeof import('../../src/cli/auth.ts').savePlatformToken>();
const mockListProjects =
  vi.fn<() => Promise<Array<Omit<import('../../src/cli/client.ts').ProjectResponse, 'role'>>>>();
const mockCreateProject =
  vi.fn<import('../../src/cli/client.ts').PlatformClient['createProject']>();
const mockDiscoverPlatform =
  vi.fn<typeof import('../../src/cli/platform-cmd.ts').discoverPlatform>();
let platformRegistryDirectory: string;

it('pins compatibility date in the lock without rewriting authored TypeScript', () => {
  const root = mkdtempSync(join(tmpdir(), 'void-init-authored-config-'));
  const source =
    "import { defineConfig } from 'void/config';\nexport default defineConfig({ remote: process.env.REMOTE === '1' });\n";
  try {
    writeFileSync(join(root, 'void.config.ts'), source);
    ensureVoidWorkerCompatibilityDate(root, new InitReport());
    expect(readFileSync(join(root, 'void.config.ts'), 'utf8')).toBe(source);
    const lock = JSON.parse(readFileSync(join(root, 'void.lock.json'), 'utf8'));
    expect(lock.resolved.compatibility_date).toBe(LATEST_KNOWN_COMPAT_DATE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps an existing typed Astro adapter with dynamic options during targeted init', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-init-typed-astro-'));
  const adapter =
    'import cloudflare from "@astrojs/cloudflare"; const options = { configPath: "./.void-wrangler.jsonc" }; export default { adapter: cloudflare(options) };\n';
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { astro: '*' } }));
    writeFileSync(
      join(root, 'void.config.ts'),
      'export default { cloudflare: { name: "app" } };\n',
    );
    writeFileSync(join(root, 'astro.config.ts'), adapter);

    await runInitCommand(root, { tsconfig: true, github: false });
    expect(readFileSync(join(root, 'astro.config.ts'), 'utf8')).toBe(adapter);
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('init Git arguments', () => {
  it('keeps Git optional and honors the last positive or negative flag', () => {
    expect(parseInitArgs([]).git).toBeUndefined();
    expect(parseInitArgs(['--git']).git).toBe(true);
    expect(parseInitArgs(['--no-git']).git).toBe(false);
    expect(parseInitArgs(['--git', '--no-git']).git).toBe(false);
    expect(parseInitArgs(['--no-git', '--git']).git).toBe(true);
    expect(parseInitArgs(['--tsconfig', '--git'])).toMatchObject({ tsconfig: true, git: true });
    expect(() => parseInitArgs(['--agents'])).toThrow('Unknown option');
  });

  it.each(['--git', '--no-git'])('keeps the full starter flow with %s', async (flag) => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-git-flow-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static')
        .mockResolvedValueOnce('none');
      await runInitCommand(root, parseInitArgs([flag]));
      expect(existsSync(join(root, 'pages', 'index.tsx'))).toBe(true);
      expect(existsSync(join(root, '.gitignore'))).toBe(true);
      const gitCalls = mockSpawnSync.mock.calls.filter(([command]) => command === 'git');
      expect(gitCalls).toHaveLength(flag === '--git' ? 1 : 0);
      if (flag === '--git') {
        expect(gitCalls[0][1]).toEqual(['init']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['--git', '--no-git'])(
    'rejects %s in a workspace member before modifying it',
    async (flag) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-git-workspace-'));
      try {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
        const child = join(root, 'apps', 'web');
        mkdirSync(child, { recursive: true });
        await expect(runInitCommand(child, parseInitArgs(['--tsconfig', flag]))).rejects.toThrow(
          'The --git/--no-git options are not available when adding a package to an existing monorepo',
        );
        expect(readdirSync(child)).toEqual([]);
        expect(mockSpawnSync).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('init scaffold arguments', () => {
  it('parses scaffold choices and rejects unknown values', () => {
    expect(
      parseInitArgs([
        '--toolchain',
        'vite',
        '--framework=vue',
        '--starter',
        'static',
        '--deploy',
        'none',
      ]),
    ).toMatchObject({ toolchain: 'vite', framework: 'vue', starter: 'static', deploy: 'none' });
    expect(parseInitArgs([])).toMatchObject({
      toolchain: undefined,
      framework: undefined,
      starter: undefined,
      deploy: undefined,
    });
    expect(() => parseInitArgs(['--framework', 'angular'])).toThrow(
      'init: --framework must be one of react, vue, svelte, solid.',
    );
    expect(parseInitArgs(['--no-install', '--no-git'])).toMatchObject({
      install: false,
      git: false,
    });
    expect(parseInitArgs(['--package-manager', 'pnpm'])).toMatchObject({ packageManager: 'pnpm' });
  });

  it('scaffolds with --no-install without running the package manager install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-no-install-'));
    try {
      await runInitCommand(
        root,
        parseInitArgs([
          '--toolchain',
          'vite',
          '--framework',
          'react',
          '--starter',
          'static',
          '--deploy',
          'none',
          '--no-install',
        ]),
      );

      expect(existsSync(join(root, 'pages', 'index.tsx'))).toBe(true);
      expect(
        mockSpawnSync.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === 'install'),
      ).toEqual([]);
      expect(summaryMessages('→').join('\n')).toContain('npm install');
      expect(
        summaryMessages('✓').some(
          (message) => typeof message === 'string' && message.startsWith('Installed dependencies'),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the delegated package manager for a plain Vite starter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-delegated-pm-'));
    try {
      await runInitCommand(
        root,
        parseInitArgs([
          '--package-manager',
          'pnpm',
          '--toolchain',
          'vite',
          '--framework',
          'react',
          '--starter',
          'static',
          '--deploy',
          'none',
          '--no-install',
        ]),
      );

      expect(summaryMessages('→').join('\n')).toContain('pnpm install --no-frozen-lockfile');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds from flags without prompting when stdin is not a terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-flags-'));
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });
      await runInitCommand(
        root,
        parseInitArgs([
          '--toolchain',
          'vite',
          '--framework',
          'react',
          '--starter',
          'static',
          '--deploy',
          'none',
        ]),
      );
      expect(mockSelect).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'pages', 'index.tsx'))).toBe(true);
      expect(readDeploymentPlatform(root)).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails with the missing flag instead of prompting when stdin is not a terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-flags-missing-'));
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });
      await expect(runInitCommand(root, parseInitArgs(['--toolchain', 'vite']))).rejects.toThrow(
        'init: Pass --framework (react, vue, svelte, solid) when running without an interactive terminal.',
      );
      expect(mockSelect).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a missing deployment choice retryable without a terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-flags-retry-'));
    const flags = ['--toolchain', 'vite', '--framework', 'react', '--starter', 'static'];
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });
      await expect(runInitCommand(root, parseInitArgs(flags))).rejects.toThrow(
        'init: Pass --deploy (cloudflare, void, none) when running without an interactive terminal.',
      );
      expect(readdirSync(root)).toEqual([]);
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();

      await runInitCommand(root, parseInitArgs([...flags, '--deploy', 'none']));
      expect(mockSelect).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'pages', 'index.tsx'))).toBe(true);
      expect(readDeploymentPlatform(root)).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('init question order', () => {
  const DEPLOY_PROMPT = 'Where should this project deploy?';
  const answers: Record<string, string | undefined> = {
    'Choose a Pages scaffold toolchain:': 'vite',
    'Choose a Pages framework to scaffold:': 'react',
    'Choose a Pages starter:': 'static',
    'Choose a database setup for this project:': 'none',
    [DEPLOY_PROMPT]: 'none',
  };

  it('asks where a new starter deploys before writing its files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-order-'));
    let entriesAtDeployPrompt: Array<string> | undefined;
    try {
      mockSelect.mockImplementation((options: { message: string }) => {
        if (options.message === DEPLOY_PROMPT) {
          entriesAtDeployPrompt = readdirSync(root);
        }
        return answers[options.message];
      });

      await runInitCommand(root);

      expect(entriesAtDeployPrompt).toEqual([]);
      expect(existsSync(join(root, 'pages', 'index.tsx'))).toBe(true);
      expect(readDeploymentPlatform(root)).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the folder empty when the deployment question is cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-order-cancel-'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Cancelled');
    });
    try {
      mockSelect.mockImplementation((options: { message: string }) =>
        options.message === DEPLOY_PROMPT ? Symbol.for('cancel') : answers[options.message],
      );

      await expect(runInitCommand(root)).rejects.toThrow('Cancelled');

      expect(exit).toHaveBeenCalledWith(0);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      exit.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['an empty folder', 'Empty project detected. Creating a Pages starter.', false],
    ['an existing app', 'Existing project detected. Configuring Void.', true],
  ])('says what it does in %s before asking about Git', async (_name, message, existing) => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-order-git-'));
    // Outside CI, init asks whether to initialize Git.
    delete process.env.CI;
    try {
      if (existing) {
        writeExistingViteApp(root, { void: '^0.0.1' });
      }
      mockSelect.mockImplementation((options: { message: string }) => answers[options.message]);
      mockConfirm.mockResolvedValue(false);

      await runInitCommand(root);

      const infoIndex = mockLogInfo.mock.calls.findIndex(([text]) => text === message);
      const gitIndex = mockConfirm.mock.calls.findIndex(
        ([options]) => options?.message === 'Initialize a git repository?',
      );
      expect(infoIndex).not.toBe(-1);
      expect(gitIndex).not.toBe(-1);
      expect(mockLogInfo.mock.invocationCallOrder[infoIndex]).toBeLessThan(
        mockConfirm.mock.invocationCallOrder[gitIndex],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('init summary', () => {
  const STARTER_FLAGS = [
    '--toolchain',
    'vite',
    '--framework',
    'react',
    '--starter',
    'sqlite',
    '--deploy',
    'none',
  ];

  it('describes a new starter in one line instead of listing its files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-starter-'));
    // The user's shell is in the project, so the Git command needs no -C.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      mkdirSync(join(root, '.claude'));

      await runInitCommand(root, parseInitArgs(['--git', ...STARTER_FLAGS]));

      expect(existsSync(join(root, 'pages', 'index.tsx'))).toBe(true);
      const fileSteps = mockLogStep.mock.calls.filter(([text]) =>
        /^(Created|Updated|Pinned) /.test(String(text)),
      );
      expect(fileSteps).toEqual([]);
      expect(summaryMessages('✓')).toEqual([
        'Created a React Pages starter with D1 (SQLite)',
        'Linked Void skills for Claude Code',
        INSTALLED,
        'Generated the initial database migration',
      ]);
      expect(summaryMessages('→')).toEqual([
        'Git (optional): git add -A && git commit -m "chore: initial commit"',
      ]);
      // The summary comes last, right before the success line.
      const [lastSummary] = mockLogMessage.mock.invocationCallOrder.slice(-1);
      expect(lastSummary).toBeLessThan(mockOutro.mock.invocationCallOrder[0]);
      expect(mockLogStep.mock.invocationCallOrder.every((order) => order < lastSummary)).toBe(true);
    } finally {
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the output of the install and of drizzle-kit off the terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-quiet-'));
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      mockSpawnSync.mockImplementation((command, args, options) => {
        const generateCwd = drizzleGenerateCwd(command, args, options);
        if (generateCwd) {
          writeMockGeneratedMigration(generateCwd);
        }
        return { status: 0, stdout: 'added 181 packages\n', stderr: 'npm warn deprecated\n' };
      });

      await runInitCommand(root, parseInitArgs(STARTER_FLAGS));

      // Without a terminal there is no spinner. Each step logs one line when it starts.
      expect(mockLogStep.mock.calls).toEqual([
        ['Installing dependencies with npm'],
        ['Generating the initial database migration'],
      ]);
      expect(write).not.toHaveBeenCalled();
      expect(mockLogError).not.toHaveBeenCalled();
      expect(summaryMessages('✓')).toEqual([
        'Created a React Pages starter with D1 (SQLite)',
        INSTALLED,
        'Generated the initial database migration',
      ]);
    } finally {
      write.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'sqlite',
      'Created a React Pages starter with D1 (SQLite)',
      'Run `npm install`, then `npx void db generate` to finish setup',
    ],
    ['static', 'Created a static React Pages starter', 'Run `npm install` to finish setup'],
  ])(
    'prints the output of a failed install and what is left to run for the %s starter',
    async (starter, created, nextStep) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-summary-install-fails-'));
      // The user's shell is in the project, so the commands need no `cd`.
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      try {
        mockSpawnSync.mockImplementation((_command, args) =>
          Array.isArray(args) && args[0] === 'install'
            ? { status: 1, stdout: 'resolving packages\n', stderr: 'ERR registry unreachable' }
            : { status: 0, stdout: '', stderr: '' },
        );

        await expect(
          runInitCommand(
            root,
            parseInitArgs([
              '--toolchain',
              'vite',
              '--framework',
              'react',
              '--starter',
              starter,
              '--deploy',
              'none',
            ]),
          ),
        ).rejects.toThrow('npm install failed with exit code 1');

        expect(mockLogError.mock.calls).toEqual([['Failed to install dependencies with npm']]);
        expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toBe(
          'resolving packages\nERR registry unreachable\n',
        );
        expect(mockLogWarn.mock.calls).toEqual([['Setup did not finish. Done so far:']]);
        // The failed step, its output, then what init had done.
        expect(mockLogError.mock.invocationCallOrder[0]).toBeLessThan(
          write.mock.invocationCallOrder[0],
        );
        expect(write.mock.invocationCallOrder[0]).toBeLessThan(
          mockLogWarn.mock.invocationCallOrder[0],
        );
        expect(summaryMessages('✓')).toEqual([created]);
        expect(summaryMessages('→')).toEqual([nextStep]);
        expect(drizzleGenerateCalls()).toEqual([]);
        expect(mockOutro).not.toHaveBeenCalled();
      } finally {
        write.mockRestore();
        cwd.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('names the command that creates the migration when drizzle-kit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-migration-fails-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      mockSpawnSync.mockImplementation((command, args, options) =>
        drizzleGenerateCwd(command, args, options)
          ? { status: 1, stdout: '', stderr: 'drizzle-kit: simulated crash\n' }
          : { status: 0, stdout: '', stderr: '' },
      );

      await expect(runInitCommand(root, parseInitArgs(STARTER_FLAGS))).rejects.toThrow(
        'Failed to generate the initial database migration.',
      );

      expect(write.mock.calls).toEqual([['drizzle-kit: simulated crash\n']]);
      expect(mockLogError).not.toHaveBeenCalled();
      expect(mockLogWarn.mock.calls).toEqual([['Setup did not finish. Done so far:']]);
      expect(summaryMessages('✓')).toEqual([
        'Created a React Pages starter with D1 (SQLite)',
        INSTALLED,
      ]);
      expect(summaryMessages('→')).toEqual(['Run `npx void db generate` to finish setup']);
    } finally {
      write.mockRestore();
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops the install and says how to finish it when init exits during it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-install-exit-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const exitListeners = process.listeners('exit');
    const interruptListeners = process.listeners('SIGINT');
    const exitCode = process.exitCode;
    let run: Promise<void> | undefined;
    try {
      mockSpawnSync.mockImplementation((_command, args) =>
        Array.isArray(args) && args[0] === 'install'
          ? { status: 0, hang: true }
          : { status: 0, stdout: '', stderr: '' },
      );
      run = runInitCommand(root, parseInitArgs(STARTER_FLAGS));
      await vi.waitFor(() => expect(hangingCommands).toHaveLength(1));

      // Ctrl+C at a spinner exits the process with 0, which runs the exit
      // listeners in order. Call the ones this run added.
      for (const listener of process.listeners('exit')) {
        if (!exitListeners.includes(listener)) {
          listener(0);
        }
      }

      // An interrupted install is not a success for the caller.
      expect(process.exitCode).toBe(130);

      // The stopped step comes first. Without a terminal it is a red ■ line,
      // as a cancelled spinner is in a terminal.
      expect(mockLogError.mock.calls).toEqual([['Installing dependencies with npm']]);
      expect(mockLogWarn.mock.calls).toEqual([['Setup did not finish. Done so far:']]);
      expect(mockLogError.mock.invocationCallOrder[0]).toBeLessThan(
        mockLogWarn.mock.invocationCallOrder[0],
      );
      // The installer runs in its own process group, which init stops as a whole.
      if (process.platform === 'win32') {
        expect(mockSpawnSync).toHaveBeenCalledWith(
          'taskkill',
          ['/PID', String(HANGING_COMMAND_PID), '/T', '/F'],
          expect.anything(),
        );
      } else {
        expect(mockSpawnSync).toHaveBeenCalledWith(
          'npm',
          ['install'],
          expect.objectContaining({ detached: true }),
        );
        expect(kill.mock.calls).toEqual([[-HANGING_COMMAND_PID, 'SIGTERM']]);
      }
      // A signal to init does not reach that group, so init listens for it
      // while the installer runs.
      expect(process.listeners('SIGINT')).toHaveLength(interruptListeners.length + 1);
      expect(summaryMessages('✓')).toEqual(['Created a React Pages starter with D1 (SQLite)']);
      expect(summaryMessages('→')).toEqual([
        'Run `npm install`, then `npx void db generate` to finish setup',
      ]);

      // The run removes its listeners when the command ends.
      hangingCommands.pop()!();
      await run;
      expect(process.listeners('exit')).toEqual(exitListeners);
      expect(process.listeners('SIGINT')).toEqual(interruptListeners);
    } finally {
      // After a failed assertion too, so that no listener of this run remains.
      for (const finish of hangingCommands.splice(0)) {
        finish();
      }
      await run?.catch(() => {});
      process.exitCode = exitCode;
      kill.mockRestore();
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes what drizzle-kit wrote when init exits during it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-migration-exit-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const exitListeners = process.listeners('exit');
    const exitCode = process.exitCode;
    const migrations = join(root, 'db', 'migrations');
    let run: Promise<void> | undefined;
    try {
      mockSpawnSync.mockImplementation((command, args, options) => {
        const generateCwd = drizzleGenerateCwd(command, args, options);
        if (!generateCwd) {
          return { status: 0, stdout: '', stderr: '' };
        }
        // drizzle-kit has written the journal entry, and not the SQL file yet.
        writeMockGeneratedMigration(generateCwd);
        rmSync(join(migrations, '0000_generated.sql'));
        return { status: null, hang: true };
      });
      run = runInitCommand(root, parseInitArgs(STARTER_FLAGS));
      await vi.waitFor(() => expect(hangingCommands).toHaveLength(1));
      expect(existsSync(join(migrations, 'meta', '_journal.json'))).toBe(true);

      for (const listener of process.listeners('exit')) {
        if (!exitListeners.includes(listener)) {
          listener(0);
        }
      }

      // With the journal entry left behind, `void db generate` would find no
      // schema changes and never write the SQL file.
      expect(existsSync(join(migrations, 'meta'))).toBe(false);
      expect(listMigrationSqlFiles(root)).toEqual([]);
      if (process.platform !== 'win32') {
        expect(kill.mock.calls).toEqual([[-HANGING_COMMAND_PID, 'SIGTERM']]);
      }
      expect(mockLogError.mock.calls).toEqual([['Generating the initial database migration']]);
      expect(mockLogWarn.mock.calls).toEqual([['Setup did not finish. Done so far:']]);
      expect(summaryMessages('✓')).toEqual([
        'Created a React Pages starter with D1 (SQLite)',
        INSTALLED,
      ]);
      expect(summaryMessages('→')).toEqual(['Run `npx void db generate` to finish setup']);

      // The stopped drizzle-kit ends without an exit code.
      hangingCommands.pop()!();
      await expect(run).rejects.toThrow('Failed to generate the initial database migration.');
    } finally {
      for (const finish of hangingCommands.splice(0)) {
        finish();
      }
      await run?.catch(() => {});
      process.exitCode = exitCode;
      kill.mockRestore();
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['a vp on PATH', 0, 'vp install --no-frozen-lockfile'],
    // `vp install` would not run for this user. The starter pins a Vite+ version.
    [
      'no vp',
      1,
      expect.stringMatching(/^npx -p vite-plus@\d+\.\d+\.\d+ vp install --no-frozen-lockfile$/),
    ],
  ])(
    'names an install that the user can run with %s when a Vite+ install fails',
    async (_vp, probeStatus, manualCommand) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-summary-vite-plus-install-fails-'));
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      try {
        mockSpawnSync.mockImplementation((command, args) => {
          if (command === 'vp' && Array.isArray(args) && args[0] === '--version') {
            return { status: probeStatus };
          }
          return Array.isArray(args) && args.includes('install')
            ? { status: 1, stdout: '', stderr: '' }
            : { status: 0, stdout: '', stderr: '' };
        });

        await expect(
          runInitCommand(
            root,
            parseInitArgs([
              '--toolchain',
              'vite-plus',
              '--framework',
              'react',
              '--starter',
              'sqlite',
              '--deploy',
              'none',
            ]),
          ),
        ).rejects.toThrow('vp install failed with exit code 1');

        const [nextStep, ...others] = summaryMessages('→');
        expect(others).toEqual([]);
        const command = /^Run `(.+)`, then `.+ db generate` to finish setup$/.exec(
          String(nextStep),
        )?.[1];
        expect(command).toEqual(manualCommand);
      } finally {
        write.mockRestore();
        cwd.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('points the Git command at a new subfolder by its path from the shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-subfolder-'));
    // The user's shell stays in the parent directory.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      mkdirSync(join(root, 'existing-project'));
      mockSelect.mockResolvedValueOnce('subfolder');
      mockText.mockResolvedValueOnce('my-new-app');

      await runInitCommand(root, parseInitArgs(['--git', ...STARTER_FLAGS]));

      expect(summaryMessages('→')).toEqual([
        'Git (optional): git -C my-new-app add -A && git -C my-new-app commit -m "chore: initial commit"',
      ]);
      expect(String(mockOutro.mock.calls.at(-1)?.[0])).toContain(
        'Run `cd my-new-app && vite dev` to start developing.',
      );
    } finally {
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists the files it created and changed in an existing project', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'void-init-summary-existing-')));
    try {
      writeExistingViteApp(root);
      writeFileSync(
        join(root, 'vite.config.ts'),
        'import { defineConfig } from "vite";\n\nexport default defineConfig({\n  plugins: [],\n});\n',
      );
      writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
      mkdirSync(join(root, '.claude'));
      mockSelect.mockResolvedValue('none');
      mockConfirm.mockResolvedValue(false);

      await runInitCommand(root);

      expect(summaryMessages('✓')).toEqual([
        [
          'Configured Void',
          '+ .gitignore',
          '+ void.config.ts',
          '~ package.json    added void and dev/build scripts',
          '~ vite.config.ts  added voidPlugin()',
          '~ tsconfig.json   extends .void/tsconfig.json, added void/env to types',
        ],
        'Linked Void skills for Claude Code',
        INSTALLED,
      ]);
      expect(summaryMessages('→')).toEqual([]);

      // The mocked install left nothing in node_modules.
      writeInstalledVoid(root);
      mockLogMessage.mockClear();
      await runInitCommand(root);

      // The skills are already linked, too.
      expect(summaryMessages('✓')).toEqual(['Void is already set up. No files changed.']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['installed', true, 'npm'],
    ['not installed', false, 'npm'],
    // Init installs a Vite+ project with vp, so it asks for the same command.
    ['installed in a Vite+ project', true, 'vp'],
  ])(
    'asks for an install after removing a dependency when void is %s',
    async (_name, voidInstalled, installer) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-summary-lockfile-'));
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
      try {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({
            name: 'app',
            type: 'module',
            scripts: { dev: 'vite', build: 'vite build' },
            devDependencies: {
              '@cloudflare/workers-types': '^4.0.0',
              vite: '^8.0.0',
              void: '*',
              ...(installer === 'vp' ? { 'vite-plus': '*' } : {}),
            },
          }) + '\n',
        );
        writeFileSync(
          join(root, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { types: ['@cloudflare/workers-types'] } }) + '\n',
        );
        if (voidInstalled) {
          writeInstalledVoid(root);
        }
        mockSelect.mockResolvedValue('none');
        mockConfirm.mockResolvedValue(false);

        await runInitCommand(root);

        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        expect(pkg.devDependencies['@cloudflare/workers-types']).toBeUndefined();
        expect(summaryMessages('✓')[0]).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^~ package\.json +removed @cloudflare\/workers-types$/),
          ]),
        );
        // Init's own install updates the lockfile when void still has to be installed.
        expect(installCalls()).toHaveLength(voidInstalled ? 0 : 1);
        expect(summaryMessages('→')).toEqual(
          voidInstalled ? [`Run \`${installer} install\` to update your lockfile`] : [],
        );
      } finally {
        cwd.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('lists a root Wrangler config that it creates as a new file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-wrangler-'));
    try {
      // Targeted init writes no void.config.ts, so the Cloudflare config goes to the root.
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { astro: '*' } }));

      await runInitCommand(root, { tsconfig: true, github: false });

      expect(existsSync(join(root, 'void.config.ts'))).toBe(false);
      expect(summaryMessages('✓')).toEqual([
        ['Configured Void', '+ tsconfig.json', '+ .gitignore', '+ wrangler.jsonc'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists the files that the config migration creates as new files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-migration-'));
    try {
      writeExistingViteApp(root);
      writeFileSync(
        join(root, 'vite.config.ts'),
        'import { defineConfig } from "vite";\n\nexport default defineConfig({\n  plugins: [],\n});\n',
      );
      writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
      writeFileSync(join(root, 'wrangler.jsonc'), '{ "name": "app" }\n');
      mockSelect.mockResolvedValue('none');
      mockConfirm.mockResolvedValue(false);

      await runInitCommand(root);

      expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
      // Later steps change void.config.ts and .gitignore again, and no other
      // step records void.lock.json.
      expect(summaryMessages('✓')).toEqual([
        [
          'Configured Void',
          '+ void.config.ts',
          '+ void.lock.json',
          '+ .gitignore',
          '~ package.json    added void and dev/build scripts',
          '~ vite.config.ts  added voidPlugin()',
          '~ tsconfig.json   extends .void/tsconfig.json, added void/env to types',
        ],
        // The list of files does not show that the migration deleted wrangler.jsonc.
        'Migrated project configuration to void.config.ts',
        INSTALLED,
      ]);
      expect(summaryMessages('→')).toEqual(['Commit void.config.ts and void.lock.json']);
      expect(mockLogStep).not.toHaveBeenCalledWith(expect.stringContaining('Migrated'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('asks to commit only void.config.ts when the migration wrote no lock file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-migration-json-'));
    try {
      writeExistingViteApp(root);
      // Only a Cloudflare config gives the migration something to lock.
      writeFileSync(join(root, 'void.json'), '{ "routing": { "prerender": ["/"] } }\n');

      await runInitCommand(root, { tsconfig: true, github: false });

      expect(existsSync(join(root, 'void.json'))).toBe(false);
      expect(existsSync(join(root, 'void.lock.json'))).toBe(false);
      expect(summaryMessages('✓')).toContain('Migrated project configuration to void.config.ts');
      expect(summaryMessages('→')).toContain('Commit void.config.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists what two steps added to void.lock.json without repeating it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-lock-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'app',
          dependencies: { astro: '*' },
          devDependencies: { void: '*' },
        }),
      );
      writeInstalledVoid(root);
      // Init does not rewrite authored TypeScript, so it pins the date in the
      // lock. The Astro step then finds the date there and adds only its flag.
      writeFileSync(
        join(root, 'void.config.ts'),
        "import { defineConfig } from 'void/config';\nexport default defineConfig({ remote: process.env.REMOTE === '1' });\n",
      );
      writeFileSync(
        join(root, 'void.lock.json'),
        JSON.stringify({ version: 1, source: {}, resolved: {}, text: '{}\n' }) + '\n',
      );
      mockSelect.mockResolvedValue('none');
      mockConfirm.mockResolvedValue(false);

      await runInitCommand(root);

      expect(summaryMessages('✓')[0]).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^~ void\.lock\.json +pinned compatibility_date, added nodejs_als$/,
          ),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every agent whose skills it linked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-agents-'));
    try {
      writeExistingViteApp(root);
      // Codex and Cursor read the same skills folder.
      mkdirSync(join(root, '.codex'));
      mkdirSync(join(root, '.cursor'));

      await runInitCommand(root, { tsconfig: true, github: false });

      expect(summaryMessages('✓')).toContain('Linked Void skills for Codex and Cursor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not call Void set up after a targeted run that changed no files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-targeted-'));
    try {
      // --tsconfig adds neither the void dependency nor its Vite plugin.
      writeExistingViteApp(root);

      await runInitCommand(root, { tsconfig: true, github: false });
      mockLogMessage.mockClear();
      await runInitCommand(root, { tsconfig: true, github: false });

      expect(summaryMessages('✓')).toEqual(['No files changed.']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Root can write to a read-only file.
  it.skipIf(process.getuid?.() === 0)('does not list a file that it failed to write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-readonly-'));
    const tsconfigPath = join(root, 'tsconfig.json');
    const original = '{ "compilerOptions": { "strict": true } }\n';
    try {
      writeExistingViteApp(root);
      // The run stops here, before it changes any other file.
      writeFileSync(tsconfigPath, original);
      chmodSync(tsconfigPath, 0o444);

      await expect(runInitCommand(root, { tsconfig: true, github: false })).rejects.toThrow(
        /EACCES|EPERM/,
      );

      expect(readFileSync(tsconfigPath, 'utf8')).toBe(original);
      expect(mockLogWarn).not.toHaveBeenCalled();
    } finally {
      chmodSync(tsconfigPath, 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists the files it already changed when a later question is cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-summary-cancel-'));
    // The real process.exit() runs the exit listener that init-report.test.ts covers.
    // This one throws, so init reports the same way as for a failed step.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('Cancelled');
    });
    try {
      writeExistingViteApp(root);
      writeFileSync(
        join(root, 'vite.config.ts'),
        'import { defineConfig } from "vite";\n\nexport default defineConfig({\n  plugins: [],\n});\n',
      );
      writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
      // Init configures an existing project before its first question, about the database.
      mockSelect.mockResolvedValue(Symbol.for('cancel'));

      await expect(runInitCommand(root)).rejects.toThrow('Cancelled');

      expect(exit).toHaveBeenCalledWith(0);
      expect(mockLogWarn.mock.calls).toEqual([
        [
          [
            'Setup did not finish. Files changed so far:',
            '+ .gitignore',
            '+ void.config.ts',
            '~ package.json    added void and dev/build scripts',
            '~ vite.config.ts  added voidPlugin()',
            '~ tsconfig.json   extends .void/tsconfig.json, added void/env to types',
          ].join('\n'),
        ],
      ]);
      expect(mockLogMessage).not.toHaveBeenCalled();
      expect(mockOutro).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GitHub Actions deployment workflows', () => {
  it('requires a selected URL for a Void deployment workflow', () => {
    expect(() => getWorkflowYaml('/project', 'npm', 'my-app', 'void')).toThrow('void connect');
  });
  it('scaffolds the direct Cloudflare deployment path with a scoped API token', () => {
    const yaml = getWorkflowYaml('/project', 'npm', null, 'cloudflare');
    expect(yaml).toContain('name: Deploy to Cloudflare');
    expect(yaml).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(yaml).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(yaml).toContain(
      'CLOUDFLARE_WORKERS_SUBDOMAIN: ${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}',
    );
    expect(yaml).toContain('CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}');
    expect(yaml).toContain('CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}');
    expect(yaml).toContain('npx void deploy --platform cloudflare');
    expect(yaml).toContain('contents: read');
    expect(yaml).not.toContain('id-token: write');
    expect(yaml).not.toContain('VOID_TOKEN');
  });

  it('sets up a supported Node before bunx runs the CLI in Bun workflows', () => {
    // bunx runs the CLI with the `node` on PATH, which is the runner's default Node.
    const yaml = getWorkflowYaml('/project', 'bun', null, 'cloudflare');
    expect(yaml).toContain(
      '      - uses: oven-sh/setup-bun@v2\n' +
        '      - uses: actions/setup-node@v6\n' +
        '        with:\n' +
        '          node-version: lts/*\n' +
        '          check-latest: true\n' +
        '      - run: bun install --frozen-lockfile\n',
    );
    expect(yaml.indexOf('actions/setup-node@v6')).toBeLessThan(
      yaml.indexOf('bunx void deploy --platform cloudflare'),
    );

    const managed = getWorkflowYaml(
      '/project',
      'bun',
      'my-app',
      'void',
      'https://api.company.example',
    );
    expect(managed.indexOf('actions/setup-node@v6')).toBeGreaterThan(-1);
    expect(managed.indexOf('actions/setup-node@v6')).toBeLessThan(
      managed.indexOf('bunx void connect'),
    );
  });

  it.each(['24.22.1', '24'])(
    'uses .node-version %s for the Bun workflow Node without a stale cached release',
    (pin) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-bun-node-'));
      try {
        writeFileSync(join(root, '.node-version'), `${pin}\n`);
        const yaml = getWorkflowYaml(root, 'bun', null, 'cloudflare');
        expect(yaml).toContain(
          '      - uses: actions/setup-node@v6\n' +
            '        with:\n' +
            '          node-version-file: .node-version\n' +
            '          check-latest: true\n' +
            '      - run: bun install --frozen-lockfile\n',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('asks setup-node for the latest LTS release instead of a cached one', () => {
    const yaml = getWorkflowYaml('/project', 'pnpm', null, 'cloudflare');
    expect(yaml).toContain(
      '        with:\n' +
        '          node-version: lts/*\n' +
        '          check-latest: true\n' +
        '          cache: pnpm\n',
    );
  });

  it('retains the GitHub OIDC workflow for managed deployments', () => {
    const yaml = getWorkflowYaml(
      '/project',
      'npm',
      'my-app',
      'void',
      'https://api.company.example',
    );
    expect(yaml).toContain('name: Deploy to Void');
    expect(yaml).toContain('id-token: write');
    expect(yaml).toContain(
      "VOID_API_URL: ${{ vars.VOID_API_URL || 'https://api.company.example' }}",
    );
    expect(yaml).toContain('npx void connect "$VOID_API_URL" --no-login');
    expect(yaml.indexOf('npx void connect')).toBeLessThan(yaml.indexOf('npx void deploy'));
    expect(yaml).toContain('npx void deploy --platform void --project "$VOID_PROJECT"');
  });
});

function expectPnpmAllowBuilds(root: string): void {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  expect(yaml.match(/^allowBuilds:\n(?: {2}.*\n)*/m)?.[0]).toBe(
    'allowBuilds:\n  better-sqlite3: false\n  esbuild: true\n  sharp: true\n  workerd: true\n',
  );
  expect(yaml).not.toContain('onlyBuiltDependencies:');
}

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  settings: { accessible: false },
  intro: vi.fn(),
  outro: (...args: Parameters<typeof mockOutro>) => mockOutro(...args),
  note: (...args: Parameters<typeof mockNote>) => mockNote(...args),
  log: {
    success: vi.fn(),
    warn: (...args: Parameters<typeof mockLogWarn>) => mockLogWarn(...args),
    error: (...args: Parameters<typeof mockLogError>) => mockLogError(...args),
    info: (...args: Parameters<typeof mockLogInfo>) => mockLogInfo(...args),
    step: (...args: Parameters<typeof mockLogStep>) => mockLogStep(...args),
    message: (...args: Parameters<typeof mockLogMessage>) => mockLogMessage(...args),
  },
  confirm: (...args: Parameters<typeof mockConfirm>) => mockConfirm(...args),
  select: (...args: Parameters<typeof mockSelect>) => mockSelect(...args),
  text: (...args: Parameters<typeof mockText>) => mockText(...args),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  isCI: () => false,
  isCancel: (value: unknown) => value === Symbol.for('cancel'),
  cancel: vi.fn(),
}));

vi.mock('../../src/cli/auth', () => ({
  getApiUrl: (...args: Parameters<typeof mockGetApiUrl>) => mockGetApiUrl(...args),
  getToken: (...args: Parameters<typeof mockGetToken>) => mockGetToken(...args),
  runPlatformLogin: (...args: Parameters<typeof mockRunLogin>) => mockRunLogin(...args),
  savePlatformToken: (...args: Parameters<typeof mockSaveToken>) => mockSaveToken(...args),
  getSiteDomain: () => 'void.app',
}));

vi.mock('../../src/cli/platform-cmd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/platform-cmd.ts')>()),
  discoverPlatform: (...args: Parameters<typeof mockDiscoverPlatform>) =>
    mockDiscoverPlatform(...args),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformApiError: class PlatformApiError extends Error {
    readonly status = 500;
    readonly code = undefined;
    readonly body = undefined;
  },
  PlatformClient: class {
    readonly apiUrl: string;

    constructor(_token: string, options?: string | { apiUrl?: string }) {
      this.apiUrl =
        (typeof options === 'string' ? options : options?.apiUrl) ??
        mockGetApiUrl() ??
        'https://api.example.com';
    }

    listProjects(...args: Parameters<typeof mockListProjects>) {
      return mockListProjects(...args);
    }

    createProject(...args: Parameters<typeof mockCreateProject>) {
      return mockCreateProject(...args);
    }
  },
}));

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawnSync: (...args: Parameters<typeof mockSpawnSync>) => mockSpawnSync(...args),
    // Init runs installs and drizzle-kit with `spawn`, behind a spinner. Answer
    // them from the same mock, so a test sets one result for both kinds of call.
    spawn: (...args: Parameters<typeof mockSpawnSync>) => {
      const result = mockSpawnSync(...args);
      const child = Object.assign(new EventEmitter(), {
        // No process has this id, so a signal to it reaches nothing.
        pid: result?.hang ? HANGING_COMMAND_PID : undefined,
      });
      const { stdio } = args[2] as { stdio: ['ignore', number, number] };
      if (result?.stdout) {
        writeSync(stdio[1], result.stdout);
      }
      if (result?.stderr) {
        writeSync(stdio[2], result.stderr);
      }
      const finish = (): void => {
        if (result?.error) {
          child.emit('error', result.error);
        } else {
          child.emit('exit', result?.status ?? null);
        }
      };
      if (result?.hang) {
        // The command keeps running until the test ends it.
        hangingCommands.push(finish);
      } else {
        queueMicrotask(finish);
      }
      return child;
    },
  };
});

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'void-init-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempDirAsync(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'void-init-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeMockGeneratedMigration(root: string): void {
  const schema = readFileSync(join(root, 'db', 'schema.ts'), 'utf8');
  const isPostgres = schema.includes('from "void/schema-pg"');
  const migrationsDir = join(root, 'db', 'migrations');
  const metaDir = join(migrationsDir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  writeFileSync(
    join(migrationsDir, '0000_generated.sql'),
    isPostgres
      ? `CREATE TABLE "messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
`
      : `CREATE TABLE \`messages\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`text\` text NOT NULL,
  \`created_at\` text DEFAULT (datetime('now')) NOT NULL
);
`,
  );
  writeFileSync(
    join(metaDir, '_journal.json'),
    JSON.stringify(
      {
        version: '7',
        dialect: isPostgres ? 'postgresql' : 'sqlite',
        entries: [{ idx: 0, version: '6', when: 0, tag: '0000_generated', breakpoints: true }],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(metaDir, '0000_snapshot.json'),
    JSON.stringify({ version: '6', dialect: isPostgres ? 'postgresql' : 'sqlite' }, null, 2) + '\n',
  );
}

function listMigrationSqlFiles(root: string): Array<string> {
  const migrationsDir = join(root, 'db', 'migrations');
  if (!existsSync(migrationsDir)) {
    return [];
  }
  return readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
}

/** The cwd of a mocked `drizzle-kit generate` spawn, or undefined for any other spawn. */
function drizzleGenerateCwd(command: unknown, args: unknown, options: unknown): string | undefined {
  if (command !== process.execPath || !Array.isArray(args) || args[1] !== 'generate') {
    return undefined;
  }
  const cwd = (options as { cwd?: unknown } | null | undefined)?.cwd;
  return typeof cwd === 'string' ? cwd : undefined;
}

/** Every spawn succeeds; drizzle-kit writes a migration and `yarn install` runs `onYarnInstall`. */
function mockSpawnSuccess(onYarnInstall?: (cwd: string) => void): void {
  mockSpawnSync.mockImplementation((command, args, options) => {
    const cwd = (options as { cwd?: unknown } | null | undefined)?.cwd;
    if (
      onYarnInstall &&
      command === 'yarn' &&
      Array.isArray(args) &&
      args[0] === 'install' &&
      typeof cwd === 'string'
    ) {
      onYarnInstall(cwd);
    }
    const generateCwd = drizzleGenerateCwd(command, args, options);
    if (generateCwd) {
      writeMockGeneratedMigration(generateCwd);
    }
    return { status: 0, stdout: '', stderr: '' };
  });
}

function installCalls() {
  return mockSpawnSync.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][0] === 'install',
  );
}

function drizzleGenerateCalls() {
  return mockSpawnSync.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
  );
}

function workspaceNotes() {
  return mockNote.mock.calls.filter((call) => call[1] === 'Workspace subpackage');
}

/** The closing summary lines init printed with `symbol`: ✓ for finished work, → for next steps. */
function summaryMessages(symbol: '✓' | '→'): Array<string | Array<string>> {
  return mockLogMessage.mock.calls
    .filter(([, options]) => stripVTControlCharacters(String(options?.symbol)) === symbol)
    .map(([message]) => message);
}

/** The summary line for an install. The mocked installer finishes at once. */
const INSTALLED = expect.stringMatching(/^Installed dependencies in (\d+ms|\d\.\ds|\d+s)$/);

function writeInstalledVoid(dir: string): void {
  mkdirSync(join(dir, 'node_modules', 'void'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'void', 'package.json'),
    JSON.stringify({ name: 'void', version: '0.0.0' }, null, 2) + '\n',
  );
}

/** An existing Vite app, so init offers the demo instead of the Pages starter. */
function writeExistingViteApp(
  root: string,
  options: { void?: string; packageManager?: string } = {},
): void {
  mkdirSync(root, { recursive: true });
  const devDependencies: Record<string, string> = { vite: '^8.0.0' };
  if (options.void !== undefined) {
    devDependencies.void = options.void;
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'app',
        private: true,
        type: 'module',
        packageManager: options.packageManager,
        devDependencies,
      },
      null,
      2,
    ) + '\n',
  );
}

/** Full init flow with no database, the demo accepted and GitHub Actions declined. */
async function runInitWithDemo(root: string): Promise<void> {
  mockSelect.mockResolvedValueOnce('none');
  mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await runInitCommand(root);
}

function expectVoidDeclared(root: string): void {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const voidSpec =
    pkg.devDependencies?.void ?? pkg.dependencies?.void ?? pkg.peerDependencies?.void;
  expect(typeof voidSpec).toBe('string');
  expect(voidSpec.length).toBeGreaterThan(0);
}

function writeExistingAstroProject(root: string): void {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      { name: 'existing-astro-app', private: true, dependencies: { astro: '^5.0.0' } },
      null,
      2,
    ) + '\n',
  );
}

function selectCloudflareDuringInit(accountId?: string): void {
  mockSelect.mockImplementation((options: { message?: string }) => {
    switch (options.message) {
      case 'Choose a database setup for this project:':
        return 'none';
      case 'Where should this project deploy?':
        return 'cloudflare';
      case 'Choose a Cloudflare account:':
        return accountId;
      default:
        return undefined;
    }
  });
}

function wranglerWhoamiResult(accounts: Array<{ id: string; name: string }>): {
  status: number;
  stdout: string;
  stderr: string;
} {
  return {
    status: 0,
    stdout: JSON.stringify({ operationResult: 1, data: { loggedIn: true, accounts, scopes: [] } }),
    stderr: '',
  };
}

function cloudflareOperationType(args: unknown): string | undefined {
  if (!Array.isArray(args)) {
    return undefined;
  }
  const input: unknown = args.at(-1);
  if (typeof input !== 'string') {
    return undefined;
  }
  try {
    const operation: unknown = JSON.parse(input);
    return isRecord(operation) && typeof operation.type === 'string' ? operation.type : undefined;
  } catch {
    return undefined;
  }
}

// Prompts are mocked, so give init a terminal to prompt in. CI stays set, as
// in CI runs, so Git and AGENTS.md setup keep skipping their prompts.
const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
let previousCI: string | undefined;

function restoreInteractiveTerminal(): void {
  if (previousCI === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = previousCI;
  }
  if (stdinTtyDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', stdinTtyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
}

afterEach(() => {
  restoreInteractiveTerminal();
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  rmSync(platformRegistryDirectory, { recursive: true, force: true });
  mockSpawnSync.mockReset();
  mockSelect.mockReset();
  mockConfirm.mockReset();
  mockText.mockReset();
  mockNote.mockReset();
  mockOutro.mockReset();
  mockLogWarn.mockReset();
  mockLogError.mockReset();
  mockLogInfo.mockReset();
  mockLogStep.mockReset();
  mockLogMessage.mockReset();
  mockGetToken.mockReset();
  mockGetApiUrl.mockReset();
  mockRunLogin.mockReset();
  mockSaveToken.mockReset();
  mockListProjects.mockReset();
  mockCreateProject.mockReset();
  mockDiscoverPlatform.mockReset();
});

beforeEach(() => {
  previousCI = process.env.CI;
  process.env.CI = 'true';
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => true });
  platformRegistryDirectory = mkdtempSync(join(tmpdir(), 'void-init-platform-registry-'));
  process.env.VOID_PLATFORM_REGISTRY_DIR = platformRegistryDirectory;
  savePlatformConnection({
    accountId: null,
    apiUrl: 'https://api.void.cloud',
    applicationDomain: 'void.app',
    displayName: 'Void Cloud',
    installationId: null,
    kind: 'connected',
    proxyUrl: 'https://proxy.void.cloud',
  });
  mockSelect.mockImplementation((options: { message?: string }) =>
    options.message === 'Where should this project deploy?' ? 'void' : undefined,
  );
  mockSpawnSuccess();
  mockGetToken.mockReturnValue(null);
  mockGetApiUrl.mockReturnValue('https://api.void.cloud');
  mockRunLogin.mockResolvedValue('token_123');
  mockListProjects.mockResolvedValue([]);
  mockCreateProject.mockResolvedValue({ id: 'proj_123', slug: 'my-app' });
  mockDiscoverPlatform.mockResolvedValue({
    apiUrl: 'https://api.void.cloud',
    applicationDomain: 'void.app',
    authenticationProviders: ['github', 'google'],
    capabilities: {
      ai: true,
      customDomains: true,
      email: true,
      githubActions: true,
      githubOAuth: true,
      googleOAuth: true,
      managedBuilds: true,
      sandbox: true,
    },
    displayName: 'Void Cloud',
    installationId: null,
    platformVersion: '0.10.14',
    proxyUrl: 'https://proxy.void.cloud',
    schemaVersion: 1,
    usageProtocolVersion: 0,
  });
});

describe('Void platform deployment setup', () => {
  it('connects a genuinely new user before attempting platform login', async () => {
    rmSync(platformRegistryDirectory, { force: true, recursive: true });
    mockGetApiUrl.mockImplementation(() => {
      throw new Error('No Void platform connected');
    });
    mockText.mockResolvedValue('https://platform.example.test');
    mockDiscoverPlatform.mockResolvedValueOnce({
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      authenticationProviders: ['github'],
      capabilities: {
        ai: true,
        customDomains: true,
        email: false,
        githubActions: false,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
      },
      displayName: 'Company Void',
      installationId: 'company-a1b2c3d4',
      platformVersion: '0.10.14',
      proxyUrl: 'https://proxy.example.test',
      schemaVersion: 1,
      usageProtocolVersion: 0,
    });

    await ensureVoidPlatformConnection('/project');

    expect(mockDiscoverPlatform).toHaveBeenCalledWith('https://platform.example.test');
    const { getActivePlatformConnection } = await import('../../src/cli/platform-registry.ts');
    expect(getActivePlatformConnection()).toMatchObject({
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      proxyUrl: 'https://proxy.example.test',
    });
  });

  it('refuses to scaffold unsupported platform GitHub Actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-no-github-actions-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mockDiscoverPlatform.mockResolvedValueOnce({
        apiUrl: 'https://platform.example.test',
        applicationDomain: 'apps.example.test',
        authenticationProviders: ['github'],
        capabilities: {
          ai: true,
          customDomains: true,
          email: false,
          githubActions: false,
          githubOAuth: true,
          googleOAuth: false,
          managedBuilds: false,
          sandbox: false,
        },
        displayName: 'Company Void',
        installationId: 'company-a1b2c3d4',
        platformVersion: '0.10.14',
        proxyUrl: 'https://proxy.example.test',
        schemaVersion: 1,
        usageProtocolVersion: 0,
      });

      await expect(runInitCommand(root, { github: true, tsconfig: false })).rejects.toThrow(
        'Company Void does not support GitHub Actions deployments',
      );
      expect(existsSync(join(root, '.github', 'workflows', 'void-deploy.yml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('extractPnpmWorkspacePackages', () => {
  it('parses block-style packages list with mixed quoting', () => {
    const yaml = ['packages:', "  - 'packages/*'", '  - "apps/*"', '  - docs', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['packages/*', 'apps/*', 'docs']);
  });

  it('parses inline flow-style list with a single quoted element', () => {
    expect(extractPnpmWorkspacePackages("packages: ['packages/*']\n")).toEqual(['packages/*']);
  });

  it('parses inline flow-style list with multiple quoted elements', () => {
    expect(extractPnpmWorkspacePackages("packages: ['packages/*', 'apps/*']\n")).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('parses inline flow-style list with unquoted elements', () => {
    expect(extractPnpmWorkspacePackages('packages: [packages/*]\n')).toEqual(['packages/*']);
  });

  it('parses inline flow-style list with surrounding whitespace', () => {
    expect(extractPnpmWorkspacePackages("packages: [ 'packages/*' ,  'apps/*' ]\n")).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('parses inline flow-style list mixing quoted and unquoted elements', () => {
    expect(extractPnpmWorkspacePackages('packages: ["packages/*", apps/*]\n')).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('returns [] when packages key is absent', () => {
    expect(extractPnpmWorkspacePackages('catalog:\n  vite: ^8.0.0\n')).toEqual([]);
  });

  it('preserves `#` inside a double-quoted workspace pattern', () => {
    const yaml = ['packages:', '  - "path #hash/*"', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['path #hash/*']);
  });

  it('preserves `#` inside a single-quoted workspace pattern', () => {
    const yaml = ['packages:', "  - 'apps/#one/*'", ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['apps/#one/*']);
  });

  it('strips a trailing comment from a quoted pattern without touching the value', () => {
    const yaml = ['packages:', '  - "apps/*" # top-level apps', '  - docs', ''].join('\n');
    expect(extractPnpmWorkspacePackages(yaml)).toEqual(['apps/*', 'docs']);
  });

  it('preserves `#` inside a quoted flow-style pattern', () => {
    expect(extractPnpmWorkspacePackages('packages: ["a/#b/*", "c/*"]\n')).toEqual([
      'a/#b/*',
      'c/*',
    ]);
  });
});

describe('isVoidResolvableFrom', () => {
  function probeCalls(kind: 'cjs' | 'esm'): number {
    const argv =
      kind === 'cjs'
        ? ['-e', "require.resolve('void')"]
        : ['--input-type=module', '-e', "import.meta.resolve('void')"];
    return mockSpawnSync.mock.calls.filter((call) => {
      const args: unknown = call[1];
      return Array.isArray(args) && argv.every((arg, index) => args[index] === arg);
    }).length;
  }

  it('returns true when a PnP runtime sits at an ancestor directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-'));
    try {
      const subApp = join(root, 'packages', 'app');
      mkdirSync(subApp, { recursive: true });
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      expect(isVoidResolvableFrom(subApp)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Before `yarn install`, a committed `.pnp.cjs` points at archives that are not fetched yet.
  it('returns false when .pnp.cjs exists but .yarn/install-state.gz is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-fresh-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      expect(isVoidResolvableFrom(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Zero-install repos commit `.yarn/cache` and often have no install-state.gz.
  it('returns true when .pnp.cjs exists with a populated .yarn/cache (zero-install)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-zero-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn', 'cache'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'cache', 'pkg-npm-1.0.0-abcd.zip'), '');
      expect(isVoidResolvableFrom(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when .pnp.cjs exists but .yarn/cache is empty and install-state.gz is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-empty-cache-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn', 'cache'), { recursive: true });
      expect(isVoidResolvableFrom(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when .yarn/install-state.gz is at a DIFFERENT ancestor than .pnp.cjs', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-mismatch-'));
    try {
      const subApp = join(root, 'app');
      mkdirSync(subApp, { recursive: true });
      writeFileSync(join(subApp, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      expect(isVoidResolvableFrom(subApp)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false for a bare directory with no node_modules and no PnP runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-bare-'));
    try {
      expect(isVoidResolvableFrom(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when `node_modules/void/package.json` exists at `start` (unchanged legacy shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-nm-'));
    try {
      writeInstalledVoid(root);
      expect(isVoidResolvableFrom(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when `node_modules/void/package.json` exists at an ancestor (hoisted monorepo shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-hoist-'));
    try {
      writeInstalledVoid(root);
      const subApp = join(root, 'packages', 'app');
      mkdirSync(subApp, { recursive: true });
      expect(isVoidResolvableFrom(subApp)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Installed PnP data can be stale (for example after `void` was removed on another branch).
  it('returns false when the PnP probe for `require.resolve("void")` fails (stale .pnp.cjs)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-stale-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });

      expect(isVoidResolvableFrom(root)).toBe(false);
      expect(probeCalls('cjs')).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when the PnP probe for `require.resolve("void")` succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-ok-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

      expect(isVoidResolvableFrom(root)).toBe(true);
      expect(probeCalls('cjs')).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A loader-only runtime gets no `--require`, so a CJS probe cannot see it.
  it('uses an ESM probe when only `.pnp.loader.mjs` is present (loader-only PnP)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-loader-only-'));
    try {
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

      expect(isVoidResolvableFrom(root)).toBe(true);
      expect(probeCalls('esm')).toBe(1);
      expect(probeCalls('cjs')).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when the loader-only ESM probe fails (stale `.pnp.loader.mjs`)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-loader-stale-'));
    try {
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });

      expect(isVoidResolvableFrom(root)).toBe(false);
      expect(probeCalls('esm')).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still uses the CJS probe when both `.pnp.cjs` and `.pnp.loader.mjs` are present', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-both-'));
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      writeFileSync(join(root, '.pnp.loader.mjs'), '// pnp loader\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

      expect(isVoidResolvableFrom(root)).toBe(true);
      expect(probeCalls('cjs')).toBe(1);
      expect(probeCalls('esm')).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not spawn the PnP probe when node_modules/void exists at start (even with PnP markers)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-pnp-nm-'));
    try {
      writeInstalledVoid(root);
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      const probesBefore = probeCalls('cjs');
      expect(isVoidResolvableFrom(root)).toBe(true);
      expect(probeCalls('cjs')).toBe(probesBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A nested project with its own lockfile must not inherit an outer PnP graph.
  it('does not walk past a leaf-managed lockfile into an ancestor Yarn PnP monorepo', () => {
    const outer = mkdtempSync(join(tmpdir(), 'void-init-pnp-leaf-lock-'));
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const leaf = join(outer, 'scratch', 'my-app');
      mkdirSync(leaf, { recursive: true });
      writeFileSync(join(leaf, 'package.json'), '{"name":"my-app"}\n');
      writeFileSync(join(leaf, 'package-lock.json'), '{}\n');

      const probesBefore = mockSpawnSync.mock.calls.length;
      expect(isVoidResolvableFrom(leaf)).toBe(false);
      expect(mockSpawnSync.mock.calls.length).toBe(probesBefore);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  // Yarn workspace members may carry their own Corepack pin and still use the root `.pnp.cjs`.
  it('still walks to an ancestor `.pnp.cjs` when a subpackage has only a `packageManager` pin (no lockfile)', () => {
    const outer = mkdtempSync(join(tmpdir(), 'void-init-pnp-pkgmgr-ws-'));
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const sub = join(outer, 'packages', 'app');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(sub, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.5.3' }, null, 2) + '\n',
      );
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

      expect(isVoidResolvableFrom(sub)).toBe(true);
      expect(probeCalls('cjs')).toBe(1);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

// An outer `.pnp.cjs` in NODE_OPTIONS would resolve a leaf project's deps through the wrong graph.
describe('buildDrizzleKitSpawnEnv leaf-managed gate', () => {
  it('does not inject NODE_OPTIONS for a leaf project with a local lockfile inside a Yarn PnP monorepo', () => {
    const outer = mkdtempSync(join(tmpdir(), 'void-init-env-leaf-lock-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const leaf = join(outer, 'scratch', 'my-app');
      mkdirSync(leaf, { recursive: true });
      writeFileSync(join(leaf, 'package.json'), '{"name":"my-app"}\n');
      writeFileSync(join(leaf, 'package-lock.json'), '{}\n');

      const env = buildDrizzleKitSpawnEnv(leaf);
      expect(env.NODE_OPTIONS).toBeUndefined();
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('still injects NODE_OPTIONS for a workspace subpackage that only has a `packageManager` pin', () => {
    const outer = mkdtempSync(join(tmpdir(), 'void-init-env-pkgmgr-ws-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(outer, '.pnp.cjs'), '// pnp stub\n');
      mkdirSync(join(outer, '.yarn'), { recursive: true });
      writeFileSync(join(outer, '.yarn', 'install-state.gz'), '');
      const sub = join(outer, 'packages', 'app');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(sub, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.5.3' }, null, 2) + '\n',
      );

      const env = buildDrizzleKitSpawnEnv(sub);
      expect(env.NODE_OPTIONS).toBeDefined();
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(toSlash(join(outer, '.pnp.cjs'))));
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('still injects NODE_OPTIONS when local PnP files exist alongside a lockfile (local PnP precedence)', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-env-local-pnp-'));
    const savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      mkdirSync(join(root, '.yarn'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'install-state.gz'), '');

      const env = buildDrizzleKitSpawnEnv(root);
      expect(env.NODE_OPTIONS).toBeDefined();
      expect(env.NODE_OPTIONS).toContain('--require');
      expect(env.NODE_OPTIONS).toContain(JSON.stringify(toSlash(join(root, '.pnp.cjs'))));
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isScaffoldableEmptyProject', () => {
  it('returns true for an empty directory', () => {
    withTempDir((root) => {
      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns true for npm install -D void shape', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              void: '^0.0.1',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'package-lock.json'), '{}\n');

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns true for pnpm add -D void shape with generated pnpm-workspace.yaml', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            devDependencies: {
              void: '^0.8.9',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        [
          'allowBuilds:',
          '  better-sqlite3: set this to true or false',
          '  esbuild: set this to true or false',
          '  sharp: set this to true or false',
          '  workerd: set this to true or false',
          'minimumReleaseAgeExclude:',
          '  - void@0.8.9',
          '',
        ].join('\n'),
      );
      mkdirSync(join(root, 'node_modules', 'void'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'void', 'package.json'), '{"name":"void"}\n');

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns true when only void and a single Pages adapter are installed', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              void: '^0.2.3',
              '@void/react': '^0.2.3',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('returns false when pnpm-workspace.yaml declares workspace packages', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            devDependencies: {
              void: '^0.8.9',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('returns true for a deleted starter that only has manifest and generated state left', () => {
    withTempDir((root) => {
      mkdirSync(join(root, '.void'), { recursive: true });
      mkdirSync(join(root, '.wrangler'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({}) + '\n');
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'deleted-starter',
            private: true,
            type: 'module',
            scripts: {
              dev: 'vp dev',
              build: 'vp build',
              preview: 'vp preview',
              postinstall: 'void prepare',
            },
            dependencies: {
              hono: '^4.11.9',
              svelte: '^5.53.9',
            },
            devDependencies: {
              void: '^0.2.3',
              '@void/svelte': '^0.2.3',
              vite: '^8.0.10',
              'vite-plus': '^0.1.21',
              typescript: '^7.0.2',
            },
          },
          null,
          2,
        ) + '\n',
      );

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it('replaces stale vp starter scripts when plain Vite is selected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'stale-vp-starter',
            scripts: {
              dev: 'vp dev',
              build: 'vp build',
              preview: 'vp preview',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect
        .mockResolvedValueOnce('vite')
        .mockResolvedValueOnce('svelte')
        .mockResolvedValueOnce('static');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts).toMatchObject({
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
      });
      expect(pkg.devDependencies.vite).toBe('^8.0.10');
      expect(pkg.devDependencies['vite-plus']).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when app files already exist', () => {
    withTempDir((root) => {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'main.ts'), "console.log('x');\n");
      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('returns false when package has non-starter dependencies', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              void: '^0.0.1',
              express: '^4.18.0',
            },
          },
          null,
          2,
        ) + '\n',
      );

      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it('scaffolds a React Pages starter with D1 in an empty directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies['react-dom']).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies.typescript).toBeDefined();
      expect(pkg.devDependencies['@void/react']).toBeDefined();
      expect(pkg.devDependencies['@types/react']).toBeDefined();
      expect(pkg.devDependencies['@types/react-dom']).toBeDefined();
      expect(pkg.devDependencies['oxc-transform-react']).toBeDefined();
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(pkg.scripts.build).toBe('vp build');
      expect(pkg.scripts.preview).toBe('vp preview');
      expect(pkg.scripts.postinstall).toBe('void prepare');

      const reactViteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(reactViteConfig).toContain('from "@void/react/plugin"');
      expect(reactViteConfig).toContain('voidReact({ react: { compiler: true } })');
      const page = readFileSync(join(root, 'pages', 'index.tsx'), 'utf8');
      expect(page).toContain('Welcome to Void');
      expect(page).toContain('The list below is loaded from your database in');
      expect(page).toContain('href="/api/hello"');
      expect(page).toContain('void db seed');
      expect(page).not.toContain('no database or server code yet');
      expect(page).not.toContain('Void +');
      expect(page).toContain('src="/react.svg"');
      expect(page).toContain('import "./style.css"');
      expect(page).toContain('messages.map');
      expect(page).toContain('useForm');
      expect(page).toContain('<Form form={form}');
      expect(page).toContain('No messages yet.');
      expect(readFileSync(join(root, 'pages', 'style.css'), 'utf8')).toContain(
        'prefers-color-scheme: dark',
      );
      expect(readFileSync(join(root, 'pages', 'vite-env.d.ts'), 'utf8')).toContain(
        'reference types="vite/client"',
      );
      expect(readFileSync(join(root, 'public', 'void.svg'), 'utf8')).toContain('<svg');
      expect(readFileSync(join(root, 'public', 'react.svg'), 'utf8')).toContain('<svg');
      expect(readFileSync(join(root, 'public', 'stack.svg'), 'utf8')).toContain('<svg');
      expect(page).toContain('src="/stack.svg"');
      expect(readFileSync(join(root, 'public', 'icons.svg'), 'utf8')).toContain(
        'id="documentation-icon"',
      );
      expect(readFileSync(join(root, 'pages', 'index.server.ts'), 'utf8')).toContain(
        'import { messages } from "@schema";',
      );
      expect(readFileSync(join(root, 'routes', 'api', 'hello.ts'), 'utf8')).toContain(
        'export const GET = defineHandler',
      );
      expect(readFileSync(join(root, 'db', 'schema.ts'), 'utf8')).toContain(
        'from "void/schema-d1"',
      );
      expect(readFileSync(join(root, 'db', 'seed.ts'), 'utf8')).toContain('defineSeed');
      expect(listMigrationSqlFiles(root)).toEqual(['0000_generated.sql']);
      expect(readFileSync(join(root, 'db', 'migrations', '0000_generated.sql'), 'utf8')).toContain(
        'CREATE TABLE',
      );
      expect(
        readFileSync(join(root, 'db', 'migrations', 'meta', '_journal.json'), 'utf8'),
      ).toContain('"entries"');

      expect(() => readFileSync(join(root, 'routes', 'api', 'hello.get.ts'), 'utf8')).toThrow(
        /ENOENT/,
      );
      expect(() => readFileSync(join(root, 'index.html'), 'utf8')).toThrow(/ENOENT/);
      expect(() => readFileSync(join(root, 'src', 'main.ts'), 'utf8')).toThrow(/ENOENT/);
      expect(readConfig(root)).toEqual({
        routing: { typedRoutes: true },
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
      expect(() =>
        readFileSync(join(root, 'db', 'migrations', '0000_initial.sql'), 'utf8'),
      ).toThrow(/ENOENT/);

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.compilerOptions.jsx).toBe('react-jsx');
      expect(tsconfig.include).toContain('pages');
      expect(tsconfig.include).toContain('db');

      expect(mockLogInfo).toHaveBeenCalledWith('Empty project detected. Creating a Pages starter.');
      // The starter has its own pages.
      expect(mockLogInfo).not.toHaveBeenCalledWith(expect.stringContaining('skipping demo'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds a Vue Pages starter with PostgreSQL config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('postgresql');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.dependencies.vue).toBeDefined();
      expect(pkg.devDependencies['@void/vue']).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();

      expect(readConfig(root)).toEqual({
        routing: { typedRoutes: true },
        database: 'pg',
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });

      const vueViteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(vueViteConfig).toContain('from "@void/vue/plugin"');
      expect(vueViteConfig).toContain('voidVue()');
      const page = readFileSync(join(root, 'pages', 'index.vue'), 'utf8');
      expect(page).toContain('Welcome to Void');
      expect(page).not.toContain('Void +');
      expect(page).toContain('src="/vue.svg"');
      expect(page).toContain('v-for="message in messages"');
      expect(page).toContain('<Form :form="form"');
      expect(readFileSync(join(root, 'db', 'schema.ts'), 'utf8')).toContain(
        'from "void/schema-pg"',
      );
      expect(readFileSync(join(root, 'db', 'seed.ts'), 'utf8')).toContain('defineSeed');
      expect(listMigrationSqlFiles(root)).toEqual(['0000_generated.sql']);
      expect(readFileSync(join(root, 'db', 'migrations', '0000_generated.sql'), 'utf8')).toContain(
        'CREATE TABLE "messages"',
      );
      expect(summaryMessages('✓')).toEqual([
        'Created a Vue Pages starter with PostgreSQL',
        INSTALLED,
        'Generated the initial database migration',
      ]);
      expect(summaryMessages('→')).toEqual([
        'Add DATABASE_URL to .env before running `vp dev` (Void uses it for local PostgreSQL development)',
      ]);

      const toolchainPrompt = mockSelect.mock.calls[0]?.[0];
      expect(toolchainPrompt.message).toBe('Choose a Pages scaffold toolchain:');
      expect(toolchainPrompt.initialValue).toBe('vite-plus');
      expect(toolchainPrompt.options).toEqual([
        {
          value: 'vite-plus',
          label: 'Vite+',
          hint: 'Uses the Vite+ toolchain and vp commands.',
        },
        {
          value: 'vite',
          label: 'Vite',
          hint: 'Uses plain Vite commands without Vite+.',
        },
      ]);

      const frameworkPrompt = mockSelect.mock.calls[1]?.[0];
      expect(frameworkPrompt.message).toBe('Choose a Pages framework to scaffold:');
      expect(frameworkPrompt.options).toEqual([
        {
          value: 'react',
          label: 'React',
          hint: 'TSX Pages starter with the React adapter.',
        },
        {
          value: 'vue',
          label: 'Vue',
          hint: 'Vue SFC Pages starter with the Vue adapter.',
        },
        {
          value: 'svelte',
          label: 'Svelte',
          hint: 'Svelte 5 Pages starter with the Svelte adapter.',
        },
        {
          value: 'solid',
          label: 'Solid',
          hint: 'Fine-grained TSX Pages starter with the Solid adapter.',
        },
      ]);

      const starterPrompt = mockSelect.mock.calls[2]?.[0];
      expect(starterPrompt.message).toBe('Choose a Pages starter:');
      expect(starterPrompt.options).toEqual([
        {
          value: 'sqlite',
          label: 'D1 (SQLite)',
          hint: 'Recommended starter. Scaffolds a DB-backed page, schema, generated migration, seed file, and API route.',
        },
        {
          value: 'postgresql',
          label: 'PostgreSQL',
          hint: 'Scaffolds the same starter with PostgreSQL, a generated migration, a seed file, and writes database: "pg" to void.config.ts.',
        },
        {
          value: 'mysql',
          label: 'MySQL',
          hint: 'Scaffolds the same starter with MySQL, a generated migration, a seed file, and writes database: "mysql" to void.config.ts.',
        },
        {
          value: 'static',
          label: 'Static Pages',
          hint: 'No database or server starter files yet. Good for content sites; add Void features later.',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds a static Pages starter without database files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies['react-dom']).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies['@void/react']).toBeDefined();
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.devDependencies.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
      expect(pkg.packageManager).toBeUndefined();
      expectPnpmAllowBuilds(root);
      expect(detectProjectState(root).packageManager).toBe('pnpm');
      expect(installCalls()[0][0]).toBe('vp');
      expect(pkg.scripts.dev).toBe('vp dev');

      const page = readFileSync(join(root, 'pages', 'index.tsx'), 'utf8');
      expect(page).toContain('Welcome to Void');
      expect(page).toContain(
        'This starter is running in Pages mode with no database or server code yet.',
      );
      expect(page).toContain('you want to grow into full-stack features.');
      expect(page).not.toContain('href="/api/hello"');
      expect(page).not.toContain('useForm');
      expect(page).not.toContain('<Form');

      expect(() => readFileSync(join(root, 'pages', 'index.server.ts'), 'utf8')).toThrow();
      expect(() => readFileSync(join(root, 'routes', 'api', 'hello.ts'), 'utf8')).toThrow();
      expect(() => readFileSync(join(root, 'db', 'schema.ts'), 'utf8')).toThrow();
      expect(() => readFileSync(join(root, 'db', 'seed.ts'), 'utf8')).toThrow();
      expect(() =>
        readFileSync(join(root, 'db', 'migrations', '0000_generated.sql'), 'utf8'),
      ).toThrow();
      expect(readConfig(root)).toEqual({
        routing: { typedRoutes: true },
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['npm@11.20.0', 'pnpm@10.34.4', 'yarn@4.5.3', 'bun@1.1.42'])(
    'preserves %s when scaffolding with Vite+',
    async (packageManager) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-'));
      try {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ private: true, packageManager }),
        );
        mockSelect
          .mockResolvedValueOnce('vite-plus')
          .mockResolvedValueOnce('react')
          .mockResolvedValueOnce('static');
        mockConfirm.mockResolvedValueOnce(false);

        await runInitCommand(root);

        expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager).toBe(
          packageManager,
        );
        expect(detectProjectState(root).packageManager).toBe(packageManager.split('@')[0]);
        expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(
          packageManager.startsWith('pnpm@'),
        );
        expect(installCalls()[0][0]).toBe('vp');
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        expect(pkg.devDependencies.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
        if (packageManager.startsWith('npm@')) {
          expect(pkg.overrides.vite).toBe('$vite');
        } else if (packageManager.startsWith('bun@')) {
          expect(pkg.overrides.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
        } else if (packageManager.startsWith('yarn@')) {
          expect(pkg.resolutions.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['npm', 'pnpm', 'yarn', 'bun'])(
    'preserves an existing Vite+ pairing and overrides with %s',
    async (manager) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-existing-vp-'));
      const core = 'npm:@voidzero-dev/vite-plus-core@8.4.1000';
      const policy = { vite: core, vitest: '5.2.0', unrelated: '^2.0.0' };
      try {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({
            packageManager: manager + '@1.0.0',
            devDependencies: { 'vite-plus': '1.8.0', vite: core, '@void/react': '^1.10.0' },
            ...(manager === 'yarn' ? { resolutions: policy } : { overrides: policy }),
          }),
        );
        if (manager === 'pnpm') {
          writeFileSync(
            join(root, 'pnpm-workspace.yaml'),
            '# User toolchain\noverrides: { "vite@*": "' + core + '", "vitest@*": "5.2.0" }\n',
          );
        }
        mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('static');
        mockConfirm.mockResolvedValueOnce(false);
        await runInitCommand(root);
        expect(existsSync(join(root, 'pages/index.tsx'))).toBe(true);
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        expect(pkg.devDependencies).toMatchObject({ 'vite-plus': '1.8.0', vite: core });
        expect(manager === 'yarn' ? pkg.resolutions : pkg.overrides).toEqual(policy);
        if (manager === 'pnpm') {
          expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain(
            '"vite@*": "' + core + '"',
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('preserves catalog references when scaffolding with an existing Vite+ toolchain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-catalog-vp-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          packageManager: 'pnpm@12.4.1',
          devDependencies: {
            '@void/react': '^1.10.0',
            'vite-plus': 'catalog:tools',
            vite: 'catalog:',
          },
        }),
      );
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        '# Selected toolchain\ncatalog: { vite: "npm:@voidzero-dev/vite-plus-core@1.6.0" }\n' +
          'catalogs: { tools: { vite-plus: "1.6.0" } }\noverrides: { "vite@*": "catalog:" }\n',
      );
      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('static');
      mockConfirm.mockResolvedValueOnce(false);
      await runInitCommand(root);
      expect(existsSync(join(root, 'pages/index.tsx'))).toBe(true);
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.devDependencies).toMatchObject({ 'vite-plus': 'catalog:tools', vite: 'catalog:' });
      expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain(
        '"vite@*": "catalog:"',
      );
      expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain(
        'vite-plus: "1.6.0"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['package-lock.json', 'yarn.lock', 'bun.lock'])(
    'preserves %s without switching a Vite+ starter to pnpm',
    async (lockfile) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-'));
      try {
        writeFileSync(join(root, lockfile), '');
        mockSelect
          .mockResolvedValueOnce('vite-plus')
          .mockResolvedValueOnce('react')
          .mockResolvedValueOnce('static');
        mockConfirm.mockResolvedValueOnce(false);

        await runInitCommand(root);

        expect(
          JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager,
        ).toBeUndefined();
        expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(false);
        expect(installCalls()[0][0]).toBe('vp');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('prompts for the scaffold toolchain after pnpm add -D void creates pnpm-workspace.yaml', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            devDependencies: {
              void: '^0.8.9',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        [
          'allowBuilds:',
          '  better-sqlite3: set this to true or false',
          '  esbuild: set this to true or false',
          '  sharp: set this to true or false',
          '  workerd: set this to true or false',
          'minimumReleaseAgeExclude:',
          '  - void@0.8.9',
          '',
        ].join('\n'),
      );
      mkdirSync(join(root, 'node_modules', 'void'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'void', 'package.json'), '{"name":"void"}\n');

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.devDependencies.void).toBe('^0.8.9');
      expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toContain(
        'voidReact({ react: { compiler: true } })',
      );
      expectPnpmAllowBuilds(root);

      expect(mockSelect.mock.calls[0]?.[0].message).toBe('Choose a Pages scaffold toolchain:');
      expect(mockSelect.mock.calls[0]?.[0].initialValue).toBe('vite-plus');
      expect(mockSelect.mock.calls[1]?.[0].message).toBe('Choose a Pages framework to scaffold:');
      expect(mockSelect.mock.calls[2]?.[0].message).toBe('Choose a Pages starter:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers to scaffold in a subfolder from a non-project parent directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    // The user's shell stays in the parent directory.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      mkdirSync(join(root, 'existing-project'));
      mockSelect
        .mockResolvedValueOnce('subfolder')
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static');
      mockText.mockResolvedValueOnce('my-new-app');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(existsSync(join(root, 'package.json'))).toBe(false);
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
      // Init created the folder, so it does not report detecting an empty project.
      expect(mockLogInfo).toHaveBeenCalledWith('Creating a Pages starter in ./my-new-app.');
      expect(mockLogInfo).not.toHaveBeenCalledWith(expect.stringContaining('detected'));
      expect(summaryMessages('✓')).toEqual([
        'Created a static React Pages starter in ./my-new-app',
        INSTALLED,
      ]);

      const appRoot = join(root, 'my-new-app');
      const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(readFileSync(join(appRoot, 'pages', 'index.tsx'), 'utf8')).toContain(
        'Welcome to Void',
      );

      const locationPrompt = mockSelect.mock.calls[0]?.[0];
      expect(locationPrompt.message).toBe(
        'This folder is not empty. Where should Void initialize?',
      );
      expect(locationPrompt.initialValue).toBe('subfolder');
      expect(mockText).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'New project folder name:',
          placeholder: 'my-void-app',
          defaultValue: 'my-void-app',
        }),
      );
      const folderPrompt = mockText.mock.calls[0][0];
      expect(folderPrompt).not.toHaveProperty('initialValue');
      const validate = folderPrompt.validate;
      if (!validate) {
        throw new Error('Expected a project folder validator');
      }
      expect(validate('')).toBeUndefined();
      expect(validate(' ')).toBe('Enter a folder name.');
      mkdirSync(join(root, 'my-void-app'));
      expect(validate('')).toBe('That folder already exists.');
      expect(validate('another-app')).toBeUndefined();
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'vp',
        ['install', '--no-frozen-lockfile'],
        expect.objectContaining({
          cwd: toSlash(appRoot),
          stdio: ['ignore', expect.any(Number), expect.any(Number)],
          shell: process.platform === 'win32',
        }),
      );
      expect(String(mockOutro.mock.calls.at(-1)?.[0])).toContain(
        'Run `cd my-new-app && vp dev` to start developing.',
      );
    } finally {
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can continue configuring a non-project parent directory when requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'existing-project'));
      mockSelect.mockResolvedValueOnce('current').mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.type).toBe('module');
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.scripts.dev).toBe('vite');
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(true);
      expect(mockText).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('configures an existing package without forcing it to ESM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.type).toBeUndefined();
      expect(pkg.scripts.dev).toBe('vite');
      expect(pkg.scripts.build).toBe('vite build');
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies.vite).toBe('^8.0.10');

      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
      const viteConfig = readFileSync(join(root, 'vite.config.mts'), 'utf8');
      expect(viteConfig).toContain('import { voidPlugin } from "void";');
      expect(viteConfig).toContain('plugins: [voidPlugin()]');
      expect(mockConfirm).toHaveBeenCalledWith({
        message: 'Create .github/workflows/void-deploy.yml to deploy on pushes to main?',
      });
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'npm',
        ['install'],
        expect.objectContaining({
          cwd: root,
          stdio: ['ignore', expect.any(Number), expect.any(Number)],
          shell: process.platform === 'win32',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds an OIDC deploy workflow with a VOID_PROJECT placeholder when no project is linked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );

      await runInitCommand(root, { github: true, tsconfig: false });

      const yaml = readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf8');
      expect(yaml).not.toContain('secrets.VOID_TOKEN');
      expect(yaml).toContain('id-token: write');
      expect(yaml).toContain('contents: read');
      expect(yaml).toContain('VOID_PROJECT: ${{ vars.VOID_PROJECT }}');
      expect(yaml).toContain("VOID_API_URL: ${{ vars.VOID_API_URL || 'https://api.void.cloud' }}");
      expect(yaml).toContain('npx void deploy --platform void --project "$VOID_PROJECT"');
      expect(yaml.match(/deploy --platform void --project "\$VOID_PROJECT"/g)).toHaveLength(1);
      expect(yaml).toContain('concurrency:');
      expect(yaml).toContain('group: void-deploy-${{ github.repository }}-${{ github.ref }}');
      expect(yaml).toContain('cancel-in-progress: true');
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Set a VOID_PROJECT repository variable'),
        'GitHub Actions OIDC deploy',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bakes the linked project slug into the OIDC deploy workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mkdirSync(join(root, '.void'), { recursive: true });
      writeFileSync(
        join(root, '.void', 'project.json'),
        JSON.stringify({ projectId: 'prj_123', slug: 'my-app' }, null, 2) + '\n',
      );

      await runInitCommand(root, { github: true, tsconfig: false });

      const yaml = readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf8');
      expect(yaml).toContain('VOID_PROJECT: my-app');
      expect(yaml).not.toContain('vars.VOID_PROJECT');
      expect(yaml).toContain('concurrency:');
      expect(yaml).toContain('group: void-deploy-${{ github.repository }}-${{ github.ref }}');
      expect(yaml).toContain('cancel-in-progress: true');
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('"my-app"'),
        'GitHub Actions OIDC deploy',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bakes the slug into void-deploy.yml when a project is linked during the same interactive init', async () => {
    // The workflow is written before the project link, so the slug is patched in afterwards.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'existing-astro-app',
            private: true,
            dependencies: { astro: '^5.0.0' },
          },
          null,
          2,
        ) + '\n',
      );
      mockGetToken.mockReturnValue('existing_token');
      mockListProjects.mockResolvedValueOnce([
        {
          id: 'proj_789',
          user_id: 'user_1',
          slug: 'linked-app',
          type: 'worker',
          created_at: '2026-03-27T00:00:00.000Z',
          custom_domain: null,
        },
      ]);
      // Selects: database, deployment platform, project.
      mockSelect
        .mockResolvedValueOnce('none')
        .mockResolvedValueOnce('void')
        .mockResolvedValueOnce('proj_789');
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf8'))).toEqual({
        applicationDomain: 'void.app',
        platform: 'void',
        platformUrl: 'https://api.void.cloud',
        proxyUrl: 'https://proxy.void.cloud',
        projectId: 'proj_789',
        slug: 'linked-app',
      });
      const yaml = readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf8');
      expect(yaml).toContain('VOID_PROJECT: linked-app');
      expect(yaml).not.toContain('vars.VOID_PROJECT');
      expect(yaml).not.toContain('Set a VOID_PROJECT repository variable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes void-deploy.yml and never touches an existing deploy.yml (no migration)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'existing-app', private: true }, null, 2) + '\n',
      );
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      const existingPath = join(root, '.github', 'workflows', 'deploy.yml');
      const existing = `name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
`;
      writeFileSync(existingPath, existing);

      await runInitCommand(root, { github: true, tsconfig: false });

      expect(existsSync(existingPath)).toBe(true);
      expect(readFileSync(existingPath, 'utf8')).toBe(existing);
      const workflows = readdirSync(join(root, '.github', 'workflows')).sort();
      expect(workflows).toEqual(['deploy.yml', 'void-deploy.yml']);
      const oidc = readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf8');
      expect(oidc).toContain('name: Deploy to Void');
      expect(oidc).toContain('npx void deploy --platform void --project "$VOID_PROJECT"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('configures an existing class-C framework without plain Vite package setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'existing-astro-app',
            private: true,
            dependencies: {
              astro: '^5.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts).toBeUndefined();
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies.vite).toBeUndefined();
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Add `voidPlugin()` to the Astro Vite plugins option'),
        'Manual Astro config step',
      );
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('vite: { plugins: [voidPlugin()] }'),
        'Manual Astro config step',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['peerDependencies', 'optionalDependencies'] as const)(
    'prints a Nuxt-specific manual config step and keeps void declared in %s',
    async (field) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-'));
      try {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify(
            {
              name: 'existing-nuxt-app',
              private: true,
              dependencies: { nuxt: '^4.0.0' },
              [field]: { void: '^0.6.0' },
            },
            null,
            2,
          ) + '\n',
        );
        mockSelect.mockResolvedValueOnce('none');
        mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

        await runInitCommand(root);

        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        expect(pkg[field].void).toBe('^0.6.0');
        expect(pkg.devDependencies?.void).toBeUndefined();
        expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
        expect(mockNote).toHaveBeenCalledWith(
          expect.stringContaining('Add `voidPlugin()` to the Nuxt Vite plugins option'),
          'Manual Nuxt config step',
        );
        expect(mockNote).toHaveBeenCalledWith(
          expect.stringContaining('export default defineNuxtConfig'),
          'Manual Nuxt config step',
        );
        // Without the preset Nuxt builds a Node server; without the dev config, dev has no env;
        // without the top-level alias, `nuxi typecheck` cannot find `@schema`.
        const nuxtNote = mockNote.mock.calls.find(
          ([, title]) => title === 'Manual Nuxt config step',
        );
        for (const line of [
          'import { resolve } from "node:path";',
          '  alias: {\n    "@schema": resolve(import.meta.dirname, "db/schema.ts"),\n  },\n  nitro: {',
          'preset: "cloudflare-module",',
          'modules: ["void/nitro"],',
          'cloudflare: { dev: { configPath: "./.void-wrangler.jsonc" } },',
        ]) {
          expect(nuxtNote?.[0]).toContain(line);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('prints an Analog-specific manual config step with the Nitro module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'existing-analog-app',
            private: true,
            devDependencies: { '@analogjs/platform': '^2.8.0' },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
      const analogNote = mockNote.mock.calls.find(
        ([, title]) => title === 'Manual Analog config step',
      );
      for (const line of [
        'Install `nitro-cloudflare-dev` as a dev dependency.',
        'preset: "cloudflare-module",',
        'modules: ["nitro-cloudflare-dev", "void/nitro"],',
        'cloudflareDev: { configPath: "./.void-wrangler.jsonc" },',
      ]) {
        expect(analogNote?.[0]).toContain(line);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds voidPlugin to an existing Vite plugins array without replacing scripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'vite-app',
            scripts: {
              dev: 'custom-dev',
              test: 'vitest',
            },
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
  ],
});
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.type).toBeUndefined();
      expect(pkg.scripts.dev).toBe('custom-dev');
      expect(pkg.scripts.build).toBe('vite build');
      expect(pkg.scripts.test).toBe('vitest');

      const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(viteConfig).toContain('import { voidPlugin } from "void";');
      expect(viteConfig).toContain(`plugins: [
    voidPlugin(),
    react(),`);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'npm',
        ['install'],
        expect.objectContaining({
          cwd: root,
          stdio: ['ignore', expect.any(Number), expect.any(Number)],
          shell: process.platform === 'win32',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('patches only the top-level Vite plugins array', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'nested-vite-plugins-app',
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
  plugins: [
    react(),
  ],
});
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(viteConfig).toContain(`rollupOptions: {
      plugins: [legacy()],
    },`);
      expect(viteConfig).toContain(`plugins: [
    voidPlugin(),
    react(),`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds a top-level Vite plugins property instead of patching nested plugin options', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'nested-vite-no-top-level-plugins-app',
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `import { defineConfig } from "vite";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
});
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(viteConfig).toContain(`export default defineConfig({
  plugins: [voidPlugin()],
  build: {`);
      expect(viteConfig).toContain(`rollupOptions: {
      plugins: [legacy()],
    },`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a manual Vite config step when an existing config is too dynamic to patch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'dynamic-vite-app',
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `const config = buildConfig();

export default config;
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toBe(`const config = buildConfig();

export default config;
`);
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Could not safely update vite.config.ts automatically'),
        'Manual Vite config step',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not patch nested plugin arrays when the top-level Vite config object is dynamic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'dynamic-nested-vite-app',
            devDependencies: {
              vite: '^8.0.10',
              void: '^0.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'vite.config.ts'),
        `const config = {
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
};

export default config;
`,
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toBe(`const config = {
  build: {
    rollupOptions: {
      plugins: [legacy()],
    },
  },
};

export default config;
`);
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Add `voidPlugin()` to the top-level Vite plugins array'),
        'Manual Vite config step',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not run existing-project setup for targeted init flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'targeted-app' }, null, 2) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts).toBeUndefined();
      expect(pkg.devDependencies).toBeUndefined();
      expect(existsSync(join(root, 'vite.config.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('coding agent setup', () => {
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    let previousCI: string | undefined;

    beforeEach(() => {
      previousCI = process.env.CI;
      delete process.env.CI;
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => true });
    });

    afterEach(() => {
      if (previousCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCI;
      }
      if (ttyDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      }
    });

    it('creates minimal AGENTS.md for a new project without prompting or agent detection', async () => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-'));
      try {
        await runInitCommand(root, { tsconfig: true, github: false });

        const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8');
        expect(instructions).toContain('## Void');
        expect(instructions).toContain('node_modules/void/docs/');
        expect(instructions.match(/^- /gm)).toHaveLength(2);
        expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
        expect(mockSelect).not.toHaveBeenCalled();
        expect(mockConfirm).not.toHaveBeenCalled();

        await runInitCommand(root, { tsconfig: true, github: false });
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(instructions);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.each([false, true])(
      'writes AGENTS.md and preserves CLAUDE.md when Claude is detected (existing AGENTS.md: %s)',
      async (hasAgentsFile) => {
        // Resolve macOS's /var alias so relative skill symlinks use the fixture's real path.
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'void-init-')));
        try {
          const claudeInstructions = '# Claude instructions\n\nKeep these instructions.\n';
          const projectInstructions = '# Project instructions\n\nKeep this guidance.\n';
          writeFileSync(join(root, 'CLAUDE.md'), claudeInstructions);
          mkdirSync(join(root, '.claude'));
          mkdirSync(join(root, 'src'));
          if (hasAgentsFile) {
            writeFileSync(join(root, 'AGENTS.md'), projectInstructions);
          }
          mockConfirm.mockResolvedValueOnce(true);

          await runInitCommand(root, { tsconfig: true, github: false });

          const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8');
          expect(instructions).toContain('## Void');
          if (hasAgentsFile) {
            expect(instructions.startsWith(projectInstructions)).toBe(true);
          }
          expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(claudeInstructions);
          expect(existsSync(join(root, '.claude/skills/void/SKILL.md'))).toBe(true);
          expect(mockSelect).not.toHaveBeenCalled();
          expect(mockConfirm).toHaveBeenCalledExactlyOnceWith({
            message: hasAgentsFile
              ? 'Append Void instructions to AGENTS.md?'
              : 'Create AGENTS.md with Void instructions?',
            initialValue: true,
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each(['prerelease', 'current'])(
      'updates %s agent instructions only after approval',
      async (versionKind) => {
        const root = mkdtempSync(join(tmpdir(), 'void-init-'));
        try {
          const currentVersion = JSON.parse(
            readFileSync(join(process.cwd(), 'packages/void/package.json'), 'utf8'),
          ).version;
          const before = '# Project guidance\n\nKeep this user-authored introduction.\n\n';
          const after = '\n\nKeep this user-authored footer.\n';
          const oldVersion = versionKind === 'current' ? currentVersion : '1.2.3-beta.2+build.7';
          writeFileSync(
            join(root, 'AGENTS.md'),
            `${before}<!--injected-by-void-v${oldVersion}-->\nStale managed instructions.\n<!--/injected-by-void-->${after}`,
          );
          mockConfirm.mockResolvedValueOnce(true);

          await runInitCommand(root, { tsconfig: true, github: false });

          const updated = readFileSync(join(root, 'AGENTS.md'), 'utf8');
          expect(updated.startsWith(before)).toBe(true);
          expect(updated.endsWith(after)).toBe(true);
          expect(updated).toContain(`<!--injected-by-void-v${currentVersion}-->`);
          expect(updated).not.toContain('1.2.3-beta.2+build.7');
          expect(updated).not.toContain('Stale managed instructions.');
          expect(updated).toContain('node_modules/void/docs/');
          expect(updated.match(/<!--injected-by-void-v/g)).toHaveLength(1);
          expect(updated.match(/<!--\/injected-by-void-->/g)).toHaveLength(1);
          expect(mockConfirm).toHaveBeenCalledExactlyOnceWith({
            message: 'Update Void instructions in AGENTS.md?',
            initialValue: true,
          });
          await runInitCommand(root, { tsconfig: true, github: false });
          expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(updated);
          expect(mockConfirm).toHaveBeenCalledTimes(1);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each([false, true])(
      'preserves existing project instructions when declined (AGENTS.md: %s)',
      async (hasInstructions) => {
        const root = mkdtempSync(join(tmpdir(), 'void-init-agents-decline-'));
        const original = '# My project\n\nKeep this unchanged.\n';
        try {
          mkdirSync(join(root, 'src'));
          if (hasInstructions) {
            writeFileSync(join(root, 'AGENTS.md'), original);
          }
          mockConfirm.mockResolvedValueOnce(false);
          await runInitCommand(root, { tsconfig: true, github: false });
          expect(mockConfirm).toHaveBeenCalledTimes(1);
          if (hasInstructions) {
            expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
          } else {
            expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each(['CI', 'non-TTY'])('does not change existing AGENTS.md in %s', async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-agents-headless-'));
      const original = '# Keep my instructions\n';
      try {
        writeFileSync(join(root, 'AGENTS.md'), original);
        if (mode === 'CI') {
          process.env.CI = 'true';
        } else {
          Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });
        }
        await runInitCommand(root, { tsconfig: true, github: false });
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
        expect(mockConfirm).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('cancels before appending instructions', async () => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-agents-cancel-'));
      const original = '# Keep my instructions\n';
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('Cancelled');
      });
      try {
        writeFileSync(join(root, 'AGENTS.md'), original);
        mockConfirm.mockResolvedValueOnce(Symbol.for('cancel'));
        await expect(runInitCommand(root, { tsconfig: true, github: false })).rejects.toThrow(
          'Cancelled',
        );
        expect(exit).toHaveBeenCalledWith(0);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(original);
      } finally {
        exit.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('creates .gitignore with Void defaults during targeted setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      await runInitCommand(root, { tsconfig: true, github: false });

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
      expect(gitignore).toContain('node_modules');
      expect(gitignore).toContain('.void');
      expect(gitignore).toContain('.wrangler');
      expect(gitignore).toContain('.env');
      expect(gitignore.split('\n')).toContain('.env.*');
      expect(gitignore.split('\n')).not.toContain('!.env.example');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends missing Void defaults to an existing .gitignore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(root, '.gitignore'), 'node_modules\ncustom-cache\n');

      await runInitCommand(root, { tsconfig: true, github: false });

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
      expect(gitignore).toContain('custom-cache');
      expect(gitignore).toContain('.void');
      expect(gitignore).toContain('.wrangler');
      expect(gitignore).toContain('.env');
      expect(gitignore.match(/^node_modules$/gm)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses tsconfig.json with JSONC comments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'tsconfig.json'),
        `{
  // This is a comment
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true
  }
}\n`,
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toBeDefined();
      expect(tsconfig.compilerOptions.types).toContain('void/env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges Void type files and path aliases into root-level tsconfig fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'main.ts'), 'export {};\n');
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: './tsconfig.base.json',
            compilerOptions: {
              paths: {
                '@/*': ['src/*'],
              },
            },
            files: ['src/main.ts'],
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toEqual(['./tsconfig.base.json', './.void/tsconfig.json']);
      expect(tsconfig.files).toEqual(['./src/main.ts', './.void/routes.d.ts']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '@/*': ['./src/*'],
        'void/routes': ['./.void/routes.d.ts'],
      });
      expect(tsconfig.compilerOptions.types).toContain('void/env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves directly extended tsconfig files and paths when adding Void config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      writeFileSync(join(root, 'base.d.ts'), 'declare const baseValue: string;\n');
      writeFileSync(
        join(root, 'tsconfig.base.json'),
        JSON.stringify(
          {
            compilerOptions: {
              paths: {
                '~/*': ['./src/*'],
              },
            },
            files: ['base.d.ts'],
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: ['./tsconfig.base.json'],
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toEqual(['./tsconfig.base.json', './.void/tsconfig.json']);
      expect(tsconfig.files).toEqual(['./base.d.ts', './.void/routes.d.ts']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '~/*': ['./src/*'],
        'void/routes': ['./.void/routes.d.ts'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes Void path aliases relative to an inherited baseUrl', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      const root = join(workspaceRoot, 'packages', 'app');
      mkdirSync(join(root, 'routes'), { recursive: true });
      writeFileSync(
        join(workspaceRoot, 'tsconfig.base.json'),
        JSON.stringify(
          {
            compilerOptions: {
              baseUrl: '.',
              paths: {
                '@shared/*': ['shared/*'],
              },
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: '../../tsconfig.base.json',
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toEqual(['../../tsconfig.base.json', './.void/tsconfig.json']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        '@shared/*': ['./shared/*'],
        'void/routes': ['./packages/app/.void/routes.d.ts'],
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('merges Void type files and paths into explicit empty tsconfig override fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      writeFileSync(join(root, 'base.d.ts'), 'declare const baseValue: string;\n');
      writeFileSync(
        join(root, 'tsconfig.base.json'),
        JSON.stringify(
          {
            compilerOptions: {
              paths: {
                '~/*': ['./src/*'],
              },
            },
            files: ['base.d.ts'],
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(
          {
            extends: './tsconfig.base.json',
            compilerOptions: {
              paths: {},
            },
            files: [],
            include: ['src', 'routes'],
          },
          null,
          2,
        ) + '\n',
      );

      await runInitCommand(root, { tsconfig: true, github: false });

      const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
      expect(tsconfig.extends).toEqual(['./tsconfig.base.json', './.void/tsconfig.json']);
      expect(tsconfig.files).toEqual(['./.void/routes.d.ts']);
      expect(tsconfig.compilerOptions.paths).toEqual({
        'void/routes': ['./.void/routes.d.ts'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the preinstalled adapter to scaffold an empty project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            private: true,
            devDependencies: {
              void: '^0.2.3',
              '@void/react': '^0.2.3',
              vite: '^8.0.10',
              'vite-plus': '^0.1.21',
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      mockSelect.mockResolvedValueOnce('vite-plus').mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts.dev).toBe('vp dev');
      expect(pkg.devDependencies['vite-plus']).toBe(
        SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'],
      );
      expect(pkg.devDependencies.vite).toBe(SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite);
      expect(pkg.devDependencies.void).toBe('^0.2.3');
      expect(pkg.devDependencies['@void/react']).toBe('^0.2.3');
      expect(pkg.devDependencies['oxc-transform-react']).toBe('>=0.152.0 <0.157.0');
      expectPnpmAllowBuilds(root);

      const reactViteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      expect(reactViteConfig).toContain('from "@void/react/plugin"');
      expect(reactViteConfig).toContain('voidReact({ react: { compiler: true } })');

      expect(mockSelect.mock.calls[0]?.[0].message).toBe('Choose a Pages scaffold toolchain:');
      expect(mockSelect.mock.calls[0]?.[0].initialValue).toBe('vite-plus');
      expect(mockSelect.mock.calls[1]?.[0].message).toBe('Choose a Pages starter:');
      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a Pages framework to scaffold:' }),
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'vp',
        ['install', '--no-frozen-lockfile'],
        expect.objectContaining({
          cwd: root,
          stdio: ['ignore', expect.any(Number), expect.any(Number)],
          shell: process.platform === 'win32',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves other void.json fields when switching from pg to sqlite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify(
          {
            database: 'pg',
            routing: {
              prerender: ['/'],
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('sqlite');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        routing: {
          prerender: ['/'],
        },
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps database.casing when switching from pg to sqlite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify({ database: { dialect: 'pg', casing: 'snake_case' } }, null, 2) + '\n',
      );
      mockSelect.mockResolvedValueOnce('sqlite');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        database: { casing: 'snake_case' },
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a pg database object with casing when choosing pg', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify({ database: { dialect: 'pg', casing: 'snake_case' } }, null, 2) + '\n',
      );
      mockSelect.mockResolvedValueOnce('postgresql');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(JSON.stringify(summaryMessages('✓'))).not.toContain('database:');
      expect(readConfig(root).database).toEqual({ dialect: 'pg', casing: 'snake_case' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the pg config when choosing no database yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'pg' }, null, 2) + '\n');
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes a casing-only database config when choosing no database yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify({ database: { casing: 'snake_case' } }, null, 2) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(readConfig(root)).toEqual({
        worker: {
          compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can log in and create a project during init', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('void')
        .mockResolvedValueOnce('github');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockText.mockResolvedValueOnce('my-live-app');
      mockCreateProject.mockResolvedValueOnce({ id: 'proj_live', slug: 'my-live-app' });

      await runInitCommand(root);

      expect(mockConfirm.mock.calls[1]?.[0]).toMatchObject({
        message: 'Log in now and link or create a Void project?',
      });
      expect(mockRunLogin).toHaveBeenCalledWith(
        'https://api.void.cloud',
        'github',
        expect.any(Function),
      );
      expect(mockSaveToken).toHaveBeenCalledWith('token_123', 'https://api.void.cloud');
      expect(mockListProjects).toHaveBeenCalledOnce();
      expect(mockCreateProject).toHaveBeenCalledWith('my-live-app');
      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf8'))).toEqual({
        applicationDomain: 'void.app',
        platform: 'void',
        platformUrl: 'https://api.void.cloud',
        proxyUrl: 'https://proxy.void.cloud',
        projectId: 'proj_live',
        slug: 'my-live-app',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs starter dependencies before optional project creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('void')
        .mockResolvedValueOnce('github');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockText.mockResolvedValueOnce('my-live-app');
      mockCreateProject.mockRejectedValueOnce(new Error('project create failed'));

      await expect(runInitCommand(root)).rejects.toThrow('project create failed');

      const installCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][0] === 'install',
      );
      expect(installCalls.length).toBeGreaterThan(0);

      const drizzleCalls = mockSpawnSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1][1] === 'generate',
      );
      expect(drizzleCalls.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can link an existing project during init without re-authenticating', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      mockGetToken.mockReturnValue('existing_token');
      mockListProjects.mockResolvedValueOnce([
        {
          id: 'proj_456',
          user_id: 'user_1',
          slug: 'existing-app',
          type: 'worker',
          created_at: '2026-03-27T00:00:00.000Z',
          custom_domain: null,
        },
      ]);
      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite')
        .mockResolvedValueOnce('void')
        .mockResolvedValueOnce('proj_456');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      await runInitCommand(root);

      expect(mockConfirm.mock.calls[1]?.[0]).toMatchObject({
        message: 'Link your Void project now?',
      });
      expect(mockConfirm.mock.calls[2]?.[0]).toMatchObject({
        message:
          'Linking to an existing project. Running `void deploy` will overwrite the current deployment of existing-app.void.app. Continue?',
      });
      expect(mockRunLogin).not.toHaveBeenCalled();
      expect(mockSaveToken).not.toHaveBeenCalled();
      expect(mockCreateProject).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf8'))).toEqual({
        applicationDomain: 'void.app',
        platform: 'void',
        platformUrl: 'https://api.void.cloud',
        proxyUrl: 'https://proxy.void.cloud',
        projectId: 'proj_456',
        slug: 'existing-app',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults deployment setup to Cloudflare, opens login, and offers its GitHub workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      selectCloudflareDuringInit();
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.whoami'
          ? { status: 1, stdout: '', stderr: 'Not authenticated' }
          : { status: 0, stdout: '', stderr: '' },
      );
      mockConfirm.mockImplementation((options: { message?: string }) => {
        if (
          options.message ===
          'Create .github/workflows/void-deploy.yml to deploy on pushes to main?'
        ) {
          return true;
        }
        return undefined;
      });

      await runInitCommand(root);

      const platformPrompt = mockSelect.mock.calls.find(
        ([options]) => options.message === 'Where should this project deploy?',
      )?.[0];
      expect(platformPrompt).toMatchObject({ initialValue: 'cloudflare' });
      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf8'))).toEqual({
        platform: 'cloudflare',
      });
      expect(JSON.parse(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf8'))).toEqual({
        compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        compatibility_flags: ['nodejs_als'],
      });
      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([
          JSON.stringify({
            type: 'auth.whoami',
            configPath: toSlash(join(root, '.void-wrangler.jsonc')),
          }),
        ]),
        expect.objectContaining({ cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }),
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([JSON.stringify({ type: 'auth.login' })]),
        expect.objectContaining({ cwd: root, stdio: ['inherit', 'inherit', 'inherit'] }),
      );
      expect(mockNote).toHaveBeenCalledWith(
        expect.stringContaining('Run `void connect --platform cloudflare`'),
        'Cloudflare deployment',
      );
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListProjects).not.toHaveBeenCalled();
      expect(readFileSync(join(root, '.github', 'workflows', 'void-deploy.yml'), 'utf8')).toContain(
        'void deploy --platform cloudflare',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores the only authenticated Cloudflare account and preserves Wrangler JSONC', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        '{\n  // Keep this comment.\n  "name": "existing-worker",\n  "vars": { "EXAMPLE": "yes" }\n}\n',
      );
      selectCloudflareDuringInit();
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.whoami'
          ? wranglerWhoamiResult([{ id: 'account-1', name: 'My account' }])
          : { status: 0, stdout: '', stderr: '' },
      );

      await runInitCommand(root);

      const wrangler = readFileSync(join(root, '.void-wrangler.jsonc'), 'utf8');
      expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
      expect(readConfig(root).cloudflare?.name).toBe('existing-worker');
      expect(wrangler).toContain('// Keep this comment.');
      expect(wrangler).toContain('"name": "existing-worker"');
      expect(wrangler).toContain('"EXAMPLE": "yes"');
      expect(wrangler).toContain('"compatibility_date":');
      expect(wrangler).toContain('"account_id": "account-1"');
      expect(mockSpawnSync).not.toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([JSON.stringify({ type: 'auth.login' })]),
        expect.anything(),
      );
      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a Cloudflare account:' }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('opens Cloudflare browser login, rereads accounts, and stores the selected account', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      selectCloudflareDuringInit('account-2');
      let whoamiCalls = 0;
      mockSpawnSync.mockImplementation((_command, args) => {
        if (cloudflareOperationType(args) === 'auth.whoami') {
          whoamiCalls++;
          return whoamiCalls === 1
            ? { status: 1, stdout: '', stderr: 'Not authenticated' }
            : wranglerWhoamiResult([
                { id: 'account-1', name: 'First account' },
                { id: 'account-2', name: 'Second account' },
              ]);
        }
        return { status: 0, stdout: '', stderr: '' };
      });

      await runInitCommand(root);

      expect(whoamiCalls).toBe(2);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([JSON.stringify({ type: 'auth.login' })]),
        expect.objectContaining({ cwd: root, stdio: ['inherit', 'inherit', 'inherit'] }),
      );
      const accountPrompt = mockSelect.mock.calls.find(
        ([options]) => options.message === 'Choose a Cloudflare account:',
      )?.[0];
      expect(accountPrompt).toMatchObject({ initialValue: 'account-1' });
      expect(accountPrompt?.options).toEqual([
        { value: 'account-1', label: 'First account', hint: 'account-1' },
        { value: 'account-2', label: 'Second account', hint: 'account-2' },
      ]);
      expect(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf8')).toContain(
        '"account_id": "account-2"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an existing valid Cloudflare account without asking again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        JSON.stringify(
          { compatibility_date: '2026-01-02', account_id: 'account-2', name: 'my-worker' },
          null,
          2,
        ) + '\n',
      );
      selectCloudflareDuringInit('account-1');
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.whoami'
          ? wranglerWhoamiResult([
              { id: 'account-1', name: 'First account' },
              { id: 'account-2', name: 'Second account' },
            ])
          : { status: 0, stdout: '', stderr: '' },
      );

      await runInitCommand(root);

      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Choose a Cloudflare account:' }),
      );
      expect(JSON.parse(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf8'))).toEqual({
        compatibility_date: '2026-01-02',
        account_id: 'account-2',
        name: 'my-worker',
        compatibility_flags: ['nodejs_als'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('continues without an account when Cloudflare sign-in fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingAstroProject(root);
      selectCloudflareDuringInit();
      mockSpawnSync.mockImplementation((_command, args) =>
        cloudflareOperationType(args) === 'auth.login'
          ? { status: 1, stdout: '', stderr: 'Login failed' }
          : cloudflareOperationType(args) === 'auth.whoami'
            ? { status: 1, stdout: '', stderr: 'Not authenticated' }
            : { status: 0, stdout: '', stderr: '' },
      );

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf8'))).toEqual({
        compatibility_date: LATEST_KNOWN_COMPAT_DATE,
        compatibility_flags: ['nodejs_als'],
      });
      expect(
        mockSpawnSync.mock.calls.filter(
          ([, args]) => cloudflareOperationType(args) === 'auth.whoami',
        ),
      ).toHaveLength(1);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Cloudflare browser sign-in did not complete. Run `void cloudflare login` to try again.',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists skipped deployment setup without prompting for Void setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          { name: 'existing-astro-app', private: true, dependencies: { astro: '^5.0.0' } },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('none');

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf8'))).toEqual({
        platform: 'none',
      });
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListProjects).not.toHaveBeenCalled();
      expect(existsSync(join(root, '.github', 'workflows', 'void-deploy.yml'))).toBe(false);
      expect(
        mockSpawnSync.mock.calls.some(([, args]) =>
          ['auth.whoami', 'auth.login'].includes(cloudflareOperationType(args) ?? ''),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults the database prompt to D1 when no database is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'my-app',
            devDependencies: {
              void: '^0.0.1',
              vite: '^8.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      );
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const databasePrompt = mockSelect.mock.calls[0]?.[0];
      expect(databasePrompt.message).toBe('Choose a database setup for this project:');
      expect(databasePrompt.initialValue).toBe('sqlite');
      expect(databasePrompt.options).toEqual([
        {
          value: 'sqlite',
          label: 'D1 (SQLite)',
          hint: 'Zero-config and fully managed by Void; best for prototyping and read-heavy apps.',
        },
        {
          value: 'postgresql',
          label: 'PostgreSQL',
          hint: 'Bring your own Postgres via Hyperdrive; best for write-heavy apps, complex queries, or existing infra.',
        },
        {
          value: 'mysql',
          label: 'MySQL',
          hint: 'Bring your own MySQL via Hyperdrive; ideal for existing MySQL infrastructure and compatible providers.',
        },
        {
          value: 'none',
          label: 'No Database Yet',
          hint: 'Skip database setup for now. You can add D1, PostgreSQL, or MySQL later as your app grows.',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips install after demo scaffold when node_modules/void is already populated (workspace subpackage)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      // Without a lockfile init falls back to npm, which rejects `workspace:` specs.
      writeExistingViteApp(root, { void: 'workspace:../packages/void' });
      writeInstalledVoid(root);

      await runInitWithDemo(root);

      expect(installCalls()).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the migration after scaffolding a demo with --no-install and existing dependencies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingViteApp(root, { void: '^0.0.1' });
      writeInstalledVoid(root);
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitCommand(root, parseInitArgs(['--no-install']));

      expect(drizzleGenerateCalls()).toHaveLength(0);
      expect(summaryMessages('→').join('\n')).toContain('db generate` to finish setup');
      expect(String(mockOutro.mock.calls.at(-1)?.[0])).toContain(
        'Follow the next steps to finish setup.',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips install after demo scaffold when void is hoisted at the workspace root (ancestor node_modules)', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeInstalledVoid(wsroot);
      const subpkgRoot = join(wsroot, 'subpkg');
      writeExistingViteApp(subpkgRoot, { void: 'workspace:../packages/void' });

      await runInitWithDemo(subpkgRoot);

      expect(installCalls()).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install after demo scaffold when void resolves from an ancestor but the child package.json was mutated', async () => {
    // The parent is not a workspace root, so the child's own lockfile must
    // pick up the `void` dependency that init adds.
    const parentRoot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeInstalledVoid(parentRoot);
      const childRoot = join(parentRoot, 'subpkg');
      writeExistingViteApp(childRoot);
      writeFileSync(join(childRoot, 'package-lock.json'), '{}\n');

      await runInitWithDemo(childRoot);

      expectVoidDeclared(childRoot);
      expect(installCalls().length).toBeGreaterThan(0);
      expect(workspaceNotes()).toHaveLength(0);
    } finally {
      rmSync(parentRoot, { recursive: true, force: true });
    }
  });

  it('skips install and starter migration in a fresh workspace subpackage', async () => {
    // Before the first workspace install, a leaf install rejects `workspace:`
    // specs and drizzle-kit cannot resolve `void/schema-d1`.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      const subpkgRoot = join(wsroot, 'packages', 'app');
      writeExistingViteApp(subpkgRoot, { void: 'workspace:*' });

      await runInitWithDemo(subpkgRoot);

      expect(installCalls()).toHaveLength(0);
      expect(drizzleGenerateCalls()).toHaveLength(0);
      expectVoidDeclared(subpkgRoot);
      const notes = workspaceNotes();
      expect(notes.length).toBeGreaterThan(0);
      const body = String(
        notes.find((call) => String(call[0]).includes('Scaffolded the starter demo'))?.[0] ?? '',
      );
      expect(body).toMatch(/Scaffolded the starter demo/);
      expect(body).toMatch(/void db generate/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it.each([
    { marker: 'npm', pattern: 'packages/*', subPath: 'packages/app', member: true },
    { marker: 'pnpm', pattern: './packages/*', subPath: 'packages/app', member: true },
    { marker: 'pnpm', pattern: 'packages/*-app', subPath: 'packages/my-app', member: true },
    { marker: 'pnpm', pattern: '{apps,packages}/*', subPath: 'packages/my-app', member: true },
    { marker: 'pnpm', pattern: '{apps,packages}/*', subPath: 'apps/my-app', member: true },
    { marker: 'npm', pattern: '{apps,packages}/*', subPath: 'apps/web', member: true },
    { marker: 'pnpm', pattern: 'packages/*', subPath: 'scratch/my-app', member: false },
    { marker: 'npm', pattern: 'packages/*', subPath: 'scratch/my-app', member: false },
    { marker: 'pnpm', pattern: 'packages/*-app', subPath: 'packages/other', member: false },
    { marker: 'pnpm', pattern: '{apps,packages}/*', subPath: 'other/my-app', member: false },
  ] as const)(
    'defers install and starter migration only for members ($marker `$pattern`, $subPath)',
    async ({ marker, pattern, subPath, member }) => {
      const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
      try {
        if (marker === 'pnpm') {
          writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), `packages:\n  - '${pattern}'\n`);
        } else {
          writeFileSync(
            join(wsroot, 'package.json'),
            JSON.stringify({ name: 'ws-root', private: true, workspaces: [pattern] }, null, 2) +
              '\n',
          );
        }
        const appRoot = join(wsroot, ...subPath.split('/'));
        writeExistingViteApp(appRoot, { void: member ? 'workspace:*' : '^0.0.1' });
        if (!member) {
          writeFileSync(join(appRoot, 'package-lock.json'), '{}\n');
        }

        await runInitWithDemo(appRoot);

        expect(installCalls().length > 0).toBe(!member);
        expect(drizzleGenerateCalls().length > 0).toBe(!member);
        expect(workspaceNotes().length > 0).toBe(member);
      } finally {
        rmSync(wsroot, { recursive: true, force: true });
      }
    },
  );

  it('emits a lockfile-sync note when init adds void to a workspace subpackage with void hoisted', async () => {
    // The workspace lockfile must pick up the new `void` entry before the next frozen install.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeInstalledVoid(wsroot);
      const subpkgRoot = join(wsroot, 'packages', 'my-app');
      writeExistingViteApp(subpkgRoot);

      await runInitWithDemo(subpkgRoot);

      expectVoidDeclared(subpkgRoot);
      expect(installCalls()).toHaveLength(0);
      expect(drizzleGenerateCalls()).toHaveLength(0);
      const notes = workspaceNotes();
      expect(notes.length).toBeGreaterThan(0);
      const body = String(notes[0][0]);
      expect(body).toMatch(/lockfile/);
      expect(body).toMatch(/void db generate/);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('runs install after demo scaffold when node_modules/void is missing (fresh clone)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingViteApp(root, { void: '^0.0.1' });
      writeFileSync(join(root, 'package-lock.json'), '{}\n');

      await runInitWithDemo(root);

      const installs = installCalls();
      expect(installs.length).toBeGreaterThan(0);
      expect(installs[0][0]).toBe('npm');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['postgresql', 'pg', 'void/schema-pg'],
    ['mysql', 'mysql', 'void/schema-mysql'],
  ] as const)(
    'scaffolds the demo for the chosen %s database',
    async (dialect, configValue, schemaModule) => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-'));
      try {
        writeExistingViteApp(root, { void: '^0.0.1' });
        mockSelect.mockResolvedValueOnce(dialect);
        mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        await runInitCommand(root);

        expect(readConfig(root).database).toBe(configValue);
        const schema = readFileSync(join(root, 'db', 'schema.ts'), 'utf8');
        expect(schema).toContain(`from "${schemaModule}"`);
        expect(schema).not.toContain('void/schema-d1');
        expect(drizzleGenerateCalls()).toHaveLength(1);
        const drizzleConfig = JSON.parse(
          readFileSync(join(root, '.void', 'drizzle.config.json'), 'utf8'),
        );
        expect(drizzleConfig.dialect).toBe(dialect);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['db/schema.ts', 'Project already has a database schema, skipping demo'],
    ['src/demo.ts', 'Project already has src/demo.ts, skipping demo'],
  ])('keeps an existing %s and skips the whole demo', async (existingFile, message) => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingViteApp(root, { void: '^0.0.1' });
      const authored = 'export const authored = "keep me";\n';
      mkdirSync(join(root, existingFile, '..'), { recursive: true });
      writeFileSync(join(root, existingFile), authored);
      mockConfirm.mockImplementation((options: { message?: string }) =>
        String(options.message).startsWith('Scaffold demo code?'),
      );

      await runInitCommand(root);

      expect(readFileSync(join(root, existingFile), 'utf8')).toBe(authored);
      expect(mockLogInfo).toHaveBeenCalledWith(message);
      const prompts = mockConfirm.mock.calls.map(([options]) => String(options?.message));
      expect(prompts.some((prompt) => prompt.startsWith('Scaffold demo code?'))).toBe(false);
      for (const demoFile of ['db/schema.ts', 'routes/api/posts.ts', 'src/demo.ts']) {
        if (demoFile !== existingFile) {
          expect(existsSync(join(root, demoFile))).toBe(false);
        }
      }
      expect(drizzleGenerateCalls()).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scaffolds every demo file in a project without a schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingViteApp(root, { void: '^0.0.1' });

      await runInitWithDemo(root);

      for (const demoFile of ['db/schema.ts', 'routes/api/posts.ts', 'src/demo.ts']) {
        expect(existsSync(join(root, demoFile))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs starter migration with injected PnP NODE_OPTIONS in a Yarn Berry PnP project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingViteApp(root, { void: '^0.0.1', packageManager: 'yarn@4.5.3' });
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');

      const savedNodeOptions = process.env.NODE_OPTIONS;
      delete process.env.NODE_OPTIONS;

      mockSpawnSuccess((cwd) => {
        writeFileSync(join(cwd, '.pnp.cjs'), '// pnp stub\n');
        mkdirSync(join(cwd, '.yarn'), { recursive: true });
        writeFileSync(join(cwd, '.yarn', 'install-state.gz'), '');
      });

      try {
        await runInitWithDemo(root);
      } finally {
        if (savedNodeOptions === undefined) {
          delete process.env.NODE_OPTIONS;
        } else {
          process.env.NODE_OPTIONS = savedNodeOptions;
        }
      }

      expect(existsSync(join(root, 'db', 'schema.ts'))).toBe(true);
      const installs = installCalls();
      expect(installs.length).toBeGreaterThan(0);
      expect(installs[0][0]).toBe('yarn');
      expect(existsSync(join(root, '.pnp.cjs'))).toBe(true);

      const drizzleCalls = drizzleGenerateCalls();
      expect(drizzleCalls.length).toBeGreaterThan(0);
      const spawnOptions = drizzleCalls[0][2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env).toBeDefined();
      expect(typeof spawnOptions.env!.NODE_OPTIONS).toBe('string');
      expect(spawnOptions.env!.NODE_OPTIONS).toContain('--require');
      expect(spawnOptions.env!.NODE_OPTIONS).toContain(
        JSON.stringify(toSlash(join(root, '.pnp.cjs'))),
      );
      expect(existsSync(join(root, 'db', 'migrations', '0000_generated.sql'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs starter migration in a Yarn 4 project with `.yarnrc.yml` but `nodeLinker: node-modules`', async () => {
    // `.yarnrc.yml` is not a PnP marker; only `.pnp.cjs` and `.pnp.loader.mjs` are.
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeExistingViteApp(root, { void: '^0.0.1', packageManager: 'yarn@4.5.3' });
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      writeFileSync(join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
      mockSpawnSuccess((cwd) => writeInstalledVoid(cwd));

      await runInitWithDemo(root);

      const installs = installCalls();
      expect(installs.length).toBeGreaterThan(0);
      expect(installs[0][0]).toBe('yarn');
      expect(existsSync(join(root, '.pnp.cjs'))).toBe(false);
      expect(drizzleGenerateCalls().length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'keeps the workspace Vite+ toolchain for a new member (catalog: %s)',
    async (catalog) => {
      const wsroot = mkdtempSync(join(tmpdir(), 'void-init-vp-workspace-'));
      try {
        const pair = {
          'vite-plus': catalog ? 'catalog:tools' : '1.6.0',
          vite: catalog ? 'catalog:' : 'npm:@voidzero-dev/vite-plus-core@1.6.0',
        };
        writeFileSync(
          join(wsroot, 'package.json'),
          JSON.stringify({ private: true, devDependencies: pair }),
        );
        writeFileSync(
          join(wsroot, 'pnpm-workspace.yaml'),
          'packages: [packages/*]\ncatalog: { vite: "npm:@voidzero-dev/vite-plus-core@1.6.0" }\n' +
            'catalogs: { tools: { vite-plus: "1.6.0" } }\noverrides: { "vite@*": "npm:@voidzero-dev/vite-plus-core@1.6.0" }\n',
        );
        const member = join(wsroot, 'packages/app');
        mkdirSync(member, { recursive: true });
        mockSelect
          .mockResolvedValueOnce('vite-plus')
          .mockResolvedValueOnce('react')
          .mockResolvedValueOnce('static');
        mockConfirm.mockResolvedValueOnce(false);
        await runInitCommand(member);
        expect(existsSync(join(member, 'pages/index.tsx'))).toBe(true);
        expect(
          JSON.parse(readFileSync(join(member, 'package.json'), 'utf8')).devDependencies,
        ).toMatchObject(pair);
        expect(readFileSync(join(wsroot, 'pnpm-workspace.yaml'), 'utf8')).toContain(
          '"vite@*": "npm:@voidzero-dev/vite-plus-core@1.6.0"',
        );
        expect(installCalls()).toHaveLength(0);
      } finally {
        rmSync(wsroot, { recursive: true, force: true });
      }
    },
  );

  it('void init in an empty pnpm workspace subpackage skips leaf install and starter migration', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf8'));
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies['@void/vue']).toBeDefined();
      expect(installCalls()).toHaveLength(0);
      expect(drizzleGenerateCalls()).toHaveLength(0);
      const notes = workspaceNotes();
      expect(notes.length).toBeGreaterThan(0);
      const body = String(notes[0][0]);
      expect(body).toMatch(/Scaffolded the Pages starter/);
      expect(body).toMatch(/void db generate/);
      expect(body).toContain(toSlash(wsroot));
      // The starter's own files stay hidden, but not the edit to the workspace root.
      expect(summaryMessages('✓')[0]).toEqual([
        'Created a Vue Pages starter with D1 (SQLite)',
        '~ ../../pnpm-workspace.yaml  approved builds',
      ]);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('omits the `void db generate` follow-up in the workspace skip note AND outro for static starter mode', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'static-starter');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('static');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const notes = workspaceNotes();
      expect(notes.length).toBeGreaterThan(0);
      const body = String(notes[0][0]);
      expect(body).not.toMatch(/void db generate/);
      expect(body).toMatch(/Run your workspace install/);

      const outroCalls = mockOutro.mock.calls;
      expect(outroCalls.length).toBeGreaterThan(0);
      const outroText = String(outroCalls.at(-1)![0]);
      expect(outroText).not.toMatch(/void db generate/);
      expect(outroText).toMatch(/Run your workspace install/);

      expect(drizzleGenerateCalls()).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  // GitHub reads workflows only from the repository root, even when a member
  // manages its own install.
  it.each(['member', 'local-lockfile', 'local-corepack-pin'] as const)(
    'skips GitHub Actions setup for `void init --github` in a workspace subpackage (%s)',
    async (shape) => {
      const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
      try {
        writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

        const subpkgRoot = join(wsroot, 'packages', `leaf-${shape}`);
        mkdirSync(subpkgRoot, { recursive: true });
        const pkgBody: Record<string, unknown> = {
          name: `leaf-${shape}-sub`,
          private: true,
          type: 'module',
        };
        if (shape === 'local-corepack-pin') {
          pkgBody.packageManager = 'bun@1.1.42';
        }
        writeFileSync(join(subpkgRoot, 'package.json'), JSON.stringify(pkgBody, null, 2) + '\n');
        if (shape === 'local-lockfile') {
          writeFileSync(join(subpkgRoot, 'bun.lock'), '');
        }

        await runInitCommand(subpkgRoot, { github: true, tsconfig: false });

        const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'void-deploy.yml');
        expect(existsSync(deployYmlPath)).toBe(false);
      } finally {
        rmSync(wsroot, { recursive: true, force: true });
      }
    },
  );

  it('runs install (does NOT take the workspace skip path) for a starter init when the subpackage has a local `packageManager: bun@…` Corepack pin', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'leaf-bun');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(
        join(subpkgRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'leaf-bun-sub',
            private: true,
            type: 'module',
            packageManager: 'bun@1.1.42',
          },
          null,
          2,
        ) + '\n',
      );

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const installs = installCalls();
      expect(installs.length).toBeGreaterThan(0);
      expect(installs[0][0]).toBe('vp');
      expect(
        JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf8')).packageManager,
      ).toBe('bun@1.1.42');
      expect(workspaceNotes()).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('honors a local `package-lock.json` veto for a yarn-leaf nested under a pnpm workspace', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'leaf-managed');
      mkdirSync(subpkgRoot, { recursive: true });
      writeFileSync(join(subpkgRoot, 'package-lock.json'), '{}\n');

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      expect(installCalls().length).toBeGreaterThan(0);
      expect(workspaceNotes()).toHaveLength(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('skips GitHub Actions setup when the workspace-subpackage skip path fires', async () => {
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

      const subpkgRoot = join(wsroot, 'packages', 'gha-skip');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await runInitCommand(subpkgRoot);

      const deployYmlPath = join(subpkgRoot, '.github', 'workflows', 'void-deploy.yml');
      expect(existsSync(deployYmlPath)).toBe(false);
      expect(workspaceNotes().length).toBeGreaterThan(0);
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('void init in an empty STANDALONE app (not a workspace subpackage) still runs install and starter migration', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      const appRoot = join(parent, 'my-app');
      mkdirSync(appRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('react')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(appRoot);

      expect(installCalls().length).toBeGreaterThan(0);
      expect(drizzleGenerateCalls().length).toBeGreaterThan(0);
      expect(workspaceNotes()).toHaveLength(0);
      expect(listMigrationSqlFiles(appRoot)).toEqual(['0000_generated.sql']);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps the pnpm build policy and Corepack pin at the root of a pnpm workspace', async () => {
    // The member has no lockfile or pin, so `detectProjectState` reports npm;
    // pnpm still installs it from the workspace root.
    const wsroot = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(wsroot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(
        join(wsroot, 'package.json'),
        JSON.stringify(
          { name: 'workspace-root', private: true, packageManager: 'pnpm@^12.4.1' },
          null,
          2,
        ) + '\n',
      );

      const subpkgRoot = join(wsroot, 'packages', 'my-new-app');
      mkdirSync(subpkgRoot, { recursive: true });

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(subpkgRoot);

      const pkg = JSON.parse(readFileSync(join(subpkgRoot, 'package.json'), 'utf8'));
      expectPnpmAllowBuilds(wsroot);
      expect(pkg.pnpm).toBeUndefined();
      expect(pkg.packageManager).toBeUndefined();
    } finally {
      rmSync(wsroot, { recursive: true, force: true });
    }
  });

  it('writes pnpm allowBuilds without adding a packageManager pin in a standalone pnpm project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-init-'));
    try {
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

      mockSelect
        .mockResolvedValueOnce('vite-plus')
        .mockResolvedValueOnce('vue')
        .mockResolvedValueOnce('sqlite');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expectPnpmAllowBuilds(root);
      expect(pkg.packageManager).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the existing pnpm build approvals when adding the Void defaults', async () => {
    const roots: Array<string> = [];
    const initWithWorkspaceYaml = async (yaml: string): Promise<string> => {
      const root = mkdtempSync(join(tmpdir(), 'void-init-'));
      roots.push(root);
      writeExistingViteApp(root);
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(root, 'pnpm-workspace.yaml'), yaml);
      mockSelect.mockResolvedValueOnce('none');
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
      await runInitCommand(root);
      return readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
    };
    try {
      expect(
        await initWithWorkspaceYaml(
          'allowBuilds:\n  "@parcel/watcher": true\n  better-sqlite3: true\nonlyBuiltDependencies:\n  - bcrypt\n',
        ),
      ).toBe(
        'allowBuilds:\n  "@parcel/watcher": true\n  better-sqlite3: true\n  bcrypt: true\n  esbuild: true\n  sharp: true\n  workerd: true\n',
      );
      expect(await initWithWorkspaceYaml('onlyBuiltDependencies:\n- bcrypt\n')).toBe(
        'allowBuilds:\n  bcrypt: true\n  better-sqlite3: false\n  esbuild: true\n  sharp: true\n  workerd: true\n',
      );

      const flow = 'allowBuilds: {"@parcel/watcher": true}\n';
      expect(await initWithWorkspaceYaml(flow)).toBe(flow);
      expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('esbuild: true'));
    } finally {
      for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe('detectProjectState', () => {
  // Without a lockfile, an npm fallback would reject `workspace:` specs or write the wrong lockfile.
  it('prefers package.json#packageManager when no lockfile is present (pnpm)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'pnpm@10.2.3' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('prefers package.json#packageManager when no lockfile is present (yarn berry pin)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });

  it('prefers package.json#packageManager when no lockfile is present (yarn classic pin)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@1.22.22' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });

  it('prefers a committed yarn.lock over a Corepack yarn field', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }, null, 2) + '\n',
      );
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });

  it('prefers package.json#packageManager when no lockfile is present (bun)', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'bun@1.1.0' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('bun');
    });
  });

  it('honors the Corepack integrity suffix on the packageManager field', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'pnpm@10.2.3+sha512.abcdef' }, null, 2) +
          '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('prefers a committed lockfile over the packageManager field', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }, null, 2) + '\n',
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('falls back to npm when neither lockfile nor packageManager field is present', () => {
    withTempDir((root) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }, null, 2) + '\n');
      expect(detectProjectState(root).packageManager).toBe('npm');
    });
  });

  it('ignores unrecognized packageManager names', () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', packageManager: 'cnpm@1.0.0' }, null, 2) + '\n',
      );
      expect(detectProjectState(root).packageManager).toBe('npm');
    });
  });

  it('treats pnpm-workspace.yaml as a pnpm signal when no lockfile is present', () => {
    withTempDir((root) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }, null, 2) + '\n');
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      expect(detectProjectState(root).packageManager).toBe('pnpm');
    });
  });

  it('prefers a committed yarn.lock over pnpm-workspace.yaml', () => {
    withTempDir((root) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }, null, 2) + '\n');
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      expect(detectProjectState(root).packageManager).toBe('yarn');
    });
  });
});

describe('generateStarterMigration', () => {
  // Partial drizzle-kit output would make the next journal coherence check refuse.
  function seedStarterSchema(root: string): void {
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(
      join(root, 'db', 'schema.ts'),
      'import { sqliteTable } from "void/schema-d1";\nexport const messages = sqliteTable("messages", {});\n',
    );
  }

  it('rolls back partial artifacts when drizzle-kit fails and migrations/ did not exist before', async () => {
    await withTempDirAsync(async (root) => {
      seedStarterSchema(root);
      mockSpawnSync.mockImplementationOnce((command, args, options) => {
        const cwd = drizzleGenerateCwd(command, args, options);
        if (cwd) {
          const migrationsDir = join(cwd, 'db', 'migrations');
          const metaDir = join(migrationsDir, 'meta');
          mkdirSync(metaDir, { recursive: true });
          writeFileSync(
            join(metaDir, '_journal.json'),
            '{"version":"7","dialect":"sqlite","entries":[',
          );
          writeFileSync(join(metaDir, '0000_snapshot.json'), '{"partial":true');
          writeFileSync(join(migrationsDir, '0000_generated.sql'), '-- partially written sql\n');
        }
        return {
          status: 1,
          stdout: '',
          stderr: 'drizzle-kit: simulated crash',
        };
      });

      await expect(generateStarterMigration(root, 'sqlite')).rejects.toThrow(
        /Failed to generate the initial database migration/,
      );

      expect(existsSync(join(root, 'db', 'migrations', 'meta', '_journal.json'))).toBe(false);
      expect(existsSync(join(root, 'db', 'migrations', 'meta', '0000_snapshot.json'))).toBe(false);
      if (existsSync(join(root, 'db', 'migrations', 'meta'))) {
        expect(readdirSync(join(root, 'db', 'migrations', 'meta'))).toEqual([]);
      }
      const sqlFiles = existsSync(join(root, 'db', 'migrations'))
        ? readdirSync(join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql'))
        : [];
      expect(sqlFiles).toEqual([]);
    });
  });

  it('restores the journal and keeps prior entries when drizzle-kit fails and a journal existed before', async () => {
    await withTempDirAsync(async (root) => {
      seedStarterSchema(root);
      const migrationsDir = join(root, 'db', 'migrations');
      const metaDir = join(migrationsDir, 'meta');
      mkdirSync(metaDir, { recursive: true });

      const originalJournal =
        JSON.stringify(
          {
            version: '7',
            dialect: 'sqlite',
            entries: [{ idx: 0, version: '6', when: 0, tag: '0000_prev', breakpoints: true }],
          },
          null,
          2,
        ) + '\n';
      writeFileSync(join(metaDir, '_journal.json'), originalJournal);
      writeFileSync(
        join(metaDir, '0000_snapshot.json'),
        JSON.stringify({ version: '6', dialect: 'sqlite' }, null, 2) + '\n',
      );
      writeFileSync(
        join(migrationsDir, '0000_prev.sql'),
        'CREATE TABLE existing (id INTEGER PRIMARY KEY);\n',
      );

      mockSpawnSync.mockImplementationOnce((command, args, options) => {
        const cwd = drizzleGenerateCwd(command, args, options);
        if (cwd) {
          const cwdMigrationsDir = join(cwd, 'db', 'migrations');
          const cwdMetaDir = join(cwdMigrationsDir, 'meta');
          writeFileSync(join(cwdMetaDir, '_journal.json'), '{"truncated":true');
          writeFileSync(join(cwdMetaDir, '0001_snapshot.json'), '{"new":"partial"');
          writeFileSync(join(cwdMigrationsDir, '0001_new.sql'), '-- half-written new migration\n');
        }
        return {
          status: 1,
          stdout: '',
          stderr: 'drizzle-kit: simulated crash',
        };
      });

      await expect(generateStarterMigration(root, 'sqlite')).rejects.toThrow(
        /Failed to generate the initial database migration/,
      );

      expect(readFileSync(join(metaDir, '_journal.json'), 'utf8')).toBe(originalJournal);
      expect(existsSync(join(metaDir, '0000_snapshot.json'))).toBe(true);
      expect(existsSync(join(migrationsDir, '0000_prev.sql'))).toBe(true);
      expect(existsSync(join(metaDir, '0001_snapshot.json'))).toBe(false);
      expect(existsSync(join(migrationsDir, '0001_new.sql'))).toBe(false);
    });
  });

  // cmd.exe would split `C:\Program Files\nodejs\node.exe` and paths with spaces.
  it('runs drizzle-kit and the Yarn PnP probe without a shell on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await withTempDirAsync(async (root) => {
        seedStarterSchema(root);
        writeFileSync(join(root, '.pnp.cjs'), '// pnp stub\n');
        mkdirSync(join(root, '.yarn'), { recursive: true });
        writeFileSync(join(root, '.yarn', 'install-state.gz'), '');
        mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

        await generateStarterMigration(root, 'sqlite');
        expect(isVoidResolvableFrom(root)).toBe(true);

        const nodeSpawns = mockSpawnSync.mock.calls.filter(
          ([command]) => command === process.execPath,
        );
        expect(nodeSpawns.map(([, , options]) => Boolean(options.shell))).toEqual([false, false]);
      });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
