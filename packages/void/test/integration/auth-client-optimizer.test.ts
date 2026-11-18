import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vite-plus/test';
import { analyzeApplicationSync } from '../../src/application-analysis.ts';
import { readConfig } from '../../src/config.ts';
import { routingPlugin } from '../../src/plugin-routing.ts';

it.each([
  ['react', true, undefined],
  ['vue', true, undefined],
  ['svelte', true, undefined],
  ['solid', true, undefined],
  [undefined, true, undefined],
  ['react', false, undefined],
  ['react', true, 'better-auth'],
  ['react', true, 'better-auth/react'],
] as const)(
  'configures %s auth optimization before the first browser request (auth enabled: %s, excluded: %s)',
  async (framework, authEnabled, excluded) => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-optimizer-'));
    mkdirSync(join(root, 'routes'));
    writeFileSync(join(root, 'routes', 'health.ts'), 'export const GET = () => new Response();');
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          routingPlugin(root, {
            isAuthEnabled: () => authEnabled,
            getApplicationAnalysis: (environment) =>
              analyzeApplicationSync(root, { config: readConfig(root), environment }),
          }),
          ...(framework ? [{ name: `void-${framework}:pages` }] : []),
        ],
        optimizeDeps: { noDiscovery: true, exclude: excluded ? [excluded] : [] },
        server: { middlewareMode: true, ws: false, watch: null, preTransformRequests: false },
      });
      const specifier = `better-auth/${framework ?? 'client'}`;
      const client = server.environments.client;
      if (!authEnabled || excluded) {
        expect(client.config.optimizeDeps.include).not.toContain(specifier);
        return;
      }
      expect(client.config.optimizeDeps.include).toContain(specifier);
      expect(server.environments.ssr.config.optimizeDeps.include).not.toContain(specifier);
      const optimizer = client.depsOptimizer!;
      await optimizer.init();
      const dependency =
        optimizer.metadata.optimized[specifier] ?? optimizer.metadata.discovered[specifier];
      expect(dependency).toBeDefined();
      await dependency.processing;
      expect(optimizer.metadata.optimized).toHaveProperty(specifier);
      expect(existsSync(optimizer.metadata.optimized[specifier].file)).toBe(true);
    } finally {
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
