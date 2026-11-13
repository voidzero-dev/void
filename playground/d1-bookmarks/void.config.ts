import { defineConfig } from 'void/config';
import cloudflare from './cloudflare.config.ts';

export default defineConfig({
  routing: { isr: false },
  cloudflare: {
    account_id: cloudflare.accountId,
    name: cloudflare.worker.name,
    compatibility_date: cloudflare.worker.compatibilityDate,
    compatibility_flags: cloudflare.worker.compatibilityFlags,
    workers_dev: cloudflare.worker.workersDev,
    placement: cloudflare.worker.placement,
    observability: {
      enabled: cloudflare.worker.observability.enabled,
      head_sampling_rate: cloudflare.worker.observability.headSamplingRate,
      logs: {
        enabled: cloudflare.worker.observability.logs.enabled,
        invocation_logs: cloudflare.worker.observability.logs.invocationLogs,
        persist: cloudflare.worker.observability.logs.persist,
      },
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: cloudflare.worker.env.DB.name,
        database_id: cloudflare.worker.env.DB.id,
        migrations_dir: 'db/migrations',
      },
    ],
  },
});
