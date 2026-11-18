import {
  PLATFORM_LOGIN_KINDS,
  parsePlatformLoginConfiguration,
  type PlatformLoginConfiguration,
} from '@void/platform';
import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import { getPlatformCapabilities } from '../../capabilities.ts';
import { SITE_DOMAIN } from '../../constants.ts';
import {
  countDeployments,
  countProjects,
  countUsers,
  getAllDeploymentsWithProject,
  getAllProjectsWithOwner,
  getAllUsers,
  getBuild,
  getDeployment,
  getProject,
  getProjectMembers,
  getPendingProjectInvitations,
  searchDeployments,
  searchProjects,
  searchUsers,
} from '../../db.ts';
import type { Db } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { OperatorError } from '../../operator/common.ts';
import { cliVersionStats } from '../../operator/system-operations.ts';
import {
  initialPlanDefaultFor,
  readPlanCatalog,
  readPlanCatalogWithAccounts,
  planFromCatalog,
} from '../../plans.ts';
import { getPlatformApiUrl, platformConnectCommand } from '../../platform-identity.ts';
import { projectUrl, projectWithUrl } from '../../project-url.ts';
import { invitations, platformLoginTests } from '../../schema.ts';
import type { DeployManifest } from '../../types.ts';

type AdminContext = Context<ApiEnv>;
const PAGE_SIZE = 20;

function pageLocation(path: string, pathname: string): URL {
  const url = new URL(path, 'https://admin.invalid');
  if (
    !path.startsWith('/admin/') ||
    url.origin !== 'https://admin.invalid' ||
    url.pathname !== pathname
  ) {
    throw new OperatorError(400, 'Invalid admin page request.');
  }
  return url;
}

function detailLocation(path: string, prefix: string): { id: string; url: URL } {
  const url = new URL(path, 'https://admin.invalid');
  if (
    !path.startsWith(prefix) ||
    !url.pathname.startsWith(prefix) ||
    url.origin !== 'https://admin.invalid'
  ) {
    throw new OperatorError(400, 'Invalid admin page request.');
  }
  const encodedId = url.pathname.slice(prefix.length);
  if (!encodedId || encodedId.includes('/')) {
    throw new OperatorError(400, 'Invalid admin page request.');
  }
  return { id: decodeURIComponent(encodedId), url };
}

export function requestTimezone(context: AdminContext): string | undefined {
  return context.req.raw.cf?.timezone as string | undefined;
}

function pageNumber(url: URL) {
  return Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
}

export async function loadUsersPage(context: AdminContext, path: string) {
  const url = pageLocation(path, '/admin/users');
  const search = url.searchParams.get('search') ?? undefined;
  const tz = requestTimezone(context);
  if (search) {
    return { id: path, users: await searchUsers(context.get('db'), search), search, tz };
  }
  const page = pageNumber(url);
  const [users, total] = await Promise.all([
    getAllUsers(context.get('db'), PAGE_SIZE, (page - 1) * PAGE_SIZE),
    countUsers(context.get('db')),
  ]);
  return { id: path, users, page, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)), tz };
}

export async function loadProjectsPage(context: AdminContext, path: string) {
  const url = pageLocation(path, '/admin/projects');
  const search = url.searchParams.get('search') ?? undefined;
  const siteDomain = context.env.SITE_DOMAIN ?? SITE_DOMAIN;
  const tz = requestTimezone(context);
  if (search) {
    const projects = await searchProjects(context.get('db'), search);
    return {
      id: path,
      projects: projects.map((project) => projectWithUrl(project, context.env)),
      search,
      siteDomain,
      tz,
    };
  }
  const page = pageNumber(url);
  const [projects, total] = await Promise.all([
    getAllProjectsWithOwner(context.get('db'), PAGE_SIZE, (page - 1) * PAGE_SIZE),
    countProjects(context.get('db')),
  ]);
  return {
    id: path,
    projects: projects.map((project) => projectWithUrl(project, context.env)),
    page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    siteDomain,
    tz,
  };
}

export async function loadDeploymentsPage(context: AdminContext, path: string) {
  const url = pageLocation(path, '/admin/deployments');
  const search = url.searchParams.get('search') ?? undefined;
  const tz = requestTimezone(context);
  if (search) {
    return {
      id: path,
      deployments: await searchDeployments(context.get('db'), search),
      search,
      tz,
    };
  }
  const page = pageNumber(url);
  const [deployments, total] = await Promise.all([
    getAllDeploymentsWithProject(context.get('db'), PAGE_SIZE, (page - 1) * PAGE_SIZE),
    countDeployments(context.get('db')),
  ]);
  return {
    id: path,
    deployments,
    page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    tz,
  };
}

export async function loadUserDetailPage(context: AdminContext, path: string) {
  const { id } = detailLocation(path, '/admin/users/');
  const { getOperatorUser } = await import('../../operator/tenant-service.ts');
  const detail = await getOperatorUser(context, id);
  const { readPlanAiLoggingSettings } = await import('../../ai-logging-plans.ts');
  const { planAiLogging } = await import('../../ai-logging-policy.ts');
  const [catalog, aiLoggingSettings] = await Promise.all([
    readPlanCatalog(context.get('db'), initialPlanDefaultFor(context.env)),
    readPlanAiLoggingSettings(context.get('db')),
  ]);
  return {
    id: path,
    ...detail,
    limits: planFromCatalog(catalog, detail.user.plan).limits,
    aiLogging: planAiLogging(aiLoggingSettings, catalog, detail.user.plan),
    plans: catalog.plans
      .filter((plan) => !plan.archived || plan.id === detail.user.plan)
      .map((plan) => ({ id: plan.id, name: plan.name, archived: plan.archived })),
    tz: requestTimezone(context),
  };
}

/**
 * Saved Zero Trust state for the project detail page. It reads only the
 * database, because page navigations load it often; the live Access check
 * belongs to the Zero Trust page.
 */
async function loadProjectZeroTrust(db: Db, projectId: string) {
  const {
    ZeroTrustConfigurationError,
    readZeroTrustConfigurationStrict,
    zeroTrustConfigurationStatus,
  } = await import('../../zero-trust/configuration.ts');
  const { getProjectZeroTrustState, projectZeroTrustAvailable, publicProjectZeroTrustState } =
    await import('../../zero-trust/state.ts');
  const [row, configuration] = await Promise.all([
    getProjectZeroTrustState(db, projectId),
    readZeroTrustConfigurationStrict(db).catch((error: unknown) => {
      if (error instanceof ZeroTrustConfigurationError) {
        return 'invalid' as const;
      }
      throw error;
    }),
  ]);
  const saved = configuration === 'invalid' ? null : configuration;
  return {
    configured: configuration !== null,
    invalid: configuration === 'invalid',
    enabled: saved?.enabled ?? false,
    status: saved ? zeroTrustConfigurationStatus(saved) : null,
    operation: saved?.operation?.kind ?? null,
    available: projectZeroTrustAvailable(saved),
    state: publicProjectZeroTrustState(row),
  };
}

export async function loadProjectDetailPage(context: AdminContext, path: string) {
  const { id } = detailLocation(path, '/admin/projects/');
  const { getOperatorProject } = await import('../../operator/tenant-service.ts');
  const db = context.get('db');
  const [detail, members, invitations, zeroTrust] = await Promise.all([
    getOperatorProject(db, context.env, id),
    getProjectMembers(db, id),
    getPendingProjectInvitations(db, id),
    loadProjectZeroTrust(db, id),
  ]);
  return {
    id: path,
    ...detail,
    teamMembers: members.map(({ member, user }) => ({
      user: { id: user.id, login: user.login, email: user.email },
      role: member.role,
      createdAt: member.created_at,
    })),
    pendingTeamInvitations: invitations.map((invitation) => ({
      id: invitation.id,
      targetUserId: invitation.target_user_id,
      email: invitation.target_email_snapshot,
      role: invitation.role,
      expiresAt: invitation.expires_at,
    })),
    zeroTrust,
    cfAccountId: context.env.CF_ACCOUNT_ID,
    deployUrl: projectUrl(detail.project, context.env),
    tz: requestTimezone(context),
  };
}

export async function loadDeploymentDetailPage(context: AdminContext, path: string) {
  const { id } = detailLocation(path, '/admin/deployments/');
  const deployment = await getDeployment(context.get('db'), id);
  if (!deployment) {
    throw new OperatorError(404, 'Deployment not found');
  }
  const project = await getProject(context.get('db'), deployment.project_id);
  let manifest: DeployManifest | null = null;
  try {
    if (deployment.manifest) {
      manifest = JSON.parse(deployment.manifest) as DeployManifest;
    }
  } catch {
    // Preserve the detail page when an old deployment has malformed manifest JSON.
  }
  return {
    id: path,
    deployment,
    project,
    manifest,
    canCancel: ['pending', 'uploading', 'migrating', 'prerendering'].includes(deployment.status),
    tz: requestTimezone(context),
  };
}

export async function loadBuildDetailPage(context: AdminContext, path: string) {
  const { id, url } = detailLocation(path, '/admin/builds/');
  if (url.searchParams.has('status')) {
    throw new OperatorError(400, 'Build status is a separate endpoint.');
  }
  const build = await getBuild(context.get('db'), id);
  if (!build) {
    throw new OperatorError(404, 'Build not found');
  }
  return {
    id: path,
    build,
    tz: requestTimezone(context),
  };
}

export async function loadCliVersionsPage(context: AdminContext, path: string) {
  pageLocation(path, '/admin/cli-versions');
  return {
    id: path,
    ...(await cliVersionStats(context.get('db'))),
    tz: requestTimezone(context),
  };
}

export async function loadSignupPage(context: AdminContext, path: string) {
  const url = pageLocation(path, '/admin/signup-control');
  const page = pageNumber(url);
  const { getOperatorSignup, listOperatorInvitations } =
    await import('../../operator/access-service.ts');
  const { getAuthenticationConfiguration } = await import('../../operator/auth-config.ts');
  const [signup, invitationPage, authentication] = await Promise.all([
    getOperatorSignup(context),
    listOperatorInvitations(context.get('db'), {
      page,
      limit: 50,
      offset: (page - 1) * 50,
    }),
    getAuthenticationConfiguration(context),
  ]);
  const exactEmailGrants = signup.entries.flatMap((entry) =>
    entry.type === 'email' && !entry.pattern.startsWith('*@') ? [entry.pattern.toLowerCase()] : [],
  );
  const invitationGrants = exactEmailGrants.length
    ? await context
        .get('db')
        .select({ email: invitations.email })
        .from(invitations)
        .where(and(inArray(invitations.email, exactEmailGrants), ne(invitations.status, 'revoked')))
    : [];
  const invitedEmails = new Set(invitationGrants.map(({ email }) => email));
  const invitationGrantIndexes = new Map(
    signup.entries.flatMap((entry, index) =>
      entry.type === 'email' &&
      !entry.pattern.startsWith('*@') &&
      invitedEmails.has(entry.pattern.toLowerCase())
        ? [[entry.pattern.toLowerCase(), index] as const]
        : [],
    ),
  );
  const directEntries = signup.entries
    .map((entry, index) => ({ ...entry, index }))
    .filter(
      (entry) =>
        entry.type !== 'email' ||
        entry.pattern.startsWith('*@') ||
        !invitedEmails.has(entry.pattern.toLowerCase()),
    );
  const apiUrl = getPlatformApiUrl(context.env, context.req.url);
  return {
    id: path,
    ...signup,
    directEntries,
    initialized: authentication.initialized,
    revision: authentication.initialized ? authentication.revision : null,
    methods: authentication.methods.map(({ id, kind, label, enabled }) => ({
      id,
      kind,
      label,
      enabled,
    })),
    protection: Boolean(authentication.protection),
    invitations: invitationPage.invitations.map((invitation) => ({
      ...invitation,
      grantIndex:
        invitation.status === 'revoked'
          ? null
          : (invitationGrantIndexes.get(invitation.email.toLowerCase()) ?? null),
    })),
    page: invitationPage.page,
    totalPages: invitationPage.totalPages,
    emailEnabled: Boolean(context.env.EMAIL),
    connectCommand: platformConnectCommand(apiUrl),
    inviteUrl: `${apiUrl}/invite`,
    result: url.searchParams.get('result') === 'invited' ? 'invited' : null,
    tz: requestTimezone(context),
  };
}

export async function loadInvitationsPage(context: AdminContext, path: string) {
  const url = pageLocation(path, '/admin/invitations');
  const page = pageNumber(url);
  const { listOperatorInvitations } = await import('../../operator/access-service.ts');
  const result = await listOperatorInvitations(context.get('db'), {
    page,
    limit: 50,
    offset: (page - 1) * 50,
  });
  return {
    id: path,
    invitations: result.invitations,
    page,
    totalPages: result.totalPages,
    tz: requestTimezone(context),
  };
}

export async function loadAuthSettingsPage(context: AdminContext, path: string) {
  const url = pageLocation(path, '/admin/config/auth');
  const { getAuthenticationConfiguration } = await import('../../operator/auth-config.ts');
  const data = await getAuthenticationConfiguration(context);
  const testId = url.searchParams.get('test');
  const [tested] = testId
    ? await context
        .get('db')
        .select()
        .from(platformLoginTests)
        .where(
          and(
            eq(platformLoginTests.id, testId),
            eq(platformLoginTests.user_id, context.get('user').id),
            gt(platformLoginTests.expires_at, new Date().toISOString()),
          ),
        )
    : [];
  return { id: path, data, tested };
}

export async function loadAuthNewPage(context: AdminContext, path: string) {
  const url = pageLocation(path, '/admin/config/auth/new');
  const kind = url.searchParams.get('kind') as PlatformLoginConfiguration['kind'];
  if (!PLATFORM_LOGIN_KINDS.includes(kind)) {
    throw new OperatorError(400, 'Select a supported login method.');
  }
  const connectionId = kind === 'oidc' ? 'company' : kind === 'cloudflare-access' ? 'access' : kind;
  return {
    id: path,
    kind,
    connectionId,
    callbackUrl: context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href,
  };
}

export async function loadAuthEditPage(context: AdminContext, path: string) {
  const { id } = detailLocation(path, '/admin/config/auth/connections/');
  const { getAuthenticationConfiguration } = await import('../../operator/auth-config.ts');
  const data = await getAuthenticationConfiguration(context);
  const method = data.methods.find((method) => method.id === id);
  if (
    !method ||
    !('configuration' in method) ||
    !method.configuration ||
    !('revision' in method) ||
    typeof method.revision !== 'number'
  ) {
    throw new OperatorError(404, 'Login method not found.');
  }
  return {
    id: path,
    configuration: parsePlatformLoginConfiguration(method.configuration),
    label: method.label,
    revision: method.revision,
    callbackUrl: context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href,
  };
}

function requireEmail(context: AdminContext) {
  if (!getPlatformCapabilities(context.env).email) {
    throw new OperatorError(501, 'Email is not enabled on this platform');
  }
}

export async function loadEmailSettingsPage(context: AdminContext, path: string) {
  pageLocation(path, '/admin/email');
  requireEmail(context);
  const { loadEmailSettingsData } = await import('../routes/email.tsx');
  return { id: path, ...(await loadEmailSettingsData(context)) };
}

export async function loadEmailProjectPage(context: AdminContext, path: string) {
  const { id } = detailLocation(path, '/admin/email/');
  requireEmail(context);
  const { loadEmailProjectData } = await import('../routes/email.tsx');
  return { id: path, ...(await loadEmailProjectData(context, id)) };
}

/**
 * A fixed, redacted view of the Zero Trust status. It leaves out the stored
 * credential, the configuration revision, and the managed Access application
 * identifiers. `?check=1` adds the live Cloudflare Access check.
 */
export async function loadZeroTrustPage(context: AdminContext, path: string) {
  const url = pageLocation(path, '/admin/zero-trust');
  const { zeroTrustStatus } = await import('../../zero-trust/status.ts');
  const status = await zeroTrustStatus(context.env, context.get('db'), {
    check: url.searchParams.get('check') === '1',
  });
  const saved = 'accountId' in status ? status : null;
  return {
    id: path,
    configured: status.configured,
    enabled: status.enabled,
    status: 'status' in status ? status.status : null,
    accountId: saved?.accountId ?? null,
    teamDomain: saved?.teamDomain ?? null,
    identityProviderIds: [...(saved?.identityProviderIds ?? [])],
    policyIds: [...(saved?.policyIds ?? [])],
    protectNewProjects: saved?.protectNewProjects ?? null,
    operation: saved?.operation
      ? {
          kind: saved.operation.kind,
          phase: saved.operation.phase,
          existingProjects: saved.operation.existingProjects,
        }
      : null,
    lastError: 'lastError' in status ? status.lastError : null,
    checked: 'checked' in status ? status.checked : false,
    live: status.live ? { present: status.live.present, drifted: status.live.drifted } : null,
    projects: status.projects.map((entry) => ({
      desiredProtected: entry.desiredProtected,
      effectiveProtected: entry.effectiveProtected,
      state: entry.state,
      count: entry.count,
    })),
  };
}

export async function loadPlansPage(context: AdminContext, path: string) {
  const url = new URL(path, 'https://admin.invalid');
  const home = '/admin/config/plans';
  if (!path.startsWith(home) || url.origin !== 'https://admin.invalid') {
    throw new OperatorError(400, 'Invalid plans page request.');
  }
  const match = /^\/admin\/config\/plans\/([a-z][a-z0-9-]{0,63})\/edit$/.exec(url.pathname);
  if (url.pathname !== home && url.pathname !== home + '/new' && !match) {
    throw new OperatorError(400, 'Invalid plans page request.');
  }
  const initialPlanDefault = initialPlanDefaultFor(context.env);
  const { readPlanAiLoggingProgress } = await import('../../ai-logging-plans.ts');
  const [data, aiLogging] = await Promise.all([
    readPlanCatalogWithAccounts(context.get('db'), initialPlanDefault),
    readPlanAiLoggingProgress(context.get('db'), initialPlanDefault),
  ]);
  const selectedPlanId = match?.[1] ?? null;
  if (selectedPlanId && !data.catalog.plans.some((plan) => plan.id === selectedPlanId)) {
    throw new OperatorError(404, 'Plan not found.');
  }
  return { id: path, ...data, aiLogging, selectedPlanId };
}
