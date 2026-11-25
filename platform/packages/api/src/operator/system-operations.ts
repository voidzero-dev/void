import { platformHealthHostname, readPlatformApplication } from '@void/platform';
import { sql } from 'drizzle-orm';
import { backfillQueueTokens } from '../admin/backfill-queue-tokens.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import { DEFAULT_DISPATCH_NAMESPACE, SITE_DOMAIN } from '../constants.ts';
import {
  getAllDeploymentsWithProject,
  getAllProjectsWithOwner,
  getCliVersionDeploymentStats,
  getProjectsWithOwnerByIds,
  getSystemStats,
} from '../db.ts';
import type { Db } from '../db.ts';
import { isDevBypass } from '../env.ts';
import type { ApiEnv } from '../env.ts';
import { getRequestsDataset, queryTopProjectTraffic } from '../routes/usage.ts';

/** Derive the base cloud domain from the API request hostname.
 *  api.void.cloud → void.cloud, api.staging.void.cloud → staging.void.cloud */
function cloudDomainFromHost(host: string): string {
  return host.replace(/^api\./, '');
}

export type HealthCheck = Readonly<{
  name: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}>;

export type HealthResult = Readonly<{
  checks: ReadonlyArray<HealthCheck>;
  allOk: boolean;
}>;

export function systemHealthCheckNames(installed: boolean): ReadonlyArray<string> {
  return ['api', 'proxy', ...(installed ? [] : ['dashboard']), 'dispatch', 'db'];
}

async function checkUrl(
  name: string,
  url: string,
  headers?: Record<string, string>,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const res = await request(url, {
      headers,
      // Do not forward probe credentials to a login redirect or treat its HTML
      // login page as a successful health check.
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    void res.body?.cancel().catch(() => {});
    return {
      name,
      ok: res.ok,
      latencyMs: Date.now() - start,
      ...(!res.ok
        ? {
            error: `HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirect)' : ''}`,
          }
        : {}),
    };
  } catch (err) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - start,
      error:
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'Health check timed out after 5 seconds.'
          : 'Could not reach the service.',
    };
  }
}

async function checkDb(db: Db): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { name: 'db', ok: true, latencyMs: Date.now() - start };
  } catch {
    return {
      name: 'db',
      ok: false,
      latencyMs: Date.now() - start,
      error: 'Database query failed.',
    };
  }
}

function mockHealthResult(installed: boolean): HealthResult {
  return {
    checks: systemHealthCheckNames(installed).map((name) => ({ name, ok: true, latencyMs: 0 })),
    allOk: true,
  };
}

const TOP_PROJECT_LIMIT = 10;
const TOP_PROJECT_WINDOW_MS = 60 * 60 * 1000;

export async function getTopProjectsLastHour(db: Db, env: ApiEnv['Bindings']) {
  if (isDevBypass(env)) {
    return [];
  }

  const topTraffic = await queryTopProjectTraffic(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    getRequestsDataset(env),
    new Date(Date.now() - TOP_PROJECT_WINDOW_MS),
    TOP_PROJECT_LIMIT,
  );
  if (topTraffic.length === 0) {
    return [];
  }

  const projects = await getProjectsWithOwnerByIds(
    db,
    topTraffic.map((row) => row.projectId),
  );
  const projectMap = new Map(projects.map((project) => [project.id, project]));

  return topTraffic
    .map((row) => {
      const project = projectMap.get(row.projectId);
      if (!project) {
        return null;
      }
      return {
        ...project,
        requests: row.requests,
        bandwidthBytes: row.bandwidthBytes,
        lastSeen: row.lastSeen,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

export async function systemHealth(
  db: Db,
  env: ApiEnv['Bindings'],
  requestUrl: string,
): Promise<HealthResult> {
  const installed = Boolean(env.PLATFORM_INSTALLATION_ID);
  if (isDevBypass(env)) {
    return mockHealthResult(installed);
  }
  const cloudDomain = cloudDomainFromHost(new URL(requestUrl).hostname);
  const siteDomain = env.SITE_DOMAIN ?? SITE_DOMAIN;
  const proxyUrl = env.PROXY_URL ?? `https://proxy.${cloudDomain}`;
  let dispatchUrl: string | null = `https://test.${siteDomain}/health`;
  if (installed) {
    const application = readPlatformApplication(env);
    // Project Zero Trust covers every other project-domain hostname with Access.
    const healthHostname = platformHealthHostname(application);
    if (healthHostname) {
      dispatchUrl = `https://${healthHostname}/health`;
    } else {
      const worker = env.DISPATCH_WORKER_NAME;
      const workersDev = application.workersDev;
      dispatchUrl =
        worker &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(worker) &&
        workersDev &&
        workersDev.installationId === env.PLATFORM_INSTALLATION_ID
          ? `https://${worker}.${workersDev.subdomain}.workers.dev/health`
          : null;
    }
  }
  const proxy = env.PLATFORM_PROXY;
  const dispatchHeaders: Record<string, string> | undefined = installed
    ? env.PLATFORM_HEALTH_PROBE_TOKEN
      ? { 'X-Void-Platform-Probe': env.PLATFORM_HEALTH_PROBE_TOKEN }
      : undefined
    : { 'X-Health-Check': 'void-admin' };
  const checks = [
    { name: 'api', ok: true, latencyMs: 0 },
    ...(await Promise.all([
      checkUrl(
        'proxy',
        `${proxyUrl.replace(/\/$/, '')}/health`,
        installed ? dispatchHeaders : undefined,
        installed && proxy ? (url, init) => proxy.fetch(url, init) : undefined,
      ),
      ...(!installed
        ? [
            checkUrl(
              'dashboard',
              `${(env.DASHBOARD_URL ?? `https://dash.${cloudDomain}`).replace(/\/$/, '')}/login`,
            ),
          ]
        : []),
      !dispatchUrl || (installed && !dispatchHeaders)
        ? Promise.resolve({
            name: 'dispatch',
            ok: false,
            latencyMs: 0,
            error: !dispatchUrl
              ? 'Dispatch health endpoint is not configured for this installation.'
              : 'Platform health probe token is not configured.',
          })
        : checkUrl('dispatch', dispatchUrl, dispatchHeaders),
      checkDb(db),
    ])),
  ];
  return { checks, allOk: checks.every((check) => check.ok) };
}

export async function systemOverview(db: Db, env: ApiEnv['Bindings']) {
  const [base, topProjects] = await Promise.all([
    systemOverviewBase(db, env),
    getTopProjectsLastHour(db, env),
  ]);
  return { ...base, topProjects };
}

export async function systemOverviewBase(db: Db, env: ApiEnv['Bindings']) {
  const [stats, projects, deployments] = await Promise.all([
    getSystemStats(db),
    getAllProjectsWithOwner(db, 5, 0),
    getAllDeploymentsWithProject(db, 5, 0),
  ]);
  return {
    stats,
    projects,
    deployments,
    siteDomain: env.SITE_DOMAIN ?? SITE_DOMAIN,
    capabilities: getPlatformCapabilities(env),
    installationId: env.PLATFORM_INSTALLATION_ID ?? null,
    version: env.PLATFORM_VERSION ?? null,
  };
}

export async function cliVersionStats(db: Db) {
  const [last30Days, allTime] = await Promise.all([
    getCliVersionDeploymentStats(db, { sinceDays: 30 }),
    getCliVersionDeploymentStats(db),
  ]);
  return { last30Days, allTime };
}

export async function backfillPlatformQueueTokens(env: ApiEnv['Bindings'], dryRun = false) {
  return backfillQueueTokens(env.ROUTING, {
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN,
    dispatchNamespace: env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE,
    jwtSecret: env.JWT_SECRET,
    dryRun,
  });
}
