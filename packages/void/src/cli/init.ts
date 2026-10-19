import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { isRecord } from '@void/deploy-core';
import type { PlatformDiscoveryDocument } from '@void/platform';
import { log, confirm, isCancel, cancel, select, text } from '@voidzero-dev/vite-plus-prompts';
import { parse, type ParseError } from 'jsonc-parser';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathslash';
import { materializeCloudflareConfig } from '../cloudflare-config.ts';
import { createProjectTsconfig, ensureProjectTsconfig } from '../codegen/project-tsconfig.ts';
import { TYPED_CONFIG_FILE } from '../config-loader.ts';
import { canRewriteVoidProjectConfig, writeVoidProjectConfig } from '../config-write.ts';
import {
  databaseConfigValue,
  getDatabaseCasing,
  getDatabaseDialect,
  readConfig,
  type DatabaseDialect,
  type VoidConfig,
} from '../config.ts';
import { PLACEHOLDER_DB_URL, writeDrizzleConfig } from '../drizzle/config.ts';
import { snapshotDrizzleOutputs } from '../drizzle/generate.ts';
import { detectFramework, type DetectedFramework } from '../plugin-inference.ts';
import { readProjectPaths } from '../project-paths.ts';
import {
  hasPackageDependency,
  readPackageJson,
  type PackageDependencyField,
} from '../shared/package-json.ts';
import { detectAgents, getOwnVersion, getPackageDir } from './agents.ts';
import { connectCloudflare } from './cloudflare-connect.ts';
import { maybeSetupDeployProject } from './deploy-setup.ts';
import { maybeScaffoldEnvTs } from './env-scaffold.ts';
import { migrateFrameworkAdapterPaths } from './framework-config-migrate.ts';
import { initialCommitCommand, setupGit } from './init-git.ts';
import { configureVitePlusScaffold } from './init-vite-plus.ts';
import { migrateLegacyVoidConfig } from './migrate.ts';
import { formatUrl, note, printSuccess } from './output.ts';
import { discoverPlatform, saveDiscoveredPlatform } from './platform-cmd.ts';
import { formatProjectCommand } from './preset.ts';
import {
  readDeploymentPlatform,
  readProjectConfig,
  writeDeploymentPlatform,
  type DeploymentPlatform,
} from './project.ts';
import {
  createPagesStarterTemplate,
  detectScaffoldFrameworkFromDependencies,
  getScaffoldTsconfigCompilerOptions,
  SCAFFOLD_BASE_DEV_DEPENDENCIES,
  SCAFFOLD_FRAMEWORKS,
  SCAFFOLD_FRAMEWORK_OPTIONS,
  SCAFFOLD_GITIGNORE_LINES,
  SCAFFOLD_TOOLCHAIN_OPTIONS,
  SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES,
  type ScaffoldFramework,
  type ScaffoldStarterMode,
  type ScaffoldToolchain,
} from './template.ts';
import { patchViteConfigWithVoidPlugin } from './vite-config-patch.ts';
import { LATEST_KNOWN_COMPAT_DATE, writeProvisionedWranglerConfig } from './wrangler.ts';
import {
  buildDrizzleKitSpawnEnv,
  drizzleKitBin,
  findInstalledYarnPnpRuntime,
  hasLocalLockfile,
} from './yarn-pnp.ts';

export type InitArgs = {
  tsconfig: boolean;
  github: boolean;
  git?: boolean;
};

export function parseInitArgs(args: Array<string>): InitArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        tsconfig: { type: 'boolean' },
        github: { type: 'boolean' },
        git: { type: 'boolean' },
      },
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`init: ${message}.`);
  }

  return {
    tsconfig: parsed.values.tsconfig === true,
    github: parsed.values.github === true,
    git: parsed.values.git as boolean | undefined,
  };
}

const EMPTY_PROJECT_ALLOWED_ENTRIES = new Set([
  '.git',
  '.gitignore',
  'AGENTS.md',
  'CLAUDE.md',
  '.node-version',
  '.npmrc',
  '.yarnrc.yml',
  '.nvmrc',
  '.editorconfig',
  '.vscode',
  '.idea',
  '.DS_Store',
  '.void',
  '.wrangler',
  'node_modules',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  '.agents',
  '.claude',
  '.cline',
  '.codex',
  '.continue',
  '.cursor',
  '.gemini',
  '.goose',
  '.junie',
  '.kilocode',
  '.kiro',
  '.opencode',
  '.qwen',
  '.roo',
  '.trae',
  '.windsurf',
  '.zencoder',
]);

// better-sqlite3 13 already ships its Node-API binaries; no native build is needed.
const PNPM_BUILD_DEFAULTS = [
  ['better-sqlite3', false],
  ['esbuild', true],
  ['sharp', true],
  ['workerd', true],
] as const;
// pnpm writes this value for each blocked build it wants a decision on.
const PNPM_BUILD_PLACEHOLDER = 'set this to true or false';

// Packages a previous Void Pages starter can leave behind, so re-running init
// after deleting the app files still takes the starter path.
const EMPTY_PROJECT_ALLOWED_PACKAGES = new Set([
  'void',
  'hono',
  'vite',
  'vite-plus',
  'typescript',
  '@rolldown/plugin-babel',
  '@vitejs/plugin-react',
  'babel-plugin-react-compiler',
  'oxc-transform-react',
  '@types/react',
  '@types/react-dom',
  'react',
  'react-dom',
  'vue',
  'svelte',
  'solid-js',
  '@void/react',
  '@void/vue',
  '@void/svelte',
  '@void/solid',
]);

// Only `void` and adapters may be a preinstall (`pnpm add -D void @void/svelte`);
// other starter packages such as `svelte` also require an adapter.
const EMPTY_PROJECT_ALLOWED_ADAPTER_PACKAGES = new Set([
  '@void/react',
  '@void/vue',
  '@void/svelte',
  '@void/solid',
]);
const EMPTY_PROJECT_BASE_PACKAGES = new Set([
  'void',
  '@void/react',
  '@void/vue',
  '@void/svelte',
  '@void/solid',
]);

// scaffoldPagesApp() replaces these starter scripts; custom scripts make the
// package an existing project.
const EMPTY_PROJECT_ALLOWED_SCRIPTS: Record<string, Set<string> | undefined> = {
  test: undefined,
  dev: new Set(['vite', 'vp dev']),
  build: new Set(['vite build', 'vp build']),
  preview: new Set(['vite preview', 'vp preview']),
};
const EMPTY_PROJECT_STARTER_SCRIPT_COMMANDS = new Set(
  Object.values(EMPTY_PROJECT_ALLOWED_SCRIPTS).flatMap((commands) =>
    commands ? Array.from(commands) : [],
  ),
);

function isStarterScriptCommand(value: unknown): boolean {
  return typeof value === 'string' && EMPTY_PROJECT_STARTER_SCRIPT_COMMANDS.has(value);
}

function hasOnlyVoidStarterDependencies(depNames: Array<string>): boolean {
  if (depNames.some((dep) => !EMPTY_PROJECT_ALLOWED_PACKAGES.has(dep))) {
    return false;
  }
  const hasStarterDependency = depNames.some((dep) => !EMPTY_PROJECT_BASE_PACKAGES.has(dep));
  const hasPagesAdapter = depNames.some((dep) => EMPTY_PROJECT_ALLOWED_ADAPTER_PACKAGES.has(dep));
  return !hasStarterDependency || hasPagesAdapter;
}

const VITE_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
];
const VOID_CONFIG_FILE = 'void.json';
type DatabaseSetupChoice = DatabaseDialect | 'none';
type InitLocationChoice = 'subfolder' | 'current';
type JsonObject = Record<string, unknown>;
type TsconfigInheritancePatch = {
  files: Array<string>;
  paths: Record<string, Array<string>>;
};

function asRecord(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}

function parseJsoncFile(path: string): JsonObject | null {
  const errors: Array<ParseError> = [];
  const parsed = asRecord(parse(readFileSync(path, 'utf-8'), errors));
  return errors.length === 0 ? parsed : null;
}

function uniqueStrings(values: Array<string>): Array<string> {
  return Array.from(new Set(values));
}

function normalizeRelativePath(fromDir: string, toPath: string): string {
  const rel = relative(fromDir, toPath).replaceAll('\\', '/');
  return rel === '..' || rel.startsWith('../') || rel.startsWith('./') ? rel : `./${rel}`;
}

function getOwnConfigBaseUrlDir(config: JsonObject, configDir: string): string | null {
  const compilerOptions = asRecord(config.compilerOptions);
  return compilerOptions && typeof compilerOptions.baseUrl === 'string'
    ? resolve(configDir, compilerOptions.baseUrl)
    : null;
}

function readExtends(config: JsonObject): Array<string> {
  return typeof config.extends === 'string'
    ? [config.extends]
    : Array.isArray(config.extends)
      ? config.extends.filter((value): value is string => typeof value === 'string')
      : [];
}

function getEffectiveConfigBaseUrlDir(
  config: JsonObject,
  configPath: string,
  seen: Set<string>,
): string | null {
  if (seen.has(configPath)) {
    return null;
  }
  seen.add(configPath);

  const configDir = dirname(configPath);
  const ownBaseUrl = getOwnConfigBaseUrlDir(config, configDir);
  if (ownBaseUrl) {
    return ownBaseUrl;
  }

  const extendsValues = readExtends(config);

  let inheritedBaseUrl: string | null = null;
  for (const extendsValue of extendsValues) {
    const extendedPath = resolveExtendedTsconfig(configPath, extendsValue);
    if (!extendedPath || !existsSync(extendedPath)) {
      continue;
    }

    const extendedConfig = parseJsoncFile(extendedPath);
    if (!extendedConfig) {
      continue;
    }

    inheritedBaseUrl =
      getEffectiveConfigBaseUrlDir(extendedConfig, extendedPath, seen) ?? inheritedBaseUrl;
  }

  return inheritedBaseUrl;
}

function effectiveConfigPathBaseDir(config: JsonObject, configPath: string): string {
  return getEffectiveConfigBaseUrlDir(config, configPath, new Set()) ?? dirname(configPath);
}

function convertConfigFileEntry(value: string, configDir: string, root: string): string {
  if (isAbsolute(value)) {
    return normalizeRelativePath(root, value);
  }
  return normalizeRelativePath(root, resolve(configDir, value));
}

function convertPathTarget(value: string, fromBaseDir: string, toBaseDir: string): string {
  if (isAbsolute(value)) {
    return normalizeRelativePath(toBaseDir, value);
  }
  return normalizeRelativePath(toBaseDir, resolve(fromBaseDir, value));
}

function mergePathMaps(
  target: Record<string, Array<string>>,
  source: Record<string, Array<string>>,
): void {
  for (const [key, values] of Object.entries(source)) {
    target[key] = values;
  }
}

function readStringArray(value: unknown): Array<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readPaths(value: unknown): Record<string, Array<string>> {
  const paths = asRecord(value);
  if (!paths) {
    return {};
  }

  const result: Record<string, Array<string>> = {};
  for (const [key, values] of Object.entries(paths)) {
    const stringValues = readStringArray(values);
    if (stringValues.length > 0) {
      result[key] = stringValues;
    }
  }
  return result;
}

function resolveExtendedTsconfig(fromConfigPath: string, specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const resolved = resolve(dirname(fromConfigPath), specifier);
    return resolved.endsWith('.json') ? resolved : `${resolved}.json`;
  }

  try {
    return createRequire(fromConfigPath).resolve(specifier);
  } catch {
    try {
      return createRequire(fromConfigPath).resolve(`${specifier}.json`);
    } catch {
      return null;
    }
  }
}

function collectTsconfigPatchFromConfig(
  config: JsonObject,
  configPath: string,
  root: string,
  outputBaseDir: string,
  seen: Set<string>,
): TsconfigInheritancePatch {
  const patch: TsconfigInheritancePatch = { files: [], paths: {} };

  if (seen.has(configPath)) {
    return patch;
  }
  seen.add(configPath);

  const extendsValues = readExtends(config);

  const hasOwnFiles = Array.isArray(config.files);
  const compilerOptions = asRecord(config.compilerOptions);
  const hasOwnPaths = asRecord(compilerOptions?.paths) !== null;

  for (const extendsValue of extendsValues) {
    const extendedPath = resolveExtendedTsconfig(configPath, extendsValue);
    if (!extendedPath || !existsSync(extendedPath)) {
      continue;
    }

    const extendedConfig = parseJsoncFile(extendedPath);
    if (!extendedConfig) {
      continue;
    }

    const extendedPatch = collectTsconfigPatchFromConfig(
      extendedConfig,
      extendedPath,
      root,
      outputBaseDir,
      seen,
    );
    if (!hasOwnFiles) {
      patch.files.push(...extendedPatch.files);
    }
    if (!hasOwnPaths) {
      mergePathMaps(patch.paths, extendedPatch.paths);
    }
  }

  const configDir = dirname(configPath);
  if (hasOwnFiles) {
    patch.files.push(
      ...readStringArray(config.files).map((entry) =>
        convertConfigFileEntry(entry, configDir, root),
      ),
    );
  }

  if (hasOwnPaths) {
    const paths = readPaths(compilerOptions?.paths);
    const pathBaseDir = effectiveConfigPathBaseDir(config, configPath);
    const convertedPaths: Record<string, Array<string>> = {};
    for (const [key, values] of Object.entries(paths)) {
      convertedPaths[key] = values.map((value) =>
        convertPathTarget(value, pathBaseDir, outputBaseDir),
      );
    }
    mergePathMaps(patch.paths, convertedPaths);
  }

  return patch;
}

function createVoidTsconfigPatch(root: string, outputBaseDir: string): TsconfigInheritancePatch {
  const hasSchema = hasDrizzleSchema(root);
  const voidConfig = createProjectTsconfig(root, undefined, hasSchema, hasSchema);
  return collectTsconfigPatchFromConfig(
    voidConfig as unknown as JsonObject,
    join(root, '.void', 'tsconfig.json'),
    root,
    outputBaseDir,
    new Set(),
  );
}

function hasTopLevelYamlKey(yaml: string, key: string): boolean {
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  return yaml.split(/\r?\n/).some((rawLine) => {
    const line = stripYamlLineComment(rawLine);
    return keyPattern.test(line);
  });
}

function isEmptyProjectAllowedPnpmWorkspaceFile(root: string): boolean {
  try {
    const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8');
    return !hasTopLevelYamlKey(yaml, 'packages');
  } catch {
    return false;
  }
}

export function isScaffoldableEmptyProject(root: string): boolean {
  for (const dir of [
    'src',
    'routes',
    'db',
    'migrations',
    'middleware',
    'crons',
    'queues',
    'pages',
  ]) {
    if (existsSync(join(root, dir))) {
      return false;
    }
  }
  if (existsSync(join(root, 'index.html'))) {
    return false;
  }
  for (const file of VITE_CONFIG_FILES) {
    if (existsSync(join(root, file))) {
      return false;
    }
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (EMPTY_PROJECT_ALLOWED_ENTRIES.has(entry.name)) {
      continue;
    }
    if (entry.name === 'pnpm-workspace.yaml' && isEmptyProjectAllowedPnpmWorkspaceFile(root)) {
      continue;
    }
    if (entry.name.startsWith('README')) {
      continue;
    }
    return false;
  }

  const packageJsonPath = join(root, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return true;
  }

  let pkgRaw: unknown;
  try {
    pkgRaw = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    return false;
  }
  const pkg = asRecord(pkgRaw);
  if (!pkg) {
    return false;
  }

  const deps = {
    ...(asRecord(pkg.dependencies) ?? {}),
    ...(asRecord(pkg.devDependencies) ?? {}),
  };
  if (!hasOnlyVoidStarterDependencies(Object.keys(deps))) {
    return false;
  }

  const scripts = asRecord(pkg.scripts) ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (!(name in EMPTY_PROJECT_ALLOWED_SCRIPTS)) {
      return false;
    }
    const allowed = EMPTY_PROJECT_ALLOWED_SCRIPTS[name];
    if (allowed === undefined) {
      continue;
    }
    if (typeof command !== 'string' || !allowed.has(command)) {
      return false;
    }
  }

  return true;
}

function shouldPromptForInitLocation(root: string): boolean {
  if (isScaffoldableEmptyProject(root)) {
    return false;
  }
  if (existsSync(join(root, 'package.json'))) {
    return false;
  }
  if (existsSync(join(root, VOID_CONFIG_FILE)) || existsSync(join(root, TYPED_CONFIG_FILE))) {
    return false;
  }
  return findViteConfig(root) === undefined;
}

function validateSubfolderName(root: string, value: string | undefined): string | undefined {
  const name = value?.trim() ?? '';
  if (!name) {
    return 'Enter a folder name.';
  }
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return 'Enter a single folder name, not a path.';
  }
  if (existsSync(join(root, name))) {
    return 'That folder already exists.';
  }
  return undefined;
}

async function resolveInitRoot(root: string): Promise<string> {
  if (!shouldPromptForInitLocation(root)) {
    return root;
  }

  const choice = await select({
    message: 'This folder is not empty. Where should Void initialize?',
    initialValue: 'subfolder',
    options: [
      {
        value: 'subfolder',
        label: 'Create a new subfolder',
        hint: 'Scaffold a new app inside this directory.',
      },
      {
        value: 'current',
        label: 'Continue here',
        hint: 'Add package.json, vite.config.ts, and Void files to this directory.',
      },
    ],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  if ((choice as InitLocationChoice) === 'current') {
    return root;
  }

  const defaultFolder = 'my-void-app';
  const folder = await text({
    message: 'New project folder name:',
    placeholder: defaultFolder,
    defaultValue: defaultFolder,
    validate: (value) => validateSubfolderName(root, value || defaultFolder),
  });

  if (isCancel(folder) || typeof folder === 'symbol') {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const nextRoot = join(root, folder.trim());
  mkdirSync(nextRoot, { recursive: true });
  log.info(`Scaffolding in ${nextRoot}`);
  return nextRoot;
}

type ProjectState = {
  hasTypescript: boolean;
  hasTsconfig: boolean;
  hasRoutes: boolean;
  hasMigrations: boolean;
  hasPages: boolean;
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm';
  typescriptWanted: boolean;
};

function parsePackageManagerField(pkg: unknown): ProjectState['packageManager'] | undefined {
  if (!pkg || typeof pkg !== 'object') {
    return undefined;
  }
  const raw = (pkg as { packageManager?: unknown }).packageManager;
  if (typeof raw !== 'string') {
    return undefined;
  }
  // Corepack spec: "name@version[+sha.<hash>]".
  const name = raw.split('@', 1)[0]?.trim();
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    return name;
  }
  return undefined;
}

/**
 * Whether pnpm manages `root`. pnpm keeps the lockfile and Corepack pin at the
 * workspace root, so a member without local markers inherits them, but a local
 * lockfile or pin for another manager always wins.
 */
function isPnpmProject(root: string, pkg: JsonObject): boolean {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return true;
  }
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) {
    return true;
  }
  const localPm = parsePackageManagerField(pkg);
  if (localPm === 'pnpm') {
    return true;
  }

  if (localPm === 'bun' || localPm === 'yarn' || localPm === 'npm') {
    return false;
  }
  if (hasLocalLockfile(root)) {
    return false;
  }

  return hasAncestorPnpmMarkers(root);
}

/**
 * Whether `start` is a declared member of a pnpm-managed ancestor workspace.
 * A scratch app outside the workspace globs is a separate project.
 */
function hasAncestorPnpmMarkers(start: string): boolean {
  const workspaceRoot = findWorkspaceRoot(start);
  if (workspaceRoot === undefined) {
    return false;
  }
  if (!isWorkspaceSubpackage(workspaceRoot, start)) {
    return false;
  }
  if (existsSync(join(workspaceRoot, 'pnpm-workspace.yaml'))) {
    return true;
  }
  if (existsSync(join(workspaceRoot, 'pnpm-lock.yaml'))) {
    return true;
  }
  const pkgPath = join(workspaceRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (parsePackageManagerField(pkg) === 'pnpm') {
        return true;
      }
    } catch {
      // An unreadable root package.json is not a pnpm pin.
    }
  }
  return false;
}

/**
 * Whether `void` resolves from `start`, through an ancestor `node_modules`
 * (hoisted workspace installs) or an installed Yarn PnP runtime.
 */
export function isVoidResolvableFrom(start: string): boolean {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'node_modules', 'void', 'package.json'))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // PnP data can be stale (void removed on another branch), so probe under the
  // loaders drizzle-kit will use. With only `.pnp.loader.mjs`, CJS
  // `require.resolve` skips the ESM loader, so probe with `import.meta.resolve`.
  const installed = findInstalledYarnPnpRuntime(start);
  if (installed !== undefined) {
    const probeArgs = installed.pnpCjs
      ? ['-e', "require.resolve('void')"]
      : ['--input-type=module', '-e', "import.meta.resolve('void')"];
    const probe = spawnSync(process.execPath, probeArgs, {
      cwd: start,
      stdio: 'ignore',
      env: buildDrizzleKitSpawnEnv(start),
    });
    return !probe.error && probe.status === 0;
  }
  return false;
}

/**
 * Nearest ancestor of `start` (excluding `start`) with a `pnpm-workspace.yaml`
 * or a `package.json#workspaces` field.
 */
function findWorkspaceRoot(start: string): string | undefined {
  let dir = dirname(start);
  while (true) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
        if (pkg && typeof pkg === 'object' && 'workspaces' in pkg) {
          return dir;
        }
      } catch {
        // Keep walking past an unreadable package.json.
      }
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Member globs from `pnpm-workspace.yaml#packages` or `package.json#workspaces`
 * (an array or `{ packages }`). Empty when none can be read.
 */
function readWorkspacePatterns(workspaceRoot: string): Array<string> {
  const pnpmWorkspacePath = join(workspaceRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWorkspacePath)) {
    try {
      const yaml = readFileSync(pnpmWorkspacePath, 'utf-8');
      return extractPnpmWorkspacePackages(yaml);
    } catch {
      return [];
    }
  }
  const pkgPath = join(workspaceRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const workspaces = (pkg as { workspaces?: unknown }).workspaces;
      if (Array.isArray(workspaces)) {
        return workspaces.filter((x): x is string => typeof x === 'string');
      }
      if (workspaces && typeof workspaces === 'object') {
        const packages = (workspaces as { packages?: unknown }).packages;
        if (Array.isArray(packages)) {
          return packages.filter((x): x is string => typeof x === 'string');
        }
      }
    } catch {
      return [];
    }
  }
  return [];
}

/** Strip a trailing YAML comment, keeping `#` inside quotes (`- "path #hash/*"`). */
function stripYamlLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '#' && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line;
}

/**
 * Read the `packages:` list of a `pnpm-workspace.yaml` in block (`- 'apps/*'`)
 * or flow (`packages: ['apps/*']`) form.
 */
export function extractPnpmWorkspacePackages(yaml: string): Array<string> {
  const lines = yaml.split(/\r?\n/);
  const patterns: Array<string> = [];
  let inPackages = false;
  for (const rawLine of lines) {
    const line = stripYamlLineComment(rawLine);

    const inlineMatch = line.match(/^\s*packages\s*:\s*\[(.*)\]\s*$/);
    if (inlineMatch) {
      const inner = inlineMatch[1];
      const items = inner.match(/(['"])(?:(?!\1).)*\1|[^,\s]+/g) ?? [];
      for (const raw of items) {
        const unquoted = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
        if (unquoted) {
          patterns.push(unquoted);
        }
      }
      inPackages = false;
      continue;
    }

    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    // Any other top-level key ends the `packages:` block.
    if (/^[A-Za-z_][\w-]*\s*:\s*(?:\S.*)?$/.test(line) && !/^\s/.test(line)) {
      inPackages = false;
      continue;
    }
    const m = line.match(/^\s*-\s*(['"]?)([^'"\s][^'"]*?)\1\s*$/);
    if (m) {
      patterns.push(m[2]);
    }
  }
  return patterns;
}

/** Expand `{a,b}` brace groups, including several groups in one pattern. */
function expandBraces(pattern: string): Array<string> {
  const match = pattern.match(/^([^{}]*)\{([^{}]*)\}(.*)$/);
  if (!match) {
    return [pattern];
  }
  const [, before, group, after] = match;
  const options = group
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (options.length === 0) {
    return [pattern];
  }
  const results: Array<string> = [];
  for (const opt of options) {
    for (const sub of expandBraces(before + opt + after)) {
      results.push(sub);
    }
  }
  return results;
}

// Supports *, **, ./ and {a,b} braces; ?, [...] and extglobs are matched literally.
function matchesWorkspacePattern(relPath: string, pattern: string): boolean {
  const expansions = expandBraces(pattern);
  return expansions.some((p) => matchesSingleWorkspacePattern(relPath, p));
}

function matchesSingleWorkspacePattern(relPath: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/^\.\/+/, '');
  const pathSegs = relPath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  const patSegs = normalizedPattern
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  const compiled = patSegs.map(compilePatternSegment);
  return matchSegments(pathSegs, 0, compiled, 0);
}

type CompiledSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'globstar' };

function compilePatternSegment(seg: string): CompiledSegment {
  if (seg === '**') {
    return { kind: 'globstar' };
  }
  if (!seg.includes('*')) {
    return { kind: 'literal', value: seg };
  }
  // Each `*` matches any characters except `/`.
  const re = new RegExp(
    '^' +
      seg
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*') +
      '$',
  );
  return { kind: 'regex', re };
}

function matchSegments(
  path: Array<string>,
  pi: number,
  pat: Array<CompiledSegment>,
  qi: number,
): boolean {
  while (qi < pat.length) {
    const seg = pat[qi];
    if (seg.kind === 'globstar') {
      // A trailing `**` matches any remaining path, including none.
      if (qi === pat.length - 1) {
        return true;
      }
      for (let k = pi; k <= path.length; k++) {
        if (matchSegments(path, k, pat, qi + 1)) {
          return true;
        }
      }
      return false;
    }
    if (pi >= path.length) {
      return false;
    }
    if (seg.kind === 'literal') {
      if (seg.value !== path[pi]) {
        return false;
      }
    } else if (!seg.re.test(path[pi])) {
      return false;
    }
    pi++;
    qi++;
  }
  return pi === path.length;
}

/**
 * Whether `root` matches a workspace glob and no `!` glob. A nested app outside
 * the globs is a separate project.
 */
function isWorkspaceSubpackage(workspaceRoot: string, root: string): boolean {
  const relPath = relative(workspaceRoot, root);
  if (relPath === '' || relPath.startsWith('..')) {
    return false;
  }
  const normalized = relPath.split(/[\\/]/).join('/');
  const patterns = readWorkspacePatterns(workspaceRoot);
  if (patterns.length === 0) {
    return false;
  }
  let matched = false;
  for (const raw of patterns) {
    const isNegation = raw.startsWith('!');
    const pattern = isNegation ? raw.slice(1) : raw;
    if (matchesWorkspacePattern(normalized, pattern)) {
      if (isNegation) {
        return false;
      }
      matched = true;
    }
  }
  return matched;
}

/** Workspace membership, even when the member manages its own install. */
function isInsideWorkspaceSubpackage(root: string): boolean {
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot === undefined) {
    return false;
  }
  return isWorkspaceSubpackage(workspaceRoot, root);
}

/**
 * The workspace root that should install for `root`: set when `root` is a
 * member without its own lockfile or non-pnpm Corepack pin, as in `isPnpmProject`.
 */
function resolveWorkspaceDeferral(
  root: string,
  pkg: JsonObject | null,
): { workspaceRoot: string } | undefined {
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot === undefined) {
    return undefined;
  }
  if (!isWorkspaceSubpackage(workspaceRoot, root)) {
    return undefined;
  }
  if (hasLocalLockfile(root)) {
    return undefined;
  }
  const localPm = parsePackageManagerField(pkg);
  if (localPm === 'bun' || localPm === 'yarn' || localPm === 'npm') {
    return undefined;
  }
  return { workspaceRoot };
}

export function detectProjectState(root: string): ProjectState {
  let hasTypescript = false;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const pkgRecord = (pkg ?? {}) as { dependencies?: unknown; devDependencies?: unknown };
    const allDeps = {
      ...(asRecord(pkgRecord.dependencies) ?? {}),
      ...(asRecord(pkgRecord.devDependencies) ?? {}),
    };
    hasTypescript = 'typescript' in allDeps;
  } catch {
    // no package.json
  }

  let packageManager: ProjectState['packageManager'] | undefined;
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
  } else if (existsSync(join(root, 'yarn.lock'))) {
    packageManager = 'yarn';
  } else if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) {
    packageManager = 'bun';
  } else if (existsSync(join(root, 'pnpm-workspace.yaml'))) {
    // A fresh pnpm workspace has no lockfile yet; npm would reject its
    // `workspace:` specs.
    packageManager = 'pnpm';
  } else {
    const field = parsePackageManagerField(pkg);
    if (field === 'pnpm' || field === 'yarn' || field === 'bun') {
      packageManager = field;
    } else {
      packageManager = 'npm';
    }
  }

  const paths = readProjectPaths(root);
  return {
    hasTypescript,
    hasTsconfig: existsSync(join(root, 'tsconfig.json')),
    hasRoutes: existsSync(paths.routesDir),
    hasMigrations: existsSync(paths.migrationsDir) || existsSync(join(root, 'migrations')),
    hasPages: existsSync(paths.pagesDir),
    packageManager,
    typescriptWanted: hasTypescript,
  };
}

function findViteConfig(root: string): string | undefined {
  return VITE_CONFIG_FILES.find((file) => existsSync(join(root, file)));
}

function hasDrizzleSchema(root: string): boolean {
  const paths = readProjectPaths(root);
  return existsSync(paths.schemaFile) || existsSync(paths.schemaDir);
}

function detectPagesFramework(root: string): ScaffoldFramework | undefined {
  const pkg = readPackageJson(root);
  if (!pkg) {
    return undefined;
  }
  return detectScaffoldFrameworkFromDependencies({
    ...(asRecord(pkg.dependencies) ?? {}),
    ...(asRecord(pkg.devDependencies) ?? {}),
  });
}

const DEPENDENCY_FIELDS: ReadonlyArray<PackageDependencyField> = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** The first declared spec for `packageName`, in `DEPENDENCY_FIELDS` order. */
function resolveScaffoldDependencySpec(
  root: string,
  packageName: string,
  fallbackVersion: string,
): string {
  const pkg = readPackageJson(root);
  for (const field of DEPENDENCY_FIELDS) {
    const spec = asRecord(pkg?.[field])?.[packageName];
    if (typeof spec === 'string') {
      return spec || fallbackVersion;
    }
  }
  return fallbackVersion;
}

function defaultPackageName(root: string): string {
  return (
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-') || 'my-app'
  );
}

function setupTsconfig(
  root: string,
  state: ProjectState,
  pagesFramework?: ScaffoldFramework,
): void {
  const tsconfigPath = join(root, 'tsconfig.json');

  if (state.hasTsconfig) {
    // Case C: existing tsconfig — check and offer fixes
    let tsconfig: JsonObject;
    try {
      const parsed = parseJsoncFile(tsconfigPath);
      if (!parsed) {
        throw new SyntaxError('Failed to parse tsconfig.json');
      }
      tsconfig = parsed;
    } catch {
      log.warn('Could not parse tsconfig.json, skipping');
      return;
    }

    let updated = false;
    const rootPathBaseDir = effectiveConfigPathBaseDir(tsconfig, tsconfigPath);
    const existingPatch = collectTsconfigPatchFromConfig(
      tsconfig,
      tsconfigPath,
      root,
      rootPathBaseDir,
      new Set(),
    );
    const voidPatch = createVoidTsconfigPatch(root, rootPathBaseDir);

    // Check extends
    const extendsValue = tsconfig.extends;
    const target = './.void/tsconfig.json';
    const hasCorrectExtends =
      extendsValue === target || (Array.isArray(extendsValue) && extendsValue.includes(target));

    if (!hasCorrectExtends) {
      if (typeof extendsValue === 'string') {
        tsconfig.extends = [extendsValue, target];
      } else if (Array.isArray(extendsValue)) {
        tsconfig.extends = [...extendsValue, target];
      } else {
        tsconfig.extends = target;
      }
      updated = true;
      log.step('Updated tsconfig.json — added extends .void/tsconfig.json');
    }

    // Check types
    const compilerOptions = asRecord(tsconfig.compilerOptions) ?? {};
    tsconfig.compilerOptions = compilerOptions;
    const types = Array.isArray(compilerOptions.types)
      ? compilerOptions.types.filter((value): value is string => typeof value === 'string')
      : [];
    if (!types.includes('void/env')) {
      types.push('void/env');
      updated = true;
      log.step('Updated tsconfig.json — added void/env to types');
    }

    // Remove @cloudflare/workers-types — void/env includes it
    const cfIdx = types.indexOf('@cloudflare/workers-types');
    if (cfIdx !== -1) {
      types.splice(cfIdx, 1);
      updated = true;
      log.step('Removed @cloudflare/workers-types from tsconfig types (included in void/env)');
    }

    compilerOptions.types = types;

    const existingFiles = uniqueStrings(existingPatch.files);
    if (existingFiles.length > 0 || Array.isArray(tsconfig.files)) {
      const files = uniqueStrings([...existingFiles, ...voidPatch.files]);
      if (JSON.stringify(tsconfig.files) !== JSON.stringify(files)) {
        tsconfig.files = files;
        updated = true;
        log.step('Updated tsconfig.json — merged generated Void type files');
      }
    }

    if (Object.keys(existingPatch.paths).length > 0 || asRecord(compilerOptions.paths) !== null) {
      const paths = { ...existingPatch.paths };
      mergePathMaps(paths, voidPatch.paths);
      const existingPaths = readPaths(compilerOptions.paths);
      if (JSON.stringify(existingPaths) !== JSON.stringify(paths)) {
        compilerOptions.paths = paths;
        updated = true;
        log.step('Updated tsconfig.json — merged generated Void path aliases');
      }
    }

    if (updated) {
      // Rebuild with extends first so it appears at the top of the file
      const { extends: ext, ...rest } = tsconfig;
      const ordered = { extends: ext, ...rest };
      writeFileSync(tsconfigPath, JSON.stringify(ordered, null, 2) + '\n');
    } else {
      log.step('tsconfig.json looks good');
    }

    // Remove @cloudflare/workers-types from package.json — void/env includes it
    try {
      const pkgPath = join(root, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      let pkgUpdated = false;
      if (pkg.dependencies?.['@cloudflare/workers-types']) {
        delete pkg.dependencies['@cloudflare/workers-types'];
        pkgUpdated = true;
      }
      if (pkg.devDependencies?.['@cloudflare/workers-types']) {
        delete pkg.devDependencies['@cloudflare/workers-types'];
        pkgUpdated = true;
      }
      if (pkgUpdated) {
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        log.step('Removed @cloudflare/workers-types from package.json (included in void/env)');
        log.info(`Re-run ${state.packageManager} install to update your lockfile`);
      }
    } catch {
      // no package.json or parse error — skip
    }
  } else {
    // Case B: no tsconfig — create recommended one
    const tsconfig = {
      extends: './.void/tsconfig.json',
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ['void/env'],
        ...getScaffoldTsconfigCompilerOptions(pagesFramework),
      },
      include: ['src', 'pages', 'routes', 'middleware', 'crons', 'queues', 'db'],
    };
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');
    log.step('Created tsconfig.json');

    if (!state.hasTypescript) {
      log.info("Don't forget to install typescript");
    }
  }
}

function readProjectWranglerCompatDate(root: string): string | undefined {
  const configPath = materializeCloudflareConfig(root);
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const errors: Array<ParseError> = [];
    const parsed = parse(readFileSync(configPath, 'utf-8'), errors);
    if (errors.length === 0 && typeof parsed?.compatibility_date === 'string') {
      return parsed.compatibility_date;
    }
  } catch {
    // Ignore unreadable or invalid wrangler config and fall back to today's date.
  }
  return undefined;
}

/**
 * Ensure wrangler.jsonc exists with `compatibility_date` and `nodejs_als` flag
 * for class B/C meta-frameworks that need it for local dev.
 */
function setupWranglerConfig(root: string, framework: DetectedFramework): void {
  if (framework.class === 'a') {
    return;
  }

  const hadConfig = existsSync(materializeCloudflareConfig(root));
  const result = writeProvisionedWranglerConfig(root, {
    compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    compatibilityFlags: ['nodejs_als'],
  });

  if (result.modified) {
    log.step(
      hadConfig
        ? 'Updated Cloudflare config with compatibility_date and nodejs_als'
        : 'Created Cloudflare config with compatibility_date and nodejs_als',
    );
  } else {
    log.step(`${basename(result.configPath)} looks good`);
  }
}

export function ensureVoidWorkerCompatibilityDate(root: string): void {
  const config = readConfig(root) as Record<string, unknown>;

  if (typeof config.target === 'string' && config.target !== 'cloudflare') {
    return;
  }

  const worker = asRecord(config.worker) ?? {};
  if (typeof worker.compatibility_date === 'string' && worker.compatibility_date.length > 0) {
    return;
  }

  const compatibilityDate = readProjectWranglerCompatDate(root) ?? LATEST_KNOWN_COMPAT_DATE;
  if (!canRewriteVoidProjectConfig(root)) {
    writeProvisionedWranglerConfig(root, { compatibilityDate });
    log.step('Pinned worker compatibility_date in void.lock.json');
    return;
  }
  config.worker = {
    ...worker,
    compatibility_date: compatibilityDate,
  };
  writeVoidProjectConfig(root, config);
  log.step('Pinned worker compatibility_date in void.config.ts');
}

/** Write `dialect` to the config's `database`, keeping its casing. */
function writeDatabaseDialect(root: string, config: VoidConfig, dialect: DatabaseDialect): void {
  const next: VoidConfig = { ...config };
  const database = databaseConfigValue(dialect, getDatabaseCasing(config));
  if (database === undefined) {
    delete next.database;
  } else {
    next.database = database;
  }
  writeVoidProjectConfig(root, next);
}

function clearConfiguredDatabase(
  root: string,
  messages: { unchanged: string; updated: string },
): void {
  const config = readConfig(root);

  if (getDatabaseDialect(config) === 'sqlite') {
    log.info(messages.unchanged);
    return;
  }

  writeDatabaseDialect(root, config, 'sqlite');
  log.step(messages.updated);
}

function applyDatabaseDialect(root: string, dialect: DatabaseDialect): void {
  const config = readConfig(root);

  if (dialect === 'postgresql') {
    if (getDatabaseDialect(config) === 'postgresql') {
      log.info('PostgreSQL already configured in void.config.ts');
      return;
    }

    writeDatabaseDialect(root, config, 'postgresql');
    log.step('Configured PostgreSQL in void.config.ts');
    return;
  }

  if (dialect === 'mysql') {
    if (getDatabaseDialect(config) === 'mysql') {
      log.info('MySQL already configured in void.config.ts');
      return;
    }

    writeDatabaseDialect(root, config, 'mysql');
    log.step('Configured MySQL in void.config.ts');
    return;
  }

  clearConfiguredDatabase(root, {
    unchanged: 'Using default D1 (SQLite) configuration',
    updated: 'Updated void.config.ts to use the default D1 (SQLite) configuration',
  });
}

function detectDatabaseSetup(root: string): DatabaseSetupChoice {
  const dialect = getDatabaseDialect(readConfig(root));
  if (dialect !== 'sqlite') {
    return dialect;
  }
  if (
    hasDrizzleSchema(root) ||
    existsSync(readProjectPaths(root).migrationsDir) ||
    existsSync(join(root, 'migrations'))
  ) {
    return 'sqlite';
  }
  return 'none';
}

function applyDatabaseSetup(root: string, choice: DatabaseSetupChoice): void {
  if (choice === 'none') {
    clearConfiguredDatabase(root, {
      unchanged: 'No database configured yet',
      updated: 'Removed database config from void.config.ts',
    });
    return;
  }

  applyDatabaseDialect(root, choice);
}

async function promptStarterMode(): Promise<ScaffoldStarterMode> {
  const choice = await select({
    message: 'Choose a Pages starter:',
    options: [
      {
        value: 'sqlite',
        label: 'D1 (SQLite)',
        hint: 'Recommended starter. Scaffolds a DB-backed page, schema, generated migration, seed file, and API route.',
      },
      {
        value: 'postgresql',
        label: 'PostgreSQL',
        hint: 'Scaffolds the same starter with PostgreSQL, a generated migration, a seed file, and writes database: "pg" to void.config.ts.',
      },
      {
        value: 'mysql',
        label: 'MySQL',
        hint: 'Scaffolds the same starter with MySQL, a generated migration, a seed file, and writes database: "mysql" to void.config.ts.',
      },
      {
        value: 'static',
        label: 'Static Pages',
        hint: 'No database or server starter files yet. Good for content sites; add Void features later.',
      },
    ],
  });

  if (isCancel(choice) || typeof choice === 'symbol') {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as ScaffoldStarterMode;
}

async function promptScaffoldToolchain(): Promise<ScaffoldToolchain> {
  const choice = await select({
    message: 'Choose a Pages scaffold toolchain:',
    initialValue: 'vite-plus',
    options: [...SCAFFOLD_TOOLCHAIN_OPTIONS],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as ScaffoldToolchain;
}

async function promptScaffoldFramework(): Promise<ScaffoldFramework> {
  const choice = await select({
    message: 'Choose a Pages framework to scaffold:',
    options: [...SCAFFOLD_FRAMEWORK_OPTIONS],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as ScaffoldFramework;
}

async function promptDatabaseSetup(root: string): Promise<DatabaseSetupChoice> {
  const currentSetup = detectDatabaseSetup(root);
  const initialValue = currentSetup === 'none' ? 'sqlite' : currentSetup;

  const choice = await select({
    message: 'Choose a database setup for this project:',
    initialValue,
    options: [
      {
        value: 'sqlite',
        label: currentSetup === 'sqlite' ? 'D1 (SQLite) [current]' : 'D1 (SQLite)',
        hint: 'Zero-config and fully managed by Void; best for prototyping and read-heavy apps.',
      },
      {
        value: 'postgresql',
        label: currentSetup === 'postgresql' ? 'PostgreSQL [current]' : 'PostgreSQL',
        hint: 'Bring your own Postgres via Hyperdrive; best for write-heavy apps, complex queries, or existing infra.',
      },
      {
        value: 'mysql',
        label: currentSetup === 'mysql' ? 'MySQL [current]' : 'MySQL',
        hint: 'Bring your own MySQL via Hyperdrive; ideal for existing MySQL infrastructure and compatible providers.',
      },
      {
        value: 'none',
        label: 'No Database Yet',
        hint: 'Skip database setup for now. You can add D1, PostgreSQL, or MySQL later as your app grows.',
      },
    ],
  });

  if (isCancel(choice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return choice as DatabaseSetupChoice;
}

async function promptDeploymentPlatform(root: string): Promise<DeploymentPlatform> {
  const current = readDeploymentPlatform(root);
  const choice = await select({
    message: 'Where should this project deploy?',
    initialValue: current ?? 'cloudflare',
    options: [
      {
        value: 'cloudflare',
        label: current === 'cloudflare' ? 'Cloudflare [current]' : 'Cloudflare',
        hint: 'Deploy to your own Cloudflare account. (default)',
      },
      {
        value: 'void',
        label: current === 'void' ? 'Void [current]' : 'Void',
        hint: "Deploy to your company's Void Platform.",
      },
      {
        value: 'none',
        label: current === 'none' ? 'Skip deployment setup [current]' : 'Skip deployment setup',
        hint: 'Use Void locally or deploy another way.',
      },
    ],
  });

  if (isCancel(choice) || typeof choice === 'symbol') {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const platform = choice as DeploymentPlatform;
  writeDeploymentPlatform(root, platform);
  return platform;
}

export async function ensureVoidPlatformConnection(
  root: string,
): Promise<PlatformDiscoveryDocument> {
  let selectedApiUrl: string | null = null;
  let promptedForPlatform = false;
  try {
    const { getApiUrl, getSiteDomain } = await import('./auth.ts');
    selectedApiUrl = getApiUrl(root);
    getSiteDomain(root);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No Void platform connected')) {
      throw error;
    }
    // A genuinely new user must identify the company platform before login.
  }
  if (!selectedApiUrl) {
    promptedForPlatform = true;
    const value = await text({
      message: 'Void platform API URL:',
      placeholder: 'https://platform.example.com',
    });
    if (isCancel(value) || typeof value === 'symbol') {
      cancel('Setup cancelled.');
      process.exit(0);
    }
    selectedApiUrl = String(value);
  }
  const discovery = await discoverPlatform(selectedApiUrl);
  saveDiscoveredPlatform(discovery);
  if (promptedForPlatform) {
    log.step(`Connected to ${discovery.displayName} at ${formatUrl(discovery.apiUrl)}.`);
  }
  return discovery;
}

async function setupCloudflareDeployment(root: string): Promise<void> {
  try {
    await connectCloudflare(root, true);
  } catch (error) {
    log.warn(error instanceof Error ? error.message : String(error));
    note(
      'Run `void connect --platform cloudflare` when you want to finish Cloudflare setup.',
      'Cloudflare deployment',
    );
  }
}

/** Get the dev command for a detected framework. */
function getDevCommand(root: string, framework?: DetectedFramework): string {
  if (!framework) {
    return formatProjectCommand(root, 'vite dev');
  }
  switch (framework.name) {
    case 'nuxt':
      return 'nuxt dev';
    case 'astro':
      return 'astro dev';
    default:
      return formatProjectCommand(root, 'vite dev');
  }
}

function getNodeVersionLine(root: string): string {
  if (existsSync(join(root, '.node-version'))) {
    return 'node-version-file: .node-version';
  }
  return 'node-version: lts/*';
}

// Per-package-manager install + setup steps. `void deploy` always runs through
// the package-manager-appropriate runner in the deploy step below.
function getWorkflowSetupSteps(
  root: string,
  pm: ProjectState['packageManager'],
): { setup: string; install: string; runner: string } {
  const nodeVersion = getNodeVersionLine(root);
  switch (pm) {
    case 'pnpm':
      return {
        setup: `      - uses: pnpm/action-setup@v5
      - uses: actions/setup-node@v6
        with:
          ${nodeVersion}
          cache: pnpm`,
        install: '      - run: pnpm install --frozen-lockfile',
        runner: 'pnpm exec void',
      };
    case 'yarn':
      return {
        setup: `      - uses: actions/setup-node@v6
        with:
          ${nodeVersion}
          cache: yarn`,
        install: '      - run: yarn install --immutable',
        runner: 'yarn void',
      };
    case 'bun':
      return {
        setup: '      - uses: oven-sh/setup-bun@v2',
        install: '      - run: bun install --frozen-lockfile',
        runner: 'bunx void',
      };
    default:
      return {
        setup: `      - uses: actions/setup-node@v6
        with:
          ${nodeVersion}
          cache: npm`,
        install: '      - run: npm ci',
        runner: 'npx void',
      };
  }
}

/**
 * The deploy workflow. Void deploys exchange a GitHub OIDC token (`id-token: write`)
 * at deploy time, so no long-lived token is stored. Without a `slug`, the workflow
 * reads a `vars.VOID_PROJECT` repository variable.
 */
export function getWorkflowYaml(
  root: string,
  pm: ProjectState['packageManager'],
  slug: string | null,
  platform: 'cloudflare' | 'void' = 'void',
  platformApiUrl?: string,
): string {
  const { setup, install, runner } = getWorkflowSetupSteps(root, pm);
  if (platform === 'cloudflare') {
    return `name: Deploy to Cloudflare
on:
  push:
    branches: [main]

concurrency:
  group: void-cloudflare-deploy-\${{ github.repository }}-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
${setup}
${install}
      - name: Deploy
        env:
          # Add this scoped token at Settings → Secrets and variables → Actions.
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          # Required only for PostgreSQL/MySQL provisioning and migrations.
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
          # Required in fresh checkouts when a Worker Version has no preview URL.
          CLOUDFLARE_WORKERS_SUBDOMAIN: \${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}
          # Required only when Cloudflare Access protects Worker readiness.
          CF_ACCESS_CLIENT_ID: \${{ secrets.CF_ACCESS_CLIENT_ID }}
          CF_ACCESS_CLIENT_SECRET: \${{ secrets.CF_ACCESS_CLIENT_SECRET }}
        run: ${runner} deploy --platform cloudflare
`;
  }
  if (!platformApiUrl) {
    throw new Error(
      'init: Connect to a Void platform before generating a deployment workflow. Run `void connect <url>` first.',
    );
  }
  // When the slug is unknown, fall back to a repository variable and prefix the
  // `VOID_PROJECT` line with a comment (each comment line indented to 2 spaces
  // so it stays inside the `env:` mapping and the YAML remains valid).
  const projectLine = slug
    ? `VOID_PROJECT: ${slug}`
    : `# Set a VOID_PROJECT repository variable to your project slug
  # (Settings → Secrets and variables → Actions → Variables).
  VOID_PROJECT: \${{ vars.VOID_PROJECT }}`;
  return `name: Deploy to Void
on:
  push:
    branches: [main]

# Latest push wins: cancel an in-flight deploy for the same repo+branch so a
# newer commit is never overtaken by an older one. Keyed by repo + ref only —
# workflow-level concurrency cannot read the \`env\` context, so VOID_PROJECT is
# not used here (one repo+branch deploys to one project in this scaffold).
concurrency:
  group: void-deploy-\${{ github.repository }}-\${{ github.ref }}
  cancel-in-progress: true

# id-token: write lets the job mint a GitHub OIDC token. No long-lived
# VOID_TOKEN secret is stored — \`void deploy\` mints that OIDC token and
# exchanges it for a short-lived, project-scoped deploy token at deploy time.
permissions:
  id-token: write
  contents: read

env:
  # Override only when intentionally targeting another platform deployment.
  VOID_API_URL: \${{ vars.VOID_API_URL || '${platformApiUrl}' }}
  ${projectLine}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
${setup}
${install}
      - name: Deploy
        run: |
          ${runner} connect "$VOID_API_URL" --no-login
          ${runner} deploy --platform void --project "$VOID_PROJECT"
`;
}

function setupGithubActions(
  root: string,
  state: ProjectState,
  platform: 'cloudflare' | 'void' = 'void',
  platformApiUrl?: string,
): void {
  const workflowDir = join(root, '.github', 'workflows');
  const workflowPath = join(workflowDir, 'void-deploy.yml');

  if (existsSync(workflowPath)) {
    log.warn('void-deploy.yml already exists, skipping');
    return;
  }

  const slug = readProjectConfig(root)?.slug ?? null;

  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    workflowPath,
    getWorkflowYaml(root, state.packageManager, slug, platform, platformApiUrl),
  );
  log.step('Created .github/workflows/void-deploy.yml');

  if (platform === 'cloudflare') {
    note(
      'Pushes to main will deploy through the same readiness-gated Cloudflare path.\n' +
        'Add a scoped CLOUDFLARE_API_TOKEN repository secret; PostgreSQL/MySQL apps also need DATABASE_URL.\n' +
        'Keep cloudflare.account_id in void.config.ts.',
      'GitHub Actions Cloudflare deploy',
    );
  } else if (slug) {
    note(
      `Pushes to main will build and deploy "${slug}" via GitHub OIDC — no token to store.\n` +
        'Connect the repo to your project in the Void dashboard to authorize it.',
      'GitHub Actions OIDC deploy',
    );
  } else {
    note(
      'Pushes to main will build and deploy via GitHub OIDC — no token to store.\n' +
        'Set a VOID_PROJECT repository variable (Settings → Secrets and variables → Actions → Variables)\n' +
        'to your project slug, and connect the repo to your project in the Void dashboard.',
      'GitHub Actions OIDC deploy',
    );
  }
}

/**
 * Replace the `vars.VOID_PROJECT` placeholder in `void-deploy.yml` with a slug
 * linked after the workflow was written. Returns false when there is none.
 */
function patchWorkflowProjectSlug(root: string, slug: string): boolean {
  const workflowPath = join(root, '.github', 'workflows', 'void-deploy.yml');
  if (!existsSync(workflowPath)) {
    return false;
  }
  const yaml = readFileSync(workflowPath, 'utf-8');
  // The placeholder block that `getWorkflowYaml` emits.
  const placeholderBlock =
    '  # Set a VOID_PROJECT repository variable to your project slug\n' +
    '  # (Settings → Secrets and variables → Actions → Variables).\n' +
    '  VOID_PROJECT: ${{ vars.VOID_PROJECT }}';
  if (!yaml.includes(placeholderBlock)) {
    return false;
  }
  writeFileSync(workflowPath, yaml.replace(placeholderBlock, `  VOID_PROJECT: ${slug}`));
  log.step(`Set VOID_PROJECT: ${slug} in .github/workflows/void-deploy.yml`);
  return true;
}

function writeFileIfMissing(root: string, filePath: string, content: string): void {
  const fullPath = join(root, filePath);
  if (existsSync(fullPath)) {
    return;
  }
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  log.step(`Created ${filePath}`);
}

function ensureGitignore(root: string): void {
  const gitignorePath = join(root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, SCAFFOLD_GITIGNORE_LINES.join('\n') + '\n');
    log.step('Created .gitignore');
    return;
  }

  const content = readFileSync(gitignorePath, 'utf-8');
  const existing = new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = SCAFFOLD_GITIGNORE_LINES.filter((line) => !existing.has(line));
  if (missing.length === 0) {
    return;
  }

  const separator = content.endsWith('\n') ? '' : '\n';
  writeFileSync(gitignorePath, content + separator + missing.join('\n') + '\n');
  log.step('Updated .gitignore with Void defaults');
}

/** Removes each block-style top-level `key:` block; `removed` holds its non-blank lines. */
function removeTopLevelYamlBlock(
  yaml: string,
  key: string,
): { yaml: string; removed: Array<string> } {
  const lines = yaml.split(/\r?\n/);
  const next: Array<string> = [];
  const removed: Array<string> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line)) {
      next.push(line);
      continue;
    }

    i += 1;
    while (i < lines.length && (lines[i].trim() === '' || /^(?:\s|-(?:\s|$))/.test(lines[i]))) {
      if (lines[i].trim() !== '') {
        removed.push(lines[i]);
      }
      i += 1;
    }
    i -= 1;
  }
  return { yaml: next.join('\n'), removed };
}

function pnpmAllowBuildsEntryName(line: string): string | undefined {
  return /^\s+(?!#)(["']?)(.+?)\1\s*:(?:\s|$)/.exec(line)?.[2];
}

/**
 * Keeps the existing `allowBuilds` entries as written, approves the legacy
 * `onlyBuiltDependencies` list, and adds each Void default that is missing.
 */
function pnpmAllowBuildsYaml(entries: Array<string>, legacyList: Array<string>): string {
  const legacy = legacyList.flatMap((line) => {
    const name = /^\s*-\s+(["']?)(.+?)\1\s*(?:#.*)?$/.exec(line)?.[2];
    return name === undefined ? [] : [name];
  });
  const decided = new Set([...legacy, ...PNPM_BUILD_DEFAULTS.map(([name]) => name)]);
  const lines = entries.filter((line) => {
    const name = pnpmAllowBuildsEntryName(line);
    return !(name !== undefined && decided.has(name) && line.includes(PNPM_BUILD_PLACEHOLDER));
  });
  const names = new Set(lines.map((line) => pnpmAllowBuildsEntryName(line)));
  const firstEntry = lines.find((line) => pnpmAllowBuildsEntryName(line) !== undefined);
  const indent = /^\s+/.exec(firstEntry ?? '')?.[0] ?? '  ';
  const additions: Array<readonly [string, boolean]> = [
    ...legacy.map((name) => [name, true] as const),
    ...PNPM_BUILD_DEFAULTS,
  ];
  for (const [name, value] of additions) {
    if (!names.has(name)) {
      names.add(name);
      lines.push(`${indent}${/^[\w.-]+$/.test(name) ? name : JSON.stringify(name)}: ${value}`);
    }
  }
  return ['allowBuilds:', ...lines].join('\n');
}

function insertPnpmAllowBuilds(yaml: string, allowBuilds: string): string {
  const trimmed = yaml.trim();
  if (trimmed === '') {
    return `${allowBuilds}\n`;
  }

  const lines = trimmed.split(/\r?\n/);
  const packagesIndex = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
  if (packagesIndex === -1) {
    return `${trimmed}\n\n${allowBuilds}\n`;
  }

  let insertIndex = packagesIndex + 1;
  while (
    insertIndex < lines.length &&
    (lines[insertIndex].trim() === '' || /^\s/.test(lines[insertIndex]))
  ) {
    insertIndex += 1;
  }
  lines.splice(insertIndex, 0, '', ...allowBuilds.split('\n'), '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function resolvePnpmConfigRoot(root: string, pkg: JsonObject): string {
  if (
    existsSync(join(root, 'pnpm-workspace.yaml')) ||
    existsSync(join(root, 'pnpm-lock.yaml')) ||
    parsePackageManagerField(pkg) === 'pnpm'
  ) {
    return root;
  }

  // `hasAncestorPnpmMarkers` also verifies `root` is a declared member.
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot !== undefined && hasAncestorPnpmMarkers(root)) {
    return workspaceRoot;
  }

  return root;
}

function ensurePnpmAllowBuilds(root: string, pkg: JsonObject): void {
  const configRoot = resolvePnpmConfigRoot(root, pkg);
  const workspacePath = join(configRoot, 'pnpm-workspace.yaml');
  const displayPath = configRoot === root ? 'pnpm-workspace.yaml' : relative(root, workspacePath);
  const before = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf-8') : '';
  // A same-line value such as `allowBuilds: {...}` cannot be merged line by
  // line, and a second `allowBuilds:` key would make the file invalid.
  const inline = /^allowBuilds:[ \t]*([^\s#].*)$/m.exec(before)?.[1];
  if (inline !== undefined) {
    const missing = PNPM_BUILD_DEFAULTS.filter(
      ([name]) => !new RegExp(`[{,]\\s*["']?${name}["']?\\s*:`).test(inline),
    );
    if (missing.length > 0) {
      log.warn(
        `Add ${missing.map(([name, value]) => `${name}: ${value}`).join(', ')} to allowBuilds in ${displayPath}. ` +
          'Void only edits allowBuilds when each entry is on its own line.',
      );
    }
    return;
  }

  const legacy = removeTopLevelYamlBlock(before, 'onlyBuiltDependencies');
  const current = removeTopLevelYamlBlock(legacy.yaml, 'allowBuilds');
  const after = insertPnpmAllowBuilds(
    current.yaml,
    pnpmAllowBuildsYaml(current.removed, legacy.removed),
  );
  if (after !== before) {
    writeFileSync(workspacePath, after);
    log.step(`Updated ${displayPath} with approved builds`);
  }
}

export function installProjectDependencies(
  root: string,
  packageManager: ProjectState['packageManager'],
): void {
  const pkg = readPackageJson(root);
  const useVitePlus = pkg !== null && hasPackageDependency(pkg, 'vite-plus');
  const installer = useVitePlus ? 'vp' : packageManager;
  log.step(`Installing dependencies with ${installer}`);

  // Init has just changed the manifest. Refresh the lockfile even when pnpm
  // detects a CI host; subsequent CI builds can use frozen installs normally.
  let command: string = installer;
  let args =
    useVitePlus || packageManager === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install'];
  if (useVitePlus) {
    let localBin: string | undefined;
    try {
      const require = createRequire(join(root, 'package.json'));
      localBin = join(dirname(require.resolve('vite-plus/package.json')), 'bin/vp');
    } catch {
      // The starter's Vite+ dependency has not been installed yet.
    }
    if (localBin) {
      command = process.execPath;
      args = [localBin, ...args];
    } else {
      const probe = spawnSync('vp', ['--version'], {
        cwd: root,
        stdio: 'ignore',
        shell: process.platform === 'win32',
        timeout: 5_000,
      });
      if (probe.status !== 0) {
        // npx void init must also work without a globally installed vp. Avoid
        // asking an older pnpm to switch itself to a pinned native pnpm 12.
        command = 'npx';
        const packageArg = `--package=vite-plus@${SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus']}`;
        args = [
          '--yes',
          // cmd.exe treats the semver caret as an escape outside quotes.
          process.platform === 'win32' ? `"${packageArg}"` : packageArg,
          'vp',
          ...args,
        ];
      }
    }
  }
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: command !== process.execPath && process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${installer} install failed with exit code ${result.status ?? 'unknown'}`);
  }

  log.step(`Installed dependencies with ${installer}`);
}

export function generateStarterMigration(
  root: string,
  starterMode: Exclude<ScaffoldStarterMode, 'static'>,
): void {
  const dialect = starterMode;
  const configPath = writeDrizzleConfig(root, PLACEHOLDER_DB_URL[dialect], dialect);

  const rollBack = snapshotDrizzleOutputs(readProjectPaths(root).migrationsDir);

  log.step('Generating initial Drizzle migration');
  // Adds the Yarn PnP loaders drizzle-kit needs to resolve `void/schema-d1`.
  const result = spawnSync(process.execPath, [drizzleKitBin, 'generate', '--config', configPath], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf-8',
    env: buildDrizzleKitSpawnEnv(root),
  });

  if (result.error || result.status !== 0) {
    rollBack();
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(
      ['Failed to generate the starter database migration.', ...(detail ? [detail] : [])].join(
        '\n\n',
      ),
    );
  }

  log.step('Generated initial Drizzle migration');
}

function scaffoldPagesApp(
  root: string,
  packageManager: ProjectState['packageManager'],
  framework: ScaffoldFramework,
  starterMode: ScaffoldStarterMode,
  toolchain: ScaffoldToolchain,
): boolean {
  const packageJsonPath = join(root, 'package.json');
  const template = createPagesStarterTemplate({
    framework,
    starterMode,
    toolchain,
    voidPackageSpec: resolveScaffoldDependencySpec(root, 'void', getOwnVersion()),
    adapterPackageSpec: resolveScaffoldDependencySpec(
      root,
      SCAFFOLD_FRAMEWORKS[framework].adapterPackage,
      getOwnVersion(),
    ),
  });
  let pkg: JsonObject = {};

  if (existsSync(packageJsonPath)) {
    try {
      pkg = asRecord(JSON.parse(readFileSync(packageJsonPath, 'utf-8'))) ?? {};
    } catch {
      throw new Error('Could not parse package.json in empty project');
    }
  }

  const fallbackName = defaultPackageName(root);
  if (!pkg.name || typeof pkg.name !== 'string') {
    pkg.name = fallbackName;
  }
  if (pkg.private === undefined) {
    pkg.private = true;
  }
  if (!pkg.type) {
    pkg.type = 'module';
  }

  const scripts = asRecord(pkg.scripts) ?? {};
  pkg.scripts = scripts;
  for (const [name, command] of Object.entries(template.scripts)) {
    const existing = scripts[name];
    if (typeof existing !== 'string' || isStarterScriptCommand(existing)) {
      scripts[name] = command;
    }
  }

  const dependencies = asRecord(pkg.dependencies) ?? {};
  const devDependencies = asRecord(pkg.devDependencies) ?? {};
  pkg.dependencies = dependencies;
  pkg.devDependencies = devDependencies;

  let dependencyAdded = false;
  const ensureDependency = (
    group: 'dependencies' | 'devDependencies',
    name: string,
    fallbackVersion: string,
  ) => {
    const otherGroup = group === 'dependencies' ? 'devDependencies' : 'dependencies';
    const targetGroup = group === 'dependencies' ? dependencies : devDependencies;
    const sourceGroup = otherGroup === 'dependencies' ? dependencies : devDependencies;
    const existing = targetGroup[name] ?? sourceGroup[name];
    const selectToolchainVersion =
      toolchain === 'vite-plus' && (name === 'vite' || name === 'vite-plus');
    if (!targetGroup[name] || (selectToolchainVersion && existing !== fallbackVersion)) {
      targetGroup[name] = selectToolchainVersion ? fallbackVersion : (existing ?? fallbackVersion);
      dependencyAdded = true;
    }
    if (sourceGroup[name]) {
      delete sourceGroup[name];
      dependencyAdded = true;
    }
  };

  for (const [name, version] of Object.entries(template.dependencies)) {
    ensureDependency('dependencies', name, version);
  }
  for (const [name, version] of Object.entries(template.devDependencies)) {
    ensureDependency('devDependencies', name, version);
  }

  // `detectProjectState` reads only local markers; `isPnpmProject` also covers
  // pnpm workspace members, which need the root `allowBuilds`.
  if (packageManager === 'pnpm' || isPnpmProject(root, pkg)) {
    ensurePnpmAllowBuilds(root, pkg);
  }

  if (toolchain === 'vite-plus') {
    configureVitePlusScaffold(
      packageManager === 'pnpm' ? resolvePnpmConfigRoot(root, pkg) : root,
      packageManager,
      pkg,
    );
  }

  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
  log.step('Updated package.json with starter scripts and dependencies');

  for (const [filePath, content] of Object.entries(template.files)) {
    writeFileIfMissing(root, filePath, content);
  }

  ensureGitignore(root);
  if (starterMode !== 'static') {
    applyDatabaseDialect(root, starterMode);
  }

  if (starterMode === 'postgresql') {
    const devCommand = getDevCommand(root);
    note(
      `Add DATABASE_URL to .env before running \`${devCommand}\`.\n` +
        'Void uses that direct connection for local PostgreSQL development.',
      'PostgreSQL local dev',
    );
  } else if (starterMode === 'mysql') {
    const devCommand = getDevCommand(root);
    note(
      `Add DATABASE_URL to .env before running \`${devCommand}\`.\n` +
        'Void uses that direct connection for local MySQL development.',
      'MySQL local dev',
    );
  }

  return dependencyAdded;
}

/** Returns whether a dependency was added. */
function ensureExistingProjectPackage(
  root: string,
  options: { plainViteSetup?: boolean } = {},
): boolean {
  const packageJsonPath = join(root, 'package.json');
  const voidSpec = resolveScaffoldDependencySpec(root, 'void', getOwnVersion());
  const plainViteSetup = options.plainViteSetup ?? true;
  let pkg: JsonObject = {};
  let existedBefore = false;

  if (existsSync(packageJsonPath)) {
    existedBefore = true;
    try {
      pkg = asRecord(JSON.parse(readFileSync(packageJsonPath, 'utf-8'))) ?? {};
    } catch {
      throw new Error('Could not parse package.json while configuring Void');
    }
  }

  const fallbackName = defaultPackageName(root);
  let changed = !existedBefore;
  let dependencyAdded = false;

  if (!pkg.name || typeof pkg.name !== 'string') {
    pkg.name = fallbackName;
    changed = true;
  }
  if (!existedBefore && pkg.private === undefined) {
    pkg.private = true;
    changed = true;
  }
  if (!existedBefore && !pkg.type) {
    pkg.type = 'module';
    changed = true;
  }

  if (plainViteSetup) {
    const scripts = asRecord(pkg.scripts) ?? {};
    pkg.scripts = scripts;
    if (typeof scripts.dev !== 'string') {
      scripts.dev = 'vite';
      changed = true;
    }
    if (typeof scripts.build !== 'string') {
      scripts.build = 'vite build';
      changed = true;
    }
  }

  const devDependencies = asRecord(pkg.devDependencies) ?? {};
  pkg.devDependencies = devDependencies;
  if (!hasPackageDependency(pkg, 'void', DEPENDENCY_FIELDS)) {
    devDependencies.void = voidSpec;
    changed = true;
    dependencyAdded = true;
  }
  if (plainViteSetup && !hasPackageDependency(pkg, 'vite', DEPENDENCY_FIELDS)) {
    devDependencies.vite = SCAFFOLD_BASE_DEV_DEPENDENCIES.vite;
    changed = true;
    dependencyAdded = true;
  }

  if (isPnpmProject(root, pkg)) {
    ensurePnpmAllowBuilds(root, pkg);
  }

  if (changed) {
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    log.step(
      existedBefore
        ? plainViteSetup
          ? 'Updated package.json with Void dependencies and Vite scripts'
          : 'Updated package.json with Void dependency'
        : plainViteSetup
          ? 'Created package.json with Void dependencies and Vite scripts'
          : 'Created package.json with Void dependency',
    );
  }

  return dependencyAdded;
}

function getBasicVoidViteConfig(): string {
  return `import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin()],
});
`;
}

function getGeneratedViteConfigPath(root: string): 'vite.config.ts' | 'vite.config.mts' {
  const pkg = readPackageJson(root);
  return pkg?.type === 'module' ? 'vite.config.ts' : 'vite.config.mts';
}

function noteManualViteConfigSetup(configPath?: string): void {
  const target = configPath ?? 'your framework Vite config';
  note(
    `Could not safely update ${target} automatically.\n\n` +
      `Add \`voidPlugin()\` to the top-level Vite plugins array:\n\n` +
      `import { voidPlugin } from "void";\n\n` +
      `export default defineConfig({\n` +
      `  plugins: [voidPlugin()],\n` +
      `});`,
    'Manual Vite config step',
  );
}

function noteManualFrameworkConfigSetup(framework: DetectedFramework): void {
  if (framework.name === 'astro') {
    note(
      `Detected Astro. Void init does not patch astro.config.* automatically.\n\n` +
        `Add \`voidPlugin()\` to the Astro Vite plugins option:\n\n` +
        `import { voidPlugin } from "void";\n\n` +
        `export default defineConfig({\n` +
        `  vite: { plugins: [voidPlugin()] },\n` +
        `});`,
      'Manual Astro config step',
    );
    return;
  }

  if (framework.name === 'nuxt') {
    note(
      `Detected Nuxt. Void init does not patch nuxt.config.* automatically.\n\n` +
        `Add \`voidPlugin()\` to the Nuxt Vite plugins option, the \`@schema\` alias that \`nuxi typecheck\` reads, and the Cloudflare preset, \`void/nitro\` and the generated Cloudflare config to the Nitro options:\n\n` +
        `import { resolve } from "node:path";\n` +
        `import { voidPlugin } from "void";\n\n` +
        `export default defineNuxtConfig({\n` +
        `  alias: {\n` +
        `    "@schema": resolve(import.meta.dirname, "db/schema.ts"),\n` +
        `  },\n` +
        `  nitro: {\n` +
        `    preset: "cloudflare-module",\n` +
        `    modules: ["void/nitro"],\n` +
        `    cloudflare: { dev: { configPath: "./.void-wrangler.jsonc" } },\n` +
        `  },\n` +
        `  vite: { plugins: [voidPlugin()] },\n` +
        `});`,
      'Manual Nuxt config step',
    );
    return;
  }

  if (framework.name === 'analog') {
    note(
      `Detected Analog. Void init does not patch vite.config.* automatically.\n\n` +
        `Install \`nitro-cloudflare-dev\` as a dev dependency. Add \`voidPlugin()\` to the Vite plugins, and the Cloudflare preset, \`void/nitro\` and the generated Cloudflare config to Analog's Nitro options:\n\n` +
        `import analog from "@analogjs/platform";\n` +
        `import { voidPlugin } from "void";\n\n` +
        `export default defineConfig({\n` +
        `  plugins: [\n` +
        `    analog({\n` +
        `      ssr: true,\n` +
        `      nitro: {\n` +
        `        preset: "cloudflare-module",\n` +
        `        modules: ["nitro-cloudflare-dev", "void/nitro"],\n` +
        `        cloudflareDev: { configPath: "./.void-wrangler.jsonc" },\n` +
        `      },\n` +
        `    }),\n` +
        `    voidPlugin(),\n` +
        `  ],\n` +
        `});`,
      'Manual Analog config step',
    );
    return;
  }

  noteManualViteConfigSetup();
}

function ensureExistingProjectViteConfig(root: string, framework?: DetectedFramework): void {
  if (framework?.class === 'c') {
    noteManualFrameworkConfigSetup(framework);
    return;
  }

  const configPath = findViteConfig(root);
  if (!configPath) {
    writeFileIfMissing(root, getGeneratedViteConfigPath(root), getBasicVoidViteConfig());
    return;
  }

  const fullPath = join(root, configPath);
  const original = readFileSync(fullPath, 'utf-8');
  const updated = patchViteConfigWithVoidPlugin(configPath, original);
  if (updated === undefined) {
    noteManualViteConfigSetup(configPath);
    return;
  }
  if (updated === original) {
    log.info(`${configPath} already includes voidPlugin()`);
    return;
  }

  writeFileSync(fullPath, updated);
  log.step(`Added voidPlugin() to ${configPath}`);
}

/** Returns whether a dependency was added. */
function setupExistingProject(root: string, framework?: DetectedFramework): boolean {
  log.info('Existing project detected. Configuring Void...');
  const dependencyAdded = ensureExistingProjectPackage(root, {
    plainViteSetup: framework?.class !== 'c',
  });
  ensureExistingProjectViteConfig(root, framework);
  return dependencyAdded;
}

/** The demo `posts` table for the database dialect that init configured. */
function demoSchemaSource(dialect: DatabaseDialect): string {
  if (dialect === 'postgresql') {
    return `import { pgTable, serial, text, timestamp } from "void/schema-pg";

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
`;
  }

  if (dialect === 'mysql') {
    return `import { int, mysqlTable, text, timestamp } from "void/schema-mysql";

export const posts = mysqlTable("posts", {
  id: int("id").autoincrement().primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
`;
  }

  return `import { sql } from "void/db";
import { integer, sqliteTable, text } from "void/schema-d1";

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull().default(sql\`(datetime('now'))\`),
});
`;
}

/**
 * Scaffolds the "SQL → types → handler → fetch" demo into an existing project.
 * `setupExistingProject` has already declared `void` in `package.json`.
 */
function scaffoldDemo(root: string, dialect: DatabaseDialect): void {
  const devCommand = getDevCommand(root);
  const paths = readProjectPaths(root);

  mkdirSync(paths.dbDir, { recursive: true });
  writeFileSync(paths.schemaFile, demoSchemaSource(dialect));
  log.step('Created db/schema.ts');

  // API route
  mkdirSync(join(paths.routesDir, 'api'), { recursive: true });
  writeFileSync(
    join(paths.routesDir, 'api', 'posts.ts'),
    `import { defineHandler } from "void";
import { db } from "void/db";
import { posts } from "@schema";

// GET /api/posts — returns all posts, fully typed from migration schema
export const GET = defineHandler(async () => {
  return db.select().from(posts);
});
`,
  );
  log.step('Created routes/api/posts.ts');
  ensureProjectTsconfig(root, undefined, true, true, { paths });

  // Frontend demo
  mkdirSync(paths.ssrDir, { recursive: true });
  writeFileSync(
    join(paths.ssrDir, 'demo.ts'),
    `import { fetch } from "void/client";

// Fully typed: response type is inferred from the GET handler's return type,
// which is derived from the migration schema. No manual types needed.
const posts = await fetch("/api/posts");

console.log(posts);
// posts[0].title  ← string (type-checked)
// posts[0].body   ← string (type-checked)
// posts[0].nope   ← TypeScript error
`,
  );
  log.step('Created src/demo.ts');

  note(
    'SQL migration → DB types → Route handler → Route types → Typed fetch\n\n' +
      `Run \`${devCommand}\` and open src/demo.ts to see the types in action.\n` +
      'Try changing the migration or handler — types update automatically.',
    'Type Safety Demo',
  );
}

const MARKER_VERSION_SOURCE =
  String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?` +
  String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const MARKER_CLOSE = '<!--/injected-by-void-->';
const MARKER_BLOCK_RE = new RegExp(
  String.raw`^<!--injected-by-void-v${MARKER_VERSION_SOURCE}-->\r?\n[\s\S]*?^<!--\/injected-by-void-->\r?$`,
  'm',
);

async function injectAgentBlock(root: string, newProject: boolean): Promise<void> {
  const filePath = 'AGENTS.md';
  const fullPath = join(root, filePath);
  const version = getOwnVersion();
  const template = readFileSync(join(getPackageDir(), 'AGENTS_TEMPLATE.md'), 'utf-8');
  const openMarker = `<!--injected-by-void-v${version}-->`;
  const block = `${openMarker}\n${template}\n${MARKER_CLOSE}`;
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : null;
  const managedBlock = existing?.match(MARKER_BLOCK_RE);
  if (managedBlock?.[0] === block) {
    log.info(`${filePath} already has Void instructions (v${version})`);
    return;
  }

  if (!newProject) {
    if (process.env.CI || !process.stdin.isTTY) {
      log.info(
        `Skipping ${filePath} setup without an interactive terminal; read node_modules/void/docs/.`,
      );
      return;
    }
    const accepted = await confirm({
      message: managedBlock
        ? 'Update Void instructions in AGENTS.md?'
        : existing !== null
          ? 'Append Void instructions to AGENTS.md?'
          : 'Create AGENTS.md with Void instructions?',
      initialValue: true,
    });
    if (isCancel(accepted)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }
    if (!accepted) {
      return;
    }
  }

  if (existing !== null) {
    if (managedBlock) {
      const updated = existing.replace(MARKER_BLOCK_RE, block);
      writeFileSync(fullPath, updated);
      log.step(`Updated Void instructions in ${filePath}`);
    } else {
      // Append block to end of file
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      writeFileSync(fullPath, existing + separator + block + '\n');
      log.step(`Added Void instructions to ${filePath}`);
    }
  } else {
    writeFileSync(fullPath, block + '\n');
    log.step(`Created ${filePath} with Void instructions`);
  }
}

export async function runInitCommand(root: string, initArgs?: InitArgs): Promise<void> {
  console.log();

  const targeted = Boolean(initArgs && (initArgs.tsconfig || initArgs.github));
  if (!targeted) {
    root = await resolveInitRoot(root);
  }
  const newProject = isScaffoldableEmptyProject(root) && !existsSync(join(root, 'AGENTS.md'));
  const hadTypedConfig = existsSync(join(root, TYPED_CONFIG_FILE));
  if (migrateLegacyVoidConfig(root)) {
    log.step(
      'Migrated project configuration to void.config.ts. Commit void.config.ts and void.lock.json.',
    );
  }
  const workspaceSubpackage = isInsideWorkspaceSubpackage(root);
  if (workspaceSubpackage && initArgs?.git !== undefined) {
    throw new Error(
      'init: The --git/--no-git options are not available when adding a package to an existing monorepo.',
    );
  }
  const gitInitialized =
    !workspaceSubpackage && (!targeted || initArgs?.git !== undefined)
      ? await setupGit(root, initArgs?.git)
      : false;
  const framework = detectFramework(root);
  const preScaffoldState = detectProjectState(root);
  const detectedPagesFramework = detectPagesFramework(root);
  let scaffoldedPagesFramework: ScaffoldFramework | undefined;
  let scaffoldedStarterMode: Exclude<ScaffoldStarterMode, 'static'> | undefined;
  let didScaffoldStarter = false;
  let scaffoldAddedDependencies = false;
  let workspaceSubpackageSkip = false;

  if (framework) {
    log.info(`Detected ${framework.name} framework`);
  }

  if (!targeted && !framework && isScaffoldableEmptyProject(root)) {
    log.info('Empty project detected. Scaffolding a Pages starter...');
    const scaffoldToolchain = await promptScaffoldToolchain();
    if (detectedPagesFramework) {
      scaffoldedPagesFramework = detectedPagesFramework;
      log.info(
        `Detected ${SCAFFOLD_FRAMEWORKS[detectedPagesFramework].label} adapter in package.json`,
      );
    } else {
      scaffoldedPagesFramework = await promptScaffoldFramework();
    }
    const starterMode = await promptStarterMode();
    const existingPackageJson = readPackageJson(root);
    const hasPackageManager =
      hasLocalLockfile(root) ||
      existsSync(join(root, 'pnpm-workspace.yaml')) ||
      parsePackageManagerField(existingPackageJson) !== undefined ||
      resolveWorkspaceDeferral(root, existingPackageJson) !== undefined;
    const scaffoldPackageManager =
      scaffoldToolchain === 'vite-plus' && !hasPackageManager
        ? 'pnpm'
        : preScaffoldState.packageManager;
    const scaffoldWroteDeps = scaffoldPagesApp(
      root,
      scaffoldPackageManager,
      scaffoldedPagesFramework,
      starterMode,
      scaffoldToolchain,
    );

    // A workspace member installs from the workspace root: a leaf install would
    // leave a stray lockfile or reject `workspace:` specs, and drizzle-kit needs
    // the installed deps for the starter migration.
    const deferral = resolveWorkspaceDeferral(root, readPackageJson(root));
    const voidResolvable = isVoidResolvableFrom(root);
    if (deferral && (!voidResolvable || scaffoldWroteDeps)) {
      workspaceSubpackageSkip = true;
      const relRoot = relative(deferral.workspaceRoot, root) || '.';
      // The static starter has no database schema to generate from.
      const dbFollowUp =
        starterMode === 'static'
          ? ''
          : `\nthen run \`void db generate\` from ./${relRoot} to create the initial migration.`;
      note(
        `Scaffolded the Pages starter in ./${relRoot}.\n\n` +
          `Run your workspace install from ${deferral.workspaceRoot} to pick up the new dependencies.${dbFollowUp}`,
        'Workspace subpackage',
      );
    } else if (scaffoldWroteDeps || !voidResolvable) {
      scaffoldAddedDependencies = true;
    }
    if (starterMode !== 'static') {
      scaffoldedStarterMode = starterMode;
    }
    didScaffoldStarter = true;
  }

  const state = detectProjectState(root);
  const pagesFramework = scaffoldedPagesFramework ?? detectPagesFramework(root);

  if (!targeted && !didScaffoldStarter) {
    const dependencyAdded = setupExistingProject(root, framework);
    const voidResolvable = isVoidResolvableFrom(root);
    if (dependencyAdded || !voidResolvable) {
      const deferral = resolveWorkspaceDeferral(root, readPackageJson(root));
      if (deferral) {
        workspaceSubpackageSkip = true;
        const relRoot = relative(deferral.workspaceRoot, root) || '.';
        note(
          `Configured Void in ./${relRoot}.\n\n` +
            `Run your workspace install from ${deferral.workspaceRoot} to sync the lockfile and pick up the updated dependencies.\n` +
            `If this init flow scaffolds database files, then run \`void db generate\` from ./${relRoot}.`,
          'Workspace subpackage',
        );
      } else {
        scaffoldAddedDependencies = true;
      }
    }
  }

  if (!targeted || initArgs?.tsconfig) {
    state.typescriptWanted = true;
    setupTsconfig(root, state, pagesFramework);
  }

  // Generate .void/tsconfig.json so the root tsconfig can extend it
  if (state.typescriptWanted) {
    const hasSchema = hasDrizzleSchema(root);
    ensureProjectTsconfig(root, undefined, hasSchema, hasSchema);
  }

  ensureGitignore(root);

  if (!targeted) {
    ensureVoidWorkerCompatibilityDate(root);
  }

  if (framework) {
    setupWranglerConfig(root, framework);
  }
  if (!hadTypedConfig) {
    migrateFrameworkAdapterPaths(root);
  }

  if (!targeted && !didScaffoldStarter) {
    applyDatabaseSetup(root, await promptDatabaseSetup(root));
  }

  // Agent instructions and skills are part of every init.
  await injectAgentBlock(root, newProject);

  const agents = detectAgents(root);
  if (agents.length > 0) {
    const { linkSkillsForSpecificAgents } = await import('./skills.ts');
    linkSkillsForSpecificAgents(root, agents);
  } else {
    log.info('Bundled Void docs: node_modules/void/docs/');
  }

  // Demo code only in the full flow, and not for meta-frameworks.
  if (!targeted && !framework) {
    if (didScaffoldStarter || state.hasRoutes || state.hasMigrations || state.hasPages) {
      log.info('Project already has pages, routes, or migrations, skipping demo');
    } else {
      const scaffold = await confirm({
        message: 'Scaffold demo code? (migration + API route + frontend fetch)',
      });
      if (isCancel(scaffold)) {
        cancel('Setup cancelled.');
        process.exit(0);
      }
      if (scaffold) {
        // Read the dialect from config, as later `void db` commands do.
        const demoDialect = getDatabaseDialect(readConfig(root));
        scaffoldDemo(root, demoDialect);
        // The existing-project step already queued any install or workspace deferral the demo needs.
        const voidResolvable = isVoidResolvableFrom(root);
        const deferral = resolveWorkspaceDeferral(root, readPackageJson(root));
        if (deferral && !voidResolvable) {
          const relRoot = relative(deferral.workspaceRoot, root) || '.';
          note(
            `Scaffolded the starter demo in ./${relRoot}.\n\n` +
              `Run your workspace install from ${deferral.workspaceRoot} to pick up the new \`void\` dep,\n` +
              `then run \`void db generate\` from ./${relRoot} to create the initial migration.`,
            'Workspace subpackage',
          );
        }
        scaffoldedStarterMode = demoDialect;
      }
    }
  }

  // Targeted runs keep the saved deployment preference without prompting.
  const deploymentPlatform = !targeted
    ? await promptDeploymentPlatform(root)
    : readDeploymentPlatform(root);
  let voidPlatformDiscovery: PlatformDiscoveryDocument | null = null;

  if (!targeted && deploymentPlatform === 'cloudflare') {
    await setupCloudflareDeployment(root);
  }
  if (!targeted && deploymentPlatform === 'void') {
    voidPlatformDiscovery = await ensureVoidPlatformConnection(root);
  }

  // GitHub reads workflows only from the repository root, so skip every
  // workspace member, even one that manages its own install.
  let shouldSetupGithub = targeted ? initArgs?.github === true : deploymentPlatform !== 'none';
  if (
    shouldSetupGithub &&
    !workspaceSubpackage &&
    deploymentPlatform !== 'cloudflare' &&
    deploymentPlatform !== 'none'
  ) {
    if (!voidPlatformDiscovery) {
      const { getApiUrl } = await import('./auth.ts');
      voidPlatformDiscovery = await discoverPlatform(getApiUrl(root));
    }
    if (!voidPlatformDiscovery.capabilities.githubActions) {
      const message = `${voidPlatformDiscovery.displayName} does not support GitHub Actions deployments.`;
      if (targeted) {
        throw new Error(`init: ${message}`);
      }
      log.info(`${message} Skipping workflow setup.`);
      shouldSetupGithub = false;
    }
  }
  if (shouldSetupGithub && !workspaceSubpackage) {
    if (targeted) {
      // --github flag: run directly without prompting
      setupGithubActions(
        root,
        state,
        deploymentPlatform === 'cloudflare' ? 'cloudflare' : 'void',
        voidPlatformDiscovery?.apiUrl,
      );
    } else {
      const setupGha = await confirm({
        message: 'Create .github/workflows/void-deploy.yml to deploy on pushes to main?',
      });
      if (isCancel(setupGha)) {
        cancel('Setup cancelled.');
        process.exit(0);
      }
      if (setupGha) {
        setupGithubActions(
          root,
          state,
          deploymentPlatform === 'cloudflare' ? 'cloudflare' : 'void',
          voidPlatformDiscovery?.apiUrl,
        );
      }
    }
  } else if (workspaceSubpackage && shouldSetupGithub) {
    log.info(
      'Skipping GitHub Actions setup: workflow files must live at the repo root, not in a workspace subpackage.',
    );
  }

  if (!targeted) {
    const scaffoldResult = maybeScaffoldEnvTs(root);
    if (scaffoldResult.written) {
      const rel = relative(root, scaffoldResult.written) || 'env.ts';
      if (scaffoldResult.entries.length > 0) {
        log.step(`Scaffolded ${rel} from .env — review inferred types before running dev.`);
      } else {
        log.step(`Created empty ${rel} — add your env keys with \`defineEnv({...})\`.`);
      }
    }
  }

  if (scaffoldAddedDependencies) {
    installProjectDependencies(root, state.packageManager);
  }
  if (scaffoldedStarterMode && !workspaceSubpackageSkip) {
    generateStarterMigration(root, scaffoldedStarterMode);
  }

  if (!targeted && deploymentPlatform === 'void') {
    const linked = await maybeSetupDeployProject(root);
    // The workflow was written before linking, with a placeholder slug.
    if (linked?.slug) {
      patchWorkflowProjectSlug(root, linked.slug);
    }
  }

  if (gitInitialized) {
    log.info(`Git (optional): ${initialCommitCommand(root)}`);
  }

  if (workspaceSubpackageSkip) {
    // The dev command cannot run before the workspace install.
    if (scaffoldedStarterMode) {
      printSuccess(
        'Project initialized. Run your workspace install, then `void db generate` to finish setup.',
      );
    } else {
      printSuccess('Project initialized. Run your workspace install to finish setup.');
    }
  } else {
    printSuccess(
      `Project initialized. Run \`${getDevCommand(root, framework)}\` to start developing.`,
    );
  }
}
