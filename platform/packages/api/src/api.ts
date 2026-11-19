// Type-only API route definition for use by the dashboard's hc client.
// This file must NOT import admin routes (.tsx) — the dashboard's tsconfig
// doesn't support Hono JSX.

import { Hono } from 'hono';
import type { ApiEnv } from './env.ts';
import domains from './routes/domains.ts';
import me from './routes/me.ts';
import projectSecurityRoutes from './routes/project-security.ts';
import projectZeroTrustRoutes from './routes/project-zero-trust.ts';
import projects from './routes/projects.ts';
import secrets from './routes/secrets.ts';
import { projectUsage, accountUsage } from './routes/usage.ts';

const api = new Hono<ApiEnv>()
  .route('/me', me)
  .route('/projects', projects)
  .route('/projects', secrets)
  .route('/projects', domains)
  .route('/projects', projectZeroTrustRoutes)
  .route('/projects', projectSecurityRoutes)
  .route('/projects', projectUsage)
  .route('/usage', accountUsage);

export type ApiRoutes = typeof api;
