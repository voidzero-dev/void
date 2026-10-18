import type { CloudflareCommandResult, CloudflareOperation } from '@void/deploy-cloudflare';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  log: { error: vi.fn(), info: vi.fn(), message: vi.fn(), step: vi.fn(), warn: vi.fn() },
}));

const { log } = await import('@voidzero-dev/vite-plus-prompts');
const { applyAndVerifyRemoteD1Migrations } = await import('../../src/cli/deploy-migrations.ts');

const bookmark = '00000085-0000024c-00004ef2-0a83ea2fceebc654de0640c422be4653';
const clean = { status: 0, stdout: '', stderr: '' };

type Answers = Partial<Record<CloudflareOperation['type'], Array<CloudflareCommandResult>>>;

function recordingRunner(answers: Answers) {
  const calls: Array<CloudflareOperation['type']> = [];
  const run = (operation: CloudflareOperation): CloudflareCommandResult => {
    calls.push(operation.type);
    return answers[operation.type]?.shift() ?? clean;
  };
  return { calls, run };
}

const pending = (names: Array<string>) => ({ ...clean, data: { pending: names } });

function errorText(): string {
  return vi
    .mocked(log.error)
    .mock.calls.map(([message]) => String(message))
    .join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the D1 restore point a deploy takes before migrating', () => {
  it('saves a restore point before applying pending migrations, and names how to restore it', async () => {
    const runner = recordingRunner({
      'd1.migrations.list': [
        pending(['0001_add_column.sql']),
        pending(['0001_add_column.sql']),
        pending([]),
      ],
      'd1.time-travel.bookmark': [{ ...clean, data: { bookmark } }],
    });

    const applied = await applyAndVerifyRemoteD1Migrations(
      'app-db',
      'wrangler.json',
      runner.run,
      () => true,
    );

    expect(applied).toEqual({ restoreCommand: `void db restore --bookmark=${bookmark}` });
    expect(runner.calls).toEqual([
      'd1.migrations.list',
      'd1.time-travel.bookmark',
      'd1.migrations.list',
      'd1.migrations.apply',
      'd1.migrations.list',
    ]);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining(`void db restore --bookmark=${bookmark}`),
    );
  });

  it.each([
    {
      status: 1,
      stdout: '',
      stderr: 'Time Travel is unavailable for this database.',
      data: { bookmark },
    },
    { ...clean, data: {} },
  ])('refuses to migrate when the restore point cannot be saved (%o)', async (answer) => {
    const runner = recordingRunner({
      'd1.migrations.list': [pending(['0001_add_column.sql'])],
      'd1.time-travel.bookmark': [answer],
    });

    const applied = await applyAndVerifyRemoteD1Migrations(
      'app-db',
      'wrangler.json',
      runner.run,
      () => true,
    );

    expect(applied).toBe(false);
    expect(runner.calls).toEqual(['d1.migrations.list', 'd1.time-travel.bookmark']);
    expect(errorText()).toContain('Refusing to migrate without a restore point');
    if (answer.stderr) {
      expect(errorText()).toContain(`Cloudflare: ${answer.stderr}`);
    } else {
      expect(errorText()).not.toContain('\nCloudflare:');
    }
    expect(vi.mocked(log.info)).not.toHaveBeenCalled();
  });

  it.each([
    { status: 1, stdout: '', stderr: 'Authentication error', data: { pending: [] } },
    { ...clean, data: {} },
  ])('refuses to migrate when the pending list cannot be read (%o)', async (answer) => {
    const runner = recordingRunner({ 'd1.migrations.list': [answer] });

    const applied = await applyAndVerifyRemoteD1Migrations(
      'app-db',
      'wrangler.json',
      runner.run,
      () => true,
    );

    expect(applied).toBe(false);
    expect(runner.calls).toEqual(['d1.migrations.list']);
    expect(errorText()).toContain(answer.status ? 'exit 1' : 'returned no pending migration list');
  });

  it('checks the uploader again after the restore point, before applying', async () => {
    const runner = recordingRunner({
      'd1.migrations.list': [pending(['0001_add_column.sql']), pending(['0001_add_column.sql'])],
      'd1.time-travel.bookmark': [{ ...clean, data: { bookmark } }],
    });
    const stillPinned = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

    const applied = await applyAndVerifyRemoteD1Migrations(
      'app-db',
      'wrangler.json',
      runner.run,
      stillPinned,
    );

    expect(applied).toBe(false);
    expect(runner.calls).toEqual([
      'd1.migrations.list',
      'd1.time-travel.bookmark',
      'd1.migrations.list',
    ]);
  });

  it.each([
    { name: 'the apply fails', apply: { status: 1, stdout: '', stderr: '' } },
    { name: 'the check cannot run', verify: { status: 1, stdout: '', stderr: '' } },
    { name: 'migrations are still pending', verify: pending(['0001_add_column.sql']) },
    { name: 'the check returns no list', verify: { ...clean, data: {} } },
    { name: 'the uploader changed after the apply', pinnedChecks: 2 },
  ])('repeats the restore command when $name', async ({ apply, verify, pinnedChecks }) => {
    const runner = recordingRunner({
      'd1.migrations.list': [
        pending(['0001_add_column.sql']),
        pending(['0001_add_column.sql']),
        verify ?? pending([]),
      ],
      'd1.time-travel.bookmark': [{ ...clean, data: { bookmark } }],
      'd1.migrations.apply': [apply ?? clean],
    });
    let checks = 0;

    const applied = await applyAndVerifyRemoteD1Migrations(
      'app-db',
      'wrangler.json',
      runner.run,
      () => pinnedChecks === undefined || checks++ < pinnedChecks,
    );

    expect(applied).toBe(false);
    expect(errorText()).toContain(`void db restore --bookmark=${bookmark}`);
  });

  it('names the platform in the restore command after a one-off Cloudflare deploy', async () => {
    const runner = recordingRunner({
      'd1.migrations.list': [
        pending(['0001_add_column.sql']),
        pending(['0001_add_column.sql']),
        pending([]),
      ],
      'd1.time-travel.bookmark': [{ ...clean, data: { bookmark } }],
    });

    await applyAndVerifyRemoteD1Migrations('app-db', 'wrangler.json', runner.run, () => true, true);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining(`void db restore --platform cloudflare --bookmark=${bookmark}`),
    );
  });

  it('names only the migrations still pending after the restore point', async () => {
    // An overlapping deploy applied 0001 between the first read and the bookmark.
    const runner = recordingRunner({
      'd1.migrations.list': [
        pending(['0001_add_column.sql', '0002_add_index.sql']),
        pending(['0002_add_index.sql']),
        pending([]),
      ],
      'd1.time-travel.bookmark': [{ ...clean, data: { bookmark } }],
    });

    await applyAndVerifyRemoteD1Migrations('app-db', 'wrangler.json', runner.run, () => true);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining('Saved a D1 restore point before applying 1 migration.'),
    );
  });

  it('offers no restore point when an overlapping deploy applied every pending migration', async () => {
    const runner = recordingRunner({
      'd1.migrations.list': [pending(['0001_add_column.sql']), pending([]), pending([])],
      'd1.time-travel.bookmark': [{ ...clean, data: { bookmark } }],
      'd1.migrations.apply': [{ status: 1, stdout: '', stderr: '' }],
    });

    const applied = await applyAndVerifyRemoteD1Migrations(
      'app-db',
      'wrangler.json',
      runner.run,
      () => true,
    );

    // The bookmark is later than those migrations, so restoring it would not undo them.
    expect(applied).toBe(false);
    expect(vi.mocked(log.info)).not.toHaveBeenCalled();
    expect(errorText()).not.toContain('void db restore');
  });

  it('refuses to migrate when the pending list cannot be read after the restore point', async () => {
    const runner = recordingRunner({
      'd1.migrations.list': [
        pending(['0001_add_column.sql']),
        { status: 1, stdout: '', stderr: 'Authentication error' },
      ],
      'd1.time-travel.bookmark': [{ ...clean, data: { bookmark } }],
    });

    const applied = await applyAndVerifyRemoteD1Migrations(
      'app-db',
      'wrangler.json',
      runner.run,
      () => true,
    );

    expect(applied).toBe(false);
    expect(runner.calls).not.toContain('d1.migrations.apply');
    expect(errorText()).toContain('Cloudflare: Authentication error');
  });

  it('saves no restore point when no migration is pending', async () => {
    const runner = recordingRunner({ 'd1.migrations.list': [pending([]), pending([])] });

    const applied = await applyAndVerifyRemoteD1Migrations(
      'app-db',
      'wrangler.json',
      runner.run,
      () => true,
    );

    expect(applied).toEqual({ restoreCommand: undefined });
    expect(runner.calls).not.toContain('d1.time-travel.bookmark');
  });
});
