import { createDeployIntent, isR2LocationHint } from '@void/deploy-core';
import type { R2LocationHint } from '@void/deploy-core';
import { getProjectResources, createResource } from '../db.ts';
import type { Db } from '../db.ts';
import { getProjectQueueName } from '../naming.ts';
import type { DeployManifest, Resource } from '../types.ts';
import {
  createD1Database,
  createKVNamespace,
  createR2Bucket,
  createQueue,
  deleteD1Database,
  deleteKVNamespace,
  deleteQueue,
  deleteR2Bucket,
  setD1ReadReplication,
  ensureHyperdriveCachingDisabled,
  getD1DatabaseByName,
  getKVNamespaceByTitle,
  getQueueByName,
} from './cloudflare-api.ts';

export type WorkerBinding = Readonly<{
  type: 'd1' | 'kv_namespace' | 'r2_bucket' | 'queue' | 'service' | 'plain_text' | 'hyperdrive';
  name: string;
  id?: string;
  namespace_id?: string;
  bucket_name?: string;
  queue_name?: string;
  queue_id?: string;
  service?: string;
  text?: string;
}>;

export async function provisionBindings(
  db: Db,
  accountId: string,
  apiToken: string,
  projectId: string,
  manifest: DeployManifest,
  aiProxyService: string,
  /**
   * Per-project platform identity injected into every worker. Grouped into
   * an object rather than two more trailing strings — `projectId`,
   * `accountId`, `apiToken` and `projectSlug` are all bare strings, and a
   * transposed pair would provision against the wrong project silently.
   */
  platform: {
    /** Project slug. Framework reads it as `__VOID_PROJECT_SLUG`. */
    projectSlug: string;
    /** Token the Worker presents to the proxy. Framework reads it as `__VOID_PROXY_TOKEN`. */
    proxyToken: string;
    /** Immutable deployment identity for signed inbound email receipts. */
    deploymentId?: string;
    /**
     * Platform mail domain for this environment (`EMAIL_SENDER_DOMAIN` on
     * the api worker — `mail.void.cloud` in production,
     * `mail.voidcloud.dev` in staging). Never hard-coded: the proxy
     * validates outbound senders against its own copy of the same value,
     * so a baked-in production domain would make staging unsendable.
     *
     * Optional so a deployment environment with email unconfigured still
     * deploys. When absent the binding is omitted entirely rather than
     * injected empty — the framework's `sendEmail`/`replyEmail` then fail
     * naming `__VOID_EMAIL_DOMAIN`, which is a far better error than a
     * malformed `slug+noreply@` the proxy rejects for a different reason.
     */
    emailSenderDomain?: string;
    storageLocationHint?: string;
  },
): Promise<ReadonlyArray<WorkerBinding>> {
  const existing = await getProjectResources(db, projectId);
  const plan = createDeployIntent(manifest).resourcePlan;
  const locationHint = plan.resources.some((resource) => resource.type === 'r2')
    ? (manifest.storage?.locationHint ?? platform.storageLocationHint)
    : undefined;
  if (locationHint !== undefined && !isR2LocationHint(locationHint)) {
    throw new Error('Invalid R2 storage location hint.');
  }

  const tasks: Array<Promise<WorkerBinding>> = [];

  for (const resource of plan.resources) {
    switch (resource.type) {
      case 'd1':
        tasks.push(
          ensureResource(db, accountId, apiToken, projectId, 'd1', resource.bindingName, existing, {
            readReplication: resource.readReplication,
          }).then((r): WorkerBinding => ({ type: 'd1', name: resource.bindingName, id: r.cf_id })),
        );
        break;
      case 'kv':
        tasks.push(
          ensureResource(
            db,
            accountId,
            apiToken,
            projectId,
            'kv',
            resource.bindingName,
            existing,
          ).then((r): WorkerBinding => ({
            type: 'kv_namespace',
            name: resource.bindingName,
            namespace_id: r.cf_id,
          })),
        );
        break;
      case 'r2':
        tasks.push(
          ensureResource(db, accountId, apiToken, projectId, 'r2', resource.bindingName, existing, {
            locationHint,
          }).then((r): WorkerBinding => ({
            type: 'r2_bucket',
            name: resource.bindingName,
            bucket_name: r.cf_id,
          })),
        );
        break;
      case 'queue': {
        const queueName = getProjectQueueName(projectId, resource.resourceName);
        tasks.push(
          ensureResource(
            db,
            accountId,
            apiToken,
            projectId,
            'queue',
            resource.resourceName,
            existing,
          ).then((r): WorkerBinding => ({
            type: 'queue',
            name: resource.bindingName,
            queue_name: queueName,
            queue_id: r.cf_id,
          })),
        );
        break;
      }
      case 'hyperdrive': {
        const found = existing.find(
          (r) => r.type === 'hyperdrive' && r.binding_name === resource.bindingName,
        );
        if (!found) {
          throw new Error(
            `Hyperdrive not provisioned for binding "${resource.bindingName}". Run \`void db set-url\` first.`,
          );
        }
        tasks.push(
          ensureHyperdriveCachingDisabled(accountId, apiToken, found.cf_id).then(
            (): WorkerBinding => ({
              type: 'hyperdrive',
              name: resource.bindingName,
              id: found.cf_id,
            }),
          ),
        );
        break;
      }
    }
  }

  const bindings = await Promise.all(tasks);

  // Always inject proxy bindings — used by AI, revalidation, email, and future
  // platform features. The AI-specific usage limit check stays in the proxy
  // (/ai/* middleware).
  bindings.push({ type: 'service', name: '__VOID_PROXY', service: aiProxyService });
  bindings.push({ type: 'plain_text', name: '__PROJECT_ID', text: projectId });
  bindings.push({ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: platform.proxyToken });
  // Project slug — the SINGLE producer of `__VOID_PROJECT_SLUG`. `void/email`
  // needs it on every worker to default an outbound `from` to
  // `<slug>+noreply@<domain>`, and the sandbox runtime reads the same name.
  // Emitted after the user's vars in the upload array, so it cannot be
  // shadowed — see `reserved-bindings.ts`.
  bindings.push({ type: 'plain_text', name: '__VOID_PROJECT_SLUG', text: platform.projectSlug });
  if (manifest.emailProtocolVersion === 1) {
    if (!platform.deploymentId) {
      throw new Error('email delivery requires a deployment identity');
    }
    bindings.push({
      type: 'plain_text',
      name: '__VOID_EMAIL_DEPLOYMENT_ID',
      text: platform.deploymentId,
    });
  }
  if (platform.emailSenderDomain) {
    bindings.push({
      type: 'plain_text',
      name: '__VOID_EMAIL_DOMAIN',
      text: platform.emailSenderDomain,
    });
  }

  return bindings;
}

async function ensureResource(
  db: Db,
  accountId: string,
  apiToken: string,
  projectId: string,
  type: Resource['type'],
  bindingName: string,
  existing: ReadonlyArray<Resource>,
  options: { locationHint?: R2LocationHint; readReplication?: boolean } = {},
): Promise<Resource> {
  // Normalize: R2 bucket names only allow lowercase alphanumeric + hyphens
  const resourceName = `${projectId}-${bindingName}`.toLowerCase().replaceAll('_', '-');

  const found = existing.find((r) => r.type === type && r.binding_name === bindingName);
  if (found) {
    if (type === 'd1' && options.readReplication !== undefined) {
      await setD1ReadReplication(accountId, apiToken, found.cf_id, options.readReplication);
    }
    return found;
  }
  let cfId: string;
  // Track whether WE created the CF object. Only a self-created object is safe to
  // roll back below — an already-exists lookup may be adopting a pre-existing
  // resource we don't own.
  let createdByUs = false;

  try {
    cfId = await createCfResource(type, accountId, apiToken, resourceName, options);
    createdByUs = true;
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      cfId = await lookupCfResource(type, accountId, apiToken, resourceName);
      if (type === 'd1' && options.readReplication !== undefined) {
        await setD1ReadReplication(accountId, apiToken, cfId, options.readReplication);
      }
    } else {
      throw err;
    }
  }

  try {
    return await createResource(db, projectId, type, cfId, bindingName);
  } catch (err) {
    // The CF object exists but its `resources` row did not persist — most often a
    // FK violation because teardown deleted the project concurrently (the project
    // FOR UPDATE in deleteProjectCascade serializes against this INSERT's FK FOR
    // KEY SHARE). Without the row there is no durable handle, and teardown's
    // cascade-capture sweep can't see it, so it would orphan the CF object. Delete
    // what we just created before rethrowing. Best-effort: a failure here only
    // falls back to the same orphan we're trying to avoid. (Pre-existing objects
    // adopted via the already-exists lookup are left alone — not ours to delete.)
    if (createdByUs) {
      await deleteCfResource(type, accountId, apiToken, cfId).catch(() => {});
    }
    throw err;
  }
}

/** Delete a CF resource by type — the rollback dual of {@link createCfResource}. */
function deleteCfResource(
  type: Resource['type'],
  accountId: string,
  apiToken: string,
  cfId: string,
): Promise<void> {
  switch (type) {
    case 'd1':
      return deleteD1Database(accountId, apiToken, cfId);
    case 'kv':
      return deleteKVNamespace(accountId, apiToken, cfId);
    case 'r2':
      return deleteR2Bucket(accountId, apiToken, cfId);
    case 'queue':
      return deleteQueue(accountId, apiToken, cfId);
    case 'durable-object':
    case 'hyperdrive':
    case 'container':
      // ensureResource never creates these (createCfResource throws first), so a
      // rollback can't reach here. Resolve so the type switch stays exhaustive.
      return Promise.resolve();
  }
}

async function createCfResource(
  type: Resource['type'],
  accountId: string,
  apiToken: string,
  resourceName: string,
  options: { locationHint?: R2LocationHint; readReplication?: boolean },
): Promise<string> {
  switch (type) {
    case 'd1': {
      const result = await createD1Database(accountId, apiToken, resourceName, {
        readReplication: options.readReplication,
      });
      return result.uuid;
    }
    case 'kv': {
      const result = await createKVNamespace(accountId, apiToken, resourceName);
      return result.id;
    }
    case 'r2': {
      const result = await createR2Bucket(accountId, apiToken, resourceName, options.locationHint);
      return result.name;
    }
    case 'queue': {
      const result = await createQueue(accountId, apiToken, resourceName);
      return result.queue_id;
    }
    case 'hyperdrive':
      throw new Error(
        'Hyperdrive resources are provisioned via the database endpoint, not ensureResource',
      );
    case 'durable-object':
      throw new Error('Custom Durable Objects are provisioned during Worker deployment');
    case 'container':
      throw new Error('Container resources are provisioned during sandbox deployment');
  }
}

async function lookupCfResource(
  type: Resource['type'],
  accountId: string,
  apiToken: string,
  resourceName: string,
): Promise<string> {
  switch (type) {
    case 'd1': {
      const result = await getD1DatabaseByName(accountId, apiToken, resourceName);
      return result.uuid;
    }
    case 'kv': {
      const result = await getKVNamespaceByTitle(accountId, apiToken, resourceName);
      return result.id;
    }
    case 'r2':
      // R2 bucket name IS the cf_id — no lookup API needed
      return resourceName;
    case 'queue': {
      const result = await getQueueByName(accountId, apiToken, resourceName);
      return result.queue_id;
    }
    case 'hyperdrive':
      throw new Error(
        'Hyperdrive resources are provisioned via the database endpoint, not ensureResource',
      );
    case 'durable-object':
      throw new Error('Custom Durable Objects are provisioned during Worker deployment');
    case 'container':
      throw new Error('Container resources are provisioned during sandbox deployment');
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return msg.includes('already exists') || msg.includes('already been created');
}
