/**
 * Project-level security settings (spec §8.3, §16.2): the scan model and the monthly
 * cap. Both need `settings` and a platform with the capability on; the route checks
 * those. The rules for what may be picked live here.
 */
import {
  isSecurityModelId,
  isSecurityModelPriced,
  SECURITY_MODELS,
  SECURITY_PROVIDER_NAMES,
  SECURITY_PROVIDER_NOTICE_VERSION,
  securityModelBadges,
  securityModelThirdPartyHost,
  securityProviderNotice,
} from '@void/platform/security-models';
import type { SecurityModelId } from '@void/platform/security-models';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { generateId } from '../id.ts';
import type { ProjectRole } from '../types.ts';
import {
  assertSecurityProjectCapAllowed,
  securityProjectCeiling,
  securityUsdToCents,
} from './budget.ts';
import { SecurityApiError } from './errors.ts';
import { readSecurityPlanCapCell, securityProjectPlanCapSql } from './plan-caps.ts';
import { readSecurityPolicyLenient } from './policy.ts';
import {
  securityProjectBudgetView,
  securityProjectModelView,
  readSecurityProjectSettings,
} from './project-view.ts';
import {
  MAX_CAP_CENTS,
  projectSecuritySettings,
  securityProjectEvents,
  securityScans,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type SecurityModelRequest = Readonly<{
  /** `null` = use the installation default. */
  model: string | null;
  acceptProviderNoticeVersion: number | null;
}>;

export function parseSecurityModelRequest(body: unknown): SecurityModelRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw SecurityApiError.invalid('Send a JSON body such as {"model":"@cf/zai-org/glm-5.3"}.');
  }
  const record = body as Record<string, unknown>;
  if (!('model' in record) || (record.model !== null && typeof record.model !== 'string')) {
    throw SecurityApiError.invalid('model must be a model id, or null for the platform default.');
  }
  const accept = record.acceptProviderNoticeVersion;
  if (
    accept !== undefined &&
    accept !== null &&
    (typeof accept !== 'number' || !Number.isSafeInteger(accept))
  ) {
    throw SecurityApiError.invalid('acceptProviderNoticeVersion must be a whole number.');
  }
  return { model: record.model, acceptProviderNoticeVersion: accept ?? null };
}

// ---------------------------------------------------------------------------
// Refusal rate (PRD §16: "high refusal" badge above 30%)
// ---------------------------------------------------------------------------

/** A model is badged "High refusal" above this share of refused scans… */
export const SECURITY_HIGH_REFUSAL_RATE = 0.3;
/** …over the scans that ended in these many days… */
export const SECURITY_HIGH_REFUSAL_DAYS = 30;
/** …once at least this many ended (fewer says nothing). */
export const SECURITY_HIGH_REFUSAL_MIN_SCANS = 10;
export const SECURITY_HIGH_REFUSAL_BADGE = 'High refusal';

/** Models whose scans of the last 30 days were refused more than 30% of the time. */
export async function readSecurityHighRefusalModels(
  db: Db,
  now: number = Date.now(),
): Promise<ReadonlySet<string>> {
  const since = new Date(now - SECURITY_HIGH_REFUSAL_DAYS * 24 * 60 * 60_000).toISOString();
  const rows = await db
    .select({
      model: securityScans.model_used,
      ended: sql<number>`count(*)::int`,
      refused: sql<number>`count(*) FILTER (WHERE ${securityScans.status} = 'refused')::int`,
    })
    .from(securityScans)
    .where(
      and(
        isNotNull(securityScans.model_used),
        gte(securityScans.finished_at, since),
        inArray(securityScans.status, [
          'succeeded',
          'refused',
          'failed',
          'timed_out',
          'incomplete',
        ]),
      ),
    )
    .groupBy(securityScans.model_used);
  return new Set(
    rows
      .filter(
        (row) =>
          row.model !== null &&
          row.ended >= SECURITY_HIGH_REFUSAL_MIN_SCANS &&
          row.refused > row.ended * SECURITY_HIGH_REFUSAL_RATE,
      )
      .map((row) => row.model!),
  );
}

/** The picker badges of a model, with "High refusal" when its measured rate is high. */
export function securityPickerBadges(
  id: SecurityModelId,
  highRefusal: ReadonlySet<string>,
): Array<string> {
  const badges = [...securityModelBadges(id)];
  if (highRefusal.has(id)) {
    badges.push(SECURITY_HIGH_REFUSAL_BADGE);
  }
  return badges;
}

/** One model a project admin may pick now: the same rules `setProjectSecurityModel` checks. */
export type SecurityModelChoice = Readonly<{
  id: SecurityModelId;
  provider: string;
  thirdParty: boolean;
  badges: ReadonlyArray<string>;
  /** The provider notice to read before a third-party model is used; `null` for `@cf/*`. */
  notice: ReadonlyArray<string> | null;
}>;

export type SecurityModelChoices = Readonly<{
  defaultModel: SecurityModelId;
  /**
   * The project's saved model, `null` when it follows the platform default. The picker
   * selects this, so a project that named the default model keeps that choice on save.
   */
  saved: string | null;
  /** The platform default's provider notice when it is a third-party model, else `null`. */
  defaultNotice: Readonly<{ provider: string; notice: ReadonlyArray<string> }> | null;
  /** The notice version a form sends back when its box is ticked. */
  noticeVersion: number;
  choices: ReadonlyArray<SecurityModelChoice>;
}>;

/** The page and dashboard model pickers list these; anything else would be refused. */
export function securityProjectModelChoices(
  policy: SecurityPolicy,
  saved: string | null,
  highRefusal: ReadonlySet<string> = new Set(),
): SecurityModelChoices {
  const choices = SECURITY_MODELS.flatMap((model): Array<SecurityModelChoice> => {
    if (!isSecurityModelPriced(model.id) || policy.blockedModels.includes(model.id)) {
      return [];
    }
    const host = securityModelThirdPartyHost(model.id);
    if (host && !policy.entitlement?.hosts[host]) {
      return [];
    }
    return [
      {
        id: model.id,
        provider: SECURITY_PROVIDER_NAMES[model.host],
        thirdParty: host !== null,
        badges: securityPickerBadges(model.id, highRefusal),
        notice: host ? securityProviderNotice(host) : null,
      },
    ];
  });
  const defaultHost = securityModelThirdPartyHost(policy.defaultModel);
  return {
    defaultModel: policy.defaultModel,
    saved,
    defaultNotice: defaultHost
      ? {
          provider: SECURITY_PROVIDER_NAMES[defaultHost],
          notice: securityProviderNotice(defaultHost),
        }
      : null,
    noticeVersion: SECURITY_PROVIDER_NOTICE_VERSION,
    choices,
  };
}

/** `securityProjectModelChoices` for one project, with its saved model. */
export async function readSecurityProjectModelChoices(
  db: Db,
  projectId: string,
  policy?: SecurityPolicy,
): Promise<SecurityModelChoices> {
  const [current, [row], highRefusal] = await Promise.all([
    policy ?? readSecurityPolicyLenient(db),
    db
      .select({ model: projectSecuritySettings.model })
      .from(projectSecuritySettings)
      .where(eq(projectSecuritySettings.project_id, projectId)),
    readSecurityHighRefusalModels(db),
  ]);
  return securityProjectModelChoices(current, row?.model ?? null, highRefusal);
}

/** `PUT /projects/:id/security/model`. */
export async function setProjectSecurityModel(
  db: Db,
  input: Readonly<{ projectId: string; userId: string; request: SecurityModelRequest }>,
) {
  const policy = await readSecurityPolicyLenient(db);
  const settings = await readSecurityProjectSettings(db, input.projectId);
  const { model, acceptProviderNoticeVersion: accept } = input.request;
  if (model !== null) {
    if (!isSecurityModelId(model)) {
      throw SecurityApiError.of('modelNotAllowed', `${model} is not a security audit model.`, {
        model,
      });
    }
    if (policy.blockedModels.includes(model)) {
      throw SecurityApiError.of(
        'modelNotAllowed',
        `${model} is blocked by your platform admin. Pick another model.`,
        { model },
      );
    }
    if (!isSecurityModelPriced(model)) {
      throw SecurityApiError.of(
        'modelNotAllowed',
        `${model} has no list price yet, so its scans cannot be metered. Pick another model.`,
        { model },
      );
    }
  }
  const target = model ?? policy.defaultModel;
  const host = securityModelThirdPartyHost(target);
  let acceptNotice = false;
  if (host) {
    if (accept !== null && accept !== SECURITY_PROVIDER_NOTICE_VERSION) {
      throw SecurityApiError.of(
        'providerNoticeNotAccepted',
        `The provider notice changed. Read the current notice, then accept version ${SECURITY_PROVIDER_NOTICE_VERSION}.`,
        {
          model: target,
          version: SECURITY_PROVIDER_NOTICE_VERSION,
          notice: securityProviderNotice(host),
        },
      );
    }
    acceptNotice = accept === SECURITY_PROVIDER_NOTICE_VERSION;
    if (model !== null) {
      // Code must not leave Cloudflare for a host the last probe did not find ready.
      if (!policy.entitlement?.hosts[host]) {
        throw SecurityApiError.of(
          'modelNotAllowed',
          `${host}/* models cannot be picked: they are not ready on this platform (AI Gateway credits or the scanner image). Ask your platform admin.`,
          { model, host },
        );
      }
      if (!acceptNotice && settings.noticeVersion !== SECURITY_PROVIDER_NOTICE_VERSION) {
        throw SecurityApiError.of(
          'providerNoticeNotAccepted',
          `${model} is run by ${SECURITY_PROVIDER_NAMES[host]}, not by Cloudflare. Read the provider notice, then accept it: void project security model ${model} --accept-provider-notice`,
          {
            model,
            version: SECURITY_PROVIDER_NOTICE_VERSION,
            notice: securityProviderNotice(host),
          },
        );
      }
    }
  }
  const noticeSet = acceptNotice
    ? {
        provider_notice_version: SECURITY_PROVIDER_NOTICE_VERSION,
        provider_notice_by_user_id: input.userId,
        provider_notice_at: sql`now()`,
      }
    : {};
  // No lock: a policy change between the read above and this write is caught at scan time
  // (source: fallback), so a stale-valid model never runs.
  await db
    .insert(projectSecuritySettings)
    .values({
      project_id: input.projectId,
      model,
      ...noticeSet,
      updated_by_user_id: input.userId,
    })
    .onConflictDoUpdate({
      target: projectSecuritySettings.project_id,
      set: { model, ...noticeSet, updated_by_user_id: input.userId, updated_at: sql`now()` },
    });
  const next = await readSecurityProjectSettings(db, input.projectId);
  return { ok: true as const, model: securityProjectModelView(policy, next) };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** The new own cap in cents; `null` clears it. Whole cents, $0 up to $1,000,000. */
export function parseSecurityBudgetRequest(body: unknown): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('monthlyUsd' in body)) {
    throw SecurityApiError.invalid('Send a JSON body such as {"monthlyUsd":50}, or null to clear.');
  }
  const usd = (body as { monthlyUsd: unknown }).monthlyUsd;
  if (usd === null) {
    return null;
  }
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
    throw SecurityApiError.invalid('monthlyUsd must be a dollar amount of 0 or more, or null.');
  }
  const cents = securityUsdToCents(usd);
  if (Math.abs(usd * 100 - cents) > 1e-6 || cents > MAX_CAP_CENTS) {
    throw SecurityApiError.invalid(
      `monthlyUsd must be whole cents, at most ${MAX_CAP_CENTS / 100}.`,
    );
  }
  return cents;
}

/** `PUT /projects/:id/security/budget`. Writes a `cap_changed` event when the cap moves. */
export async function setProjectSecurityBudget(
  db: Db,
  input: Readonly<{
    projectId: string;
    slug: string;
    userId: string;
    role: ProjectRole;
    cents: number | null;
  }>,
) {
  const policy = await readSecurityPolicyLenient(db);
  const caps = await db.transaction(async (tx) => {
    // The row is created first so the update below can lock it.
    await tx
      .insert(projectSecuritySettings)
      .values({ project_id: input.projectId })
      .onConflictDoNothing();
    const [current] = await tx
      .select({
        monthlyCapCents: projectSecuritySettings.monthly_cap_cents,
        capCeilingCents: projectSecuritySettings.cap_ceiling_cents,
        planCap: securityProjectPlanCapSql(projectSecuritySettings.project_id),
      })
      .from(projectSecuritySettings)
      .where(eq(projectSecuritySettings.project_id, input.projectId))
      .for('update');
    const before = {
      monthlyCapCents: current?.monthlyCapCents ?? null,
      capCeilingCents: current?.capCeilingCents ?? null,
      planCap: readSecurityPlanCapCell(current?.planCap),
    };
    assertSecurityProjectCapAllowed(input.cents, securityProjectCeiling(before, policy.budgets), {
      id: input.projectId,
      slug: input.slug,
    });
    if (before.monthlyCapCents !== input.cents) {
      await tx
        .update(projectSecuritySettings)
        .set({
          monthly_cap_cents: input.cents,
          cap_updated_by_user_id: input.userId,
          cap_updated_at: sql`now()`,
          updated_by_user_id: input.userId,
          updated_at: sql`now()`,
        })
        .where(eq(projectSecuritySettings.project_id, input.projectId));
      await tx.insert(securityProjectEvents).values({
        id: generateId('spe'),
        project_id: input.projectId,
        actor_kind: 'user',
        actor_user_id: input.userId,
        actor_role: input.role,
        action: 'cap_changed',
        cap_kind: 'own',
        old_cents: before.monthlyCapCents,
        new_cents: input.cents,
      });
    }
    return {
      monthlyCapCents: input.cents,
      capCeilingCents: before.capCeilingCents,
      planCap: before.planCap,
    };
  });
  return {
    ok: true as const,
    budget: await securityProjectBudgetView(db, input.projectId, policy, caps),
  };
}
