import { and, count, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { constantTimeEqual } from '../auth/hmac.ts';
import type { Db, DbOrTx, Tx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  PROJECT_PERMISSION_MESSAGES,
  requireProjectCapability,
} from '../project-access.ts';
import { decryptPlatformCredential, encryptPlatformCredential } from '../project-secrets.ts';
import { CloudflareApiError } from '../provisioning/cloudflare-api.ts';
import { projects } from '../schema.ts';
import { emailUnresolvedAttempts } from './admission-schema.ts';
import { disableEmailDomainRouteAndDrainTx, lockEmailPolicy } from './admission.ts';
import { createCfCustomerClient } from './cf-customer.ts';
import {
  findZoneForEmailDomain,
  lookupMxOverDns,
  sendingOnboardedReadback,
} from './cf-domain-probes.ts';
import {
  emailCacheOutbox,
  emailCredentials,
  emailDomainRoutes,
  emailOperations,
  emailOperationSteps,
  emailZoneConnections,
  type EmailInboundMode,
} from './connection-schema.ts';
import { isValidEmailDomain, normalizeEmailDomain } from './domain-name.ts';
import { RELAY_COMPATIBILITY_DATE, RELAY_SOURCE, RELAY_VERSION } from './relay-worker.ts';

type Bindings = ApiEnv['Bindings'];
export type EmailActor =
  | { kind: 'owner'; userId: string }
  | { kind: 'admin'; userId: string }
  | { kind: 'system' };
export class EmailOperationError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly userMessage?: string,
  ) {
    super(message);
  }
}

export class EmailCredentialExpiredError extends EmailOperationError {
  constructor() {
    super('email connection credential has expired', 503);
  }
}

export function isEmailCredentialExpired(expiresOn: string | null): boolean {
  if (!expiresOn) {
    return false;
  }
  const expiresAt = Date.parse(expiresOn);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function verifiedApiTokenMetadata(verification: { id: string; expires_on?: string | null }): {
  tokenId: string;
  expiresOn: string | null;
} {
  if (!verification.id) {
    throw new EmailOperationError('Cloudflare API token identity is unavailable', 503);
  }
  if (!verification.expires_on) {
    return { tokenId: verification.id, expiresOn: null };
  }
  const expiresAt = Date.parse(verification.expires_on);
  if (!Number.isFinite(expiresAt)) {
    throw new EmailOperationError('Cloudflare API token expiry is invalid', 503);
  }
  if (expiresAt <= Date.now()) {
    throw new EmailOperationError('Cloudflare API token has expired', 403);
  }
  return { tokenId: verification.id, expiresOn: new Date(expiresAt).toISOString() };
}

/** A failed local/read-only prerequisite proves that no provider mutation ran. */
class EmailOperationPreflightError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'EmailOperationPreflightError';
  }
}

async function emailOperationPreflight<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EmailOperationPreflightError) {
      throw error;
    }
    throw new EmailOperationPreflightError(error);
  }
}

export const EMAIL_OPERATION_RECOVERY_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const SETUP_STEPS = [
  'routing_enable',
  'ingress_deploy',
  'probe_route_enable',
  'secret_put',
  'relay_probe',
  'gateway_probe',
  'catchall_ensure',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
const STAGED_SECRET_REPAIR_STEPS = [
  'routing_enable',
  'ingress_deploy',
  'probe_route_enable',
  'secret_put',
  'relay_probe',
  'gateway_probe',
  'secret_retire',
  'catchall_ensure',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
const SYNC_STEPS = [
  'ingress_deploy',
  'probe_route_enable',
  'relay_probe',
  'gateway_probe',
  'catchall_ensure',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
const SIBLING_STEPS = [
  'routing_enable',
  'gateway_probe',
  'catchall_ensure',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
const SHARED_SYNC_STEPS = [
  'routing_enable',
  'subaddressing_ensure',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
// Custom apex routes can share the installation Worker, while their catch-all
// still needs to be provisioned. Native Worker secrets are deployment-owned.
const NATIVE_CUSTOM_SYNC_STEPS = [
  'routing_enable',
  'catchall_ensure',
  'inbound_probe',
  'sending_onboard',
  'publish',
] as const;
// Outbound-only routes never deploy ingress or touch Email Routing, so the apex MX is left alone.
const OUTBOUND_ONLY_STEPS = ['sending_onboard', 'publish'] as const;
const OUTBOUND_ONLY_INBOUND_REASON =
  "Outbound only: inbound mail stays with the domain's MX provider";
const REMOVE_STEPS = ['route_disable', 'catchall_detach', 'ingress_delete', 'publish'] as const;
const ROTATE_STEPS = [
  'secret_put',
  'relay_probe',
  'gateway_probe',
  'secret_promote',
  'publish',
] as const;
type StepKind =
  | (typeof SETUP_STEPS)[number]
  | (typeof STAGED_SECRET_REPAIR_STEPS)[number]
  | (typeof OUTBOUND_ONLY_STEPS)[number]
  | (typeof REMOVE_STEPS)[number]
  | (typeof SHARED_SYNC_STEPS)[number]
  | (typeof ROTATE_STEPS)[number];
const OPERATOR_RECOVERABLE_WRITE_STEPS = [
  'routing_enable',
  'ingress_deploy',
  'probe_route_enable',
  'secret_put',
  'catchall_ensure',
  'subaddressing_ensure',
  'sending_onboard',
  'catchall_detach',
  'ingress_delete',
] as const satisfies ReadonlyArray<StepKind>;
type OperatorRecoverableWriteStep = (typeof OPERATOR_RECOVERABLE_WRITE_STEPS)[number];
function isOperatorRecoverableWriteStep(kind: string): kind is OperatorRecoverableWriteStep {
  return (OPERATOR_RECOVERABLE_WRITE_STEPS as ReadonlyArray<string>).includes(kind);
}

async function findEmailOperationByKey(
  db: DbOrTx,
  installationId: string,
  actorScope: string,
  key: string,
) {
  const [operation] = await db
    .select()
    .from(emailOperations)
    .where(
      and(
        eq(emailOperations.installation_id, installationId),
        eq(emailOperations.actor_scope, actorScope),
        eq(emailOperations.idempotency_key, key),
      ),
    )
    .limit(1);
  return operation;
}

async function findUnresolvedConnectionOperation(db: DbOrTx, connectionId: string) {
  const [operation] = await db
    .select({ id: emailOperations.id })
    .from(emailOperations)
    .where(
      and(
        eq(emailOperations.connection_id, connectionId),
        inArray(emailOperations.status, ['pending', 'running', 'unknown']),
      ),
    )
    .limit(1);
  return operation;
}

async function findEmailRoute(db: DbOrTx, routeId: string | null) {
  if (!routeId) {
    return null;
  }
  const [route] = await db
    .select()
    .from(emailDomainRoutes)
    .where(eq(emailDomainRoutes.id, routeId))
    .limit(1);
  return route ?? null;
}

function supportsSubaddressing(settings: unknown): boolean {
  return (
    !!settings &&
    typeof settings === 'object' &&
    (settings as { support_subaddress?: unknown }).support_subaddress === true
  );
}

type EmailStepRoute = Pick<
  typeof emailDomainRoutes.$inferSelect,
  'id' | 'domain' | 'desired_generation'
>;

export function emailInstallationId(env: Bindings): string {
  return env.PLATFORM_INSTALLATION_ID ?? 'void-hosted';
}
async function lockEmailZoneConnectionIdentity(
  tx: Tx,
  installationId: string,
  accountId: string,
  zoneId: string,
): Promise<void> {
  const identity = `email-zone-connection-v1:${installationId}:${accountId}:${zoneId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);
}
function gatewayOrigin(env: Bindings): string {
  const origin = env.EMAIL_GATEWAY_ORIGIN;
  if (!origin || !/^https:\/\/[^/]+$/i.test(origin)) {
    throw new EmailOperationError(
      'EMAIL_GATEWAY_ORIGIN must be configured before email ingress setup',
      503,
    );
  }
  return origin;
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
function randomSecret(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
async function relayProof(
  secret: string,
  connection: typeof emailZoneConnections.$inferSelect,
  generation: number,
  challenge: string,
): Promise<string> {
  const data = [
    'email-relay-proof-v1',
    connection.account_id,
    connection.zone_id,
    connection.ingress_worker_name,
    String(generation),
    challenge,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))),
  );
}
async function probeDeployedRelay(
  client: ReturnType<typeof createCfCustomerClient>,
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
  staged: boolean,
): Promise<Record<string, unknown>> {
  if (
    !(await client.getScriptSubdomainEnabled(connection.account_id, connection.ingress_worker_name))
  ) {
    throw new EmailOperationError('ingress probe endpoint is disabled', 503);
  }
  const subdomain = await client.getWorkersSubdomain(connection.account_id);
  if (!/^[a-z0-9-]+$/i.test(subdomain)) {
    throw new EmailOperationError('invalid Cloudflare Workers subdomain', 503);
  }
  const generation = staged
    ? connection.staged_secret_generation
    : connection.active_secret_generation;
  if (generation === null) {
    throw new EmailOperationError('staged ingress generation is absent');
  }
  const secret = staged
    ? await readStagedConnectionSecret(env, connection)
    : await readConnectionSecret(env, connection);
  const challenge = randomSecret();
  const response = await fetch(
    `https://${connection.ingress_worker_name}.${subdomain}.workers.dev/__void/email/probe`,
    {
      method: 'POST',
      headers: {
        'X-Void-Probe-Challenge': challenge,
        'X-Void-Probe-Generation': String(generation),
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new EmailOperationError(`deployed ingress probe returned HTTP ${response.status}`, 503);
  }
  if (!response.body) {
    throw new EmailOperationError('deployed ingress proof body is empty', 503);
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > 2048) {
        throw new EmailOperationError('deployed ingress proof is too large', 503);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: {
    accountId?: unknown;
    zoneId?: unknown;
    ingressName?: unknown;
    generation?: unknown;
    challenge?: unknown;
    proof?: unknown;
  };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EmailOperationError('deployed ingress proof is invalid', 503);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new EmailOperationError('deployed ingress proof is invalid', 503);
  }
  if (
    body.accountId !== connection.account_id ||
    body.zoneId !== connection.zone_id ||
    body.ingressName !== connection.ingress_worker_name ||
    body.generation !== generation ||
    body.challenge !== challenge ||
    typeof body.proof !== 'string' ||
    !constantTimeEqual(body.proof, await relayProof(secret, connection, generation, challenge))
  ) {
    throw new EmailOperationError('deployed ingress proof did not match staged identity', 503);
  }
  return { generation, workerName: connection.ingress_worker_name, proved: true };
}
async function probeGatewayAcceptance(
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
  staged: boolean,
): Promise<Record<string, unknown>> {
  const secret = staged
    ? await readStagedConnectionSecret(env, connection)
    : await readConnectionSecret(env, connection);
  const payload = JSON.stringify({
    accountId: connection.account_id,
    zoneId: connection.zone_id,
    ingressName: connection.ingress_worker_name,
  });
  const response = await fetch(`${gatewayOrigin(env)}/email/probe`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(payload).byteLength),
    },
    body: payload,
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (response.status !== 204) {
    throw new EmailOperationError(
      `email gateway rejected ingress identity with HTTP ${response.status}`,
      503,
    );
  }
  return {
    accepted: true,
    generation: staged ? connection.staged_secret_generation : connection.active_secret_generation,
  };
}
function ingressName(installationId: string, zoneId: string): string {
  // Stable, bounded, and owned by an installation/zone rather than a project.
  const suffix = [installationId, zoneId]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(-48);
  return `void-email-${suffix}`;
}
function isCloudflareEmailRoutingMx(exchange: string): boolean {
  return /\.mx\.cloudflare\.net$/i.test(exchange);
}
function isSharedGatewayConnection(
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
): boolean {
  return (
    !!env.EMAIL_SHARED_ACCOUNT_ID &&
    !!env.EMAIL_SHARED_ZONE_ID &&
    !!env.EMAIL_SHARED_INGRESS_NAME &&
    connection.account_id === env.EMAIL_SHARED_ACCOUNT_ID &&
    connection.zone_id === env.EMAIL_SHARED_ZONE_ID &&
    connection.ingress_worker_name === env.EMAIL_SHARED_INGRESS_NAME
  );
}
function canManageConnection(
  actor: EmailActor,
  connection: typeof emailZoneConnections.$inferSelect,
): boolean {
  if (actor.kind === 'system') {
    return true;
  }
  return (
    connection.managed_by === actor.kind &&
    (actor.kind === 'admin' || connection.manager_user_id === actor.userId)
  );
}

async function requireProjectManagedEmailAccess(
  db: DbOrTx,
  projectId: string,
  actor: EmailActor,
): Promise<void> {
  if (actor.kind !== 'owner') {
    return;
  }
  try {
    const access = await requireProjectCapability(db, projectId, actor.userId, 'settings');
    if (access.project.status === 'deleting') {
      throw new EmailOperationError('email domain not available', 404);
    }
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
      throw new EmailOperationError(
        'forbidden',
        403,
        error instanceof ProjectAccessDeniedError
          ? error.userMessage
          : PROJECT_PERMISSION_MESSAGES.settings,
      );
    }
    throw error;
  }
}

async function lockProjectManagedEmailAccess(
  tx: Tx,
  projectId: string,
  actor: EmailActor,
): Promise<void> {
  if (actor.kind !== 'owner') {
    return;
  }
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update');
  await requireProjectManagedEmailAccess(tx, projectId, actor);
}

async function hasDelegatedConnectionAccess(
  db: DbOrTx,
  connectionId: string,
  actor: EmailActor,
  assignedProjectId?: string | null,
): Promise<boolean> {
  if (actor.kind !== 'owner') {
    return false;
  }
  const rows = await db
    .select({ projectId: emailDomainRoutes.project_id })
    .from(emailDomainRoutes)
    .where(
      and(
        eq(emailDomainRoutes.connection_id, connectionId),
        ne(emailDomainRoutes.desired_state, 'removed'),
        isNotNull(emailDomainRoutes.project_id),
      ),
    );
  const projectIds = new Set(rows.flatMap((row) => (row.projectId ? [row.projectId] : [])));
  if (assignedProjectId) {
    projectIds.add(assignedProjectId);
  }
  if (projectIds.size === 0) {
    return false;
  }
  for (const projectId of projectIds) {
    try {
      await requireProjectManagedEmailAccess(db, projectId, actor);
    } catch (error) {
      if (error instanceof EmailOperationError && (error.status === 403 || error.status === 404)) {
        return false;
      }
      throw error;
    }
  }
  return true;
}

function emailStepResourceIdentity(
  connection: typeof emailZoneConnections.$inferSelect,
  kind: StepKind,
  route?: EmailStepRoute | null,
  secretGeneration?: number,
): string {
  const base = `${connection.account_id}/${connection.zone_id}/${connection.ingress_worker_name}`;
  if (kind === 'routing_enable') {
    if (!route) {
      throw new EmailOperationError('email route identity is unavailable', 503);
    }
    return `${base}/routing/${route.domain}`;
  }
  if (kind === 'ingress_deploy') {
    return `${base}/relay/${RELAY_VERSION}`;
  }
  if (kind === 'probe_route_enable') {
    return `${base}/workers-dev/enabled`;
  }
  if (kind === 'secret_put') {
    if (secretGeneration === undefined) {
      throw new EmailOperationError('email secret generation is unavailable', 503);
    }
    return `${base}/secret/${secretGeneration}`;
  }
  if (kind === 'catchall_ensure' || kind === 'catchall_detach') {
    return `${base}/catch-all/${kind === 'catchall_ensure' ? 'ensure' : 'detach'}`;
  }
  if (kind === 'subaddressing_ensure') {
    return `${base}/settings/subaddressing`;
  }
  if (kind === 'ingress_delete') {
    return `${base}/relay/delete`;
  }
  if (kind === 'sending_onboard') {
    if (!route) {
      throw new EmailOperationError('email route identity is unavailable', 503);
    }
    return `${base}/sending/${route.domain}`;
  }
  return secretGeneration === undefined ? base : `${base}/secret/${secretGeneration}`;
}

async function emailStepRequestDigest(
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
  kind: StepKind,
  generation: number,
  route?: EmailStepRoute | null,
  secretGeneration?: number,
): Promise<string> {
  const intent = {
    kind,
    connectionId: connection.id,
    generation,
    accountId: connection.account_id,
    zoneId: connection.zone_id,
    ingressName: connection.ingress_worker_name,
    routeId: route?.id,
    routeDomain: route?.domain,
    routeGeneration: route?.desired_generation,
    secretGeneration,
  };
  if (kind === 'ingress_deploy') {
    return digest({
      ...intent,
      relayVersion: RELAY_VERSION,
      relaySourceDigest: await digest(RELAY_SOURCE),
      compatibilityDate: RELAY_COMPATIBILITY_DATE,
      gatewayOrigin: gatewayOrigin(env),
    });
  }
  return digest(intent);
}

function emailStepSecretGeneration(
  operationKind: typeof emailOperations.$inferSelect.kind,
  connection: typeof emailZoneConnections.$inferSelect,
  stepKind: StepKind,
): number | undefined {
  if (stepKind === 'secret_retire') {
    if (connection.staged_secret_generation === null) {
      throw new EmailOperationError('staged ingress generation unavailable', 503);
    }
    return connection.staged_secret_generation;
  }
  if (stepKind !== 'secret_put') {
    return undefined;
  }
  if (operationKind === 'rotate_secret') {
    if (connection.staged_secret_generation === null) {
      throw new EmailOperationError('staged ingress generation unavailable', 503);
    }
    return connection.staged_secret_generation;
  }
  return connection.active_secret_generation;
}

async function insertEmailOperationSteps(
  tx: Tx,
  env: Bindings,
  input: {
    operationId: string;
    connection: typeof emailZoneConnections.$inferSelect;
    steps: ReadonlyArray<StepKind>;
    generation: number;
    route: EmailStepRoute | null;
    secretGeneration: (step: StepKind) => number | undefined;
  },
): Promise<void> {
  const { operationId, connection, generation, route } = input;
  for (const [ordinal, kind] of input.steps.entries()) {
    const secretGeneration = input.secretGeneration(kind);
    await tx.insert(emailOperationSteps).values({
      id: generateId('estep'),
      operation_id: operationId,
      ordinal,
      kind,
      resource_identity: emailStepResourceIdentity(connection, kind, route, secretGeneration),
      request_digest: await emailStepRequestDigest(
        env,
        connection,
        kind,
        generation,
        route,
        secretGeneration,
      ),
    });
  }
}

async function resumeBlockedEmailOperationTx(
  tx: DbOrTx,
  env: Bindings,
  operationId: string,
  actor: EmailActor,
  expectedRouteId?: string,
  expectedProjectId?: string,
): Promise<boolean> {
  const snapshot = (
    await tx.select().from(emailOperations).where(eq(emailOperations.id, operationId)).limit(1)
  )[0];
  if (!snapshot || snapshot.status !== 'blocked') {
    return false;
  }
  if (
    snapshot.installation_id !== emailInstallationId(env) ||
    (expectedRouteId !== undefined && snapshot.route_id !== expectedRouteId)
  ) {
    throw new EmailOperationError('email operation is unavailable', 404);
  }
  const route = snapshot.route_id
    ? (
        await tx
          .select()
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.id, snapshot.route_id))
          .for('update')
          .limit(1)
      )[0]
    : null;
  if (snapshot.route_id && !route) {
    throw new EmailOperationError('email operation is unavailable', 404);
  }
  if (route && expectedProjectId !== undefined && route.project_id !== expectedProjectId) {
    throw new EmailOperationError('email operation is unavailable', 404);
  }
  if (route && actor.kind === 'owner') {
    if (!route.project_id || route.managed_by !== 'owner') {
      throw new EmailOperationError(
        'forbidden',
        403,
        'This email connection is managed by the platform. Contact a platform administrator to change it.',
      );
    }
    await requireProjectManagedEmailAccess(tx, route.project_id, actor);
  }
  const connection = (
    await tx
      .select()
      .from(emailZoneConnections)
      .where(eq(emailZoneConnections.id, snapshot.connection_id))
      .for('update')
      .limit(1)
  )[0];
  const operation = (
    await tx
      .select()
      .from(emailOperations)
      .where(eq(emailOperations.id, snapshot.id))
      .for('update')
      .limit(1)
  )[0];
  const canManage =
    !!connection &&
    (snapshot.kind === 'remove' ||
      canManageConnection(actor, connection) ||
      (await hasDelegatedConnectionAccess(tx, connection.id, actor)));
  if (
    !connection ||
    !operation ||
    operation.status !== 'blocked' ||
    operation.connection_id !== snapshot.connection_id ||
    operation.route_id !== snapshot.route_id ||
    operation.desired_generation !== snapshot.desired_generation ||
    !canManage
  ) {
    throw new EmailOperationError('blocked email operation cannot be resumed', 409);
  }
  if (connection.desired_generation !== operation.desired_generation) {
    return false;
  }
  const blocked = await tx
    .select()
    .from(emailOperationSteps)
    .where(
      and(
        eq(emailOperationSteps.operation_id, operation.id),
        eq(emailOperationSteps.status, 'blocked'),
      ),
    )
    .orderBy(emailOperationSteps.ordinal);
  if (blocked.length !== 1 || operation.current_step !== blocked[0]!.kind) {
    throw new EmailOperationError('blocked email operation step is unavailable', 409);
  }
  const step = blocked[0]!;
  const resumed = await tx
    .update(emailOperationSteps)
    .set({
      status: 'pending',
      outcome: null,
      failure_code: null,
      failure_detail: null,
      started_at: null,
      finished_at: null,
    })
    .where(
      and(
        eq(emailOperationSteps.id, step.id),
        eq(emailOperationSteps.status, 'blocked'),
        eq(emailOperationSteps.attempt, step.attempt),
      ),
    )
    .returning({ id: emailOperationSteps.id });
  if (!resumed.length) {
    return false;
  }
  await tx
    .update(emailOperations)
    .set({
      status: 'pending',
      current_step: null,
      failure_code: null,
      failure_detail: null,
      updated_at: sql`now()`,
    })
    .where(and(eq(emailOperations.id, operation.id), eq(emailOperations.status, 'blocked')));
  return true;
}

async function resumeBlockedEmailOperation(
  db: Db,
  env: Bindings,
  operationId: string,
  actor: EmailActor,
  expectedRouteId?: string,
  expectedProjectId?: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (expectedProjectId) {
      await lockProjectManagedEmailAccess(tx, expectedProjectId, actor);
    }
    return resumeBlockedEmailOperationTx(
      tx,
      env,
      operationId,
      actor,
      expectedRouteId,
      expectedProjectId,
    );
  });
}

export async function resolveEmailDomain(db: DbOrTx, rawDomain: string) {
  const domain = normalizeEmailDomain(rawDomain);
  const rows = await db
    .select({ route: emailDomainRoutes, connection: emailZoneConnections })
    .from(emailDomainRoutes)
    .innerJoin(emailZoneConnections, eq(emailDomainRoutes.connection_id, emailZoneConnections.id))
    .where(eq(emailDomainRoutes.domain, domain))
    .limit(1);
  return rows[0] ?? null;
}

type ResolvedEmailDomain = NonNullable<Awaited<ReturnType<typeof resolveEmailDomain>>>;

export async function resolveEmailDomains(
  db: DbOrTx,
  rawDomains: ReadonlyArray<string>,
): Promise<Map<string, ResolvedEmailDomain>> {
  const normalizedByInput = new Map(
    rawDomains.map((rawDomain) => [rawDomain, normalizeEmailDomain(rawDomain)]),
  );
  const domains = [...new Set(normalizedByInput.values())];
  if (domains.length === 0) {
    return new Map<string, ResolvedEmailDomain>();
  }
  const rows = await db
    .select({ route: emailDomainRoutes, connection: emailZoneConnections })
    .from(emailDomainRoutes)
    .innerJoin(emailZoneConnections, eq(emailDomainRoutes.connection_id, emailZoneConnections.id))
    .where(inArray(emailDomainRoutes.domain, domains));
  const byDomain = new Map(rows.map((row) => [row.route.domain, row]));
  return new Map(
    [...normalizedByInput].flatMap(([input, normalized]) => {
      const row = byDomain.get(normalized);
      return row ? [[input, row] as const] : [];
    }),
  );
}

export async function resolveEmailIngress(
  db: DbOrTx,
  input: {
    installationId: string;
    accountId: string;
    zoneId: string;
    ingressName: string;
    recipient: string;
  },
) {
  const at = input.recipient.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  const found = await resolveEmailDomain(db, input.recipient.slice(at + 1));
  if (
    !found ||
    found.route.desired_state !== 'active' ||
    found.route.inbound_status !== 'ready' ||
    found.connection.inbound_status !== 'ready'
  ) {
    return null;
  }
  if (
    found.connection.installation_id !== input.installationId ||
    found.connection.account_id !== input.accountId ||
    found.connection.zone_id !== input.zoneId ||
    found.connection.ingress_worker_name !== input.ingressName
  ) {
    return null;
  }
  if (found.route.addressing === 'custom' && !found.route.project_id) {
    return null;
  }
  return found;
}

export async function credentialFor(
  env: Bindings,
  db: DbOrTx,
  connection: typeof emailZoneConnections.$inferSelect,
): Promise<string> {
  if (!connection.credential_id) {
    throw new EmailOperationError('email connection has no credential', 503);
  }
  const row = (
    await db
      .select()
      .from(emailCredentials)
      .where(eq(emailCredentials.id, connection.credential_id))
      .limit(1)
  )[0];
  if (
    !row ||
    row.installation_id !== connection.installation_id ||
    row.account_id !== connection.account_id ||
    row.zone_id !== connection.zone_id
  ) {
    throw new EmailOperationError('email connection credential is unavailable', 503);
  }
  if (row.status === 'expired' || isEmailCredentialExpired(row.expires_on)) {
    throw new EmailCredentialExpiredError();
  }
  if (row.status !== 'healthy') {
    throw new EmailOperationError('email connection credential is unavailable', 503);
  }
  if (row.kind === 'platform') {
    if (connection.account_id !== env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
      throw new EmailOperationError('platform credential cannot manage this zone', 403);
    }
    return env.CF_API_TOKEN;
  }
  if (!row.ciphertext || !row.iv || !row.key_version) {
    throw new EmailOperationError('stored email credential is incomplete', 503);
  }
  return decryptPlatformCredential(env, row.installation_id, row.id, {
    ciphertext: row.ciphertext,
    iv: row.iv,
    keyVersion: row.key_version,
  });
}

export async function replaceBlockedSystemEmailCleanupCredential(
  db: Db,
  env: Bindings,
  routeId: string,
  token: string,
): Promise<string> {
  const route = (
    await db.select().from(emailDomainRoutes).where(eq(emailDomainRoutes.id, routeId)).limit(1)
  )[0];
  if (
    !route ||
    route.addressing !== 'custom' ||
    !route.project_id ||
    route.desired_state !== 'disabled'
  ) {
    throw new EmailOperationError(
      'replacement credential is available only for blocked project cleanup',
      409,
    );
  }
  const connection = (
    await db
      .select()
      .from(emailZoneConnections)
      .where(eq(emailZoneConnections.id, route.connection_id))
      .limit(1)
  )[0];
  if (
    !connection ||
    connection.installation_id !== emailInstallationId(env) ||
    !connection.credential_id
  ) {
    throw new EmailOperationError('email cleanup connection is unavailable', 409);
  }
  const project = (
    await db
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, route.project_id))
      .limit(1)
  )[0];
  if (project && project.status !== 'deleting') {
    throw new EmailOperationError('project cleanup is not in progress', 409);
  }
  const sibling = (
    await db
      .select({ id: emailDomainRoutes.id })
      .from(emailDomainRoutes)
      .where(
        and(
          eq(emailDomainRoutes.connection_id, connection.id),
          ne(emailDomainRoutes.id, route.id),
          ne(emailDomainRoutes.desired_state, 'removed'),
        ),
      )
      .limit(1)
  )[0];
  if (sibling) {
    throw new EmailOperationError('email connection still has another domain assignment', 409);
  }
  const unresolved = await findUnresolvedConnectionOperation(db, connection.id);
  if (unresolved) {
    throw new EmailOperationError(`connection operation ${unresolved.id} is unresolved`, 409);
  }
  const candidates = await db
    .select()
    .from(emailOperations)
    .where(
      and(
        eq(emailOperations.connection_id, connection.id),
        eq(emailOperations.route_id, route.id),
        eq(emailOperations.kind, 'remove'),
        eq(emailOperations.actor_kind, 'system'),
        eq(emailOperations.status, 'blocked'),
        eq(emailOperations.desired_generation, connection.desired_generation),
        eq(emailOperations.route_generation, route.desired_generation),
      ),
    )
    .orderBy(desc(emailOperations.created_at), desc(emailOperations.id))
    .limit(2);
  if (candidates.length !== 1) {
    throw new EmailOperationError('blocked system cleanup operation is unavailable', 409);
  }
  const operation = candidates[0]!;
  const client = createCfCustomerClient(token);
  let verifiedToken: { tokenId: string; expiresOn: string | null };
  try {
    const verification = await client.verifyToken(connection.account_id);
    if (verification.status !== 'active') {
      throw new EmailOperationError('Cloudflare API token is not active', 403);
    }
    verifiedToken = verifiedApiTokenMetadata(verification);
    const zone = await client.findZone(connection.zone_name);
    if (
      !zone ||
      zone.id !== connection.zone_id ||
      zone.account.id !== connection.account_id ||
      zone.name.toLowerCase() !== connection.zone_name.toLowerCase()
    ) {
      throw new EmailOperationError('Cloudflare API token cannot manage this email zone', 403);
    }
    await client.getRoutingSettings(connection.zone_id);
  } catch (error) {
    if (error instanceof EmailOperationError) {
      throw error;
    }
    if (error instanceof CloudflareApiError) {
      throw new EmailOperationError(error.message, error.status >= 500 ? 503 : error.status);
    }
    throw new EmailOperationError('Cloudflare API token could not be verified', 503);
  }
  const encrypted = await encryptPlatformCredential(
    env,
    connection.installation_id,
    connection.credential_id,
    token,
  );

  return db.transaction(async (tx) => {
    const currentRoute = (
      await tx
        .select()
        .from(emailDomainRoutes)
        .where(eq(emailDomainRoutes.id, route.id))
        .for('update')
        .limit(1)
    )[0];
    if (
      !currentRoute ||
      currentRoute.connection_id !== route.connection_id ||
      currentRoute.project_id !== route.project_id ||
      currentRoute.addressing !== 'custom' ||
      currentRoute.desired_state !== 'disabled' ||
      currentRoute.desired_generation !== route.desired_generation
    ) {
      throw new EmailOperationError('email cleanup changed while verifying the credential', 409);
    }
    const currentConnection = (
      await tx
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, connection.id))
        .for('update')
        .limit(1)
    )[0];
    if (
      !currentConnection ||
      currentConnection.installation_id !== connection.installation_id ||
      currentConnection.account_id !== connection.account_id ||
      currentConnection.zone_id !== connection.zone_id ||
      currentConnection.zone_name !== connection.zone_name ||
      currentConnection.credential_id !== connection.credential_id ||
      currentConnection.managed_by !== connection.managed_by ||
      currentConnection.manager_user_id !== connection.manager_user_id ||
      currentConnection.desired_generation !== connection.desired_generation
    ) {
      throw new EmailOperationError('email cleanup changed while verifying the credential', 409);
    }
    const currentProject = (
      await tx
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, currentRoute.project_id!))
        .limit(1)
    )[0];
    if (currentProject && currentProject.status !== 'deleting') {
      throw new EmailOperationError('project cleanup is not in progress', 409);
    }
    const currentSibling = (
      await tx
        .select({ id: emailDomainRoutes.id })
        .from(emailDomainRoutes)
        .where(
          and(
            eq(emailDomainRoutes.connection_id, currentConnection.id),
            ne(emailDomainRoutes.id, currentRoute.id),
            ne(emailDomainRoutes.desired_state, 'removed'),
          ),
        )
        .limit(1)
    )[0];
    if (currentSibling) {
      throw new EmailOperationError('email connection still has another domain assignment', 409);
    }
    const currentUnresolved = await findUnresolvedConnectionOperation(tx, currentConnection.id);
    if (currentUnresolved) {
      throw new EmailOperationError(
        `connection operation ${currentUnresolved.id} is unresolved`,
        409,
      );
    }
    const currentOperation = (
      await tx
        .select()
        .from(emailOperations)
        .where(eq(emailOperations.id, operation.id))
        .for('update')
        .limit(1)
    )[0];
    if (
      !currentOperation ||
      currentOperation.connection_id !== currentConnection.id ||
      currentOperation.route_id !== currentRoute.id ||
      currentOperation.kind !== 'remove' ||
      currentOperation.actor_kind !== 'system' ||
      currentOperation.status !== 'blocked' ||
      currentOperation.desired_generation !== currentConnection.desired_generation ||
      currentOperation.route_generation !== currentRoute.desired_generation
    ) {
      throw new EmailOperationError('blocked system cleanup operation is unavailable', 409);
    }
    const currentCredential = (
      await tx
        .select()
        .from(emailCredentials)
        .where(eq(emailCredentials.id, currentConnection.credential_id!))
        .for('update')
        .limit(1)
    )[0];
    if (
      !currentCredential ||
      currentCredential.installation_id !== currentConnection.installation_id ||
      currentCredential.account_id !== currentConnection.account_id ||
      currentCredential.zone_id !== currentConnection.zone_id ||
      currentCredential.managed_by !== currentConnection.managed_by ||
      currentCredential.manager_user_id !== currentConnection.manager_user_id
    ) {
      throw new EmailOperationError('email cleanup credential changed while it was verified', 409);
    }
    await tx
      .update(emailCredentials)
      .set({
        kind: 'api_token',
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        key_version: encrypted.keyVersion,
        token_id: verifiedToken.tokenId,
        expires_on: verifiedToken.expiresOn,
        status: 'healthy',
        generation: sql`${emailCredentials.generation} + 1`,
        updated_at: sql`now()`,
      })
      .where(eq(emailCredentials.id, currentCredential.id));
    await tx
      .update(emailZoneConnections)
      .set({
        management_status: 'healthy',
        management_reason: null,
        management_observed_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(emailZoneConnections.id, currentConnection.id));
    const resumed = await resumeBlockedEmailOperationTx(
      tx,
      env,
      currentOperation.id,
      { kind: 'system' },
      currentRoute.id,
      currentRoute.project_id!,
    );
    if (!resumed) {
      throw new EmailOperationError('blocked system cleanup operation could not be resumed', 409);
    }
    return currentOperation.id;
  });
}

async function forgetUnusedEmailCredential(
  tx: DbOrTx,
  connectionId: string,
  removingRouteId: string,
): Promise<void> {
  const connection = (
    await tx
      .select()
      .from(emailZoneConnections)
      .where(eq(emailZoneConnections.id, connectionId))
      .for('update')
      .limit(1)
  )[0];
  if (!connection?.credential_id) {
    return;
  }
  const sibling = (
    await tx
      .select({ id: emailDomainRoutes.id })
      .from(emailDomainRoutes)
      .where(
        and(
          eq(emailDomainRoutes.connection_id, connectionId),
          ne(emailDomainRoutes.id, removingRouteId),
          ne(emailDomainRoutes.desired_state, 'removed'),
        ),
      )
      .limit(1)
  )[0];
  if (sibling) {
    return;
  }
  await tx
    .update(emailZoneConnections)
    .set({
      credential_id: null,
      management_status: 'revoked',
      management_observed_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .where(eq(emailZoneConnections.id, connectionId));
  await tx.delete(emailCredentials).where(eq(emailCredentials.id, connection.credential_id));
}

export async function inspectEmailInboundRoute(
  client: ReturnType<typeof createCfCustomerClient>,
  connection: Pick<
    typeof emailZoneConnections.$inferSelect,
    'zone_id' | 'zone_name' | 'ingress_worker_name'
  >,
  domain: string,
  addressing: 'custom' | 'shared' = 'custom',
): Promise<string | null> {
  if (addressing === 'custom' && domain !== connection.zone_name) {
    return 'Cloudflare catch-all routing requires a zone apex; use the apex domain for custom inbound email';
  }
  if (addressing === 'shared') {
    const [settings, exchanges] = await Promise.all([
      client.getRoutingSettings(connection.zone_id),
      lookupMxOverDns(domain),
    ]);
    if (!exchanges.length || exchanges.some((exchange) => !isCloudflareEmailRoutingMx(exchange))) {
      return `MX records for ${domain} do not route mail to Cloudflare Email Routing`;
    }
    if (!supportsSubaddressing(settings) || (settings as { enabled?: unknown }).enabled !== true) {
      return 'Cloudflare Email Routing and subaddressing must be enabled for shared email';
    }
    // Domain readiness does not assert recipient coverage. Each project's
    // exact provider rule is verified by the shared-recipient service.
    return null;
  }
  const [catchall, rules, exchanges] = await Promise.all([
    client.getCatchAll(connection.zone_id),
    client.listRoutingRules(connection.zone_id),
    lookupMxOverDns(domain),
  ]);
  if (!exchanges.length || exchanges.some((exchange) => !isCloudflareEmailRoutingMx(exchange))) {
    return `MX records for ${domain} do not route mail to Cloudflare Email Routing`;
  }
  if (!catchall?.enabled || catchall.workerName !== connection.ingress_worker_name) {
    return 'zone catch-all does not point to this ingress';
  }
  return rules.some(
    (rule) => rule.enabled && rule.addresses.some((address) => address.endsWith(`@${domain}`)),
  )
    ? `enabled explicit Cloudflare email rules conflict with ${domain}`
    : null;
}

export async function readConnectionSecret(
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
): Promise<string> {
  return decryptPlatformCredential(
    env,
    connection.installation_id,
    `${connection.id}:secret:${connection.active_secret_generation}`,
    {
      ciphertext: connection.secret_ciphertext,
      iv: connection.secret_iv,
      keyVersion: connection.secret_key_version,
    },
  );
}
export async function readStagedConnectionSecret(
  env: Bindings,
  connection: typeof emailZoneConnections.$inferSelect,
): Promise<string> {
  if (
    connection.staged_secret_generation === null ||
    !connection.staged_secret_ciphertext ||
    !connection.staged_secret_iv ||
    !connection.staged_secret_key_version
  ) {
    throw new EmailOperationError('no staged ingress secret', 409);
  }
  return decryptPlatformCredential(
    env,
    connection.installation_id,
    `${connection.id}:secret:${connection.staged_secret_generation}`,
    {
      ciphertext: connection.staged_secret_ciphertext,
      iv: connection.staged_secret_iv,
      keyVersion: connection.staged_secret_key_version,
    },
  );
}

/** The inbound columns a route starts with, or returns to when it is reactivated. */
function outboundOnlyInbound(inboundMode: EmailInboundMode) {
  return {
    inbound_mode: inboundMode,
    inbound_status: inboundMode === 'none' ? ('disabled' as const) : ('pending' as const),
    inbound_reason: inboundMode === 'none' ? OUTBOUND_ONLY_INBOUND_REASON : null,
    inbound_observed_at: null,
  };
}

export async function requestEmailDomainAdd(
  db: Db,
  env: Bindings,
  input: {
    projectId: string;
    domain: string;
    actor: EmailActor;
    token?: string;
    attemptId?: string;
    inboundMode?: EmailInboundMode;
  },
): Promise<{ operationId: string; routeId: string }> {
  const domain = normalizeEmailDomain(input.domain);
  const inboundMode = input.inboundMode ?? 'managed';
  const outboundOnly = inboundMode === 'none';
  if (!isValidEmailDomain(domain)) {
    throw new EmailOperationError('invalid email domain', 400);
  }
  if (input.actor.kind === 'system') {
    throw new EmailOperationError('system cannot assign project email domains', 403);
  }
  const actor = input.actor as Exclude<EmailActor, { kind: 'system' }>;
  if (outboundOnly && actor.kind !== 'admin') {
    throw new EmailOperationError('outbound-only email domains are administrator-managed', 403);
  }
  const installationId = emailInstallationId(env);
  const key = input.attemptId ?? generateId('eadd');
  const actorScope = `${actor.kind}:${actor.userId}:${input.projectId}`;
  const requestDigest = await digest({
    projectId: input.projectId,
    domain,
    actor: input.actor.kind,
    tokenDigest: input.token ? await digest(input.token) : null,
    // Only outbound-only requests carry the mode, so earlier managed digests still match.
    ...(outboundOnly ? { inboundMode } : {}),
  });
  const previous = await findEmailOperationByKey(db, installationId, actorScope, key);
  if (previous) {
    if (previous.request_digest !== requestDigest || !previous.route_id) {
      throw new EmailOperationError('email operation key was reused with a different request');
    }
    await resumeBlockedEmailOperation(
      db,
      env,
      previous.id,
      actor,
      previous.route_id,
      input.projectId,
    );
    return { operationId: previous.id, routeId: previous.route_id };
  }
  if (!input.token && input.actor.kind === 'owner') {
    throw new EmailOperationError('a scoped Cloudflare API token is required', 400);
  }
  const token = input.token ?? env.CF_API_TOKEN;
  if (!token) {
    throw new EmailOperationError('platform Cloudflare credential is unavailable', 503);
  }
  const client = createCfCustomerClient(token);
  const zone = await findZoneForEmailDomain(client, domain);
  if (!zone) {
    throw new EmailOperationError(`no Cloudflare zone found for ${domain}`, 404);
  }
  if (domain !== zone.name) {
    throw new EmailOperationError(
      outboundOnly
        ? 'outbound-only email domains must be a zone apex'
        : 'Cloudflare catch-all routing requires a zone apex; use the apex domain for custom inbound email',
      400,
    );
  }
  if (zone.account.id === env.EMAIL_SHARED_ACCOUNT_ID && zone.id === env.EMAIL_SHARED_ZONE_ID) {
    if (outboundOnly) {
      throw new EmailOperationError(
        'the installation shared mail zone receives mail and cannot be outbound-only',
        409,
      );
    }
    if (actor.kind !== 'admin') {
      throw new EmailOperationError(
        'the installation shared mail zone is administrator-managed',
        403,
      );
    }
    const bootstrap = await ensureSharedEmailConnection(db, env);
    if (bootstrap) {
      await runEmailOperation(db, env, bootstrap);
    }
  }
  if (!input.token && zone.account.id !== env.CF_ACCOUNT_ID) {
    throw new EmailOperationError(
      'administrator must supply a token for this Cloudflare account',
      403,
    );
  }
  let verifiedToken: { tokenId: string; expiresOn: string | null } | null = null;
  if (input.token) {
    const verification = await client.verifyToken(zone.account.id);
    if (verification.status !== 'active') {
      throw new EmailOperationError('Cloudflare API token is not active', 403);
    }
    verifiedToken = verifiedApiTokenMetadata(verification);
    // The actual zone read above proves resource scope more reliably than a template URL.
    if (outboundOnly) {
      await client.listSendingSubdomains(zone.id);
    } else {
      await client.getRoutingSettings(zone.id);
    }
  }
  const existingConnection = (
    await db
      .select()
      .from(emailZoneConnections)
      .where(
        and(
          eq(emailZoneConnections.installation_id, installationId),
          eq(emailZoneConnections.account_id, zone.account.id),
          eq(emailZoneConnections.zone_id, zone.id),
        ),
      )
      .limit(1)
  )[0];
  const existingAssignment = await resolveEmailDomain(db, domain);
  // Outbound-only setup never takes the apex MX or catch-all, so their owners do not matter.
  const mxPreflight =
    !outboundOnly && (!existingAssignment || existingAssignment.route.desired_state !== 'active');
  if (mxPreflight) {
    const preflight = await Promise.all([
      lookupMxOverDns(domain),
      client.getCatchAll(zone.id),
      client.listRoutingRules(zone.id),
    ]);
    const mxConflict = existingAssignment
      ? preflight[0].some((exchange) => !isCloudflareEmailRoutingMx(exchange))
      : preflight[0].length > 0;
    if (mxConflict) {
      throw new EmailOperationError(
        `${domain} already has MX records; use an unused domain apex or a platform shared email address`,
        409,
      );
    }
    if (
      preflight[1]?.enabled &&
      preflight[1].workerName !==
        (existingConnection?.ingress_worker_name ?? ingressName(installationId, zone.id))
    ) {
      throw new EmailOperationError(
        'an unrelated catch-all already owns this Cloudflare zone',
        409,
      );
    }
    const conflicts = preflight[2].filter(
      (rule) => rule.enabled && rule.addresses.some((address) => address.endsWith(`@${domain}`)),
    );
    if (conflicts.length > 0) {
      throw new EmailOperationError(
        `enabled explicit Cloudflare email rules conflict with ${domain}`,
        409,
      );
    }
  }
  if (!outboundOnly) {
    gatewayOrigin(env);
  }
  const connectionId = generateId('econ');
  const routeId = generateId('eroute');
  const operationId = generateId('eop');
  const credentialId = generateId('ecred');
  const secret = randomSecret();
  const encryptedSecret = await encryptPlatformCredential(
    env,
    installationId,
    `${connectionId}:secret:1`,
    secret,
  );
  const encryptedToken = input.token
    ? await encryptPlatformCredential(env, installationId, credentialId, token)
    : null;
  try {
    return await db.transaction(async (tx) => {
      const insertCredential = () =>
        tx.insert(emailCredentials).values({
          id: credentialId,
          installation_id: installationId,
          managed_by: actor.kind,
          manager_user_id: actor.kind === 'owner' ? actor.userId : null,
          kind: input.token ? 'api_token' : 'platform',
          account_id: zone.account.id,
          zone_id: zone.id,
          ciphertext: encryptedToken?.ciphertext ?? null,
          iv: encryptedToken?.iv ?? null,
          key_version: encryptedToken?.keyVersion ?? null,
          token_id: verifiedToken?.tokenId ?? null,
          expires_on: verifiedToken?.expiresOn ?? null,
        });
      const project = (
        await tx
          .select()
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .for('update')
          .limit(1)
      )[0];
      if (!project || project.status === 'deleting') {
        throw new EmailOperationError('project not available', 409);
      }
      await requireProjectManagedEmailAccess(tx, input.projectId, actor);
      await lockEmailZoneConnectionIdentity(tx, installationId, zone.account.id, zone.id);
      const existingRoute = (
        await tx
          .select()
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.domain, domain))
          .for('update')
          .limit(1)
      )[0];
      const transfer = !!existingRoute && existingRoute.project_id !== input.projectId;
      if (transfer) {
        if (existingRoute.desired_state !== 'removed' || existingRoute.addressing !== 'custom') {
          throw new EmailOperationError('email domain is assigned to another project', 409);
        }
        const lastRemoval = (
          await tx
            .select({ status: emailOperations.status })
            .from(emailOperations)
            .where(
              and(
                eq(emailOperations.route_id, existingRoute.id),
                eq(emailOperations.kind, 'remove'),
              ),
            )
            .orderBy(desc(emailOperations.created_at), desc(emailOperations.id))
            .limit(1)
        )[0];
        if (lastRemoval?.status !== 'completed') {
          throw new EmailOperationError('previous email domain cleanup is unresolved', 409);
        }
        const [unresolved] = await tx
          .select({ n: count() })
          .from(emailUnresolvedAttempts)
          .where(
            and(
              eq(emailUnresolvedAttempts.project_id, existingRoute.project_id!),
              eq(emailUnresolvedAttempts.sender_domain, domain),
            ),
          );
        if ((unresolved?.n ?? 0) > 0) {
          throw new EmailOperationError('previous email domain sends are unresolved', 409);
        }
      }
      let connection = (
        await tx
          .select()
          .from(emailZoneConnections)
          .where(
            and(
              eq(emailZoneConnections.installation_id, installationId),
              eq(emailZoneConnections.account_id, zone.account.id),
              eq(emailZoneConnections.zone_id, zone.id),
            ),
          )
          .for('update')
          .limit(1)
      )[0];
      const created = !connection;
      const canManageExistingConnection =
        !connection ||
        canManageConnection(actor, connection) ||
        (await hasDelegatedConnectionAccess(tx, connection.id, actor, existingRoute?.project_id));
      if (!canManageExistingConnection) {
        throw new EmailOperationError('zone connection requires its manager approval', 403);
      }
      if (existingRoute && existingRoute.connection_id !== connection?.id) {
        throw new EmailOperationError('email domain belongs to a different Cloudflare zone', 409);
      }
      if (connection) {
        const unresolved = await findUnresolvedConnectionOperation(tx, connection.id);
        if (unresolved) {
          throw new EmailOperationError(`connection operation ${unresolved.id} is unresolved`);
        }
      }
      if (existingRoute) {
        if (
          !connection ||
          !canManageExistingConnection ||
          existingRoute.managed_by !== actor.kind
        ) {
          throw new EmailOperationError(
            'email domain credential may be replaced only by its connection manager',
            403,
          );
        }
        // The MX preflight was skipped for an active route. If it was removed meanwhile,
        // reactivating it here could take over mail that another provider now receives.
        if (!outboundOnly && !mxPreflight && existingRoute.desired_state !== 'active') {
          throw new EmailOperationError('email domain changed during the request; retry', 409);
        }
        if (
          existingRoute.desired_state === 'active' &&
          existingRoute.inbound_mode !== inboundMode
        ) {
          throw new EmailOperationError(
            existingRoute.inbound_mode === 'none'
              ? 'email domain is set up as outbound-only; remove it before adding it with inbound mail'
              : 'email domain receives mail through Void; remove it before adding it as outbound-only',
            409,
          );
        }
        const blockedAssignment = (
          await tx
            .select({ id: emailOperations.id })
            .from(emailOperations)
            .where(
              and(
                eq(emailOperations.connection_id, connection.id),
                eq(emailOperations.route_id, existingRoute.id),
                eq(emailOperations.route_generation, existingRoute.desired_generation),
                eq(emailOperations.actor_kind, actor.kind),
                ...(actor.kind === 'owner'
                  ? [eq(emailOperations.actor_user_id, actor.userId)]
                  : []),
                inArray(emailOperations.kind, ['setup', 'sync']),
                eq(emailOperations.status, 'blocked'),
                eq(emailOperations.desired_generation, connection.desired_generation),
              ),
            )
            .orderBy(desc(emailOperations.created_at), desc(emailOperations.id))
            .limit(1)
        )[0];
        if (connection.credential_id) {
          const replacement = input.token
            ? await encryptPlatformCredential(
                env,
                installationId,
                connection.credential_id,
                input.token,
              )
            : null;
          await tx
            .update(emailCredentials)
            .set({
              kind: input.token ? 'api_token' : 'platform',
              ciphertext: replacement?.ciphertext ?? null,
              iv: replacement?.iv ?? null,
              key_version: replacement?.keyVersion ?? null,
              token_id: verifiedToken?.tokenId ?? null,
              expires_on: verifiedToken?.expiresOn ?? null,
              status: 'healthy',
              generation: sql`${emailCredentials.generation} + 1`,
              updated_at: sql`now()`,
            })
            .where(eq(emailCredentials.id, connection.credential_id));
        } else {
          await insertCredential();
          await tx
            .update(emailZoneConnections)
            .set({ credential_id: credentialId })
            .where(eq(emailZoneConnections.id, connection.id));
        }
        const generation = connection.desired_generation + 1;
        const routeGeneration =
          existingRoute.desired_generation + (existingRoute.desired_state !== 'active' ? 1 : 0);
        await tx
          .update(emailZoneConnections)
          .set({
            desired_generation: generation,
            management_status: 'healthy',
            management_reason: null,
            management_observed_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .where(eq(emailZoneConnections.id, connection.id));
        const reactivating = existingRoute.desired_state !== 'active';
        await tx
          .update(emailDomainRoutes)
          .set({
            desired_state: 'active',
            ...(reactivating
              ? {
                  desired_generation: sql`${emailDomainRoutes.desired_generation} + 1`,
                  ...outboundOnlyInbound(inboundMode),
                  outbound_status: 'pending' as const,
                  outbound_reason: null,
                  outbound_observed_at: null,
                }
              : {}),
            ...(transfer
              ? {
                  project_id: input.projectId,
                  assigned_by_user_id: actor.userId,
                  created_at: sql`now()`,
                }
              : {}),
            updated_at: sql`now()`,
          })
          .where(eq(emailDomainRoutes.id, existingRoute.id));
        await tx.insert(emailOperations).values({
          id: operationId,
          installation_id: installationId,
          connection_id: connection.id,
          route_id: existingRoute.id,
          route_generation: routeGeneration,
          actor_kind: actor.kind,
          actor_user_id: actor.userId,
          actor_scope: actorScope,
          kind: 'sync',
          idempotency_key: key,
          request_digest: requestDigest,
          desired_generation: generation,
        });
        const steps = outboundOnly
          ? OUTBOUND_ONLY_STEPS
          : isSharedGatewayConnection(env, connection)
            ? NATIVE_CUSTOM_SYNC_STEPS
            : connection.staged_secret_generation !== null
              ? STAGED_SECRET_REPAIR_STEPS
              : connection.inbound_status !== 'ready' ||
                  existingRoute.inbound_status !== 'ready' ||
                  reactivating ||
                  blockedAssignment
                ? SETUP_STEPS
                : SYNC_STEPS;
        const stepRoute: EmailStepRoute = {
          id: existingRoute.id,
          domain,
          desired_generation: routeGeneration,
        };
        await insertEmailOperationSteps(tx, env, {
          operationId,
          connection,
          steps,
          generation,
          route: stepRoute,
          secretGeneration: (step) => emailStepSecretGeneration('sync', connection, step),
        });
        return { operationId, routeId: existingRoute.id };
      }
      if (!connection) {
        await insertCredential();
        await tx.insert(emailZoneConnections).values({
          id: connectionId,
          installation_id: installationId,
          account_id: zone.account.id,
          zone_id: zone.id,
          zone_name: zone.name,
          managed_by: actor.kind,
          manager_user_id: actor.kind === 'owner' ? actor.userId : null,
          credential_id: credentialId,
          ingress_worker_name: ingressName(installationId, zone.id),
          secret_ciphertext: encryptedSecret.ciphertext,
          secret_iv: encryptedSecret.iv,
          secret_key_version: encryptedSecret.keyVersion,
          active_secret_generation: 1,
          management_status: 'healthy',
          management_observed_at: sql`now()`,
        });
        connection = (
          await tx
            .select()
            .from(emailZoneConnections)
            .where(eq(emailZoneConnections.id, connectionId))
            .limit(1)
        )[0]!;
      } else if (!connection.credential_id) {
        await insertCredential();
        await tx
          .update(emailZoneConnections)
          .set({
            credential_id: credentialId,
            management_status: 'healthy',
            management_reason: null,
            management_observed_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .where(eq(emailZoneConnections.id, connection.id));
      } else if (input.token) {
        // A sibling assignment supplies the manager's current zone token.
        // The connection, rather than either project, owns its ciphertext.
        const replacement = await encryptPlatformCredential(
          env,
          installationId,
          connection.credential_id,
          input.token,
        );
        await tx
          .update(emailCredentials)
          .set({
            kind: 'api_token',
            ciphertext: replacement.ciphertext,
            iv: replacement.iv,
            key_version: replacement.keyVersion,
            token_id: verifiedToken!.tokenId,
            expires_on: verifiedToken!.expiresOn,
            status: 'healthy',
            generation: sql`${emailCredentials.generation} + 1`,
            updated_at: sql`now()`,
          })
          .where(eq(emailCredentials.id, connection.credential_id));
        await tx
          .update(emailZoneConnections)
          .set({
            management_status: 'healthy',
            management_reason: null,
            management_observed_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .where(eq(emailZoneConnections.id, connection.id));
      }
      const repairStaged = connection.staged_secret_generation !== null;
      if (!created) {
        connection = (
          await tx
            .update(emailZoneConnections)
            .set({
              desired_generation: sql`${emailZoneConnections.desired_generation} + 1`,
              updated_at: sql`now()`,
            })
            .where(eq(emailZoneConnections.id, connection.id))
            .returning()
        )[0]!;
      }
      await tx.insert(emailDomainRoutes).values({
        id: routeId,
        domain,
        connection_id: connection.id,
        project_id: input.projectId,
        addressing: 'custom',
        managed_by: actor.kind,
        assigned_by_user_id: actor.userId,
        ...outboundOnlyInbound(inboundMode),
      });
      await tx.insert(emailOperations).values({
        id: operationId,
        installation_id: installationId,
        connection_id: connection.id,
        route_id: routeId,
        route_generation: 1,
        actor_kind: actor.kind,
        actor_user_id: actor.userId,
        actor_scope: actorScope,
        kind: 'setup',
        idempotency_key: key,
        request_digest: requestDigest,
        desired_generation: connection.desired_generation,
      });
      const steps = outboundOnly
        ? OUTBOUND_ONLY_STEPS
        : isSharedGatewayConnection(env, connection)
          ? NATIVE_CUSTOM_SYNC_STEPS
          : repairStaged
            ? STAGED_SECRET_REPAIR_STEPS
            : created || connection.inbound_status !== 'ready'
              ? SETUP_STEPS
              : SIBLING_STEPS;
      const stepRoute: EmailStepRoute = { id: routeId, domain, desired_generation: 1 };
      await insertEmailOperationSteps(tx, env, {
        operationId,
        connection,
        steps,
        generation: connection.desired_generation,
        route: stepRoute,
        secretGeneration: (step) => emailStepSecretGeneration('setup', connection, step),
      });
      return { operationId, routeId };
    });
  } catch (error) {
    // A concurrent insert may have committed the same caller attempt while this
    // transaction waited on uniqueness. Fetch it, but never infer success from a domain row.
    const winner = await findEmailOperationByKey(db, installationId, actorScope, key);
    if (winner && winner.request_digest === requestDigest && winner.route_id) {
      return { operationId: winner.id, routeId: winner.route_id };
    }
    throw error;
  }
}

/** Reserve the installation's shared sender as an exact route on its zone.
 * This uses the same durable step runner as project assignments. It is safe to
 * call from scheduled reconciliation: the stable key returns the same operation. */
export async function ensureSharedEmailConnection(db: Db, env: Bindings): Promise<string | null> {
  const configured = env.EMAIL_SENDER_DOMAIN;
  if (!configured) {
    return null;
  }
  if (!env.EMAIL_SHARED_ACCOUNT_ID || !env.EMAIL_SHARED_ZONE_ID || !env.EMAIL_SHARED_INGRESS_NAME) {
    throw new EmailOperationError('shared email ingress identity is not configured', 503);
  }
  const domain = normalizeEmailDomain(configured);
  if (!isValidEmailDomain(domain)) {
    throw new EmailOperationError('EMAIL_SENDER_DOMAIN is invalid', 503);
  }
  gatewayOrigin(env);
  const installationId = emailInstallationId(env);
  const key = `shared:${domain}:literal-v1`;
  const previous = await findEmailOperationByKey(db, installationId, 'system:shared', key);
  if (previous) {
    await resumeBlockedEmailOperation(db, env, previous.id, { kind: 'system' }, previous.route_id!);
    return previous.id;
  }
  const client = createCfCustomerClient(env.CF_API_TOKEN);
  const zone = await findZoneForEmailDomain(client, domain);
  if (
    !zone ||
    zone.account.id !== env.CF_ACCOUNT_ID ||
    zone.account.id !== env.EMAIL_SHARED_ACCOUNT_ID ||
    zone.id !== env.EMAIL_SHARED_ZONE_ID
  ) {
    throw new EmailOperationError(
      'shared sender zone does not match the configured gateway identity',
      503,
    );
  }
  const worker = env.EMAIL_SHARED_INGRESS_NAME;
  let routeId = generateId('eroute');
  const connectionId = generateId('econ'),
    credentialId = generateId('ecred'),
    operationId = generateId('eop');
  const secret = await encryptPlatformCredential(
    env,
    installationId,
    `${connectionId}:secret:1`,
    randomSecret(),
  );
  return db.transaction(async (tx) => {
    await lockEmailZoneConnectionIdentity(tx, installationId, zone.account.id, zone.id);
    const existingRoute = (
      await tx.select().from(emailDomainRoutes).where(eq(emailDomainRoutes.domain, domain)).limit(1)
    )[0];
    if (existingRoute) {
      if (existingRoute.addressing !== 'shared') {
        throw new EmailOperationError('shared sender domain is assigned to a project');
      }
      const latest = (
        await tx
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.route_id, existingRoute.id))
          .orderBy(sql`${emailOperations.created_at} DESC`)
          .limit(1)
      )[0];
      if (latest && !['completed', 'cancelled'].includes(latest.status)) {
        await resumeBlockedEmailOperationTx(
          tx,
          env,
          latest.id,
          { kind: 'system' },
          existingRoute.id,
        );
        return latest.id;
      }
      if (existingRoute.desired_state !== 'active') {
        throw new EmailOperationError('shared email domain is disabled');
      }
      routeId = existingRoute.id;
    }
    let connection = (
      await tx
        .select()
        .from(emailZoneConnections)
        .where(
          and(
            eq(emailZoneConnections.installation_id, installationId),
            eq(emailZoneConnections.account_id, zone.account.id),
            eq(emailZoneConnections.zone_id, zone.id),
          ),
        )
        .for('update')
        .limit(1)
    )[0];
    if (connection && connection.managed_by !== 'admin') {
      throw new EmailOperationError('shared sender zone connection must be administrator-managed');
    }
    if (connection && connection.ingress_worker_name !== worker) {
      throw new EmailOperationError(
        'shared sender zone is already connected to a different ingress worker',
      );
    }
    if (!connection) {
      await tx.insert(emailCredentials).values({
        id: credentialId,
        installation_id: installationId,
        managed_by: 'admin',
        kind: 'platform',
        account_id: zone.account.id,
        zone_id: zone.id,
      });
      await tx.insert(emailZoneConnections).values({
        id: connectionId,
        installation_id: installationId,
        account_id: zone.account.id,
        zone_id: zone.id,
        zone_name: zone.name,
        managed_by: 'admin',
        credential_id: credentialId,
        ingress_worker_name: worker,
        secret_ciphertext: secret.ciphertext,
        secret_iv: secret.iv,
        secret_key_version: secret.keyVersion,
        active_secret_generation: 1,
        management_status: 'healthy',
        management_observed_at: sql`now()`,
      });
      connection = (
        await tx
          .select()
          .from(emailZoneConnections)
          .where(eq(emailZoneConnections.id, connectionId))
          .limit(1)
      )[0]!;
    }
    if (existingRoute) {
      // A completed legacy catch-all observation says nothing about shared
      // subdomain recipients or plus addressing. Re-probe before readiness.
      await tx
        .update(emailZoneConnections)
        .set({
          inbound_status: 'pending',
          inbound_reason: null,
          inbound_observed_at: null,
          updated_at: sql`now()`,
        })
        .where(eq(emailZoneConnections.id, connection.id));
    }
    const [route] = existingRoute
      ? await tx
          .update(emailDomainRoutes)
          .set({
            inbound_status: 'pending',
            inbound_reason: null,
            desired_generation: sql`${emailDomainRoutes.desired_generation} + 1`,
            updated_at: sql`now()`,
          })
          .where(eq(emailDomainRoutes.id, routeId))
          .returning()
      : await tx
          .insert(emailDomainRoutes)
          .values({
            id: routeId,
            domain,
            connection_id: connection.id,
            project_id: null,
            addressing: 'shared',
            managed_by: 'admin',
            desired_state: 'active',
          })
          .returning();
    const requestDigest = await digest({ shared: domain, connectionId: connection.id });
    await tx.insert(emailOperations).values({
      id: operationId,
      installation_id: installationId,
      connection_id: connection.id,
      route_id: routeId,
      route_generation: route!.desired_generation,
      actor_kind: 'system',
      actor_scope: 'system:shared',
      kind: 'setup',
      idempotency_key: key,
      request_digest: requestDigest,
      desired_generation: connection.desired_generation,
    });
    // Native gateway is deployed with the platform. Uploading the customer
    // relay source here would replace it and sever shared mail delivery.
    const steps = ['routing_enable', 'subaddressing_ensure', 'inbound_probe', 'publish'] as const;
    const stepRoute: EmailStepRoute = {
      id: routeId,
      domain,
      desired_generation: route!.desired_generation,
    };
    await insertEmailOperationSteps(tx, env, {
      operationId,
      connection,
      steps,
      generation: connection.desired_generation,
      route: stepRoute,
      secretGeneration: () => undefined,
    });
    return operationId;
  });
}

export async function getEmailOperation(db: DbOrTx, projectId: string, key: string) {
  const rows = await db
    .select({ operation: emailOperations, route: emailDomainRoutes })
    .from(emailOperations)
    .innerJoin(
      emailDomainRoutes,
      sql`(
      ${emailOperations.route_id} = ${emailDomainRoutes.id}
      OR (${emailOperations.kind} = 'rotate_secret'
        AND ${emailOperations.connection_id} = ${emailDomainRoutes.connection_id})
    )`,
    )
    .where(
      and(
        eq(emailDomainRoutes.project_id, projectId),
        sql`(${emailOperations.kind} = 'rotate_secret' OR ${emailOperations.created_at} >= ${emailDomainRoutes.created_at})`,
        sql`(${emailOperations.id} = ${key} OR ${emailOperations.idempotency_key} = ${key})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function requestEmailDomainSync(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  key = generateId('esync'),
  expectedProjectId?: string,
): Promise<string> {
  const operationId = await (expectedProjectId === undefined
    ? requestExistingOperation(db, env, routeId, actor, 'sync', key)
    : requestExistingOperation(db, env, routeId, actor, 'sync', key, expectedProjectId));
  if (!operationId) {
    throw new EmailOperationError('email domain not available', 404);
  }
  return operationId;
}
export function requestEmailDomainRemove(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  key?: string,
): Promise<string>;
export function requestEmailDomainRemove(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  key: string | undefined,
  expectedProjectId: string,
): Promise<string | null>;
export async function requestEmailDomainRemove(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  key = generateId('erem'),
  expectedProjectId?: string,
): Promise<string | null> {
  return expectedProjectId === undefined
    ? requestExistingOperation(db, env, routeId, actor, 'remove', key)
    : requestExistingOperation(db, env, routeId, actor, 'remove', key, expectedProjectId);
}
/** Stage a new zone secret. The old generation stays active until a signed
 * challenge proves the deployed Worker actually received the new value. */
export async function requestEmailSecretRotation(
  db: Db,
  env: Bindings,
  connectionId: string,
  actor: EmailActor,
  key = generateId('erot'),
  expectedProjectId?: string,
): Promise<string> {
  const installationId = emailInstallationId(env);
  const actorScope =
    actor.kind === 'system' ? 'system:rotation' : `${actor.kind}:${actor.userId}:${connectionId}`;
  const requestDigest = await digest({ connectionId, kind: 'rotate_secret', actor: actor.kind });
  const prior = await findEmailOperationByKey(db, installationId, actorScope, key);
  if (prior && expectedProjectId === undefined) {
    if (prior.request_digest !== requestDigest) {
      throw new EmailOperationError('email operation key conflict');
    }
    if (prior.status !== 'blocked') {
      return prior.id;
    }
  }
  const secret = randomSecret();
  return db.transaction(async (tx) => {
    if (expectedProjectId) {
      await lockProjectManagedEmailAccess(tx, expectedProjectId, actor);
    }
    const connection = (
      await tx
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, connectionId))
        .for('update')
        .limit(1)
    )[0];
    if (!connection || connection.installation_id !== installationId) {
      throw new EmailOperationError('connection not found', 404);
    }
    if (actor.kind === 'owner' && expectedProjectId) {
      const assignedRoute = (
        await tx
          .select({ id: emailDomainRoutes.id })
          .from(emailDomainRoutes)
          .where(
            and(
              eq(emailDomainRoutes.connection_id, connectionId),
              eq(emailDomainRoutes.project_id, expectedProjectId),
              eq(emailDomainRoutes.desired_state, 'active'),
            ),
          )
          .limit(1)
      )[0];
      if (!assignedRoute) {
        throw new EmailOperationError('connection not found', 404);
      }
    }
    if (
      !canManageConnection(actor, connection) &&
      !(await hasDelegatedConnectionAccess(tx, connection.id, actor))
    ) {
      throw new EmailOperationError('only the connection manager can rotate ingress', 403);
    }
    const replay = await findEmailOperationByKey(tx, installationId, actorScope, key);
    if (replay) {
      if (replay.request_digest !== requestDigest) {
        throw new EmailOperationError('email operation key conflict');
      }
      if (replay.status === 'blocked') {
        await resumeBlockedEmailOperationTx(tx, env, replay.id, actor);
      }
      return replay.id;
    }
    if (isSharedGatewayConnection(env, connection)) {
      throw new EmailOperationError(
        'the installation gateway secret is managed by platform deployment, not zone rotation',
        409,
      );
    }
    const unresolved = await findUnresolvedConnectionOperation(tx, connectionId);
    if (unresolved) {
      throw new EmailOperationError(`connection operation ${unresolved.id} is unresolved`);
    }
    const blockedRotation = (
      await tx
        .select({ id: emailOperations.id })
        .from(emailOperations)
        .where(
          and(
            eq(emailOperations.connection_id, connectionId),
            eq(emailOperations.kind, 'rotate_secret'),
            eq(emailOperations.status, 'blocked'),
            eq(emailOperations.desired_generation, connection.desired_generation),
          ),
        )
        .orderBy(desc(emailOperations.created_at), desc(emailOperations.id))
        .limit(1)
    )[0];
    if (blockedRotation) {
      await resumeBlockedEmailOperationTx(tx, env, blockedRotation.id, actor);
      return blockedRotation.id;
    }
    if (connection.inbound_status !== 'ready') {
      throw new EmailOperationError('email ingress must be ready before rotating its secret', 409);
    }
    if (connection.staged_secret_generation !== null) {
      throw new EmailOperationError('ingress rotation already staged');
    }
    const generation = connection.desired_generation + 1,
      secretGeneration = connection.active_secret_generation + 1;
    const encrypted = await encryptPlatformCredential(
      env,
      installationId,
      `${connection.id}:secret:${secretGeneration}`,
      secret,
    );
    await tx
      .update(emailZoneConnections)
      .set({
        desired_generation: generation,
        staged_secret_generation: secretGeneration,
        staged_secret_ciphertext: encrypted.ciphertext,
        staged_secret_iv: encrypted.iv,
        staged_secret_key_version: encrypted.keyVersion,
        updated_at: sql`now()`,
      })
      .where(eq(emailZoneConnections.id, connectionId));
    const operationId = generateId('eop');
    await tx.insert(emailOperations).values({
      id: operationId,
      installation_id: installationId,
      connection_id: connectionId,
      actor_kind: actor.kind,
      actor_user_id: actor.kind === 'system' ? null : actor.userId,
      actor_scope: actorScope,
      kind: 'rotate_secret',
      idempotency_key: key,
      request_digest: requestDigest,
      desired_generation: generation,
    });
    await insertEmailOperationSteps(tx, env, {
      operationId,
      connection,
      steps: ROTATE_STEPS,
      generation,
      route: null,
      secretGeneration: () => secretGeneration,
    });
    return operationId;
  });
}
function requestExistingOperation(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  kind: 'sync' | 'remove',
  key: string,
): Promise<string>;
function requestExistingOperation(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  kind: 'sync' | 'remove',
  key: string,
  expectedProjectId: string,
): Promise<string | null>;
async function requestExistingOperation(
  db: Db,
  env: Bindings,
  routeId: string,
  actor: EmailActor,
  kind: 'sync' | 'remove',
  key: string,
  expectedProjectId?: string,
): Promise<string | null> {
  const installationId = emailInstallationId(env);
  const actorScope =
    actor.kind === 'system' ? 'system' : `${actor.kind}:${actor.userId}:${routeId}`;
  const requestDigest = await digest({
    routeId,
    kind,
    actor: actor.kind,
    ...(actor.kind === 'owner' || expectedProjectId === undefined ? {} : { expectedProjectId }),
  });
  const existing = await findEmailOperationByKey(db, installationId, actorScope, key);
  if (existing && expectedProjectId === undefined) {
    if (existing.request_digest !== requestDigest) {
      throw new EmailOperationError('email operation key conflict');
    }
    if (existing.status !== 'blocked') {
      return existing.id;
    }
  }
  const authorizationProjectId =
    actor.kind === 'owner'
      ? (expectedProjectId ??
        (
          await db
            .select({ projectId: emailDomainRoutes.project_id })
            .from(emailDomainRoutes)
            .where(eq(emailDomainRoutes.id, routeId))
            .limit(1)
        )[0]?.projectId ??
        null)
      : null;
  if (actor.kind === 'owner' && !authorizationProjectId) {
    throw new EmailOperationError('email domain not available', 404);
  }
  const expectedRouteProjectId = authorizationProjectId ?? expectedProjectId ?? null;
  return db.transaction(async (tx) => {
    if (kind === 'remove') {
      await lockEmailPolicy(tx);
    }
    if (authorizationProjectId) {
      await lockProjectManagedEmailAccess(tx, authorizationProjectId, actor);
    }
    let route = (
      await tx
        .select()
        .from(emailDomainRoutes)
        .where(eq(emailDomainRoutes.id, routeId))
        .for('update')
        .limit(1)
    )[0];
    if (!route) {
      throw new EmailOperationError('email domain not available', 404);
    }
    if (expectedRouteProjectId && route.project_id !== expectedRouteProjectId) {
      if (expectedProjectId === undefined) {
        throw new EmailOperationError('email domain not available', 404);
      }
      return null;
    }
    if (kind === 'remove') {
      await disableEmailDomainRouteAndDrainTx(tx, routeId);
      route = (
        await tx
          .select()
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.id, routeId))
          .for('update')
          .limit(1)
      )[0]!;
    }
    if (kind === 'sync' && route.desired_state !== 'active') {
      throw new EmailOperationError('email domain must be active before reconciliation', 409);
    }
    const connection = (
      await tx
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, route.connection_id))
        .for('update')
        .limit(1)
    )[0];
    const project = route.project_id
      ? (await tx.select().from(projects).where(eq(projects.id, route.project_id)).limit(1))[0]
      : null;
    const adminRemoval =
      actor.kind === 'admin' &&
      kind === 'remove' &&
      route.addressing === 'custom' &&
      route.project_id !== null;
    if (
      !connection ||
      (actor.kind !== 'system' && !adminRemoval && (!project || project.status === 'deleting'))
    ) {
      throw new EmailOperationError('email domain not available', 404);
    }
    if (actor.kind === 'owner') {
      if (!project || route.managed_by !== 'owner') {
        throw new EmailOperationError(
          'forbidden',
          403,
          'This email connection is managed by the platform. Contact a platform administrator to change it.',
        );
      }
    }
    if (
      kind === 'sync' &&
      !canManageConnection(actor, connection) &&
      !(await hasDelegatedConnectionAccess(tx, connection.id, actor))
    ) {
      throw new EmailOperationError(
        'only the connection manager can reconcile shared ingress',
        403,
      );
    }
    const replay = await findEmailOperationByKey(tx, installationId, actorScope, key);
    if (replay) {
      if (replay.request_digest !== requestDigest) {
        throw new EmailOperationError('email operation key conflict');
      }
      if (replay.status === 'blocked') {
        await resumeBlockedEmailOperationTx(tx, env, replay.id, actor, routeId);
      }
      return replay.id;
    }
    const existingRemoval =
      kind === 'remove'
        ? (
            await tx
              .select()
              .from(emailOperations)
              .where(
                and(
                  eq(emailOperations.route_id, routeId),
                  eq(emailOperations.kind, 'remove'),
                  or(
                    inArray(emailOperations.status, ['pending', 'running', 'unknown']),
                    and(
                      eq(emailOperations.status, 'blocked'),
                      eq(emailOperations.desired_generation, connection.desired_generation),
                      eq(emailOperations.route_generation, route.desired_generation),
                    ),
                  ),
                ),
              )
              .orderBy(emailOperations.created_at, emailOperations.id)
              .limit(1)
          )[0]
        : null;
    if (existingRemoval) {
      if (existingRemoval.status === 'blocked') {
        const recoveringOrphanedSystemCleanup =
          actor.kind === 'admin' &&
          existingRemoval.actor_kind === 'system' &&
          (!project || project.status === 'deleting');
        await resumeBlockedEmailOperationTx(
          tx,
          env,
          existingRemoval.id,
          recoveringOrphanedSystemCleanup ? { kind: 'system' } : actor,
          routeId,
        );
      }
      return existingRemoval.id;
    }
    const unresolved = (
      await tx
        .select()
        .from(emailOperations)
        .where(
          and(
            eq(emailOperations.connection_id, connection.id),
            inArray(emailOperations.status, ['pending', 'running', 'unknown']),
          ),
        )
        .orderBy(desc(emailOperations.created_at), desc(emailOperations.id))
        .limit(1)
    )[0];
    if (unresolved && kind !== 'remove') {
      throw new EmailOperationError(`connection operation ${unresolved.id} is unresolved`);
    }
    if (kind === 'sync') {
      const blocked = (
        await tx
          .select({ id: emailOperations.id })
          .from(emailOperations)
          .where(
            and(
              eq(emailOperations.route_id, routeId),
              inArray(emailOperations.kind, ['setup', 'sync']),
              eq(emailOperations.status, 'blocked'),
              eq(emailOperations.desired_generation, connection.desired_generation),
            ),
          )
          .orderBy(desc(emailOperations.created_at), desc(emailOperations.id))
          .limit(1)
      )[0];
      if (blocked) {
        await resumeBlockedEmailOperationTx(tx, env, blocked.id, actor, routeId);
        return blocked.id;
      }
    }
    const opId = generateId('eop');
    const generation = unresolved
      ? connection.desired_generation
      : connection.desired_generation + 1;
    if (!unresolved) {
      await tx
        .update(emailZoneConnections)
        .set({ desired_generation: generation, updated_at: sql`now()` })
        .where(eq(emailZoneConnections.id, connection.id));
    }
    await tx.insert(emailOperations).values({
      id: opId,
      installation_id: installationId,
      connection_id: connection.id,
      route_id: routeId,
      route_generation: route.desired_generation,
      actor_kind: actor.kind,
      actor_user_id: actor.kind === 'system' ? null : actor.userId,
      actor_scope: actorScope,
      kind,
      idempotency_key: key,
      request_digest: requestDigest,
      desired_generation: generation,
      current_step: unresolved && kind === 'remove' ? `wait:${unresolved.id}` : null,
    });
    const steps =
      kind === 'sync'
        ? route.inbound_mode === 'none'
          ? OUTBOUND_ONLY_STEPS
          : isSharedGatewayConnection(env, connection)
            ? route.addressing === 'shared'
              ? SHARED_SYNC_STEPS
              : NATIVE_CUSTOM_SYNC_STEPS
            : connection.staged_secret_generation !== null
              ? STAGED_SECRET_REPAIR_STEPS
              : connection.inbound_status !== 'ready' || route.inbound_status !== 'ready'
                ? SETUP_STEPS
                : SYNC_STEPS
        : REMOVE_STEPS;
    await insertEmailOperationSteps(tx, env, {
      operationId: opId,
      connection,
      steps,
      generation,
      route,
      secretGeneration: (step) => emailStepSecretGeneration(kind, connection, step),
    });
    return opId;
  });
}

/** Bounded synchronous driver. Cron calls this too, so a lost HTTP response cannot strand setup. */
export async function runEmailOperation(db: Db, env: Bindings, operationId: string): Promise<void> {
  for (let iteration = 0; iteration < 12; iteration++) {
    const claim = await db.transaction(async (tx) => {
      const snapshot = (
        await tx.select().from(emailOperations).where(eq(emailOperations.id, operationId)).limit(1)
      )[0];
      if (
        !snapshot ||
        snapshot.status === 'completed' ||
        snapshot.status === 'blocked' ||
        snapshot.status === 'unknown'
      ) {
        return null;
      }
      // Every operation driver and recovery path locks the connection before
      // the operation and step. Read the operation once without a lock only to
      // discover that connection, then re-read and validate it under the lock.
      const connection = (
        await tx
          .select()
          .from(emailZoneConnections)
          .where(eq(emailZoneConnections.id, snapshot.connection_id))
          .for('update')
          .limit(1)
      )[0];
      const op = (
        await tx
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, operationId))
          .for('update')
          .limit(1)
      )[0];
      if (
        !op ||
        op.connection_id !== snapshot.connection_id ||
        op.route_id !== snapshot.route_id ||
        op.desired_generation !== snapshot.desired_generation ||
        op.status === 'completed' ||
        op.status === 'blocked' ||
        op.status === 'unknown'
      ) {
        return null;
      }
      if (!connection || connection.desired_generation !== op.desired_generation) {
        throw new EmailOperationError('email operation generation changed');
      }
      if (op.kind === 'remove') {
        // Removal intents form a durable chain. A later sibling removal may
        // wait for this one, but must never stop it from making progress.
        const predecessorId = op.current_step?.startsWith('wait:')
          ? op.current_step.slice(5)
          : null;
        if (predecessorId) {
          const predecessor = (
            await tx
              .select({ status: emailOperations.status })
              .from(emailOperations)
              .where(eq(emailOperations.id, predecessorId))
              .limit(1)
          )[0];
          if (
            predecessor &&
            (predecessor.status === 'pending' ||
              predecessor.status === 'running' ||
              predecessor.status === 'unknown')
          ) {
            return null;
          }
        }
      }
      const steps = await tx
        .select()
        .from(emailOperationSteps)
        .where(eq(emailOperationSteps.operation_id, operationId))
        .orderBy(emailOperationSteps.ordinal);
      const step = steps.find((s) => s.status !== 'confirmed');
      if (!step) {
        await tx
          .update(emailOperations)
          .set({ status: 'completed', current_step: null, updated_at: sql`now()` })
          .where(eq(emailOperations.id, operationId));
        return null;
      }
      if (step.status === 'in_flight') {
        // A second scheduler must leave the current driver alone. A crashed
        // driver is fenced only after its lease ages out; its provider write
        // is never replayed merely because the lease expired.
        const lease = (
          await tx
            .select({
              expired: sql<boolean>`${emailOperationSteps.started_at} IS NULL OR ${emailOperationSteps.started_at} <= now() - interval '5 minutes'`,
            })
            .from(emailOperationSteps)
            .where(eq(emailOperationSteps.id, step.id))
            .limit(1)
        )[0];
        if (!lease?.expired) {
          return null;
        }
        await tx
          .update(emailOperationSteps)
          .set({ status: 'unknown', failure_code: 'outcome_unknown' })
          .where(
            and(
              eq(emailOperationSteps.id, step.id),
              eq(emailOperationSteps.status, 'in_flight'),
              eq(emailOperationSteps.attempt, step.attempt),
            ),
          );
        await tx
          .update(emailOperations)
          .set({
            status: 'unknown',
            current_step: step.kind,
            failure_code: 'outcome_unknown',
            updated_at: sql`now()`,
          })
          .where(eq(emailOperations.id, operationId));
        return null;
      }
      if (step.status === 'unknown' || step.status === 'blocked') {
        return null;
      }
      if (
        op.kind === 'remove' &&
        (step.kind === 'catchall_detach' || step.kind === 'ingress_delete') &&
        op.route_id
      ) {
        const [route] = await tx
          .select({
            projectId: emailDomainRoutes.project_id,
            domain: emailDomainRoutes.domain,
            inboundMode: emailDomainRoutes.inbound_mode,
          })
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.id, op.route_id))
          .limit(1);
        if (route?.projectId) {
          const [active] = await tx
            .select({ n: count() })
            .from(emailUnresolvedAttempts)
            .where(
              and(
                eq(emailUnresolvedAttempts.project_id, route.projectId),
                eq(emailUnresolvedAttempts.sender_domain, route.domain),
              ),
            );
          if ((active?.n ?? 0) > 0) {
            return null;
          }
        }
        const [sibling] = await tx
          .select({ id: emailDomainRoutes.id })
          .from(emailDomainRoutes)
          .where(
            and(
              eq(emailDomainRoutes.connection_id, connection.id),
              ne(emailDomainRoutes.desired_state, 'removed'),
              ne(emailDomainRoutes.id, op.route_id),
            ),
          )
          .limit(1);
        // An outbound-only route never installed a catch-all or ingress Worker, so its
        // removal has nothing to clean up in Email Routing or Workers.
        const retained = sibling
          ? { retainedForSibling: true }
          : route?.inboundMode === 'none'
            ? { outboundOnly: true }
            : !canManageConnection(
                  { kind: op.actor_kind, userId: op.actor_user_id ?? '' } as EmailActor,
                  connection,
                )
              ? { retainedForManager: true }
              : null;
        if (retained && 'outboundOnly' in retained && step.kind === 'ingress_delete') {
          await forgetUnusedEmailCredential(tx, connection.id, op.route_id);
        }
        if (retained) {
          // Local retention is atomic with its outcome, so a driver crash cannot
          // turn a step that never called the provider into an unknown write.
          await tx
            .update(emailOperationSteps)
            .set({ status: 'confirmed', outcome: retained, finished_at: sql`now()` })
            .where(eq(emailOperationSteps.id, step.id));
          await tx
            .update(emailOperations)
            .set({ status: 'pending', current_step: step.kind, updated_at: sql`now()` })
            .where(eq(emailOperations.id, operationId));
          return { local: true };
        }
      }
      await tx
        .update(emailOperationSteps)
        .set({ status: 'in_flight', attempt: step.attempt + 1, started_at: sql`now()` })
        .where(eq(emailOperationSteps.id, step.id));
      await tx
        .update(emailOperations)
        .set({ status: 'running', current_step: step.kind, updated_at: sql`now()` })
        .where(eq(emailOperations.id, operationId));
      return { op, connection, step, attempt: step.attempt + 1 };
    });
    if (!claim) {
      return;
    }
    if ('local' in claim) {
      continue;
    }
    try {
      const outcome = await executeEmailStep(db, env, claim.op, claim.connection, claim.step);
      await db.transaction(async (tx) => {
        const current = (
          await tx
            .select()
            .from(emailZoneConnections)
            .where(eq(emailZoneConnections.id, claim.connection.id))
            .for('update')
            .limit(1)
        )[0];
        if (!current || current.desired_generation !== claim.op.desired_generation) {
          return;
        }
        const currentOperation = (
          await tx
            .select({
              status: emailOperations.status,
              connectionId: emailOperations.connection_id,
              desiredGeneration: emailOperations.desired_generation,
            })
            .from(emailOperations)
            .where(eq(emailOperations.id, operationId))
            .for('update')
            .limit(1)
        )[0];
        if (
          !currentOperation ||
          !['running', 'unknown'].includes(currentOperation.status) ||
          currentOperation.connectionId !== current.id ||
          currentOperation.desiredGeneration !== claim.op.desired_generation
        ) {
          return;
        }
        const updated = await tx
          .update(emailOperationSteps)
          .set({
            status: 'confirmed',
            outcome,
            failure_code: null,
            failure_detail: null,
            finished_at: sql`now()`,
          })
          .where(
            and(
              eq(emailOperationSteps.id, claim.step.id),
              eq(emailOperationSteps.attempt, claim.attempt),
              inArray(emailOperationSteps.status, ['in_flight', 'unknown']),
            ),
          )
          .returning({ id: emailOperationSteps.id });
        if (updated.length) {
          if (
            claim.step.kind === 'ingress_delete' &&
            outcome.deleted === true &&
            claim.op.route_id
          ) {
            await tx
              .update(emailZoneConnections)
              .set({ inbound_status: 'disabled', inbound_observed_at: sql`now()` })
              .where(eq(emailZoneConnections.id, current.id));
            await forgetUnusedEmailCredential(tx, current.id, claim.op.route_id);
          }
          await tx
            .update(emailOperations)
            .set({
              status: 'pending',
              failure_code: null,
              failure_detail: null,
              updated_at: sql`now()`,
            })
            .where(
              and(
                eq(emailOperations.id, operationId),
                inArray(emailOperations.status, ['running', 'unknown']),
              ),
            );
        }
      });
    } catch (error) {
      // A write may have reached Cloudflare even if fetch failed. Stop until
      // an explicit probe or operator decision establishes its outcome.
      const detail = error instanceof Error ? error.message : String(error);
      const blocked =
        error instanceof EmailOperationPreflightError ||
        ((error instanceof EmailOperationError || error instanceof CloudflareApiError) &&
          error.status < 500 &&
          error.status !== 408);
      const status = blocked ? 'blocked' : 'unknown';
      await db.transaction(async (tx) => {
        const current = (
          await tx
            .select({ desiredGeneration: emailZoneConnections.desired_generation })
            .from(emailZoneConnections)
            .where(eq(emailZoneConnections.id, claim.connection.id))
            .for('update')
            .limit(1)
        )[0];
        if (!current || current.desiredGeneration !== claim.op.desired_generation) {
          return;
        }
        const currentOperation = (
          await tx
            .select({
              status: emailOperations.status,
              connectionId: emailOperations.connection_id,
              desiredGeneration: emailOperations.desired_generation,
            })
            .from(emailOperations)
            .where(eq(emailOperations.id, operationId))
            .for('update')
            .limit(1)
        )[0];
        if (
          !currentOperation ||
          !['running', 'unknown'].includes(currentOperation.status) ||
          currentOperation.connectionId !== claim.connection.id ||
          currentOperation.desiredGeneration !== claim.op.desired_generation
        ) {
          return;
        }
        const updated = await tx
          .update(emailOperationSteps)
          .set({
            status,
            failure_code: blocked ? 'blocked' : 'outcome_unknown',
            failure_detail: detail.slice(0, 300),
            finished_at: sql`now()`,
          })
          .where(
            and(
              eq(emailOperationSteps.id, claim.step.id),
              eq(emailOperationSteps.attempt, claim.attempt),
              inArray(emailOperationSteps.status, ['in_flight', 'unknown']),
            ),
          )
          .returning({ id: emailOperationSteps.id });
        if (updated.length) {
          await tx
            .update(emailOperations)
            .set({
              status,
              current_step: claim.step.kind,
              failure_code: blocked ? 'blocked' : 'outcome_unknown',
              failure_detail: detail.slice(0, 300),
              updated_at: sql`now()`,
            })
            .where(
              and(
                eq(emailOperations.id, operationId),
                inArray(emailOperations.status, ['running', 'unknown']),
              ),
            );
        }
      });
      return;
    }
  }
}

async function executeEmailStep(
  db: Db,
  env: Bindings,
  op: typeof emailOperations.$inferSelect,
  connection: typeof emailZoneConnections.$inferSelect,
  step: typeof emailOperationSteps.$inferSelect,
): Promise<Record<string, unknown>> {
  const kind = step.kind as StepKind;
  const route = await emailOperationPreflight(() => findEmailRoute(db, op.route_id));
  if (isOperatorRecoverableWriteStep(kind) || kind === 'secret_retire') {
    const { expectedIdentity, expectedDigest } = await emailOperationPreflight(async () => {
      const secretGeneration = emailStepSecretGeneration(op.kind, connection, kind);
      return {
        expectedIdentity: emailStepResourceIdentity(connection, kind, route, secretGeneration),
        expectedDigest: await emailStepRequestDigest(
          env,
          connection,
          kind,
          op.desired_generation,
          route,
          secretGeneration,
        ),
      };
    });
    if (step.resource_identity !== expectedIdentity || step.request_digest !== expectedDigest) {
      throw new EmailOperationError(
        'email operation intent does not match the current relay implementation',
        409,
      );
    }
  }
  if (kind === 'route_disable') {
    return { disabled: true };
  }
  if (kind === 'publish') {
    if (route) {
      await db.transaction(async (tx) => {
        if (op.kind === 'remove') {
          await tx
            .update(emailDomainRoutes)
            .set({ desired_state: 'removed', inbound_status: 'disabled', updated_at: sql`now()` })
            .where(eq(emailDomainRoutes.id, route.id));
        }
        const state = op.kind === 'remove' ? 'removed' : route.desired_state;
        await tx
          .insert(emailCacheOutbox)
          .values({
            id: generateId('eout'),
            installation_id: connection.installation_id,
            resource_kind: 'route',
            resource_id: route.id,
            version: route.desired_generation,
            payload: { domain: route.domain, status: state, connectionId: connection.id },
          })
          .onConflictDoNothing();
      });
    }
    return { published: false, queued: true };
  }
  if (kind === 'secret_retire') {
    if (
      (op.kind !== 'setup' && op.kind !== 'sync') ||
      connection.staged_secret_generation === null
    ) {
      throw new EmailOperationError('staged ingress generation unavailable');
    }
    const retiredGeneration = connection.staged_secret_generation;
    const retired = await db
      .update(emailZoneConnections)
      .set({
        staged_secret_generation: null,
        staged_secret_ciphertext: null,
        staged_secret_iv: null,
        staged_secret_key_version: null,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(emailZoneConnections.id, connection.id),
          eq(emailZoneConnections.desired_generation, op.desired_generation),
          eq(emailZoneConnections.staged_secret_generation, retiredGeneration),
        ),
      )
      .returning({ id: emailZoneConnections.id });
    if (!retired.length) {
      throw new EmailOperationError('staged ingress retirement lost its generation fence', 503);
    }
    return { retiredGeneration };
  }
  const credential = await emailOperationPreflight(() => credentialFor(env, db, connection));
  const client = createCfCustomerClient(credential);
  if (kind === 'routing_enable') {
    if (!route) {
      throw new EmailOperationError('route is unavailable');
    }
    const subdomain = route.domain !== connection.zone_name;
    if (subdomain && route.addressing === 'custom') {
      throw new EmailOperationError(
        'Cloudflare catch-all routing requires a zone apex; use the apex domain for custom inbound email',
      );
    }
    if (route.addressing === 'shared') {
      const exchanges = await emailOperationPreflight(() => lookupMxOverDns(route.domain));
      if (exchanges.some((exchange) => !isCloudflareEmailRoutingMx(exchange))) {
        throw new EmailOperationError(
          `${route.domain} already has MX records for another mail provider; choose an unused shared mail domain`,
        );
      }
    }
    await client.enableRouting(connection.zone_id, subdomain ? route.domain : undefined);
    return { domain: route.domain };
  }
  if (kind === 'ingress_deploy') {
    await client.putRelayScript(connection.account_id, connection.ingress_worker_name, {
      source: RELAY_SOURCE,
      compatibilityDate: RELAY_COMPATIBILITY_DATE,
      gatewayOrigin: gatewayOrigin(env),
      accountId: connection.account_id,
      zoneId: connection.zone_id,
      ingressName: connection.ingress_worker_name,
    });
    await db
      .update(emailZoneConnections)
      .set({ ingress_version: RELAY_VERSION, updated_at: sql`now()` })
      .where(
        and(
          eq(emailZoneConnections.id, connection.id),
          eq(emailZoneConnections.desired_generation, op.desired_generation),
        ),
      );
    return { version: RELAY_VERSION };
  }
  if (kind === 'probe_route_enable') {
    if (
      !(await emailOperationPreflight(() =>
        client.getScriptSubdomainEnabled(connection.account_id, connection.ingress_worker_name),
      ))
    ) {
      await client.enableScriptSubdomain(connection.account_id, connection.ingress_worker_name);
    }
    return { enabled: true };
  }
  if (kind === 'secret_put') {
    const staged = op.kind === 'rotate_secret';
    const secret = await emailOperationPreflight(() =>
      staged ? readStagedConnectionSecret(env, connection) : readConnectionSecret(env, connection),
    );
    await client.putRelaySecret(connection.account_id, connection.ingress_worker_name, secret);
    return {
      generation: staged
        ? connection.staged_secret_generation
        : connection.active_secret_generation,
    };
  }
  if (kind === 'relay_probe') {
    return probeDeployedRelay(client, env, connection, op.kind === 'rotate_secret');
  }
  if (kind === 'gateway_probe') {
    return probeGatewayAcceptance(env, connection, op.kind === 'rotate_secret');
  }
  if (kind === 'secret_promote') {
    if (
      op.kind !== 'rotate_secret' ||
      connection.staged_secret_generation === null ||
      !connection.staged_secret_ciphertext ||
      !connection.staged_secret_iv ||
      !connection.staged_secret_key_version
    ) {
      throw new EmailOperationError('staged ingress generation unavailable');
    }
    const oldSecret = await readConnectionSecret(env, connection);
    const oldHash = await digest(oldSecret);
    const promoted = await db
      .update(emailZoneConnections)
      .set({
        active_secret_generation: connection.staged_secret_generation,
        secret_ciphertext: connection.staged_secret_ciphertext,
        secret_iv: connection.staged_secret_iv,
        secret_key_version: connection.staged_secret_key_version,
        staged_secret_generation: null,
        staged_secret_ciphertext: null,
        staged_secret_iv: null,
        staged_secret_key_version: null,
        previous_secret_hash: oldHash,
        previous_secret_until: sql`now() + interval '10 minutes'`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(emailZoneConnections.id, connection.id),
          eq(emailZoneConnections.desired_generation, op.desired_generation),
          eq(emailZoneConnections.staged_secret_generation, connection.staged_secret_generation),
        ),
      )
      .returning({ id: emailZoneConnections.id });
    if (!promoted.length) {
      throw new EmailOperationError('secret promotion lost its generation fence', 503);
    }
    return { generation: connection.staged_secret_generation };
  }
  if (
    kind === 'subaddressing_ensure' ||
    (kind === 'catchall_ensure' && route?.addressing === 'shared')
  ) {
    if (!route || route.addressing !== 'shared') {
      throw new EmailOperationError('shared email route is unavailable');
    }
    // Compatibility for interrupted catch-all-era shared bootstrap operations.
    if (kind === 'catchall_ensure') {
      await client.enableRouting(
        connection.zone_id,
        route.domain === connection.zone_name ? undefined : route.domain,
      );
    }
    const settings = await emailOperationPreflight(() =>
      client.getRoutingSettings(connection.zone_id),
    );
    if (!supportsSubaddressing(settings)) {
      await client.enableSubaddressing(connection.zone_id);
    }
    if (!supportsSubaddressing(await client.getRoutingSettings(connection.zone_id))) {
      throw new EmailOperationError('Cloudflare did not enable shared email subaddressing', 503);
    }
    return { subaddressing: true };
  }
  if (kind === 'catchall_ensure') {
    if (route && route.domain !== connection.zone_name) {
      throw new EmailOperationError(
        'Cloudflare catch-all routing requires a zone apex; use the apex domain for custom inbound email',
      );
    }
    const current = await emailOperationPreflight(() => client.getCatchAll(connection.zone_id));
    if (current?.enabled && current.workerName !== connection.ingress_worker_name) {
      throw new EmailOperationError('another enabled catch-all owns this zone');
    }
    if (!current?.enabled) {
      await client.setCatchAll(connection.zone_id, connection.ingress_worker_name);
    }
    return { workerName: connection.ingress_worker_name };
  }
  if (kind === 'inbound_probe') {
    if (!route) {
      throw new EmailOperationError('email route is unavailable');
    }
    const issue = await inspectEmailInboundRoute(
      client,
      connection,
      route.domain,
      route.addressing,
    );
    if (issue) {
      await db
        .update(emailDomainRoutes)
        .set({
          inbound_status: 'drifted',
          inbound_reason: issue,
          inbound_observed_at: sql`now()`,
        })
        .where(
          and(
            eq(emailDomainRoutes.id, route.id),
            eq(emailDomainRoutes.connection_id, connection.id),
            eq(emailDomainRoutes.desired_generation, route.desired_generation),
            eq(emailDomainRoutes.desired_state, 'active'),
          ),
        );
      throw new EmailOperationError(issue);
    }
    const observed = await db.transaction(async (tx) => {
      // Route-bearing transactions always lock route before connection. Re-read
      // both generations because the provider probe ran outside this transaction.
      const currentRoute = (
        await tx
          .select()
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.id, route.id))
          .for('update')
          .limit(1)
      )[0];
      if (
        !currentRoute ||
        currentRoute.connection_id !== connection.id ||
        currentRoute.desired_generation !== route.desired_generation ||
        currentRoute.desired_state !== 'active'
      ) {
        return false;
      }
      const currentConnection = (
        await tx
          .select()
          .from(emailZoneConnections)
          .where(eq(emailZoneConnections.id, connection.id))
          .for('update')
          .limit(1)
      )[0];
      if (!currentConnection || currentConnection.desired_generation !== op.desired_generation) {
        return false;
      }
      await tx
        .update(emailZoneConnections)
        .set({ inbound_status: 'ready', inbound_reason: null, inbound_observed_at: sql`now()` })
        .where(
          and(
            eq(emailZoneConnections.id, connection.id),
            eq(emailZoneConnections.desired_generation, op.desired_generation),
          ),
        );
      await tx
        .update(emailDomainRoutes)
        .set({ inbound_status: 'ready', inbound_reason: null, inbound_observed_at: sql`now()` })
        .where(
          and(
            eq(emailDomainRoutes.id, route.id),
            eq(emailDomainRoutes.connection_id, connection.id),
            eq(emailDomainRoutes.desired_generation, route.desired_generation),
            eq(emailDomainRoutes.desired_state, 'active'),
          ),
        );
      return true;
    });
    return observed ? { ready: true } : { ready: false, stale: true };
  }
  if (kind === 'sending_onboard') {
    if (!route || route.desired_state !== 'active') {
      return { skipped: true };
    }
    const outboundOnly = route.inbound_mode === 'none';
    const blockOutbound = async (reason: string, message: string): Promise<never> => {
      await db
        .update(emailDomainRoutes)
        .set({
          outbound_status: 'blocked',
          outbound_reason: reason,
          outbound_observed_at: sql`now()`,
        })
        .where(
          and(
            eq(emailDomainRoutes.id, route.id),
            eq(emailDomainRoutes.connection_id, connection.id),
            eq(emailDomainRoutes.desired_generation, route.desired_generation),
            eq(emailDomainRoutes.desired_state, 'active'),
          ),
        );
      throw new EmailOperationError(message, 409);
    };
    // The apex usually belongs to another mail provider. Onboarding only adds records on
    // cf-bounce.<domain> and _dmarc.<domain>; refuse before writing if any of them clash.
    // Missing records are expected here, since onboarding creates them. A domain that is
    // already onboarded owns those records, so a later sync skips the check.
    if (
      outboundOnly &&
      !(await emailOperationPreflight(() =>
        sendingOnboardedReadback(client, connection.zone_id, route.domain),
      ))
    ) {
      const conflicts = (
        await emailOperationPreflight(() => client.previewSending(connection.zone_id, route.domain))
      ).filter((issue) => !issue.code.endsWith('.missing'));
      if (conflicts.length > 0) {
        const list = conflicts
          .map((issue) => (issue.name ? `${issue.code} at ${issue.name}` : issue.code))
          .join('; ');
        await blockOutbound(
          'Existing DNS records conflict with Cloudflare Email Sending',
          `Cloudflare Email Sending cannot onboard ${route.domain}: ${list}. Fix these DNS records, then run domain-sync.`,
        );
      }
    }
    try {
      await client.onboardSending(connection.zone_id, route.domain);
    } catch (error) {
      let onboarded: boolean;
      try {
        onboarded = await sendingOnboardedReadback(client, connection.zone_id, route.domain);
      } catch {
        // A failed probe cannot narrow the original write outcome. Preserve the
        // original error so an uncertain POST remains behind operator recovery.
        throw error;
      }
      if (!onboarded) {
        const definitiveRefusal =
          error instanceof CloudflareApiError && error.status < 500 && error.status !== 408;
        if (!definitiveRefusal) {
          throw error;
        }
        if (outboundOnly) {
          // Verified-only sending needs an Email Routing domain, so it is no fallback here.
          await blockOutbound(
            'Cloudflare Sending onboarding unavailable',
            `Cloudflare refused Email Sending for ${route.domain} (HTTP ${error.status}). It needs the Workers Paid plan; enable it, then run domain-sync.`,
          );
        }
        await db
          .update(emailDomainRoutes)
          .set({
            outbound_status: 'verified_only',
            outbound_reason: 'Cloudflare Sending onboarding unavailable',
            outbound_observed_at: sql`now()`,
          })
          .where(
            and(
              eq(emailDomainRoutes.id, route.id),
              eq(emailDomainRoutes.connection_id, connection.id),
              eq(emailDomainRoutes.desired_generation, route.desired_generation),
              eq(emailDomainRoutes.desired_state, 'active'),
            ),
          );
        return { verifiedOnly: true };
      }
    }
    await db
      .update(emailDomainRoutes)
      .set({ outbound_status: 'ready', outbound_reason: null, outbound_observed_at: sql`now()` })
      .where(
        and(
          eq(emailDomainRoutes.id, route.id),
          eq(emailDomainRoutes.connection_id, connection.id),
          eq(emailDomainRoutes.desired_state, 'active'),
          eq(emailDomainRoutes.desired_generation, route.desired_generation),
        ),
      );
    return { ready: true };
  }
  if (kind === 'catchall_detach') {
    const current = await emailOperationPreflight(() => client.getCatchAll(connection.zone_id));
    if (current?.enabled && current.workerName === connection.ingress_worker_name) {
      await client.resetCatchAll(connection.zone_id);
    }
    return { detached: true };
  }
  if (kind === 'ingress_delete') {
    const current = await emailOperationPreflight(() => client.getCatchAll(connection.zone_id));
    if (current?.enabled && current.workerName === connection.ingress_worker_name) {
      throw new EmailOperationError('owned catch-all still targets ingress');
    }
    await client.deleteRelayScript(connection.account_id, connection.ingress_worker_name);
    return { deleted: true };
  }
  throw new EmailOperationError(`unsupported email step: ${kind}`);
}

export async function reconcilePendingEmailOperations(
  db: Db,
  env: Bindings,
  limit = 10,
): Promise<number> {
  const rows = await db
    .select({ id: emailOperations.id, status: emailOperations.status })
    .from(emailOperations)
    .where(inArray(emailOperations.status, ['pending', 'running', 'unknown']))
    .orderBy(emailOperations.updated_at, emailOperations.id)
    .limit(limit);
  for (const row of rows) {
    // Ambiguous writes may need human recovery. Rotate visits so they cannot
    // occupy every batch slot forever; step.started_at still owns its lease.
    await db
      .update(emailOperations)
      .set({ updated_at: sql`now()` })
      .where(eq(emailOperations.id, row.id));
    if (row.status === 'unknown') {
      await reconcileUnknownEmailOperation(db, env, row.id);
    }
    await runEmailOperation(db, env, row.id);
  }
  return rows.length;
}

export type EmailOperationRecoveryFence = {
  operationId: string;
  stepId: string;
  step: OperatorRecoverableWriteStep;
  attempt: number;
  requestDigest: string;
  resourceIdentity: string;
  connectionId: string;
  desiredGeneration: number;
  routeId: string | null;
  routeDesiredGeneration: number | null;
  startedAt: string;
  eligibleAt: string;
};

async function supersedingRemovalId(
  db: DbOrTx,
  operation: typeof emailOperations.$inferSelect,
  route: typeof emailDomainRoutes.$inferSelect | null,
  lock = false,
): Promise<string | null> {
  if (
    !route ||
    (operation.kind !== 'setup' && operation.kind !== 'sync') ||
    operation.route_id !== route.id ||
    operation.route_generation === null ||
    route.desired_state === 'active'
  ) {
    return null;
  }
  const query = db
    .select({ id: emailOperations.id })
    .from(emailOperations)
    .where(
      and(
        eq(emailOperations.route_id, route.id),
        eq(emailOperations.route_generation, route.desired_generation),
        eq(emailOperations.kind, 'remove'),
        eq(emailOperations.status, 'pending'),
        eq(emailOperations.current_step, `wait:${operation.id}`),
      ),
    )
    .limit(1);
  const [removal] = lock ? await query.for('update') : await query;
  return removal?.id ?? null;
}

async function completeSupersededEmailOperation(
  tx: Tx,
  operation: typeof emailOperations.$inferSelect,
  removalId: string,
): Promise<void> {
  await tx
    .update(emailOperationSteps)
    .set({
      status: 'confirmed',
      outcome: { skipped: true, supersededByRemoval: removalId },
      failure_code: null,
      failure_detail: null,
      finished_at: sql`now()`,
    })
    .where(
      and(
        eq(emailOperationSteps.operation_id, operation.id),
        eq(emailOperationSteps.status, 'pending'),
      ),
    );
}

async function unknownEmailOperationRecoveryFence(
  db: DbOrTx,
  env: Bindings,
  operationId: string,
  lock = false,
) {
  const snapshot = (
    await db.select().from(emailOperations).where(eq(emailOperations.id, operationId)).limit(1)
  )[0];
  if (
    !snapshot ||
    snapshot.installation_id !== emailInstallationId(env) ||
    snapshot.status !== 'unknown'
  ) {
    throw new EmailOperationError('unknown email operation not found', 404);
  }
  const routeQuery = snapshot.route_id
    ? db
        .select()
        .from(emailDomainRoutes)
        .where(eq(emailDomainRoutes.id, snapshot.route_id))
        .limit(1)
    : null;
  const [route = null] = routeQuery
    ? lock
      ? await routeQuery.for('update')
      : await routeQuery
    : [];
  const connectionQuery = db
    .select()
    .from(emailZoneConnections)
    .where(eq(emailZoneConnections.id, snapshot.connection_id))
    .limit(1);
  const [connection] = lock ? await connectionQuery.for('update') : await connectionQuery;
  const operation = lock
    ? (
        await db
          .select()
          .from(emailOperations)
          .where(eq(emailOperations.id, snapshot.id))
          .for('update')
          .limit(1)
      )[0]
    : snapshot;
  const stepQuery = db
    .select()
    .from(emailOperationSteps)
    .where(
      and(
        eq(emailOperationSteps.operation_id, snapshot.id),
        eq(emailOperationSteps.status, 'unknown'),
      ),
    )
    .orderBy(emailOperationSteps.ordinal)
    .limit(1);
  const [step] = lock ? await stepQuery.for('update') : await stepQuery;
  if (
    !connection ||
    !operation ||
    !step ||
    operation.status !== 'unknown' ||
    operation.connection_id !== snapshot.connection_id ||
    operation.route_id !== snapshot.route_id ||
    operation.route_generation !== snapshot.route_generation ||
    operation.desired_generation !== snapshot.desired_generation ||
    connection.desired_generation !== operation.desired_generation ||
    operation.current_step !== step.kind ||
    !isOperatorRecoverableWriteStep(step.kind) ||
    (operation.kind === 'rotate_secret'
      ? operation.route_id !== null || operation.route_generation !== null || route !== null
      : operation.route_id === null ||
        operation.route_generation === null ||
        !route ||
        route.connection_id !== connection.id ||
        route.id !== operation.route_id) ||
    !step.started_at
  ) {
    throw new EmailOperationError('email operation recovery fence is unavailable', 409);
  }
  const removalId = await supersedingRemovalId(db, operation, route, lock);
  if (
    operation.route_id !== null &&
    !removalId &&
    (route!.desired_generation !== operation.route_generation ||
      ((operation.kind === 'setup' || operation.kind === 'sync') &&
        route!.desired_state !== 'active'))
  ) {
    throw new EmailOperationError('email operation recovery fence is unavailable', 409);
  }
  const intentRoute = route
    ? {
        id: route.id,
        domain: route.domain,
        desired_generation: operation.route_generation!,
      }
    : null;
  const secretGeneration = emailStepSecretGeneration(operation.kind, connection, step.kind);
  const expectedIdentity = emailStepResourceIdentity(
    connection,
    step.kind,
    intentRoute,
    secretGeneration,
  );
  const expectedDigest = await emailStepRequestDigest(
    env,
    connection,
    step.kind,
    operation.desired_generation,
    intentRoute,
    secretGeneration,
  );
  if (step.resource_identity !== expectedIdentity || step.request_digest !== expectedDigest) {
    throw new EmailOperationError(
      'email operation intent does not match the current relay implementation',
      409,
    );
  }
  const startedAt = new Date(step.started_at);
  const fence: EmailOperationRecoveryFence = {
    operationId: operation.id,
    stepId: step.id,
    step: step.kind,
    attempt: step.attempt,
    requestDigest: step.request_digest,
    resourceIdentity: step.resource_identity,
    connectionId: connection.id,
    desiredGeneration: operation.desired_generation,
    routeId: route?.id ?? null,
    routeDesiredGeneration: operation.route_generation,
    startedAt: startedAt.toISOString(),
    eligibleAt: new Date(startedAt.getTime() + EMAIL_OPERATION_RECOVERY_MIN_AGE_MS).toISOString(),
  };
  return { fence, operation, step, connection, route, removalId };
}

export async function inspectUnknownEmailOperationRecovery(
  db: Db,
  env: Bindings,
  operationId: string,
): Promise<EmailOperationRecoveryFence> {
  return (await unknownEmailOperationRecoveryFence(db, env, operationId)).fence;
}

export async function resolveUnknownEmailOperation(
  db: Db,
  env: Bindings,
  input: {
    operationId: string;
    stepId: string;
    attempt: number;
    requestDigest: string;
    resourceIdentity: string;
    connectionId: string;
    desiredGeneration: number;
    routeId: string | null;
    routeDesiredGeneration: number | null;
    ended: boolean;
    outcome: 'applied' | 'not-applied';
    reason: string;
    now?: number;
  },
): Promise<{
  operationId: string;
  stepId: string;
  status: 'pending' | 'completed';
  outcome: string;
}> {
  if (!input.ended) {
    throw new EmailOperationError('confirm the original provider execution has ended', 400);
  }
  if (!input.reason.trim() || input.reason.length > 500) {
    throw new EmailOperationError('a bounded operator recovery reason is required', 400);
  }
  if (input.outcome !== 'applied' && input.outcome !== 'not-applied') {
    throw new EmailOperationError('email operation recovery outcome is invalid', 400);
  }
  const now = input.now ?? Date.now();
  return db.transaction(async (tx) => {
    const { fence, operation, step, connection, route, removalId } =
      await unknownEmailOperationRecoveryFence(tx, env, input.operationId, true);
    if (new Date(fence.eligibleAt).getTime() > now) {
      throw new EmailOperationError(
        `email operation cannot be resolved before ${fence.eligibleAt}`,
        409,
      );
    }
    if (
      fence.stepId !== input.stepId ||
      fence.attempt !== input.attempt ||
      fence.requestDigest !== input.requestDigest ||
      fence.resourceIdentity !== input.resourceIdentity ||
      fence.connectionId !== input.connectionId ||
      fence.desiredGeneration !== input.desiredGeneration ||
      fence.routeId !== input.routeId ||
      fence.routeDesiredGeneration !== input.routeDesiredGeneration
    ) {
      throw new EmailOperationError('email operation recovery fence changed', 409);
    }
    const updated = await tx
      .update(emailOperationSteps)
      .set(
        input.outcome === 'applied' || removalId
          ? {
              status: 'confirmed',
              outcome: {
                operatorResolution: input.outcome,
                reason: input.reason.trim(),
                ...(removalId ? { supersededByRemoval: removalId } : {}),
              },
              failure_code: null,
              failure_detail: null,
              finished_at: sql`now()`,
            }
          : {
              status: 'pending',
              outcome: null,
              failure_code: null,
              failure_detail: null,
              started_at: null,
              finished_at: null,
            },
      )
      .where(
        and(
          eq(emailOperationSteps.id, step.id),
          eq(emailOperationSteps.operation_id, operation.id),
          eq(emailOperationSteps.status, 'unknown'),
          eq(emailOperationSteps.attempt, step.attempt),
          eq(emailOperationSteps.request_digest, step.request_digest),
        ),
      )
      .returning({ id: emailOperationSteps.id });
    if (!updated.length) {
      throw new EmailOperationError('email operation recovery fence changed', 409);
    }
    if (input.outcome === 'applied' && step.kind === 'ingress_deploy') {
      const match = /\/relay\/(\d+)$/.exec(step.resource_identity);
      const relayVersion = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(relayVersion) || relayVersion < 1) {
        throw new EmailOperationError('email relay recovery identity is invalid', 409);
      }
      const postcondition = await tx
        .update(emailZoneConnections)
        .set({ ingress_version: relayVersion, updated_at: sql`now()` })
        .where(
          and(
            eq(emailZoneConnections.id, connection.id),
            eq(emailZoneConnections.desired_generation, operation.desired_generation),
          ),
        )
        .returning({ id: emailZoneConnections.id });
      if (!postcondition.length) {
        throw new EmailOperationError('email operation recovery fence changed', 409);
      }
    }
    if (input.outcome === 'applied' && !removalId && step.kind === 'sending_onboard') {
      if (!route || route.desired_state !== 'active') {
        throw new EmailOperationError('email operation recovery fence changed', 409);
      }
      const postcondition = await tx
        .update(emailDomainRoutes)
        .set({
          outbound_status: 'ready',
          outbound_reason: null,
          outbound_observed_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(emailDomainRoutes.id, route.id),
            eq(emailDomainRoutes.connection_id, connection.id),
            eq(emailDomainRoutes.desired_state, 'active'),
            eq(emailDomainRoutes.desired_generation, route.desired_generation),
          ),
        )
        .returning({ id: emailDomainRoutes.id });
      if (!postcondition.length) {
        throw new EmailOperationError('email operation recovery fence changed', 409);
      }
    }
    if (input.outcome === 'applied' && step.kind === 'ingress_delete') {
      if (!route) {
        throw new EmailOperationError('email operation recovery fence changed', 409);
      }
      const postcondition = await tx
        .update(emailZoneConnections)
        .set({ inbound_status: 'disabled', inbound_observed_at: sql`now()` })
        .where(
          and(
            eq(emailZoneConnections.id, connection.id),
            eq(emailZoneConnections.desired_generation, operation.desired_generation),
          ),
        )
        .returning({ id: emailZoneConnections.id });
      if (!postcondition.length) {
        throw new EmailOperationError('email operation recovery fence changed', 409);
      }
      await forgetUnusedEmailCredential(tx, connection.id, route.id);
    }
    if (removalId) {
      await completeSupersededEmailOperation(tx, operation, removalId);
    }
    const resumed = await tx
      .update(emailOperations)
      .set({
        status: removalId ? 'completed' : 'pending',
        current_step: null,
        failure_code: null,
        failure_detail: null,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(emailOperations.id, operation.id),
          eq(emailOperations.status, 'unknown'),
          eq(emailOperations.desired_generation, operation.desired_generation),
        ),
      )
      .returning({ id: emailOperations.id });
    if (!resumed.length) {
      throw new EmailOperationError('email operation recovery fence changed', 409);
    }
    return {
      operationId: operation.id,
      stepId: step.id,
      status: removalId ? ('completed' as const) : ('pending' as const),
      outcome: input.outcome,
    };
  });
}

/** Read-only recovery for ambiguous provider writes. A result is confirmed
 * only where the currently observed resource proves this exact step's intent.
 * Script upload and routing enable remain unknown without that proof. */
export async function reconcileUnknownEmailOperation(
  db: Db,
  env: Bindings,
  operationId: string,
): Promise<boolean> {
  const op = (
    await db.select().from(emailOperations).where(eq(emailOperations.id, operationId)).limit(1)
  )[0];
  if (!op || op.status !== 'unknown') {
    return false;
  }
  const connection = (
    await db
      .select()
      .from(emailZoneConnections)
      .where(eq(emailZoneConnections.id, op.connection_id))
      .limit(1)
  )[0];
  if (!connection || connection.desired_generation !== op.desired_generation) {
    return false;
  }
  const step = (
    await db
      .select()
      .from(emailOperationSteps)
      .where(
        and(
          eq(emailOperationSteps.operation_id, operationId),
          eq(emailOperationSteps.status, 'unknown'),
        ),
      )
      .orderBy(emailOperationSteps.ordinal)
      .limit(1)
  )[0];
  if (!step) {
    return false;
  }
  let outcome: Record<string, unknown> | null = null;
  try {
    if (step.kind === 'route_disable') {
      const route = await findEmailRoute(db, op.route_id);
      if (route?.desired_state === 'disabled') {
        outcome = { disabled: true };
      }
    } else if (step.kind === 'secret_promote') {
      const target = Number(step.resource_identity.split('/secret/')[1]);
      if (
        Number.isInteger(target) &&
        connection.staged_secret_generation === null &&
        connection.active_secret_generation === target
      ) {
        outcome = { generation: connection.active_secret_generation };
      }
    } else if (step.kind === 'secret_retire') {
      const target = Number(step.resource_identity.split('/secret/')[1]);
      const route = await findEmailRoute(db, op.route_id);
      const intentRoute =
        route && op.route_generation !== null
          ? { id: route.id, domain: route.domain, desired_generation: op.route_generation }
          : null;
      if (
        Number.isInteger(target) &&
        intentRoute &&
        step.resource_identity ===
          emailStepResourceIdentity(connection, 'secret_retire', intentRoute, target) &&
        step.request_digest ===
          (await emailStepRequestDigest(
            env,
            connection,
            'secret_retire',
            op.desired_generation,
            intentRoute,
            target,
          )) &&
        (connection.staged_secret_generation === null ||
          connection.staged_secret_generation === target) &&
        connection.active_secret_generation !== target
      ) {
        outcome = { retiredGeneration: target };
      }
    } else if (step.kind === 'publish') {
      const route = await findEmailRoute(db, op.route_id);
      const outbox = route
        ? (
            await db
              .select({ id: emailCacheOutbox.id })
              .from(emailCacheOutbox)
              .where(
                and(
                  eq(emailCacheOutbox.resource_kind, 'route'),
                  eq(emailCacheOutbox.resource_id, route.id),
                  eq(emailCacheOutbox.version, route.desired_generation),
                ),
              )
              .limit(1)
          )[0]
        : null;
      if (outbox || op.kind === 'rotate_secret') {
        outcome = { queued: true };
      }
    } else {
      const client = createCfCustomerClient(await credentialFor(env, db, connection));
      if (step.kind === 'probe_route_enable') {
        if (
          await client.getScriptSubdomainEnabled(
            connection.account_id,
            connection.ingress_worker_name,
          )
        ) {
          outcome = { enabled: true };
        }
      } else if (step.kind === 'secret_put' || step.kind === 'relay_probe') {
        outcome = await probeDeployedRelay(client, env, connection, op.kind === 'rotate_secret');
      } else if (step.kind === 'gateway_probe') {
        outcome = await probeGatewayAcceptance(env, connection, op.kind === 'rotate_secret');
      } else if (step.kind === 'inbound_probe') {
        const route = await findEmailRoute(db, op.route_id);
        if (
          route &&
          !(await inspectEmailInboundRoute(client, connection, route.domain, route.addressing))
        ) {
          outcome = { ready: true };
        }
      } else if (step.kind === 'subaddressing_ensure') {
        if (supportsSubaddressing(await client.getRoutingSettings(connection.zone_id))) {
          outcome = { subaddressing: true };
        }
      } else if (step.kind === 'catchall_ensure') {
        const route = await findEmailRoute(db, op.route_id);
        if (route?.addressing === 'shared') {
          // Legacy shared-domain operations used this step for an apex-only
          // catch-all. Recovery must confirm the new subdomain prerequisites.
          if (!(await inspectEmailInboundRoute(client, connection, route.domain, 'shared'))) {
            outcome = { subaddressing: true };
          }
        } else {
          const catchall = await client.getCatchAll(connection.zone_id);
          if (
            catchall?.enabled &&
            catchall.workerName === connection.ingress_worker_name &&
            route?.domain === connection.zone_name
          ) {
            outcome = { workerName: connection.ingress_worker_name };
          }
        }
      } else if (step.kind === 'catchall_detach') {
        const catchall = await client.getCatchAll(connection.zone_id);
        if (!catchall?.enabled || catchall.workerName !== connection.ingress_worker_name) {
          outcome = { detached: true };
        }
      } else if (step.kind === 'ingress_delete') {
        if (
          !(await client.relayScriptExists(connection.account_id, connection.ingress_worker_name))
        ) {
          outcome = { deleted: true };
        }
      } else if (step.kind === 'sending_onboard') {
        const route = await findEmailRoute(db, op.route_id);
        if (route && (await sendingOnboardedReadback(client, connection.zone_id, route.domain))) {
          outcome = { ready: true };
        }
      }
    }
  } catch {
    return false;
  }
  if (!outcome) {
    return false;
  }
  return db.transaction(async (tx) => {
    const currentRoute = op.route_id
      ? (
          await tx
            .select()
            .from(emailDomainRoutes)
            .where(eq(emailDomainRoutes.id, op.route_id))
            .for('update')
            .limit(1)
        )[0]
      : null;
    if (op.route_id && (!currentRoute || currentRoute.connection_id !== connection.id)) {
      return false;
    }
    const current = (
      await tx
        .select()
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, connection.id))
        .for('update')
        .limit(1)
    )[0];
    if (!current || current.desired_generation !== op.desired_generation) {
      return false;
    }
    const currentOperation = (
      await tx
        .select()
        .from(emailOperations)
        .where(eq(emailOperations.id, operationId))
        .for('update')
        .limit(1)
    )[0];
    if (
      !currentOperation ||
      currentOperation.status !== 'unknown' ||
      currentOperation.connection_id !== connection.id ||
      currentOperation.route_id !== op.route_id ||
      currentOperation.route_generation !== op.route_generation ||
      currentOperation.desired_generation !== op.desired_generation ||
      currentOperation.current_step !== step.kind
    ) {
      return false;
    }
    if (
      currentOperation.kind === 'rotate_secret'
        ? currentOperation.route_id !== null ||
          currentOperation.route_generation !== null ||
          currentRoute !== null
        : currentOperation.route_id === null ||
          currentOperation.route_generation === null ||
          !currentRoute ||
          currentRoute.connection_id !== connection.id
    ) {
      return false;
    }
    const removalId = await supersedingRemovalId(tx, currentOperation, currentRoute, true);
    if (
      currentOperation.route_id !== null &&
      !removalId &&
      (currentRoute!.desired_generation !== currentOperation.route_generation ||
        ((currentOperation.kind === 'setup' || currentOperation.kind === 'sync') &&
          currentRoute!.desired_state !== 'active'))
    ) {
      return false;
    }
    if (step.kind === 'secret_retire' && current.staged_secret_generation !== null) {
      const target = outcome.retiredGeneration;
      if (typeof target !== 'number' || current.staged_secret_generation !== target) {
        return false;
      }
      const retired = await tx
        .update(emailZoneConnections)
        .set({
          staged_secret_generation: null,
          staged_secret_ciphertext: null,
          staged_secret_iv: null,
          staged_secret_key_version: null,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(emailZoneConnections.id, current.id),
            eq(emailZoneConnections.desired_generation, currentOperation.desired_generation),
            eq(emailZoneConnections.staged_secret_generation, target),
          ),
        )
        .returning({ id: emailZoneConnections.id });
      if (!retired.length) {
        return false;
      }
    }
    const updated = await tx
      .update(emailOperationSteps)
      .set({
        status: 'confirmed',
        outcome,
        failure_code: null,
        failure_detail: null,
        finished_at: sql`now()`,
      })
      .where(
        and(
          eq(emailOperationSteps.id, step.id),
          eq(emailOperationSteps.status, 'unknown'),
          eq(emailOperationSteps.attempt, step.attempt),
        ),
      )
      .returning({ id: emailOperationSteps.id });
    if (!updated.length) {
      return false;
    }
    if (!removalId && step.kind === 'inbound_probe') {
      await tx
        .update(emailZoneConnections)
        .set({ inbound_status: 'ready', inbound_reason: null, inbound_observed_at: sql`now()` })
        .where(eq(emailZoneConnections.id, connection.id));
      if (op.route_id) {
        await tx
          .update(emailDomainRoutes)
          .set({ inbound_status: 'ready', inbound_reason: null, inbound_observed_at: sql`now()` })
          .where(
            and(
              eq(emailDomainRoutes.id, op.route_id),
              eq(emailDomainRoutes.desired_state, 'active'),
            ),
          );
      }
    }
    if (!removalId && step.kind === 'sending_onboard' && op.route_id) {
      await tx
        .update(emailDomainRoutes)
        .set({ outbound_status: 'ready', outbound_reason: null, outbound_observed_at: sql`now()` })
        .where(eq(emailDomainRoutes.id, op.route_id));
    }
    if (step.kind === 'ingress_delete' && outcome.deleted === true && op.route_id) {
      await tx
        .update(emailZoneConnections)
        .set({ inbound_status: 'disabled', inbound_observed_at: sql`now()` })
        .where(eq(emailZoneConnections.id, connection.id));
      await forgetUnusedEmailCredential(tx, connection.id, op.route_id);
    }
    if (removalId) {
      await completeSupersededEmailOperation(tx, currentOperation, removalId);
    }
    await tx
      .update(emailOperations)
      .set({
        status: removalId ? 'completed' : 'pending',
        current_step: removalId ? null : currentOperation.current_step,
        failure_code: null,
        failure_detail: null,
        updated_at: sql`now()`,
      })
      .where(and(eq(emailOperations.id, operationId), eq(emailOperations.status, 'unknown')));
    return true;
  });
}

/** Serialized cache publication. Versioned values are immutable; the mutable
 * pointer is for display only and never authorizes mail. */
export async function flushEmailCacheOutbox(db: Db, kv: KVNamespace, limit = 25): Promise<number> {
  const rows = await db
    .select()
    .from(emailCacheOutbox)
    .where(isNull(emailCacheOutbox.published_at))
    .orderBy(emailCacheOutbox.created_at, emailCacheOutbox.id)
    .limit(limit);
  let count = 0;
  for (const row of rows) {
    const newest = (
      await db
        .select({ version: emailCacheOutbox.version })
        .from(emailCacheOutbox)
        .where(
          and(
            eq(emailCacheOutbox.resource_kind, row.resource_kind),
            eq(emailCacheOutbox.resource_id, row.resource_id),
          ),
        )
        .orderBy(sql`${emailCacheOutbox.version} DESC`)
        .limit(1)
    )[0];
    if (newest?.version === row.version) {
      const base = `email-cache:${row.resource_kind}:${row.resource_id}`;
      await kv.put(`${base}:v${row.version}`, JSON.stringify(row.payload));
      // This mutable pointer is never security authority. Out-of-order
      // publication may make display stale until a later refresh.
      await kv.put(`${base}:latest`, String(row.version));
    }
    await db
      .update(emailCacheOutbox)
      .set({ published_at: sql`now()` })
      .where(eq(emailCacheOutbox.id, row.id));
    count++;
  }
  return count;
}
