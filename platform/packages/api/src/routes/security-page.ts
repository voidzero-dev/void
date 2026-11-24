/**
 * `GET /security/projects/:slug` (spec §13.2): the project security page, and its forms
 * (Phase 2, M29).
 *
 * There is no browser session for project users on the API host, so a signed link from
 * `void project security open` is the credential, like the email confirm link:
 *
 *   ?t=<token> ─► verify (15 min, one user, this project) ─► HttpOnly cookie on this
 *                 path only ─► 303 to the clean URL (the token leaves the address bar)
 *   cookie     ─► verify ─► re-check the member's role and account on every load ─► page
 *   neither    ─► landing page with no project data (links in email land here)
 *
 * Forms post below the page path, so the path-scoped cookie goes with them:
 *
 *   POST …/findings/:fid/resolve   settings    POST …/model    settings
 *   POST …/findings/:fid/comment   configure   POST …/budget   settings
 *   POST …/bypass                  settings
 *
 *   same origin? (Origin, else Referer; the admin CSRF rule) ─► cookie + member check
 *   ─► the server operation the API route calls ─► 303 to the page with ?done=<what>
 *   a refusal re-renders the page with the reason and the refusal's status
 *
 * The same text answers an unknown project and a project the reader may not see, so
 * the page does not tell whether a slug exists. Access protection still applies to the
 * route: a person behind the platform's Access app signs in there first.
 */
import { SECURITY_PROVIDER_NOTICE_VERSION } from '@void/platform/security-models';
import { parseSecurityDigits, parseSecurityUsdText } from '@void/platform/security-policy';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { platformBrowserPage } from '../browser-page.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import { getProjectBySlug, getUser } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  requireProjectCapability,
} from '../project-access.ts';
import { SecurityApiError } from '../security/errors.ts';
import { verifySecurityPageToken } from '../security/page-token.ts';
import {
  commentOnSecurityFinding,
  parseSecurityComment,
  parseSecurityResolution,
  resolveSecurityFinding,
} from '../security/project-findings.ts';
import {
  loadSecurityPage,
  renderSecurityInvalidLink,
  renderSecurityLanding,
  renderSecurityPage,
} from '../security/project-page.ts';
import type { SecurityPageNotice } from '../security/project-page.ts';
import {
  parseSecurityBudgetRequest,
  parseSecurityModelRequest,
  setProjectSecurityBudget,
  setProjectSecurityModel,
} from '../security/project-settings.ts';
import {
  bypassPublicRequest,
  recheckPublicRequestBestEffort,
} from '../security/public-gate-flow.ts';
import { readOpenPublicRequest, readPublicRequestById } from '../security/public-gate.ts';
import { isAdminSuspended } from '../suspension.ts';
import type { Project, ProjectCapability, ProjectRole, User } from '../types.ts';
import { ZeroTrustConfigurationError } from '../zero-trust/configuration.ts';
import { zeroTrustNotReadyMessage, ZeroTrustUnavailableError } from '../zero-trust/errors.ts';

const COOKIE_NAME = 'void_security_page';

/** `?done=` keys a form redirect sets, and the line the page shows for each. */
const DONE_COPY: Readonly<Record<string, string>> = {
  resolved: 'Finding resolved.',
  commented: 'Comment added.',
  model: 'Scan model saved.',
  budget: 'Monthly scan budget saved.',
  bypassed: 'Scan bypassed. The project is going public.',
};

const app = new Hono<ApiEnv>();

// The token sits in the URL and the page holds finding detail: keep both out of caches
// and out of other sites' `Referer`. `same-origin`, not `no-referrer`: under
// `no-referrer` a browser sends `Origin: null` on the page's own form posts, and the
// origin check below would refuse every one (as in `oauth.ts`).
app.use('*', async (context, next) => {
  await next();
  context.res.headers.set('cache-control', 'no-store');
  context.res.headers.set('referrer-policy', 'same-origin');
});

function capabilityOn(env: ApiEnv['Bindings']): boolean {
  try {
    return getPlatformCapabilities(env).securityAudits;
  } catch {
    return false;
  }
}

function cleanPath(slug: string): string {
  return `/security/projects/${encodeURIComponent(slug)}`;
}

type PageViewer = Readonly<{ project: Project; user: User; role: ProjectRole }>;

/**
 * The signed-in member behind the page cookie, or `null` (no cookie, a bad or foreign
 * token, a removed member, a suspended account). Checked on every load and every post.
 */
async function pageViewer(context: Context<ApiEnv>, slug: string): Promise<PageViewer | null> {
  const db = context.get('db');
  const project = await getProjectBySlug(db, slug);
  const cookie = getCookie(context, COOKIE_NAME);
  if (!cookie || !project) {
    return null;
  }
  const payload = await verifySecurityPageToken(cookie, context.env.JWT_SECRET);
  if (!payload || payload.pid !== project.id) {
    return null;
  }
  const user = await getUser(db, payload.uid);
  if (!user || isAdminSuspended(user.suspended_reason)) {
    return null;
  }
  // The same gate as /projects/:id/security/*: a member, and an owner not suspended.
  try {
    const { role } = await requireProjectCapability(db, project.id, user.id, 'read');
    return { project, user, role };
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
      return null;
    }
    throw error;
  }
}

async function renderPage(
  context: Context<ApiEnv>,
  viewer: PageViewer,
  notice: SecurityPageNotice | null,
  status: ContentfulStatusCode = 200,
): Promise<Response> {
  const data = await loadSecurityPage(context.get('db'), {
    project: viewer.project,
    role: viewer.role,
    capability: capabilityOn(context.env),
  });
  return platformBrowserPage(context, 'Project security', renderSecurityPage(data, notice), status);
}

app.get('/:slug', async (context) => {
  const slug = context.req.param('slug');
  const path = cleanPath(slug);

  const link = context.req.query('t');
  if (link !== undefined) {
    const project = await getProjectBySlug(context.get('db'), slug);
    const payload = await verifySecurityPageToken(link, context.env.JWT_SECRET);
    if (!payload || !project || payload.pid !== project.id) {
      return platformBrowserPage(context, 'Link expired', renderSecurityInvalidLink(slug), 400);
    }
    setCookie(context, COOKIE_NAME, link, {
      path,
      httpOnly: true,
      secure: new URL(context.req.url).protocol === 'https:',
      sameSite: 'Lax',
      maxAge: Math.max(1, payload.exp - Math.floor(Date.now() / 1000)),
    });
    return context.redirect(path, 303);
  }

  const viewer = await pageViewer(context, slug);
  if (!viewer) {
    return platformBrowserPage(context, 'Project security', renderSecurityLanding(slug));
  }
  const done = DONE_COPY[context.req.query('done') ?? ''];
  return renderPage(context, viewer, done ? { kind: 'ok', text: done } : null);
});

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The admin CSRF rule (`admin/middleware/csrf.ts`): Origin, else Referer, must be ours. */
function sameOrigin(context: Context<ApiEnv>): boolean {
  const expected = new URL(context.req.url).origin;
  const origin = context.req.header('Origin');
  if (origin) {
    return parseOrigin(origin) === expected;
  }
  const referer = context.req.header('Referer');
  return referer !== undefined && parseOrigin(referer) === expected;
}

function text(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

/** A refusal the page can show: the same text the API route answers with. */
function refusal(error: unknown): Readonly<{ text: string; status: ContentfulStatusCode }> | null {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
    return { text: error.userMessage, status: error.status };
  }
  if (
    error instanceof SecurityApiError ||
    error instanceof OperatorError ||
    error instanceof PageRefusalError
  ) {
    return { text: error.message, status: error.status as ContentfulStatusCode };
  }
  if (error instanceof ZeroTrustUnavailableError || error instanceof ZeroTrustConfigurationError) {
    return { text: zeroTrustNotReadyMessage(error) ?? error.message, status: 409 };
  }
  return null;
}

type FormAction = (
  context: Context<ApiEnv>,
  viewer: PageViewer,
  body: Record<string, unknown>,
) => Promise<keyof typeof DONE_COPY>;

/**
 * One page form: the origin check, the signed-in member, the capability the API route
 * needs, then `run`. Success redirects (a reload does not post again); a refusal shows
 * the page with the reason.
 */
function pageForm(capability: ProjectCapability, run: FormAction) {
  return async (context: Context<ApiEnv>) => {
    const slug = context.req.param('slug') ?? '';
    if (!sameOrigin(context)) {
      return platformBrowserPage(
        context,
        'Request refused',
        '<div class="void-auth-lead"><h1 id="void-auth-title">This request could not be verified</h1>' +
          '<p>Open the page again and retry from there.</p></div>',
        403,
      );
    }
    const viewer = await pageViewer(context, slug);
    if (!viewer) {
      return platformBrowserPage(context, 'Link expired', renderSecurityInvalidLink(slug), 403);
    }
    let body: Record<string, unknown>;
    try {
      body = await context.req.parseBody();
    } catch {
      return renderPage(
        context,
        viewer,
        { kind: 'error', text: 'The form could not be read.' },
        400,
      );
    }
    try {
      await requireProjectCapability(
        context.get('db'),
        viewer.project.id,
        viewer.user.id,
        capability,
      );
      const done = await run(context, viewer, body);
      return context.redirect(`${cleanPath(slug)}?done=${done}`, 303);
    } catch (error) {
      const reason = refusal(error);
      if (!reason) {
        throw error;
      }
      return renderPage(context, viewer, { kind: 'error', text: reason.text }, reason.status);
    }
  };
}

/** A refusal of the page itself, with the status the matching API route answers. */
class PageRefusalError extends Error {
  constructor(
    message: string,
    readonly status: ContentfulStatusCode,
  ) {
    super(message);
  }
}

/** `capabilityOff` in `project-security.ts`: model and budget need the capability. */
function requireCapability(context: Context<ApiEnv>): void {
  if (!capabilityOn(context.env)) {
    throw new PageRefusalError('This Void platform does not enable securityAudits.', 501);
  }
}

/** Digits become a number; anything else goes on as text, for the parser's own reason. */
function revision(value: string | undefined): unknown {
  return value === undefined ? value : (parseSecurityDigits(value, 15) ?? value);
}

/** The rest of the API route's 502 line (`project-zero-trust.ts`), for a bypass Access did not take. */
const ACCESS_NOT_UPDATED_NEXT =
  'Protection remains fail closed. Run `void project zero-trust reconcile` to retry, or ask a platform administrator to check the Access token.';

app.post(
  '/:slug/findings/:fid/resolve',
  pageForm('settings', async (context, viewer, body) => {
    const db = context.get('db');
    await resolveSecurityFinding(db, {
      projectId: viewer.project.id,
      ref: context.req.param('fid') ?? '',
      userId: viewer.user.id,
      resolution: parseSecurityResolution(text(body, 'reason')),
      comment: parseSecurityComment(text(body, 'comment'), 'comment'),
      expectedRevision: revision(text(body, 'expectedRevision')),
    });
    // As the API route: an open public request is judged again.
    await recheckPublicRequestBestEffort(context.env, db, viewer.project.id, 'a resolve');
    return 'resolved';
  }),
);

app.post(
  '/:slug/findings/:fid/comment',
  pageForm('configure', async (context, viewer, body) => {
    await commentOnSecurityFinding(context.get('db'), {
      projectId: viewer.project.id,
      ref: context.req.param('fid') ?? '',
      userId: viewer.user.id,
      role: viewer.role,
      text: parseSecurityComment(text(body, 'text'), 'comment'),
    });
    return 'commented';
  }),
);

app.post(
  '/:slug/model',
  pageForm('settings', async (context, viewer, body) => {
    requireCapability(context);
    const model = text(body, 'model') ?? '';
    const accepted = text(body, 'acceptProviderNotice') === '1';
    const version = Number(text(body, 'noticeVersion') ?? SECURITY_PROVIDER_NOTICE_VERSION);
    await setProjectSecurityModel(context.get('db'), {
      projectId: viewer.project.id,
      userId: viewer.user.id,
      request: parseSecurityModelRequest({
        model: model === '' ? null : model,
        // The version the page showed: a notice changed since then is refused.
        ...(accepted ? { acceptProviderNoticeVersion: version } : {}),
      }),
    });
    return 'model';
  }),
);

app.post(
  '/:slug/budget',
  pageForm('settings', async (context, viewer, body) => {
    requireCapability(context);
    const monthlyUsd = parseSecurityUsdText(text(body, 'usd') ?? '');
    if (monthlyUsd === undefined) {
      throw SecurityApiError.invalid(
        'Enter a dollar amount such as 50 or 12.50, or leave it empty to remove the cap.',
      );
    }
    await setProjectSecurityBudget(context.get('db'), {
      projectId: viewer.project.id,
      slug: viewer.project.slug,
      userId: viewer.user.id,
      role: viewer.role,
      cents: parseSecurityBudgetRequest({ monthlyUsd }),
    });
    return 'budget';
  }),
);

app.post(
  '/:slug/bypass',
  pageForm('settings', async (context, viewer, body) => {
    if (text(body, 'confirm') !== '1') {
      throw SecurityApiError.invalid('Tick the box to confirm the project goes public unscanned.');
    }
    const db = context.get('db');
    const open = await readOpenPublicRequest(db, viewer.project.id);
    try {
      await bypassPublicRequest(context.env, db, {
        projectId: viewer.project.id,
        reason: text(body, 'reason'),
        actor: { kind: 'user', userId: viewer.user.id, role: viewer.role },
      });
    } catch (error) {
      if (refusal(error)) {
        throw error;
      }
      // As the API route: a Cloudflare failure is a 502 with the retry command. The
      // bypass commits before Access is updated, so say when it is already recorded: a
      // retry would only answer "no public request to bypass".
      console.error('[security-page] public request bypass failed', {
        projectId: viewer.project.id,
        error,
      });
      const after = open ? await readPublicRequestById(db, viewer.project.id, open.id) : null;
      throw new PageRefusalError(
        after?.state === 'bypassed'
          ? `The bypass is recorded, but Cloudflare Access is not updated yet. ${ACCESS_NOT_UPDATED_NEXT}`
          : `Cloudflare Access could not be updated. ${ACCESS_NOT_UPDATED_NEXT}`,
        502,
      );
    }
    return 'bypassed';
  }),
);

export default app;
