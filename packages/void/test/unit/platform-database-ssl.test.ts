import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { claimPlatformDatabase } from '../../src/cli/platform-installer-database.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  platformDatabaseClientUrl,
  readPlatformDatabaseLifecycleManifest,
} from '../../src/cli/platform-installer.ts';
import { resolvePlatformInstallDatabaseUrl } from '../../src/cli/platform-lifecycle.ts';

const mocks = vi.hoisted(() => ({ pool: vi.fn() }));
vi.mock('pg', () => ({ Pool: mocks.pool }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pool.mockImplementation(function () {
    return {
      connect: async () => {
        throw new Error('Stopped before network access.');
      },
      query: async () => {
        throw new Error('Stopped before network access.');
      },
      on: () => {},
      end: async () => {},
    };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('platform PostgreSQL SSL mode', () => {
  it.each(['postgres:', 'postgresql:'])(
    'makes require explicit for %s without losing connection options',
    (protocol) => {
      const original = `${protocol}//owner:p%40ss%2Bword@db.example.com:5432/platform?sslmode=require&channel_binding=require&application_name=Void%20Platform&sslrootcert=%2Ftmp%2Froot.pem`;
      const actual = new URL(platformDatabaseClientUrl(original));
      const expected = new URL(original);
      expect(actual.searchParams.get('sslmode')).toBe('verify-full');
      actual.searchParams.delete('sslmode');
      expected.searchParams.delete('sslmode');
      expect(actual.toString()).toBe(expected.toString());
    },
  );

  it.each([
    'postgresql://owner:pw@localhost/platform',
    ...['disable', 'prefer', 'verify-ca', 'verify-full', 'no-verify'].map(
      (mode) => `postgresql://owner:pw@db/platform?sslmode=${mode}`,
    ),
    'postgresql://owner:pw@db/platform?sslmode=require&uselibpqcompat=true',
    'postgresql://owner:pw@db/platform?sslmode=require&sslmode=disable',
    'https://db.example.com/?sslmode=require',
    'not a connection URL',
  ])('leaves other policies and inputs unchanged: %s', (url) => {
    expect(platformDatabaseClientUrl(url)).toBe(url);
  });

  it('uses the effective query values just like pg', () => {
    const result = new URL(
      platformDatabaseClientUrl(
        'postgresql://owner:pw@db/platform?sslmode=disable&sslmode=%72equire&uselibpqcompat=true&uselibpqcompat=false',
      ),
    );
    expect(result.searchParams.getAll('sslmode')).toEqual(['verify-full']);
    expect(result.searchParams.getAll('uselibpqcompat')).toEqual(['true', 'false']);
  });

  it('retains certificate and hostname verification without emitting the driver warning', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const { Client } = await vi.importActual<typeof import('pg')>('pg');
    // Constructing a real pg client parses SSL options, but does not open a connection.
    const client = new Client({
      connectionString: platformDatabaseClientUrl(
        'postgresql://owner:pw@db.example.com/platform?sslmode=require',
      ),
    });
    expect(client.ssl).toEqual({}); // Node TLS verification defaults remain enabled.
    expect(warning).not.toHaveBeenCalled();
  });

  it.each([
    ['verify-full', '?sslmode=verify-full&sslrootcert=system'],
    ['require', '?sslrootcert=system&sslmode=require'],
    ['no sslmode', '?sslrootcert=system'],
    ['libpq compatibility', '?sslmode=verify-full&sslrootcert=system&uselibpqcompat=true'],
    ['a repeated root certificate', '?sslrootcert=%2Ftmp%2Froot.pem&sslrootcert=system'],
  ])(
    'uses the system trust store with full verification for sslrootcert=system with %s',
    (_name, query) => {
      const original = `postgresql://owner:p%40ss@db.example.com:5432/postgres${query}&application_name=void`;
      const actual = new URL(platformDatabaseClientUrl(original));
      expect(actual.searchParams.getAll('sslrootcert')).toEqual([]);
      expect(actual.searchParams.getAll('sslmode')).toEqual(['verify-full']);
      const expected = new URL(original);
      for (const name of ['sslrootcert', 'sslmode']) {
        actual.searchParams.delete(name);
        expected.searchParams.delete(name);
      }
      expect(actual.toString()).toBe(expected.toString());
    },
  );

  it.each([
    'postgresql://owner:pw@db/platform?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Froot.pem',
    'postgresql://owner:pw@db/platform?sslmode=verify-full&sslrootcert=system&sslrootcert=%2Froot.pem',
    'postgresql://owner:pw@db/platform?sslmode=verify-full&sslrootcert=System',
  ])('leaves other root certificate settings unchanged: %s', (url) => {
    expect(platformDatabaseClientUrl(url)).toBe(url);
  });

  it.each([
    ['database claim', claimPlatformDatabase],
    ['lifecycle lock', acquirePlatformDatabaseLifecycleLock],
    ['checkpoint read', readPlatformDatabaseLifecycleManifest],
  ] as const)('normalizes only the %s client copy, not the saved URL', async (_name, operation) => {
    const original = 'postgresql://owner:pw@db.example.com/platform?sslmode=require';
    vi.stubEnv('DATABASE_URL', original);
    vi.stubEnv('VOID_PLATFORM_DATABASE_URL', '');
    const checkpoint = { databaseUrl: original, databaseClaimState: 'claimed' };
    const url = resolvePlatformInstallDatabaseUrl(checkpoint);
    await expect(operation(url, 'installation', 'nonce')).rejects.toThrow(
      'Stopped before network access.',
    );
    expect(mocks.pool).toHaveBeenCalledWith({
      connectionString: original.replace('sslmode=require', 'sslmode=verify-full'),
      max: 1,
    });
    expect(checkpoint.databaseUrl).toBe(original);
    expect(process.env.DATABASE_URL).toBe(original);
    expect(resolvePlatformInstallDatabaseUrl(checkpoint)).toBe(original);
  });
});
