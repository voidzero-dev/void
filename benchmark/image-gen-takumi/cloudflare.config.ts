import { defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'void-perf-image-gen-takumi',
    compatibilityDate: '2026-11-10',
    compatibilityFlags: ['nodejs_als'],
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 1 },
    },
    placement: { mode: 'off' },
  },
});
