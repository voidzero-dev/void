import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { hasDeploySchemaDrift } from '../../src/cli/deploy-drift.ts';
import { generateStarterMigration } from '../../src/cli/init.ts';
import { createPagesStarterTemplate, type ScaffoldStarterMode } from '../../src/cli/template.ts';

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(),
  isCI: () => false,
  settings: { accessible: false },
  select: vi.fn(),
  text: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
}));

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const tempDirs: Array<string> = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

// Each case runs real Drizzle Kit subprocesses for generation and drift checking.
// Windows CI needs more than the default five seconds to start both processes.
describe('starter migration generation', { timeout: 30_000 }, () => {
  it('creates a sqlite starter migration that deploy sees as drift-free', async () => {
    const root = createStarterApp('sqlite');

    await generateStarterMigration(root, 'sqlite');

    expect(readSqlMigrations(root)).toHaveLength(1);
    expect(existsSync(join(root, 'db', 'migrations', 'meta', '_journal.json'))).toBe(true);
    expect(hasDeploySchemaDrift(root, 'sqlite')).toBe(false);
  });

  it('creates a postgresql starter migration that deploy sees as drift-free', async () => {
    const root = createStarterApp('postgresql');

    await generateStarterMigration(root, 'postgresql');

    expect(readSqlMigrations(root)).toHaveLength(1);
    expect(existsSync(join(root, 'db', 'migrations', 'meta', '_journal.json'))).toBe(true);
    expect(hasDeploySchemaDrift(root, 'postgresql')).toBe(false);
  });
});

function createStarterApp(starterMode: Exclude<ScaffoldStarterMode, 'static'>): string {
  const root = mkdtempSync(
    packageFixturePath(join(packageRoot, 'test/unit'), '.tmp-init-starter-'),
  );
  tempDirs.push(root);

  const template = createPagesStarterTemplate({
    framework: 'react',
    starterMode,
    voidPackageSpec: 'workspace:*',
    adapterPackageSpec: 'workspace:*',
  });

  for (const [filePath, content] of Object.entries(template.files)) {
    const fullPath = join(root, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  const nodeModulesDir = join(root, 'node_modules');
  mkdirSync(nodeModulesDir, { recursive: true });
  symlinkSync(packageRoot, join(nodeModulesDir, 'void'), 'dir');

  return root;
}

function readSqlMigrations(root: string): Array<string> {
  const migrationsDir = join(root, 'db', 'migrations');
  if (!existsSync(migrationsDir)) {
    return [];
  }

  return readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
}
