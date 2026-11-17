import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { voidPlugin } from 'void';

export default {
  run: {
    tasks: {
      build: {
        command: 'vp build',
        dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies'] }],
      },
    },
  },
  plugins: [
    voidPlugin(),
    sveltekit({
      adapter: adapter({
        config: './.void-wrangler.jsonc',
        platformProxy: { configPath: './.void-wrangler.jsonc' },
      }),
    }),
  ],
};
