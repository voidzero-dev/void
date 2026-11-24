import { eq, sql } from 'drizzle-orm';
import { deleteWorkerBundle } from './assets.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from './constants.ts';
import {
  cancelDeployment,
  getDeployment,
  getDomainsByProjectId,
  getProject,
  updateDeploymentStatus,
} from './db.ts';
import type { Db } from './db.ts';
import { projectPublicUrls } from './deploy/shared.ts';
import type { ApiEnv } from './env.ts';
import { deleteSandboxController } from './provisioning/sandbox-controller.ts';
import { settleDeploymentForSandboxDrain } from './routes/deploy.ts';
import { deployments } from './schema.ts';
import type { DeployEvent, DeployManifest, Deployment, Project } from './types.ts';

const INTERRUPTED_MESSAGE = 'Deployment execution was interrupted. Deploy again to retry.';

type Settlement = Readonly<{ terminal: boolean; event?: DeployEvent }>;

async function committedEvent(
  env: ApiEnv['Bindings'],
  db: Db,
  project: Project,
  deployment: Deployment,
): Promise<DeployEvent> {
  const urls = projectPublicUrls(env, project, await getDomainsByProjectId(db, project.id));
  const manifest = deployment.manifest ? (JSON.parse(deployment.manifest) as DeployManifest) : null;
  return {
    event: 'done',
    deployment: deployment.id,
    url: urls[0]!,
    urls,
    assets: deployment.asset_hashes
      ? Object.keys(JSON.parse(deployment.asset_hashes) as Record<string, unknown>).length
      : 0,
    // The operation journal retains the original module count. This describes
    // the serving target when a crash happened before its result was recorded.
    workers: manifest?.type === 'static' || manifest?.type === 'spa' ? 0 : 1,
  };
}

/**
 * Reconcile an execution only after its runner's hard lifetime has expired.
 * The caller owns a persisted recovery claim and keeps admission blocked until
 * this returns terminal. This never replays provisioning or application SQL.
 */
export async function settleExpiredDeployment(
  env: ApiEnv['Bindings'],
  db: Db,
  deploymentId: string,
): Promise<Settlement> {
  const progress = (step: string) =>
    console.info('[deployment-execution] recovery progress', { deploymentId, step });
  progress('loading deployment');
  const initial = await getDeployment(db, deploymentId);
  if (!initial) {
    return {
      terminal: true,
      event: { event: 'error', message: INTERRUPTED_MESSAGE, step: 'recovery' },
    };
  }

  if (initial.status === 'cutover' || initial.status === 'compensating') {
    const protectedResult = await settleDeploymentForSandboxDrain(env, db, deploymentId, {
      expiredInvocation: true,
      reason: INTERRUPTED_MESSAGE,
    });
    if (protectedResult.state !== 'terminal') {
      return { terminal: false };
    }
  }

  // Commit cancellation before external cleanup so a failure or lost response
  // retains an in-flight fence rather than allowing another deployment to race.
  progress('fencing interrupted execution');
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${initial.project_id} FOR UPDATE`);
    const deployment = await getDeployment(tx, deploymentId);
    if (
      deployment &&
      !['live', 'failed', 'canceled', 'canceling'].includes(deployment.status) &&
      deployment.source !== 'rollback-lease'
    ) {
      await cancelDeployment(tx, deploymentId, INTERRUPTED_MESSAGE);
    }
  });

  progress('cleaning candidate');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${initial.project_id} FOR UPDATE`);
    const deployment = await getDeployment(tx, deploymentId);
    if (!deployment) {
      return {
        terminal: true,
        event: { event: 'error', message: INTERRUPTED_MESSAGE, step: 'recovery' },
      };
    }
    const project = await getProject(tx, deployment.project_id);
    if (!project || project.status === 'deleting') {
      // Project teardown owns its resources and cleanup jobs.
      return { terminal: false };
    }
    if (deployment.status === 'live') {
      return { terminal: true, event: await committedEvent(env, tx, project, deployment) };
    }
    if (
      project.active_deployment_id === deployment.id ||
      deployment.source === 'rollback-lease' ||
      deployment.status === 'cutover' ||
      deployment.status === 'compensating'
    ) {
      return { terminal: false };
    }

    if (!deployment.retained) {
      const manifest = deployment.manifest
        ? (JSON.parse(deployment.manifest) as DeployManifest)
        : null;
      // An upload can land before its acknowledgement or local uploaded flag.
      // The manifest is committed before upload; null/static manifests cannot
      // have uploaded a Worker and need no dispatch provider permissions.
      if (manifest && manifest.type !== 'static' && manifest.type !== 'spa') {
        progress('deleting candidate worker');
        const namespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
        const workerName = `user-${project.slug}-${deployment.id}`;
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${namespace}/scripts/${workerName}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!response.ok && response.status !== 404) {
          throw new Error(`Interrupted deployment cleanup failed (HTTP ${response.status}).`);
        }
      }
      // Remove the tenant service binding before deleting its controller.
      if (manifest?.sandbox) {
        progress('deleting sandbox controller');
        await deleteSandboxController(
          env.CF_ACCOUNT_ID,
          env.CF_API_TOKEN,
          project.id,
          deployment.id,
          manifest.sandbox,
          env.SANDBOX_CONCURRENCY_COUNTER,
          tx,
        );
        progress('sandbox controller deleted');
      }
      progress('deleting candidate bundle');
      await env.ROUTING.delete(`manifest:${deployment.id}`);
      await deleteWorkerBundle(env.STATIC_ASSETS_R2, project.id, deployment.id);
      await tx
        .update(deployments)
        .set({ bundle_stored: false })
        .where(eq(deployments.id, deployment.id));
    }

    // Do not undo remotely committed SQL or delete project-scoped resources.
    // Only this candidate's private artifacts have been confirmed cleaned up.
    const canceled =
      deployment.status === 'canceled' ||
      (deployment.status === 'canceling' && deployment.error_message !== INTERRUPTED_MESSAGE);
    await updateDeploymentStatus(tx, deployment.id, canceled ? 'canceled' : 'failed', undefined, {
      force: true,
    });
    progress('candidate cleanup complete');
    return {
      terminal: true,
      event: {
        event: 'error',
        message: deployment.error_message ?? INTERRUPTED_MESSAGE,
        step: 'recovery',
      },
    };
  });
}
