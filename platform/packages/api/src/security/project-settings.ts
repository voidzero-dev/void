/**
 * Project security settings (spec §8.3, §16.2): the scan model and the monthly cap, with
 * the rules for what may be picked. The route checks `settings` and the capability.
 */
import { isRecord } from '@void/deploy-core';
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

export type SecurityModelRequest = Readonly<{
  /** `null` = use the installation default. */
  model: string | null;
  acceptProviderNoticeVersion: number | null;
}>;

export function parseSecurityModelRequest(body: unknown): SecurityModelRequest {
  if (!isRecord(body)) {
    throw SecurityApiError.invalid('Send a JSON body such as {"model":"@cf/zai-org/glm-5.3"}.');
  }
  if (!('model' in body) || (body.model !== null && typeof body.model !== 'string')) {
    throw SecurityApiError.invalid('model must be a model id, or null for the platform default.');
  }
  const accept = body.acceptProviderNoticeVersion;
  if (
    accept !== undefined &&
    accept !== null &&
    (typeof accept !== 'number' || !Number.isSafeInteger(accept))
  ) {
    throw SecurityApiError.invalid('acceptProviderNoticeVersion must be a whole number.');
  }
  return { model: body.model, acceptProviderNoticeVersion: accept ?? null };
}

export const SECURITY_HIGH_REFUSAL_BADGE = 'High refusal';

/**
 * Models badged "High refusal" (PRD §16): over 30% of the scans that ended in the last 30
 * days were refused, once at least 10 ended (fewer says nothing).
 */
export async function readSecurityHighRefusalModels(
  db: Db,
  now: number = Date.now(),
): Promise<ReadonlySet<string>> {
  const since = new Date(now - 30 * 24 * 60 * 60_000).toISOString();
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
  const models = new Set<string>();
  for (const row of rows) {
    if (row.model !== null && row.ended >= 10 && row.refused > row.ended * 0.3) {
      models.add(row.model);
    }
  }
  return models;
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

export type SecurityModelChoices = ReturnType<typeof securityProjectModelChoices>;

/**
 * What the page and dashboard model pickers list: the same rules `setProjectSecurityModel`
 * checks. `saved` is the project's own model (`null`: it follows the default), so a project
 * that named the default keeps that choice on save.
 */
function securityProjectModelChoices(
  policy: SecurityPolicy,
  saved: string | null,
  highRefusal: ReadonlySet<string>,
) {
  const choices = SECURITY_MODELS.flatMap((model) => {
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

/** The new own cap in cents; `null` clears it. */
export function parseSecurityBudgetRequest(body: unknown): number | null {
  if (!isRecord(body) || !('monthlyUsd' in body)) {
    throw SecurityApiError.invalid('Send a JSON body such as {"monthlyUsd":50}, or null to clear.');
  }
  return parseSecurityMonthlyUsd(body.monthlyUsd);
}

/** `monthlyUsd` in whole cents, $0 up to $1,000,000; `null` clears the cap. */
export function parseSecurityMonthlyUsd(usd: unknown): number | null {
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

/** `PUT /projects/:id/security/budget`: a project admin sets the project's own cap. */
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
  return writeSecurityProjectCap(db, { ...input, by: { role: input.role, slug: input.slug } });
}

/**
 * Sets a project's own cap (`by` a project admin, within the ceiling) or the ceiling (`by`
 * an installation admin), and writes a `cap_changed` event when it moves.
 */
export async function writeSecurityProjectCap(
  db: Db,
  input: Readonly<{
    projectId: string;
    userId: string;
    cents: number | null;
    by: Readonly<{ role: ProjectRole; slug: string }> | 'installation_admin';
  }>,
) {
  const policy = await readSecurityPolicyLenient(db);
  const admin = input.by === 'installation_admin' ? null : input.by;
  const caps = await db.transaction(async (tx) => {
    // The row is created first so the select below can lock it.
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
    if (admin) {
      assertSecurityProjectCapAllowed(input.cents, securityProjectCeiling(before, policy.budgets), {
        id: input.projectId,
        slug: admin.slug,
      });
    }
    const old = admin ? before.monthlyCapCents : before.capCeilingCents;
    if (old !== input.cents) {
      await tx
        .update(projectSecuritySettings)
        .set({
          ...(admin ? { monthly_cap_cents: input.cents } : { cap_ceiling_cents: input.cents }),
          cap_updated_by_user_id: input.userId,
          cap_updated_at: sql`now()`,
          updated_by_user_id: input.userId,
          updated_at: sql`now()`,
        })
        .where(eq(projectSecuritySettings.project_id, input.projectId));
      await tx.insert(securityProjectEvents).values({
        id: generateId('spe'),
        project_id: input.projectId,
        actor_kind: admin ? 'user' : 'installation_admin',
        actor_user_id: input.userId,
        actor_role: admin?.role ?? null,
        action: 'cap_changed',
        cap_kind: admin ? 'own' : 'ceiling',
        old_cents: old,
        new_cents: input.cents,
      });
    }
    return admin
      ? { ...before, monthlyCapCents: input.cents }
      : { ...before, capCeilingCents: input.cents };
  });
  return {
    ok: true as const,
    budget: await securityProjectBudgetView(db, input.projectId, policy, caps),
  };
}
