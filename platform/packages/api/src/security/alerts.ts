/**
 * Hourly queueing of the Phase 2 alert emails (design doc 0095 M26): failure streaks
 * (`streaks.ts`) and the weekly digest (`digest.ts`). Rows go to the outbox
 * (`notifications.ts`), which works out recipients and text at send time.
 */
import type { SecurityPolicy } from '@void/platform/security-policy';
import type { Db } from '../db.ts';
import { securityDigestWeek } from './digest.ts';
import { enqueueSecurityNotification } from './notifications.ts';
import {
  listSecurityProjectStreaks,
  readSecurityInstallationFailures,
  securityInstallationFailing,
  securityProjectStreakAlreadyQueued,
  securityUtcDay,
} from './streaks.ts';

/** Queues the streak emails that are due. Returns how many rows were queued. */
export async function queueSecurityStreakNotifications(db: Db, now: number): Promise<number> {
  let queued = 0;
  for (const streak of await listSecurityProjectStreaks(db, { now })) {
    if (await securityProjectStreakAlreadyQueued(db, streak.projectId)) {
      continue;
    }
    if (
      await enqueueSecurityNotification(db, {
        kind: 'streak_project',
        projectId: streak.projectId,
        sinceScanId: streak.sinceScanId,
      })
    ) {
      queued++;
    }
  }
  if (securityInstallationFailing(await readSecurityInstallationFailures(db, now))) {
    if (
      await enqueueSecurityNotification(db, {
        kind: 'streak_installation',
        day: securityUtcDay(now),
      })
    ) {
      queued++;
    }
  }
  return queued;
}

/**
 * Queues last week's digest while the policy's `digest` is on. Once per week (the
 * dedupe key); the delivery skips a week with nothing to tell.
 */
export async function queueSecurityDigest(
  db: Db,
  policy: SecurityPolicy,
  now: number,
): Promise<number> {
  if (!policy.digest || policy.mode === 'disabled') {
    return 0;
  }
  const { week } = securityDigestWeek(now);
  return (await enqueueSecurityNotification(db, { kind: 'digest', week })) ? 1 : 0;
}
