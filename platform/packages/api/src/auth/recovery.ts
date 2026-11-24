import { platformAuthenticationRecoveryMessage } from '@void/platform';
import type { PlatformAuthenticationRecovery } from '@void/platform';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { users } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import { requireUncachedAuthenticationDatabase } from './bootstrap.ts';
import { hmacVerifyState } from './hmac.ts';

/** Only the ownership-verified CLI can insert this capability using the original recovery key. */
export async function validateRecoveryTest(
  db: Db,
  env: ApiEnv['Bindings'],
  recovery: PlatformAuthenticationRecovery | undefined,
  attempt: { connection_id: string; revision: number; generation: number },
  testId: string | undefined,
  userId: string,
): Promise<boolean> {
  if (
    !recovery ||
    !env.PLATFORM_INSTALLATION_ID ||
    recovery.installationId !== env.PLATFORM_INSTALLATION_ID ||
    recovery.administratorUserId !== userId ||
    recovery.connectionId !== attempt.connection_id ||
    recovery.revision !== attempt.revision ||
    recovery.generation !== attempt.generation ||
    recovery.testId !== testId ||
    typeof recovery.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(recovery.expiresAt)) ||
    Date.parse(recovery.expiresAt) <= Date.now() ||
    Date.parse(recovery.expiresAt) > Date.now() + 10 * 60 * 1000 ||
    typeof recovery.signature !== 'string'
  ) {
    return false;
  }
  requireUncachedAuthenticationDatabase(env);
  if (
    !(await hmacVerifyState(
      platformAuthenticationRecoveryMessage(recovery),
      recovery.signature,
      env.JWT_SECRET,
    ))
  ) {
    return false;
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return !!user && user.role === 'admin' && !isAdminSuspended(user.suspended_reason);
}
