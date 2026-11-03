import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { getRootConfigPath, getWorkerConfigPath } from '@cloudflare/build-output-utils';
import { dirname, join } from 'pathslash';
import type { Plugin } from 'vite';
import { writeFileAtomic } from './shared/atomic-write.ts';
import { loadLocalEnv } from './shared/env.ts';

/** Give preview local bindings without changing the deployable build or storing their values. */
export function withLocalPreviewBindings(plugins: Array<Plugin>, root: string): Array<Plugin> {
  let directory: string | undefined;
  const cleanup = () => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
    process.removeListener('exit', cleanup);
  };
  // Only the entry plugin reads Build Output during config resolution. Its other
  // hooks and the remaining plugins continue to see the application's real root.
  const entry = plugins.find((plugin) => plugin.name === 'vite-plugin-cloudflare');
  if (!entry?.config) {
    throw new Error('The Cloudflare plugin no longer exposes its configuration hook.');
  }
  const hook = typeof entry.config === 'function' ? entry.config : entry.config.handler;
  entry.config = async function (config, environment) {
    if (!environment.isPreview) {
      return hook.call(this, config, environment);
    }
    cleanup();
    const parent = join(root, '.void');
    mkdirSync(parent, { recursive: true });
    directory = mkdtempSync(join(parent, 'preview-'));
    process.once('exit', cleanup);
    try {
      const output = dirname(getRootConfigPath(root));
      cpSync(output, dirname(getRootConfigPath(directory)), { recursive: true });
      const path = getWorkerConfigPath(directory);
      const worker = JSON.parse(readFileSync(path, 'utf8'));
      worker.env ??= {};
      for (const name of Object.keys(loadLocalEnv(root))) {
        const binding = worker.env[name];
        if (!binding || ['text', 'json', 'secret'].includes(binding.type)) {
          worker.env[name] = { type: 'secret' };
        }
      }
      writeFileAtomic(path, JSON.stringify(worker));
      // The upstream preview resolves declared secrets from this env directory.
      // A private artifact copy isolates local-only declarations from deployment
      // and from other previews, including when the original build had no .env.
      return await hook.call(this, { ...config, root: directory, envDir: root }, environment);
    } catch (error) {
      cleanup();
      throw error;
    }
  };
  return [
    ...plugins,
    {
      name: 'void:cloudflare-preview-cleanup',
      configurePreviewServer(server) {
        server.httpServer.once('close', cleanup);
      },
    },
  ];
}
