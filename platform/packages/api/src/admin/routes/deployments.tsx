import { Hono } from 'hono';
import { getDeployment } from '../../db.ts';
import { type ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  deploymentLogs,
  requestDeploymentCancellation,
} from '../../operator/deployment-operations.ts';
import { renderFateDetailPage, renderFateListPage } from '../fate/render.ts';

const app = new Hono<ApiEnv>();

app.get('/', (context) => renderFateListPage(context, 'deployments'));

app.get('/:id', (context) => renderFateDetailPage(context, 'deploymentDetail'));

app.post('/:id/cancel', async (context) => {
  const deploymentId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`deployments/${deploymentId}/cancel`),
    async () => {
      const deployment = await getDeployment(context.get('db'), deploymentId);
      if (!deployment) {
        return {
          response: context.html('<h1>Deployment not found</h1>', 404),
          succeeded: false,
        };
      }

      try {
        await requestDeploymentCancellation(context.get('db'), deployment.id);
      } catch (error) {
        if (error instanceof OperatorError) {
          return { response: context.text(error.message, error.status), succeeded: false };
        }
        throw error;
      }
      return {
        response: context.redirect(`/admin/deployments/${deployment.id}`),
        succeeded: true,
      };
    },
  );
});

// GET /deployments/:id/logs — shared historical log reader.
app.get('/:id/logs', async (context) => {
  try {
    return context.json(
      await deploymentLogs(context.get('db'), context.env, context.req.param('id'), {
        since: context.req.query('since'),
        limit: Number(context.req.query('limit') ?? 100),
        cursor: context.req.query('cursor'),
        order: 'newest-first',
      }),
    );
  } catch (error) {
    if (error instanceof OperatorError) {
      return context.json({ error: error.message }, error.status);
    }
    throw error;
  }
});

export default app;
