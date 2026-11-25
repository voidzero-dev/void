import { and, asc, eq, gt, lt, notInArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import { TERMINAL_DEPLOYMENT_STATUSES } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getProjectDeploymentWorkerName } from '../naming.ts';
import { CloudflareApiError } from '../provisioning/cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  findDurableObjectNamespaceId,
  getContainerApplication,
  perDeployContainerApplicationName,
} from '../provisioning/containers.ts';
import type { ContainerApplicationInfo } from '../provisioning/containers.ts';
import { settleDeploymentForSandboxDrain } from '../routes/deploy.ts';
import {
  acquireSandboxDrainLease,
  checkpointSandboxDrain,
  completeSandboxDrain,
  readSandboxDrainCheckpoint,
} from '../sandbox-drain.ts';
import type { SandboxDrainCursor, SandboxDrainPhase } from '../sandbox-drain.ts';
import { deployments, projects, resources } from '../schema.ts';
import { OperatorError, preview } from './common.ts';

const PAGE_SIZE = 16;
const MAX_SANDBOX_IDENTITY_LENGTH = 512;

const manifestJson = sql`${deployments.manifest}::jsonb`;
const sandboxJson = sql`${manifestJson} -> 'sandbox'`;
const sandboxBindingName = sql`${sandboxJson} -> 'bindingName'`;
const sandboxClassName = sql`${sandboxJson} -> 'className'`;
const sandboxContainerName = sql`${sandboxJson} -> 'containerName'`;

function boundedJsonString(value: SQL): SQL<string | null> {
  return sql<string | null>`CASE
    WHEN jsonb_typeof(${value}) = 'string'
      AND char_length(${value} #>> '{}') <= ${MAX_SANDBOX_IDENTITY_LENGTH}
    THEN ${value} #>> '{}'
    ELSE NULL
  END`;
}

type DeploymentSandboxProjection = Readonly<{
  deploymentId: string;
  projectId: string;
  projectSlug: string;
  active: boolean;
  rollbackLease: boolean;
  manifestPresent: boolean;
  sandboxType: string | null;
  bindingNameType: string | null;
  bindingName: string | null;
  classNameType: string | null;
  className: string | null;
  containerNameType: string | null;
  containerName: string | null;
  identityOversized: boolean;
  createdAt: string;
}>;

type ManifestTarget = Readonly<{
  deploymentId: string;
  projectId: string;
  projectSlug: string;
  applicationName: string;
  bindingName: string;
  className: string;
}>;

export type SandboxDrainBlocker = Readonly<{
  kind:
    | 'active_deployment'
    | 'invalid_manifest'
    | 'container_read_failed'
    | 'container_delete_failed'
    | 'unverified_container';
  message: string;
  deploymentId?: string;
  projectId?: string;
  resourceId?: string;
  bindingName?: string;
  applicationId?: string;
  applicationName?: string;
  resolution?: string;
}>;

type PageResult = {
  processed: number;
  applications: Array<Record<string, unknown>>;
  blockers: Array<SandboxDrainBlocker>;
  cancelRequested: Array<string>;
  deletedApplications: Array<string>;
  nextCursor: SandboxDrainCursor | null;
  truncated: boolean;
};

function emptyPage(processed: number, truncated: boolean): PageResult {
  return {
    processed,
    applications: [],
    blockers: [],
    cancelRequested: [],
    deletedApplications: [],
    nextCursor: null,
    truncated,
  };
}

function pass(cursor: SandboxDrainCursor | null): '1' | '2' {
  return cursor?.pass === '2' ? '2' : '1';
}

function sandboxTarget(row: DeploymentSandboxProjection): ManifestTarget | null {
  if (row.sandboxType === null || row.sandboxType === 'null') {
    return null;
  }
  if (row.identityOversized) {
    throw new Error(`sandbox identity metadata exceeds ${MAX_SANDBOX_IDENTITY_LENGTH} characters`);
  }
  if (
    row.sandboxType !== 'object' ||
    row.bindingNameType !== 'string' ||
    !row.bindingName ||
    row.classNameType !== 'string' ||
    !row.className ||
    (row.containerNameType !== null && row.containerNameType !== 'string')
  ) {
    throw new Error('sandbox metadata is invalid');
  }
  return {
    deploymentId: row.deploymentId,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    applicationName: perDeployContainerApplicationName(
      row.projectId,
      row.deploymentId,
      row.containerName ?? 'void-sandbox',
    ),
    bindingName: row.bindingName,
    className: row.className,
  };
}

/**
 * Load only the bounded Sandbox identity needed by the drain. Deployment
 * manifests may contain multi-megabyte routing and asset metadata; JSONB
 * extraction keeps that unrelated payload inside PostgreSQL.
 */
export async function loadSandboxDeploymentPageProjection(
  db: Db,
  cursor: SandboxDrainCursor | null,
): Promise<Array<DeploymentSandboxProjection>> {
  const createdAt = cursor?.createdAt;
  const id = cursor?.id;
  return db
    .select({
      deploymentId: deployments.id,
      projectId: deployments.project_id,
      projectSlug: projects.slug,
      active: sql<boolean>`${notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES)}`,
      rollbackLease: sql<boolean>`COALESCE(${deployments.source} = 'rollback-lease', false)`,
      manifestPresent: sql<boolean>`${deployments.manifest} IS NOT NULL`,
      sandboxType: sql<string | null>`jsonb_typeof(${sandboxJson})`,
      bindingNameType: sql<string | null>`jsonb_typeof(${sandboxBindingName})`,
      bindingName: boundedJsonString(sandboxBindingName),
      classNameType: sql<string | null>`jsonb_typeof(${sandboxClassName})`,
      className: boundedJsonString(sandboxClassName),
      containerNameType: sql<string | null>`jsonb_typeof(${sandboxContainerName})`,
      containerName: boundedJsonString(sandboxContainerName),
      identityOversized: sql<boolean>`COALESCE(
        (jsonb_typeof(${sandboxBindingName}) = 'string'
          AND char_length(${sandboxBindingName} #>> '{}') > ${MAX_SANDBOX_IDENTITY_LENGTH})
        OR (jsonb_typeof(${sandboxClassName}) = 'string'
          AND char_length(${sandboxClassName} #>> '{}') > ${MAX_SANDBOX_IDENTITY_LENGTH})
        OR (jsonb_typeof(${sandboxContainerName}) = 'string'
          AND char_length(${sandboxContainerName} #>> '{}') > ${MAX_SANDBOX_IDENTITY_LENGTH}),
        false
      )`,
      createdAt: deployments.created_at,
    })
    .from(deployments)
    .innerJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      and(
        lt(deployments.admission_protocol, 3),
        createdAt && id
          ? or(
              gt(deployments.created_at, createdAt),
              and(eq(deployments.created_at, createdAt), gt(deployments.id, id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(deployments.created_at), asc(deployments.id))
    .limit(PAGE_SIZE + 1);
}

async function verifyApplication(
  env: ApiEnv['Bindings'],
  application: ContainerApplicationInfo,
  target: ManifestTarget,
): Promise<SandboxDrainBlocker | { verification: 'dispatch_namespace' }> {
  if (application.name !== target.applicationName || !application.durable_objects?.namespace_id) {
    return {
      kind: 'unverified_container',
      projectId: target.projectId,
      deploymentId: target.deploymentId,
      applicationId: application.id,
      applicationName: application.name,
      message: `Container application ${application.id} does not match the deployment manifest identity.`,
    };
  }
  try {
    const namespaceId = await findDurableObjectNamespaceId(
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE,
      getProjectDeploymentWorkerName(target.projectSlug, target.deploymentId),
      target.bindingName,
      target.className,
    );
    if (namespaceId !== application.durable_objects.namespace_id) {
      return {
        kind: 'unverified_container',
        projectId: target.projectId,
        deploymentId: target.deploymentId,
        applicationId: application.id,
        applicationName: application.name,
        message: `Container application ${application.id} is bound to a different Durable Object namespace.`,
      };
    }
    return { verification: 'dispatch_namespace' };
  } catch (error) {
    return {
      kind:
        error instanceof CloudflareApiError && error.status === 404
          ? 'unverified_container'
          : 'container_read_failed',
      projectId: target.projectId,
      deploymentId: target.deploymentId,
      applicationId: application.id,
      applicationName: application.name,
      message:
        error instanceof CloudflareApiError && error.status === 404
          ? `Managed dispatch script for ${target.deploymentId} is missing; the same-name container application was not deleted.`
          : `Could not verify managed dispatch ownership for ${application.name}: ${error instanceof Error ? error.message : String(error)}`,
      resolution:
        'Verify the application and Durable Object namespace against immutable installation records. Remove it manually only after proving ownership, then rerun the drain.',
    };
  }
}

async function deploymentPage(
  db: Db,
  env: ApiEnv['Bindings'],
  cursor: SandboxDrainCursor | null,
  dryRun: boolean,
): Promise<PageResult> {
  const rows = await loadSandboxDeploymentPageProjection(db, cursor);
  const pageRows = rows.slice(0, PAGE_SIZE);
  const result = emptyPage(pageRows.length, rows.length > PAGE_SIZE);
  for (const row of pageRows) {
    if (row.rollbackLease || !row.manifestPresent) {
      if (row.active) {
        if (!dryRun) {
          const settlement = await settleDeploymentForSandboxDrain(env, db, row.deploymentId);
          if (settlement.state === 'cancel_requested') {
            result.cancelRequested.push(row.deploymentId);
          }
          if (settlement.state === 'terminal') {
            continue;
          }
        }
        result.blockers.push({
          kind: 'active_deployment',
          deploymentId: row.deploymentId,
          projectId: row.projectId,
          message: `Deployment ${row.deploymentId} must settle before the Sandbox drain can advance.`,
        });
      }
      continue;
    }
    let target: ManifestTarget | null;
    try {
      target = sandboxTarget(row);
    } catch (error) {
      result.blockers.push({
        kind: 'invalid_manifest',
        deploymentId: row.deploymentId,
        projectId: row.projectId,
        message: `Deployment ${row.deploymentId} ${error instanceof Error ? error.message : 'has an unreadable manifest'}.`,
      });
      if (row.active) {
        result.blockers.push({
          kind: 'active_deployment',
          deploymentId: row.deploymentId,
          projectId: row.projectId,
          message: `Deployment ${row.deploymentId} has invalid metadata and must settle.`,
        });
      }
      continue;
    }
    if (!target) {
      continue;
    }
    if (row.active) {
      const settlement = dryRun
        ? undefined
        : await settleDeploymentForSandboxDrain(env, db, row.deploymentId);
      if (settlement?.state === 'cancel_requested') {
        result.cancelRequested.push(row.deploymentId);
      }
      if (settlement?.state !== 'terminal') {
        result.blockers.push({
          kind: 'active_deployment',
          deploymentId: row.deploymentId,
          projectId: row.projectId,
          message: `Sandbox deployment ${row.deploymentId} must settle before the drain can advance.`,
        });
        continue;
      }
    }
    let application: ContainerApplicationInfo | undefined;
    try {
      application = await findContainerApplication(
        env.CF_ACCOUNT_ID,
        env.CF_API_TOKEN,
        target.applicationName,
      );
    } catch (error) {
      result.blockers.push({
        kind: 'container_read_failed',
        deploymentId: target.deploymentId,
        projectId: target.projectId,
        applicationName: target.applicationName,
        message: `Could not inspect ${target.applicationName}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!application) {
      continue;
    }
    const verified = await verifyApplication(env, application, target);
    if ('kind' in verified) {
      result.blockers.push(verified);
      continue;
    }
    result.applications.push({
      id: application.id,
      name: application.name,
      projectId: target.projectId,
      deploymentId: target.deploymentId,
      verification: verified.verification,
    });
    if (!dryRun) {
      try {
        await deleteContainerApplicationIdempotent(
          env.CF_ACCOUNT_ID,
          env.CF_API_TOKEN,
          application.id,
        );
        result.deletedApplications.push(application.id);
      } catch (error) {
        result.blockers.push({
          kind: 'container_delete_failed',
          applicationId: application.id,
          applicationName: application.name,
          message: `Could not delete ${application.name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  const last = pageRows.at(-1);
  if (last) {
    result.nextCursor = { pass: pass(cursor), createdAt: last.createdAt, id: last.deploymentId };
  }
  return result;
}

async function resourcePage(
  db: Db,
  env: ApiEnv['Bindings'],
  cursor: SandboxDrainCursor | null,
  dryRun: boolean,
): Promise<PageResult> {
  const rows = await db
    .select({
      resourceId: resources.id,
      projectId: resources.project_id,
      applicationId: resources.cf_id,
      bindingName: resources.binding_name,
    })
    .from(resources)
    .where(
      and(eq(resources.type, 'container'), cursor?.id ? gt(resources.id, cursor.id) : undefined),
    )
    .orderBy(asc(resources.id))
    .limit(PAGE_SIZE + 1);
  const pageRows = rows.slice(0, PAGE_SIZE);
  const result = emptyPage(pageRows.length, rows.length > PAGE_SIZE);
  for (const resource of pageRows) {
    try {
      const application = await getContainerApplication(
        env.CF_ACCOUNT_ID,
        env.CF_API_TOKEN,
        resource.applicationId,
      );
      if (!application) {
        if (!dryRun) {
          await db.delete(resources).where(eq(resources.id, resource.resourceId));
        }
        continue;
      }
      result.blockers.push({
        kind: 'unverified_container',
        projectId: resource.projectId,
        resourceId: resource.resourceId,
        bindingName: resource.bindingName,
        applicationId: application.id,
        applicationName: application.name,
        message: `Container resource ${resource.resourceId} (${resource.projectId}/${resource.bindingName} -> ${application.id} ${application.name}) remains after the manifest pass and was not deleted.`,
        resolution:
          'Verify the application and Durable Object namespace against this installation managed dispatch script. Remove the application and resource row only after proving ownership, then rerun the drain.',
      });
    } catch (error) {
      result.blockers.push({
        kind: 'container_read_failed',
        projectId: resource.projectId,
        resourceId: resource.resourceId,
        bindingName: resource.bindingName,
        applicationId: resource.applicationId,
        message: `Could not inspect container resource ${resource.resourceId}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const last = pageRows.at(-1);
  if (last) {
    result.nextCursor = { pass: pass(cursor), id: last.resourceId };
  }
  return result;
}

type SandboxPreviewPosition = {
  phase: SandboxDrainPhase;
  cursor: SandboxDrainCursor;
};

function parsePreviewCursor(raw: string | undefined): SandboxPreviewPosition {
  if (!raw) {
    return { phase: 'deployments', cursor: { pass: '1' } };
  }
  try {
    const parsed = JSON.parse(raw) as { phase?: unknown; cursor?: unknown };
    if (
      (parsed.phase === 'deployments' || parsed.phase === 'resources') &&
      parsed.cursor &&
      typeof parsed.cursor === 'object' &&
      !Array.isArray(parsed.cursor)
    ) {
      return { phase: parsed.phase, cursor: parsed.cursor as SandboxDrainCursor };
    }
  } catch {
    // handled below
  }
  throw new OperatorError(400, 'Sandbox drain preview cursor is invalid.', 'invalid_cursor');
}

type SandboxPreviewProgress = {
  phase: SandboxDrainPhase;
  cursor: SandboxDrainCursor;
  complete: boolean;
};

function nextPosition(
  phase: SandboxDrainPhase,
  cursor: SandboxDrainCursor,
  page: PageResult,
): SandboxPreviewProgress {
  if (page.truncated && page.nextCursor) {
    return { phase, cursor: page.nextCursor, complete: false };
  }
  const currentPass = pass(cursor);
  if (phase === 'deployments') {
    return { phase: 'resources', cursor: { pass: currentPass }, complete: false };
  }
  if (currentPass === '1') {
    return { phase: 'deployments', cursor: { pass: '2' }, complete: false };
  }
  return { phase: 'resources', cursor: { pass: '2' }, complete: true };
}

export async function sandboxDrainStatus(db: Db) {
  const checkpoint = await readSandboxDrainCheckpoint(db);
  return {
    version: 1,
    state: checkpoint?.state ?? 'required',
    generation: checkpoint?.generation ?? null,
    complete: checkpoint?.state === 'complete',
    updatedAt: checkpoint?.updated_at ?? null,
    phase: checkpoint?.phase ?? null,
  };
}

export async function drainManagedSandboxes(
  db: Db,
  env: ApiEnv['Bindings'],
  dryRun = false,
  previewCursor?: string,
) {
  if (dryRun) {
    const checkpoint = await readSandboxDrainCheckpoint(db);
    if (checkpoint?.state === 'complete' && !previewCursor) {
      return preview('system.sandbox-drain', 'managed-sandbox-containers', {
        checkpoint,
        complete: true,
        nextCursor: null,
        effect: 'Legacy tenant-owned Sandbox containers are already drained.',
      });
    }
    const position = previewCursor
      ? parsePreviewCursor(previewCursor)
      : checkpoint
        ? {
            phase: checkpoint.phase,
            cursor: (checkpoint.cursor ?? { pass: '1' }) as SandboxDrainCursor,
          }
        : parsePreviewCursor(undefined);
    const page =
      position.phase === 'deployments'
        ? await deploymentPage(db, env, position.cursor, true)
        : await resourcePage(db, env, position.cursor, true);
    const next = nextPosition(position.phase, position.cursor, page);
    return preview('system.sandbox-drain', 'managed-sandbox-containers', {
      phase: position.phase,
      pass: pass(position.cursor),
      ...page,
      nextCursor: next.complete ? null : JSON.stringify({ phase: next.phase, cursor: next.cursor }),
      complete: false,
      effect:
        'Block legacy tenant-owned Sandbox activation, cancel active legacy deployments, delete verified container applications, and verify two bounded passes.',
    });
  }

  const lease = await acquireSandboxDrainLease(db);
  if (lease.kind === 'complete') {
    return { ok: true, partial: false, complete: true, checkpoint: lease.checkpoint };
  }
  if (lease.kind === 'busy') {
    return {
      ok: false,
      partial: true,
      complete: false,
      busy: true,
      checkpoint: lease.checkpoint,
      message: 'Another Sandbox drain page is in progress. Retry after its lease expires.',
    };
  }
  const cursor = (lease.checkpoint.cursor ?? { pass: '1' }) as SandboxDrainCursor;
  const page =
    lease.checkpoint.phase === 'deployments'
      ? await deploymentPage(db, env, cursor, false)
      : await resourcePage(db, env, cursor, false);
  const leaseIdentity = { generation: lease.checkpoint.generation, owner: lease.owner };
  if (page.blockers.length > 0) {
    const checkpoint = await checkpointSandboxDrain(db, leaseIdentity, {
      phase: lease.checkpoint.phase,
      cursor,
    });
    return {
      ok: false,
      partial: true,
      complete: false,
      checkpoint,
      ...page,
      message: 'The Sandbox drain page is blocked. Resolve the reported identities and rerun.',
    };
  }
  const next = nextPosition(lease.checkpoint.phase, cursor, page);
  if (next.complete) {
    const checkpoint = await completeSandboxDrain(db, leaseIdentity);
    return {
      ok: true,
      partial: false,
      complete: true,
      checkpoint,
      ...page,
      message: 'Legacy tenant-owned Sandbox container applications are drained.',
    };
  }
  const checkpoint = await checkpointSandboxDrain(db, leaseIdentity, next);
  return {
    ok: false,
    partial: true,
    complete: false,
    checkpoint,
    ...page,
    message: 'Sandbox drain checkpoint advanced. Rerun to process the next bounded page.',
  };
}
