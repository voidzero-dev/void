/**
 * Exposure catch-up (spec §6.1, D12). Under `public` mode a protected project's deploy
 * gets a `skipped:protected` row. When the project later counts as public with no
 * request involved (a reconcile error, the installation turning Zero Trust off, a
 * bypassed request), the live deployment is scanned once, `trigger=exposure`.
 * Findings it reports never re-protect the project (D51). A project whose rule is
 * `never` (M34) gets no catch-up scan.
 */
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { deployments, projects, projectZeroTrust } from '../schema.ts';
import { securityProjectHasOverrideSql } from './project-policy.ts';
import { findLiveInput } from './public-gate.ts';
import {
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  securityPublicRequests,
  securityScans,
} from './schema.ts';

const EXPOSURE_BATCH = 20;

/** Queues at most one catch-up scan per exposed project. Returns how many it queued. */
export async function queueExposureCatchUpScans(
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2'>,
  db: Db,
): Promise<number> {
  const candidates = await db
    .select({ projectId: projects.id, deploymentId: projects.active_deployment_id })
    .from(projects)
    .innerJoin(deployments, eq(deployments.id, projects.active_deployment_id))
    .leftJoin(projectZeroTrust, eq(projectZeroTrust.project_id, projects.id))
    .where(
      and(
        eq(deployments.status, 'live'),
        ne(projects.status, 'deleting'),
        sql`${projects.slug} NOT LIKE 'preview-%'`,
        // Counts as public: no settled protected row.
        sql`(${projectZeroTrust.project_id} IS NULL OR NOT (${projectZeroTrust.status} = 'ready' AND ${projectZeroTrust.desired_protected} AND ${projectZeroTrust.effective_protected}))`,
        // The live deployment was skipped while protected, or its gate scan did not succeed.
        sql`EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.deployment_id = ${projects.active_deployment_id} AND ((s.status = 'skipped' AND s.status_reason = 'protected') OR (s.trigger = 'gate' AND s.status <> 'succeeded')))`,
        // And nothing since has scanned it or is about to.
        sql`NOT EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.deployment_id = ${projects.active_deployment_id} AND s.status IN ('pending_input', 'queued', 'running', 'succeeded'))`,
        sql`NOT ${securityProjectHasOverrideSql(projects.id, 'never')}`,
        // A failed, refused, canceled or capped exposure scan is not retried every hour.
        sql`NOT EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.deployment_id = ${projects.active_deployment_id} AND s.trigger = 'exposure')`,
        sql`NOT EXISTS (SELECT 1 FROM security_public_requests r WHERE r.project_id = ${projects.id} AND r.state IN (${sql.join(
          SECURITY_PUBLIC_REQUEST_OPEN_STATES.map((state) => sql`${state}`),
          sql`, `,
        )}))`,
      ),
    )
    .limit(EXPOSURE_BATCH);
  let queued = 0;
  for (const candidate of candidates) {
    const deploymentId = candidate.deploymentId;
    if (!deploymentId) {
      continue;
    }
    const input = await findLiveInput(env, db, candidate.projectId, deploymentId);
    if (!input) {
      continue;
    }
    const inserted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${candidate.projectId} FOR UPDATE`);
      const [live] = await tx
        .select({ id: projects.active_deployment_id })
        .from(projects)
        .where(eq(projects.id, candidate.projectId));
      if (live?.id !== deploymentId) {
        return false;
      }
      const [waiting] = await tx
        .select({ id: securityScans.id })
        .from(securityScans)
        .where(
          and(
            eq(securityScans.project_id, candidate.projectId),
            eq(securityScans.deployment_id, deploymentId),
            or(
              inArray(securityScans.status, ['pending_input', 'queued', 'running', 'succeeded']),
              eq(securityScans.trigger, 'exposure'),
            ),
          ),
        )
        .orderBy(desc(securityScans.created_at))
        .limit(1);
      if (waiting) {
        return false;
      }
      const [open] = await tx
        .select({ id: securityPublicRequests.id })
        .from(securityPublicRequests)
        .where(
          and(
            eq(securityPublicRequests.project_id, candidate.projectId),
            inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]),
          ),
        )
        .limit(1);
      if (open) {
        return false;
      }
      await tx.insert(securityScans).values({
        id: generateId('scan'),
        project_id: candidate.projectId,
        deployment_id: deploymentId,
        status: 'queued',
        trigger: 'exposure',
        input_r2_key: input.r2Key,
        policy_mode_at_enqueue: 'public',
        public_at_enqueue: true,
        first_queued_at: sql`now()`,
        queued_at: sql`now()`,
      });
      return true;
    });
    if (inserted) {
      queued++;
    }
  }
  return queued;
}
