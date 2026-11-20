import {
  parseSecurityDigits,
  parseSecurityFindingLabel,
  parseSecurityUsdText,
} from '@void/platform/security-policy';
/**
 * The project security page in the dashboard (Phase 2, M29). It reads and writes only
 * through the API's project security routes, so the rules (roles, revisions, caps, the
 * provider notice, the public gate) are the API's:
 *
 *   loader  GET /projects ─► slug → id + role ─► GET …/security, …/findings, …/scans
 *   ?resolve ?comment ?model ?budget ?bypass
 *           same origin? ─► POST/PUT on the API with the session token
 *           ok ─► 303 back with ?done=<what>   refused ─► the page again with the reason
 */
import type { Context } from 'hono';
import { defineHandler, defineHead } from 'void';
import {
  apiClient,
  fetchApi,
  getApiErrorMessage,
  readApiJson,
  type ProjectListItem,
  type ProjectSecurityBody,
  type ProjectSecurityFindingsBody,
  type ProjectSecurityScansBody,
} from '../../../lib/api.ts';
import { dashboardRequestOrigin } from '../../../lib/origin.ts';

export type SecurityNotice = Readonly<{ kind: 'ok' | 'error'; text: string }>;

declare module 'void' {
  interface CloudContextVariables {
    /** Set by an action that was refused; the loader shows it. */
    securityNotice: SecurityNotice;
  }
}

export type Finding = ProjectSecurityFindingsBody['findings'][number];
export type Scan = ProjectSecurityScansBody['scans'][number];

export type Props = Readonly<{
  slug: string;
  project: Readonly<{ id: string; role: ProjectListItem['role'] }> | null;
  status: ProjectSecurityBody | null;
  open: ReadonlyArray<Finding>;
  resolved: ReadonlyArray<Finding>;
  scans: ReadonlyArray<Scan> | null;
  notice: SecurityNotice | null;
}>;

/** `?done=` keys an action redirect sets, and the line the page shows for each. */
export const SECURITY_DONE_COPY: Readonly<Record<string, string>> = {
  resolved: 'Finding resolved.',
  commented: 'Comment added.',
  model: 'Scan model saved.',
  budget: 'Monthly scan budget saved.',
  bypassed: 'Scan bypassed. The project is going public.',
};

/** A project id as the API writes it: 1 to 64 of `A-Z a-z 0-9 _ -`. */
function isProjectId(value: string): boolean {
  if (value.length === 0 || value.length > 64) {
    return false;
  }
  for (const char of value) {
    const ok =
      (char >= 'a' && char <= 'z') ||
      (char >= 'A' && char <= 'Z') ||
      (char >= '0' && char <= '9') ||
      char === '_' ||
      char === '-';
    if (!ok) {
      return false;
    }
  }
  return true;
}

export const head = defineHead<Props>((_context, props) => ({
  title: `${props.slug} · Security`,
}));

function pagePath(slug: string): string {
  return `/projects/${encodeURIComponent(slug)}/security`;
}

async function findProject(
  context: Context,
  slug: string,
): Promise<Readonly<{ id: string; role: ProjectListItem['role'] }> | null> {
  const response = await apiClient(context).projects.$get();
  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response));
  }
  const projects = (await readApiJson<ReadonlyArray<ProjectListItem>>(response)) ?? [];
  const project = projects.find((item) => item.slug === slug);
  return project ? { id: project.id, role: project.role } : null;
}

async function getJson<T>(context: Context, url: URL): Promise<T> {
  const response = await fetchApi(context, `${url.pathname}${url.search}`);
  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response));
  }
  const body = await readApiJson<T>(response);
  if (body === null) {
    throw new Error('The service is temporarily unavailable. Try again shortly.');
  }
  return body;
}

function findingsUrl(context: Context, id: string, state: 'open' | 'resolved'): URL {
  const url = apiClient(context).projects[':id'].security.findings.$url({ param: { id } });
  url.searchParams.set('state', state);
  url.searchParams.set('limit', '100');
  return url;
}

export const loader = defineHandler<Props>(async (context) => {
  const slug = context.req.param('slug') ?? '';
  const done = SECURITY_DONE_COPY[context.req.query('done') ?? ''];
  const notice: SecurityNotice | null =
    context.get('securityNotice') ?? (done ? { kind: 'ok', text: done } : null);
  const empty = { slug, open: [], resolved: [], scans: null, notice } as const;
  try {
    const project = await findProject(context, slug);
    if (!project) {
      return { ...empty, project: null, status: null };
    }
    const client = apiClient(context).projects[':id'].security;
    const param = { param: { id: project.id } };
    const [status, open, resolved, scans] = await Promise.all([
      getJson<ProjectSecurityBody>(context, client.$url(param)),
      getJson<ProjectSecurityFindingsBody>(context, findingsUrl(context, project.id, 'open')),
      getJson<ProjectSecurityFindingsBody>(context, findingsUrl(context, project.id, 'resolved')),
      // Scans need deploy; with the capability off the API answers 501, so none show.
      project.role === 'reader'
        ? Promise.resolve(null)
        : getJson<ProjectSecurityScansBody>(context, client.scans.$url(param)).catch(() => null),
    ]);
    return {
      ...empty,
      project,
      status,
      open: open.findings,
      resolved: resolved.findings,
      scans: scans?.scans.slice(0, 10) ?? null,
    };
  } catch (error) {
    return {
      ...empty,
      project: null,
      status: null,
      notice: {
        kind: 'error',
        text:
          error instanceof Error && error.message
            ? error.message
            : 'The service is temporarily unavailable. Try again shortly.',
      },
    };
  }
});

type Body = Record<string, string | File | Array<string | File>>;

function field(body: Body, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

/**
 * One form: the origin check, the project id the page rendered, the API call. A refusal
 * keeps the reader on the page with the API's reason; success redirects so a reload
 * does not send it again.
 */
function securityAction(
  done: keyof typeof SECURITY_DONE_COPY,
  send: (context: Context, projectId: string, body: Body) => Promise<Response | string>,
) {
  return defineHandler(async (context) => {
    // Cookie-authenticated mutations must originate in this dashboard.
    if (context.req.header('Origin') !== dashboardRequestOrigin(context)) {
      return context.text(
        'This request could not be verified. Refresh the security page and try again.',
        403,
      );
    }
    const slug = context.req.param('slug') ?? '';
    const body = (await context.req.parseBody()) as Body;
    const projectId = field(body, 'projectId');
    if (!isProjectId(projectId)) {
      context.set('securityNotice', { kind: 'error', text: 'Refresh the page and try again.' });
      return;
    }
    let result: Response | string;
    try {
      result = await send(context, projectId, body);
    } catch {
      result = 'The service is temporarily unavailable. Try again shortly.';
    }
    if (typeof result === 'string') {
      context.set('securityNotice', { kind: 'error', text: result });
      return;
    }
    if (!result.ok) {
      context.set('securityNotice', { kind: 'error', text: await getApiErrorMessage(result) });
      return;
    }
    return context.redirect(`${pagePath(slug)}?done=${done}`, 303);
  });
}

function send(context: Context, url: URL, method: 'POST' | 'PUT', json: unknown) {
  return fetchApi(context, `${url.pathname}${url.search}`, {
    method,
    body: JSON.stringify(json),
  });
}

function findingUrl(
  context: Context,
  projectId: string,
  body: Body,
  action: 'resolve' | 'comments',
): URL | null {
  const fid = field(body, 'finding');
  if (parseSecurityFindingLabel(fid) === null) {
    return null;
  }
  return apiClient(context).projects[':id'].security.findings[':fid'][action].$url({
    param: { id: projectId, fid },
  });
}

export const actions = {
  resolve: securityAction('resolved', async (context, projectId, body) => {
    const url = findingUrl(context, projectId, body, 'resolve');
    if (!url) {
      return 'Refresh the page and try again.';
    }
    const revision = field(body, 'expectedRevision');
    return send(context, url, 'POST', {
      reason: field(body, 'reason'),
      comment: field(body, 'comment'),
      expectedRevision: parseSecurityDigits(revision, 15) ?? revision,
    });
  }),
  comment: securityAction('commented', async (context, projectId, body) => {
    const url = findingUrl(context, projectId, body, 'comments');
    if (!url) {
      return 'Refresh the page and try again.';
    }
    return send(context, url, 'POST', { text: field(body, 'text') });
  }),
  model: securityAction('model', async (context, projectId, body) => {
    const model = field(body, 'model');
    const version = Number(field(body, 'noticeVersion'));
    return send(
      context,
      apiClient(context).projects[':id'].security.model.$url({ param: { id: projectId } }),
      'PUT',
      {
        model: model === '' ? null : model,
        // The version the page showed: a notice changed since then is refused.
        ...(field(body, 'acceptProviderNotice') === '1'
          ? { acceptProviderNoticeVersion: version }
          : {}),
      },
    );
  }),
  budget: securityAction('budget', async (context, projectId, body) => {
    const monthlyUsd = parseSecurityUsdText(field(body, 'usd'));
    if (monthlyUsd === undefined) {
      return 'Enter a dollar amount such as 50 or 12.50, or leave it empty to remove the cap.';
    }
    return send(
      context,
      apiClient(context).projects[':id'].security.budget.$url({ param: { id: projectId } }),
      'PUT',
      { monthlyUsd },
    );
  }),
  bypass: securityAction('bypassed', async (context, projectId, body) => {
    if (field(body, 'confirm') !== '1') {
      return 'Tick the box to confirm the project goes public unscanned.';
    }
    try {
      return await send(
        context,
        apiClient(context).projects[':id']['zero-trust']['public-request'].bypass.$url({
          param: { id: projectId },
        }),
        'POST',
        { reason: field(body, 'reason') },
      );
    } catch {
      // The API may have recorded the bypass after the dashboard stopped waiting.
      return 'The bypass did not answer in time and may still go through. Reload this page to see whether the project is going public.';
    }
  }),
};
