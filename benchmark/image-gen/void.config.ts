import { convertToWranglerConfig, CloudflareConfigSchema } from '@cloudflare/config';
import { defineConfig, type VoidConfig } from 'void/config';
import cloudflare from './cloudflare.config.ts';

export default defineConfig({
  cloudflare: convertToWranglerConfig(
    CloudflareConfigSchema.parse(cloudflare),
  ) as VoidConfig['cloudflare'],
});
