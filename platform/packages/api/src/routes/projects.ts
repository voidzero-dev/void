import { tokenizeSql } from '@void/deploy-core';
import type { ProjectZeroTrustRouting } from '@void/edge';
import { sql as drizzleSql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deployTokenTtlSecondsForBuildMinutes, signPrerenderToken } from '../auth/deploy-token.ts';
import { hmacSignState } from '../auth/hmac.ts';
import { buildManagerNamespace } from '../build-namespace.ts';
import { isTerminalBuildStatus } from '../build-status.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import {
  clearCronScheduler,
  restoreCronScheduler,
  snapshotCronScheduler,
  syncCronScheduler,
} from '../cron-scheduler-client.ts';
import type { Db } from '../db.ts';
import {
  createProject,
  createResource,
  getBuild,
  getProjectBuilds,
  getProjectBySlug,
  getProjectByEmailAlias,
  getAccessibleProjectsByUserId,
  getAccessibleProjectBySlug,
  getLatestDeploymentsByProjectIds,
  getProjectDeployments,
  getProjectResources,
  getActivatedDeployments,
  getTerminalFailedDeployments,
  getDomainsByProjectId,
  getDomainsByProjectIds,
  getDeployment,
  getActiveDeployment,
  createDeployment,
  deleteRollbackLease,
  updateRollbackLeaseState,
  cancelDeployment,
  getPendingDeploymentOperation,
  setActiveDeployment,
  updateProjectType,
  appendAppliedMigrations,
  appendProjectMigrations,
  activeDeploymentContainsMigration,
  getProjectMigrationRows,
  getProjectMigrationNames,
  renameAppliedMigrationsForProject,
  renameProjectMigrations,
  recordMigrationRenames,
  migrationRenameExists,
  invalidateMigrationRenamesForOldName,
  upsertProjectDatabaseUrl,
  getProjectDatabaseUrl,
  tryCreateEmailDestination,
  ACTIVE_BUILD_STATUSES,
} from '../db.ts';
import { databaseTimestampMs } from '../deploy/recovery.ts';
import { type ApiEnv, isDevBypass } from '../env.ts';
import { validateSubmittedExecutionPlans } from '../migrations/execution-plan.ts';
import { ensureTrackingTable, queryD1, runRemoteMigrations } from '../migrations/remote-runner.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../naming.ts';
import { LOG_ROW_GROUP_BY } from '../observability/log-rows.ts';
import { hasSqlState } from '../pg-errors.ts';
import { resolvePlan, resolvePlanLimits } from '../plans.ts';
import { PROJECT_PERMISSION_MESSAGES } from '../project-access.ts';
import { MAX_SLUG_LENGTH, projectNameError } from '../project-names.ts';
import { encryptProjectSecret, decryptProjectSecret } from '../project-secrets.ts';
import { ProjectRequiresNormalizationError, requireNormalizedProject } from '../project-state.ts';
import { projectWithUrl } from '../project-url.ts';
import {
  CloudflareApiError,
  InvalidHyperdriveConnectionStringError,
  addQueueConsumer,
  createHyperdrive,
  deleteHyperdrive,
  getDispatchWorkerProxyToken,
  getHyperdriveByName,
  removeQueueConsumer,
  restoreQueueConsumer,
  snapshotQueueConsumer,
  updateHyperdrive,
} from '../provisioning/cloudflare-api.ts';
import { reconcileManagedDurableObjects } from '../provisioning/durable-objects.ts';
import {
  addDestination,
  listDestinations,
  // This module has its own `isAlreadyExistsError` for CF resource
  // provisioning (see the bottom of this file); alias the Email Routing one
  // rather than shadowing it — they match different CF error wordings.
  isAlreadyExistsError as isDestinationAlreadyExistsError,
} from '../provisioning/email-routing.ts';
import { isManagedSandbox, verifySandboxController } from '../provisioning/sandbox-controller.ts';
import {
  proxyTokenRotationWarnings,
  requestRotationIfReplacingUntrustedCode,
} from '../proxy-token-rotation.ts';
import { projectRouteKey } from '../routing.ts';
import {
  buildRoutingJson,
  buildStaticRoutingJson,
  computeDispatchLimits,
  resolveRoutingUndo,
} from '../routing.ts';
import type { Build, DeployManifest, Project, ProjectRole, User } from '../types.ts';
import { ZeroTrustUnavailableError, zeroTrustNotReadyMessage } from '../zero-trust/errors.ts';
import { lockZeroTrustConfiguration } from '../zero-trust/lock.ts';
import { initializeNewProjectZeroTrust } from '../zero-trust/project.ts';
import {
  resolveProjectZeroTrustRouting,
  resolveProjectZeroTrustRoutingForPublication,
  withProjectZeroTrustRouting,
} from '../zero-trust/routing.ts';
import { publicProjectZeroTrustState } from '../zero-trust/state.ts';
import { rollbackCfDestination } from './email.ts';
import { requireProjectRouteCapability } from './project-access.ts';
import { getRequestsDataset, queryAnalyticsEngine, queryProjectRequestOverview } from './usage.ts';

const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+VIEW\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bDROP\s+TRIGGER\b/i,
  /\bDROP\s+COLUMN\b/i,
  // Match all three destructive RENAME forms SQLite accepts: `RENAME TO …`
  // (table rename), `RENAME COLUMN …` (column rename), and the legacy
  // naked-column form `RENAME <old_col> TO <new_col>` (no `COLUMN` keyword).
  // The `[^;\s]+\s+TO\b` branch covers the legacy form — any non-whitespace
  // non-semicolon token stands in for the old column name; because the
  // tokenizer replaces quoted identifiers with `"_"` / `` `_` `` / `[_]`,
  // quoted forms match the same pattern. `[^;]` on both lookaheads guards
  // against crossing a statement boundary. The legacy form is rare in
  // drizzle/modern SQL but still accepted by the engine, so skipping it
  // leaves a bypass. False positives on benign additive migrations like
  // `ALTER TABLE x ADD COLUMN rename TEXT` are avoided because the legacy
  // branch requires a following `TO` keyword — a trailing column-type
  // token never matches.
  /\bALTER\s+TABLE\b[^;]*?\bRENAME\s+(?:TO\b|COLUMN\b|[^;\s]+\s+TO\b)/i,
  /\bTRUNCATE\b/i,
  // Destructive DML forms requiring the same pragma opt-in as DDL:
  // `INSERT OR REPLACE INTO …` silently deletes any row whose primary key
  // collides with the insert, dressed up as an insert. Unbounded DELETE and
  // UPDATE checks are statement-aware below so a later statement or nested
  // subquery WHERE cannot mask an unbounded write.
  /\bINSERT\s+OR\s+REPLACE\b/i,
];

const DESTRUCTIVE_PRAGMA = '-- void:allow-destructive';

/**
 * Sentinel error used by the /rollback handler to signal an HTTP
 * response status from inside the row-locked transaction callback.
 * `db.transaction` rolls back on any throw, so we use this wrapper to
 * distinguish "user-facing 404/400" from unexpected exceptions that
 * should surface as 500. Handling is local to the /rollback handler.
 */
class RollbackError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 501,
    message: string,
    /**
     * For destructive-rollback rejections, we surface the server-computed
     * diff as a structured field alongside the error string so
     * programmatic callers (CLI retry, dashboard, MCP agent) can echo it
     * back verbatim without re-parsing the human message. Migration names
     * can contain arbitrary characters (see /rename which accepts any
     * non-empty string), so human-readable hints built via string
     * concatenation are not safe to copy-paste.
     */
    public readonly destructiveMigrations?: ReadonlyArray<string>,
    public readonly userMessage?: string,
  ) {
    super(message);
    this.name = 'RollbackError';
  }
}

async function getProjectAccessErrorBody(
  response: Response,
): Promise<{ error: string; message: string }> {
  const fallback =
    response.status === 404
      ? { error: 'project not found', message: PROJECT_PERMISSION_MESSAGES['not-found'] }
      : {
          error: 'forbidden',
          message:
            'You do not have permission for this action. Ask a project admin or owner to check your access.',
        };
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string'
    ) {
      return {
        error: body.error,
        message:
          'message' in body && typeof body.message === 'string' && body.message.trim()
            ? body.message
            : fallback.message,
      };
    }
  } catch {
    // Preserve the established fallback if a future access response is not JSON.
  }
  return fallback;
}

class DatabaseUrlPersistenceError extends Error {
  constructor(cause: unknown) {
    super('failed to persist database configuration', { cause });
    this.name = 'DatabaseUrlPersistenceError';
  }
}

type ProjectListItem = Project & {
  role: ProjectRole;
  owner: Pick<User, 'id' | 'login'>;
  url?: string;
  custom_domain: string | null;
  latest_deployment: Awaited<ReturnType<typeof getLatestDeploymentsByProjectIds>> extends Map<
    string,
    infer Deployment
  >
    ? Deployment | null
    : null;
  traffic: {
    requests5m: number;
    lastSeenAt: string | null;
    sparkline5m: ReadonlyArray<number>;
  };
  health: {
    responses4xx15m: number;
    responses5xx15m: number;
    errorRate5xx15m: number;
  };
};

function deployAttentionScore(status: string | null | undefined): number {
  if (status === 'failed') {
    return 4;
  }
  if (
    status === 'pending' ||
    status === 'uploading' ||
    status === 'migrating' ||
    status === 'prerendering' ||
    status === 'cutover' ||
    status === 'compensating' ||
    status === 'canceling'
  ) {
    return 3;
  }
  if (status === 'canceled') {
    return 1;
  }
  return 0;
}

function projectListSortScore(project: ProjectListItem): number {
  const hasRecentErrors = project.health.responses5xx15m > 0 ? 2 : 0;
  return Math.max(deployAttentionScore(project.latest_deployment?.status), hasRecentErrors);
}

function parseSortDate(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function sortProjectList(a: ProjectListItem, b: ProjectListItem): number {
  const attentionDelta = projectListSortScore(b) - projectListSortScore(a);
  if (attentionDelta !== 0) {
    return attentionDelta;
  }

  const deployDelta =
    parseSortDate(b.latest_deployment?.created_at) - parseSortDate(a.latest_deployment?.created_at);
  if (deployDelta !== 0) {
    return deployDelta;
  }

  const trafficDelta = b.traffic.requests5m - a.traffic.requests5m;
  if (trafficDelta !== 0) {
    return trafficDelta;
  }

  return a.slug.localeCompare(b.slug);
}

/**
 * Resolve the proxy token to use when re-targeting routing/cron at a
 * historical deployment.
 *
 * Preferred path: fetch the EXACT `__VOID_PROXY_TOKEN` plain_text
 * binding baked into the target worker. Rotating `JWT_SECRET` after
 * that worker was deployed would make a fresh `hmacSignState` value
 * mismatch the worker and 401 every /__void/queue and /__void/scheduled
 * relay.
 *
 * Legacy workers (deployed before the binding was introduced) report
 * `{kind: "missing"}`. Falling back to the current-secret derivation is
 * safe only if `JWT_SECRET` has not rotated since the worker was
 * deployed; the warning surfaces the risk to operators so they can
 * redeploy instead of relying on the fallback.
 *
 * Transient CF API failures MUST propagate. A silent null that becomes
 * a fallback can write a mismatched token into KV that will 401 the
 * worker indefinitely.
 */
async function resolveRollbackProxyToken(
  env: ApiEnv['Bindings'],
  workerName: string,
  projectId: string,
): Promise<string> {
  const dispatchNamespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const lookup = await getDispatchWorkerProxyToken(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    dispatchNamespace,
    workerName,
  );
  if (lookup.kind === 'found') {
    return lookup.token;
  }
  if (lookup.kind === 'error') {
    throw new Error(
      `rollback: could not read __VOID_PROXY_TOKEN from worker "${workerName}": ${lookup.error.message}`,
    );
  }
  // lookup.kind === 'missing' — legacy worker.
  console.warn(
    `[rollback] worker "${workerName}" has no __VOID_PROXY_TOKEN binding; falling back to current-secret derivation. If JWT_SECRET has rotated since this deployment was live, you must redeploy the project instead.`,
  );
  return hmacSignState(projectId, env.JWT_SECRET);
}

/**
 * D1 returns "no such table" when a table is missing. GET /:id/migrations
 * probes both `_void_migrations` and `_migrations` and must tolerate either
 * being absent, but must NOT silently swallow unrelated errors (auth failure,
 * timeout, quota, "database is locked", etc.) — those should surface to the
 * caller instead of returning an empty applied set.
 */
function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

type LineComment = Readonly<{
  text: string;
  standalone: boolean;
}>;

/**
 * Tokenize SQL into executable code and the set of line-comment lines.
 * String literals, identifier quotes, and block comments are stripped from
 * `code`; only `-- ...` line comments are accumulated into `lineComments`,
 * each tagged with whether it stood alone on its raw source line.
 *
 * This is load-bearing for four reasons:
 *
 *   1. A raw `sql.includes('-- void:allow-destructive')` check authorizes
 *      destructive SQL when the pragma appears anywhere in the file,
 *      including inside a string literal. A migration like
 *      `INSERT INTO t VALUES('-- void:allow-destructive'); DROP TABLE users;`
 *      would slip through — the pragma must only be honored when it is
 *      actually a SQL comment.
 *   2. Running destructive-pattern regexes on the raw SQL false-positives
 *      on data like `VALUES('DROP TABLE users')` and on `-- DROP TABLE`
 *      in a line comment, which could block legitimate migrations.
 *   3. Block comments are intentionally NOT counted toward the pragma. A
 *      docstring like `/* use -- void:allow-destructive to permit drops *\/`
 *      is documentation, not authorization. They are also replaced with a
 *      single space rather than deleted outright so that token boundaries
 *      are preserved — `DROP/**\/TABLE` must not collapse to `DROPTABLE`,
 *      which would slip the destructive keyword regex entirely.
 *   4. The standalone bit on each line comment lets the caller require
 *      that the destructive pragma occupies its own raw line. Trailing
 *      pragmas like `CREATE TABLE t(id); -- void:allow-destructive`
 *      must not retroactively authorize a later DROP TABLE.
 *
 * Only the SQLite lexical forms are handled: `'...'` strings with `''`
 * escape, `"..."` / `` `...` `` / `[...]` identifier quotes with doubled
 * closing-quote escape, `-- line` comments, and `/* block *\/` comments.
 */
function stripSqlStringsAndComments(sql: string): {
  code: string;
  lineComments: ReadonlyArray<LineComment>;
} {
  let code = '';
  const lineComments: Array<LineComment> = [];

  for (const seg of tokenizeSql(sql)) {
    switch (seg.kind) {
      case 'sql':
        code += sql.slice(seg.start, seg.end);
        break;
      case 'line-comment': {
        // Walk backwards from the `--` to the previous newline (or start of
        // input). The comment is "standalone" iff every character in that
        // raw-source prefix is whitespace — anything else (a SQL token, the
        // closing `*/` of a block comment, a string literal, etc.) means the
        // pragma is sharing its line with content and must not authorize.
        let standalone = true;
        for (let k = seg.start - 1; k >= 0; k--) {
          const ch = sql[k];
          if (ch === '\n') {
            break;
          }
          if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
            standalone = false;
            break;
          }
        }
        // Capture the line comment text without the trailing newline so
        // callers can compare exact directive forms.
        lineComments.push({ text: sql.slice(seg.start, seg.end), standalone });
        break;
      }
      case 'block-comment':
        // Replace the block comment with a single space so token boundaries
        // are preserved — `DROP/**/TABLE` must NOT collapse to `DROPTABLE`,
        // which would slip past the destructive regex entirely. The space
        // is sufficient because every destructive pattern requires `\b` /
        // `\s+` between keywords.
        code += ' ';
        break;
      case 'string':
        code += "''";
        break;
      case 'ident-quote': {
        // Replace the quoted identifier body with a neutral placeholder `_`
        // rather than copying the raw slice. Two bypasses hinge on this:
        //
        //   1. A semicolon inside an identifier — `ALTER TABLE "user;data"
        //      RENAME TO x` — would survive into the code stream and
        //      truncate the `[^;]*?` lookahead in the destructive ALTER
        //      RENAME regex, stopping the match at the `;` before `RENAME`
        //      and letting the destructive DDL through unauthorized.
        //   2. A destructive keyword inside an identifier — `CREATE TABLE
        //      "DROP TABLE users" (x INT)` — would false-positive against
        //      the `/\bDROP\s+TABLE\b/` regex and block a benign migration.
        //
        // The placeholder keeps the opening and closing quote characters so
        // token boundaries (`ALTER TABLE "foo" RENAME` → four tokens)
        // remain intact, but the body is fixed to `_` which cannot contain
        // semicolons or destructive keywords.
        const close = seg.open === '[' ? ']' : seg.open;
        code += seg.open + '_' + close;
        break;
      }
    }
  }

  return { code, lineComments };
}

function splitExecutableStatements(sql: string): Array<string> {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function hasTopLevelKeyword(statement: string, keyword: string): boolean {
  let depth = 0;
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index];
    if (character === '(') {
      depth++;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (
      statement.slice(index, index + keyword.length).toUpperCase() === keyword &&
      !/[A-Z0-9_]/i.test(statement[index - 1] ?? '') &&
      !/[A-Z0-9_]/i.test(statement[index + keyword.length] ?? '')
    ) {
      return true;
    }
  }
  return false;
}

function hasUnboundedWrite(statement: string): boolean {
  if (/\bDELETE\s+FROM\b/i.test(statement)) {
    return !hasTopLevelKeyword(statement, 'WHERE');
  }
  if (/\bUPDATE\b[\s\S]*\bSET\b/i.test(statement)) {
    return !hasTopLevelKeyword(statement, 'WHERE');
  }
  return false;
}

function hasUnauthorizedDestructive(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
): ReadonlyArray<string> {
  const violations: Array<string> = [];
  for (const m of migrations) {
    const { code, lineComments } = stripSqlStringsAndComments(m.sql);
    const isDestructive = splitExecutableStatements(code).some((statement) => {
      return (
        DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(statement)) ||
        hasUnboundedWrite(statement)
      );
    });
    if (!isDestructive) {
      continue;
    }
    // The pragma is only honored when it appears as a standalone line-comment
    // directive: it must be the sole content of its raw source line (only
    // whitespace before the `--`), and the comment body — after the `--` and
    // surrounding whitespace — must be exactly `void:allow-destructive`. A
    // trailing pragma like `CREATE TABLE t(id); -- void:allow-destructive`
    // does not authorize, and neither does a documentation comment like
    // `-- see void:allow-destructive for details`.
    const authorized = lineComments.some(
      (line) => line.standalone && line.text.trim() === DESTRUCTIVE_PRAGMA,
    );
    if (!authorized) {
      violations.push(m.name);
    }
  }
  return violations;
}

function toBuildSummary(build: Build) {
  return {
    id: build.id,
    status: build.status,
    executor: build.executor,
    commit_sha: build.commit_sha,
    branch: build.branch,
    exit_code: build.exit_code,
    error: build.error,
    logs_url: build.logs_url,
    created_at: build.created_at,
    started_at: build.started_at,
    completed_at: build.completed_at,
  };
}

const app = new Hono<ApiEnv>()

  // List all projects for the current user
  .get('/', async (context) => {
    const userId = context.get('user').id;
    const allProjects = await getAccessibleProjectsByUserId(context.get('db'), userId);

    // A project-scoped deploy token (aud:'deploy') is minted to deploy ONE
    // project and only needs the scoped project present here for the CLI's
    // slug→id resolution. Restrict the listing to that project so a leaked
    // build-time token cannot enumerate every other project's domains,
    // deployments, traffic, and health. Full `api` tokens (deployScope unset)
    // keep the complete listing.
    const deployScope = context.get('deployScope');
    const projects = deployScope
      ? allProjects.filter(({ project }) => project.id === deployScope)
      : allProjects;

    // Batch-fetch domains for all projects in a single query
    const projectIds = projects.map(({ project }) => project.id);
    const [domainMap, latestDeployments, requestOverview] =
      projectIds.length > 0
        ? await Promise.all([
            getDomainsByProjectIds(context.get('db'), projectIds),
            getLatestDeploymentsByProjectIds(context.get('db'), projectIds),
            isDevBypass(context.env)
              ? Promise.resolve(new Map())
              : queryProjectRequestOverview(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  getRequestsDataset(context.env),
                  projectIds,
                ),
          ])
        : [new Map(), new Map(), new Map()];

    const projectsWithSummaries = projects.map(({ project: p, role, owner }): ProjectListItem => {
      const pDomains = domainMap.get(p.id);
      const domain =
        pDomains?.find((d: { status: string }) => d.status === 'active') ?? pDomains?.[0];
      const overview = requestOverview.get(p.id);
      return {
        ...projectWithUrl(p, context.env),
        role,
        owner: { id: owner.id, login: owner.login },
        custom_domain: domain?.hostname ?? null,
        latest_deployment: latestDeployments.get(p.id) ?? null,
        traffic: {
          requests5m: overview?.requests5m ?? 0,
          lastSeenAt: overview?.lastSeenAt ?? null,
          sparkline5m: overview?.sparkline5m ?? Array.from({ length: 20 }, () => 0),
        },
        health: {
          responses4xx15m: overview?.responses4xx15m ?? 0,
          responses5xx15m: overview?.responses5xx15m ?? 0,
          errorRate5xx15m: overview?.errorRate5xx15m ?? 0,
        },
      };
    });

    return context.json(projectsWithSummaries.sort(sortProjectList));
  })

  // Lightweight project choices for interactive deploys.
  .get('/choices', async (context) => {
    const projects = await getAccessibleProjectsByUserId(context.get('db'), context.get('user').id);
    return context.json(
      projects.map(({ project, role, owner }) => ({
        ...projectWithUrl(project, context.env),
        role,
        owner: { id: owner.id, login: owner.login },
      })),
    );
  })

  // Resolve one project for the CLI without loading deployment and traffic summaries.
  .get('/resolve', async (context) => {
    const slug = context.req.query('slug');
    if (!slug || slug.length > MAX_SLUG_LENGTH || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return context.json({ error: 'valid slug is required' }, 400);
    }

    const access = await getAccessibleProjectBySlug(
      context.get('db'),
      context.get('user').id,
      slug,
    );
    if (
      !access ||
      (context.get('deployScope') && context.get('deployScope') !== access.project.id)
    ) {
      return context.json({ project: null });
    }

    return context.json({
      project: {
        ...projectWithUrl(access.project, context.env),
        role: access.role,
        owner: { id: access.owner.id, login: access.owner.login },
      },
    });
  })

  // Create a new project
  .post('/', async (context) =>
    createUserProject(context, await context.req.json<{ slug: string }>()),
  )

  // Get project by ID
  .get('/:id', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    return context.json({
      ...projectWithUrl(access.project, context.env),
      role: access.role,
      owner: {
        id: access.owner.id,
        login: access.owner.login,
      },
    });
  })

  // Mint a narrowly scoped credential for deploy-time remote-binding access.
  // The built application receives this token while it runs under Miniflare,
  // so it must never inherit the caller's full API/deploy credential.
  .post('/:id/prerender-token', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'deploy');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    const user = context.get('user');
    const deployBuild = context.get('deployBuild');
    const deployCredential = context.get('deployCredential');
    const signToken = (buildId?: string) => {
      const maximumTtl = deployTokenTtlSecondsForBuildMinutes(0);
      const expiry = context.get('deployTokenExpiresAt');
      const ttlSeconds =
        buildId && expiry !== undefined
          ? Math.min(maximumTtl, Math.floor(expiry - Date.now() / 1000))
          : maximumTtl;
      if (ttlSeconds <= 0) {
        return context.json(
          {
            error: 'deploy token expired before prerendering',
            message: 'Start a new build to obtain a valid deployment credential.',
          },
          401,
        );
      }
      return signPrerenderToken(
        {
          projectId: project.id,
          userId: user.id,
          login: user.login,
          buildId,
          credentialId: deployCredential,
        },
        context.env.JWT_SECRET,
        {
          // Managed builds retain the deadline admitted by their scoped token,
          // even if their account's plan changes while they are running. Manual
          // prerenders use the existing bounded 65-minute ceiling.
          ttlSeconds,
        },
      );
    };

    let token: string;
    if (deployBuild) {
      // The auth middleware checked this build before entering the route, but a
      // supersede can race that check and token signing. Lock project first
      // (the platform-wide lock order), then the build row, and revalidate while
      // minting. Once this transaction releases, the proxy checks the same row
      // on every request, so a later terminal transition revokes the derived
      // credential immediately rather than merely waiting for JWT expiry.
      const minted = await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${project.id} FOR SHARE`);
        await tx.execute(drizzleSql`SELECT id FROM builds WHERE id = ${deployBuild} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(context, project.id, 'deploy', tx);
        if (lockedAccess instanceof Response) {
          return lockedAccess;
        }
        const boundBuild = await getBuild(tx, deployBuild);
        if (
          lockedAccess.project.status === 'deleting' ||
          !boundBuild ||
          boundBuild.project_id !== project.id ||
          !ACTIVE_BUILD_STATUSES.includes(boundBuild.status)
        ) {
          return null;
        }
        return signToken(deployBuild);
      });
      if (minted instanceof Response) {
        return minted;
      }
      if (!minted) {
        return context.json(
          {
            error: 'deploy token build is no longer active',
            message:
              'This build is no longer active. Start a new build to obtain a valid deployment credential.',
          },
          403,
        );
      }
      token = minted;
    } else {
      const minted = await signToken();
      if (minted instanceof Response) {
        return minted;
      }
      token = minted;
    }
    return context.json({ token });
  })

  // List deployments for a project
  .get('/:id/deployments', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const deployments = await getProjectDeployments(context.get('db'), project.id, 20);
    // Deploy tokens run untrusted build code, and readers lack configure access.
    // Strip plaintext vars while preserving `live`, which the deploy CLI consumes.
    const sanitized =
      context.get('deployScope') || access.role === 'reader'
        ? deployments.map((deployment) => ({
            ...deployment,
            manifest: sanitizeDeploymentManifest(deployment.manifest),
          }))
        : deployments;
    const warnings = await proxyTokenRotationWarnings(
      context.get('db'),
      project.id,
      access.role,
      !!context.get('deployScope'),
    );
    return context.json({
      deployments: sanitized,
      activeDeploymentId: project.active_deployment_id,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  })

  // Request cancellation of an active deployment
  .post('/:id/deployments/:deploymentId/cancel', async (context) => {
    const projectId = context.req.param('id');
    const deploymentId = context.req.param('deploymentId');
    const access = await requireProjectRouteCapability(context, projectId, 'deploy');
    if (access instanceof Response) {
      return access;
    }

    return context.get('db').transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      const lockedAccess = await requireProjectRouteCapability(context, projectId, 'deploy', tx);
      if (lockedAccess instanceof Response) {
        return lockedAccess;
      }

      const deployment = await getDeployment(tx, deploymentId);
      if (!deployment || deployment.project_id !== projectId) {
        return context.json({ error: 'deployment not found' }, 404);
      }

      const canceling = await cancelDeployment(tx, deploymentId, 'canceled by user');
      if (!canceling) {
        return context.json(
          { error: 'deployment already completed', status: deployment.status },
          409,
        );
      }

      return context.json({ ok: true, deploymentId, status: 'canceling' });
    });
  })

  // Rollback to a previous deployment
  .post('/:id/rollback', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'deploy');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const { deploymentId, allowDestructive } = await context.req.json<{
      deploymentId: string;
      allowDestructive?: ReadonlyArray<string>;
    }>();
    if (!deploymentId) {
      return context.json({ error: 'deploymentId is required' }, 400);
    }
    if (allowDestructive !== undefined) {
      if (!Array.isArray(allowDestructive) || allowDestructive.some((m) => typeof m !== 'string')) {
        return context.json(
          { error: 'allowDestructive must be an array of migration name strings' },
          400,
        );
      }
    }

    // Pre-lock sanity check: reject fast if the deployment plainly does
    // not belong to this project. The authoritative check runs inside
    // the lock below against a freshly-read row.
    const preCheck = await getDeployment(context.get('db'), deploymentId);
    if (!preCheck || preCheck.project_id !== projectId) {
      return context.json({ error: 'deployment not found' }, 404);
    }
    if (!preCheck.retained) {
      return context.json({ error: 'deployment not retained (worker script evicted)' }, 400);
    }
    if (preCheck.manifest) {
      const manifest = JSON.parse(preCheck.manifest) as DeployManifest;
      if (manifest.sandbox && !getPlatformCapabilities(context.env).sandbox) {
        return context.json(
          { error: 'This Void platform does not enable rollback to Sandbox deployments.' },
          501,
        );
      }
      if (manifest.sandbox && (!isManagedSandbox(manifest) || preCheck.admission_protocol < 3)) {
        return context.json(
          {
            error:
              'This deployment predates managed Sandbox controllers. Redeploy the app before rolling back to it.',
          },
          409,
        );
      }
    }

    // A committed rollback lease blocks deploys and other rollbacks while
    // the cutover transaction commits or external compensation runs. Keeping
    // this fence outside the cutover transaction is essential: if PostgreSQL
    // rejects COMMIT after the callback returns, the lease still exists while
    // we restore KV, cron, and queue state from the callback's undo log.
    let rollbackLeaseId: string | undefined;
    const rollbackOwnerId = crypto.randomUUID();
    const externalUndo: Array<(zeroTrust: ProjectZeroTrustRouting | null) => Promise<void>> = [];
    const routingValuesWritten = new Map<string, string | null>();
    let externalCompensated = false;
    let rollbackCommitted = false;
    let adoptedRollbackLease = false;
    let releaseRollbackLease = true;
    let rollbackResultCandidate: { migrationDiff: ReadonlyArray<string> } | undefined;
    let rollbackErrorResponse: Response | undefined;
    let rollbackErrorToThrow: unknown;
    let leaseReleaseError: AggregateError | undefined;

    // The entire rollback cutover runs inside a single row-locked tx so
    // concurrent rollbacks / applies / renames serialize and no external
    // state is written before the pg flip. Ordering invariants:
    //
    //   - pg flip runs FIRST inside the lock; external writes run AFTER.
    //     If the pg flip throws, the tx rolls back and no external writes
    //     have happened yet → caller sees 500, state is consistent.
    //
    //   - If an external write throws after the pg flip, the tx rolls
    //     back (reverting active_deployment_id), but some earlier
    //     external writes may have already landed. The caller sees 500
    //     and retries; KV PUTs and cron/queue routes are idempotent
    //     under the same payload.
    //
    // target.applied_migrations (and retained, manifest) are re-read
    // inside the lock because a concurrent /rename can rewrite every
    // deployment's applied_migrations via
    // renameAppliedMigrationsForProject.
    let rollbackResult: { migrationDiff: ReadonlyArray<string> } | undefined;
    try {
      const rollbackLease = await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(context, projectId, 'deploy', tx);
        if (lockedAccess instanceof Response) {
          const denied = await getProjectAccessErrorBody(lockedAccess);
          throw new RollbackError(
            lockedAccess.status as 403 | 404,
            denied.error,
            undefined,
            denied.message,
          );
        }
        const lockedProject = lockedAccess.project;
        if (lockedProject.status === 'deleting') {
          throw new RollbackError(409, 'project is being deleted');
        }
        try {
          await requireNormalizedProject(tx, lockedProject);
        } catch (error) {
          if (error instanceof ProjectRequiresNormalizationError) {
            throw new RollbackError(409, error.code, undefined, error.message);
          }
          throw error;
        }
        const pendingOperation = await getPendingDeploymentOperation(tx, projectId);
        if (pendingOperation) {
          throw new RollbackError(409, `deploy in progress: ${pendingOperation.id}`);
        }
        const activeDeploy = await getActiveDeployment(tx, projectId);
        if (activeDeploy) {
          if (activeDeploy.source === 'rollback-lease' && activeDeploy.manifest) {
            try {
              const lease = JSON.parse(activeDeploy.manifest) as {
                targetDeploymentId?: unknown;
                state?: unknown;
                ownerId?: unknown;
                migrationDiff?: unknown;
              };
              const updatedAt = activeDeploy.updated_at.includes('T')
                ? activeDeploy.updated_at
                : `${activeDeploy.updated_at.replace(' ', 'T')}Z`;
              const staleRunningLease =
                lease.state === 'running' &&
                Date.now() - new Date(updatedAt).getTime() >= 30 * 60 * 1000;
              if (
                lease.targetDeploymentId === deploymentId &&
                lease.state === 'applied' &&
                typeof lease.ownerId === 'string' &&
                lockedProject.active_deployment_id === deploymentId
              ) {
                if (
                  !Array.isArray(lease.migrationDiff) ||
                  !lease.migrationDiff.every((value) => typeof value === 'string')
                ) {
                  throw new RollbackError(409, `deploy in progress: ${activeDeploy.id}`);
                }
                const migrationDiff = lease.migrationDiff as Array<string>;
                const released = await deleteRollbackLease(tx, activeDeploy.id, lease.ownerId);
                if (!released) {
                  throw new RollbackError(409, `deploy in progress: ${activeDeploy.id}`);
                }
                return { id: activeDeploy.id, adopted: false, appliedResult: { migrationDiff } };
              }
              if (
                lease.targetDeploymentId === deploymentId &&
                typeof lease.ownerId === 'string' &&
                (lease.state === 'retryable' || staleRunningLease)
              ) {
                const adopted = await updateRollbackLeaseState(
                  tx,
                  activeDeploy.id,
                  deploymentId,
                  'running',
                  rollbackOwnerId,
                  lease.ownerId,
                );
                if (!adopted) {
                  throw new RollbackError(409, `deploy in progress: ${activeDeploy.id}`);
                }
                return { id: activeDeploy.id, adopted: true, appliedResult: undefined };
              }
            } catch {
              // Legacy/corrupt leases retain the normal in-progress behavior.
            }
          }
          throw new RollbackError(409, `deploy in progress: ${activeDeploy.id}`);
        }
        const lease = await createDeployment(
          tx,
          projectId,
          JSON.stringify({
            version: 1,
            targetDeploymentId: deploymentId,
            state: 'running',
            ownerId: rollbackOwnerId,
          }),
          'rollback-lease',
        );
        return { id: lease.id, adopted: false, appliedResult: undefined };
      });
      if (rollbackLease.appliedResult) {
        rollbackCommitted = true;
        rollbackResult = rollbackLease.appliedResult;
      } else {
        rollbackLeaseId = rollbackLease.id;
        adoptedRollbackLease = rollbackLease.adopted;
      }

      if (!rollbackCommitted) {
        rollbackResult = await context.get('db').transaction(async (tx) => {
          // Lock the project row via `SELECT … FOR UPDATE` — per-project,
          // collision-free, released automatically at tx end. MUST be the
          // first statement in the locked section so serialization is
          // established before any subsequent read or write.
          await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
          const lockedAccess = await requireProjectRouteCapability(
            context,
            projectId,
            'deploy',
            tx,
          );
          if (lockedAccess instanceof Response) {
            const denied = await getProjectAccessErrorBody(lockedAccess);
            throw new RollbackError(
              lockedAccess.status as 403 | 404,
              denied.error,
              undefined,
              denied.message,
            );
          }

          // Re-read target INSIDE the lock. applied_migrations can be
          // rewritten by a concurrent /rename; manifest and retained are
          // stable in practice but re-reading is cheap and removes every
          // time-of-check / time-of-use hazard on this row.
          const target = await getDeployment(tx, deploymentId);
          if (!target || target.project_id !== projectId) {
            throw new RollbackError(404, 'deployment not found');
          }
          if (!target.retained) {
            throw new RollbackError(400, 'deployment not retained (worker script evicted)');
          }
          if (target.manifest) {
            const manifest = JSON.parse(target.manifest) as DeployManifest;
            if (manifest.sandbox && !getPlatformCapabilities(context.env).sandbox) {
              throw new RollbackError(
                501,
                'This Void platform does not enable rollback to Sandbox deployments.',
              );
            }
            if (manifest.sandbox) {
              if (!isManagedSandbox(manifest) || target.admission_protocol < 3) {
                throw new RollbackError(
                  409,
                  'This deployment predates managed Sandbox controllers. Redeploy the app before rolling back to it.',
                );
              }
              try {
                await verifySandboxController(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  projectId,
                  deploymentId,
                  manifest.sandbox,
                );
              } catch (error) {
                throw new RollbackError(
                  409,
                  error instanceof Error ? error.message : 'Sandbox controller is unavailable.',
                );
              }
            }
          }

          // Re-read project so `active_deployment_id` and `type` reflect
          // any concurrent rollback / deploy that committed before the
          // lock was acquired. `type` and `user_id` are effectively
          // immutable but re-reading keeps the computed routing JSON
          // consistent with the exact row the flip will reference.
          const lockedProject = lockedAccess.project;
          if (lockedProject.status === 'deleting') {
            throw new RollbackError(409, 'project is being deleted');
          }
          const pendingOperation = await getPendingDeploymentOperation(tx, projectId);
          if (pendingOperation) {
            throw new RollbackError(409, `deploy in progress: ${pendingOperation.id}`);
          }
          const activeDeploy = await getActiveDeployment(tx, projectId);
          let ownsRollbackLease = false;
          if (activeDeploy && activeDeploy.id === rollbackLeaseId && activeDeploy.manifest) {
            try {
              const lease = JSON.parse(activeDeploy.manifest) as { ownerId?: unknown };
              ownsRollbackLease = lease.ownerId === rollbackOwnerId;
            } catch {
              // A corrupt or legacy lease is never treated as owned.
            }
          }
          if (!ownsRollbackLease) {
            throw new RollbackError(
              409,
              `deploy in progress: ${activeDeploy?.id ?? rollbackLeaseId}`,
            );
          }

          const targetMigrations: Array<string> = target.applied_migrations
            ? JSON.parse(target.applied_migrations)
            : [];

          const projectMigrationNames = await getProjectMigrationNames(tx, projectId);
          const currentActive = lockedProject.active_deployment_id
            ? await getDeployment(tx, lockedProject.active_deployment_id)
            : null;
          const currentMigrations: Array<string> =
            projectMigrationNames.length > 0
              ? [...projectMigrationNames]
              : currentActive?.applied_migrations
                ? JSON.parse(currentActive.applied_migrations)
                : [];
          const diff = currentMigrations.filter((m) => !targetMigrations.includes(m));

          // Reject destructive rollbacks server-side unless the caller
          // explicitly opts in. `diff` holds migrations the CURRENT active
          // has run that the TARGET does not know about — typically
          // forward-only DDL (DROP TABLE, ALTER, etc.) applied after the
          // target was built. Flipping traffic to the target in this state
          // leaves the worker code expecting the OLD schema while D1 still
          // carries the evolved schema, which silently corrupts queries.
          //
          // The override is snapshot-bound, NOT a blanket boolean: the
          // caller must echo the exact set of migration names they were
          // shown at confirmation time, and the server-computed diff must
          // match that set exactly (same elements, same size). This closes
          // a TOCTOU where a concurrent deploy flips `currentActive`
          // between the caller's preflight `listDeployments` read and our
          // locked `diff` re-read — set-equality means any drift forces a
          // fresh confirmation against the new state.
          //
          // The check runs BEFORE the pg flip and any external write so a
          // rejected rollback mutates nothing.
          if (diff.length > 0) {
            const confirmed = allowDestructive ?? [];
            const confirmedSet = new Set(confirmed);
            const snapshotMatches =
              confirmed.length === diff.length && diff.every((m) => confirmedSet.has(m));
            if (!snapshotMatches) {
              // Migration names are arbitrary non-empty strings (see
              // /rename), so interpolating them raw into prose with hand-
              // rolled quoting can produce invalid JSON hints when a name
              // contains quotes / backslashes / newlines. JSON.stringify
              // the diff for the example, and expose it structurally via
              // `destructiveMigrations` so programmatic callers echo the
              // authoritative array rather than re-parsing the message.
              throw new RollbackError(
                400,
                `Rollback is destructive: current deployment has migration(s) the target does not include: ${JSON.stringify(diff)}. Retry with \`allowDestructive: ${JSON.stringify(diff)}\` to confirm this exact set.`,
                diff,
              );
            }
          }

          // Build routing JSON from the freshly-read target manifest.
          const manifest: DeployManifest | null = target.manifest
            ? JSON.parse(target.manifest)
            : null;
          const dispatchLimits = computeDispatchLimits(
            await resolvePlanLimits(tx, lockedAccess.owner.plan),
            manifest?.limits,
          );
          // Rollback external-write pass depends only on authoritative
          // persistent sources (pg deployments table for queue activation
          // history; target's manifest + unconditional DO reconciliation
          // for crons), not on the potentially-stale currentActive manifest
          // snapshot or the eagerly-written resources table. See queue
          // sweep below for why the union uses `deployed_at IS NOT NULL`.
          const workerName = getProjectDeploymentWorkerName(lockedProject.slug, target.id);
          const existingRouting = await context.env.ROUTING.get(projectRouteKey(lockedProject));
          const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
          const zeroTrust = await resolveProjectZeroTrustRouting(tx, projectId).catch(
            (error: unknown) => {
              const message = zeroTrustNotReadyMessage(error);
              throw message
                ? new RollbackError(409, 'zero trust not ready', undefined, message)
                : error;
            },
          );
          const targetType =
            manifest?.type ??
            (manifest?.framework
              ? 'framework'
              : target.bundle_stored || manifest?.workerMain
                ? 'void'
                : manifest?.static === 'spa'
                  ? 'spa'
                  : manifest?.static === 'ssg'
                    ? 'static'
                    : manifest?.assetConfig?.not_found_handling === 'single-page-application'
                      ? 'spa'
                      : manifest?.assetConfig?.not_found_handling === '404-page'
                        ? 'static'
                        : 'void');
          const isStaticDeployment = targetType === 'static' || targetType === 'spa';
          let targetHasAssets = false;
          if (target.asset_hashes) {
            try {
              const assetHashes = JSON.parse(target.asset_hashes) as unknown;
              targetHasAssets =
                typeof assetHashes === 'object' &&
                assetHashes !== null &&
                Object.keys(assetHashes).length > 0;
            } catch {
              throw new RollbackError(400, 'target deployment has invalid asset metadata');
            }
          }

          let routingJson: string;
          if (isStaticDeployment) {
            const assetConfig = manifest?.assetConfig ?? {
              not_found_handling: targetType === 'spa' ? 'single-page-application' : '404-page',
            };
            routingJson = buildStaticRoutingJson({
              privatePreview: Boolean(project.preview_client_id),
              projectId,
              userId: lockedProject.user_id,
              deploymentId: target.id,
              assetConfig,
              manifest,
              suspended: existingEntry?.suspended,
              zeroTrust,
            });
          } else {
            routingJson = buildRoutingJson({
              privatePreview: Boolean(project.preview_client_id),
              workerName,
              projectId,
              userId: lockedProject.user_id,
              manifest,
              deploymentId: target.id,
              dispatchLimits,
              suspended: existingEntry?.suspended,
              hasCrons: !!manifest?.schedules?.length,
              assetManifestId: targetHasAssets ? target.id : undefined,
              assetConfig: targetHasAssets ? manifest?.assetConfig : undefined,
              zeroTrust,
            });
          }

          // PG flip FIRST. If this throws, no external state is mutated
          // yet — the tx rolls back cleanly and the caller can retry.
          await updateProjectType(tx, projectId, targetType);
          await requestRotationIfReplacingUntrustedCode(tx, projectId, target.id);
          await setActiveDeployment(tx, projectId, target.id);

          const snapshottedRoutingKeys = new Set<string>();
          const snapshotRoutingKey = async (key: string): Promise<void> => {
            if (snapshottedRoutingKeys.has(key)) {
              return;
            }
            const previous = await context.env.ROUTING.get(key);
            snapshottedRoutingKeys.add(key);
            externalUndo.push(async (currentZeroTrust) => {
              if (!routingValuesWritten.has(key)) {
                return;
              }
              const undo = resolveRoutingUndo(
                await context.env.ROUTING.get(key),
                routingValuesWritten.get(key)!,
                previous,
              );
              if (!undo.restore) {
                return;
              }
              if (undo.value === null) {
                await context.env.ROUTING.delete(key);
              } else {
                await context.env.ROUTING.put(
                  key,
                  key === lockedProject.slug || key.startsWith('domain:')
                    ? withProjectZeroTrustRouting(undo.value, currentZeroTrust, lockedProject.id)
                    : undo.value,
                );
              }
            });
          };
          const putRouting = async (key: string, value: string): Promise<void> => {
            await snapshotRoutingKey(key);
            // Record before awaiting KV so a committed write whose acknowledgement
            // is lost is still included in the rollback undo pass.
            routingValuesWritten.set(key, value);
            await context.env.ROUTING.put(key, value);
          };
          const deleteRouting = async (key: string): Promise<void> => {
            await snapshotRoutingKey(key);
            routingValuesWritten.set(key, null);
            await context.env.ROUTING.delete(key);
          };

          // External writes SECOND, inside the same lock. Every write is
          // preceded by an exact snapshot and compensated in reverse order
          // before the transaction releases the project lock.
          try {
            await reconcileManagedDurableObjects(
              context.env,
              tx,
              projectId,
              target.id,
              manifest ?? null,
              (undo) => externalUndo.push(async () => undo()),
            );
            await putRouting(projectRouteKey(lockedProject), routingJson);

            // Resolve the target worker's baked __VOID_PROXY_TOKEN once if
            // either cron or queues need it. Re-fetching on each path would
            // double the CF API round-trips AND widen the failure window
            // between cron DO sync and queue KV write: a transient CF 429
            // on the second fetch would abort the transaction after cron
            // state was already committed to the DO. The framework's
            // /__void/scheduled and /__void/queue handlers both validate
            // against the SAME __VOID_PROXY_TOKEN binding, so one lookup
            // is authoritative for both.
            // The target may hold an older generation than the issued one;
            // its copies get the token it holds.
            const needsProxyToken = !!manifest?.schedules?.length || !!manifest?.queues?.length;
            const targetProxyToken = needsProxyToken
              ? await resolveRollbackProxyToken(context.env, workerName, projectId)
              : null;

            // Sync cron scheduler to point at the rollback target.
            //
            // When target has no schedules, `/clear` is called unconditionally
            // (it's idempotent — see cron-scheduler.ts `handleClear`). A
            // prior failed cutover could leave the DO holding schedules that
            // no pg manifest still mentions, and a guarded clear would let
            // that stale DO state persist across every future rollback.
            const previousCronState = await snapshotCronScheduler(context.env, projectId);
            externalUndo.push(() =>
              restoreCronScheduler(context.env, projectId, previousCronState),
            );
            if (manifest?.schedules?.length) {
              await syncCronScheduler(context.env, projectId, {
                workerName,
                schedules: manifest.schedules,
                proxyToken: targetProxyToken!,
              });
            } else {
              await clearCronScheduler(context.env, projectId);
            }

            // Update custom domain routing
            const projectDomains = await getDomainsByProjectId(tx, projectId);
            for (const domain of projectDomains) {
              if (domain.status === 'active') {
                await putRouting(`domain:${domain.hostname}`, routingJson);
              }
            }

            // Update queue routing. Rewrite every queue route that target
            // binds AND delete any queue route left over from older
            // deployments that target does not bind. Without the deletion
            // pass, messages arriving on a queue A had bound but B does not
            // would still hit `queue:<q>` in KV and dispatch would forward
            // them to A's (now evicted) worker.
            //
            // Sweep source is the UNION of:
            //   - Deployments that have ever been live (`deployed_at IS NOT NULL`).
            //   - Terminal-failed/canceled deployments (`deployed_at = null`).
            //
            // The second set catches deploys that wrote `queue:<name>` KV
            // routes at step 2b and then failed before the routing flip.
            // In-flight deploys (status not in the terminal-failed set) are
            // excluded, so rollback does not clobber KV routes an in-flight
            // deploy is provisioning.
            const [activatedDeployments, terminalFailedDeployments] = await Promise.all([
              getActivatedDeployments(tx, projectId),
              getTerminalFailedDeployments(tx, projectId),
            ]);
            const sweepQueueNames = new Set<string>();
            const unionSource = [...activatedDeployments, ...terminalFailedDeployments];
            for (const d of unionSource) {
              if (!d.manifest) {
                continue;
              }
              let depManifest: DeployManifest | null = null;
              try {
                depManifest = JSON.parse(d.manifest);
              } catch {
                // Skip deployments with unparseable manifests rather than
                // blowing up the whole rollback.
                continue;
              }
              for (const q of depManifest?.queues ?? []) {
                sweepQueueNames.add(q.name);
              }
            }
            // Include target's own queue names in the union so the delete
            // pass's complement is always `union \ target`, i.e. we never
            // accidentally delete a route we're about to rewrite below.
            const targetQueueNames = new Set((manifest?.queues ?? []).map((q) => q.name));
            for (const name of targetQueueNames) {
              sweepQueueNames.add(name);
            }
            const queueResources = await getProjectResources(tx, projectId);
            const dispatchWorkerName = context.env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
            const queueResourceByName = new Map(
              queueResources
                .filter((resource) => resource.type === 'queue')
                .map((resource) => [resource.binding_name, resource] as const),
            );
            for (const name of sweepQueueNames) {
              const resource = queueResourceByName.get(name);
              if (!resource) {
                if (targetQueueNames.has(name)) {
                  throw new RollbackError(400, `target queue resource is missing: ${name}`);
                }
                continue;
              }
              const previousConsumer = await snapshotQueueConsumer(
                context.env.CF_ACCOUNT_ID,
                context.env.CF_API_TOKEN,
                resource.cf_id,
                dispatchWorkerName,
              );
              externalUndo.push(() =>
                restoreQueueConsumer(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  resource.cf_id,
                  dispatchWorkerName,
                  previousConsumer,
                ),
              );
              const targetQueue = manifest?.queues?.find((queue) => queue.name === name);
              if (targetQueue) {
                const consumer = await addQueueConsumer(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  resource.cf_id,
                  dispatchWorkerName,
                  {
                    ...(targetQueue.maxBatchSize != null && {
                      batch_size: targetQueue.maxBatchSize,
                    }),
                    ...(targetQueue.maxBatchTimeout != null && {
                      max_wait_time_ms: targetQueue.maxBatchTimeout * 1000,
                    }),
                    ...(targetQueue.maxRetries != null && {
                      max_retries: targetQueue.maxRetries,
                    }),
                    ...(targetQueue.retryDelay != null && {
                      retry_delay: targetQueue.retryDelay,
                    }),
                  },
                );
                if (consumer.status === 'conflict') {
                  throw new Error(
                    `queue consumer conflict: ${name} owned by ${consumer.ownerScript}`,
                  );
                }
              } else {
                await removeQueueConsumer(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  resource.cf_id,
                  dispatchWorkerName,
                );
              }
            }
            if (manifest?.queues?.length) {
              for (const q of manifest.queues) {
                await putRouting(
                  `queue:${getProjectQueueName(projectId, q.name)}`,
                  JSON.stringify({
                    workerName,
                    projectId,
                    queueName: q.name,
                    proxyToken: targetProxyToken!,
                  }),
                );
              }
            }
            for (const name of sweepQueueNames) {
              if (targetQueueNames.has(name)) {
                continue;
              }
              await deleteRouting(`queue:${getProjectQueueName(projectId, name)}`);
            }
          } catch (externalError) {
            const compensationErrors: Array<unknown> = [];
            for (const undo of externalUndo.reverse()) {
              try {
                await undo(zeroTrust);
              } catch (compensationError) {
                compensationErrors.push(compensationError);
              }
            }
            if (compensationErrors.length > 0) {
              throw new AggregateError(
                [externalError, ...compensationErrors],
                'rollback failed and external state compensation was incomplete',
              );
            }
            externalCompensated = true;
            throw externalError;
          }

          // This owned lease transition commits atomically with the project flip
          // and is the durable witness for ambiguous COMMIT acknowledgements.
          // `active_deployment_id` alone is insufficient when the requested
          // rollback target was already active before this transaction began.
          const witnessed = await updateRollbackLeaseState(
            tx,
            rollbackLeaseId!,
            deploymentId,
            'applied',
            rollbackOwnerId,
            rollbackOwnerId,
            diff,
          );
          if (!witnessed) {
            throw new Error('rollback lease ownership was lost before commit');
          }
          rollbackResultCandidate = { migrationDiff: diff };
          return rollbackResultCandidate;
        });
        rollbackCommitted = true;
      }
    } catch (err) {
      // COMMIT acknowledgement can be lost after PostgreSQL durably applied
      // the project flip. The owned lease's `applied` transition commits in
      // the same transaction and is the authoritative witness, including a
      // rollback whose target was already active before the request. A still-
      // `running` lease proves the transaction did not commit.
      let ambiguousCommitOutcome: 'committed' | 'not_committed' | 'unknown' | undefined;
      if (!rollbackCommitted && !externalCompensated && externalUndo.length > 0) {
        let durableReadSucceeded = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const latestLease = rollbackLeaseId
              ? await getDeployment(context.get('db'), rollbackLeaseId)
              : null;
            durableReadSucceeded = true;
            if (latestLease?.source === 'rollback-lease' && latestLease.manifest) {
              const lease = JSON.parse(latestLease.manifest) as {
                targetDeploymentId?: unknown;
                state?: unknown;
                ownerId?: unknown;
              };
              if (lease.targetDeploymentId === deploymentId && lease.ownerId === rollbackOwnerId) {
                ambiguousCommitOutcome = lease.state === 'applied' ? 'committed' : 'not_committed';
                break;
              }
            }
          } catch {
            // Preserve on an unreadable outcome; the original error remains
            // the one returned to the caller below.
          }
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
          }
        }
        ambiguousCommitOutcome ??= durableReadSucceeded ? 'not_committed' : 'unknown';
      }

      if (ambiguousCommitOutcome === 'committed' && rollbackResultCandidate) {
        rollbackCommitted = true;
        rollbackResult = rollbackResultCandidate;
      }

      if (!rollbackCommitted && !externalCompensated && externalUndo.length > 0) {
        if (ambiguousCommitOutcome === 'not_committed') {
          const compensationErrors: Array<unknown> = [];
          try {
            await context.get('db').transaction(async (tx) => {
              await tx.execute(
                drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
              );
              const activeLease = await getActiveDeployment(tx, projectId);
              let stillOwnsLease = false;
              if (activeLease && activeLease.id === rollbackLeaseId && activeLease.manifest) {
                try {
                  const lease = JSON.parse(activeLease.manifest) as { ownerId?: unknown };
                  stillOwnsLease = lease.ownerId === rollbackOwnerId;
                } catch {
                  // Corrupt or replaced ownership always suppresses stale undo.
                }
              }
              if (!stillOwnsLease) {
                return;
              }
              const zeroTrust = await resolveProjectZeroTrustRoutingForPublication(tx, projectId);
              for (const undo of [...externalUndo].reverse()) {
                try {
                  await undo(zeroTrust);
                } catch (compensationError) {
                  compensationErrors.push(compensationError);
                }
              }

              // A domain activation can commit after the failed rollback's
              // transaction released this project lock but before this outer
              // compensation acquired it. That hostname was not in the earlier
              // snapshot, and activation may have copied the rollback target's
              // temporary slug route into its domain key. Reconcile the complete
              // current domain inventory to the now-restored slug route before
              // releasing the rollback lease. Pending rows are deleted too: KV
              // may have been written immediately before activation's final
              // database status update was interrupted.
              let restoredProjectRouting: string | null = null;
              try {
                const rawRouting = await context.env.ROUTING.get(projectRouteKey(project));
                restoredProjectRouting =
                  rawRouting === null
                    ? null
                    : withProjectZeroTrustRouting(rawRouting, zeroTrust, projectId);
              } catch (compensationError) {
                compensationErrors.push(compensationError);
              }
              for (const domain of await getDomainsByProjectId(tx, projectId)) {
                try {
                  if (domain.status === 'active' && restoredProjectRouting !== null) {
                    await context.env.ROUTING.put(
                      `domain:${domain.hostname}`,
                      restoredProjectRouting,
                    );
                  } else {
                    await context.env.ROUTING.delete(`domain:${domain.hostname}`);
                  }
                } catch (compensationError) {
                  compensationErrors.push(compensationError);
                }
              }
            });
          } catch (compensationTransactionError) {
            // This includes failure to acquire/commit the lock and DB reads
            // inside it. No such outcome proves compensation completed, so the
            // rollback lease must remain as a fail-closed fence.
            compensationErrors.push(compensationTransactionError);
          }
          if (compensationErrors.length > 0) {
            releaseRollbackLease = false;
            if (rollbackLeaseId) {
              await updateRollbackLeaseState(
                context.get('db'),
                rollbackLeaseId,
                deploymentId,
                'retryable',
                rollbackOwnerId,
                rollbackOwnerId,
              ).catch(() => {
                // The owned running lease is still a fail-closed fence when
                // the retryable state write is unavailable.
              });
            }
            throw new AggregateError(
              [err, ...compensationErrors],
              'rollback transaction failed and external state compensation was incomplete',
            );
          }
        } else if (ambiguousCommitOutcome === 'unknown') {
          releaseRollbackLease = false;
          // Do not overwrite the witness while PostgreSQL is unreadable. An
          // `applied` lease lets a retry finish success; a `running` lease
          // remains a fail-closed fence until it can be reconciled.
        }
      }
      if (rollbackCommitted) {
        // Continue through finally so the rollback lease is released, then
        // return the normal success response below.
      } else {
        // An adopted lease represents an earlier rollback whose PostgreSQL
        // outcome was unreadable while external state may already point at
        // the target. A failed retry snapshots that possibly-divergent state,
        // so even successful compensation cannot prove it matches the active
        // deployment in PostgreSQL. Keep the original fence until a retry
        // durably confirms the target as active.
        if (rollbackLeaseId && adoptedRollbackLease && ambiguousCommitOutcome !== 'unknown') {
          releaseRollbackLease = false;
          await updateRollbackLeaseState(
            context.get('db'),
            rollbackLeaseId,
            deploymentId,
            'retryable',
            rollbackOwnerId,
            rollbackOwnerId,
          ).catch(() => {
            // A failed state write leaves the lease in `running`, which is a
            // stronger non-adoptable fence until its stale timeout elapses.
          });
        }
      }
      if (!rollbackCommitted && err instanceof RollbackError) {
        if (err.destructiveMigrations) {
          rollbackErrorResponse = context.json(
            { error: err.message, destructiveMigrations: err.destructiveMigrations },
            err.status,
          );
        } else {
          rollbackErrorResponse = context.json(
            { error: err.message, ...(err.userMessage ? { message: err.userMessage } : {}) },
            err.status,
          );
        }
      } else if (!rollbackCommitted) {
        rollbackErrorToThrow = err;
      }
    } finally {
      if (rollbackLeaseId && releaseRollbackLease) {
        let releaseError: unknown;
        let releaseAttemptCompleted = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await deleteRollbackLease(context.get('db'), rollbackLeaseId, rollbackOwnerId);
            releaseAttemptCompleted = true;
            break;
          } catch (error) {
            releaseError = error;
            if (attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
            }
          }
        }
        if (!releaseAttemptCompleted) {
          await updateRollbackLeaseState(
            context.get('db'),
            rollbackLeaseId,
            deploymentId,
            'retryable',
            rollbackOwnerId,
            rollbackOwnerId,
          ).catch(() => {
            // Preserve the running fence if PostgreSQL remains unavailable.
          });
          leaseReleaseError = new AggregateError(
            [releaseError],
            'rollback finished but its project lease could not be released; retry the rollback',
          );
        }
      }
    }

    if (leaseReleaseError) {
      throw leaseReleaseError;
    }
    if (rollbackErrorResponse) {
      return rollbackErrorResponse;
    }
    if (rollbackErrorToThrow !== undefined) {
      throw rollbackErrorToThrow;
    }
    if (!rollbackResult) {
      throw new Error('rollback completed without a result');
    }
    return context.json({
      ok: true,
      deploymentId,
      migrationDiff: rollbackResult.migrationDiff,
    });
  })

  // Get migration status for a project
  .get('/:id/migrations', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const resources = await getProjectResources(context.get('db'), project.id);
    const requestedDialect = context.req.query('dialect');
    if (
      requestedDialect !== undefined &&
      requestedDialect !== 'sqlite' &&
      requestedDialect !== 'postgresql' &&
      requestedDialect !== 'mysql'
    ) {
      return context.json({ error: 'invalid dialect, must be sqlite, postgresql, or mysql' }, 400);
    }

    if (
      requestedDialect === 'postgresql' ||
      requestedDialect === 'mysql' ||
      (requestedDialect === undefined &&
        resources.some((r) => r.type === 'hyperdrive') &&
        !resources.some((r) => r.type === 'd1'))
    ) {
      const applied = await getProjectMigrationRows(context.get('db'), project.id);
      return context.json({ applied });
    }

    const d1Resource = resources.find((r) => r.type === 'd1');
    if (!d1Resource) {
      return context.json({ applied: [] });
    }

    // Torn-read safety across an in-flight legacy → _void_migrations upgrade.
    //
    // The upgrade sequence is three non-atomic D1 calls:
    //   1. CREATE TABLE _void_migrations
    //   2. INSERT OR IGNORE ... FROM _migrations
    //   3. DROP TABLE _migrations
    //
    // Reading _void_migrations first and _migrations second is unsafe: a GET
    // that sees an empty _void_migrations (pre-upgrade) and then races past
    // step 3 sees _migrations missing too — and returns `{ applied: [] }`
    // even though migrations are applied.
    //
    // Reading _migrations FIRST is race-free because of the upgrade invariant:
    // _migrations can only disappear AFTER its rows were copied into
    // _void_migrations. So:
    //
    //   - If legacy read succeeds, we captured the pre-upgrade state.
    //   - If legacy is missing, either it never existed or the upgrade is
    //     past step 2, so _void_migrations is authoritative.
    //
    // Dedup uses a name → applied_at map with last-write-wins, and
    // _void_migrations is always read second so its timestamps win on
    // overlaps.
    const byName = new Map<string, string>();

    try {
      const legacy = await queryD1(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        d1Resource.cf_id,
        {
          sql: 'SELECT name, applied_at FROM _migrations ORDER BY name',
        },
      );
      for (const r of legacy.results) {
        byName.set(r.name as string, r.applied_at as string);
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        return context.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    try {
      const result = await queryD1(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        d1Resource.cf_id,
        {
          sql: 'SELECT name, applied_at FROM _void_migrations ORDER BY name',
        },
      );
      for (const r of result.results) {
        byName.set(r.name as string, r.applied_at as string);
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        return context.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    const applied = Array.from(byName, ([name, applied_at]) => ({ name, applied_at })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    return context.json({ applied });
  })

  // Apply migrations to a project's remote D1 database
  .post('/:id/migrations/apply', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'configure');
    if (access instanceof Response) {
      return access;
    }

    const body = await context.req.json<{
      migrations: ReadonlyArray<{ name: string; sql: string }>;
      migrationProtocolVersion?: number;
      executionPlans?: ReadonlyArray<Record<string, unknown>>;
    }>();
    if (!body.migrations || !Array.isArray(body.migrations)) {
      return context.json({ error: 'migrations array required' }, 400);
    }
    const invalidEntry = body.migrations.find(
      (m) => typeof m.name !== 'string' || !m.name || typeof m.sql !== 'string',
    );
    if (invalidEntry) {
      return context.json(
        { error: 'each migration must have a non-empty string "name" and string "sql"' },
        400,
      );
    }
    const nameSet = new Set<string>();
    for (const m of body.migrations) {
      if (nameSet.has(m.name)) {
        return context.json({ error: `duplicate migration name: ${m.name}` }, 400);
      }
      nameSet.add(m.name);
    }
    const planValidationError = await validateSubmittedExecutionPlans(
      body.migrations,
      body.executionPlans,
    );
    if (planValidationError) {
      return context.json({ error: planValidationError }, 400);
    }

    // Serialize /apply and /rename per project via a pg transaction-scoped
    // row lock on the `projects` row. The critical section holds a pg
    // connection open across remote D1 HTTP calls — not ideal for pool
    // pressure, but these are low-QPS operator flows and correctness
    // trumps efficiency here. The lock prevents an /apply that landed
    // in D1 but has not yet appended to pg metadata from being
    // overtaken by a /rename whose snapshot misses the unwritten row,
    // which would leave D1 and pg permanently diverged.
    try {
      const outcome = await context.get('db').transaction(async (tx) => {
        // Per-project row lock. Must be the first statement so all
        // subsequent reads/writes serialize against any concurrent
        // /apply, /rename, or /rollback holding the same row.
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(
          context,
          projectId,
          'configure',
          tx,
        );
        if (lockedAccess instanceof Response) {
          return {
            status: lockedAccess.status as 403 | 404,
            body: await getProjectAccessErrorBody(lockedAccess),
          };
        }

        const resources = await getProjectResources(tx, projectId);
        const d1Resource = resources.find((r) => r.type === 'd1');
        if (!d1Resource) {
          return { status: 400 as const, body: { error: 'no D1 database found for this project' } };
        }

        // Filter to pending-only before validating destructive patterns
        const applied = await ensureTrackingTable(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          d1Resource.cf_id,
        );
        const pending = body.migrations.filter((m) => !applied.has(m.name));

        const violations = hasUnauthorizedDestructive(pending);
        if (violations.length > 0) {
          return {
            status: 400 as const,
            body: {
              ok: false,
              error: `Destructive migrations without pragma: ${violations.join(', ')}. Add "${DESTRUCTIVE_PRAGMA}" to allow.`,
            },
          };
        }

        const result = await runRemoteMigrations(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          d1Resource.cf_id,
          body.migrations,
          applied,
        );

        // Re-read the project inside the lock so active_deployment_id
        // reflects any concurrent rollback / setActive commit that landed
        // while we were blocked on the lock.
        const locked = lockedAccess.project;
        // Append the UNION of applied + skipped, not just applied.
        //
        // If a previous /apply landed the migration in D1 but the pg
        // metadata write failed, the D1 tracking row is already present.
        // A retry with the same payload then classifies the name as
        // `skipped` (not `applied`). Gating the metadata write on
        // `applied.length > 0` would leave pg permanently missing the
        // name despite D1 having it — corrupting future rollback diffs
        // and rename operations.
        //
        // `appendAppliedMigrations` de-dupes via `SELECT ... FOR UPDATE`
        // + union, so passing names already present in pg is a safe
        // no-op. Passing `skipped` makes the retry reconcile pg from the
        // source of truth (D1's `_void_migrations`).
        //
        // `result.failed` may be set when a mid-batch migration threw —
        // the runner returns the committed prefix (applied + skipped)
        // that DID land in D1 along with the failing pair, and we append
        // the prefix to pg metadata before surfacing the error. The
        // prefix MUST be persisted inside the locked tx so a retry with
        // the same payload sees pg matching D1 and heals idempotently.
        // Returning a non-200 outcome is load-bearing: `return` commits
        // the tx (preserving the healing write) while a `throw` would
        // roll it back.
        const effectiveNames = [...result.applied, ...result.skipped];
        if (effectiveNames.length > 0) {
          await appendProjectMigrations(
            tx,
            projectId,
            effectiveNames,
            locked.active_deployment_id ?? undefined,
          );
        }
        if (effectiveNames.length > 0 && locked.active_deployment_id) {
          await appendAppliedMigrations(tx, locked.active_deployment_id, effectiveNames);
        }

        if (result.failed) {
          const responseBody: Record<string, unknown> = {
            ok: false,
            error: `migration ${result.failed.name} failed: ${result.failed.error}`,
            applied: result.applied,
            skipped: result.skipped,
            failed: result.failed,
          };
          if (body.migrationProtocolVersion === 2) {
            responseBody.migration_protocol = 'legacy';
            responseBody.migration_stability = 'legacy';
          }
          return {
            status: 500 as const,
            body: responseBody,
          };
        }

        const responseBody: Record<string, unknown> = {
          ok: true,
          applied: result.applied,
          skipped: result.skipped,
        };
        if (body.migrationProtocolVersion === 2) {
          responseBody.migration_protocol = 'legacy';
          responseBody.migration_stability = 'legacy';
          responseBody.warnings = [
            'Remote D1 REST migrations use the legacy compensating runner; deploy-time worker protocol v2 provides the stable migration contract.',
          ];
        }
        return {
          status: 200 as const,
          body: responseBody,
        };
      });
      return context.json(outcome.body, outcome.status);
    } catch (err) {
      return context.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  })

  // Rename migration records in a project's remote D1 database
  .post('/:id/migrations/rename', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'configure');
    if (access instanceof Response) {
      return access;
    }

    const body = await context.req.json<{ renames: ReadonlyArray<{ from: string; to: string }> }>();
    if (!body.renames || !Array.isArray(body.renames) || body.renames.length === 0) {
      return context.json({ error: 'renames array required' }, 400);
    }
    const invalidRename = body.renames.find(
      (r) => typeof r.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to,
    );
    if (invalidRename) {
      return context.json({ error: 'each rename must have non-empty string "from" and "to"' }, 400);
    }

    // Batch-level validation: the remote UPDATEs are non-atomic, so any
    // partial commit on a PK collision leaves `_void_migrations` half-renamed
    // with no automatic rollback. Rejecting ambiguous or self-conflicting
    // batches up front means a clean DB can never hit a collision mid-batch.
    const fromSet = new Set<string>();
    const toSet = new Set<string>();
    for (const { from } of body.renames) {
      if (fromSet.has(from)) {
        return context.json({ error: 'duplicate "from" in rename batch' }, 400);
      }
      fromSet.add(from);
    }
    for (const { to } of body.renames) {
      if (toSet.has(to)) {
        return context.json({ error: 'duplicate "to" in rename batch' }, 400);
      }
      toSet.add(to);
    }
    // Chains and cycles (`a→b, b→c` or `a→b, b→a`) would need two-phase
    // renames across non-atomic D1 calls to avoid a mid-batch PK collision.
    // Rejecting them forces the caller to split the work into separate
    // requests and keeps this handler's execution path strictly linear.
    for (const { to } of body.renames) {
      if (fromSet.has(to)) {
        return context.json(
          {
            error:
              'rename "to" conflicts with another rename "from" in batch — chains not supported',
          },
          400,
        );
      }
    }

    // Serialize /apply and /rename per project via a pg transaction-scoped
    // row lock on the `projects` row. Holding the lock across the D1
    // HTTP calls is what prevents the /apply-vs-/rename interleave where
    // /apply writes a row to D1, /rename then snapshots D1 + rewrites pg
    // (missing the new row), and /apply finally appends the pre-rename
    // name to pg.
    try {
      const outcome = await context.get('db').transaction(async (tx) => {
        // Per-project row lock. Must be the first statement so all
        // subsequent reads/writes serialize against any concurrent
        // /apply, /rename, or /rollback holding the same row.
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(
          context,
          projectId,
          'configure',
          tx,
        );
        if (lockedAccess instanceof Response) {
          return {
            status: lockedAccess.status as 403 | 404,
            body: {
              ok: false,
              ...(await getProjectAccessErrorBody(lockedAccess)),
            },
          };
        }

        const resources = await getProjectResources(tx, projectId);
        const d1Resource = resources.find((r) => r.type === 'd1');
        if (!d1Resource) {
          return { status: 400 as const, body: { error: 'no D1 database found for this project' } };
        }

        // Ensure tracking table exists and upgrade legacy _migrations if needed.
        // The returned set is the current applied state — reused for validation
        // below so we don't issue a redundant SELECT.
        const existing = await ensureTrackingTable(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          d1Resource.cf_id,
        );

        // DB-state validation. The semantics below exist so that retries after
        // a partial failure are safe and idempotent, not just fresh batches:
        //
        //   - unknown `from` AND unknown `to`  → 400 (genuine operator error)
        //   - unknown `from` AND known   `to`  → ambiguous: only treat as an
        //     already-landed rename when pg metadata still references `from`
        //     somewhere (the fingerprint of a legitimate retry after a prior
        //     D1-succeeded / pg-failed run). Otherwise 400 — see below.
        //   - known   `from` AND known   `to`  → 400 (would collide on UPDATE,
        //     unless the existing `to` row is itself also being renamed away —
        //     but batch-level validation already rejects chains, so that case
        //     cannot occur here)
        //   - known   `from` AND unknown `to`  → proceed (normal case)
        const missingFrom: Array<string> = [];
        const collidingTo: Array<string> = [];
        const effective: Array<{ from: string; to: string }> = [];
        const alreadyLanded: Array<{ from: string; to: string }> = [];
        for (const { from, to } of body.renames) {
          const fromExists = existing.has(from);
          const toExists = existing.has(to);
          if (!fromExists && !toExists) {
            missingFrom.push(from);
            continue;
          }
          if (!fromExists && toExists) {
            // The `!fromExists && toExists` branch must NOT unconditionally
            // classify as an idempotent retry. A request targeting an
            // unrelated existing migration (e.g., pg has `001_init.sql`
            // and D1 happens to have `002_add_email.sql` from a different
            // deploy) would silently rewrite pg to a wrong target.
            //
            // The fingerprint of a legitimate retry after a prior
            // D1-succeeded / pg-failed run is: D1 has `to`, D1 lacks `from`
            // (already renamed in D1), and pg STILL has `from` on the
            // ACTIVE deployment (the failed pg write left it stale).
            //
            // Corroboration is restricted to the ACTIVE deployment.
            // Stale retained rows from older code paths could be
            // historically inaccurate and are not trustworthy corroboration.
            //
            // A second corroboration source (the `migration_renames` audit
            // log) is required because partial-failure heal writes pg's
            // `applied_migrations` BEFORE surfacing the later pair's
            // failure — so once an earlier pair's committed prefix is
            // persisted, the active deployment no longer references
            // `from`. A same-payload retry that exercises the
            // still-failing pair must still be able to pass the
            // committed prefix through the classifier idempotently, or
            // the operator is wedged with no way to retry. The audit log
            // is written in the same locked tx as the heal, so a matching
            // row is durable proof that this exact (project_id, from, to)
            // rename was already committed here — which fat-finger
            // requests will never have.
            const stalePg = await activeDeploymentContainsMigration(tx, projectId, from);
            const auditLogged = stalePg
              ? false
              : await migrationRenameExists(tx, projectId, from, to);
            if (!stalePg && !auditLogged) {
              return {
                status: 400 as const,
                body: {
                  ok: false,
                  error:
                    `rename "${from}" → "${to}" is ambiguous: D1 already has "${to}" and no deployment ` +
                    `metadata references "${from}". Refusing to rewrite metadata without corroboration.`,
                },
              };
            }
            // Already-landed rename — idempotent no-op, but still record the
            // pair so pg metadata gets rewritten if it is stale.
            alreadyLanded.push({ from, to });
            continue;
          }
          if (fromExists && toExists) {
            collidingTo.push(to);
            continue;
          }
          effective.push({ from, to });
        }
        if (missingFrom.length > 0) {
          return {
            status: 400 as const,
            body: { error: `unknown "from" migration(s): ${missingFrom.join(', ')}` },
          };
        }
        if (collidingTo.length > 0) {
          return {
            status: 400 as const,
            body: { error: `"to" migration(s) already exist: ${collidingTo.join(', ')}` },
          };
        }

        // After validation, no clean-DB batch can hit a PK collision. Network
        // failures mid-batch can still leave partial state, but retries with
        // the same payload are safe because every already-landed rename is
        // detected by the validation block above and skipped.
        //
        // meta.changes is inspected on every UPDATE. When two concurrent
        // /rename requests both pass pre-validation against the same
        // `from`, only one UPDATE actually changes a row — the loser sees
        // `changes === 0`. We re-query `_void_migrations` to classify the
        // zero-changes case:
        //
        //   - if the row we wanted (`to`) is already present AND `from` is
        //     gone, a concurrent winner achieved the same end state and we
        //     treat this pair as already-landed (skip in D1, still rewrite
        //     pg metadata so stale entries get fixed).
        //   - otherwise the winner redirected `from` to some OTHER target,
        //     so our rename lost a race to a conflicting target → return
        //     409 and do NOT append this pair to the pg rewrite set.
        //
        // Only pairs whose D1 UPDATE actually changed a row (or that
        // classified as already-landed via the recheck) are forwarded to
        // `renameAppliedMigrationsForProject`.
        // Committed pairs MUST be persisted to pg even when a later pair
        // in the same batch fails. Earlier iterations landed their UPDATE
        // in D1 — that state is durable and cannot be rolled back by
        // throwing. Throwing would also bubble out of the locked tx and
        // roll back any pg rewrite, leaving pg's applied_migrations arrays
        // pointing at the old names while D1 already holds the new names.
        //
        // So: stash the per-pair failure, STOP the loop (continuing past
        // a 409 risks later pairs being misclassified against the winner's
        // rewritten rows), persist the committed prefix via
        // `renameAppliedMigrationsForProject` inside the same locked tx,
        // and then `return` a 409/500 outcome. A `return` commits the tx
        // (preserving the heal); a `throw` would roll it back.
        const committed: Array<{ from: string; to: string }> = [...alreadyLanded];
        type PairFailure =
          | { kind: 'conflict'; from: string; to: string }
          | { kind: 'error'; from: string; to: string; error: string };
        let pairFailure: PairFailure | undefined;
        for (const { from, to } of effective) {
          let update: Awaited<ReturnType<typeof queryD1>>;
          try {
            update = await queryD1(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              d1Resource.cf_id,
              {
                sql: 'UPDATE _void_migrations SET name = ? WHERE name = ?',
                params: [to, from],
              },
            );
          } catch (err) {
            pairFailure = {
              kind: 'error',
              from,
              to,
              error: err instanceof Error ? err.message : String(err),
            };
            break;
          }
          if ((update.meta?.changes ?? 1) > 0) {
            committed.push({ from, to });
            continue;
          }
          // Zero rows affected — a concurrent rename already moved `from`.
          // Re-check the tracking table to see whether the winner landed on
          // the same `to` we wanted (benign) or a different target (conflict).
          let recheck: Awaited<ReturnType<typeof queryD1>>;
          try {
            recheck = await queryD1(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              d1Resource.cf_id,
              {
                sql: 'SELECT name FROM _void_migrations WHERE name = ? OR name = ?',
                params: [from, to],
              },
            );
          } catch (err) {
            pairFailure = {
              kind: 'error',
              from,
              to,
              error: err instanceof Error ? err.message : String(err),
            };
            break;
          }
          const names = new Set(recheck.results.map((r) => r.name as string));
          if (!names.has(from) && names.has(to)) {
            // Winner happened to pick the same target — our end state holds.
            committed.push({ from, to });
            continue;
          }
          pairFailure = { kind: 'conflict', from, to };
          break;
        }

        // Rewrite applied_migrations for EVERY deployment of this project,
        // not just the active one — retained and inactive deployments would
        // otherwise keep the old names and break rollback diffs that compare
        // `applied_migrations` arrays across deployments. Only renames whose
        // D1 UPDATE actually committed (or that we classified as an already-
        // landed retry) are forwarded — conflicted pairs never reach here.
        //
        // This runs BEFORE surfacing any pair-level failure so the
        // committed prefix is persisted atomically with the `return` below.
        //
        // The `migration_renames` audit log entry is the durable second
        // corroboration source that lets a same-payload retry after a
        // partial-failure heal classify already-committed pairs as
        // idempotent — `renameAppliedMigrationsForProject` has just erased
        // any `from` reference from the active deployment, so the
        // `activeDeploymentContainsMigration` check would otherwise reject
        // the committed prefix on retry and wedge the operator.
        //
        // Before recording each committed pair, invalidate any prior audit
        // rows whose `to_name` matches the new pair's `from`. Those rows
        // claim "some earlier rename landed at `from`", but `from` is now
        // being renamed AWAY — the landing claim is no longer valid, and
        // a fat-fingered retry quoting a recycled lineage must not be
        // corroborated by the stale row. Invalidation runs inside the
        // same locked tx as the heal/record, so a rollback unwinds all
        // three together.
        if (committed.length > 0) {
          await renameProjectMigrations(tx, projectId, committed);
          await renameAppliedMigrationsForProject(tx, projectId, committed);
          for (const { from } of committed) {
            await invalidateMigrationRenamesForOldName(tx, projectId, from);
          }
          await recordMigrationRenames(tx, projectId, committed);
        }

        if (pairFailure) {
          if (pairFailure.kind === 'conflict') {
            return {
              status: 409 as const,
              body: {
                ok: false,
                error: `rename conflict: "${pairFailure.from}" was concurrently renamed to a different target`,
                committed,
              },
            };
          }
          return {
            status: 500 as const,
            body: {
              ok: false,
              error: `rename "${pairFailure.from}" → "${pairFailure.to}" failed: ${pairFailure.error}`,
              committed,
            },
          };
        }

        return { status: 200 as const, body: { ok: true } };
      });
      return context.json(outcome.body, outcome.status);
    } catch (err) {
      return context.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  })

  // List resources for a project
  .get('/:id/resources', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    const resources = await getProjectResources(context.get('db'), project.id);
    return context.json(resources);
  })

  // Fetch logs for a project
  .get('/:id/logs', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const since = context.req.query('since') ?? '1h';
    const sinceMs = parseDuration(since);
    if (sinceMs === null) {
      return context.json({ error: 'invalid since parameter, use format like 15m, 2h, 3d' }, 400);
    }

    const limit = parseAnalyticsLimit(context.req.query('limit'));
    if (limit === null) {
      return context.json({ error: 'invalid limit parameter, use a positive integer' }, 400);
    }
    const deploymentId = context.req.query('deploymentId');
    if (deploymentId && !/^dpl_[0-9a-z]+$/.test(deploymentId)) {
      return context.json({ error: 'invalid deploymentId format' }, 400);
    }

    // Optional level filter applied at the AE SQL layer so sparse error rows
    // are not hidden behind successful invocations by the LIMIT clause. The
    // 'all' value is treated as absence; any other value must be in the fixed
    // allowlist (allowlist check, not regex, so future code can't widen this
    // accidentally and let a tainted value reach the SQL string).
    const levelParam = context.req.query('level');
    const ALLOWED_LEVELS = ['error', 'warn', 'info', 'log', 'debug'] as const;
    type LogLevel = (typeof ALLOWED_LEVELS)[number];
    let level: LogLevel | null = null;
    if (levelParam !== undefined && levelParam !== 'all') {
      if (!(ALLOWED_LEVELS as ReadonlyArray<string>).includes(levelParam)) {
        return context.json(
          {
            error: `invalid level parameter, must be one of: error, warn, info, log, debug, all`,
          },
          400,
        );
      }
      level = levelParam as LogLevel;
    }

    const workerName = `user-${project.slug}`;
    // A slug can be reused after deletion, so rows from before this project
    // existed belong to an earlier owner.
    const createdAtMs = databaseTimestampMs(project.created_at) ?? 0;
    const startMs = Math.max(Date.now() - sinceMs, createdAtMs);
    const sinceStr = new Date(startMs).toISOString().replace('T', ' ').slice(0, 19);
    const dataset = context.env.LOGS_DATASET ?? 'void_logs';

    const deployFilter = deploymentId ? `\n        AND blob7 = '${deploymentId}'` : '';
    let levelFilter = '';
    if (level === 'error') {
      // Catch non-ok outcomes (blob1), captured exceptions (blob3 non-empty
      // array), console.error logs (blob2 has level:"error"), and 5xx responses
      // (blob6 statusCode) even when the worker neither threw nor logged.
      levelFilter = `\n        AND (blob1 != 'ok' OR blob3 != '[]' OR blob2 LIKE '%"level":"error"%' OR blob6 LIKE '5%')`;
    } else if (level !== null) {
      levelFilter = `\n        AND blob2 LIKE '%"level":"${level}"%'`;
    }

    // `timestamp` is when the row was written, in whole seconds, and keeps the
    // scan short. An earlier owner's invocation can start before this project
    // was created and still be written after, so also bound its start time
    // (`double1`, in ms).
    const query = `
      SELECT
        blob1 as outcome,
        blob2 as logData,
        blob3 as exceptionData,
        blob4 as url,
        blob5 as method,
        blob6 as statusCode,
        blob7 as deployId,
        double1 as ts,
        min(timestamp) as ingestedAt
      FROM ${dataset}
      WHERE index1 = '${workerName}'
        AND timestamp >= toDateTime('${sinceStr}')
        AND double1 >= ${createdAtMs}${deployFilter}${levelFilter}
      ${LOG_ROW_GROUP_BY}
      ORDER BY ingestedAt DESC
      LIMIT ${limit}
    `;

    const response = await queryAnalyticsEngine(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      query,
    );

    const responseText = await response.text();
    if (!response.ok) {
      console.error(
        `[logs] query failed for project ${project.id} (${response.status}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        { error: 'log query failed', status: response.status, detail: responseText.slice(0, 500) },
        502,
      );
    }

    // CF's Analytics Engine API normally returns JSON, but a 2xx response can
    // carry an HTML error page during edge incidents (status pages, DDoS
    // interstitials). Parse defensively so the handler returns a clean 502
    // instead of throwing an uncaught SyntaxError that Hono maps to a 500.
    let result: {
      data: ReadonlyArray<{
        outcome: string;
        logData: string;
        exceptionData: string;
        url: string;
        method: string;
        statusCode: string;
        ts: number;
      }>;
    };
    try {
      result = JSON.parse(responseText) as typeof result;
    } catch {
      console.error(
        `[logs] non-JSON response for project ${project.id} (${response.status} ${response.headers.get('content-type') ?? 'unknown'}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        {
          error: 'log query returned non-JSON response',
          status: response.status,
          detail: responseText.slice(0, 500),
        },
        502,
      );
    }

    // Query newest-first to match the admin log path, then return entries in
    // chronological order for CLI readability.
    const data = [...(result.data ?? [])].reverse().map((row) => ({
      timestamp: row.ts,
      outcome: row.outcome,
      logs: tryParse(row.logData),
      exceptions: tryParse(row.exceptionData),
      url: row.url,
      method: row.method,
      status: row.statusCode,
    }));

    return context.json({ data });
  })
  // Fetch request-level metering for a project. Unlike /logs (which only has
  // user-worker tail rows), this reads the dispatch request-metering dataset,
  // so it also surfaces 5xx that dispatch generated itself (missing manifest,
  // static-asset/SSR timeouts) and requests to static/SPA projects that never
  // invoke a worker.
  .get('/:id/requests', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;

    const since = context.req.query('since') ?? '1h';
    const sinceMs = parseDuration(since);
    if (sinceMs === null) {
      return context.json({ error: 'invalid since parameter, use format like 15m, 2h, 3d' }, 400);
    }

    const limit = parseAnalyticsLimit(context.req.query('limit'));
    if (limit === null) {
      return context.json({ error: 'invalid limit parameter, use a positive integer' }, 400);
    }

    // Optional status filter: a class like `5xx` (LIKE '5%') or an exact 3-digit
    // code (equality). Validated so no tainted value reaches the SQL string.
    const statusParam = context.req.query('status');
    let statusFilter = '';
    if (statusParam !== undefined && statusParam !== 'all') {
      if (/^[1-5]xx$/.test(statusParam)) {
        statusFilter = `\n        AND blob4 LIKE '${statusParam[0]}%'`;
      } else if (/^[1-5]\d{2}$/.test(statusParam)) {
        // Range-bounded so a typo like `600` errors instead of silently
        // matching nothing.
        statusFilter = `\n        AND blob4 = '${statusParam}'`;
      } else {
        return context.json(
          { error: 'invalid status parameter, use a class like 5xx or an exact code like 500' },
          400,
        );
      }
    }

    const sinceStr = new Date(Date.now() - sinceMs).toISOString().replace('T', ' ').slice(0, 19);
    const dataset = getRequestsDataset(context.env);

    // void_requests columns (see dispatch recordRequest): blob2 type, blob3
    // method, blob4 status, blob5 slug; double2 responseBytes, double3 durationMs.
    const query = `
      SELECT
        blob2 as type,
        blob3 as method,
        blob4 as status,
        double2 as bytes,
        double3 as durationMs,
        timestamp
      FROM ${dataset}
      WHERE blob1 = '${project.id}'
        AND timestamp >= toDateTime('${sinceStr}')${statusFilter}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    const response = await queryAnalyticsEngine(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      query,
    );

    const responseText = await response.text();
    if (!response.ok) {
      console.error(
        `[requests] query failed for project ${project.id} (${response.status}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        {
          error: 'request query failed',
          status: response.status,
          detail: responseText.slice(0, 500),
        },
        502,
      );
    }

    let result: {
      data: ReadonlyArray<{
        type: string;
        method: string;
        status: string;
        bytes: number;
        durationMs: number;
        timestamp: string;
      }>;
    };
    try {
      result = JSON.parse(responseText) as typeof result;
    } catch {
      console.error(
        `[requests] non-JSON response for project ${project.id} (${response.status} ${response.headers.get('content-type') ?? 'unknown'}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        {
          error: 'request query returned non-JSON response',
          status: response.status,
          detail: responseText.slice(0, 500),
        },
        502,
      );
    }

    // Query newest-first (matches /logs), return chronological for readability.
    const data = [...(result.data ?? [])].reverse().map((row) => ({
      timestamp: row.timestamp,
      type: row.type,
      method: row.method,
      status: row.status,
      bytes: row.bytes,
      durationMs: row.durationMs,
    }));

    return context.json({ data });
  })

  // List recent builds for a project.
  .get('/:id/builds', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    const rawLimit = Number(context.req.query('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const rows = await getProjectBuilds(context.get('db'), project.id, limit);
    return context.json({ builds: rows.map(toBuildSummary) });
  })
  // Build logs for one of a project's builds. Fronts the
  // BuildManager DO for container builds; github_actions builds return their
  // external GitHub Actions URL (no DO log store exists for them).
  .get('/:id/builds/:buildId/logs', async (context) => {
    const access = await requireProjectRouteCapability(context, context.req.param('id'), 'read');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    const build = await getBuild(context.get('db'), context.req.param('buildId'));
    if (!build || build.project_id !== project.id) {
      return context.json({ error: 'build not found' }, 404);
    }

    const raw = Number(context.req.query('since'));
    const since = Number.isFinite(raw) ? raw : 0;
    const terminal = isTerminalBuildStatus(build.status);

    if (build.executor !== 'container') {
      return context.json({
        lines: [],
        lastSeq: 0,
        status: build.status,
        terminal,
        logsComplete: terminal,
        external: build.logs_url ?? null,
      });
    }

    const ns = buildManagerNamespace(context.env, build.instance_type);
    const stub = ns.get(ns.idFromName(build.id));
    const res = await stub.fetch(`http://manager/logs?since=${since}`);
    const body = (await res.json()) as {
      lines: ReadonlyArray<{ seq: number; line: string; stream: string; ts: number }>;
      lastSeq: number;
      status?: string;
      terminal?: boolean;
      logsComplete?: boolean | null;
    };
    // Claiming a container build durably sets started_at. Only a terminal row
    // that was never claimed can prove completion without a producer marker.
    const logsComplete = body.logsComplete ?? (terminal && build.started_at === null ? true : null);
    // The DO holds the authoritative live status. A completion path sets the DO
    // terminal FIRST, then does the Postgres CAS write — so if that PG write
    // throws, the PG `build.status` row can lag ACTIVE until the stale reaper.
    // OR the two terminal signals (terminal is never resurrected) so a follower
    // can finish once the DO also confirms its final log drain.
    const doTerminal = body.terminal === true;
    if (doTerminal && !terminal) {
      // Snapshot was non-terminal but the DO is terminal. Two cases:
      //  (a) a concurrent terminalizer committed cancelled/failed after our
      //      snapshot — Postgres is authoritative, use the fresh status; or
      //  (b) the genuine stale-active window (PG terminal write threw) — PG is
      //      still non-terminal, so trust the DO's local terminal status.
      const fresh = await getBuild(context.get('db'), build.id);
      return context.json({
        lines: body.lines,
        lastSeq: body.lastSeq,
        status:
          fresh && isTerminalBuildStatus(fresh.status)
            ? fresh.status
            : (body.status ?? build.status),
        terminal: true,
        logsComplete,
        external: null,
      });
    }
    return context.json({
      lines: body.lines,
      lastSeq: body.lastSeq,
      status: build.status,
      terminal,
      logsComplete,
      external: null,
    });
  })

  // Provision Hyperdrive for an external database project
  .post('/:id/database', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'configure');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    // Fast rejection; the transaction below rechecks status and capability
    // under the project lock before touching Cloudflare.
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }

    const { connectionString } = await context.req.json<{ connectionString: string }>();

    // Check if Hyperdrive already exists
    const existing = await getProjectResources(context.get('db'), projectId);
    const found = existing.find((r) => r.type === 'hyperdrive');
    if (found) {
      return context.json(
        { error: 'Hyperdrive already provisioned. Use PUT /database-url to update.' },
        409,
      );
    }

    const resourceName = getHyperdriveResourceName(projectId);
    // Track whether WE created the CF Hyperdrive (vs. adopting a pre-existing one
    // via the already-exists branch) — only a self-created object is safe to
    // roll back if the locked DB transaction later fails.
    let hyperdriveId: string | undefined;
    let hyperdriveCreatedByUs = false;
    const encrypted = await encryptProjectSecret(
      context.env,
      projectId,
      'database-url',
      connectionString,
    );
    try {
      const lockedResponse = await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(
          context,
          projectId,
          'configure',
          tx,
        );
        if (lockedAccess instanceof Response) {
          return lockedAccess;
        }
        if (lockedAccess.project.status === 'deleting') {
          return context.json({ error: 'Project is being deleted' }, 409);
        }

        // Re-read after acquiring the lock. Membership changes, teardown, and
        // a competing database provision all serialize on this project row.
        const lockedResources = await getProjectResources(tx, projectId);
        if (lockedResources.some((resource) => resource.type === 'hyperdrive')) {
          return context.json(
            { error: 'Hyperdrive already provisioned. Use PUT /database-url to update.' },
            409,
          );
        }

        try {
          const hd = await createOrAdoptHyperdrive(context.env, resourceName, connectionString);
          hyperdriveId = hd.id;
          hyperdriveCreatedByUs = hd.created;
        } catch (err: unknown) {
          const response = toDatabaseProvisioningError(err);
          if (response) {
            return context.json(response.body, response.status);
          }
          throw err;
        }

        if (!hyperdriveId) {
          throw new Error('Cloudflare did not return a Hyperdrive ID');
        }
        try {
          // Persist both handles in the same transaction. If either write or
          // COMMIT fails, the outer catch removes a Hyperdrive we created so
          // no untracked CF object is left behind.
          await upsertProjectDatabaseUrl(
            tx,
            projectId,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.keyVersion,
          );
          await createResource(tx, projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
        } catch (error) {
          throw new DatabaseUrlPersistenceError(error);
        }
        return null;
      });
      if (lockedResponse) {
        return lockedResponse;
      }
    } catch (err: unknown) {
      if (hyperdriveCreatedByUs && hyperdriveId) {
        await deleteHyperdrive(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          hyperdriveId,
        ).catch(() => {});
      }
      if (err instanceof DatabaseUrlPersistenceError) {
        return context.json(
          {
            error:
              'Failed to persist database URL after Cloudflare accepted it. Run `void db set-url` again to re-sync.',
          },
          500,
        );
      }
      throw err;
    }
    return context.json({ ok: true });
  })

  // Update external database connection string (updates Hyperdrive config)
  .put('/:id/database-url', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'configure');
    if (access instanceof Response) {
      return access;
    }
    const project = access.project;
    // Fast rejection; the transaction below performs the authoritative check.
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }

    const { connectionString } = await context.req.json<{ connectionString: string }>();

    const encrypted = await encryptProjectSecret(
      context.env,
      projectId,
      'database-url',
      connectionString,
    );
    const resourceName = getHyperdriveResourceName(projectId);
    let createdHyperdriveId: string | undefined;
    try {
      const lockedResponse = await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedAccess = await requireProjectRouteCapability(
          context,
          projectId,
          'configure',
          tx,
        );
        if (lockedAccess instanceof Response) {
          return lockedAccess;
        }
        if (lockedAccess.project.status === 'deleting') {
          return context.json({ error: 'Project is being deleted' }, 409);
        }

        // Resolve the resource only after taking the lock. This prevents two
        // creates and ensures a downgrade/removal is authoritative before any
        // live Hyperdrive update is sent to Cloudflare.
        const lockedResources = await getProjectResources(tx, projectId);
        const lockedHyperdrive = lockedResources.find((resource) => resource.type === 'hyperdrive');
        if (lockedHyperdrive) {
          try {
            await updateHyperdrive(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              lockedHyperdrive.cf_id,
              connectionString,
              resourceName,
            );
          } catch (err: unknown) {
            const response = toDatabaseProvisioningError(err);
            if (response) {
              return context.json(response.body, response.status);
            }
            throw err;
          }
        } else {
          let hyperdriveId: string;
          try {
            const hd = await createOrAdoptHyperdrive(context.env, resourceName, connectionString);
            hyperdriveId = hd.id;
            if (hd.created) {
              createdHyperdriveId = hd.id;
            }
          } catch (err: unknown) {
            const response = toDatabaseProvisioningError(err);
            if (response) {
              return context.json(response.body, response.status);
            }
            throw err;
          }
          try {
            await createResource(tx, projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
          } catch (error) {
            throw new DatabaseUrlPersistenceError(error);
          }
        }

        try {
          await upsertProjectDatabaseUrl(
            tx,
            projectId,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.keyVersion,
          );
        } catch (error) {
          throw new DatabaseUrlPersistenceError(error);
        }
        return null;
      });
      if (lockedResponse) {
        return lockedResponse;
      }
    } catch (err: unknown) {
      // Only a freshly-created object is safe to hand back. Adopted or
      // pre-existing Hyperdrives may still be referenced by a prior attempt.
      if (createdHyperdriveId) {
        await deleteHyperdrive(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          createdHyperdriveId,
        ).catch(() => {});
      }
      if (err instanceof DatabaseUrlPersistenceError) {
        return context.json(
          {
            error:
              'Failed to persist database URL after Cloudflare accepted it. Run `void db set-url` again to re-sync.',
          },
          500,
        );
      }
      throw err;
    }

    return context.json({ ok: true });
  })

  // Retrieve the stored (encrypted-at-rest) external database connection string
  .get('/:id/database-url', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'configure');
    if (access instanceof Response) {
      return access;
    }
    if (access.role !== 'owner') {
      return context.json(
        { error: 'forbidden', message: PROJECT_PERMISSION_MESSAGES['database-url'] },
        403,
      );
    }

    const row = await getProjectDatabaseUrl(context.get('db'), projectId);
    if (!row) {
      return context.json(
        {
          error: 'database_url_not_stored',
          message:
            "This project's database URL is not stored on the platform yet. Run `void db set-url` once to populate it.",
        },
        404,
      );
    }

    const url = await decryptProjectSecret(context.env, projectId, {
      name: 'database-url',
      ciphertext: row.ciphertext,
      iv: row.iv,
      key_version: row.key_version,
    });
    return context.json({ url });
  });

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    return null;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = value * multipliers[unit];
  if (ms > 7 * 86_400_000) {
    return null;
  } // cap at 7d
  return ms;
}

/**
 * Parse an optional positive `limit` query (default 200, capped at 500).
 * Validated before use: an unchecked negative reaches the SQL `LIMIT` and
 * surfaces an Analytics Engine rejection as a misleading 502 rather than a
 * client error.
 */
function parseAnalyticsLimit(value: string | undefined): number | null {
  if (value === undefined) {
    return 200;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(parsed, 500);
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('already exists');
}

/**
 * Create the project's Hyperdrive, or adopt one an earlier partial attempt left
 * untracked under the same name by updating it in place. Callers hold the
 * project lock so no membership change can interleave the live update and the
 * durable resource row. `created` is true only for a fresh object — the only
 * kind that is safe to delete if persistence later fails.
 */
async function createOrAdoptHyperdrive(
  env: ApiEnv['Bindings'],
  resourceName: string,
  connectionString: string,
): Promise<{ id: string; created: boolean }> {
  try {
    const hd = await createHyperdrive(
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      resourceName,
      connectionString,
    );
    return { id: hd.id, created: true };
  } catch (err: unknown) {
    if (!isAlreadyExistsError(err)) {
      throw err;
    }
  }
  const hd = await getHyperdriveByName(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, resourceName);
  await updateHyperdrive(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    hd.id,
    connectionString,
    resourceName,
  );
  return { id: hd.id, created: false };
}

function getHyperdriveResourceName(projectId: string): string {
  return `${projectId}-hyperdrive`.toLowerCase().replaceAll('_', '-');
}

function toDatabaseProvisioningError(
  error: unknown,
): { body: { detail?: string; error: string }; status: 400 | 502 } | null {
  if (error instanceof CloudflareApiError) {
    return {
      body: {
        error: 'Failed to provision Hyperdrive',
        detail: error.message.replace(/^Cloudflare API error:\s*/, ''),
      },
      status: 502,
    };
  }

  if (error instanceof InvalidHyperdriveConnectionStringError) {
    return {
      body: { error: error.message },
      status: 400,
    };
  }

  return null;
}

/** Remove plaintext environment values from manifests returned to read-only callers. */
function sanitizeDeploymentManifest(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  delete parsed.vars;
  return JSON.stringify(parsed);
}

function tryParse(json: string): ReadonlyArray<unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

/**
 * Run `work` after the response is sent. Falls back to inline `await` when
 * there is no ExecutionContext — a test harness calling `app.fetch(req, env)`
 * with two arguments — so the side effect still happens and stays observable.
 *
 * Only the missing-context error is recovered; anything else propagates so a
 * real bug inside `waitUntil` is not swallowed. `work` must handle its own
 * failures: on the fallback path a rejection would surface as a 5xx.
 */
async function scheduleAfterResponse(
  context: Context<ApiEnv>,
  work: Promise<unknown>,
): Promise<void> {
  try {
    context.executionCtx.waitUntil(work);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/has no ExecutionContext|ExecutionContext is not available/i.test(message)) {
      await work;
      return;
    }
    throw err;
  }
}

/**
 * Register the project owner's own email as a destination for a new project.
 *
 * Entirely best-effort — the outer catch is the point, not an oversight. A
 * degraded CF Email Routing must not fail project creation, and the owner can
 * re-add the address from the dashboard.
 *
 * On a second-or-later project the address is already on the CF account, so
 * `addDestination` reports "already exists"; we recover by listing and reusing
 * the existing tag along with any `verified` status the owner earned earlier.
 * Without that recovery every additional project would start with an empty
 * allowlist.
 *
 * Trusting CF's `verified` flag is sound here only because the address IS the
 * project owner's own — the same human already consented on a prior project
 * (owner-relaxed reuse, Option C in design doc 0078). `verification_source`
 * stays `'cf'` and the audit columns record whose consent was inherited, so a
 * later email change can revoke exactly these rows. A `pending` row inherits
 * nothing and therefore carries no audit.
 */
async function autoAddOwnerDestination(
  accountId: string,
  apiToken: string,
  db: Db,
  projectId: string,
  address: string,
  ownerUserId: string,
): Promise<void> {
  // Set the moment Cloudflare holds an account-level address for us — on the
  // fresh-create path AND on the already-exists recovery path, which adopts an
  // address the account already carries. Everything after that point can fail
  // with the address still allocated and no row pointing at it.
  let allocatedTag: string | null = null;
  try {
    let cfRow;
    try {
      cfRow = await addDestination(accountId, apiToken, address);
    } catch (err) {
      if (!isDestinationAlreadyExistsError(err)) {
        throw err;
      }
      const all = await listDestinations(accountId, apiToken);
      const found = all.find((row) => row.email.toLowerCase() === address);
      if (!found) {
        throw err;
      }
      cfRow = found;
    }
    allocatedTag = cfRow.tag;
    const status = cfRow.verified ? 'verified' : 'pending';
    // `address` was the owner's email when the request came in, before the
    // Cloudflare calls above. Inheriting CF's `verified` flag is only sound
    // while that is STILL true, and the helper checks it under a lock that
    // serializes with the login-side email change — a plain re-read here
    // would not see that change until it commits. A `pending` row inherits
    // nothing, so it needs no such check.
    const { row, ownerEmailChanged } = await tryCreateEmailDestination(
      db,
      projectId,
      address,
      cfRow.tag,
      status,
      cfRow.verified ?? null,
      'cf',
      {
        ownerAudit:
          status === 'verified' ? { userId: ownerUserId, emailSnapshot: address } : undefined,
      },
    );
    if (ownerEmailChanged) {
      // The owner's address moved while CF was answering. The consent this
      // row would inherit belongs to a mailbox they no longer hold, and no
      // later login would revisit it (they compare the stored address with
      // the provider's, and those now agree). Best-effort means they can
      // add a recipient by hand; the rollback below releases the tag if
      // nothing else references it.
      throw new Error('owner email changed while the address was being registered');
    }
    if (!row) {
      // The helper's hard-error outcome: a manual add for the same address
      // won the ON CONFLICT race, and its row was deleted before the
      // read-back. That deleter released the tag only if it counted itself
      // as the last reference — teardown's cascade window, or an upstream
      // delete that failed, leaves the tag live with no row pointing at it,
      // which is exactly what the rollback below exists for. No retry, unlike
      // the POST route: the owner just removed this address on purpose, and
      // re-inserting it here would resurrect a row they revoked. Best-effort
      // means they can re-add it.
      throw new Error('owner destination row vanished between insert and read-back');
    }
  } catch (err) {
    console.error('[projects] auto-add owner email destination failed:', err);
    if (allocatedTag) {
      // Roll back on ANY error, not just the foreign-key violation that
      // project teardown's cascade raises. This path is best-effort and runs
      // after the 201, so nothing retries it and nothing reports it: once CF
      // has allocated the address, any failure past that point means no row
      // persisted to reference it, and an unreferenced address is invisible
      // to teardown's cleanup while still costing the shared 200-per-account
      // cap. Rolling back unconditionally is simpler and safer than an
      // FK-only check. The `refs === 0` guard inside `rollbackCfDestination`
      // is what stops it revoking a recipient a sibling project still uses —
      // including the already-exists path, where the address predates us.
      await rollbackCfDestination(db, accountId, apiToken, allocatedTag);
    }
  }
}

/**
 * OAuth-provider synthetic addresses that are not real mailboxes — registering
 * one would only generate an undeliverable CF verification email. Today just
 * GitHub's; add patterns as providers ship.
 */
function isSyntheticProviderEmail(email: string): boolean {
  return /@users\.noreply\.github\.com$/i.test(email);
}

export default app;

export async function createUserProject(
  context: Context<ApiEnv>,
  body: { slug: string },
): Promise<Response> {
  if (!body.slug) {
    return context.json({ error: 'slug is required' }, 400);
  }

  // Lowercase alphanumeric with dashes, short enough to fit in front of `+noreply@`
  // in a 64-octet SMTP local-part, and not reserved. The CLI treats this 400 as
  // re-promptable.
  const nameError = projectNameError(body.slug, 'slug');
  if (nameError) {
    return context.json({ error: nameError }, 400);
  }

  // Preserve short-slug eligibility when an administrator copies or renames a plan.
  if (body.slug.length <= 5) {
    if (!(await resolvePlan(context.get('db'), context.get('user').plan)).allowShortSlugs) {
      return context.json(
        { error: 'the selected plan does not permit short slugs (5 characters or fewer)' },
        403,
      );
    }
  }

  // A slug is also a mailbox on the shared mail domain, so it may not equal
  // another project's email alias either.
  const existing =
    (await getProjectBySlug(context.get('db'), body.slug)) ??
    (await getProjectByEmailAlias(context.get('db'), body.slug));
  if (existing) {
    return context.json({ error: 'slug already taken' }, 409);
  }

  const userId = context.get('user').id;
  try {
    // `void platform uninstall --purge-resources` holds this lock across its last
    // check for projects and records the uninstall before releasing it, so a
    // project either commits before that check or is refused here.
    const project = await context.get('db').transaction(async (tx) => {
      await lockZeroTrustConfiguration(tx, 'shared');
      return createProject(tx, userId, body.slug);
    });
    let zeroTrust: Awaited<ReturnType<typeof initializeNewProjectZeroTrust>> = null;
    let zeroTrustWarning: string | undefined;
    try {
      zeroTrust = await initializeNewProjectZeroTrust(context.env, context.get('db'), project.id);
    } catch (error) {
      zeroTrustWarning =
        'Project created, but its Zero Trust protection is not set up yet, so deploys will wait. Void retries within an hour. To retry now, a project owner or admin can run `void project zero-trust reconcile`; if that reports the platform is not ready, ask a platform administrator.';
      console.error('[zero-trust] new project initialization failed', {
        projectId: project.id,
        error,
      });
    }
    // Pre-seed the owner's own address as a destination so mail to
    // themselves works from the first deploy. CF sends them a verification
    // link; the row stays `pending` until they click it.
    //
    // Gated on the `email` platform capability AND EMAIL_SENDER_DOMAIN:
    // the row's only purpose is to allow-list a recipient for sends from
    // `<slug>[+tag]@<domain>`, so on a platform that does not enable email
    // (its `/email/*` routes answer 501) or in an environment with no
    // platform mail domain there is nothing it could ever authorize — and
    // registering it would still cost CF a verification email to the owner.
    const ownerEmail = context.get('user').email;
    if (
      getPlatformCapabilities(context.env).email &&
      context.env.EMAIL_SENDER_DOMAIN &&
      ownerEmail &&
      !isSyntheticProviderEmail(ownerEmail)
    ) {
      const address = ownerEmail.toLowerCase();
      // Off the response path: CF Email Routing has no timeout in
      // `cfFetch`, and project creation must not wait on it. Nothing
      // downstream depends on the row existing yet — a pending row emits
      // no allowlist entry either way.
      await scheduleAfterResponse(
        context,
        autoAddOwnerDestination(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          context.get('db'),
          project.id,
          address,
          userId,
        ),
      );
      // Tell the caller WHICH address is being registered, and nothing
      // more: whether CF mails a verification link (fresh address) or
      // adopts one the owner already verified is decided by the add above,
      // which has not run yet. The CLI prints this so the verification
      // email that may follow is explained; `void email destinations`
      // shows the outcome.
      return context.json(
        {
          ...project,
          owner_email_destination: { address },
          ...(zeroTrust ? { zero_trust: publicProjectZeroTrustState(zeroTrust) } : {}),
          ...(zeroTrustWarning ? { warnings: [zeroTrustWarning] } : {}),
        },
        201,
      );
    }
    return context.json(
      {
        ...projectWithUrl(project, context.env),
        ...(zeroTrust ? { zero_trust: publicProjectZeroTrustState(zeroTrust) } : {}),
        ...(zeroTrustWarning ? { warnings: [zeroTrustWarning] } : {}),
      },
      201,
    );
  } catch (err) {
    // Only the configuration lock above throws this here: the uninstall
    // record exists.
    if (err instanceof ZeroTrustUnavailableError) {
      return context.json(
        { error: 'The platform is being uninstalled, so new projects cannot be created.' },
        err.status,
      );
    }
    // Unique constraint violation: the slug, or an alias with that name, was
    // taken between check and insert.
    if (hasSqlState(err, '23505')) {
      return context.json({ error: 'slug already taken' }, 409);
    }
    throw err;
  }
}
