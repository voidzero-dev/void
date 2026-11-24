import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'void-perf-image-gen',
    compatibilityDate: '2026-11-10',
    compatibilityFlags: ['nodejs_als'],
    workersDev: true,
    previewUrls: false,
    env: { BROWSER: bindings.browser({ dev: { remote: true } }) },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 1 },
    },
    placement: { mode: 'off' },
  },
});
