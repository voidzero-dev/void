import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import { applySqliteAuthMigrations } from './auth-migrations.ts';
import {
  createVoidAuthRuntime,
  type VoidAuthEnv,
  type VoidAuthRuntimeApi,
} from './better-auth-shared.ts';

async function applyMigrations(
  env: VoidAuthEnv,
  migrationSchema: VoidAuthMigrationSchema,
): Promise<void> {
  const database = env.DB;
  if (!database) {
    throw new Error('auth: Better Auth requires the "DB" D1 binding for sqlite apps.');
  }

  await applySqliteAuthMigrations(
    {
      async all<T extends Record<string, unknown>>(sql: string) {
        const result = await database.prepare(sql).all();
        return (result.results ?? []) as Array<T>;
      },
      async run(sql: string) {
        await database.prepare(sql).run();
      },
    },
    migrationSchema,
  );
}

const runtime = createVoidAuthRuntime('sqlite', applyMigrations);

export const resolveVoidAuthOptions: VoidAuthRuntimeApi['resolveVoidAuthOptions'] =
  runtime.resolveVoidAuthOptions;
export const resolveVoidAuthState: VoidAuthRuntimeApi['resolveVoidAuthState'] =
  runtime.resolveVoidAuthState;
export const runVoidAuthMiddleware: VoidAuthRuntimeApi['runVoidAuthMiddleware'] =
  runtime.runVoidAuthMiddleware;
export const handleVoidAuthRequest: VoidAuthRuntimeApi['handleVoidAuthRequest'] =
  runtime.handleVoidAuthRequest;
export const runVoidAuthMigrations: VoidAuthRuntimeApi['runVoidAuthMigrations'] =
  runtime.runVoidAuthMigrations;
