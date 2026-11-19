/**
 * `GET /security/projects/:slug` (spec §13.2): the read-only project security page.
 *
 * There is no browser session for project users on the API host, so a signed link from
 * `void project security open` is the credential, like the email confirm link:
 *
 *   ?t=<token> ─► verify (15 min, one user, this project) ─► HttpOnly cookie on this
 *                 path only ─► 303 to the clean URL (the token leaves the address bar)
 *   cookie     ─► verify ─► re-check the member's role and account on every load ─► page
 *   neither    ─► landing page with no project data (links in email land here)
 *
 * The same text answers an unknown project and a project the reader may not see, so
 * the page does not tell whether a slug exists. Access protection still applies to the
 * route: a person behind the platform's Access app signs in there first.
 */
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { platformBrowserPage } from '../browser-page.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import { getProjectBySlug, getUser } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  requireProjectCapability,
} from '../project-access.ts';
import { verifySecurityPageToken } from '../security/page-token.ts';
import {
  loadSecurityPage,
  renderSecurityInvalidLink,
  renderSecurityLanding,
  renderSecurityPage,
} from '../security/project-page.ts';
import { isAdminSuspended } from '../suspension.ts';
import type { ProjectRole } from '../types.ts';

const COOKIE_NAME = 'void_security_page';

const app = new Hono<ApiEnv>();

// The token sits in the URL and the page holds finding detail: keep both out of caches
// and out of `Referer`.
app.use('*', async (context, next) => {
  await next();
  context.res.headers.set('cache-control', 'no-store');
  context.res.headers.set('referrer-policy', 'no-referrer');
});

function capabilityOn(env: ApiEnv['Bindings']): boolean {
  try {
    return getPlatformCapabilities(env).securityAudits;
  } catch {
    return false;
  }
}

app.get('/:slug', async (context) => {
  const slug = context.req.param('slug');
  const db = context.get('db');
  const project = await getProjectBySlug(db, slug);
  const cleanPath = `/security/projects/${encodeURIComponent(slug)}`;

  const link = context.req.query('t');
  if (link !== undefined) {
    const payload = await verifySecurityPageToken(link, context.env.JWT_SECRET);
    if (!payload || !project || payload.pid !== project.id) {
      return platformBrowserPage(context, 'Link expired', renderSecurityInvalidLink(slug), 400);
    }
    setCookie(context, COOKIE_NAME, link, {
      path: cleanPath,
      httpOnly: true,
      secure: new URL(context.req.url).protocol === 'https:',
      sameSite: 'Lax',
      maxAge: Math.max(1, payload.exp - Math.floor(Date.now() / 1000)),
    });
    return context.redirect(cleanPath, 303);
  }

  const landing = () =>
    platformBrowserPage(context, 'Project security', renderSecurityLanding(slug));
  const cookie = getCookie(context, COOKIE_NAME);
  if (!cookie || !project) {
    return landing();
  }
  const payload = await verifySecurityPageToken(cookie, context.env.JWT_SECRET);
  if (!payload || payload.pid !== project.id) {
    return landing();
  }
  // Access is checked on every load: a removed member or a suspended account sees the landing page.
  const user = await getUser(db, payload.uid);
  if (!user || isAdminSuspended(user.suspended_reason)) {
    return landing();
  }
  // The same gate as /projects/:id/security/*: a member, and an owner not suspended.
  let role: ProjectRole;
  try {
    role = (await requireProjectCapability(db, project.id, user.id, 'read')).role;
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
      return landing();
    }
    throw error;
  }
  const data = await loadSecurityPage(db, {
    project,
    role,
    capability: capabilityOn(context.env),
  });
  return platformBrowserPage(context, 'Project security', renderSecurityPage(data));
});

export default app;
