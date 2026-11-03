import {
  dataView,
  FateRequestError,
  resolveSourceById,
  type Entity,
  type SourceDefinition,
  type SourceRegistry,
} from '@nkzw/fate/server';
import type { Context } from 'hono';
import { isTerminalBuildStatus } from '../../build-status.ts';
import { getBuild } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { buildLogs } from '../../operator/build-operations.ts';
import { OperatorError } from '../../operator/common.ts';
import { deploymentLogs } from '../../operator/deployment-operations.ts';

type AdminContext = Context<ApiEnv>;
type BuildLogRecord = Awaited<ReturnType<typeof buildLogs>> & { id: string };
type BuildStatusRecord = { id: string; status: string; terminal: boolean };
type DeploymentLogRecord = Awaited<ReturnType<typeof deploymentLogs>> & { id: string };

export const buildLogsDataView = dataView<BuildLogRecord>('AdminBuildLogs')({
  id: true,
  lines: true,
  lastSeq: true,
  terminal: true,
  logsComplete: true,
});
export const buildStatusDataView = dataView<BuildStatusRecord>('AdminBuildStatus')({
  id: true,
  status: true,
  terminal: true,
});
export const deploymentLogsDataView = dataView<DeploymentLogRecord>('AdminDeploymentLogs')({
  id: true,
  data: true,
  runtimeLogs: true,
});

export type AdminBuildLogs = Entity<typeof buildLogsDataView, 'AdminBuildLogs'>;
export type AdminBuildStatus = Entity<typeof buildStatusDataView, 'AdminBuildStatus'>;
export type AdminDeploymentLogs = Entity<typeof deploymentLogsDataView, 'AdminDeploymentLogs'>;

const buildLogSource: SourceDefinition<BuildLogRecord> = { id: 'id', view: buildLogsDataView };
const buildStatusSource: SourceDefinition<BuildStatusRecord> = {
  id: 'id',
  view: buildStatusDataView,
};
const deploymentLogSource: SourceDefinition<DeploymentLogRecord> = {
  id: 'id',
  view: deploymentLogsDataView,
};

function args(input: { args?: Record<string, unknown> }) {
  return input.args ?? {};
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new FateRequestError('BAD_REQUEST', 'A valid admin resource ID is required.');
  }
  return value;
}

function decodeKey(id: string): Array<unknown> {
  try {
    const value: unknown = JSON.parse(id);
    if (Array.isArray(value)) {
      return value;
    }
  } catch {
    // Invalid client arguments are reported below.
  }
  throw new FateRequestError('BAD_REQUEST', 'Invalid admin log request.');
}

function translateOperatorError(error: unknown): never {
  if (error instanceof OperatorError) {
    throw new FateRequestError(error.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', error.message, {
      status: error.status,
    });
  }
  throw error;
}

export const telemetryRegistry: SourceRegistry<AdminContext> = new Map();
telemetryRegistry.set(buildLogSource, {
  byIds: async ({ ctx, ids }) =>
    Promise.all(
      ids.map(async (key) => {
        const [rawId, rawSince] = decodeKey(key);
        const id = requiredId(rawId);
        if (!Number.isSafeInteger(rawSince) || (rawSince as number) < 0) {
          throw new FateRequestError('BAD_REQUEST', 'Invalid build log cursor.');
        }
        try {
          return { id: key, ...(await buildLogs(ctx.get('db'), ctx.env, id, rawSince as number)) };
        } catch (error) {
          translateOperatorError(error);
        }
      }),
    ),
});
telemetryRegistry.set(buildStatusSource, {
  byIds: async ({ ctx, ids }) =>
    Promise.all(
      ids.map(async (id) => {
        requiredId(id);
        const build = await getBuild(ctx.get('db'), id);
        if (!build) {
          throw new FateRequestError('NOT_FOUND', 'Build not found.');
        }
        return { id, status: build.status, terminal: isTerminalBuildStatus(build.status) };
      }),
    ),
});
telemetryRegistry.set(deploymentLogSource, {
  byIds: async ({ ctx, ids }) =>
    Promise.all(
      ids.map(async (key) => {
        const [rawId, rawSince, rawLimit] = decodeKey(key);
        const id = requiredId(rawId);
        if (typeof rawSince !== 'string' || !Number.isSafeInteger(rawLimit)) {
          throw new FateRequestError('BAD_REQUEST', 'Invalid deployment log request.');
        }
        try {
          return {
            id: key,
            ...(await deploymentLogs(ctx.get('db'), ctx.env, id, {
              since: rawSince,
              limit: rawLimit as number,
              order: 'newest-first',
            })),
          };
        } catch (error) {
          translateOperatorError(error);
        }
      }),
    ),
});

export const telemetrySources = new Map<string, SourceDefinition>([
  ['AdminBuildLogs', buildLogSource],
  ['AdminBuildStatus', buildStatusSource],
  ['AdminDeploymentLogs', deploymentLogSource],
]);

export const telemetryRoot = {
  buildLogs: buildLogsDataView,
  buildStatus: buildStatusDataView,
  deploymentLogs: deploymentLogsDataView,
};

export const telemetryQueries = {
  buildLogs: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: JSON.stringify([requiredId(args(input).id), args(input).since]),
        input: { select },
        registry: telemetryRegistry,
        source: buildLogSource,
      }),
  },
  buildStatus: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: requiredId(args(input).id),
        input: { select },
        registry: telemetryRegistry,
        source: buildStatusSource,
      }),
  },
  deploymentLogs: {
    resolve: ({
      ctx,
      input,
      select,
    }: {
      ctx: AdminContext;
      input: { args?: Record<string, unknown> };
      select: Array<string>;
    }) =>
      resolveSourceById({
        ctx,
        id: JSON.stringify([requiredId(args(input).id), args(input).since, args(input).limit]),
        input: { select },
        registry: telemetryRegistry,
        source: deploymentLogSource,
      }),
  },
};
