import {
  createFateServer,
  createHonoFateHandler,
  dataView,
  hasNestedSelection,
  list,
  resolveSourceById,
} from '@nkzw/fate/server';
import type { Entity, SourceDefinition, SourcePlan, SourceRegistry } from '@nkzw/fate/server';
import type { Context } from 'hono';
import type { ApiEnv } from '../../env.ts';
import {
  getTopProjectsLastHour,
  systemHealth,
  systemOverviewBase,
} from '../../operator/system-operations.ts';
import { projectWithUrl } from '../../project-url.ts';
import { requestTimezone } from './page-data.ts';
import { PageRoot, pageQueries, pageRegistry, pageSourceByType } from './page-server.ts';
import {
  telemetryQueries,
  telemetryRegistry,
  telemetryRoot,
  telemetrySources,
} from './telemetry.ts';
export type {
  AdminPlans,
  AdminUsersPage,
  AdminProjectsPage,
  AdminDeploymentsPage,
  AdminUserDetail,
  AdminProjectDetail,
  AdminDeploymentDetail,
  AdminBuildDetail,
  AdminCliVersions,
  AdminSignup,
  AdminInvitations,
  AdminAuthSettings,
  AdminAuthNew,
  AdminAuthEdit,
  AdminEmailSettings,
  AdminEmailProject,
  AdminZeroTrust,
} from './page-server.ts';
export type { AdminBuildLogs, AdminBuildStatus, AdminDeploymentLogs } from './telemetry.ts';

type AdminContext = Context<ApiEnv>;
type TopProjectRecord = Awaited<ReturnType<typeof getTopProjectsLastHour>>[number] & {
  url?: string;
};
type DashboardRecord = Awaited<ReturnType<typeof systemOverviewBase>> & {
  id: string;
  userCount: number;
  projectCount: number;
  deploymentCount: number;
  tz: string | undefined;
  topProjects?: Array<TopProjectRecord>;
};
type HealthRecord = Awaited<ReturnType<typeof systemHealth>> & { id: string; checkedAt: number };

export const healthDataView = dataView<HealthRecord>('AdminHealth')({
  id: true,
  allOk: true,
  checks: true,
  checkedAt: true,
});

export const topProjectDataView = dataView<TopProjectRecord>('AdminTopProject')({
  id: true,
  user_id: true,
  slug: true,
  type: true,
  owner_login: true,
  requests: true,
  bandwidthBytes: true,
  lastSeen: true,
  url: true,
});

export const dashboardDataView = dataView<DashboardRecord>('AdminDashboard')({
  id: true,
  userCount: true,
  projectCount: true,
  deploymentCount: true,
  projects: true,
  deployments: true,
  siteDomain: true,
  tz: true,
  topProjects: list(topProjectDataView),
});

export type AdminTopProject = Entity<typeof topProjectDataView, 'AdminTopProject'>;
export type AdminHealth = Entity<typeof healthDataView, 'AdminHealth'>;
export type AdminDashboard = Entity<
  typeof dashboardDataView,
  'AdminDashboard',
  { topProjects: Array<AdminTopProject> }
>;

const topProjectSource: SourceDefinition<TopProjectRecord> = {
  id: 'id',
  view: topProjectDataView,
};
const healthSource: SourceDefinition<HealthRecord> = { id: 'id', view: healthDataView };
const dashboardSource: SourceDefinition<DashboardRecord> = {
  id: 'id',
  view: dashboardDataView,
  relations: {
    topProjects: {
      kind: 'many',
      foreignKey: 'dashboardId',
      localKey: 'id',
      source: topProjectSource,
    },
  },
};

const registry: SourceRegistry<AdminContext> = new Map(pageRegistry);
for (const [source, handler] of telemetryRegistry) {
  registry.set(source, handler);
}
registry.set(dashboardSource, {
  byIds: async ({
    ctx,
    ids,
    plan,
  }: {
    ctx: AdminContext;
    ids: Array<string>;
    plan: SourcePlan<DashboardRecord, AdminContext>;
  }) => {
    const needsTopProjects = hasNestedSelection(plan.selectedPaths, 'topProjects');
    const needsBase = [...plan.selectedPaths].some(
      (path) => path !== 'id' && !path.startsWith('topProjects.'),
    );
    const [base, topProjects] = await Promise.all([
      needsBase ? systemOverviewBase(ctx.get('db'), ctx.env) : null,
      needsTopProjects ? getTopProjectsLastHour(ctx.get('db'), ctx.env) : null,
    ]);
    return ids
      .filter((id) => id === 'overview')
      .map((id) => ({
        id,
        tz: requestTimezone(ctx),
        ...(base
          ? {
              ...base,
              userCount: base.stats.users,
              projectCount: base.stats.projects,
              deploymentCount: base.stats.deployments,
              projects: base.projects.map((project) => projectWithUrl(project, ctx.env)),
            }
          : {}),
        ...(topProjects
          ? {
              topProjects: topProjects.map((project) => projectWithUrl(project, ctx.env)),
            }
          : {}),
      })) as Array<DashboardRecord>;
  },
});
registry.set(topProjectSource, {});
registry.set(healthSource, {
  byIds: async ({ ctx, ids }) => {
    if (!ids.includes('health')) {
      return [];
    }
    const health = await systemHealth(ctx.get('db'), ctx.env, ctx.req.url);
    return [{ id: 'health', ...health, checkedAt: Date.now() }];
  },
});

const sources = {
  getSource: <Item extends Record<string, unknown>>(
    target: { typeName: string } | SourceDefinition<Item>,
  ) => {
    const typeName = 'view' in target ? target.view.typeName : target.typeName;
    const source =
      typeName === 'AdminTopProject'
        ? topProjectSource
        : typeName === 'AdminHealth'
          ? healthSource
          : typeName === 'AdminDashboard'
            ? dashboardSource
            : (pageSourceByType.get(typeName) ?? telemetrySources.get(typeName));
    if (!source) {
      throw new Error(`Unknown admin Fate source: ${typeName}`);
    }
    return source as SourceDefinition<Item>;
  },
  registry,
};

export const Root = {
  dashboard: dashboardDataView,
  health: healthDataView,
  ...PageRoot,
  ...telemetryRoot,
};

export const fateServer = createFateServer({
  context: ({ adapterContext }: { adapterContext?: AdminContext }) => {
    if (!adapterContext) {
      throw new Error('Admin Fate requires an authenticated request context.');
    }
    return adapterContext;
  },
  queries: {
    health: {
      resolve: ({ ctx, select }: { ctx: AdminContext; select: Array<string> }) =>
        resolveSourceById({
          ctx,
          id: 'health',
          input: { select },
          registry,
          source: healthSource,
        }),
    },
    dashboard: {
      resolve: ({ ctx, select }: { ctx: AdminContext; select: Array<string> }) =>
        resolveSourceById({
          ctx,
          id: 'overview',
          input: { select },
          registry,
          source: dashboardSource,
        }),
    },
    ...pageQueries,
    ...telemetryQueries,
  },
  roots: Root,
  sources,
});

export const adminFateHandler = createHonoFateHandler(fateServer);
