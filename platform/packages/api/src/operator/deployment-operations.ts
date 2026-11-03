import { and, count, desc, eq, getTableColumns, ilike, or } from 'drizzle-orm';
import { cancelDeployment, getDeployment, getProject, type Db } from '../db.ts';
import { type ApiEnv, isDevBypass } from '../env.ts';
import { LOG_ROW_GROUP_BY, runtimeLogsField } from '../observability/log-rows.ts';
import { deployments, projects } from '../schema.ts';
import { OperatorError } from './common.ts';

export const CANCELABLE_DEPLOYMENT_STATUSES = new Set([
  'pending',
  'uploading',
  'migrating',
  'prerendering',
  'canceling',
]);
const DEPLOYMENT_STATUSES = new Set([
  ...CANCELABLE_DEPLOYMENT_STATUSES,
  'cutover',
  'compensating',
  'live',
  'failed',
  'canceled',
]);

export async function listOperatorDeployments(
  db: Db,
  options: {
    page: number;
    limit: number;
    offset: number;
    search?: string;
    project?: string;
    status?: string;
  },
) {
  if (options.status && !DEPLOYMENT_STATUSES.has(options.status)) {
    throw new OperatorError(400, 'Unknown deployment status.');
  }
  const pattern = options.search ? `%${options.search}%` : undefined;
  const where = and(
    options.project
      ? or(eq(projects.id, options.project), eq(projects.slug, options.project))
      : undefined,
    options.status
      ? eq(deployments.status, options.status as typeof deployments.$inferSelect.status)
      : undefined,
    pattern
      ? or(
          ilike(deployments.id, pattern),
          ilike(projects.slug, pattern),
          ilike(deployments.status, pattern),
          ilike(deployments.commit, pattern),
          ilike(deployments.source, pattern),
          ilike(deployments.cli_version, pattern),
        )
      : undefined,
  );
  const [rows, totals] = await Promise.all([
    db
      .select({
        ...getTableColumns(deployments),
        project_slug: projects.slug,
        active_deployment_id: projects.active_deployment_id,
      })
      .from(deployments)
      .leftJoin(projects, eq(deployments.project_id, projects.id))
      .where(where)
      .orderBy(desc(deployments.created_at), desc(deployments.id))
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ total: count() })
      .from(deployments)
      .leftJoin(projects, eq(deployments.project_id, projects.id))
      .where(where),
  ]);
  return {
    deployments: rows,
    page: options.page,
    limit: options.limit,
    total: totals[0]?.total ?? 0,
  };
}

export async function deploymentDetail(db: Db, id: string) {
  const deployment = await getDeployment(db, id);
  if (!deployment) {
    throw new OperatorError(404, 'Deployment not found.');
  }
  const project = await getProject(db, deployment.project_id);
  return { deployment, project };
}

export async function requestDeploymentCancellation(db: Db, id: string, dryRun = false) {
  const { deployment } = await deploymentDetail(db, id);
  if (
    !CANCELABLE_DEPLOYMENT_STATUSES.has(deployment.status) ||
    deployment.source === 'rollback-lease'
  ) {
    throw new OperatorError(409, `Deployment cannot be canceled while ${deployment.status}.`);
  }
  if (dryRun) {
    return deployment;
  }
  const updated = await cancelDeployment(db, deployment.id, 'canceled by admin');
  if (!updated) {
    throw new OperatorError(
      409,
      'Deployment changed before cancellation. Inspect its current status.',
    );
  }
  return updated;
}

function parseSince(since: string): number {
  const duration = /^(\d+)([mhd])$/.exec(since);
  const multipliers: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 };
  const parsed = duration
    ? Date.now() - Number(duration[1]) * multipliers[duration[2]]
    : /^\d+$/.test(since)
      ? Number(since)
      : Date.parse(since);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 8640000000000000) {
    throw new OperatorError(
      400,
      'since must be a duration (such as 1h), ISO date, or epoch milliseconds.',
    );
  }
  return parsed;
}

function sqlString(value: string) {
  return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
}
function tryParse(value: string): ReadonlyArray<unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function analyticsTimestamp(value: string | number): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
    throw new OperatorError(502, 'Log query returned an invalid Analytics timestamp.');
  }
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(utc);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OperatorError(502, 'Log query returned an invalid Analytics timestamp.');
  }
  return parsed;
}

type LogRow = {
  outcome: string;
  logData: string;
  exceptionData: string;
  url: string;
  method: string;
  statusCode: string;
  ts: number;
  ingestedAt: string | number;
};

const FOLLOW_OVERLAP_MS = 5 * 60 * 1000;

function parseFollowAfter(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new OperatorError(400, 'Invalid deployment log follow cursor.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > Date.now()) {
    throw new OperatorError(400, 'Invalid deployment log follow cursor.');
  }
  return parsed;
}

/** Historical Analytics Engine pages use a fixed upper bound; clients exhaust nextCursor before advancing to watermark. */
export async function deploymentLogs(
  db: Db,
  env: ApiEnv['Bindings'],
  id: string,
  options: {
    since?: string;
    limit?: number;
    cursor?: string;
    order?: 'oldest-first' | 'newest-first';
    after?: string;
  } = {},
) {
  const { deployment, project } = await deploymentDetail(db, id);
  if (!project) {
    throw new OperatorError(404, 'Project not found.');
  }
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new OperatorError(400, 'limit must be between 1 and 500.');
  }
  // The admin browser requests newest-first pages and treats `since` as an
  // ingestion-time window: a long-running request that started before the
  // window can still finish and emit a new error inside it. Operator history is
  // oldest-first and remains event-time based; operator follow switches to the
  // ingestion clock explicitly through `after` and keeps its overlap protocol.
  const clock: 'event' | 'ingestion' =
    options.after !== undefined || options.order === 'newest-first' ? 'ingestion' : 'event';
  let since =
    options.after === undefined
      ? parseSince(options.since ?? '1h')
      : Math.max(0, parseFollowAfter(options.after) - FOLLOW_OVERLAP_MS);
  let until = Math.floor(Date.now() / 1000) * 1000;
  let offset = 0;
  if (options.cursor) {
    try {
      const parsed = JSON.parse(atob(options.cursor)) as {
        id: unknown;
        since: unknown;
        until: unknown;
        offset: unknown;
        clock: unknown;
      };
      if (
        parsed.id !== id ||
        parsed.clock !== clock ||
        ![parsed.since, parsed.until, parsed.offset].every(
          (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
        ) ||
        Number(parsed.offset) > 1000000 ||
        Number(parsed.since) > Number(parsed.until) ||
        Number(parsed.until) > Date.now()
      ) {
        throw new Error('Invalid cursor');
      }
      since = Number(parsed.since);
      until = Number(parsed.until);
      offset = Number(parsed.offset);
    } catch {
      throw new OperatorError(400, 'Invalid deployment log cursor.');
    }
  }
  if (isDevBypass(env)) {
    const data = mockLogData();
    return {
      data: options.order === 'newest-first' ? data : data.reverse(),
      nextCursor: null,
      watermark: String(until),
      ...runtimeLogsField(env),
    };
  }
  const dataset = env.LOGS_DATASET ?? 'void_logs';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset)) {
    throw new OperatorError(500, 'Invalid logs dataset configuration.');
  }
  const sinceStr = new Date(since).toISOString().replace('T', ' ').slice(0, 19);
  const untilStr = new Date(until).toISOString().replace('T', ' ').slice(0, 19);
  const direction = options.order === 'newest-first' ? 'DESC' : 'ASC';
  const timeFilter =
    clock === 'ingestion'
      ? `timestamp >= toDateTime(${sqlString(sinceStr)}) AND timestamp < toDateTime(${sqlString(untilStr)})`
      : `timestamp >= toDateTime(${sqlString(sinceStr)}) AND timestamp < toDateTime(${sqlString(untilStr)}) AND double1 >= ${since} AND double1 < ${until}`;
  // A grouped query can order only by its selected aliases.
  const order =
    clock === 'ingestion'
      ? `ingestedAt ${direction}, ts ${direction}`
      : `ts ${direction}, ingestedAt ${direction}`;
  const query = `SELECT blob1 as outcome, blob2 as logData, blob3 as exceptionData, blob4 as url, blob5 as method, blob6 as statusCode, double1 as ts, min(timestamp) as ingestedAt
    FROM ${dataset} WHERE index1 = ${sqlString(`user-${project.slug}`)} AND blob7 = ${sqlString(deployment.id)}
    AND ${timeFilter}
    ${LOG_ROW_GROUP_BY}
    ORDER BY ${order}, outcome ${direction}, logData ${direction}, exceptionData ${direction}, url ${direction}, method ${direction}, statusCode ${direction} LIMIT ${limit + 1} OFFSET ${offset}`;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'text/plain' },
      body: query,
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    throw new OperatorError(502, `Log query failed (Cloudflare status ${response.status}).`);
  }
  const result = (await response.json()) as { data?: ReadonlyArray<LogRow> };
  const rows = result.data ?? [];
  const nextCursor =
    rows.length > limit
      ? btoa(JSON.stringify({ id, since, until, offset: offset + limit, clock }))
      : null;
  return {
    data: rows.slice(0, limit).map((row) => ({
      timestamp: Number(row.ts),
      outcome: row.outcome,
      logs: tryParse(row.logData),
      exceptions: tryParse(row.exceptionData),
      url: row.url,
      method: row.method,
      status: row.statusCode,
      ingestedAt: analyticsTimestamp(row.ingestedAt),
    })),
    nextCursor,
    watermark: String(until),
    ...runtimeLogsField(env),
  };
}

function mockLogData() {
  const now = Date.now();
  return [
    {
      timestamp: now - 1000,
      outcome: 'ok',
      logs: [
        { level: 'info', message: 'Incoming request: GET /api/users' },
        { level: 'debug', message: 'Cache HIT for key: users:list:page=1' },
      ],
      exceptions: [],
      url: '/api/users',
      method: 'GET',
      status: '200',
    },
    {
      timestamp: now - 5000,
      outcome: 'ok',
      logs: [{ level: 'log', message: 'POST /api/auth/login — user authenticated successfully' }],
      exceptions: [],
      url: '/api/auth/login',
      method: 'POST',
      status: '200',
    },
    {
      timestamp: now - 12000,
      outcome: 'exception',
      logs: [
        {
          level: 'error',
          message:
            'TypeError: Cannot read properties of undefined (reading "id")\n    at getUser (src/handlers/users.ts:42:18)\n    at handleRequest (src/index.ts:15:3)',
        },
      ],
      exceptions: [
        { name: 'TypeError', message: 'Cannot read properties of undefined (reading "id")' },
      ],
      url: '/api/users/999',
      method: 'GET',
      status: '500',
    },
    {
      timestamp: now - 30000,
      outcome: 'ok',
      logs: [
        {
          level: 'warn',
          message: 'Rate limit approaching: 85/100 requests in current window for IP 192.168.1.42',
        },
      ],
      exceptions: [],
      url: '/api/data/export',
      method: 'GET',
      status: '200',
    },
    {
      timestamp: now - 45000,
      outcome: 'ok',
      logs: [],
      exceptions: [],
      url: '/health',
      method: 'GET',
      status: '204',
    },
    {
      timestamp: now - 60000,
      outcome: 'ok',
      logs: [
        {
          level: 'info',
          message:
            'D1 query executed in 12ms: SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC LIMIT 20',
        },
        { level: 'info', message: 'Returning 20 posts' },
      ],
      exceptions: [],
      url: '/api/posts',
      method: 'GET',
      status: '200',
    },
    {
      timestamp: now - 90000,
      outcome: 'canceled',
      logs: [{ level: 'warn', message: 'Request canceled by client before completion' }],
      exceptions: [],
      url: '/api/reports/generate',
      method: 'POST',
      status: '499',
    },
  ].map((entry) => ({ ...entry, ingestedAt: entry.timestamp }));
}
