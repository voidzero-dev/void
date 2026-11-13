import { defineConfig } from 'void/config';

export default defineConfig({
  auth: { providers: ['email'] },
  head: {
    title: 'Server Auth Errors Example',
    htmlAttrs: { lang: 'en' },
    meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  },
});
