import { isRecord } from '@void/deploy-core';
import { clientSchema, dataView, memo, type EntityOf } from 'react-fate';
import { createFateClient } from './client.generated.ts';
import type {
  AdminDeploymentDetail as ServerDeploymentDetail,
  AdminDeploymentsPage as ServerDeploymentsPage,
  AdminProjectsPage as ServerProjectsPage,
  AdminUsersPage as ServerUsersPage,
} from './server.ts';

type Suggestion = { id: string; label: string; description: string };

type LogSettings = {
  logRange: string;
  logLimit: number;
  logFilter: string;
};

const schema = clientSchema({
  typeExtensions: {
    AdminUsersPage: {
      defaults: () => ({}),
      view: dataView<ServerUsersPage>('AdminUsersPage')({
        suggestions: memo<ServerUsersPage, Array<Suggestion>, unknown, { users: true }>({
          select: { users: true },
          resolve: (_page: ServerUsersPage, { users }) =>
            users.map((user) => ({
              id: user.id,
              label: user.login,
              description: [user.email, user.id].filter(Boolean).join(' · '),
            })),
        }),
      }),
    },
    AdminProjectsPage: {
      defaults: () => ({}),
      view: dataView<ServerProjectsPage>('AdminProjectsPage')({
        suggestions: memo<ServerProjectsPage, Array<Suggestion>, unknown, { projects: true }>({
          select: { projects: true },
          resolve: (_page: ServerProjectsPage, { projects }) =>
            projects.map((project) => ({
              id: project.id,
              label: project.slug,
              description: project.owner_login ?? '',
            })),
        }),
      }),
    },
    AdminDeploymentsPage: {
      defaults: () => ({}),
      view: dataView<ServerDeploymentsPage>('AdminDeploymentsPage')({
        suggestions: memo<ServerDeploymentsPage, Array<Suggestion>, unknown, { deployments: true }>(
          {
            select: { deployments: true },
            resolve: (_page: ServerDeploymentsPage, { deployments }) =>
              deployments.map((deployment) => ({
                id: deployment.id,
                label: deployment.id,
                description: [deployment.project_slug, deployment.status]
                  .filter(Boolean)
                  .join(' · '),
              })),
          },
        ),
      }),
    },
    AdminDeploymentDetail: {
      defaults: () => ({ logRange: '1h', logLimit: 100, logFilter: '' }),
      view: dataView<ServerDeploymentDetail & LogSettings>('AdminDeploymentDetail')({
        logRange: true,
        logLimit: true,
        logFilter: true,
        manifestJson: memo<ServerDeploymentDetail, string, unknown, { manifest: true }>({
          select: { manifest: true },
          resolve: (_page: ServerDeploymentDetail, { manifest }) =>
            JSON.stringify(manifest, null, 2),
        }),
      }),
    },
  },
});

const logSettingsInput = {
  parse(input: unknown) {
    if (
      !isRecord(input) ||
      typeof input.id !== 'string' ||
      (input.logRange !== undefined &&
        (typeof input.logRange !== 'string' ||
          !['1h', '6h', '24h', '7d'].includes(input.logRange))) ||
      (input.logLimit !== undefined &&
        (typeof input.logLimit !== 'number' ||
          !Number.isSafeInteger(input.logLimit) ||
          input.logLimit < 1 ||
          input.logLimit > 1000)) ||
      (input.logFilter !== undefined && typeof input.logFilter !== 'string')
    ) {
      throw new Error('Invalid runtime log settings.');
    }
    return {
      id: input.id,
      ...(input.logRange !== undefined ? { logRange: input.logRange } : {}),
      ...(input.logLimit !== undefined ? { logLimit: input.logLimit } : {}),
      ...(input.logFilter !== undefined ? { logFilter: input.logFilter } : {}),
    };
  },
};

/** Register client fields before either SSR hydration or browser requests. */
export const createAdminFateClient = (options: Parameters<typeof createFateClient>[0]) =>
  createFateClient(options).registerClientSchema(schema, ({ mutation }) => ({
    'deploymentLogs.configure': mutation('AdminDeploymentDetail', {
      input: logSettingsInput,
      resolve: ({ input: { id, ...settings }, store }) =>
        store.update('AdminDeploymentDetail', id, settings),
    }),
  }));

export type AdminFateClient = ReturnType<typeof createAdminFateClient>;
export type AdminUsersPage = EntityOf<AdminFateClient, 'AdminUsersPage'>;
export type AdminProjectsPage = EntityOf<AdminFateClient, 'AdminProjectsPage'>;
export type AdminDeploymentsPage = EntityOf<AdminFateClient, 'AdminDeploymentsPage'>;
export type AdminDeploymentDetail = EntityOf<AdminFateClient, 'AdminDeploymentDetail'>;

declare module '@nkzw/fate' {
  interface ClientRegistration {
    client: AdminFateClient;
  }
}
