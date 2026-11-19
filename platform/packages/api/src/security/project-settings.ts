/**
 * Project-level security settings (spec §8.3, §16.2): the scan model and the monthly
 * cap. Both need `settings` and a platform with the capability on; the route checks
 * those. The rules for what may be picked live here.
 */
import {
  isSecurityModelId,
  isSecurityModelPriced,
  SECURITY_PROVIDER_NAMES,
  SECURITY_PROVIDER_NOTICE_VERSION,
  securityModelThirdPartyHost,
  securityProviderNotice,
} from '@void/platform/security-models';
import { eq, sql } from 'drizzle-orm';
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
import { MAX_CAP_CENTS, projectSecuritySettings, securityProjectEvents } from './schema.ts';

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
    assertSecurityProjectCapAllowed(
      input.cents,
      securityProjectCeiling(before, policy.budgets),
      input.slug,
    );
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
