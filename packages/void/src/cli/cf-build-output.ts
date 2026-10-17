import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getWorkerBundleDir,
  getWorkerAssetsDir,
  getWorkerConfigPath,
  getRootConfigPath,
  normalizeDirectoryName,
  readBuildOutput,
  writeAssets,
  writeContainerConfig,
  writeRootConfig,
  writeWorkerConfig,
} from '@cloudflare/build-output-utils';
import { type ModuleType, OutputContainerSchema } from '@cloudflare/config';
import ignore from 'ignore';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'pathslash';
import { migrateBuiltWranglerConfig, record } from './cf-config-migrate.ts';
import { buildContainerImage } from './container-image.ts';

export interface CfBuildOutput {
  directory: string;
  assetsDirectory?: string;
  activeSecrets?: {
    versionId: string;
    bindings: ReadonlyArray<{ name: string; type: 'secret_text' | 'secret_key' }>;
  };
  dispose(): Promise<void>;
}

// Match the additional modules emitted by the Cloudflare Vite plugin. A complete
// manifest keeps cf from treating text, binary, and Wasm imports as JavaScript.
const moduleTypes: Record<string, ModuleType> = {
  '.js': 'esm',
  '.mjs': 'esm',
  '.cjs': 'cjs',
  '.wasm': 'wasm',
  '.bin': 'data',
  '.woff': 'data',
  '.woff2': 'data',
  '.ttf': 'data',
  '.otf': 'data',
  '.eot': 'data',
  '.txt': 'text',
  '.html': 'text',
  '.sql': 'text',
  '.json': 'json',
  '.map': 'sourcemap',
};

/** Whether `path` resolves strictly inside `directory`. */
function isInside(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}

/** Asset copies follow symlinks, so a link may not reach outside the asset directory. */
function assertAssetSymlinksInside(directory: string): void {
  const realDirectory = realpathSync(directory);
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (
      entry.isSymbolicLink() &&
      !isInside(realDirectory, realpathSync(join(entry.parentPath, entry.name)))
    ) {
      throw new Error('The Worker assets contain a symlink outside the asset directory.');
    }
  }
}

function copyBundle(source: string, destination: string): Record<string, { type: ModuleType }> {
  const modules: Record<string, { type: ModuleType }> = {};
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    const absolute = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink() && !isInside(realpathSync(source), realpathSync(absolute))) {
      throw new Error('The built Worker contains a symlink outside its output directory.');
    }
    const name = relative(source, absolute);
    if (
      name === 'wrangler.json' ||
      name === '.dev.vars' ||
      name === join('.vite', 'manifest.json') ||
      // Vite extracts side-effect CSS imports into the Worker output, but they
      // are static build assets rather than Worker modules. Wrangler's module
      // rules do not upload CSS, and a complete cf manifest must omit it too.
      name.endsWith('.css') ||
      name.endsWith('.css.map')
    ) {
      continue;
    }
    const type = moduleTypes[extname(entry.name).toLowerCase()];
    if (!type) {
      throw new Error(
        `The built Worker contains an unsupported module ${JSON.stringify(name)}. Emit public assets into the client output or configure the plugin that produced this file to run only in the client environment.`,
      );
    }

    const destinationPath = join(destination, name);
    mkdirSync(dirname(destinationPath), { recursive: true });
    if (entry.isSymbolicLink()) {
      copyFileSync(realpathSync(absolute), destinationPath);
    } else {
      cpSync(absolute, destinationPath);
    }
    modules[name] = { type };
  }
  return modules;
}

/** Create a disposable cf Build Output tree from an existing Cloudflare Worker build. */
export async function prepareCfBuildOutput(
  workerDirectory: string,
  accountId?: string,
  mode?: string,
): Promise<CfBuildOutput | null> {
  const source = resolve(workerDirectory);
  if (existsSync(getRootConfigPath(source))) {
    return prepareNativeBuildOutput(source, accountId, mode);
  }
  if (!existsSync(join(source, 'wrangler.json'))) {
    throw new Error(
      `No Cloudflare Worker build found in ${source}. Pass the project root that contains .cloudflare/output/v0, or the Worker output directory that contains wrangler.json.`,
    );
  }
  const raw = record(JSON.parse(readFileSync(join(source, 'wrangler.json'), 'utf8')));
  if (!raw) {
    return null;
  }
  if (
    typeof raw.account_id === 'string' &&
    accountId !== undefined &&
    raw.account_id !== accountId
  ) {
    return null;
  }
  const config = migrateBuiltWranglerConfig(raw);
  if (!config.worker) {
    throw new Error('cf did not produce a Worker configuration.');
  }
  if (typeof raw.main !== 'string' || !raw.main) {
    throw new Error('The built Worker configuration is missing its main entry. Rebuild the app.');
  }
  const entry = raw.main.replaceAll('\\', '/');
  const main = relative(source, resolve(source, entry));
  if (isAbsolute(entry) || /^[a-z]:/i.test(entry) || !isInside(source, resolve(source, entry))) {
    throw new Error('The built Worker main entry must be inside its output directory.');
  }
  if (!existsSync(join(source, main))) {
    throw new Error(
      `The built Worker main entry ${JSON.stringify(main)} is missing. Rebuild the app.`,
    );
  }

  const assetsDirectory = record(raw.assets)?.directory;
  if (assetsDirectory !== undefined && typeof assetsDirectory !== 'string') {
    return null;
  }
  const images: Array<{ dispose(): Promise<void> }> = [];
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-deploy-'));
  const dispose = async () => {
    rmSync(directory, { recursive: true, force: true });
    await Promise.all(images.map((image) => image.dispose()));
  };
  try {
    const bundle = getWorkerBundleDir(directory);
    mkdirSync(bundle, { recursive: true });
    const modules = copyBundle(source, bundle);
    const configuredAccountId = accountId ?? raw.account_id;
    await writeRootConfig(
      directory,
      typeof configuredAccountId === 'string' ? { accountId: configuredAccountId } : {},
      { isPreview: false, mode: mode ?? 'production' },
    );
    await writeWorkerConfig({
      root: directory,
      config: config.worker,
      manifest: { type: 'complete', mainModule: main, modules },
    });
    for (const container of config.containers ?? []) {
      const builtContainer: Record<string, unknown> = { ...container };
      if ('images' in container && container.images) {
        const prepared: Record<string, unknown> = {};
        for (const [name, image] of Object.entries(container.images)) {
          if ('dockerfile' in image) {
            const built = await buildContainerImage(
              resolve(source, image.dockerfile),
              image.buildContext ? resolve(source, image.buildContext) : undefined,
            );
            images.push(built);
            prepared[name] = { localReference: built.localReference };
          } else {
            prepared[name] = image;
          }
        }
        builtContainer.images = prepared;
      }
      await writeContainerConfig({
        root: directory,
        config: OutputContainerSchema.parse(builtContainer),
        directoryName: normalizeDirectoryName(container.name),
      });
    }
    if (typeof assetsDirectory === 'string') {
      const assetPath = resolve(source, assetsDirectory);
      if (!existsSync(assetPath)) {
        await dispose();
        return null;
      }
      assertAssetSymlinksInside(assetPath);
      await writeAssets({ root: directory, sourceDirectory: assetPath });
    }
    await readBuildOutput(directory);
    return {
      directory,
      ...(typeof assetsDirectory === 'string'
        ? { assetsDirectory: resolve(source, assetsDirectory) }
        : {}),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Copy and complete the native artifact without changing the Vite build's inputs or metadata. */
async function prepareNativeBuildOutput(
  source: string,
  accountId?: string,
  mode?: string,
): Promise<CfBuildOutput | null> {
  const built = await readBuildOutput(source);
  if (
    (accountId !== undefined &&
      built.rootConfig.accountId !== undefined &&
      accountId !== built.rootConfig.accountId) ||
    (mode !== undefined && mode !== built.rootConfig.buildContext.mode)
  ) {
    return null;
  }
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-native-'));
  const dispose = async () => {
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await writeRootConfig(
      directory,
      {
        accountId: accountId ?? built.rootConfig.accountId,
        complianceRegion: built.rootConfig.complianceRegion,
      },
      { ...built.rootConfig.buildContext, mode: built.rootConfig.buildContext.mode },
    );
    for (const [name, worker] of Object.entries(built.workers)) {
      if (
        worker.bundleDir &&
        (!worker.config.manifest ||
          worker.config.manifest.modules[worker.config.manifest.mainModule]?.type !== 'esm')
      ) {
        throw new Error('The native Worker build must declare its main ES module.');
      }
      const configPath = getWorkerConfigPath(directory, name);
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(worker.config));
      if (worker.bundleDir && worker.config.manifest) {
        const bundle = getWorkerBundleDir(directory, name);
        for (const module of Object.keys(worker.config.manifest.modules)) {
          const destination = join(bundle, module);
          if (
            // A backslash or a colon (a Windows drive) has no place in a bundle path.
            module.includes('\\') ||
            module.includes(':') ||
            !isInside(bundle, resolve(bundle, module)) ||
            !isInside(worker.bundleDir, resolve(worker.bundleDir, module))
          ) {
            throw new Error('Native Worker modules must stay inside the build bundle.');
          }
          if (!existsSync(join(worker.bundleDir, module))) {
            throw new Error(`Native Worker module ${module} is missing from the build bundle.`);
          }
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(join(worker.bundleDir, module), destination);
        }
      }
      if (worker.assetsDir) {
        cpSync(worker.assetsDir, getWorkerAssetsDir(directory, name), { recursive: true });
      }
    }
    for (const container of built.containers) {
      await writeContainerConfig({
        root: directory,
        config: container.config,
        directoryName: basename(dirname(container.configPath)),
      });
    }
    await readBuildOutput(directory);
    return {
      directory,
      ...(built.workers.default.assetsDir
        ? { assetsDirectory: built.workers.default.assetsDir }
        : {}),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Bundle a generated Worker entry with Vite, then hand the result to `prepareCfBuildOutput`. */
async function prepareBundledBuildOutput(options: {
  projectRoot: string;
  entry: string;
  scratchPrefix: string;
  config: Record<string, unknown>;
  assets: Record<string, unknown>;
  accountId: string;
  external?: Array<RegExp>;
}): Promise<CfBuildOutput | null> {
  const scratch = mkdtempSync(join(tmpdir(), options.scratchPrefix));
  try {
    const { build } = await import('vite');
    await build({
      configFile: false,
      root: options.projectRoot,
      publicDir: false,
      logLevel: 'error',
      build: {
        outDir: scratch,
        emptyOutDir: true,
        lib: { entry: options.entry, formats: ['es'], fileName: 'index' },
        ...(options.external ? { rollupOptions: { external: options.external } } : {}),
        target: 'es2022',
      },
    });
    writeFileSync(
      join(scratch, 'wrangler.json'),
      JSON.stringify({ ...options.config, main: 'index.js', assets: options.assets }),
      { mode: 0o600 },
    );
    return await prepareCfBuildOutput(scratch, options.accountId);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Bundle Void's generated thin static Worker before handing it to cf as prebuilt output. */
export async function prepareCfStaticBuildOutput(options: {
  projectRoot: string;
  configPath: string;
  assetsDirectory: string;
  accountId: string;
}): Promise<CfBuildOutput | null> {
  const raw = record(JSON.parse(readFileSync(options.configPath, 'utf8')));
  if (!raw || typeof raw.main !== 'string' || basename(raw.main) !== raw.main) {
    return null;
  }
  const entry = join(dirname(options.configPath), raw.main);
  if (!existsSync(entry)) {
    return null;
  }
  return prepareBundledBuildOutput({
    projectRoot: options.projectRoot,
    entry,
    scratchPrefix: 'void-cf-static-',
    config: raw,
    assets: { ...record(raw.assets), directory: resolve(options.assetsDirectory) },
    accountId: options.accountId,
  });
}

/** Bundle an adapter-produced Worker and copy only its public framework assets. */
export async function prepareCfFrameworkBuildOutput(options: {
  projectRoot: string;
  configPath: string;
  accountId: string;
}): Promise<CfBuildOutput | null> {
  const raw = record(JSON.parse(readFileSync(options.configPath, 'utf8')));
  const assets = record(raw?.assets);
  if (!raw || typeof raw.main !== 'string' || typeof assets?.directory !== 'string') {
    return null;
  }
  const configDirectory = dirname(options.configPath);
  const entry = resolve(configDirectory, raw.main);
  const sourceAssets = resolve(configDirectory, assets.directory);
  if (!existsSync(entry) || !existsSync(sourceAssets)) {
    return null;
  }

  const publicAssets = mkdtempSync(join(tmpdir(), 'void-cf-framework-assets-'));
  try {
    const ignored = ignore();
    const ignorePath = join(sourceAssets, '.assetsignore');
    if (existsSync(ignorePath)) {
      ignored.add(readFileSync(ignorePath, 'utf8'));
    }
    const realAssets = realpathSync(sourceAssets);
    for (const file of readdirSync(sourceAssets, { recursive: true, withFileTypes: true })) {
      if (file.isDirectory()) {
        continue;
      }
      const absolute = join(file.parentPath, file.name);
      const name = relative(sourceAssets, absolute).replaceAll('\\', '/');
      if (name === '.assetsignore' || ignored.ignores(name)) {
        continue;
      }
      const destination = join(publicAssets, name);
      mkdirSync(dirname(destination), { recursive: true });
      if (file.isSymbolicLink()) {
        const target = realpathSync(absolute);
        if (!isInside(realAssets, target)) {
          throw new Error('The framework assets contain a symlink outside the asset directory.');
        }
        copyFileSync(target, destination);
      } else if (file.isFile()) {
        copyFileSync(absolute, destination);
      }
    }
    const prepared = await prepareBundledBuildOutput({
      projectRoot: options.projectRoot,
      entry,
      scratchPrefix: 'void-cf-framework-',
      config: raw,
      assets: { ...assets, directory: publicAssets },
      accountId: options.accountId,
      external: [/^cloudflare:/, /^node:/],
    });
    return prepared ? { ...prepared, assetsDirectory: sourceAssets } : null;
  } finally {
    rmSync(publicAssets, { recursive: true, force: true });
  }
}
