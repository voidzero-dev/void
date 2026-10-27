import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'pathslash';
import { analyzeApplication } from '../application-routing.ts';
import { loadVoidAuthConfig, projectAuthConfigImporter } from '../auth/config.ts';
import { generateVoidAuthDatabaseModule, generateVoidAuthDrizzleSchema } from '../auth/drizzle.ts';
import { getDatabaseCasing, readConfig } from '../config.ts';
import { discoverSchema } from '../drizzle/discover.ts';
import { loadLocalEnv } from '../shared/env.ts';
import { generateDbDts } from './db-types.ts';
import { findEnvFileForPaths, generateEnvTypes } from './env-types.ts';
import { ensureProjectTsconfig } from './project-tsconfig.ts';
import { generateQueueTypes } from './queue-types.ts';
import { generateRouteTypes } from './route-types.ts';
import { writeFileIfChanged } from './write-if-changed.ts';

export type PrepareProjectResult = {
  written: Array<string>;
  removed: Array<string>;
};

function writeGeneratedFile(
  outDir: string,
  fileName: string,
  content: string,
  written: Array<string>,
): void {
  if (writeFileIfChanged(join(outDir, fileName), content)) {
    written.push(join('.void', fileName));
  }
}

function removeGeneratedFile(outDir: string, fileName: string, removed: Array<string>): void {
  const filePath = join(outDir, fileName);
  if (!existsSync(filePath)) {
    return;
  }
  rmSync(filePath, { force: true });
  removed.push(join('.void', fileName));
}

export async function prepareProject(root: string): Promise<PrepareProjectResult> {
  const config = readConfig(root);
  const analysis = await analyzeApplication(root, { config });
  const { paths, authConfigPath, authEnabled, dialect, scan } = analysis;
  const outDir = join(root, '.void');
  const written: Array<string> = [];
  const removed: Array<string> = [];

  const envFile = findEnvFileForPaths(root, paths);
  if (envFile) {
    const { dts } = generateEnvTypes(envFile, outDir);
    writeGeneratedFile(outDir, 'env.d.ts', dts, written);
  } else {
    removeGeneratedFile(outDir, 'env.d.ts', removed);
  }

  const hasRouteTypes =
    scan.routes.length > 0 || (scan.websockets?.length ?? 0) > 0 || scan.pages.pages.length > 0;
  if (hasRouteTypes) {
    const { dts } = generateRouteTypes(scan, paths.routesDir, outDir, paths.pagesDir);
    writeGeneratedFile(outDir, 'routes.d.ts', dts, written);
  } else {
    removeGeneratedFile(outDir, 'routes.d.ts', removed);
  }

  // .void/tsconfig.json lists queues.d.ts whenever the queues directory exists,
  // so write it then, even with no queue files.
  if (existsSync(paths.queuesDir)) {
    const dts = generateQueueTypes(scan.queues, paths.queuesDir, outDir);
    writeGeneratedFile(outDir, 'queues.d.ts', dts, written);
  } else {
    removeGeneratedFile(outDir, 'queues.d.ts', removed);
  }

  const schema = discoverSchema(root, paths);
  // Matches the Vite plugin, which serves its own `void/db` for `database.casing`.
  const hasDbRuntime = schema != null || authEnabled || getDatabaseCasing(config) !== undefined;
  if (hasDbRuntime) {
    if (generateDbDts(outDir, schema, dialect)) {
      written.push(join('.void', 'db.d.ts'));
    }
  } else {
    removeGeneratedFile(outDir, 'db.d.ts', removed);
  }

  if (authEnabled) {
    const authRuntime = {
      dialect,
      providers: config.auth?.providers ?? null,
      userConfig: await loadVoidAuthConfig(authConfigPath, projectAuthConfigImporter(root)),
    };
    const env = { ...loadLocalEnv(root), ...process.env } as Record<string, unknown>;
    const schemaPath = join(outDir, 'better-auth-schema.ts');
    const databasePath = join(outDir, 'better-auth-db.ts');
    const drizzleAdapterPath = fileURLToPath(import.meta.resolve('better-auth/adapters/drizzle'));

    if (writeFileIfChanged(schemaPath, generateVoidAuthDrizzleSchema(authRuntime, env))) {
      written.push(join('.void', 'better-auth-schema.ts'));
    }
    if (
      writeFileIfChanged(
        databasePath,
        generateVoidAuthDatabaseModule({
          dialect,
          schemaImportPath: schemaPath,
          drizzleAdapterPath,
        }),
      )
    ) {
      written.push(join('.void', 'better-auth-db.ts'));
    }
  } else {
    removeGeneratedFile(outDir, 'better-auth-schema.ts', removed);
    removeGeneratedFile(outDir, 'better-auth-db.ts', removed);
  }

  if (ensureProjectTsconfig(root, hasRouteTypes, hasDbRuntime, schema != null, { paths })) {
    written.push(join('.void', 'tsconfig.json'));
  }

  return { written, removed };
}
