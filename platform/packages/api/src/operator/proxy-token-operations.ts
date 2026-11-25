import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { isDevBypass } from '../env.ts';
import type { ApiEnv } from '../env.ts';
import { isProjectId } from '../id.ts';
import {
  advanceProxyTokenRotation,
  listProxyTokenInventory,
  PROXY_TOKEN_ROTATION_JOB_KIND,
  proxyTokenRotationTarget,
  reconcileProxyTokenRotations,
  requestBulkProxyTokenRotations,
  requestProxyTokenRotation,
} from '../proxy-token-rotation.ts';
import { projectCleanupJobs, projects } from '../schema.ts';
import { OperatorError, preview } from './common.ts';

// Inline work per request stays well under the CLI's 5 minute request timeout;
// the scheduled run finishes whatever is left.
const APPLY_MAX_CF_CALLS = 150;
const APPLY_MAX_MS = 60_000;
const LISTED_JOBS = 50;

type RotateInput = Readonly<{ dryRun: boolean; project?: unknown; all?: unknown }>;

const rotationJobs = (projectId: string | undefined): SQL | undefined =>
  and(
    eq(projectCleanupJobs.kind, PROXY_TOKEN_ROTATION_JOB_KIND),
    projectId ? eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId)) : undefined,
  );

/** Rotation jobs in scope, oldest first. A job that has failed since its last good step counts as failed. */
async function listJobs(db: Db, projectId: string | undefined, failedOnly = false) {
  const rows = await db
    .select({
      projectId: projectCleanupJobs.project_id,
      slug: projects.slug,
      payload: projectCleanupJobs.payload,
      attempts: projectCleanupJobs.attempts,
      lastError: projectCleanupJobs.last_error,
      nextAttemptAt: projectCleanupJobs.next_attempt_at,
    })
    .from(projectCleanupJobs)
    .leftJoin(projects, eq(projects.id, projectCleanupJobs.project_id))
    .where(
      and(rotationJobs(projectId), failedOnly ? gt(projectCleanupJobs.attempts, 0) : undefined),
    )
    .orderBy(asc(projectCleanupJobs.created_at), asc(projectCleanupJobs.target))
    .limit(LISTED_JOBS);
  return rows.map((row) => ({
    projectId: row.projectId,
    slug: row.slug,
    phase: row.payload.phase ?? null,
    reason: row.payload.reason ?? null,
    again: row.payload.again === '1',
    attempts: row.attempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    waitUntil: row.payload.waitUntil ?? null,
  }));
}

async function jobCounts(db: Db, projectId: string | undefined) {
  const [row] = await db
    .select({
      pending: sql<number>`count(*) FILTER (WHERE ${projectCleanupJobs.attempts} = 0)::integer`,
      failed: sql<number>`count(*) FILTER (WHERE ${projectCleanupJobs.attempts} > 0)::integer`,
      retryAfterSeconds: sql<
        number | null
      >`min(greatest(0, ceil(extract(epoch FROM ${projectCleanupJobs.next_attempt_at}::timestamptz - now()))))::integer`,
    })
    .from(projectCleanupJobs)
    .where(rotationJobs(projectId));
  return {
    pending: row?.pending ?? 0,
    failed: row?.failed ?? 0,
    retryAfterSeconds: row?.retryAfterSeconds ?? null,
  };
}

/** Projects --all would queue or flag: every project without a job or with one past START. */
async function countWouldQueue(db: Db): Promise<number> {
  const job = sql`${projectCleanupJobs.target} = ${PROXY_TOKEN_ROTATION_JOB_KIND}::text || ':' || ${projects.id}`;
  const [row] = await db
    .select({
      wouldQueue: sql<number>`count(*) FILTER (WHERE ${projectCleanupJobs.target} IS NULL
        OR ${projectCleanupJobs.payload}->>'phase' <> 'requested')::integer`,
    })
    .from(projects)
    .leftJoin(projectCleanupJobs, job)
    .where(sql`${projects.status} <> 'deleting'`);
  return row?.wouldQueue ?? 0;
}

/** Progress of every rotation job; with `all`, also what an --all apply would queue. */
async function bulkPreview(db: Db, all: boolean) {
  const counts = await jobCounts(db, undefined);
  return preview(
    'system.rotate-proxy-tokens',
    { projects: 'all' },
    {
      summary: {
        ...(all ? { wouldQueue: await countWouldQueue(db) } : {}),
        pending: counts.pending,
        failed: counts.failed,
      },
      projects: await listJobs(db, undefined),
    },
  );
}

/**
 * `void platform system rotate-proxy-tokens`. An apply needs `project` or
 * `all` (every project); a preview without either shows the progress of
 * every rotation. A preview reads the database only and never returns a
 * token. An apply requests the rotations and advances them within a bounded
 * budget; the scheduled run finishes the rest.
 */
export async function rotateProxyTokens(db: Db, env: ApiEnv['Bindings'], input: RotateInput) {
  if (input.project !== undefined && !isProjectId(input.project)) {
    throw new OperatorError(400, 'project must be a project ID.', 'invalid_argument');
  }
  if (input.all !== undefined && typeof input.all !== 'boolean') {
    throw new OperatorError(400, 'all must be a boolean.', 'invalid_argument');
  }
  if (input.project !== undefined && input.all === true) {
    throw new OperatorError(400, 'Choose either project or all.', 'invalid_argument');
  }
  if (!input.dryRun && input.project === undefined && input.all !== true) {
    throw new OperatorError(400, 'Supply --project <id> or --all.', 'invalid_argument');
  }
  const all = input.all === true;
  const projectId = input.project;
  const [project] = projectId
    ? await db
        .select({
          id: projects.id,
          slug: projects.slug,
          active_deployment_id: projects.active_deployment_id,
          proxy_token_gen: projects.proxy_token_gen,
        })
        .from(projects)
        .where(eq(projects.id, projectId))
    : [];
  if (projectId && !project) {
    throw new OperatorError(404, 'Project not found.', 'not_found');
  }

  if (input.dryRun) {
    if (!project) {
      return bulkPreview(db, all);
    }
    const [job] = await listJobs(db, project.id);
    return preview(
      'system.rotate-proxy-tokens',
      { projects: project.id },
      {
        projectId: project.id,
        slug: project.slug,
        gen: project.proxy_token_gen,
        job: job
          ? {
              phase: job.phase,
              reason: job.reason,
              again: job.again,
              attempts: job.attempts,
              lastError: job.lastError,
              nextAttemptAt: job.nextAttemptAt,
              waitUntil: job.waitUntil,
            }
          : null,
        workers: (await listProxyTokenInventory(db, project)).map((row) => row.workerName),
      },
    );
  }

  if (isDevBypass(env) || !env.CF_API_TOKEN) {
    throw new OperatorError(
      409,
      'Proxy token rotation needs the platform Cloudflare API token.',
      'rotation_unavailable',
    );
  }

  const budget = { cfCallsRemaining: APPLY_MAX_CF_CALLS, deadline: Date.now() + APPLY_MAX_MS };
  let queued: number;
  if (project) {
    await requestProxyTokenRotation(db, project.id, 'operator', 'operator');
    await advanceProxyTokenRotation(db, env, project.id, budget);
    queued = 1;
  } else {
    queued = await requestBulkProxyTokenRotations(db);
    await reconcileProxyTokenRotations(db, env, {
      maxCfCalls: APPLY_MAX_CF_CALLS,
      maxMs: APPLY_MAX_MS,
    });
  }
  const counts = await jobCounts(db, project?.id);
  const complete = counts.pending + counts.failed === 0;
  const failures = (await listJobs(db, project?.id, true)).map((job) => ({
    projectId: job.projectId,
    slug: job.slug,
    phase: job.phase,
    error: job.lastError,
  }));
  return {
    ok: counts.failed === 0,
    complete,
    queued,
    pending: counts.pending,
    failed: counts.failed,
    failures,
    retryAfterSeconds: complete ? null : counts.retryAfterSeconds,
    message: complete
      ? 'Every requested rotation is finished.'
      : counts.failed > 0
        ? 'Some rotations keep failing and are retried in the background. Check progress with --plan.'
        : 'Rotations continue in the background. Check progress with --plan.',
  };
}
