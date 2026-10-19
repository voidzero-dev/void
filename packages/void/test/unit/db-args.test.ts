import { describe, expect, it } from 'vite-plus/test';
import { parseDbArgs } from '../../src/cli/db-args.ts';

describe('parseDbArgs', () => {
  it('parses status', () => {
    expect(parseDbArgs(['status'])).toEqual({ action: 'status' });
  });

  it('parses reset', () => {
    expect(parseDbArgs(['reset'])).toEqual({ action: 'reset' });
  });

  it('parses seed', () => {
    expect(parseDbArgs(['seed'])).toEqual({ action: 'seed', file: undefined });
  });

  it('parses seed with --file', () => {
    expect(parseDbArgs(['seed', '--file', 'custom.sql'])).toEqual({
      action: 'seed',
      file: 'custom.sql',
    });
  });

  it('parses --yes for reset and seed', () => {
    expect(parseDbArgs(['reset', '--yes'])).toEqual({ action: 'reset', yes: true });
    expect(parseDbArgs(['seed', '--yes'])).toEqual({ action: 'seed', yes: true });
  });

  it('parses execute with inline SQL', () => {
    expect(parseDbArgs(['execute', 'SELECT * FROM users'])).toEqual({
      action: 'execute',
      command: 'SELECT * FROM users',
      file: undefined,
      remote: undefined,
    });
  });

  it('parses execute with --file', () => {
    expect(parseDbArgs(['execute', '--file', 'query.sql'])).toEqual({
      action: 'execute',
      command: undefined,
      file: 'query.sql',
      remote: undefined,
    });
  });

  it('parses execute with --remote flag', () => {
    expect(parseDbArgs(['execute', 'SELECT 1', '--remote'])).toEqual({
      action: 'execute',
      command: 'SELECT 1',
      file: undefined,
      remote: true,
    });
  });

  it('errors on execute with no SQL and no --file', () => {
    expect(() => parseDbArgs(['execute'])).toThrow(
      'db: Usage: void db execute <sql> or void db execute --file <path>.',
    );
  });

  it('errors on execute with both SQL and --file', () => {
    expect(() => parseDbArgs(['execute', 'SELECT 1', '--file', 'query.sql'])).toThrow(
      'db: Provide either SQL inline or --file, not both.',
    );
  });

  it('parses migrate', () => {
    expect(parseDbArgs(['migrate'])).toEqual({ action: 'migrate' });
  });

  it('errors on migrate with extra positional', () => {
    expect(() => parseDbArgs(['migrate', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('parses push', () => {
    expect(parseDbArgs(['push'])).toEqual({ action: 'push' });
  });

  it('errors on push with extra positional', () => {
    expect(() => parseDbArgs(['push', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('parses generate', () => {
    expect(parseDbArgs(['generate'])).toEqual({ action: 'generate' });
  });

  it('errors on generate with extra positional', () => {
    expect(() => parseDbArgs(['generate', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('parses export with no flags', () => {
    expect(parseDbArgs(['export'])).toEqual({
      action: 'export',
      output: undefined,
      noData: undefined,
      noSchema: undefined,
      table: undefined,
    });
  });

  it('parses export with --no-schema', () => {
    expect(parseDbArgs(['export', '--no-schema'])).toEqual({
      action: 'export',
      output: undefined,
      noData: undefined,
      noSchema: true,
      table: undefined,
    });
  });

  it('parses export with all flags', () => {
    expect(
      parseDbArgs(['export', '--output', 'dump.sql', '--no-data', '--table', 'users']),
    ).toEqual({
      action: 'export',
      output: 'dump.sql',
      noData: true,
      noSchema: undefined,
      table: 'users',
    });
  });

  it('errors on export with extra positional', () => {
    expect(() => parseDbArgs(['export', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('errors on export with --remote (must not silently fall through to local export)', () => {
    expect(() => parseDbArgs(['export', '--remote'])).toThrow(
      'db: `void db export` reads only the local database; --remote is not supported.',
    );
  });

  it('rejects flags the action does not use', () => {
    expect(() => parseDbArgs(['reset', '--remote'])).toThrow(
      'db: `void db reset` does not support --remote.',
    );
    expect(() => parseDbArgs(['seed', '--remote'])).toThrow(
      'db: `void db seed` does not support --remote.',
    );
    expect(() => parseDbArgs(['push', '--remote'])).toThrow(
      'db: `void db push` does not support --remote.',
    );
    expect(() => parseDbArgs(['migrate', '--file', 'x.sql'])).toThrow(
      'db: `void db migrate` does not support --file.',
    );
    expect(() => parseDbArgs(['status', '--yes'])).toThrow(
      'db: `void db status` does not support --yes.',
    );
  });

  it('parses studio', () => {
    expect(parseDbArgs(['studio'])).toEqual({ action: 'studio', remote: undefined });
  });

  it('parses studio with --remote flag', () => {
    expect(parseDbArgs(['studio', '--remote'])).toEqual({ action: 'studio', remote: true });
  });

  it('errors on studio with extra positional', () => {
    expect(() => parseDbArgs(['studio', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });

  it('parses a direct database connection', () => {
    expect(parseDbArgs(['connect', 'postgresql://localhost/app', '--local-only'])).toEqual({
      action: 'connect',
      url: 'postgresql://localhost/app',
      provider: undefined,
      name: undefined,
      region: undefined,
      localOnly: true,
    });
  });

  it('parses provider provisioning options', () => {
    expect(
      parseDbArgs([
        'connect',
        '--provider',
        'neon',
        '--name',
        'my-app',
        '--region',
        'aws-us-east-1',
      ]),
    ).toEqual({
      action: 'connect',
      url: undefined,
      provider: 'neon',
      name: 'my-app',
      region: 'aws-us-east-1',
      localOnly: undefined,
    });
  });

  it('rejects a URL combined with a provider', () => {
    expect(() =>
      parseDbArgs(['connect', 'postgresql://localhost/app', '--provider', 'neon']),
    ).toThrow('Provide either a connection string or --provider');
  });

  it('parses restore to a bookmark or a timestamp', () => {
    expect(parseDbArgs(['restore', '--bookmark=00000085-0000024c', '--yes'])).toEqual({
      action: 'restore',
      target: { bookmark: '00000085-0000024c' },
      yes: true,
    });
    expect(parseDbArgs(['restore', '--timestamp', '2026-10-16T09:30:00+08:00'])).toEqual({
      action: 'restore',
      target: { timestamp: '2026-10-16T01:30:00.000Z' },
      yes: undefined,
    });
  });

  it.each([
    ['2024-02-29T23:59:59Z', '2024-02-29T23:59:59.000Z'],
    ['2026-10-16T09:30:00-05:30', '2026-10-16T15:00:00.000Z'],
    ['2026-01-01T00:30:00+01:00', '2025-12-31T23:30:00.000Z'],
    ['2026-10-16T09:30:00.5Z', '2026-10-16T09:30:00.500Z'],
    ['2026-10-16T09:30:00.123+08:00', '2026-10-16T01:30:00.123Z'],
  ])('reads the restore time %s as %s', (input, utc) => {
    expect(parseDbArgs(['restore', '--timestamp', input])).toMatchObject({
      target: { timestamp: utc },
    });
  });

  it('parses an explicit Cloudflare restore after a one-off deploy', () => {
    expect(
      parseDbArgs(['restore', '--platform', 'cloudflare', '--bookmark', '00000085-0000024c']),
    ).toMatchObject({ platform: 'cloudflare', target: { bookmark: '00000085-0000024c' } });
  });

  it.each([
    [[], 'void db restore --bookmark <bookmark> or'],
    [['--bookmark', 'b', '--timestamp', '2026-10-16T09:30:00Z'], 'void db restore --bookmark'],
    [['--timestamp', 'yesterday'], '--timestamp must be a valid ISO 8601 time'],
    [['--timestamp', '2026'], '--timestamp must be a valid ISO 8601 time'],
    [['--timestamp', '2026-10-16T09:30:00'], 'with Z or an offset'],
    [['--timestamp', '2026-02-30T09:30:00Z'], 'must be a valid ISO 8601 time'],
    [['--timestamp', '2026-10-16T24:00:00Z'], 'must be a valid ISO 8601 time'],
    // `new Date` would truncate this to .123, an earlier instant than the user wrote.
    [['--timestamp', '2026-10-16T09:30:00.123456Z'], 'at most millisecond precision'],
    [['--platform', 'void', '--bookmark', '00000085-0000024c'], "accepts only 'cloudflare'"],
    [['--bookmark=--dry-run'], '--bookmark must be a D1 restore point'],
    [['--bookmark', 'not-hex'], '--bookmark must be a D1 restore point'],
    [['--remote', '--bookmark', '00000085-0000024c'], 'does not support --remote'],
  ])('rejects restore %j', (args, message) => {
    expect(() => parseDbArgs(['restore', ...args])).toThrow(message);
  });

  it('errors on unknown subcommand', () => {
    expect(() => parseDbArgs(['unknown'])).toThrow(
      'db: Usage: void db <push|generate|status|reset|seed|execute|migrate|studio|export|connect|set-url|restore|rename-migrations>.',
    );
  });

  it('errors on extra positional', () => {
    expect(() => parseDbArgs(['status', 'extra'])).toThrow("db: Unexpected argument 'extra'.");
  });
});
