import { defineConfig } from 'void/config';

export default defineConfig({
  target: 'node',
  head: {
    title: 'HTTP Errors Example',
    htmlAttrs: { lang: 'en' },
    meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  },
});
