import { afterEach, describe, it } from 'vite-plus/test';
import { prerenderPlugin } from '../../src/plugin-prerender.ts';

describe('managed static prerender isolation', () => {
  const previousManagedBuild = process.env.VOID_DEPLOY_BUILD;

  afterEach(() => {
    if (previousManagedBuild === undefined) {
      delete process.env.VOID_DEPLOY_BUILD;
    } else {
      process.env.VOID_DEPLOY_BUILD = previousManagedBuild;
    }
  });

  it('defers prerender instead of running inside the Vite build child', async () => {
    process.env.VOID_DEPLOY_BUILD = '1';
    const plugin = prerenderPlugin('/path/that/must/not/be-read', { output: 'static' });
    const hook = plugin.buildApp;
    const handler = typeof hook === 'function' ? hook : hook?.handler;
    await handler!.call({} as never, {} as never);
  });
});
