import { existsSync, readFileSync } from 'node:fs';
import { convertToWranglerConfig, type ParsedInputConfig } from '@cloudflare/config';
import type { PluginConfig } from '@cloudflare/vite-plugin';
import { resolve, dirname, basename, join } from 'pathslash';
import { parse as parseToml } from 'smol-toml';
import { migrateBuiltWranglerConfig } from './cli/cf-config-migrate.ts';
import { readGeneratedWranglerConfigFile } from './cli/generated-wrangler-config.ts';

/** Void keeps its Wrangler-shaped public options independently of the upstream plugin. */
export type WorkerConfig = ReturnType<typeof convertToWranglerConfig>;

type AuxiliaryConfig =
  | Partial<WorkerConfig>
  | ((
      config: WorkerConfig,
      context: { entryWorkerConfig: WorkerConfig },
    ) => Partial<WorkerConfig> | void);
export type AuxiliaryWorkerConfig = (
  | { configPath: string; config?: AuxiliaryConfig }
  | { configPath?: string; config: AuxiliaryConfig }
) & {
  viteEnvironment?: PluginConfig['viteEnvironment'];
  devOnly?: boolean | (() => boolean);
};

/** Match the old plugin's patch semantics, including its array concatenation. */
export function mergeCloudflareConfig(patch: object, fallback: object): Record<string, unknown> {
  const result: Record<string, unknown> = { ...fallback };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const previous = (result as Record<string, unknown>)[key];
    result[key] =
      Array.isArray(value) && Array.isArray(previous)
        ? [...value, ...previous]
        : value &&
            previous &&
            typeof value === 'object' &&
            typeof previous === 'object' &&
            !Array.isArray(value) &&
            !Array.isArray(previous)
          ? mergeCloudflareConfig(
              value as Record<string, unknown>,
              previous as Record<string, unknown>,
            )
          : value;
  }
  return result;
}

/** Use Cloudflare's public migration API rather than maintaining a second binding translator. */
export function toNativeCloudflareConfig(raw: WorkerConfig, root: string): ParsedInputConfig {
  const packagePath = join(root, 'package.json');
  const packageName = existsSync(packagePath)
    ? JSON.parse(readFileSync(packagePath, 'utf8')).name
    : undefined;
  const name =
    String(packageName ?? basename(root))
      .replaceAll('_', '-')
      .replace(/[^a-z0-9- ]/g, '-')
      .replace(/^(-+)|(-+)$/g, '')
      .slice(0, 63) || 'my-worker';
  const { env, vars, ...base } = raw;
  const selected = process.env.CLOUDFLARE_ENV ? env?.[process.env.CLOUDFLARE_ENV] : undefined;
  const values = selected ? selected.vars : vars;
  // Wrangler environments are selected explicitly, independently of Vite's mode.
  // Give the codemod distinct mode names so `env.production` cannot accidentally
  // replace the top-level configuration during an ordinary production build.
  const environments =
    env &&
    Object.fromEntries(
      Object.entries(env).map(([name, { vars: _vars, ...config }]) => [
        `void-environment-${name}`,
        config,
      ]),
    );
  const config = migrateBuiltWranglerConfig(
    {
      name,
      compatibility_date: '2026-02-24',
      ...base,
      ...(environments && process.env.CLOUDFLARE_ENV ? { env: environments } : {}),
    },
    process.env.CLOUDFLARE_ENV
      ? `void-environment-${process.env.CLOUDFLARE_ENV}`
      : 'void-top-level',
  );
  if (!config.worker) {
    throw new Error('Void requires a Cloudflare Worker configuration.');
  }
  // The codemod uses disposable files. Keep all variable values, including
  // local development credentials, out of those files as well as the root config.
  for (const [name, value] of Object.entries(values ?? {})) {
    config.worker.env ??= {};
    config.worker.env[name] =
      typeof value === 'string' ? { type: 'text', value } : { type: 'json', value };
  }
  const main = selected?.main ?? raw.main;
  if (main) {
    config.worker.entrypoint = main.startsWith('virtual:') ? main : resolve(root, main);
  }
  return config;
}

export function nativeAuxiliaryWorkers(
  workers: Array<AuxiliaryWorkerConfig> | undefined,
  root: string,
): PluginConfig['auxiliaryWorkers'] {
  return workers?.map(({ configPath, config, ...options }) => ({
    ...options,
    config({ entryWorkerConfig }) {
      const path = configPath ? resolve(root, configPath) : undefined;
      const base = (
        path
          ? path.endsWith('.toml')
            ? parseToml(readFileSync(path, 'utf8'))
            : readGeneratedWranglerConfigFile(path)
          : {}
      ) as WorkerConfig;
      const patch =
        typeof config === 'function'
          ? config(base, {
              entryWorkerConfig: convertToWranglerConfig({
                worker: entryWorkerConfig,
                containers: [],
              }),
            })
          : config;
      const native = toNativeCloudflareConfig(
        mergeCloudflareConfig(patch ?? {}, base),
        path ? dirname(path) : root,
      );
      return native.worker!;
    },
  }));
}
