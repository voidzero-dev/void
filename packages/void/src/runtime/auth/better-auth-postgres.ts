import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import { applyPgAuthMigrations, pgMigrationRunner } from './auth-migrations.ts';
import {
  createVoidAuthRuntime,
  resolveConnectionString,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from './better-auth-shared.ts';
import { disablePgPassFallback } from './pg.ts';

async function applyMigrations(
  env: VoidAuthEnv,
  migrationSchema: VoidAuthMigrationSchema,
): Promise<void> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: resolveConnectionString(env, 'PostgreSQL') });
  disablePgPassFallback(client);
  await client.connect();
  try {
    await applyPgAuthMigrations(pgMigrationRunner(client), migrationSchema);
  } finally {
    await client.end();
  }
}

const runtime = createVoidAuthRuntime('postgresql', applyMigrations);

export const resolveVoidAuthState: VoidAuthRuntimeApi['resolveVoidAuthState'] =
  runtime.resolveVoidAuthState;
export const runVoidAuthMiddleware: VoidAuthRuntimeApi['runVoidAuthMiddleware'] =
  runtime.runVoidAuthMiddleware;
export const handleVoidAuthRequest: VoidAuthRuntimeApi['handleVoidAuthRequest'] =
  runtime.handleVoidAuthRequest;
export const runVoidAuthMigrations: VoidAuthRuntimeApi['runVoidAuthMigrations'] =
  runtime.runVoidAuthMigrations;
