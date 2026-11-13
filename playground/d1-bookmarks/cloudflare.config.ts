import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  accountId: '194274c8e6a8b3c2546413f05e622f44',
  worker: {
    name: 'voidzero-void-d1-bookmarks',
    compatibilityDate: '2026-02-24',
    compatibilityFlags: ['nodejs_als'],
    entrypoint: './.void/entry.ts',
    workersDev: true,
    placement: { region: 'aws:ap-southeast-1' },
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: {
        enabled: true,
        invocationLogs: true,
        persist: true,
      },
    },
    env: {
      DB: bindings.d1({
        name: 'voidzero-void-d1-bookmarks-weur',
        id: 'f4a50d02-a225-47fe-8157-0622c0553fe9',
      }),
    },
  },
});
