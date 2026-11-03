import { and, eq, getTableColumns, lte, ne, or, sql } from 'drizzle-orm';
import { paginatedR2Delete } from './assets.ts';
import { activeOAuthApproval } from './auth/oauth.ts';
import { R2_CONCURRENCY } from './concurrency.ts';
import { createDb, type Db, type DbOrTx } from './db.ts';
import { WORKER_UPLOAD_MAX_AGE_MS, type WorkerUploadModule } from './deploy/shared.ts';
import type { DeploymentInput, DeploymentOperation } from './deployment-operation-types.ts';
import type { ApiEnv } from './env.ts';
import { deploymentOperations, projectDeployCredentials, projects, users } from './schema.ts';
import { isAdminSuspended } from './suspension.ts';
import type { DeployEvent, DeployManifest } from './types.ts';
import { listR2Objects, r2WorkerModule, type WorkerModule } from './worker-upload.ts';
export type {
  DeploymentInput,
  DeploymentOperation,
  DeploymentProgress,
} from './deployment-operation-types.ts';

// Queue invocations have a 15-minute wall-clock limit. Recovery starts after
// that invocation is gone, and never repeats its provider writes or SQL.
export const DEPLOYMENT_INVOCATION_MS = 15 * 60 * 1000;
export const DEPLOYMENT_EXECUTION_LEASE_MS = 18 * 60 * 1000;
// Worker uploads of a run (the application, then each custom Durable Object
// host) end this long before the invocation does. Each host upload also leaves
// time before then to replay the committed release onto every host the run has
// moved, so a failed run can undo them. This reserve then covers restoring
// routing, queues and cron, and an undo slower than the move it reverts. The
// other 10 minutes cover the 8-minute application upload budget and the steps
// before it.
export const DEPLOYMENT_COMPENSATION_RESERVE_MS = 5 * 60 * 1000;
const MAX_PROGRESS_EVENTS = 1000;

export async function installationDeploymentAdmissionClosed(
  db: DbOrTx,
  installationId?: string,
): Promise<boolean> {
  if (!installationId) {
    return false;
  }
  // Lifecycle checkpoints UPDATE this row. The shared lock serializes new
  // admissions with maintenance/downgrade while admitted jobs keep draining.
  const result = await db.execute(sql`SELECT installation_id, lifecycle_manifest
    FROM public.__void_platform_installation WHERE singleton = true FOR SHARE`);
  const row = result.rows[0] as
    | { installation_id: string; lifecycle_manifest: { status?: string; desiredState?: string } }
    | undefined;
  return (
    !row ||
    row.installation_id !== installationId ||
    row.lifecycle_manifest.status !== 'installed' ||
    row.lifecycle_manifest.desiredState !== 'enabled'
  );
}

export async function deploymentExecutionStatus(db: Db, installationId?: string) {
  return db.transaction(async (tx) => {
    const admissionClosed = await installationDeploymentAdmissionClosed(tx, installationId);
    const result = await tx.execute(
      sql`SELECT count(*)::integer AS count FROM deployment_operations WHERE status <> 'terminal'`,
    );
    return {
      protocolVersion: 1 as const,
      installationId,
      pendingDeployments: Number(result.rows[0]?.count ?? 0),
      admissionClosed,
    };
  });
}

export async function getDeploymentOperation(db: DbOrTx, id: string) {
  const [operation] = await db
    .select({
      ...getTableColumns(deploymentOperations),
      // The stored lease is a timestamp without time zone. Resolve it in the
      // SQL session's zone so observers receive an unambiguous UTC instant.
      lease_expires_at: sql<string | null>`to_char(
        ${deploymentOperations.lease_expires_at} AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(deploymentOperations)
    .where(eq(deploymentOperations.id, id));
  return operation ?? null;
}

export async function findDeploymentOperation(
  db: DbOrTx,
  projectId: string,
  actorId: string,
  key: string,
) {
  const [operation] = await db
    .select()
    .from(deploymentOperations)
    .where(
      and(
        eq(deploymentOperations.project_id, projectId),
        eq(deploymentOperations.actor_id, actorId),
        eq(deploymentOperations.idempotency_key, key),
      ),
    );
  return operation ?? null;
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** R2 prefix holding one deployment attempt's input. */
export function deploymentInputPrefix(projectId: string, id: string): string {
  return `deployment-inputs/${projectId}/${id}/`;
}

/** Stream one input module, checked against its size and recorded digest. */
export function deploymentInputModule(
  r2: R2Bucket,
  module: DeploymentInput['modules'][number],
  size: number,
): WorkerModule {
  return r2WorkerModule(
    r2,
    { name: module.name, key: module.key, type: module.type, size, sha256: module.digest },
    {
      missing: 'Durable deployment input is missing',
      changed: 'Durable deployment input digest mismatch',
    },
  );
}

type DeploymentInputOptions = {
  appType: DeployManifest['type'];
  credentialId?: string;
  oauthApproval?: string;
};

function deploymentInputRecord(
  body: Record<string, unknown>,
  { credentialId, oauthApproval }: DeploymentInputOptions,
): DeploymentInput {
  const input: DeploymentInput = {
    body: { ...body },
    modules: [],
    ...(credentialId ? { credentialId } : {}),
    ...(oauthApproval ? { oauthApproval } : {}),
  };
  // Module bytes live in R2; the executor reads them from `modules`.
  delete input.body.workerFiles;
  delete input.body.workerInput;
  return input;
}

async function deploymentInputDigest(input: DeploymentInput): Promise<string> {
  const identity = JSON.stringify({
    body: input.body,
    modules: input.modules.map(({ name, digest, type }) => ({ name, digest, type })),
  });
  return sha256Hex(new TextEncoder().encode(identity));
}

async function writeDeploymentInputReceipt(
  r2: R2Bucket,
  prefix: string,
  appType: DeployManifest['type'],
  moduleCount: number,
): Promise<void> {
  // Attribute the existing staging write without extra requests. This marks
  // prepared input, including no-op redeploys and later failures, not a live
  // publication. Keep the parent prefix unchanged for cleanup and recovery.
  const kind = appType === 'spa' ? 'spa' : moduleCount > 0 ? 'worker' : 'static';
  await r2.put(`${prefix}receipt-void-platform-${kind}`, JSON.stringify({ createdAt: Date.now() }));
}

export async function prepareDeploymentInput(
  r2: R2Bucket,
  projectId: string,
  body: Record<string, unknown>,
  files: Array<{ name: string; content: Blob }>,
  options: DeploymentInputOptions,
) {
  const prefix = deploymentInputPrefix(projectId, crypto.randomUUID());
  const input = deploymentInputRecord(body, options);
  try {
    // Hash one module at a time so at most one extra copy of module bytes is
    // alive beside the decoded Blobs; a near-cap request already sits close
    // to the isolate memory limit.
    const modules: DeploymentInput['modules'] = [];
    for (let index = 0; index < files.length; index++) {
      const { name, content } = files[index]!;
      const digest = await sha256Hex(await content.arrayBuffer());
      modules.push({
        name,
        key: `${prefix}${index}`,
        digest,
        type: content.type,
        size: content.size,
      });
    }
    // The request has not answered yet, so upload the Blobs themselves in
    // parallel. Workers let at most six R2 calls wait for a response at once
    // (R2_CONCURRENCY); a larger pool would only queue inside the runtime.
    // After the first failure no new put starts, and every started put
    // settles before cleanup so none lands under the prefix after it was
    // deleted.
    let next = 0;
    let failed = false;
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(R2_CONCURRENCY, files.length) }, async () => {
        while (!failed && next < files.length) {
          const index = next++;
          try {
            await r2.put(modules[index]!.key, files[index]!.content);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }),
    );
    const rejected = workers.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) {
      throw rejected.reason;
    }
    input.modules = modules;
    const digest = await deploymentInputDigest(input);
    await writeDeploymentInputReceipt(r2, prefix, options.appType, files.length);
    return { input, prefix, digest };
  } catch (error) {
    await paginatedR2Delete(r2, prefix).catch(() => {});
    throw error;
  }
}

/**
 * Explain why a direct Worker upload under `prefix` cannot be deployed, or
 * return null. One paginated listing covers every module: object `i` must
 * exist with module `i`'s declared size and be recent enough that the
 * stale-input sweep cannot remove it while the deploy runs. Bytes are checked
 * against their digests when they stream to Cloudflare.
 */
export async function uploadedWorkerInputProblem(
  r2: R2Bucket,
  prefix: string,
  modules: ReadonlyArray<WorkerUploadModule>,
): Promise<string | null> {
  const stored = await listR2Objects(r2, prefix);
  const oldest = Date.now() - WORKER_UPLOAD_MAX_AGE_MS;
  for (const [index, module] of modules.entries()) {
    const object = stored.get(`${prefix}${index}`);
    const name = JSON.stringify(module.name);
    if (!object) {
      return `Worker module ${name} was not uploaded. Run the deploy again.`;
    }
    if (object.size !== module.size) {
      return `Worker module ${name} has ${object.size} bytes in storage instead of ${module.size}. Run the deploy again.`;
    }
    if (object.uploaded.getTime() < oldest) {
      return `Worker module ${name} was uploaded more than 12 hours ago. Run the deploy again.`;
    }
  }
  return null;
}

/**
 * The durable input for a Worker upload the CLI already put under `prefix`,
 * and its digest. Nothing is written, so a retry can match the operation that
 * admitted this input after its cleanup deleted the prefix.
 */
export async function uploadedDeploymentInput(
  prefix: string,
  body: Record<string, unknown>,
  modules: DeploymentInput['modules'],
  options: DeploymentInputOptions,
) {
  const input = deploymentInputRecord(body, options);
  input.modules = modules;
  return { input, prefix, digest: await deploymentInputDigest(input) };
}

/**
 * Record a Worker upload as durable input. The bytes stay where they were
 * uploaded; only the receipt marker is written. A request never deletes this
 * prefix itself: a retry of the same deploy reuses it, so the admitted
 * operation's input cleanup or the stale-input sweep removes it.
 */
export async function recordUploadedDeploymentInput(
  r2: R2Bucket,
  uploaded: Awaited<ReturnType<typeof uploadedDeploymentInput>>,
  appType: DeployManifest['type'],
) {
  await writeDeploymentInputReceipt(r2, uploaded.prefix, appType, uploaded.input.modules.length);
  return uploaded;
}

export async function assertDeploymentExecutionAuthority(
  db: DbOrTx,
  operation: DeploymentOperation,
): Promise<void> {
  if (operation.payload.oauthApproval) {
    const { approval, user } = await activeOAuthApproval(
      db,
      operation.payload.oauthApproval,
      undefined,
      true,
    );
    if (approval.data.projectId !== operation.project_id || user.id !== operation.actor_id) {
      throw new Error('Deployment approval is no longer active');
    }
  }
  const [actor] = await db
    .select({ reason: users.suspended_reason })
    .from(users)
    .where(eq(users.id, operation.actor_id))
    .limit(1);
  if (!actor || isAdminSuspended(actor.reason)) {
    throw new Error('Deployment actor is no longer active');
  }
  if (!operation.payload.credentialId) {
    return;
  }
  const [credential] = await db
    .select({ id: projectDeployCredentials.id })
    .from(projectDeployCredentials)
    .innerJoin(projects, eq(projects.id, projectDeployCredentials.project_id))
    .where(
      and(
        eq(projectDeployCredentials.id, operation.payload.credentialId),
        eq(projectDeployCredentials.project_id, operation.project_id),
        eq(projectDeployCredentials.issued_by, operation.actor_id),
        eq(projects.user_id, operation.actor_id),
        sql`${projectDeployCredentials.revoked_at} IS NULL`,
        sql`${projectDeployCredentials.expires_at} > now()`,
      ),
    )
    .limit(1);
  if (!credential) {
    throw new Error('Deployment actor or credential is no longer active');
  }
}

export async function appendDeploymentEvent(
  db: DbOrTx,
  id: string,
  ownerId: string,
  event: DeployEvent,
): Promise<void> {
  if (event.event === 'heartbeat') {
    return;
  }
  const terminal = event.event === 'done' || event.event === 'error';
  // Heartbeats and excessive intermediate events are omitted. The terminal
  // result always gets a sequence and is committed with the terminal state.
  await db.execute(sql`UPDATE deployment_operations SET
    events = events || jsonb_build_array(jsonb_build_object('seq', last_seq + 1, 'event', ${JSON.stringify(event)}::jsonb)),
    last_seq = last_seq + 1,
    status = CASE WHEN ${terminal} THEN 'terminal' ELSE status END
    WHERE id = ${id} AND owner_id = ${ownerId} AND status <> 'terminal'
      AND (${terminal} OR last_seq < ${MAX_PROGRESS_EVENTS})`);
}

export function deploymentEventPage(operation: DeploymentOperation, since: number) {
  const events = operation.events.filter((item) => item.seq > since).slice(0, 100);
  const lastSeq = events.at(-1)?.seq ?? Math.min(since, operation.last_seq);
  return {
    deploymentId: operation.id,
    events,
    lastSeq,
    terminal: operation.status === 'terminal' && lastSeq >= operation.last_seq,
    ...(operation.status !== 'terminal' && {
      heartbeat: {
        event: 'heartbeat' as const,
        deploymentId: operation.id,
        step:
          operation.status === 'recovering'
            ? 'recovery'
            : (operation.events.at(-1)?.event.event ?? 'queued'),
        status: operation.status,
        ...(operation.lease_expires_at && {
          recoveryAt: new Date(operation.lease_expires_at).toISOString(),
        }),
      },
    }),
  };
}

export function deploymentReceiptResponse(db: Db, id: string): Response {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const poll = async () => {
        if (stopped) {
          return;
        }
        try {
          const operation = await getDeploymentOperation(db, id);
          if (stopped) {
            return;
          }
          if (!operation) {
            throw new Error('Deployment receipt no longer exists');
          }
          const page = deploymentEventPage(operation, cursor);
          for (const item of page.events) {
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ ...item.event, seq: item.seq })}\n`),
            );
          }
          cursor = page.lastSeq;
          if (page.terminal) {
            stopped = true;
            controller.close();
            return;
          }
          if (!page.events.length) {
            controller.enqueue(encoder.encode(`${JSON.stringify(page.heartbeat)}\n`));
          }
          timer = setTimeout(() => {
            void poll();
          }, 1000);
        } catch (error) {
          stopped = true;
          controller.error(error);
        }
      };
      await poll();
    },
    cancel() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson', 'x-void-deployment-id': id },
  });
}

export async function dispatchDeploymentOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  id: string,
): Promise<void> {
  if (!env.DEPLOYMENTS_QUEUE) {
    throw new Error('Deployment Queue is unavailable');
  }
  // Stamp before send: a lost send acknowledgement is harmless; the outbox
  // sends again and the execution claim rejects duplicate deliveries.
  await db
    .update(deploymentOperations)
    .set({ next_dispatch_at: sql`now() + interval '2 minutes'` })
    .where(and(eq(deploymentOperations.id, id), ne(deploymentOperations.status, 'terminal')));
  await env.DEPLOYMENTS_QUEUE.send({ deploymentId: id });
}

/** Queued, or abandoned by a runner whose lease has expired. */
function claimableOperation() {
  return or(
    eq(deploymentOperations.status, 'queued'),
    and(
      ne(deploymentOperations.status, 'terminal'),
      lte(deploymentOperations.lease_expires_at, sql`now()`),
    ),
  );
}

async function deleteDeploymentInputs(
  env: ApiEnv['Bindings'],
  db: Db,
  operation: Readonly<{ id: string; input_prefix: string }>,
): Promise<void> {
  await paginatedR2Delete(env.STATIC_ASSETS_R2, operation.input_prefix);
  await db
    .update(deploymentOperations)
    .set({ inputs_deleted: true, payload: { body: {}, modules: [] } })
    .where(eq(deploymentOperations.id, operation.id));
}

export async function dispatchPendingDeployments(env: ApiEnv['Bindings'], db: Db): Promise<void> {
  if (!env.DEPLOYMENTS_QUEUE) {
    return;
  }
  const pending = await db
    .select({ id: deploymentOperations.id })
    .from(deploymentOperations)
    .where(and(lte(deploymentOperations.next_dispatch_at, sql`now()`), claimableOperation()))
    .limit(20);
  for (const operation of pending) {
    await dispatchDeploymentOperation(env, db, operation.id);
  }
  const completed = await db
    .select()
    .from(deploymentOperations)
    .where(
      and(
        eq(deploymentOperations.status, 'terminal'),
        eq(deploymentOperations.inputs_deleted, false),
      ),
    )
    .limit(20);
  for (const operation of completed) {
    await deleteDeploymentInputs(env, db, operation);
  }
  await sweepStaleDeploymentInputs(env, db);
}

/**
 * Stage-before-admission avoids holding a project transaction across R2
 * uploads, and CLIs upload Worker modules before they finalize a deploy. A
 * killed request or an abandoned upload can leave input behind; walk one
 * bounded page per tick and delete only old prefixes with no acknowledged
 * receipt.
 */
export async function sweepStaleDeploymentInputs(env: ApiEnv['Bindings'], db: Db): Promise<void> {
  const sweepKey = 'deployment-input-sweep:v1';
  const cursor = await env.ROUTING.get(sweepKey);
  const page = await env.STATIC_ASSETS_R2.list({
    prefix: 'deployment-inputs/',
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  const checked = new Map<string, boolean>();
  for (const object of page.objects) {
    if (object.uploaded.getTime() > Date.now() - 24 * 60 * 60 * 1000) {
      continue;
    }
    const prefix = object.key.slice(0, object.key.lastIndexOf('/') + 1);
    let protectedInput = checked.get(prefix);
    if (protectedInput === undefined) {
      const [operation] = await db
        .select({ id: deploymentOperations.id })
        .from(deploymentOperations)
        .where(eq(deploymentOperations.input_prefix, prefix))
        .limit(1);
      protectedInput = operation !== undefined;
      checked.set(prefix, protectedInput);
    }
    if (!protectedInput) {
      await env.STATIC_ASSETS_R2.delete(object.key);
    }
  }
  if (page.truncated) {
    await env.ROUTING.put(sweepKey, page.cursor);
  } else {
    await env.ROUTING.delete(sweepKey);
  }
}

export async function processDeploymentBatch(
  batch: MessageBatch<unknown>,
  env: ApiEnv['Bindings'],
): Promise<void> {
  const uploadDeadline = Date.now() + DEPLOYMENT_INVOCATION_MS - DEPLOYMENT_COMPENSATION_RESERVE_MS;
  const db = createDb(env.HYPERDRIVE.connectionString);
  for (const message of batch.messages) {
    const body = message.body as { deploymentId?: unknown } | null;
    if (!body || typeof body.deploymentId !== 'string') {
      message.ack();
      continue;
    }
    const id = body.deploymentId;
    const ownerId = crypto.randomUUID();
    const [operation] = await db
      .update(deploymentOperations)
      .set({
        owner_id: ownerId,
        lease_expires_at: sql`now() + (${DEPLOYMENT_EXECUTION_LEASE_MS} * interval '1 millisecond')`,
        status: sql`CASE WHEN status = 'queued' THEN 'running' ELSE 'recovering' END`,
      })
      .where(and(eq(deploymentOperations.id, id), claimableOperation()))
      .returning();
    if (!operation) {
      message.ack();
      continue;
    }
    console.info('[deployment-execution] execution claimed', {
      deploymentId: id,
      status: operation.status,
    });
    try {
      if (operation.status === 'recovering') {
        const { settleExpiredDeployment } = await import('./deployment-recovery.ts');
        const result = await settleExpiredDeployment(env, db, id);
        if (!result.terminal || !result.event) {
          await db
            .update(deploymentOperations)
            .set({ lease_expires_at: sql`now() + interval '1 minute'` })
            .where(
              and(eq(deploymentOperations.id, id), eq(deploymentOperations.owner_id, ownerId)),
            );
          message.retry({ delaySeconds: 60 });
          continue;
        }
        await appendDeploymentEvent(
          db,
          id,
          ownerId,
          result.event.event === 'done'
            ? { ...result.event, workers: operation.payload.modules.length }
            : result.event,
        );
      } else {
        const { executeQueuedDeployment } = await import('./routes/deploy.ts');
        await executeQueuedDeployment(env, db, operation, uploadDeadline);
      }
      const latest = await getDeploymentOperation(db, id);
      if (latest?.status !== 'terminal') {
        message.retry({ delaySeconds: 60 });
        continue;
      }
      await deleteDeploymentInputs(env, db, operation);
      message.ack();
    } catch (error) {
      console.error('[deployment-execution] execution/reconciliation interrupted', {
        deploymentId: id,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      });
      // A returned recovery failure has no deployment execution left to fence:
      // it only reconciles the abandoned candidate. Match the retry interval
      // used for an incomplete recovery instead of retaining its hard lifetime.
      // An interrupted initial execution still needs the full lease because
      // its provisioning or remotely committed SQL may be unresolved.
      if (operation.status === 'recovering') {
        await db
          .update(deploymentOperations)
          .set({ lease_expires_at: sql`now() + interval '1 minute'` })
          .where(and(eq(deploymentOperations.id, id), eq(deploymentOperations.owner_id, ownerId)));
      }
      message.retry({ delaySeconds: 60 });
    }
  }
}
