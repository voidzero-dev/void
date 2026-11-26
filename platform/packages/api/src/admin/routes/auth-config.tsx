import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { requireUncachedAuthenticationDatabase } from '../../auth/bootstrap.ts';
import {
  AuthenticationConfigurationError,
  importLegacyAuthentication,
} from '../../auth/configuration.ts';
import { createLoginTestLaunch } from '../../auth/login.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import {
  authenticationActor,
  changeAuthenticationConnection,
  configureAuthenticationAdmission,
  configureAuthenticationConnection,
} from '../../operator/auth-config.ts';
import { OperatorError } from '../../operator/common.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { renderFateListPage } from '../fate/render.ts';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
const HOME = '/admin/config/auth';
app.use('*', async (context, next) => {
  await next();
  // React pages return their own Response; set form-compatible privacy headers
  // on that final response, keeping callback paths and queries out of referrers.
  context.res.headers.set('Cache-Control', 'no-store');
  context.res.headers.set('Referrer-Policy', 'strict-origin');
});
app.onError((error, context) => {
  if (error instanceof OperatorError || error instanceof AuthenticationConfigurationError) {
    return renderAdminPage(
      context,
      'authError',
      'Authentication settings',
      {
        message: error.message,
        platformName: getPlatformDisplayName(context.env, context.req.url),
        username: context.get('user')?.login,
      },
      { status: error.status },
    );
  }
  throw error;
});

app.get('/', (context) => renderFateListPage(context, 'authSettings'));
app.get('/new', (context) => renderFateListPage(context, 'authNew'));
app.get('/connections/:id', (context) => renderFateListPage(context, 'authEdit'));
app.post('/initialize', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('config/auth/initialize'), async () => {
    requireUncachedAuthenticationDatabase(context.env);
    await importLegacyAuthentication(context.get('db'), context.env);
    deleteCookie(context, 'admin_token', { path: '/' });
    return { response: context.redirect('/admin/login'), succeeded: true };
  }),
);
app.post('/connections/:id/configure', async (context) => {
  const body = await context.req.parseBody();
  const revision = body.revision ? Number(body.revision) : null;
  const id = revision === null ? String(body.connectionId) : context.req.param('id');
  const action = `config/auth/connections/${id}/configure`;
  return executeAuditedMutation(context, operatorAuditIntent(action, { revision }), async () => {
    await configureAuthenticationConnection(context, id, {
      revision,
      configuration: {
        id,
        kind: String(body.kind),
        label: String(body.label),
        clientId: String(body.clientId),
        ...(body.issuer ? { issuer: String(body.issuer) } : {}),
        allowedDomains: String(body.domains ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        requiredGroups: String(body.groups ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      },
      ...(body.clientSecret ? { clientSecret: String(body.clientSecret) } : {}),
    });
    return { response: context.redirect(HOME), succeeded: true };
  });
});
app.post('/connections/:id/test', async (context) =>
  executeAuditedMutation(
    context,
    operatorAuditIntent(`config/auth/connections/${context.req.param('id')}/test`),
    async () => {
      const launch = await createLoginTestLaunch(
        context,
        authenticationActor(context),
        context.req.param('id'),
      );
      return { response: context.redirect(launch.url), succeeded: true };
    },
  ),
);
for (const action of ['enable', 'disable', 'link'] as const) {
  app.post(`/connections/:id/${action}`, async (context) => {
    const form = await context.req.parseBody();
    const body = {
      revision: Number(form.revision),
      ...(form.testId ? { testId: String(form.testId) } : {}),
    };
    return executeAuditedMutation(
      context,
      operatorAuditIntent(`config/auth/connections/${context.req.param('id')}/${action}`, body),
      async () => {
        await changeAuthenticationConnection(context, context.req.param('id'), action, body);
        return {
          response: context.redirect(
            action === 'link' && body.testId
              ? `${HOME}?test=${encodeURIComponent(body.testId)}`
              : HOME,
          ),
          succeeded: true,
        };
      },
    );
  });
}
app.post('/admission', async (context) => {
  const body = admissionFormBody(await context.req.parseBody({ all: true }));
  return executeAuditedMutation(
    context,
    operatorAuditIntent('config/auth/admission', body),
    async () => {
      await configureAuthenticationAdmission(context, body);
      return { response: context.redirect(HOME), succeeded: true };
    },
  );
});

export function admissionFormBody(form: Record<string, string | File | Array<string | File>>) {
  const connections = Array.isArray(form.connections)
    ? form.connections.map(String)
    : form.connections
      ? [String(form.connections)]
      : [];
  return {
    revision: Number(form.revision),
    admission: { mode: String(form.mode), connections, access: form.access === 'true' },
  };
}

export default app;
