import { describe, expect, it } from 'vite-plus/test';
import { createDeployIntent } from '../../src/index.ts';
import type { DeployManifest } from '../../src/index.ts';

describe('createDeployIntent', () => {
  it('interprets a full worker manifest without provider details', () => {
    const manifest: DeployManifest = {
      version: 3,
      type: 'void',
      auth: true,
      bindings: { d1: ['DB'], ai: true },
      migrations: { dialect: 'sqlite', pending: 2 },
      schedules: [{ name: 'cleanup', cron: '0 0 * * *' }],
      queues: [{ name: 'jobs', bindingName: 'QUEUE_JOBS' }],
      revalidate: 60,
      prerender: ['/'],
      live: {
        bindingName: 'LIVE',
        className: 'Live',
        storage: 'sqlite',
        classes: ['Live'],
      },
    };

    const intent = createDeployIntent(manifest);

    expect(intent.appType).toBe('void');
    expect(intent.hasWorker).toBe(true);
    expect(intent.manifest).toBe(manifest);
    expect(intent.features).toEqual({
      assets: false,
      auth: true,
      cron: true,
      queues: true,
      migrations: true,
      ai: true,
      durableObjects: true,
      webSockets: false,
      live: true,
      sandbox: false,
      isr: true,
      prerender: true,
    });
    expect(intent.resourcePlan.resources).toContainEqual({ type: 'd1', bindingName: 'DB' });
  });

  it('distinguishes static artifacts from worker artifacts', () => {
    const manifest: DeployManifest = {
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' },
    };

    expect(createDeployIntent(manifest)).toMatchObject({
      appType: 'spa',
      hasWorker: false,
      features: { assets: true },
    });
  });

  it('preserves the historical default app type', () => {
    expect(createDeployIntent({ version: 3, bindings: {} }).appType).toBe('void');
    expect(createDeployIntent({ version: 3, framework: 'astro', bindings: {} }).appType).toBe(
      'framework',
    );
  });
});
