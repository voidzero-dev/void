import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import { getPlatformSetting } from '../platform-settings.ts';
import { ZeroTrustUnavailableError } from './errors.ts';
import { markProjectError } from './state.ts';

/**
 * Written by platform uninstall while it holds the configuration lock, after
 * its final check. Mirrored in packages/void/src/cli/platform-zero-trust-uninstall.ts.
 */
export const PLATFORM_UNINSTALL_SETTING = 'platform.uninstall';

/**
 * The installation configuration lock. Project creation and mutations,
 * deployments and route publication hold it shared; installation operations
 * take it exclusive to claim, checkpoint and finish, so they never overtake
 * project work. Platform uninstall holds the same key from its final check
 * until it disables traffic
 * (packages/void/src/cli/platform-zero-trust-uninstall.ts), and records the
 * uninstall before it releases. A request admitted before traffic was disabled
 * may still be waiting here, so every holder refuses once that record exists
 * rather than create an Access application uninstall did not see.
 */
export async function lockZeroTrustConfiguration(
  db: DbOrTx,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  await db.execute(
    mode === 'shared'
      ? sql`SELECT pg_advisory_xact_lock_shared(hashtext('zero-trust:configuration'))`
      : sql`SELECT pg_advisory_xact_lock(hashtext('zero-trust:configuration'))`,
  );
  // A separate statement takes a snapshot after the lock is granted, so it
  // sees a record committed while this request waited.
  if ((await getPlatformSetting(db, PLATFORM_UNINSTALL_SETTING)) !== null) {
    throw new ZeroTrustUnavailableError(
      'The platform is being uninstalled, so Zero Trust changes and deployments are refused.',
    );
  }
}

/** Carries a failure out of the transaction once its project error is recorded. */
class RecordedProjectError {
  constructor(readonly error: unknown) {}
}

/** Runs a step whose failure is recorded on the project row and committed. */
export type RecordProjectErrors = <T>(step: () => Promise<T>) => Promise<T>;

/**
 * Run `work` in one transaction holding the project row lock and the shared
 * configuration lock. An error thrown by `work` rolls the transaction back.
 * An error thrown inside `recordErrors` instead marks the project failed,
 * commits that mark with the work done before it, and is then rethrown.
 */
export async function withProjectZeroTrustLock<T>(
  db: Db,
  projectId: string,
  work: (lockedDb: Db, recordErrors: RecordProjectErrors) => Promise<T>,
): Promise<T> {
  let recorded: RecordedProjectError | undefined;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx, 'shared');
    const recordErrors: RecordProjectErrors = async (step) => {
      try {
        return await step();
      } catch (error) {
        await markProjectError(tx, projectId, error);
        // oxlint-disable-next-line typescript/only-throw-error -- This private sentinel carries the already-recorded rejection through the transaction.
        throw new RecordedProjectError(error);
      }
    };
    try {
      return await work(tx, recordErrors);
    } catch (error) {
      if (!(error instanceof RecordedProjectError)) {
        throw error;
      }
      recorded = error;
      return undefined;
    }
  });
  if (recorded) {
    throw recorded.error;
  }
  return result as T;
}
