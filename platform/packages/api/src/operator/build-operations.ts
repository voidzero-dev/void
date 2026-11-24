import { buildManagerNamespace } from '../build-namespace.ts';
import { isTerminalBuildStatus } from '../build-status.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import { getBuild } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from './common.ts';

export async function buildDetail(db: Db, id: string) {
  const build = await getBuild(db, id);
  if (!build) {
    throw new OperatorError(404, 'Build not found.');
  }
  return { build, terminal: isTerminalBuildStatus(build.status) };
}

export async function buildLogs(
  db: Db,
  env: ApiEnv['Bindings'],
  id: string,
  since = 0,
  limit?: number,
) {
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new OperatorError(400, 'since must be a nonnegative integer cursor.');
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) {
    throw new OperatorError(400, 'limit must be between 1 and 500.');
  }
  const { build, terminal } = await buildDetail(db, id);
  if (build.executor !== 'container') {
    return {
      lines: [],
      lastSeq: since,
      external: build.logs_url ?? null,
      status: build.status,
      terminal,
      logsComplete: terminal,
    };
  }
  if (!getPlatformCapabilities(env).managedBuilds) {
    throw new OperatorError(
      501,
      'This platform does not enable managed builds.',
      'capability_unavailable',
    );
  }
  const ns = buildManagerNamespace(env, build.instance_type);
  if (!ns) {
    throw new OperatorError(501, 'The build log service is unavailable.', 'capability_unavailable');
  }
  const stub = ns.get(ns.idFromName(build.id));
  const response = await stub.fetch(`http://manager/logs?since=${since}`);
  if (!response.ok) {
    throw new OperatorError(502, `Build log service failed (${response.status}).`);
  }
  const body = (await response.json()) as {
    lines: Array<{ seq: number; line: string; stream: string; ts: number }>;
    lastSeq: number;
    status?: string | null;
    terminal?: boolean;
    logsComplete?: boolean | null;
  };
  if (
    !Array.isArray(body.lines) ||
    !Number.isSafeInteger(body.lastSeq) ||
    body.lastSeq < 0 ||
    (body.logsComplete !== undefined &&
      body.logsComplete !== null &&
      typeof body.logsComplete !== 'boolean')
  ) {
    throw new OperatorError(502, 'Build log service returned an invalid response.');
  }
  const lines = limit === undefined ? body.lines : body.lines.slice(0, limit);
  const hasMore = lines.length < body.lines.length;
  const lastSeq = hasMore ? lines.at(-1)?.seq : body.lastSeq;
  if (!Number.isSafeInteger(lastSeq)) {
    throw new OperatorError(502, 'Build log service returned an invalid sequence.');
  }
  return {
    ...body,
    lines,
    hasMore,
    lastSeq: Math.max(since, lastSeq!),
    status: body.status ?? build.status,
    terminal: body.terminal === true || terminal,
    // A terminal row that was never claimed could not have had a container log
    // producer. For started builds, terminal status alone is not drain proof.
    logsComplete: body.logsComplete ?? (terminal && build.started_at === null ? true : null),
  };
}
