import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import { applyMySqlAuthMigrations, mysqlMigrationRunner } from './auth-migrations.ts';
import {
  createVoidAuthRuntime,
  resolveConnectionString,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from './better-auth-shared.ts';

async function applyMigrations(
  env: VoidAuthEnv,
  migrationSchema: VoidAuthMigrationSchema,
): Promise<void> {
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection({
    uri: resolveConnectionString(env, 'MySQL'),
    disableEval: true,
  });
  try {
    await applyMySqlAuthMigrations(mysqlMigrationRunner(connection), migrationSchema);
  } finally {
    await connection.end();
  }
}

const runtime = createVoidAuthRuntime('mysql', applyMigrations);

export const resolveVoidAuthState: VoidAuthRuntimeApi['resolveVoidAuthState'] =
  runtime.resolveVoidAuthState;
export const runVoidAuthMiddleware: VoidAuthRuntimeApi['runVoidAuthMiddleware'] =
  runtime.runVoidAuthMiddleware;
export const handleVoidAuthRequest: VoidAuthRuntimeApi['handleVoidAuthRequest'] =
  runtime.handleVoidAuthRequest;
export const runVoidAuthMigrations: VoidAuthRuntimeApi['runVoidAuthMigrations'] =
  runtime.runVoidAuthMigrations;
