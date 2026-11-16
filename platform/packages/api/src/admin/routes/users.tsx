import { Hono } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import {
  changeOperatorUserPlan,
  deleteOperatorUser,
  restoreOperatorUser,
  suspendOperatorUser,
} from '../../operator/tenant-service.ts';
import { renderFateDetailPage, renderFateListPage } from '../fate/render.ts';
import { renderOperationError } from '../operation-error.tsx';

const app = new Hono<ApiEnv>();
app.onError(renderOperationError);

app.get('/', (context) => renderFateListPage(context, 'users'));

app.get('/:id', (context) => renderFateDetailPage(context, 'userDetail'));

app.post('/:id/plan', async (context) => {
  const body = await context.req.parseBody();
  const userId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`users/${userId}/plan`, { plan: body.plan }),
    async () => {
      await changeOperatorUserPlan(context, userId, String(body.plan ?? ''));
      return { response: context.redirect(`/admin/users/${userId}`), succeeded: true };
    },
  );
});

app.post('/:id/suspend', async (context) => {
  const body = await context.req.parseBody();
  const userId = context.req.param('id');
  const reason = String(body.reason || 'admin_suspended');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`users/${userId}/suspend`, { reason }),
    async () => {
      await suspendOperatorUser(context, userId, reason);
      return { response: context.redirect(`/admin/users/${userId}`), succeeded: true };
    },
  );
});

app.post('/:id/unsuspend', async (context) => {
  const userId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`users/${userId}/restore`),
    async () => {
      await restoreOperatorUser(context, userId);
      return { response: context.redirect(`/admin/users/${userId}`), succeeded: true };
    },
  );
});

app.post('/:id/delete', async (context) => {
  const userId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`users/${userId}/delete`),
    async () => {
      await deleteOperatorUser(context, userId);
      return { response: context.redirect('/admin/users'), succeeded: true };
    },
  );
});

export default app;
