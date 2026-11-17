import { defineConfig } from 'void/config';
import cloudflare from './cloudflare.config.ts';

export default defineConfig({
  cloudflare: {
    name: cloudflare.worker.name,
    compatibility_date: cloudflare.worker.compatibilityDate,
  },
});
