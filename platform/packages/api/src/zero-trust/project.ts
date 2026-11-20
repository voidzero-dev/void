import type { Db } from '../db.ts';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { requireProjectCapability } from '../project-access.ts';
import type { projectZeroTrust } from '../schema.ts';
import { pokeSecurityScanScheduler } from '../security/enqueue.ts';
import {
  cancelOpenRequestForProtect,
  gateAsk,
  gateBypass,
  gateFlip,
  readGateState,
  readOpenPublicRequest,
  recordProtectionChange,
  type GateActor,
  type GateEffects,
  type GateRequestedVia,
  type GateStep,
  type PublicRequestRow,
} from '../security/public-gate.ts';
import type { Project, ProjectZeroTrust } from '../types.ts';
import { bypassPolicy, reusablePolicyReferences, ZeroTrustCloudflareClient } from './cloudflare.ts';
import {
  type ManagedAccessApplication,
  type ZeroTrustConfiguration,
  readZeroTrustConfigurationStrict,
} from './configuration.ts';
import { ZeroTrustUnavailableError } from './errors.ts';
import { withProjectZeroTrustLock, type RecordProjectErrors } from './lock.ts';
import {
  publishProjectZeroTrustRoutingLocked,
  requiredRoutingBudget,
  routingProtection,
  type RoutingBudget,
} from './routing.ts';
import {
  applicationName,
  clientForConfiguration,
  getProjectZeroTrustState,
  initialProjectProtection,
  projectApplicationReference,
  projectDestinations,
  projectZeroTrustAvailable,
  putProjectState,
  sameConfiguration,
  updateProjectState,
} from './state.ts';

/**
 * The operation a reconciled row completes. A public row is complete once its
 * bypass and routes are done, which the public-bypass phase already does. A
 * protected row depends on the wildcard audience, so it completes only after
 * the wildcard phase.
 */
function completedProjectOperation(
  configuration: ZeroTrustConfiguration,
  publicProject: boolean,
): string | null {
  const operation = configuration.operation;
  if (!operation || operation.kind === 'disable') {
    return null;
  }
  return operation.phase === 'projects' || (publicProject && operation.phase === 'public-bypasses')
    ? operation.id
    : null;
}

type ProjectReconciliationOptions = {
  /** Internal proof from the custom-hostname activation gate, never from request input. */
  verifiedDomainId?: string;
  /** Snapshot owned by an installation operation; it must still match under the lock. */
  configuration?: ZeroTrustConfiguration;
  client?: ZeroTrustCloudflareClient;
  desiredProtection?: boolean;
  routingBudget?: RoutingBudget;
  /** Recheck this user's `settings` capability under the project lock. */
  actorUserId?: string;
  /**
   * Use the configuration saved under the lock even while an installation
   * operation runs. Domain changes must not wait for the whole operation.
   */
  duringOperation?: boolean;
  /** Who asked, for a platform admin acting from the admin panel or the operator route. */
  requester?: Readonly<{ userId: string | null; via: Exclude<GateRequestedVia, 'project'> }>;
  /**
   * The public gate (spec §5.5). `ask`: a person turns protection off. `flip`: the gate's
   * own re-check of the open request (ingest, resolve, cutover, rollback, hourly).
   * `bypass`: skip the scan. Without it the gate is not consulted.
   */
  gate?:
    | Readonly<{ kind: 'ask' }>
    | Readonly<{ kind: 'flip'; requestId: string }>
    | Readonly<{
        kind: 'bypass';
        requestId: string | null;
        reason: string;
        actor: GateActor & { kind: 'user' | 'installation_admin'; userId: string };
      }>;
};

/** What a checkpoint committed. `held`: the request holds the project, the row is unchanged. */
export type CheckpointResult = Readonly<{
  row: ProjectZeroTrust;
  request: PublicRequestRow | null;
  held: boolean;
  poke: boolean;
  /** A bypass: what it skipped. */
  skipped: string | null;
}>;

function savedConfigurationAllows(
  saved: ZeroTrustConfiguration | null,
  options?: ProjectReconciliationOptions,
): saved is ZeroTrustConfiguration {
  return options?.duringOperation
    ? !!saved?.enabled && !!saved.wildcardApplication && saved.operation?.kind !== 'disable'
    : projectZeroTrustAvailable(saved);
}

async function checkpointProjectReconciliation(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options?: ProjectReconciliationOptions,
): Promise<CheckpointResult> {
  return withProjectZeroTrustLock(db, projectId, async (lockedDb) => {
    // The route precheck can go stale. Team and ownership changes share this
    // lock, so authorize again before committing the new intent. Platform
    // callers (operators, maintenance, domain hooks) have no actor here.
    const access = options?.actorUserId
      ? await requireProjectCapability(lockedDb, projectId, options.actorUserId, 'settings')
      : null;
    const project = await getProject(lockedDb, projectId);
    if (!project || project.status === 'deleting') {
      throw new ZeroTrustUnavailableError('Project is unavailable.');
    }
    const effects: GateEffects = { poke: false };
    let step: GateStep = { kind: 'open' };
    const held = async (request: PublicRequestRow | null): Promise<CheckpointResult> => ({
      row: (await getProjectZeroTrustState(lockedDb, projectId))!,
      request,
      held: true,
      poke: effects.poke,
      skipped: null,
    });
    const intent = options?.gate;
    if (intent?.kind === 'flip') {
      // Judge first: a hold is recorded even while Zero Trust is busy; only a pass
      // needs the checks below.
      const flip = await gateFlip(lockedDb, env, {
        projectId,
        requestId: intent.requestId,
        effects,
      });
      if (flip.kind === 'closed') {
        return held(null);
      }
      if (flip.kind === 'held') {
        return held(flip.request);
      }
      step = flip;
    }
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    const configuration = options?.configuration ?? saved;
    if (
      !configuration ||
      configuration.operation?.kind === 'disable' ||
      (options?.configuration && !sameConfiguration(configuration, saved)) ||
      (!options?.configuration && !savedConfigurationAllows(saved, options))
    ) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is not ready on this platform.');
    }
    const existing = await getProjectZeroTrustState(lockedDb, projectId);
    if (
      intent?.kind === 'ask' &&
      options?.desiredProtection === false &&
      existing?.desired_protected
    ) {
      const via = options.requester?.via ?? 'project';
      step = await gateAsk(lockedDb, env, {
        project,
        via,
        actor: options.requester
          ? { kind: 'installation_admin', userId: options.requester.userId, role: null }
          : { kind: 'user', userId: options.actorUserId ?? null, role: access?.role ?? null },
        effects,
      });
      if (step.kind === 'held') {
        return held(step.request);
      }
    }
    if (intent?.kind === 'bypass') {
      step = await gateBypass(lockedDb, env, {
        projectId,
        slug: project.slug,
        requestId: intent.requestId,
        reason: intent.reason,
        actor: intent.actor,
        effects,
      });
    }
    const desired =
      options?.desiredProtection ??
      existing?.desired_protected ??
      initialProjectProtection(configuration, project);
    if (desired && configuration.publicAccess) {
      throw new ZeroTrustUnavailableError(
        'Choose company identity providers and policies in Admin → Zero Trust before protecting a project.',
      );
    }
    const destinations = await projectDestinations(
      env,
      lockedDb,
      project,
      desired,
      options?.verifiedDomainId,
    );
    const values: Partial<typeof projectZeroTrust.$inferInsert> = {
      desired_protected: desired,
      status: 'reconciling',
      last_error: null,
      ...(existing?.desired_protected !== desired ? { routing_cursor: null } : {}),
    };
    if (!desired && !existing?.bypass_application_name) {
      values.bypass_application_name = await applicationName(env, `public-${project.id}`);
    }
    if (
      (desired || configuration.managePublicCustomDomains) &&
      destinations.custom.length > 0 &&
      !existing?.protected_application_name
    ) {
      values.protected_application_name = await applicationName(env, `protected-${project.id}`);
    }
    const row = await putProjectState(lockedDb, projectId, values);
    // An asked-for change only: a first reconcile that applies the initial protection is not one.
    if (
      options?.desiredProtection !== undefined &&
      (existing?.desired_protected ?? false) !== options.desiredProtection
    ) {
      await recordProtectionChange(lockedDb, {
        projectId,
        protectedNow: desired,
        actor: options?.requester
          ? { kind: 'installation_admin', userId: options.requester.userId, role: null }
          : options?.actorUserId
            ? { kind: 'user', userId: options.actorUserId, role: access?.role ?? null }
            : null,
      });
    }
    // The request closes in the transaction that writes `desired_protected = false`.
    const request = step.kind === 'go' ? await step.complete(lockedDb) : null;
    return {
      row,
      request,
      held: false,
      poke: effects.poke,
      skipped: step.kind === 'go' ? (step.skipped ?? null) : null,
    };
  });
}

/**
 * Public transition, under the project lock: ensure the bypass, publish every
 * route without enforcement, mark the project effectively public, then delete
 * its protected custom-domain application. It needs no wildcard application.
 */
async function reconcilePublicProjectLocked(
  env: ApiEnv['Bindings'],
  lockedDb: Db,
  project: Project,
  current: ProjectZeroTrust,
  platformDestinations: ReadonlyArray<string>,
  customDestinations: ReadonlyArray<string>,
  client: ZeroTrustCloudflareClient,
  configuration: ZeroTrustConfiguration,
  routingBudget?: RoutingBudget,
): Promise<ProjectZeroTrust> {
  if (!current.bypass_application_name) {
    throw new Error('The project public application checkpoint is missing.');
  }
  const bypass = await client.ensureApplication(
    {
      name: current.bypass_application_name,
      destinations: platformDestinations,
      policies: bypassPolicy('Void project is public'),
    },
    projectApplicationReference(current, 'bypass'),
  );
  await updateProjectState(lockedDb, project.id, {
    bypass_application_id: bypass.id,
    bypass_application_name: bypass.name,
  });
  let publicCustom: ManagedAccessApplication | null = null;
  if (configuration.managePublicCustomDomains && customDestinations.length) {
    if (!current.protected_application_name) {
      throw new Error('The custom-domain Access checkpoint is missing.');
    }
    publicCustom = await client.ensureApplication(
      {
        name: current.protected_application_name,
        destinations: customDestinations,
        policies: bypassPolicy('Void project is public'),
      },
      projectApplicationReference(current, 'protected'),
    );
    await updateProjectState(lockedDb, project.id, {
      protected_application_id: publicCustom.id,
      protected_application_name: publicCustom.name,
      protected_application_audience: publicCustom.audience,
    });
  }
  if (!(await publishProjectZeroTrustRoutingLocked(env, lockedDb, project, null, routingBudget))) {
    return (await getProjectZeroTrustState(lockedDb, project.id))!;
  }
  const row = await updateProjectState(lockedDb, project.id, { effective_protected: false });
  if (!publicCustom) {
    await client.deleteApplication(row.protected_application_id, row.protected_application_name);
  }
  return updateProjectState(lockedDb, project.id, {
    effective_protected: false,
    status: 'ready',
    reconciled_operation: completedProjectOperation(configuration, true),
    protected_application_id: publicCustom?.id ?? null,
    protected_application_name: publicCustom?.name ?? null,
    protected_application_audience: publicCustom?.audience ?? null,
    last_error: null,
  });
}

async function reconcileProjectZeroTrustLocked(
  env: ApiEnv['Bindings'],
  lockedDb: Db,
  projectId: string,
  recordErrors: RecordProjectErrors,
  options?: ProjectReconciliationOptions,
): Promise<ProjectZeroTrust> {
  const saved = await readZeroTrustConfigurationStrict(lockedDb);
  const configuration = options?.configuration ?? saved;
  if (
    !saved ||
    !configuration ||
    !saved.enabled ||
    !saved.wildcardApplication ||
    saved.operation?.kind === 'disable' ||
    (!options?.configuration && !savedConfigurationAllows(saved, options)) ||
    (options?.configuration && !sameConfiguration(configuration, saved))
  ) {
    throw new ZeroTrustUnavailableError('Project Zero Trust is not enabled on this platform.');
  }
  const project = await getProject(lockedDb, projectId);
  if (!project || project.status === 'deleting') {
    throw new ZeroTrustUnavailableError('Project is unavailable.');
  }
  const existing = await getProjectZeroTrustState(lockedDb, projectId);
  if (!existing) {
    throw new ZeroTrustUnavailableError('Project Zero Trust is still being initialized.');
  }
  const client = options?.client ?? (await clientForConfiguration(env, configuration));
  const destinations = await projectDestinations(
    env,
    lockedDb,
    project,
    existing.desired_protected,
    options?.verifiedDomainId,
  );

  return recordErrors(async () => {
    let row = existing;
    if (!row.desired_protected) {
      return reconcilePublicProjectLocked(
        env,
        lockedDb,
        project,
        row,
        destinations.platform,
        destinations.custom,
        client,
        configuration,
        options?.routingBudget,
      );
    }

    let protectedApplication: ManagedAccessApplication | null = null;
    if (destinations.custom.length > 0) {
      if (!row.protected_application_name) {
        throw new Error('The project protected application checkpoint is missing.');
      }
      protectedApplication = await client.ensureApplication(
        {
          name: row.protected_application_name,
          destinations: destinations.custom,
          allowedIdentityProviderIds: configuration.identityProviderIds,
          policies: reusablePolicyReferences(configuration.policyIds),
        },
        projectApplicationReference(row, 'protected'),
      );
      row = await updateProjectState(lockedDb, projectId, {
        protected_application_id: protectedApplication.id,
        protected_application_name: protectedApplication.name,
        protected_application_audience: protectedApplication.audience,
      });
    } else if (row.protected_application_id || row.protected_application_name) {
      await client.deleteApplication(row.protected_application_id, row.protected_application_name);
      row = await updateProjectState(lockedDb, projectId, {
        protected_application_id: null,
        protected_application_name: null,
        protected_application_audience: null,
      });
    }
    if (
      !(await publishProjectZeroTrustRoutingLocked(
        env,
        lockedDb,
        project,
        routingProtection(configuration, protectedApplication),
        options?.routingBudget,
      ))
    ) {
      // Unpublished keys still lack the audience set. Keep the public
      // exception and stay reconciling until every route carries it.
      return (await getProjectZeroTrustState(lockedDb, projectId))!;
    }
    row = await updateProjectState(lockedDb, projectId, { effective_protected: true });
    await client.deleteApplication(row.bypass_application_id, row.bypass_application_name);
    return updateProjectState(lockedDb, projectId, {
      effective_protected: true,
      status: 'ready',
      reconciled_operation: completedProjectOperation(configuration, false),
      bypass_application_id: null,
      bypass_application_name: null,
      last_error: null,
    });
  });
}

export type GatedReconciliation = Readonly<{
  row: ProjectZeroTrust;
  /** The public request this call stored, returned, closed or canceled. */
  publicRequest: PublicRequestRow | null;
  /** The request holds the project: the row is still protected and nothing was reconciled. */
  held: boolean;
  skipped: string | null;
}>;

/** Checkpoint, then reconcile; the gate (when `options.gate` is set) decides in the checkpoint. */
export async function reconcileProjectZeroTrustGated(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options?: ProjectReconciliationOptions,
): Promise<GatedReconciliation> {
  const checkpointed = await checkpointProjectReconciliation(env, db, projectId, options);
  if (checkpointed.poke) {
    await pokeSecurityScanScheduler(env);
  }
  const outcome = {
    publicRequest: checkpointed.request,
    held: checkpointed.held,
    skipped: checkpointed.skipped,
  };
  if (checkpointed.held) {
    return { row: checkpointed.row, ...outcome };
  }
  const budget = options?.routingBudget;
  if (budget && budget.remaining < requiredRoutingBudget(checkpointed.row)) {
    // The committed checkpoint keeps this project reconciling for the next batch.
    budget.exhausted = true;
    return { row: checkpointed.row, ...outcome };
  }
  const row = await withProjectZeroTrustLock(db, projectId, (lockedDb, recordErrors) =>
    reconcileProjectZeroTrustLocked(env, lockedDb, projectId, recordErrors, options),
  );
  return { row, ...outcome };
}

export async function reconcileProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options?: ProjectReconciliationOptions,
): Promise<ProjectZeroTrust> {
  return (await reconcileProjectZeroTrustGated(env, db, projectId, options)).row;
}

/**
 * `protect` with an open public request only cancels it: the row is still protected, so
 * there is nothing to reconcile, and it works during an installation operation. A
 * request is read with the strict policy reader (bad data: 503, fail closed).
 */
async function cancelPublicRequestForProtect(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options: Pick<ProjectReconciliationOptions, 'actorUserId' | 'requester'>,
): Promise<{ row: ProjectZeroTrust; request: PublicRequestRow } | null> {
  return withProjectZeroTrustLock(db, projectId, async (lockedDb) => {
    const access = options.actorUserId
      ? await requireProjectCapability(lockedDb, projectId, options.actorUserId, 'settings')
      : null;
    if (!(await readOpenPublicRequest(lockedDb, projectId))) {
      return null;
    }
    await readGateState(lockedDb, env);
    const row = await getProjectZeroTrustState(lockedDb, projectId);
    if (!row?.desired_protected) {
      return null;
    }
    const request = await cancelOpenRequestForProtect(
      lockedDb,
      projectId,
      options.requester
        ? { kind: 'installation_admin', userId: options.requester.userId, role: null }
        : { kind: 'user', userId: options.actorUserId ?? null, role: access?.role ?? null },
    );
    return request ? { row, request } : null;
  });
}

export async function setProjectZeroTrustProtection(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  protectedProject: boolean,
  options?: Pick<ProjectReconciliationOptions, 'actorUserId' | 'requester'>,
): Promise<GatedReconciliation> {
  if (protectedProject) {
    const canceled = await cancelPublicRequestForProtect(env, db, projectId, options ?? {});
    if (canceled) {
      return { row: canceled.row, publicRequest: canceled.request, held: true, skipped: null };
    }
  }
  return reconcileProjectZeroTrustGated(env, db, projectId, {
    desiredProtection: protectedProject,
    actorUserId: options?.actorUserId,
    requester: options?.requester,
    ...(protectedProject ? {} : { gate: { kind: 'ask' as const } }),
  });
}

async function ensureProjectBypassLocked(
  env: ApiEnv['Bindings'],
  lockedDb: Db,
  projectId: string,
  client: ZeroTrustCloudflareClient,
  status: 'ready' | 'reconciling',
): Promise<ProjectZeroTrust | null> {
  const project = await getProject(lockedDb, projectId);
  const row = await getProjectZeroTrustState(lockedDb, projectId);
  if (!project || project.status === 'deleting' || !row || row.desired_protected) {
    return null;
  }
  if (!row.bypass_application_name) {
    throw new Error('The project public application checkpoint is missing.');
  }
  const destinations = await projectDestinations(env, lockedDb, project, false);
  const bypass = await client.ensureApplication(
    {
      name: row.bypass_application_name,
      destinations: destinations.platform,
      policies: bypassPolicy('Void project is public'),
    },
    projectApplicationReference(row, 'bypass'),
  );
  return putProjectState(lockedDb, project.id, {
    bypass_application_id: bypass.id,
    bypass_application_name: bypass.name,
    desired_protected: false,
    effective_protected: false,
    status,
    last_error: null,
  });
}

/**
 * Public-bypass phase: finish one public project before the wildcard changes.
 * The row then counts as done for this operation, so the projects phase does
 * not repeat its Access and routing writes.
 */
export async function reconcilePublicProjectForOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  configuration: ZeroTrustConfiguration,
  client: ZeroTrustCloudflareClient,
  routingBudget: RoutingBudget,
): Promise<ProjectZeroTrust> {
  await checkpointProjectReconciliation(env, db, projectId, { configuration });
  return withProjectZeroTrustLock(db, projectId, async (lockedDb, recordErrors) => {
    if (!sameConfiguration(configuration, await readZeroTrustConfigurationStrict(lockedDb))) {
      throw new ZeroTrustUnavailableError('The Zero Trust operation was replaced.');
    }
    const project = await getProject(lockedDb, projectId);
    const row = await getProjectZeroTrustState(lockedDb, projectId);
    if (!project || project.status === 'deleting' || !row) {
      throw new ZeroTrustUnavailableError('Project is unavailable.');
    }
    if (row.desired_protected) {
      return row;
    }
    return recordErrors(async () => {
      const destinations = await projectDestinations(env, lockedDb, project, false);
      return reconcilePublicProjectLocked(
        env,
        lockedDb,
        project,
        row,
        destinations.platform,
        destinations.custom,
        client,
        configuration,
        routingBudget,
      );
    });
  });
}

/** A running configure operation may start before the project exists or be seeded later. */
function initializesProjectZeroTrust(configuration: ZeroTrustConfiguration | null): boolean {
  return (
    !!configuration &&
    configuration.operation?.kind !== 'disable' &&
    (configuration.enabled || configuration.operation?.kind === 'configure')
  );
}

export async function initializeNewProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
): Promise<ProjectZeroTrust | null> {
  if (!initializesProjectZeroTrust(await readZeroTrustConfigurationStrict(db))) {
    return null;
  }
  // Operation heartbeats advance the saved revision. Decide from the
  // configuration read under the lock, never from the unlocked snapshot above.
  const initialized = await withProjectZeroTrustLock(db, projectId, async (lockedDb) => {
    const project = await getProject(lockedDb, projectId);
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (!project || project.status === 'deleting') {
      throw new ZeroTrustUnavailableError('Project is unavailable.');
    }
    if (!saved || !initializesProjectZeroTrust(saved)) {
      return null;
    }
    // Project creation commits before this initializer runs. A platform batch
    // may already have seeded or reconciled it, including its ownership handles.
    const existing = await getProjectZeroTrustState(lockedDb, projectId);
    if (existing) {
      return { row: existing, created: false };
    }
    const desired = initialProjectProtection(saved, project);
    // A new protected project has no route or custom domain yet, so the
    // wildcard alone settles it when no operation is running.
    const settled = desired && !!saved.wildcardApplication && !saved.operation;
    return {
      row: await putProjectState(lockedDb, projectId, {
        desired_protected: desired,
        effective_protected: settled,
        status: settled ? 'ready' : 'reconciling',
        ...(!desired
          ? { bypass_application_name: await applicationName(env, `public-${project.id}`) }
          : {}),
      }),
      created: true,
    };
  });
  if (!initialized) {
    return null;
  }
  const { row } = initialized;
  if (!initialized.created || row.desired_protected) {
    return row;
  }
  return withProjectZeroTrustLock(db, projectId, async (lockedDb, recordErrors) => {
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (!saved || !initializesProjectZeroTrust(saved)) {
      throw new ZeroTrustUnavailableError('Project Zero Trust configuration changed.');
    }
    // A running operation still owns this row; its batch finishes the transition.
    return recordErrors(async () =>
      ensureProjectBypassLocked(
        env,
        lockedDb,
        projectId,
        await clientForConfiguration(env, saved),
        saved.operation ? 'reconciling' : 'ready',
      ),
    );
  });
}

export async function cleanupProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
): Promise<void> {
  const [configuration, row] = await Promise.all([
    readZeroTrustConfigurationStrict(db),
    getProjectZeroTrustState(db, projectId),
  ]);
  if (
    !row ||
    (!row.bypass_application_id &&
      !row.bypass_application_name &&
      !row.protected_application_id &&
      !row.protected_application_name)
  ) {
    return;
  }
  if (!configuration) {
    throw new ZeroTrustUnavailableError(
      'Zero Trust configuration is unavailable; managed Access applications cannot be safely deleted.',
    );
  }
  const client = await clientForConfiguration(env, configuration);
  await client.deleteApplication(row.bypass_application_id, row.bypass_application_name);
  await client.deleteApplication(row.protected_application_id, row.protected_application_name);
}

export async function reconcileProjectZeroTrustDomains(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  options?: { verifiedDomainId: string },
): Promise<ProjectZeroTrust | null> {
  const [configuration, row] = await Promise.all([
    readZeroTrustConfigurationStrict(db),
    getProjectZeroTrustState(db, projectId),
  ]);
  if (!configuration?.enabled || configuration.operation?.kind === 'disable' || !row) {
    return row;
  }
  // Operation heartbeats advance the saved revision, so this unlocked read
  // only filters. Reconciliation uses the configuration saved under the lock.
  return reconcileProjectZeroTrust(env, db, projectId, {
    duringOperation: true,
    verifiedDomainId: options?.verifiedDomainId,
  });
}
