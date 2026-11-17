import { describe, expect, it } from 'vite-plus/test';
import { validateManifestShape, type DeployManifest } from '../../src/index.ts';

describe('queue concurrency', () => {
  it.each([undefined, 1, 2, 250])('accepts maxConcurrency = %s', (maxConcurrency) => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        queues: [{ name: 'jobs', bindingName: 'QUEUE_JOBS', maxConcurrency }],
      }),
    ).toBeNull();
  });

  it.each([0, -1, 251, 1.5, Infinity, NaN, '2', null])(
    'rejects invalid maxConcurrency = %s',
    (maxConcurrency) => {
      expect(
        validateManifestShape({
          version: 3,
          bindings: {},
          queues: [{ name: 'jobs', bindingName: 'QUEUE_JOBS', maxConcurrency }],
        }),
      ).toBe(
        'invalid manifest shape: queues entry maxConcurrency must be an integer between 1 and 250',
      );
    },
  );
});

describe('R2 location hints', () => {
  it('accepts custom Durable Objects alongside a location hint', () => {
    expect(
      validateManifestShape({
        version: 5,
        bindings: { r2: ['STORAGE'] },
        storage: { locationHint: 'apac' },
        durableObjects: {
          bindings: [
            { bindingName: 'WORKSPACE', className: 'WorkspaceDurableObject', storage: 'sqlite' },
          ],
        },
      }),
    ).toBeNull();
  });
  it.each(['apac', 'eeur', 'enam', 'weur', 'wnam', 'oc'])(
    'accepts %s in manifest v5',
    (locationHint) => {
      expect(
        validateManifestShape({
          version: 5,
          bindings: { r2: ['STORAGE'] },
          storage: { locationHint },
        }),
      ).toBeNull();
    },
  );
  it.each(['APAC', '', null, {}, true])('rejects invalid hint %j', (locationHint) => {
    expect(
      validateManifestShape({
        version: 5,
        bindings: { r2: ['STORAGE'] },
        storage: { locationHint },
      }),
    ).toContain('locationHint');
  });
  it('requires manifest v5 so older platforms cannot silently ignore the hint', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: { r2: ['STORAGE'] },
        storage: { locationHint: 'apac' },
      }),
    ).toContain('version 5');
  });
});

describe('migration execution mode', () => {
  it.each(['apply', 'skip', undefined])('accepts %s', (migrationMode) => {
    expect(validateManifestShape({ version: 3, bindings: {}, migrationMode })).toBeNull();
  });
  it.each([true, null, 'disabled', {}])('rejects %s', (migrationMode) => {
    expect(validateManifestShape({ version: 3, bindings: {}, migrationMode })).toContain(
      'migrationMode must be apply or skip',
    );
  });
});

describe('alwaysUseHttps', () => {
  it.each([true, false, undefined])('accepts %s', (alwaysUseHttps) => {
    expect(validateManifestShape({ version: 3, bindings: {}, alwaysUseHttps })).toBeNull();
  });
  it.each(['true', 1, null, {}])('rejects non-boolean %s', (alwaysUseHttps) => {
    expect(validateManifestShape({ version: 3, bindings: {}, alwaysUseHttps })).toContain(
      'alwaysUseHttps must be a boolean',
    );
  });
});

describe('custom Durable Object declarations', () => {
  const binding = {
    bindingName: 'WORKSPACE',
    className: 'WorkspaceDurableObject',
    storage: 'sqlite',
  };
  const manifest = (bindings: Array<unknown> = [binding]) => ({
    version: 4,
    bindings: {},
    durableObjects: { bindings },
  });
  it('accepts local SQLite classes and leaves ordinary apps on version 3', () => {
    expect(validateManifestShape(manifest())).toBeNull();
    expect(validateManifestShape({ version: 3, bindings: {} })).toBeNull();
    expect(validateManifestShape({ ...manifest(), version: 3 })).toContain('version 4');
  });
  it.each([
    { script_name: 'another-project' },
    { namespace_id: 'foreign' },
    { storage: 'legacy-kv' },
    { bindingName: '__VOID_PROXY' },
    { bindingName: 'ASSETS' },
    { className: 'Invalid-name' },
  ])('rejects unsafe binding fields %j', (fields) => {
    expect(validateManifestShape(manifest([{ ...binding, ...fields }]))).not.toBeNull();
  });
  it('rejects duplicate classes and binding collisions', () => {
    expect(validateManifestShape(manifest([binding, binding]))).toContain('unique');
    expect(validateManifestShape({ ...manifest(), bindings: { r2: ['WORKSPACE'] } })).toContain(
      'unique',
    );
    expect(validateManifestShape({ ...manifest(), vars: { WORKSPACE: 'value' } })).toContain(
      'unique',
    );
  });
});

function manifestWithMigration(migration: unknown): DeployManifest {
  return {
    version: 3,
    bindings: {},
    websocket: {
      routes: [],
      classes: ['Room'],
      migrations: [migration] as NonNullable<
        NonNullable<DeployManifest['websocket']>['migrations']
      >,
    },
  };
}

describe('WebSocket deployment manifest validation', () => {
  it('accepts legacy and SQLite Durable Object migration history', () => {
    expect(
      validateManifestShape(manifestWithMigration({ tag: 'ws-v1', newClasses: ['LegacyRoom'] })),
    ).toBeNull();
    expect(
      validateManifestShape(
        manifestWithMigration({
          tag: 'ws-v2',
          newSqliteClasses: ['Room'],
          deletedClasses: ['RetiredRoom'],
        }),
      ),
    ).toBeNull();
  });

  it('rejects malformed migration tags and class lists', () => {
    expect(validateManifestShape(manifestWithMigration({ tag: '' }))).toContain(
      'non-empty string tag',
    );
    expect(
      validateManifestShape(manifestWithMigration({ tag: 'ws-v1', newSqliteClasses: 'Room' })),
    ).toContain('newSqliteClasses must be an array of strings');
    expect(
      validateManifestShape(manifestWithMigration({ tag: 'ws-v1', deletedClasses: [1] })),
    ).toContain('deletedClasses must be an array of strings');
  });
});

describe('managed email protocol', () => {
  it('accepts version 1 and rejects unknown versions before deployment', () => {
    expect(validateManifestShape({ version: 3, bindings: {}, emailProtocolVersion: 1 })).toBeNull();
    for (const emailProtocolVersion of [0, 2, '1', null, {}]) {
      expect(validateManifestShape({ version: 3, bindings: {}, emailProtocolVersion })).toContain(
        'emailProtocolVersion must be 1',
      );
    }
  });
});

describe('cron expression cap', () => {
  const distinctCron = (i: number) => `${i % 60} ${Math.floor(i / 60)} * * *`;
  const withCrons = (crons: Array<string>) => ({
    version: 3,
    bindings: {},
    schedules: crons.map((cron, i) => ({ name: `job${i}`, cron })),
  });

  it('accepts 100 distinct expressions', () => {
    expect(
      validateManifestShape(withCrons(Array.from({ length: 100 }, (_, i) => distinctCron(i)))),
    ).toBeNull();
  });

  it('counts a shared expression once', () => {
    expect(
      validateManifestShape(withCrons(Array.from({ length: 500 }, (_, i) => distinctCron(i % 10)))),
    ).toBeNull();
  });

  it('rejects 101 distinct expressions', () => {
    const result = validateManifestShape(
      withCrons(Array.from({ length: 101 }, (_, i) => distinctCron(i))),
    );
    expect(result).toContain('101 distinct cron expressions');
    expect(result).toContain('100 per-project limit');
  });

  it('counts different spellings separately', () => {
    const crons = [
      ...Array.from({ length: 99 }, (_, i) => distinctCron(i)),
      '* * * * *',
      '*  * * * *',
    ];
    expect(validateManifestShape(withCrons(crons))).toContain('101 distinct');
  });

  it('accepts 1000 entries sharing one expression', () => {
    expect(
      validateManifestShape(withCrons(Array.from({ length: 1000 }, () => '* * * * *'))),
    ).toBeNull();
  });

  it('rejects 1001 entries sharing one expression', () => {
    const result = validateManifestShape(
      withCrons(Array.from({ length: 1001 }, () => '* * * * *')),
    );
    expect(result).toContain('1001 entries');
    expect(result).toContain('1000 per-project limit');
  });
});
