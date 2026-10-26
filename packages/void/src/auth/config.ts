import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isRunnableDevEnvironment, parseSync, type ViteDevServer } from 'vite';
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
 * Evaluate the auth config. A native `import()` keeps its first evaluation for
 * the life of the process, which suits one-off commands; the dev server passes
 * its module runner.
 */
export async function loadVoidAuthConfig(
  configPath: string | null,
  importModule: ModuleImporter = (path) => import(pathToFileURL(path).href),
): Promise<VoidAuthConfig | undefined> {
  if (!configPath) {
    return undefined;
  }
  const mod = await importModule(configPath);
  return (mod.default ?? mod.auth ?? mod.config) as VoidAuthConfig | undefined;
}
