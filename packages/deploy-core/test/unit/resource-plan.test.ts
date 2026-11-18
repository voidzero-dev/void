import { describe, expect, it } from 'vite-plus/test';
import { createDeployResourcePlan, type DeployManifest } from '../../src/index.ts';

describe('createDeployResourcePlan', () => {
  it.each([undefined, false, true])(
    'carries explicit D1 replication setting %s',
    (readReplication) => {
      const plan = createDeployResourcePlan({
        version: 3,
        bindings: { d1: ['APP_DB'] },
        database: { readReplication },
      });
      expect(plan.resources).toEqual([
        {
          type: 'd1',
          bindingName: 'APP_DB',
          ...(readReplication !== undefined && { readReplication }),
        },
      ]);
    },
  );
  it('normalizes provisionable manifest resources without provider details', () => {
    const manifest: DeployManifest = {
      version: 3,
      bindings: {
        d1: ['DB'],
        kv: ['KV', 'ISR_CACHE'],
        r2: ['STORAGE'],
        ai: true,
        hyperdrive: ['HYPERDRIVE'],
      },
      queues: [
        {
          name: 'emails',
          bindingName: 'QUEUE_EMAILS',
          maxBatchSize: 10,
          maxRetries: 3,
        },
      ],
    };

    expect(createDeployResourcePlan(manifest)).toEqual({
      resources: [
        { type: 'd1', bindingName: 'DB' },
        { type: 'kv', bindingName: 'KV' },
        { type: 'kv', bindingName: 'ISR_CACHE' },
        { type: 'r2', bindingName: 'STORAGE' },
        {
          type: 'queue',
          bindingName: 'QUEUE_EMAILS',
          resourceName: 'emails',
          consumer: manifest.queues![0],
        },
        { type: 'hyperdrive', bindingName: 'HYPERDRIVE' },
      ],
      runtime: {
        ai: true,
        schedules: [],
        websocket: null,
        sandbox: null,
        live: null,
      },
    });
  });

  it('returns an empty plan when no provisionable resources are requested', () => {
    const manifest: DeployManifest = { version: 3, bindings: { ai: true } };

    expect(createDeployResourcePlan(manifest)).toEqual({
      resources: [],
      runtime: {
        ai: true,
        schedules: [],
        websocket: null,
        sandbox: null,
        live: null,
      },
    });
  });

  it('preserves runtime feature intent without target-specific binding details', () => {
    const manifest: DeployManifest = {
      version: 3,
      bindings: {},
      schedules: [{ name: 'cleanup', cron: '0 0 * * *' }],
      websocket: { routes: [], classes: ['ChatRoom'] },
      sandbox: {
        bindingName: 'SANDBOX',
        className: 'Sandbox',
        containerName: 'sandbox',
        image: 'registry.example/sandbox:latest',
      },
      live: {
        bindingName: 'LIVE',
        className: 'Live',
        storage: 'sqlite',
        classes: ['Live'],
      },
    };

    expect(createDeployResourcePlan(manifest).runtime).toEqual({
      ai: false,
      schedules: manifest.schedules,
      websocket: manifest.websocket,
      sandbox: manifest.sandbox,
      live: manifest.live,
    });
  });
});
