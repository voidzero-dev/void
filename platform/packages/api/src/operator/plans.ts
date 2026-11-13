import {
  createDefaultPlanCatalog,
  parseBuildInstanceType,
  parsePlanLimitsPatch,
  parsePlanName,
  parsePlatformPlanCatalog,
  parsePlatformPlanId,
  PLAN_LIMITS,
  type BuiltinPlanId,
  type PlatformPlanCatalog,
  type PlatformPlanDefinition,
  type PlatformPlanReconciliation,
} from '@void/platform/plans';
import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  freshPlanAiLoggingInputs,
  planAiLoggingChanges,
  previewPlanAiLoggingPublish,
  readPlanAiLoggingProgress,
  runPlanAiLoggingPublishPage,
  startPlanAiLoggingPublish,
  writePlanAiLoggingSettings,
  type PlanAiLoggingPublishProgress,
} from '../ai-logging-plans.ts';
import { parsePlanAiLoggingInput, type PlanAiLoggingSettings } from '../ai-logging-policy.ts';
import type { DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  initialPlanDefaultFor,
  lockPlanCatalog,
  readPlanCatalog,
  readPlanCatalogWithAccounts,
  writePlanCatalog,
} from '../plans.ts';
import { users } from '../schema.ts';
import { getCurrentBillingPeriodStart } from '../tiers.ts';
import { dryRun, OperatorError } from './common.ts';
import { reconcileOperatorUserPlan } from './tenant-service.ts';

export type PlanCatalogAction = 'add' | 'set' | 'archive' | 'remove' | 'default' | 'reset';
const RECONCILIATION_PAGE_SIZE = 25;
const PLAN_ROLLOUT_GRACE_MS = 15 * 60_000;

function assertPlanRolloutComplete(context: Context<ApiEnv>): void {
  if (context.env.PLATFORM_ENV !== 'production' && context.env.PLATFORM_ENV !== 'staging') {
    return;
  }
  const uploadedAt = Date.parse(context.env.VERSION_METADATA?.timestamp ?? '');
  const remainingMs = uploadedAt + PLAN_ROLLOUT_GRACE_MS - Date.now();
  if (!Number.isFinite(uploadedAt) || remainingMs > 0) {
    throw new OperatorError(
      503,
      'Plan changes are temporarily unavailable while the platform upgrade completes. Retry after the previous API version has drained.',
      'plan_rollout_pending',
      remainingMs > 0 ? { retryAfterSeconds: Math.ceil(remainingMs / 1000) } : undefined,
    );
  }
}

export function initialPlanDefault(context: Context<ApiEnv>): BuiltinPlanId {
  return initialPlanDefaultFor(context.env);
}

function invalidInput(error: unknown): never {
  throw new OperatorError(
    400,
    error instanceof Error ? error.message : 'Invalid plan configuration.',
    'invalid_plan_configuration',
  );
}

function revision(
  body: Record<string, unknown>,
  catalog: PlatformPlanCatalog,
  preview: boolean,
): void {
  const expected = body.expectedRevision;
  if (expected === undefined && preview) {
    return;
  }
  if (!Number.isSafeInteger(expected) || (expected as number) < 0) {
    throw new OperatorError(
      400,
      'expectedRevision must be the catalog revision from a fresh preview.',
      'invalid_argument',
    );
  }
  if (expected !== catalog.revision) {
    throw new OperatorError(
      409,
      'The plan catalog changed. Preview your change again.',
      'revision_conflict',
      { expectedRevision: expected, currentRevision: catalog.revision },
    );
  }
}

function requirePlan(catalog: PlatformPlanCatalog, id: string): PlatformPlanDefinition {
  const plan = catalog.plans.find((plan) => plan.id === id);
  if (!plan) {
    throw new OperatorError(404, 'Plan not found.', 'not_found');
  }
  return plan;
}

function planAiLoggingInput(body: Record<string, unknown>) {
  try {
    return parsePlanAiLoggingInput(body.aiLogging);
  } catch (error) {
    throw new OperatorError(400, (error as Error).message, 'invalid_argument');
  }
}

function applyPatch(
  plan: PlatformPlanDefinition,
  body: Record<string, unknown>,
): PlatformPlanDefinition {
  if (body.allowShortSlugs !== undefined && typeof body.allowShortSlugs !== 'boolean') {
    throw new OperatorError(400, 'allowShortSlugs must be a boolean.', 'invalid_argument');
  }
  // The AI logging default lives in its own setting (see `proposePlanAiLogging`);
  // here it is only checked, so a bad value fails before anything is saved.
  planAiLoggingInput(body);
  return {
    ...plan,
    ...(body.allowShortSlugs === undefined ? {} : { allowShortSlugs: body.allowShortSlugs }),
    ...(body.name === undefined ? {} : { name: parsePlanName(body.name) }),
    ...(body.limits === undefined
      ? {}
      : { limits: { ...plan.limits, ...parsePlanLimitsPatch(body.limits) } }),
    ...(body.buildInstanceType === undefined
      ? {}
      : { buildInstanceType: parseBuildInstanceType(body.buildInstanceType) }),
  };
}

function loweredLimitKeys(
  previous: PlatformPlanDefinition,
  next: PlatformPlanDefinition,
): Array<string> {
  return Object.entries(next.limits)
    .filter(([key, limit]) => {
      const old = previous.limits[key as keyof typeof previous.limits];
      return limit !== 0 && (old === 0 || limit < old);
    })
    .map(([key]) => key);
}

/** Build and validate a proposed catalog before either preview or database writes. */
export function proposePlanCatalog(
  catalog: PlatformPlanCatalog,
  action: PlanCatalogAction,
  id: string | undefined,
  body: Record<string, unknown>,
): {
  catalog: PlatformPlanCatalog;
  affectedPlanIds: Array<string>;
  removedPlanId?: string;
  replacementPlanId?: string;
  loweredLimits: Array<string>;
} {
  const plans = [...catalog.plans];
  let defaultPlanId = catalog.defaultPlanId;
  let affectedPlanIds: Array<string> = [];
  let removedPlanId: string | undefined;
  let replacementPlanId: string | undefined;
  let loweredLimits: Array<string> = [];
  const replace = (plan: PlatformPlanDefinition) => {
    const previous = requirePlan(catalog, plan.id);
    plans[plans.findIndex((entry) => entry.id === plan.id)] = plan;
    if (
      JSON.stringify(previous.limits) !== JSON.stringify(plan.limits) ||
      previous.buildInstanceType !== plan.buildInstanceType
    ) {
      affectedPlanIds = [plan.id];
      loweredLimits = loweredLimitKeys(previous, plan);
    }
  };
  if (action === 'add') {
    const planId = parsePlatformPlanId(body.id);
    if (plans.some((plan) => plan.id === planId)) {
      throw new OperatorError(409, 'A plan with this ID already exists.', 'plan_exists');
    }
    if (plans.length === 100) {
      throw new OperatorError(400, 'A platform can contain at most 100 plans.', 'plan_limit');
    }
    const source = requirePlan(catalog, parsePlatformPlanId(body.copyFrom));
    plans.push(
      applyPatch(
        {
          ...source,
          id: planId,
          name: parsePlanName(body.name),
          archived: false,
          limits: { ...source.limits },
        },
        body,
      ),
    );
  } else if (action === 'default') {
    defaultPlanId = parsePlatformPlanId(body.planId);
    if (requirePlan(catalog, defaultPlanId).archived) {
      throw new OperatorError(409, 'An archived plan cannot become the default.', 'plan_archived');
    }
  } else {
    if (!id) {
      throw new OperatorError(400, 'A plan ID is required.', 'invalid_argument');
    }
    const existing = requirePlan(catalog, id);
    if (action === 'set') {
      if (
        body.name === undefined &&
        body.limits === undefined &&
        body.buildInstanceType === undefined &&
        body.allowShortSlugs === undefined &&
        body.aiLogging === undefined
      ) {
        throw new OperatorError(
          400,
          'Set a name, limits, buildInstanceType, allowShortSlugs, or aiLogging.',
          'invalid_argument',
        );
      }
      replace(applyPatch(existing, body));
    } else if (action === 'reset') {
      if (!Object.hasOwn(PLAN_LIMITS, existing.id)) {
        throw new OperatorError(
          400,
          'Reset is available for built-in plans. Set explicit limits for a custom plan.',
          'custom_plan_reset',
        );
      }
      const original = requirePlan(createDefaultPlanCatalog(), existing.id);
      replace({
        ...existing,
        limits: { ...original.limits },
        buildInstanceType: original.buildInstanceType,
        allowShortSlugs: original.allowShortSlugs,
      });
    } else if (action === 'archive') {
      if (body.archived !== undefined && typeof body.archived !== 'boolean') {
        throw new OperatorError(400, 'archived must be a boolean.', 'invalid_argument');
      }
      const archived = body.archived !== false;
      if (archived && existing.id === defaultPlanId) {
        throw new OperatorError(
          409,
          'Choose another default plan before archiving this one.',
          'default_plan',
        );
      }
      plans[plans.findIndex((plan) => plan.id === existing.id)] = { ...existing, archived };
    } else if (action === 'remove') {
      removedPlanId = existing.id;
      if (body.replacementPlanId !== undefined) {
        replacementPlanId = parsePlatformPlanId(body.replacementPlanId);
        if (replacementPlanId === removedPlanId) {
          throw new OperatorError(
            400,
            'The replacement must be a different plan.',
            'invalid_argument',
          );
        }
        const replacement = requirePlan(catalog, replacementPlanId);
        if (replacement.archived) {
          throw new OperatorError(409, 'The replacement plan is archived.', 'plan_archived');
        }
        affectedPlanIds = [replacementPlanId];
        loweredLimits = loweredLimitKeys(existing, replacement);
      }
      if (existing.id === defaultPlanId) {
        if (!replacementPlanId) {
          throw new OperatorError(
            409,
            'Provide a replacement when removing the default plan.',
            'default_plan',
          );
        }
        defaultPlanId = replacementPlanId;
      }
      plans.splice(
        plans.findIndex((plan) => plan.id === existing.id),
        1,
      );
    }
  }
  const revision = catalog.revision + 1;
  const next = parsePlatformPlanCatalog({
    revision,
    defaultPlanId,
    plans,
    reconciliation: affectedPlanIds.length
      ? { revision, planIds: affectedPlanIds, cursor: null, complete: false }
      : null,
  });
  return { catalog: next, affectedPlanIds, removedPlanId, replacementPlanId, loweredLimits };
}

/**
 * Plan AI logging defaults after a catalog change. `add` copies the source plan's
 * default, `remove` drops the plan's entry, and `aiLogging` on `add`/`set` sets it
 * (`inherit` clears it; leaving it out keeps it).
 */
export function proposePlanAiLogging(
  modes: PlanAiLoggingSettings['modes'],
  action: PlanCatalogAction,
  id: string | undefined,
  body: Record<string, unknown>,
  removedPlanId: string | undefined,
): PlanAiLoggingSettings['modes'] {
  const input = planAiLoggingInput(body);
  if (input !== undefined && action !== 'add' && action !== 'set') {
    throw new OperatorError(
      400,
      'aiLogging can be set only when adding or editing a plan.',
      'invalid_argument',
    );
  }
  const next = { ...modes };
  const assign = (planId: string, mode: string | undefined) => {
    if (mode === undefined || mode === 'inherit') {
      delete next[planId];
    } else {
      next[planId] = mode as PlanAiLoggingSettings['modes'][string];
    }
  };
  if (action === 'add') {
    const planId = parsePlatformPlanId(body.id);
    assign(planId, input ?? modes[parsePlatformPlanId(body.copyFrom)]);
  } else if (action === 'set' && id && input !== undefined) {
    assign(id, input);
  } else if (removedPlanId) {
    delete next[removedPlanId];
  }
  return next;
}

async function accountCount(db: DbOrTx, planIds: Array<string>): Promise<number> {
  if (!planIds.length) {
    return 0;
  }
  const rows = await db.select({ total: count() }).from(users).where(inArray(users.plan, planIds));
  return rows[0]?.total ?? 0;
}

export async function getOperatorPlanCatalog(context: Context<ApiEnv>) {
  const db = context.get('db');
  const [listing, aiLogging] = await Promise.all([
    readPlanCatalogWithAccounts(db, initialPlanDefault(context)),
    readPlanAiLoggingProgress(db, initialPlanDefault(context)),
  ]);
  return { ...listing, aiLogging };
}

export async function mutateOperatorPlanCatalog(
  context: Context<ApiEnv>,
  action: PlanCatalogAction,
  id: string | undefined,
  body: Record<string, unknown>,
) {
  const preview = dryRun(body);
  if (!preview) {
    assertPlanRolloutComplete(context);
  }
  const result = await context.get('db').transaction(async (tx) => {
    await lockPlanCatalog(tx);
    // Read through a write, not a cacheable read: the catalog revision names the AI
    // logging publish run, and a cached revision would give two changes the same run.
    const { catalog: previous, settings: savedAiLogging } = await freshPlanAiLoggingInputs(
      tx,
      initialPlanDefault(context),
    );
    revision(body, previous, preview);
    if (previous.reconciliation && !previous.reconciliation.complete) {
      throw new OperatorError(
        409,
        'Finish the pending plan update with plans sync before changing the catalog.',
        'plan_reconciliation_pending',
        { reconciliation: previous.reconciliation },
      );
    }
    let proposal;
    try {
      proposal = proposePlanCatalog(previous, action, id, body);
    } catch (error) {
      if (error instanceof OperatorError) {
        throw error;
      }
      invalidInput(error);
    }
    const aiLoggingModes = proposePlanAiLogging(
      savedAiLogging.modes,
      action,
      id,
      body,
      proposal.removedPlanId,
    );
    const moved =
      proposal.removedPlanId && proposal.replacementPlanId
        ? { from: proposal.removedPlanId, to: proposal.replacementPlanId }
        : undefined;
    const aiLoggingChange = planAiLoggingChanges({
      before: previous,
      after: proposal.catalog,
      modesBefore: savedAiLogging.modes,
      modesAfter: aiLoggingModes,
      ...(moved ? { moved } : {}),
    });
    const knownBefore = new Set(previous.plans.map((plan) => plan.id));
    const aiLoggingPublish = startPlanAiLoggingPublish(
      savedAiLogging.publish,
      proposal.catalog.revision,
      aiLoggingChange,
      {
        ...(moved ? { moved } : {}),
        added: proposal.catalog.plans.map((plan) => plan.id).filter((id) => !knownBefore.has(id)),
      },
    );
    const affectedAccounts = await accountCount(
      tx,
      proposal.removedPlanId ? [proposal.removedPlanId] : proposal.affectedPlanIds,
    );
    if (proposal.removedPlanId && affectedAccounts && !proposal.replacementPlanId) {
      throw new OperatorError(
        409,
        'This plan has assigned accounts. Provide a replacement plan.',
        'plan_has_accounts',
        { affectedAccounts },
      );
    }
    const warnings =
      proposal.loweredLimits.length && affectedAccounts
        ? [
            `Lowering ${proposal.loweredLimits.join(', ')} rechecks ${affectedAccounts} accounts against their existing usage. Accounts already at a quota will be blocked by that quota.`,
          ]
        : [];
    const previousPlan = previous.plans.find((plan) => plan.id === id);
    const nextPlan = proposal.catalog.plans.find(
      (plan) => plan.id === (proposal.replacementPlanId ?? id),
    );
    if (
      affectedAccounts &&
      previousPlan?.limits.requestsPerMonth === 0 &&
      nextPlan &&
      nextPlan.limits.requestsPerMonth > 0
    ) {
      warnings.push(
        'Earlier platform versions did not record unlimited request totals in quota counters. Existing counters may omit pre-upgrade requests; request analytics remain available. This change does not backfill historical requests.',
      );
    }
    const outcome = {
      action: `plans.${action}`,
      target: id ?? String(body.id ?? 'platform'),
      catalog: proposal.catalog,
      affectedAccounts,
      loweredLimits: proposal.loweredLimits,
      warnings,
      aiLogging: { modes: aiLoggingModes, modesBefore: savedAiLogging.modes, ...aiLoggingChange },
      ...(proposal.removedPlanId
        ? {
            removedPlanId: proposal.removedPlanId,
            replacementPlanId: proposal.replacementPlanId ?? null,
          }
        : {}),
    };
    if (preview) {
      return {
        dryRun: true as const,
        expectedRevision: previous.revision,
        ...outcome,
        aiLoggingPublish: await previewPlanAiLoggingPublish(
          tx,
          aiLoggingPublish,
          proposal.catalog,
          moved,
        ),
      };
    }
    if (proposal.removedPlanId && proposal.replacementPlanId) {
      await tx
        .update(users)
        .set({ plan: proposal.replacementPlanId })
        .where(eq(users.plan, proposal.removedPlanId));
    }
    await writePlanCatalog(tx, proposal.catalog);
    const aiLoggingSettings: PlanAiLoggingSettings = {
      modes: aiLoggingModes,
      publish: aiLoggingPublish,
    };
    if (JSON.stringify(aiLoggingSettings) !== JSON.stringify(savedAiLogging)) {
      await writePlanAiLoggingSettings(tx, aiLoggingSettings);
    }
    return outcome;
  });
  if (preview) {
    const overLimitAccounts = result.loweredLimits.length
      ? await previewQuotaOverages(context, action, id, body, result.catalog)
      : [];
    return {
      ...result,
      overLimitAccounts,
      usageSampleSize: Math.min(result.affectedAccounts, RECONCILIATION_PAGE_SIZE),
    };
  }
  if (!result.catalog.reconciliation) {
    const aiLoggingPublish = await runPlanAiLoggingPublishPage(
      context.get('db'),
      context.env.ROUTING,
      initialPlanDefault(context),
    );
    return {
      ...result,
      reconciliation: { complete: true, processed: 0 },
      aiLoggingPublish,
      ok: !aiLoggingPublish.error,
    };
  }
  const synced = await syncOperatorPlanCatalog(context, {
    expectedRevision: result.catalog.revision,
  });
  return {
    ...result,
    catalog: synced.catalog,
    reconciliation: synced.reconciliation,
    aiLoggingPublish: synced.aiLoggingPublish,
    ok: syncSucceeded(synced),
  };
}

/** Read a bounded sample without initializing or resetting durable quota counters. */
async function previewQuotaOverages(
  context: Context<ApiEnv>,
  action: PlanCatalogAction,
  id: string | undefined,
  body: Record<string, unknown>,
  catalog: PlatformPlanCatalog,
): Promise<Array<{ id: string; login: string; reasons: Array<string> }>> {
  if (!id || !['set', 'reset', 'remove'].includes(action)) {
    return [];
  }
  const effectivePlanId = action === 'remove' ? String(body.replacementPlanId) : id;
  const plan = catalog.plans.find((plan) => plan.id === effectivePlanId);
  if (!plan) {
    return [];
  }
  const sample = await context
    .get('db')
    .select({ id: users.id, login: users.login, billingCycleStart: users.billing_cycle_start })
    .from(users)
    .where(eq(users.plan, id))
    .orderBy(asc(users.id))
    .limit(RECONCILIATION_PAGE_SIZE);
  const entries = await Promise.all(
    sample.map(async (account) => {
      try {
        const stub = context.env.USAGE_COUNTER.get(
          context.env.USAGE_COUNTER.idFromName(account.id),
        );
        const response = await stub.fetch(
          new Request('https://do/state', { signal: AbortSignal.timeout(5000) }),
        );
        if (!response.ok) {
          return null;
        }
        const state = (await response.json()) as {
          ownerUserId?: unknown;
          billingPeriodStart?: unknown;
          totalRequests?: unknown;
          totalNeurons?: unknown;
          totalSandboxSeconds?: unknown;
        };
        if (
          state.ownerUserId !== account.id ||
          typeof state.billingPeriodStart !== 'string' ||
          new Date(state.billingPeriodStart).getTime() !==
            getCurrentBillingPeriodStart(account.billingCycleStart).getTime()
        ) {
          return null;
        }
        const quotas = [
          ['requestsPerMonth', state.totalRequests],
          ['aiNeuronsPerMonth', state.totalNeurons],
          ['sandboxRuntimeSecondsPerMonth', state.totalSandboxSeconds],
        ] as const;
        const reasons = quotas.flatMap(([key, total]) => {
          const limit = plan.limits[key];
          return limit > 0 && typeof total === 'number' && Number.isFinite(total) && total >= limit
            ? [key]
            : [];
        });
        return reasons.length ? { id: account.id, login: account.login, reasons } : null;
      } catch {
        // The warning remains valid when a counter cannot be inspected; never report unknown usage as zero.
        return null;
      }
    }),
  );
  return entries.filter((entry) => entry !== null);
}

type PlanAccountsProgress = Readonly<{
  complete: boolean;
  processed: number;
  error?: PlatformPlanReconciliation['error'];
}>;

/** Whether a sync step finished without an account or AI logging error. */
export function syncSucceeded(
  result: Readonly<{
    reconciliation: PlanAccountsProgress;
    aiLoggingPublish: PlanAiLoggingPublishProgress;
  }>,
): boolean {
  return !result.reconciliation.error && !result.aiLoggingPublish.error;
}

/**
 * One step of a pending plan update: a page of account updates (limits) and a page
 * of the AI logging publish. Callers repeat it until both report complete.
 */
export async function syncOperatorPlanCatalog(
  context: Context<ApiEnv>,
  body: Record<string, unknown>,
) {
  if (!dryRun(body)) {
    assertPlanRolloutComplete(context);
  }
  const db = context.get('db');
  const catalog = await readPlanCatalog(db, initialPlanDefault(context));
  revision(body, catalog, dryRun(body));
  const operation = catalog.reconciliation;
  if (dryRun(body)) {
    const affectedAccounts =
      operation && !operation.complete ? await accountCount(db, [...operation.planIds]) : 0;
    const aiLogging = await readPlanAiLoggingProgress(db, initialPlanDefault(context));
    return {
      dryRun: true as const,
      action: 'plans.sync',
      target: 'platform',
      expectedRevision: catalog.revision,
      catalog,
      affectedAccounts,
      reconciliation: { complete: !operation || operation.complete, processed: 0 },
      aiLoggingPublish: {
        complete: !aiLogging.publish || aiLogging.publish.complete,
        processed: 0,
        remaining: aiLogging.remaining,
        expectedBy: null,
      },
    };
  }
  const accounts = await reconcilePlanAccountsPage(context, catalog);
  const aiLoggingPublish = await runPlanAiLoggingPublishPage(
    db,
    context.env.ROUTING,
    initialPlanDefault(context),
  );
  return { ...accounts, aiLoggingPublish };
}

/** Advance a durable keyset cursor. Retries reread usage and never reset an account. */
async function reconcilePlanAccountsPage(
  context: Context<ApiEnv>,
  catalog: PlatformPlanCatalog,
): Promise<Readonly<{ catalog: PlatformPlanCatalog; reconciliation: PlanAccountsProgress }>> {
  const db = context.get('db');
  const operation = catalog.reconciliation;
  if (!operation || operation.complete) {
    return { catalog, reconciliation: { complete: true, processed: 0 } };
  }
  const accounts = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.plan, [...operation.planIds]),
        operation.cursor ? gt(users.id, operation.cursor) : undefined,
      ),
    )
    .orderBy(asc(users.id))
    .limit(RECONCILIATION_PAGE_SIZE + 1);
  let processed = 0;
  let latest = catalog;
  for (const account of accounts.slice(0, RECONCILIATION_PAGE_SIZE)) {
    let failure: PlatformPlanReconciliation['error'];
    try {
      await reconcileOperatorUserPlan(context, account.id);
    } catch (error) {
      // Concurrent account deletion needs no publication. Other failures remain retryable.
      if (!(error instanceof OperatorError && error.status === 404)) {
        console.error('[plans] account reconciliation failed', account.id, error);
        failure = {
          accountId: account.id,
          message:
            'Account routing or quota reconciliation failed. Inspect platform logs and retry plans sync.',
        };
      }
    }
    latest = await db.transaction(async (tx) => {
      await lockPlanCatalog(tx);
      const current = await readPlanCatalog(tx, initialPlanDefault(context));
      if (
        current.revision !== catalog.revision ||
        !current.reconciliation ||
        current.reconciliation.complete
      ) {
        return current;
      }
      // Concurrent retries are idempotent; an older response cannot move the cursor backwards.
      if (current.reconciliation.cursor && current.reconciliation.cursor >= account.id) {
        return current;
      }
      const next = {
        ...current,
        reconciliation: {
          ...current.reconciliation,
          ...(failure ? { error: failure } : { cursor: account.id, error: undefined }),
        },
      };
      await writePlanCatalog(tx, next);
      return next;
    });
    if (
      failure &&
      latest.reconciliation?.error?.accountId === account.id &&
      !latest.reconciliation.complete
    ) {
      return { catalog: latest, reconciliation: { complete: false, processed, error: failure } };
    }
    processed++;
  }
  if (accounts.length <= RECONCILIATION_PAGE_SIZE) {
    latest = await db.transaction(async (tx) => {
      await lockPlanCatalog(tx);
      const current = await readPlanCatalog(tx, initialPlanDefault(context));
      if (
        current.revision !== catalog.revision ||
        !current.reconciliation ||
        current.reconciliation.complete
      ) {
        return current;
      }
      // The next call catches accounts assigned during this page; assignments publish their own state.
      const remaining = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            inArray(users.plan, [...current.reconciliation.planIds]),
            current.reconciliation.cursor ? gt(users.id, current.reconciliation.cursor) : undefined,
          ),
        )
        .limit(1);
      if (remaining.length) {
        return current;
      }
      const next = {
        ...current,
        reconciliation: { ...current.reconciliation, complete: true, error: undefined },
      };
      await writePlanCatalog(tx, next);
      return next;
    });
  }
  return {
    catalog: latest,
    reconciliation: { complete: latest.reconciliation?.complete ?? true, processed },
  };
}
