import { Hono } from 'hono';
import { isAiLoggingMode } from '../ai-logging-policy.ts';
import { readProjectAiLoggingStatus, setProjectAiLogging } from '../ai-logging.ts';
import type { ApiEnv } from '../env.ts';
import { initialPlanDefaultFor } from '../plans.ts';
import {
  allowOperatorSignup,
  getOperatorSignup,
  listOperatorInvitations,
  removeOperatorSignup,
  revokeOperatorInvitation,
  sendOperatorInvitations,
  setOperatorSignup,
} from './access-service.ts';
import { dryRun, OperatorError, pagination, readBody, stringField } from './common.ts';
import { normalizeOperatorProject } from './project-normalization.ts';
import {
  changeOperatorUserPlan,
  deleteOperatorProject,
  deleteOperatorUser,
  getOperatorProject,
  getOperatorUser,
  listOperatorProjects,
  listOperatorUsers,
  restoreOperatorUser,
  suspendOperatorUser,
  transferOperatorProjectOwner,
} from './tenant-service.ts';

export const tenantRoutes = new Hono<ApiEnv>();

function signupEntry(body: Record<string, unknown>) {
  const type = stringField(body, 'type');
  const note = stringField(body, 'note', { optional: true, maxLength: 1000 }) || undefined;
  return type === 'identity'
    ? {
        type,
        connectionId: stringField(body, 'connectionId', { maxLength: 64 }),
        subject: body.subject,
        ...(note ? { note } : {}),
      }
    : {
        type,
        pattern: stringField(body, 'pattern', { maxLength: 320 }),
        ...(note ? { note } : {}),
      };
}

tenantRoutes.get('/users', async (context) =>
  context.json(
    await listOperatorUsers(context.get('db'), pagination(context), context.req.query('search')),
  ),
);
tenantRoutes.get('/users/:id', async (context) =>
  context.json(await getOperatorUser(context, context.req.param('id'))),
);
tenantRoutes.post('/users/:id/plan', async (context) => {
  const body = await readBody(context);
  return context.json(
    await changeOperatorUserPlan(
      context,
      context.req.param('id'),
      stringField(body, 'plan'),
      dryRun(body),
    ),
  );
});
tenantRoutes.post('/users/:id/suspend', async (context) => {
  const body = await readBody(context);
  return context.json(
    await suspendOperatorUser(
      context,
      context.req.param('id'),
      stringField(body, 'reason', { optional: true, maxLength: 1000 }) || undefined,
      dryRun(body),
    ),
  );
});
tenantRoutes.post('/users/:id/restore', async (context) => {
  const body = await readBody(context);
  return context.json(await restoreOperatorUser(context, context.req.param('id'), dryRun(body)));
});
tenantRoutes.post('/users/:id/delete', async (context) => {
  const body = await readBody(context);
  return context.json(await deleteOperatorUser(context, context.req.param('id'), dryRun(body)));
});
tenantRoutes.get('/projects', async (context) =>
  context.json(
    await listOperatorProjects(
      context.get('db'),
      pagination(context),
      context.req.query('search'),
      context.req.query('user'),
    ),
  ),
);
tenantRoutes.get('/projects/:id', async (context) =>
  context.json(await getOperatorProject(context.get('db'), context.env, context.req.param('id'))),
);
tenantRoutes.get('/projects/:id/ai-logging', async (context) => {
  const status = await readProjectAiLoggingStatus(
    context.get('db'),
    context.env.ROUTING,
    context.req.param('id'),
    initialPlanDefaultFor(context.env),
  );
  if (!status) {
    throw new OperatorError(404, 'Project not found.');
  }
  return context.json(status);
});
// Writes never go through the Hyperdrive cache, and the publish reads its inputs in a
// write statement, so this route works whatever the database caching setup.
tenantRoutes.post('/projects/:id/ai-logging', async (context) => {
  const body = await readBody(context);
  const mode = body.mode;
  if (!isAiLoggingMode(mode)) {
    throw new OperatorError(
      400,
      'mode must be inherit, off, metadata, or full.',
      'invalid_argument',
    );
  }
  return context.json(
    await setProjectAiLogging(
      context.get('db'),
      context.env.ROUTING,
      context.req.param('id'),
      mode,
      {
        initialPlanDefault: initialPlanDefaultFor(context.env),
        dryRun: dryRun(body),
      },
    ),
  );
});
tenantRoutes.post('/projects/:id/normalize', async (context) => {
  const body = await readBody(context);
  return context.json(
    await normalizeOperatorProject(context, context.req.param('id'), dryRun(body), body.expected),
  );
});
tenantRoutes.post('/projects/:id/owner', async (context) => {
  const body = await readBody(context);
  return context.json(
    await transferOperatorProjectOwner(
      context,
      context.req.param('id'),
      stringField(body, 'userId'),
      dryRun(body),
    ),
  );
});
tenantRoutes.post('/projects/:id/delete', async (context) => {
  const body = await readBody(context);
  return context.json(await deleteOperatorProject(context, context.req.param('id'), dryRun(body)));
});
tenantRoutes.get('/signup', async (context) => context.json(await getOperatorSignup(context)));
for (const [action, enabled] of [
  ['restrict', true],
  ['open', false],
] as const) {
  tenantRoutes.post(`/signup/${action}`, async (context) => {
    const body = await readBody(context);
    return context.json(await setOperatorSignup(context, enabled, dryRun(body)));
  });
}
tenantRoutes.post('/signup/allow', async (context) => {
  const body = await readBody(context);
  return context.json(await allowOperatorSignup(context, [signupEntry(body)], dryRun(body)));
});
for (const action of ['remove', 'disallow'] as const) {
  tenantRoutes.post(`/signup/${action}`, async (context) => {
    const body = await readBody(context);
    return context.json(
      await removeOperatorSignup(context, signupEntry(body), dryRun(body), action),
    );
  });
}
tenantRoutes.get('/invitations', async (context) =>
  context.json(await listOperatorInvitations(context.get('db'), pagination(context))),
);
tenantRoutes.post('/invitations/send', async (context) => {
  const body = await readBody(context);
  if (!Array.isArray(body.emails) || body.emails.some((email) => typeof email !== 'string')) {
    throw new OperatorError(400, 'emails must be an array of strings.');
  }
  return context.json(
    await sendOperatorInvitations(context, body.emails as Array<string>, dryRun(body)),
  );
});
tenantRoutes.post('/invitations/:id/revoke', async (context) => {
  const body = await readBody(context);
  return context.json(
    await revokeOperatorInvitation(context, context.req.param('id'), dryRun(body)),
  );
});
