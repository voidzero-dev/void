import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AuthenticationConfigurationError } from '../auth/configuration.ts';
import type { ApiEnv } from '../env.ts';
import { operatorAudit, operatorAuditRoutes } from './audit.ts';
import { authenticationConfigRoutes } from './auth-config.ts';
import { authenticatedSessionRoutes, operatorAuth, operatorSessionRoutes } from './auth.ts';
import { OperatorError } from './common.ts';
import { emailOperatorRoutes } from './email-routes.ts';
import { operationsRoutes } from './operations-routes.ts';
import { planOperatorRoutes } from './plans-routes.ts';
import { securityOperatorRoutes } from './security-routes.ts';
import { tenantRoutes } from './tenant-routes.ts';
import { zeroTrustOperatorRoutes } from './zero-trust-routes.ts';

export const operatorApi = new Hono<ApiEnv>();
operatorApi.onError((error, context) => {
  if (error instanceof AuthenticationConfigurationError) {
    return context.json(
      { error: error.code, message: error.message },
      error.status as ContentfulStatusCode,
    );
  }
  if (error instanceof OperatorError) {
    return context.json(
      {
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status,
    );
  }
  console.error('[operator] request failed', error);
  return context.json(
    {
      error: 'internal_error',
      message: 'The operator request failed. Inspect platform events before retrying a mutation.',
    },
    500,
  );
});
operatorApi.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('X-Void-Operator-Api-Version', '1');
  await next();
});
operatorApi.use(
  '*',
  bodyLimit({
    maxSize: 32 * 1024,
    onError: (context) =>
      context.json(
        { error: 'body_too_large', message: 'Operator request bodies must not exceed 32 KiB.' },
        413,
      ),
  }),
);
operatorApi.route('/', operatorSessionRoutes);
operatorApi.use('*', operatorAuth);
operatorApi.route('/', authenticatedSessionRoutes);
operatorApi.use('*', operatorAudit);
operatorApi.route('/', operatorAuditRoutes);
operatorApi.route('/', tenantRoutes);
operatorApi.route('/', operationsRoutes);
operatorApi.route('/', authenticationConfigRoutes);
operatorApi.route('/', planOperatorRoutes);
operatorApi.route('/', emailOperatorRoutes);
operatorApi.route('/', zeroTrustOperatorRoutes);
operatorApi.route('/', securityOperatorRoutes);
operatorApi.notFound((context) =>
  context.json({ error: 'not_found', message: 'Unknown operator API endpoint.' }, 404),
);
