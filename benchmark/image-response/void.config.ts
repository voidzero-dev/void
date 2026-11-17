import { convertToWranglerConfig, InputConfigSchema } from '@cloudflare/config';
import { defineConfig, type VoidConfig } from 'void/config';
import cloudflare from './cloudflare.config.ts';

export default defineConfig({
  cloudflare: convertToWranglerConfig(
    InputConfigSchema.parse(cloudflare),
  ) as VoidConfig['cloudflare'],
});
