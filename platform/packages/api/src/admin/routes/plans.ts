import {
  PLAN_EDITABLE_LIMIT_KEYS,
  parsePlatformPlanId,
  type PlatformPlanCatalog,
} from '@void/platform/plans';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PlanAiLoggingPublishProgress } from '../../ai-logging-plans.ts';
import { isAiLoggingMode } from '../../ai-logging-policy.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError, readBody } from '../../operator/common.ts';
import {
  getOperatorPlanCatalog,
  mutateOperatorPlanCatalog,
  syncOperatorPlanCatalog,
  type PlanCatalogAction,
} from '../../operator/plans.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { renderFateListPage } from '../fate/render.ts';
import type { AdminPlanPreview, AdminPlanProgress } from '../plans.ts';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
app.use('*', bodyLimit({ maxSize: 32 * 1024 }));
app.use('*', async (context, next) => {
  await next();
  context.res.headers.set('Referrer-Policy', 'strict-origin');
  context.res.headers.set('Cache-Control', 'no-store');
});
app.onError((error, context) => {
  if (error instanceof OperatorError) {
    return renderAdminPage(
      context,
      'adminError',
      'Plans',
      {
        message: error.message,
        status: error.status,
        platformName: getPlatformDisplayName(context.env, context.req.url),
        username: context.get('user')?.login,
      },
      { status: error.status },
    );
  }
  throw error;
});

const actions: Array<PlanCatalogAction> = ['add', 'set', 'archive', 'remove', 'default', 'reset'];
function action(value: unknown): PlanCatalogAction {
  if (typeof value !== 'string' || !actions.includes(value as PlanCatalogAction)) {
    throw new OperatorError(400, 'Choose a supported plan action.');
  }
  return value as PlanCatalogAction;
}
function planId(value: unknown): string {
  try {
    return parsePlatformPlanId(value);
  } catch {
    throw new OperatorError(400, 'Choose a valid plan ID.');
  }
}

function progress(result: {
  catalog: PlatformPlanCatalog;
  reconciliation: { complete: boolean; processed: number; error?: { message: string } };
  aiLoggingPublish: PlanAiLoggingPublishProgress;
}): AdminPlanProgress {
  const { reconciliation, aiLoggingPublish } = result;
  return {
    revision: result.catalog.revision,
    complete: reconciliation.complete && aiLoggingPublish.complete,
    processed: reconciliation.processed + aiLoggingPublish.processed,
    accounts: reconciliation.processed,
    projects: aiLoggingPublish.processed,
    cursor: `${result.catalog.reconciliation?.cursor ?? ''}|${aiLoggingPublish.remaining}`,
    error: reconciliation.error?.message ?? aiLoggingPublish.error ?? null,
  };
}

const HOME = '/admin/config/plans';
function completedPlanUrl(revision: number, target?: string, removed = false) {
  const path = target ? `${HOME}/${encodeURIComponent(target)}/edit` : HOME;
  const notice = removed ? 'plan-removed' : target ? 'plan-saved' : 'plans-updated';
  return `${path}?notice=${notice}&revision=${revision}`;
}

function planProgressResponse(
  context: Context<ApiEnv>,
  state: AdminPlanProgress,
  returnTo: string,
  target?: string,
) {
  if (state.complete) {
    return context.redirect(returnTo, 303);
  }
  return renderAdminPage(context, 'planProgress', 'Updating accounts', {
    initial: state,
    returnTo,
    target,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  });
}

app.get('/', (context) => renderFateListPage(context, 'plans'));
app.get('/new', (context) => renderFateListPage(context, 'planEdit'));
app.get('/:id/edit', (context) => renderFateListPage(context, 'planEdit'));

app.post('/preview', async (context) => {
  const form = await context.req.parseBody();
  const selectedAction = action(form.action);
  const target = planId(form.id);
  const body: Record<string, unknown> = { expectedRevision: Number(form.revision) };
  if (selectedAction === 'add') {
    body.id = target;
    body.copyFrom = planId(form.copyFrom);
    body.name = form.name;
  } else if (selectedAction === 'set') {
    body.name = form.name;
    body.buildInstanceType = form.buildInstanceType;
    body.allowShortSlugs = form.allowShortSlugs === 'true';
    if (form.aiLogging !== undefined) {
      if (!isAiLoggingMode(form.aiLogging)) {
        throw new OperatorError(400, 'Choose a supported AI Gateway logging setting.');
      }
      // The form loads the default from a possibly cached read. Sending an untouched value could
      // undo a newer saved default, so only a changed selector becomes part of the change.
      if (form.aiLogging !== form.aiLoggingInitial) {
        body.aiLogging = form.aiLogging;
      }
    }
    body.limits = Object.fromEntries(
      PLAN_EDITABLE_LIMIT_KEYS.map((key) => {
        const value = form[key];
        if (typeof value !== 'string' || !/^\d+$/.test(value)) {
          throw new OperatorError(400, 'Enter a nonnegative whole number for every limit.');
        }
        return [key, Number(value)];
      }),
    );
  } else if (selectedAction === 'archive') {
    body.archived = form.archived !== 'false';
  } else if (selectedAction === 'remove' && form.replacementPlanId) {
    body.replacementPlanId = planId(form.replacementPlanId);
  } else if (selectedAction === 'default') {
    body.planId = target;
  }
  const { catalog: before } = await getOperatorPlanCatalog(context);
  const result = await mutateOperatorPlanCatalog(
    context,
    selectedAction,
    selectedAction === 'add' || selectedAction === 'default' ? undefined : target,
    { ...body, dryRun: true },
  );
  if (
    !('overLimitAccounts' in result) ||
    !('expectedRevision' in result) ||
    typeof result.expectedRevision !== 'number'
  ) {
    throw new Error('Plan preview is unavailable.');
  }
  const preview: AdminPlanPreview = {
    action: selectedAction,
    target,
    body,
    expectedRevision: result.expectedRevision,
    before,
    after: result.catalog,
    // The dry run reads the saved defaults under the catalog lock, so this matches what apply replaces.
    aiLoggingBefore: result.aiLogging.modesBefore,
    aiLoggingAfter: result.aiLogging.modes,
    affectedAccounts: result.affectedAccounts,
    warnings: result.warnings,
    overLimitAccounts: result.overLimitAccounts,
    usageSampleSize: result.usageSampleSize,
  };
  return renderAdminPage(context, 'planPreview', 'Review plan change', {
    preview,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  });
});

app.post('/apply', async (context) => {
  const form = await context.req.parseBody();
  const selectedAction = action(form.action);
  const target = planId(form.id);
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(String(form.body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error();
    }
    body = { ...value, expectedRevision: Number(form.revision), dryRun: false };
  } catch {
    throw new OperatorError(400, 'The plan review is invalid. Preview the change again.');
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent(
      `config/plans/${selectedAction === 'add' || selectedAction === 'default' ? selectedAction : `${target}/${selectedAction}`}`,
      body,
    ),
    async () => {
      const result = await mutateOperatorPlanCatalog(
        context,
        selectedAction,
        selectedAction === 'add' || selectedAction === 'default' ? undefined : target,
        body,
      );
      if (!('reconciliation' in result)) {
        throw new Error('Plan update is unavailable.');
      }
      const state = progress(result);
      const destination = selectedAction === 'remove' ? undefined : target;
      return {
        response: await planProgressResponse(
          context,
          state,
          completedPlanUrl(state.revision, destination, selectedAction === 'remove'),
          destination,
        ),
        succeeded: !state.error,
      };
    },
  );
});

app.post('/resume', async (context) => {
  const form = await context.req.parseBody();
  const target = form.id ? planId(form.id) : undefined;
  const body = { expectedRevision: Number(form.revision) };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('config/plans/sync', body),
    async () => {
      const result = await syncOperatorPlanCatalog(context, body);
      const state = progress(result);
      const destination = result.catalog.plans.some((plan) => plan.id === target)
        ? target
        : undefined;
      return {
        response: await planProgressResponse(
          context,
          state,
          completedPlanUrl(state.revision, destination),
          destination,
        ),
        succeeded: !state.error,
      };
    },
  );
});
app.post('/sync', async (context) => {
  const value = await readBody(context);
  const body = { expectedRevision: value.expectedRevision };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('config/plans/sync', body),
    async () => {
      const state = progress(await syncOperatorPlanCatalog(context, body));
      return { response: context.json(state), succeeded: !state.error };
    },
  );
});
export default app;
