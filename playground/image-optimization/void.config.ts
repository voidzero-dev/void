import { defineConfig } from 'void/config';
import { remoteImage } from './src/photos.ts';

export default defineConfig({
  head: {
    title: 'Image Optimization Playground',
    htmlAttrs: { lang: 'en' },
    meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  },
  images: {
    remotePatterns: [new URL(remoteImage)],
    qualities: [40, 75, 90],
    formats: ['image/avif', 'image/webp'],
  },
});
