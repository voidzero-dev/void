import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import {
  getRootConfigPath,
  getWorkerAssetsDir,
  readBuildOutput,
} from '@cloudflare/build-output-utils';
import { convertToWranglerConfig } from '@cloudflare/config';
import { cloudflare as cloudflareV2, type PluginConfig } from '@cloudflare/vite-plugin';
import { dirname, isAbsolute, join, relative, resolve } from 'pathslash';
import type { BuildEnvironment, Plugin } from 'vite';
import { readGeneratedWranglerConfigFile } from './cli/generated-wrangler-config.ts';
import {
  mergeCloudflareConfig,
  nativeAuxiliaryWorkers,
  toNativeCloudflareConfig,
  type AuxiliaryWorkerConfig,
  type WorkerConfig,
} from './plugin-cloudflare-config.ts';
import { withLocalPreviewBindings } from './plugin-cloudflare-preview.ts';
import { writeFileAtomic } from './shared/atomic-write.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from './shared/env.ts';

export type { WorkerConfig, AuxiliaryWorkerConfig } from './plugin-cloudflare-config.ts';

function isInside(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}

/** Keep Void's public configuration and artifact layout while running the v2 plugin. */
export function cloudflare(options: {
  configPath?: string;
  config: (resolved: WorkerConfig) => Partial<WorkerConfig>;
  auxiliaryWorkers?: Array<AuxiliaryWorkerConfig>;
  inspectorPort?: PluginConfig['inspectorPort'];
  persistState?: PluginConfig['persistState'];
  viteEnvironment: NonNullable<PluginConfig['viteEnvironment']>;
  finalizeAssets?: (clientDir: string, environment: BuildEnvironment | undefined) => void;
}): Array<Plugin> {
  const root = process.cwd();
  let workerConfig: WorkerConfig;
  let native: ReturnType<typeof toNativeCloudflareConfig>;
  let pluginNative: ReturnType<typeof toNativeCloudflareConfig>;
  const outputDirectories = new Map<string, string>();
  const bridge: Plugin = {
    name: 'void:cloudflare-config',
    config(_userConfig, environment) {
      if (environment.isPreview) {
        return;
      }
      let base = (
        options.configPath ? readGeneratedWranglerConfigFile(options.configPath) : {}
      ) as WorkerConfig;
      if (process.env.CLOUDFLARE_ENV && base.env) {
        const selected = base.env[process.env.CLOUDFLARE_ENV];
        if (!selected) {
          throw new Error(
            `Cloudflare environment ${process.env.CLOUDFLARE_ENV} is not configured.`,
          );
        }
        const original = base;
        base = convertToWranglerConfig(toNativeCloudflareConfig(base, root));
        base.main = selected.main ?? original.main;
        base.migrations = selected.migrations ?? original.migrations;
        base.assets = {
          ...base.assets,
          directory: selected.assets?.directory ?? original.assets?.directory,
        };
      }
      workerConfig = mergeCloudflareConfig(options.config(base), base);
      native = toNativeCloudflareConfig(workerConfig, root);
      pluginNative = structuredClone(native);
      if (environment.command === 'build' && native.containers.length > 0) {
        // Void builds images during deployment preparation. Managed builds consume
        // the Worker bundle and must not acquire a local Docker prerequisite.
        pluginNative.containers = [];
        for (const declaration of Object.values(pluginNative.worker?.exports ?? {})) {
          if ('container' in declaration) {
            delete declaration.container;
          }
        }
      }
    },
  };
  const directories: Plugin = {
    name: 'void:cloudflare-output-directories',
    enforce: 'post',
    config(userConfig) {
      const environmentNames = [
        options.viteEnvironment.name ?? 'ssr',
        ...(options.viteEnvironment.childEnvironments ?? []),
      ];
      for (const name of [...environmentNames, 'client']) {
        outputDirectories.set(
          name,
          resolve(
            root,
            userConfig.environments?.[name]?.build?.outDir ??
              join(userConfig.build?.outDir ?? 'dist', name),
          ),
        );
      }
    },
  };
  const output: Plugin = {
    name: 'void:cloudflare-build-output',
    enforce: 'post',
    writeBundle: {
      order: 'post',
      handler() {
        if (this.environment?.name !== 'client') {
          return;
        }
        // Frameworks such as React Router read the completed client manifest while
        // building their server, before the final Build Output hook runs.
        const source = resolve(root, this.environment.config.build.outDir);
        const destination = outputDirectories.get('client');
        if (destination && source !== destination && existsSync(source)) {
          mkdirSync(destination, { recursive: true });
          cpSync(source, destination, { recursive: true });
        }
      },
    },
    buildApp: {
      order: 'post',
      async handler(builder) {
        if (Object.values(native.worker?.env ?? {}).some((binding) => binding.type === 'assets')) {
          // API-only apps still expose ASSETS. Keep an empty asset service so
          // native preview can resolve that binding even without a client build.
          mkdirSync(getWorkerAssetsDir(root), { recursive: true });
        }
        const built = await readBuildOutput(root);
        const worker = built.workers.default;
        const environment = options.viteEnvironment.name ?? 'ssr';
        const destination = outputDirectories.get(environment)!;
        const client = outputDirectories.get('client')!;
        if (!worker.bundleDir || !worker.config.manifest) {
          throw new Error('Void requires a built Cloudflare Worker.');
        }
        for (const directory of [destination, client]) {
          // Match Vite's default cleanup for output inside the project. Never erase the
          // project itself, an external directory, or the native output being copied.
          if (
            directory !== root &&
            isInside(root, directory) &&
            !isInside(directory, worker.bundleDir)
          ) {
            rmSync(directory, { recursive: true, force: true });
          }
        }
        mkdirSync(destination, { recursive: true });
        cpSync(worker.bundleDir, destination, { recursive: true });
        if (worker.assetsDir) {
          mkdirSync(client, { recursive: true });
          cpSync(worker.assetsDir, client, { recursive: true });
        }
        const config: WorkerConfig = {
          ...workerConfig,
          name: worker.config.name,
          account_id: native.accountId,
          compatibility_date: worker.config.compatibilityDate,
          compatibility_flags: worker.config.compatibilityFlags,
          main: worker.config.manifest.mainModule,
          no_bundle: true,
          rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
          ...(process.env.CLOUDFLARE_ENV ? { targetEnvironment: process.env.CLOUDFLARE_ENV } : {}),
          ...(workerConfig.assets || worker.assetsDir
            ? { assets: { ...workerConfig.assets, directory: relative(destination, client) } }
            : {}),
        };
        delete config.env;
        writeFileAtomic(join(destination, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`);
        if (options.finalizeAssets) {
          options.finalizeAssets(client, builder.environments.client);
          const finalized: WorkerConfig = JSON.parse(
            readFileSync(join(destination, 'wrangler.json'), 'utf8'),
          );
          // Preview and prebuilt uploads must use the same asset routing and cache
          // headers as the validated dist output, including free static requests.
          if (worker.config.assets && finalized.assets) {
            worker.config.assets.runWorkerFirst = finalized.assets.run_worker_first;
            writeFileAtomic(worker.configPath, JSON.stringify(worker.config));
          }
          if (worker.assetsDir && existsSync(client)) {
            cpSync(client, worker.assetsDir, { recursive: true });
          }
        }
        if (native.containers.length > 0) {
          writeFileAtomic(
            join(dirname(getRootConfigPath(root)), 'void-containers.json'),
            JSON.stringify({ workerDirectory: relative(root, destination) }),
          );
        }
        // Existing framework tooling still locates its built Worker through this pointer.
        const pointer = join(root, '.wrangler/deploy/config.json');
        const pointerDestination =
          existsSync(join(root, 'void.config.ts')) &&
          process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] !== '1'
            ? join(root, '.void/preview-deploy-config.json')
            : pointer;
        mkdirSync(dirname(pointerDestination), { recursive: true });
        writeFileAtomic(
          pointerDestination,
          JSON.stringify({
            configPath: relative(dirname(pointer), join(destination, 'wrangler.json')),
          }),
        );
        for (const name of options.viteEnvironment.childEnvironments ?? []) {
          const source = builder.environments[name]?.config.build.outDir;
          const target = outputDirectories.get(name);
          if (source && target && existsSync(source)) {
            cpSync(source, target, { recursive: true });
          }
        }
      },
    },
  };
  return [
    bridge,
    directories,
    ...withLocalPreviewBindings(
      cloudflareV2({
        inspectorPort: options.inspectorPort,
        persistState: options.persistState,
        viteEnvironment: options.viteEnvironment,
        auxiliaryWorkers: nativeAuxiliaryWorkers(options.auxiliaryWorkers, root),
        types: { generate: false },
        config() {
          // Replace the complete parsed configuration, including account settings
          // and Containers, without creating a provider-specific config file.
          return pluginNative;
        },
      }),
      root,
    ),
    output,
  ];
}
