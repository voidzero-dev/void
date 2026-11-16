import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  accountId: 'YOUR_ACCOUNT_ID',
  worker: {
    name: 'YOUR_WORKER_ID',
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
        name: 'YOUR_DATABASE_NAME',
        id: 'YOUR_DATABASE_ID',
      }),
    },
  },
});
