import { defineConfig } from 'void/config';

export default defineConfig({
  target: process.env.VOID_IMAGE_MEMORY_DEMO === '1' ? 'node' : 'cloudflare',
  head: {
    title: 'ImageResponse Playground',
    htmlAttrs: { lang: 'en' },
    meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  },
});
