import { existsSync, readFileSync } from 'node:fs';
import {
  type AliasOptions,
  isRunnableDevEnvironment,
  loadConfigFromFile,
  parseSync,
  runnerImport,
  type ViteDevServer,
} from 'vite';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import type { VoidAuthConfig } from '../runtime/auth.ts';
import type { AstNode, AstProgram } from '../shared/ast.ts';

function isVoidAuthConfigSource(code: string, filename: string): boolean {
  if (!code.includes('void/auth')) {
    return false;
  }
  let program: AstProgram;
  try {
    program = parseSync(filename, code).program as unknown as AstProgram;
  } catch {
    return false;
  }
  return (program.body ?? []).some((node: AstNode) => {
    if (
      node.type !== 'ImportDeclaration' &&
      node.type !== 'ExportNamedDeclaration' &&
      node.type !== 'ExportAllDeclaration'
    ) {
      return false;
    }
    return (node.source as { value?: unknown } | undefined)?.value === 'void/auth';
  });
}

export function findVoidAuthConfig(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): string | null {
  for (const absPath of paths.authConfigCandidates) {
    if (!existsSync(absPath)) {
      continue;
    }
    const code = readFileSync(absPath, 'utf-8');
    if (isVoidAuthConfigSource(code, absPath)) {
      return absPath;
    }
  }
  return null;
}

/**
 * The dev server evaluates the auth config in this Node environment. A native
 * `import()` would keep the first evaluation for the life of the process; the
 * module runner reads the config again once its files are invalidated, and the
 * module graph lists the local files the config imports.
 */
export const AUTH_CONFIG_ENVIRONMENT = 'void_auth_config';

export type ModuleImporter = (path: string) => Promise<Record<string, unknown>>;

/** The dev server's importer for the auth config, when it has the environment. */
export function devAuthConfigImporter(server: ViteDevServer): ModuleImporter | undefined {
  const environment = server.environments[AUTH_CONFIG_ENVIRONMENT];
  return environment && isRunnableDevEnvironment(environment)
    ? (path) => environment.runner.import(path)
    : undefined;
}

/**
 * Builds and CLI commands evaluate the auth config once in a throwaway module
 * runner, so its imports resolve as in dev: without file extensions and through
 * the app's aliases. A native `import()` resolves neither.
 */
export function viteAuthConfigImporter(
  root: string,
  mode: string | undefined,
  resolve: { alias?: AliasOptions; tsconfigPaths?: boolean } | undefined,
): ModuleImporter {
  return async (path) => {
    const { module } = await runnerImport<Record<string, unknown>>(path, {
      root,
      mode,
      logLevel: 'silent',
      resolve: { alias: resolve?.alias, tsconfigPaths: resolve?.tsconfigPaths },
    });
    return module;
  };
}

/** The importer for commands outside Vite, with the aliases of the app's Vite config. */
export function projectAuthConfigImporter(root: string): ModuleImporter {
  return async (path) => {
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'development' },
      undefined,
      root,
      'silent',
    );
    return viteAuthConfigImporter(root, 'development', loaded?.config.resolve)(path);
  };
}

/** Evaluate the auth config through the importer of the current command. */
export async function loadVoidAuthConfig(
  configPath: string | null,
  importModule: ModuleImporter,
): Promise<VoidAuthConfig | undefined> {
  if (!configPath) {
    return undefined;
  }
  const mod = await importModule(configPath);
  // The Worker imports only the default export.
  if (!Object.hasOwn(mod, 'default')) {
    throw new Error(
      `${configPath} has no default export. Export the auth config with \`export default defineAuth(...)\`.`,
    );
  }
  return mod.default as VoidAuthConfig | undefined;
}
