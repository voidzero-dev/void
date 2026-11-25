import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import type { SandboxConcurrencyCounter } from '../sandbox-concurrency-counter.ts';
import { getSandboxControllerSource } from '../sandbox-controller-source.ts';
import { deployments, projects } from '../schema.ts';
import type { DeployManifest } from '../types.ts';
import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  perDeployContainerApplicationName,
  prepareContainerImage,
  tryCreateContainerApplication,
} from './containers.ts';

const CONTROLLER_CLASS = 'SandboxController';
const CONTROLLER_BINDING = 'SANDBOX';
const OWNER_BINDING = '__VOID_SANDBOX_OWNER';

export type SandboxControllerIdentity = Readonly<{
  projectId: string;
  deploymentId: string;
  userId: string;
  slug: string;
}>;

type WorkerSettings = {
  bindings: Array<{
    type: string;
    name: string;
    text?: string;
    class_name?: string;
    namespace_id?: string;
    service?: string;
    entrypoint?: string;
  }>;
};

type SandboxCounterNamespace = DurableObjectNamespace<SandboxConcurrencyCounter>;

export function sandboxControllerWorkerName(projectId: string, deploymentId: string): string {
  return `void-sb-${projectId}-${deploymentId}`.toLowerCase().replaceAll('_', '-');
}

export function isManagedSandbox(manifest: DeployManifest | null | undefined): boolean {
  return manifest?.sandbox?.runtime?.protocol === 1 || manifest?.sandbox?.runtime?.protocol === 2;
}

export async function assertManagedSandboxEntitlement(
  accountId: string,
  apiToken: string,
): Promise<void> {
  try {
    await cfFetch(`${CF_API_BASE}/${accountId}/containers/applications`, apiToken);
  } catch {
    throw new Error(
      [
        'This app uses void/sandbox, but the platform could not verify Cloudflare Containers access.',
        'Cloudflare Containers require Workers Paid. Enable it for the platform account: https://dash.cloudflare.com/?to=/:account/workers/plans .',
        'The platform runtime API token needs Account / Containers: Edit and Account / Cloudchamber: Edit.',
        'An administrator can update the token and retry. No app resources were provisioned.',
      ].join(' '),
    );
  }
}

function workerUrl(accountId: string, workerName: string): string {
  return `${CF_API_BASE}/${accountId}/workers/scripts/${workerName}`;
}

async function readSettings(
  accountId: string,
  apiToken: string,
  workerName: string,
): Promise<WorkerSettings | undefined> {
  try {
    return await cfFetch<WorkerSettings>(`${workerUrl(accountId, workerName)}/settings`, apiToken);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

function assertOwnership(settings: WorkerSettings, projectId: string, deploymentId: string): void {
  const marker = settings.bindings.find(
    (binding) => binding.name === OWNER_BINDING && binding.type === 'plain_text',
  );
  if (marker?.text !== JSON.stringify({ protocol: 1, projectId, deploymentId })) {
    throw new Error(
      'Sandbox controller ownership does not match this deployment; refusing to modify it.',
    );
  }
}

function namespaceId(settings: WorkerSettings): string {
  const binding = settings.bindings.find(
    (binding) =>
      binding.type === 'durable_object_namespace' &&
      binding.name === CONTROLLER_BINDING &&
      binding.class_name === CONTROLLER_CLASS,
  );
  if (!binding?.namespace_id) {
    throw new Error('Sandbox controller Durable Object namespace is missing.');
  }
  return binding.namespace_id;
}

function plainTextBinding(settings: WorkerSettings, name: string): string | undefined {
  const binding = settings.bindings.find(
    (candidate) => candidate.type === 'plain_text' && candidate.name === name,
  );
  return binding?.text;
}

interface ControllerTextBindings {
  [key: string]: string;
}

function controllerTextBindings(
  identity: SandboxControllerIdentity,
  digest: string,
  image: string,
  instance: string,
): ControllerTextBindings {
  return {
    __VOID_SANDBOX_SOURCE: digest,
    __VOID_USER_ID: identity.userId,
    __PROJECT_ID: identity.projectId,
    __VOID_PROJECT_SLUG: identity.slug,
    __VOID_DEPLOYMENT_ID: identity.deploymentId,
    __VOID_SANDBOX_IMAGE: image,
    __VOID_SANDBOX_INSTANCE: instance,
  };
}

function assertConfiguration(
  settings: WorkerSettings,
  identity: SandboxControllerIdentity,
  apiService: string,
  expectedText: Record<string, string>,
): void {
  assertOwnership(settings, identity.projectId, identity.deploymentId);
  for (const [name, value] of Object.entries(expectedText)) {
    if (plainTextBinding(settings, name) !== value) {
      throw new Error(`Sandbox controller binding ${name} differs from this deployment.`);
    }
  }
  // Cloudflare does not return service binding `props` from `/settings`. The
  // plain-text bindings checked above come from the same upload as the props.
  const control = settings.bindings.find(
    (binding) => binding.type === 'service' && binding.name === '__VOID_SANDBOX_CONTROL',
  );
  if (control?.service !== apiService || control.entrypoint !== 'SandboxControl') {
    throw new Error('Sandbox controller authority binding differs from this deployment.');
  }
  namespaceId(settings);
}

export async function provisionSandboxController(input: {
  accountId: string;
  apiToken: string;
  apiService: string;
  identity: SandboxControllerIdentity;
  sandbox: NonNullable<DeployManifest['sandbox']>;
}): Promise<void> {
  const { accountId, apiToken, apiService, identity, sandbox } = input;
  const workerName = sandboxControllerWorkerName(identity.projectId, identity.deploymentId);
  const source = getSandboxControllerSource();
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const expectedText = controllerTextBindings(
    identity,
    digest,
    sandbox.image,
    sandbox.instanceType ?? 'lite',
  );
  const applicationName = perDeployContainerApplicationName(
    identity.projectId,
    identity.deploymentId,
    sandbox.containerName ?? 'void-sandbox-v1',
  );
  let settings = await readSettings(accountId, apiToken, workerName);
  if (settings) {
    assertConfiguration(settings, identity, apiService, expectedText);
  }
  await prepareContainerImage(accountId, apiToken, sandbox.image);
  if (!settings) {
    const form = new FormData();
    const metadata = {
      main_module: 'index.js',
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: [
        {
          type: 'durable_object_namespace',
          name: CONTROLLER_BINDING,
          class_name: CONTROLLER_CLASS,
        },
        {
          type: 'service',
          name: '__VOID_SANDBOX_CONTROL',
          service: apiService,
          entrypoint: 'SandboxControl',
          props: identity,
        },
        ...Object.entries({
          [OWNER_BINDING]: JSON.stringify({
            protocol: 1,
            projectId: identity.projectId,
            deploymentId: identity.deploymentId,
          }),
          ...expectedText,
        }).map(([name, text]) => ({ type: 'plain_text', name, text })),
      ],
      migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: [CONTROLLER_CLASS] }] },
      containers: [
        {
          class_name: CONTROLLER_CLASS,
          name: applicationName,
          images: sandbox.image === 'cloudflare/debian-trixie' ? {} : { default: sandbox.image },
        },
      ],
    };
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append(
      'index.js',
      new Blob([source], { type: 'application/javascript+module' }),
      'index.js',
    );
    const response = await fetch(workerUrl(accountId, workerName), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiToken}`, 'If-None-Match': '*' },
      body: form,
    });
    if (!response.ok && response.status !== 409 && response.status !== 412) {
      throw new Error(
        `Sandbox controller upload failed (HTTP ${response.status}): ${await response.text()}`,
      );
    }
    settings = await readSettings(accountId, apiToken, workerName);
    if (!settings) {
      throw new Error('Sandbox controller was not visible after upload. Retry the deployment.');
    }
    assertConfiguration(settings, identity, apiService, expectedText);
  }
  await cfFetch(`${workerUrl(accountId, workerName)}/subdomain`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ enabled: false, previews_enabled: false }),
  });
  const namespace = namespaceId(settings);
  const created = await tryCreateContainerApplication(accountId, apiToken, {
    name: applicationName,
    namespaceId: namespace,
  });
  const application =
    created ?? (await findContainerApplication(accountId, apiToken, applicationName));
  if (!application || application.durable_objects?.namespace_id !== namespace) {
    throw new Error('Sandbox container application does not belong to this controller namespace.');
  }
}

export async function verifySandboxController(
  accountId: string,
  apiToken: string,
  projectId: string,
  deploymentId: string,
  sandbox: NonNullable<DeployManifest['sandbox']>,
): Promise<void> {
  const settings = await readSettings(
    accountId,
    apiToken,
    sandboxControllerWorkerName(projectId, deploymentId),
  );
  if (!settings) {
    throw new Error('Sandbox controller is missing. Redeploy the app before rolling back.');
  }
  assertOwnership(settings, projectId, deploymentId);
  const application = await findContainerApplication(
    accountId,
    apiToken,
    perDeployContainerApplicationName(
      projectId,
      deploymentId,
      sandbox.containerName ?? 'void-sandbox',
    ),
  );
  if (!application || application.durable_objects?.namespace_id !== namespaceId(settings)) {
    throw new Error(
      'Sandbox container is missing or belongs to another controller. Redeploy the app before rolling back.',
    );
  }
}

/** Keep the controller until its billable container is confirmed deleted. */
export async function deleteSandboxController(
  accountId: string,
  apiToken: string,
  projectId: string,
  deploymentId: string,
  sandbox: NonNullable<DeployManifest['sandbox']>,
  counters: SandboxCounterNamespace,
  db?: Db,
): Promise<void> {
  const workerName = sandboxControllerWorkerName(projectId, deploymentId);
  const settings = await readSettings(accountId, apiToken, workerName);
  const application = await findContainerApplication(
    accountId,
    apiToken,
    perDeployContainerApplicationName(
      projectId,
      deploymentId,
      sandbox.containerName ?? 'void-sandbox',
    ),
  );
  if (!settings) {
    if (application) {
      throw new Error(
        'Cannot verify ownership of a Sandbox container whose controller is missing.',
      );
    }
    await revokeDeploymentCapacity(counters, db, undefined, projectId, deploymentId);
    if (db) {
      await markCleanupComplete(db, deploymentId);
    }
    return;
  }
  assertOwnership(settings, projectId, deploymentId);
  if (application) {
    if (application.durable_objects?.namespace_id !== namespaceId(settings)) {
      throw new Error('Refusing to delete a Sandbox container belonging to another namespace.');
    }
    await deleteContainerApplicationIdempotent(accountId, apiToken, application.id);
  }
  await revokeDeploymentCapacity(counters, db, settings, projectId, deploymentId);
  const response = await fetch(workerUrl(accountId, workerName), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) {
    const detail = await response
      .json()
      .then((value) => {
        const body = value as { errors?: Array<{ message?: string }> };
        return body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join(', ');
      })
      .catch(() => undefined);
    throw new Error(
      `Sandbox controller deletion failed (HTTP ${response.status}).${detail ? ` ${detail}` : ''}`,
    );
  }
  if (db) {
    await markCleanupComplete(db, deploymentId);
  }
}

async function revokeDeploymentCapacity(
  counters: SandboxCounterNamespace,
  db: Db | undefined,
  settings: WorkerSettings | undefined,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  let userId = settings ? plainTextBinding(settings, '__VOID_USER_ID') : undefined;
  let databaseUserId: string | undefined;
  if (db) {
    const [owner] = await db
      .select({ userId: projects.user_id })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.project_id))
      .where(and(eq(deployments.id, deploymentId), eq(deployments.project_id, projectId)))
      .limit(1);
    databaseUserId = owner?.userId;
  }
  if (databaseUserId && userId && userId !== databaseUserId) {
    throw new Error('Sandbox controller owner binding differs from the deployment owner.');
  }
  userId ??= databaseUserId;
  if (!userId) {
    throw new Error('Cannot release Sandbox capacity without the deployment owner identity.');
  }
  const counter = counters.get(counters.idFromName(`account:${userId}`));
  await counter.revokeDeployment(projectId, deploymentId);
}

async function markCleanupComplete(db: Db, deploymentId: string): Promise<void> {
  await db
    .update(deployments)
    .set({
      manifest: sql`jsonb_set(${deployments.manifest}::jsonb, '{sandbox,runtime,cleanupComplete}', 'true'::jsonb)::text`,
    })
    .where(eq(deployments.id, deploymentId));
}

/** Bounded, repeatable recovery for failed provider deletes after deployment eviction. */
export async function retrySandboxControllerCleanup(
  db: Db,
  env: Pick<ApiEnv['Bindings'], 'CF_ACCOUNT_ID' | 'CF_API_TOKEN' | 'SANDBOX_CONCURRENCY_COUNTER'>,
): Promise<void> {
  const rows = await db
    .select({
      id: deployments.id,
      projectId: deployments.project_id,
      manifest: deployments.manifest,
    })
    .from(deployments)
    .innerJoin(projects, eq(projects.id, deployments.project_id))
    .where(
      and(
        eq(deployments.retained, false),
        sql`${deployments.admission_protocol} >= 3`,
        sql`${deployments.status} IN ('live', 'failed', 'canceled')`,
        sql`${projects.active_deployment_id} IS DISTINCT FROM ${deployments.id}`,
        sql`${deployments.manifest}::jsonb #>> '{sandbox,runtime,protocol}' IN ('1', '2')`,
        sql`COALESCE(${deployments.manifest}::jsonb #>> '{sandbox,runtime,cleanupComplete}', 'false') <> 'true'`,
      ),
    )
    .orderBy(asc(deployments.updated_at), asc(deployments.id))
    .limit(16);
  for (const row of rows) {
    try {
      const manifest = row.manifest ? (JSON.parse(row.manifest) as DeployManifest) : null;
      if (!manifest?.sandbox) {
        throw new Error('Sandbox cleanup requires the deployment sandbox manifest.');
      }
      await deleteSandboxController(
        env.CF_ACCOUNT_ID,
        env.CF_API_TOKEN,
        row.projectId,
        row.id,
        manifest.sandbox,
        env.SANDBOX_CONCURRENCY_COUNTER,
        db,
      );
    } catch (error) {
      // Move a persistent provider failure behind other pending work.
      await db
        .update(deployments)
        .set({ updated_at: sql`now()` })
        .where(eq(deployments.id, row.id));
      console.error('Sandbox controller cleanup failed', { deploymentId: row.id, error });
    }
  }
}
