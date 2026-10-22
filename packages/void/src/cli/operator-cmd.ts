import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { OperatorArgs } from './operator-args.ts';
import {
  exchangeOperatorSession,
  readOperatorApiTokenStdin,
  readOperatorToken,
  removeOperatorToken,
  resolveOperatorOrigin,
  saveOperatorToken,
} from './operator-auth.ts';
import { OperatorClient, OperatorClientError } from './operator-client.ts';
import { printSuccess, sanitizeTerminalText } from './output.ts';

const MAX_RUNTIME_FOLLOW_ROWS = 10_000;
export const BUILD_LOG_DRAIN_TIMEOUT_MS: number = 2 * 60_000;

function printable(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'string') {
    // Tenant text must not execute terminal control sequences.
    return sanitizeTerminalText(value);
  }
  if (typeof value === 'object') {
    // JSON escapes C0 controls but leaves C1 controls such as U+009B (CSI) raw.
    return sanitizeTerminalText(JSON.stringify(value));
  }
  return String(value);
}

function table(rows: Array<unknown>, indent: string): Array<string> {
  if (!rows.length) {
    return [`${indent}(none)`];
  }
  if (!rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    return rows.map((row) => `${indent}${printable(row)}`);
  }
  const records = rows as Array<Record<string, unknown>>;
  const keys = [...new Set(records.flatMap((row) => Object.keys(row)))].filter((key) =>
    records.some((row) => row[key] !== null && typeof row[key] !== 'object'),
  );
  const preferred = [
    'id',
    'name',
    'login',
    'email',
    'slug',
    'status',
    'plan',
    'action',
    'target',
    'created_at',
    'version',
  ];
  const columns = [
    ...preferred.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !preferred.includes(key)),
  ].slice(0, 7);
  if (!columns.length) {
    return records.flatMap((row) => humanLines(row, indent));
  }
  const widths = columns.map((key) =>
    Math.min(64, Math.max(key.length, ...records.map((row) => printable(row[key]).length))),
  );
  const rowText = (values: Array<string>) =>
    indent +
    values
      .map((value, index) => {
        const width = widths[index]!;
        return (value.length > width ? `${value.slice(0, width - 1)}…` : value).padEnd(width);
      })
      .join('  ')
      .trimEnd();
  return [
    rowText(columns.map((key) => key.toUpperCase())),
    ...records.map((row) => rowText(columns.map((key) => printable(row[key])))),
  ];
}

function eventLines(events: Array<unknown>, indent: string): Array<string> {
  if (!events.length) {
    return [`${indent}(none)`];
  }
  return events.flatMap((event, index) => [
    `${indent}${index + 1}.`,
    ...humanLines(event, `${indent}  `),
  ]);
}

const LABEL_WORDS: Record<string, string> = {
  api: 'API',
  dns: 'DNS',
  github: 'GitHub',
  http: 'HTTP',
  id: 'ID',
  ids: 'IDs',
  oauth: 'OAuth',
  oidc: 'OIDC',
  url: 'URL',
  urls: 'URLs',
};

function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => LABEL_WORDS[word.toLowerCase()] ?? word.toLowerCase());
  if (words[0]) {
    words[0] = words[0][0]!.toUpperCase() + words[0].slice(1);
  }
  return words.join(' ');
}

export function humanLines(value: unknown, indent = ''): Array<string> {
  if (Array.isArray(value)) {
    return table(value, indent);
  }
  if (!value || typeof value !== 'object') {
    return [`${indent}${printable(value)}`];
  }
  return Object.entries(value).flatMap(([key, item]) => {
    const label = fieldLabel(key);
    if (Array.isArray(item)) {
      return [
        `${indent}${label}:`,
        ...(key === 'events' ? eventLines(item, `${indent}  `) : table(item, `${indent}  `)),
      ];
    }
    if (item && typeof item === 'object') {
      return [`${indent}${label}:`, ...humanLines(item, `${indent}  `)];
    }
    return [`${indent}${label}: ${printable(item)}`];
  });
}

function output(value: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(value) : humanLines(value).join('\n'));
}

function outputMutation(result: Record<string, unknown>, args: OperatorArgs): void {
  output(result, args.json);
  // Some successful HTTP responses checkpoint work rather than complete it.
  const configuration = result.configuration as { status?: string } | undefined;
  const project = result.project as { state?: string; last_error?: string | null } | undefined;
  if (
    args.json ||
    result.ok === false ||
    result.partial === true ||
    result.complete === false ||
    result.error ||
    (result.operationStatus && result.operationStatus !== 'completed') ||
    (configuration?.status &&
      configuration.status !== 'ready' &&
      configuration.status !== 'disabled') ||
    project?.state === 'reconciling' ||
    project?.state === 'error' ||
    project?.last_error
  ) {
    return;
  }
  printSuccess(`Platform ${args.group} ${args.action} completed.`);
}

function outputLogs(result: Record<string, unknown>, json: boolean): void {
  if (json) {
    output(result, true);
    return;
  }
  if (Array.isArray(result.lines)) {
    for (const entry of result.lines) {
      if (entry && typeof entry === 'object') {
        const line = entry as Record<string, unknown>;
        console.log(
          `${line.ts ? `[${printable(line.ts)}] ` : ''}${printable(line.line ?? line.text ?? entry)}`,
        );
      } else {
        console.log(printable(entry));
      }
    }
    if (result.external) {
      console.log(`External build logs: ${printable(result.external)}`);
    }
    if (result.terminal) {
      console.log(`Build ${printable(result.status ?? 'finished')}.`);
    }
  } else if (Array.isArray(result.data)) {
    for (const entry of result.data) {
      if (!entry || typeof entry !== 'object') {
        console.log(printable(entry));
        continue;
      }
      const row = entry as Record<string, unknown>;
      console.log(
        `${printable(row.timestamp ?? row.ts)} ${printable(row.method)} ${printable(row.url)} ${printable(row.status ?? row.statusCode ?? row.outcome)}`,
      );
      if (Array.isArray(row.logs)) {
        for (const log of row.logs) {
          if (log && typeof log === 'object') {
            const record = log as Record<string, unknown>;
            console.log(
              `  ${record.level ? `[${printable(record.level)}] ` : ''}${printable(record.message ?? log)}`,
            );
          } else {
            console.log(`  ${printable(log)}`);
          }
        }
      }
      if (Array.isArray(row.exceptions)) {
        for (const exception of row.exceptions) {
          if (exception && typeof exception === 'object') {
            const record = exception as Record<string, unknown>;
            const name = record.name ? `${printable(record.name)}: ` : '';
            console.log(`  ${name}${printable(record.message ?? exception)}`);
          } else {
            console.log(`  ${printable(exception)}`);
          }
        }
      }
    }
    if (result.nextCursor) {
      console.log(`Next cursor: ${printable(result.nextCursor)}`);
    }
  } else {
    output(result, false);
  }
}

function operationRecoveryFence(value: unknown): {
  stepId: string;
  attempt: number;
  requestDigest: string;
  resourceIdentity: string;
  connectionId: string;
  desiredGeneration: number;
  routeId: string | null;
  routeDesiredGeneration: number | null;
} {
  const target =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !target ||
    typeof target.stepId !== 'string' ||
    typeof target.attempt !== 'number' ||
    !Number.isSafeInteger(target.attempt) ||
    typeof target.requestDigest !== 'string' ||
    typeof target.resourceIdentity !== 'string' ||
    typeof target.connectionId !== 'string' ||
    typeof target.desiredGeneration !== 'number' ||
    !Number.isSafeInteger(target.desiredGeneration) ||
    (target.routeId !== null && typeof target.routeId !== 'string') ||
    (target.routeDesiredGeneration !== null &&
      (typeof target.routeDesiredGeneration !== 'number' ||
        !Number.isSafeInteger(target.routeDesiredGeneration)))
  ) {
    throw new OperatorClientError(
      'The server did not return a valid email operation recovery fence. No change was requested.',
      'invalid_preview',
    );
  }
  return {
    stepId: target.stepId,
    attempt: target.attempt,
    requestDigest: target.requestDigest,
    resourceIdentity: target.resourceIdentity,
    connectionId: target.connectionId,
    desiredGeneration: target.desiredGeneration,
    routeId: target.routeId,
    routeDesiredGeneration: target.routeDesiredGeneration,
  };
}

function runtimeLogFingerprint(row: unknown): string {
  const ingestedAt =
    row && typeof row === 'object' && !Array.isArray(row)
      ? (row as Record<string, unknown>).ingestedAt
      : undefined;
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    typeof ingestedAt !== 'number' ||
    !Number.isSafeInteger(ingestedAt)
  ) {
    throw new OperatorClientError(
      'Runtime log response has an invalid ingestion cursor.',
      'invalid_response',
    );
  }
  return createHash('sha256').update(JSON.stringify(row)).digest('base64url');
}

export async function confirmOperatorMutation(
  origin: string,
  preview: Record<string, unknown>,
  args: Pick<OperatorArgs, 'yes' | 'plan' | 'json'>,
): Promise<boolean> {
  if (args.plan) {
    output({ origin, ...preview }, args.json);
    return false;
  }
  // Unattended JSON mode reserves stderr for a single structured failure.
  // The server preview still runs and is validated before every mutation.
  if (!args.json || !args.yes) {
    process.stderr.write(`${JSON.stringify({ origin, ...preview }, null, 2)}\n`);
  }
  if (args.yes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new OperatorClientError(
      'Mutations in non-interactive mode require --yes or --plan.',
      'confirmation_required',
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`Apply this change to ${origin}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new OperatorClientError('Cancelled.', 'cancelled');
    }
    return true;
  } finally {
    prompt.close();
  }
}

async function runAuth(origin: string, args: OperatorArgs): Promise<void> {
  if (args.action === 'login' || (args.action === 'token' && args.tokenStdin)) {
    if (!args.tokenStdin && !process.stdin.isTTY) {
      throw new OperatorClientError(
        'Browser login requires an interactive terminal. Use --token-stdin to exchange an API session.',
        'interactive_login_required',
      );
    }
    const apiToken = args.tokenStdin
      ? await readOperatorApiTokenStdin()
      : await (async () => {
          const { discoverPlatform } = await import('./platform-cmd.ts');
          const { selectPlatformLoginMethod } = await import('./login.ts');
          const { runPlatformLogin } = await import('./auth.ts');
          const method = await selectPlatformLoginMethod(
            await discoverPlatform(origin),
            args.provider,
          );
          return runPlatformLogin(origin, method.id, (url) =>
            process.stderr.write(`Sign in at ${url}\n`),
          );
        })();
    const session = await exchangeOperatorSession(origin, apiToken);
    const { token, ...identity } = session;
    if (args.action === 'token') {
      if (args.json) {
        output({ origin, ...session }, true);
      } else {
        console.log(token);
      }
    } else {
      saveOperatorToken(origin, token);
      output({ origin, ...identity }, args.json);
      if (!args.json) {
        printSuccess('Signed in to platform administration.');
      }
    }
    return;
  }
  const token = readOperatorToken(origin);
  const client = new OperatorClient(origin, token);
  if (args.action === 'logout') {
    try {
      await client.request('/session/logout', { method: 'POST', body: {} });
    } catch (error) {
      // An already expired/revoked session may still be removed locally.
      if (!(error instanceof OperatorClientError) || error.status !== 401) {
        throw error;
      }
    }
    removeOperatorToken(origin);
    output(
      {
        origin,
        ok: true,
        ...(process.env.VOID_OPERATOR_TOKEN
          ? { message: 'Operator session revoked. Unset VOID_OPERATOR_TOKEN in your shell.' }
          : {}),
      },
      args.json,
    );
    if (!args.json) {
      printSuccess('Signed out of platform administration.');
    }
  } else {
    const session = await client.request('/session');
    if (args.action === 'token') {
      if (args.json) {
        output({ origin, token, ...session }, true);
      } else {
        console.log(token);
      }
    } else {
      output({ origin, ...session }, args.json);
    }
  }
}

/** Poll cursors until interrupted (runtime) or terminal (build), without mutation retries. */
export async function followOperatorLogs(
  client: OperatorClient,
  args: OperatorArgs,
  signal?: AbortSignal,
  pollIntervalMs = 2_000,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const query = { ...args.query };
  let terminalBuildSince: number | null = null;
  let previousRuntimeRows = new Map<string, number>();
  let currentRuntimeRows = new Map<string, number>();
  let currentRuntimeRowCount = 0;
  try {
    while (!combined.aborted) {
      const result = await client.request(args.path, { query, signal: combined });
      let visibleResult = result;
      if (args.group === 'deployment') {
        if (!Array.isArray(result.data)) {
          throw new OperatorClientError(
            'Runtime log response is missing its data rows.',
            'invalid_response',
          );
        }
        const data = result.data.filter((row) => {
          currentRuntimeRowCount++;
          if (currentRuntimeRowCount > MAX_RUNTIME_FOLLOW_ROWS) {
            throw new OperatorClientError(
              `Runtime log follow window exceeded ${MAX_RUNTIME_FOLLOW_ROWS} rows. Retry without --follow and query a narrower history.`,
              'invalid_response',
            );
          }
          const fingerprint = runtimeLogFingerprint(row);
          const occurrence = (currentRuntimeRows.get(fingerprint) ?? 0) + 1;
          currentRuntimeRows.set(fingerprint, occurrence);
          return occurrence > (previousRuntimeRows.get(fingerprint) ?? 0);
        });
        visibleResult = { ...result, data };
      }
      outputLogs(visibleResult, args.json);
      if (args.group === 'build') {
        if (
          typeof result.lastSeq !== 'number' ||
          !Number.isSafeInteger(result.lastSeq) ||
          result.lastSeq < Number(query.since ?? 0)
        ) {
          throw new OperatorClientError(
            'Build log response has an invalid cursor.',
            'invalid_response',
          );
        }
        const previousSeq = Number(query.since ?? 0);
        query.since = String(result.lastSeq);
        if (result.hasMore === true) {
          if (result.lastSeq === previousSeq) {
            throw new OperatorClientError(
              'Build log pagination did not advance.',
              'invalid_response',
            );
          }
          continue;
        }
        if (
          result.logsComplete !== undefined &&
          result.logsComplete !== null &&
          typeof result.logsComplete !== 'boolean'
        ) {
          throw new OperatorClientError(
            'Build log response has an invalid completion state.',
            'invalid_response',
          );
        }
        if (result.terminal === true) {
          if (result.logsComplete === true) {
            return;
          }
          // `null` means the current server cannot prove completion. `undefined`
          // comes from platforms before 0.20.0. Operator commands do not run the
          // minimum platform version check, so keep it.
          if (result.logsComplete === null || result.logsComplete === undefined) {
            throw new OperatorClientError(
              'This platform cannot confirm that the final build logs were captured. Upgrade the platform runtime, or read the retained logs without --follow.',
              'log_completion_unavailable',
            );
          }
          const now = Date.now();
          terminalBuildSince ??= now;
          if (now - terminalBuildSince >= BUILD_LOG_DRAIN_TIMEOUT_MS) {
            throw new OperatorClientError(
              'Build finished, but its log producer did not confirm completion. Retry the command to recover the final log tail.',
              'invalid_response',
            );
          }
        } else {
          terminalBuildSince = null;
        }
      } else {
        if (typeof result.nextCursor === 'string' && result.nextCursor) {
          if (result.nextCursor === query.cursor) {
            throw new OperatorClientError(
              'Runtime log pagination did not advance.',
              'invalid_response',
            );
          }
          query.cursor = result.nextCursor;
          continue;
        }
        delete query.cursor;
        if (typeof result.watermark !== 'string' && typeof result.watermark !== 'number') {
          throw new OperatorClientError(
            'Runtime log response is missing its follow watermark.',
            'invalid_response',
          );
        }
        previousRuntimeRows = currentRuntimeRows;
        currentRuntimeRows = new Map();
        currentRuntimeRowCount = 0;
        query.after = String(result.watermark);
        delete query.since;
      }
      await delay(pollIntervalMs, undefined, { signal: combined });
    }
  } catch (error) {
    if (!combined.aborted) {
      throw error;
    }
  } finally {
    process.removeListener('SIGINT', stop);
  }
}

async function migrateDeploymentAssets(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
): Promise<void> {
  const target = decodeURIComponent(
    args.path.slice('/deployments/'.length, -'/migrate-assets'.length),
  );
  const seenCursors = new Set<string>();
  let body = { ...args.body };
  if (typeof body.cursor === 'string') {
    seenCursors.add(body.cursor);
  }
  let authorized = false;
  while (true) {
    const preview = await client.request(args.path, {
      method: 'POST',
      body: { ...body, dryRun: true },
      timeoutMs: args.timeoutMs,
    });
    if (
      preview.dryRun !== true ||
      preview.action !== 'deployment.migrate-assets' ||
      preview.target !== target ||
      typeof preview.expected !== 'string' ||
      !preview.expected.trim()
    ) {
      throw new OperatorClientError(
        'The server did not return a valid asset migration preview. No asset batch was requested.',
        'invalid_preview',
      );
    }
    if (
      !(await confirmOperatorMutation(
        origin,
        {
          ...preview,
          scope:
            'Copy and verify all remaining asset batches for this deployment; keep original assets.',
        },
        authorized ? { ...args, yes: true } : args,
      ))
    ) {
      return;
    }
    authorized = true;
    // Each batch is pinned to its own preview. Failed or ambiguous writes are never retried.
    const result = await client.request(args.path, {
      method: 'POST',
      body: { ...body, expected: preview.expected },
      timeoutMs: args.timeoutMs,
    });
    const nextCursor = result.nextCursor;
    if (
      result.dryRun !== false ||
      result.action !== 'deployment.migrate-assets' ||
      result.target !== target ||
      typeof result.complete !== 'boolean' ||
      (result.complete
        ? nextCursor !== null
        : typeof nextCursor !== 'string' || !nextCursor.trim() || seenCursors.has(nextCursor))
    ) {
      throw new OperatorClientError(
        'The server returned an invalid asset migration continuation. Inspect the deployment before resuming; no batch was retried.',
        'invalid_response',
        undefined,
        { target, lastSuccessfulCursor: body.cursor ?? null, result },
      );
    }
    // Preserve each successful continuation in stdout if a later batch fails or is interrupted.
    output(result, args.json);
    if (result.complete) {
      if (!args.json) {
        printSuccess('Deployment assets migrated.');
      }
      return;
    }
    const cursor = nextCursor as string;
    seenCursors.add(cursor);
    body = { ...args.body, cursor };
  }
}

export async function runOperatorCommand(args: OperatorArgs): Promise<void> {
  if (!args.action) {
    const { printHelpPage } = await import('./help.ts');
    printHelpPage(['platform', args.group]);
    return;
  }
  const origin = resolveOperatorOrigin(args.connection);
  if (args.group === 'auth') {
    return runAuth(origin, args);
  }
  const client = new OperatorClient(origin, readOperatorToken(origin));
  if (args.method === 'POST') {
    // Fail before contacting the server when unattended mutation authorization is missing.
    if (!args.plan && !args.yes && (!process.stdin.isTTY || !process.stderr.isTTY)) {
      throw new OperatorClientError(
        'Mutations in non-interactive mode require --yes or --plan.',
        'confirmation_required',
      );
    }
    if (args.group === 'deployment' && args.action === 'migrate-assets') {
      return migrateDeploymentAssets(client, origin, args);
    }
    // Read once for preview and apply; the server excludes the token from audit output.
    if (
      args.tokenStdin &&
      ((args.group === 'email' &&
        (args.action === 'domain-add' || args.action === 'domain-remove')) ||
        (args.group === 'zero-trust' && args.action === 'configure'))
    ) {
      args = { ...args, body: { ...args.body, apiToken: await readOperatorApiTokenStdin() } };
    }
    const preview = await client.request(args.path, {
      method: 'POST',
      body: { ...args.body, dryRun: true },
      timeoutMs: args.timeoutMs,
    });
    if (
      preview.dryRun !== true ||
      typeof preview.action !== 'string' ||
      !Object.hasOwn(preview, 'target')
    ) {
      throw new OperatorClientError(
        'The server did not return a valid mutation preview. No change was requested.',
        'invalid_preview',
      );
    }
    let recoveryFence: Record<string, unknown> =
      args.group === 'email' && args.action === 'operation-resolve'
        ? operationRecoveryFence(preview.target)
        : {};
    if (args.group === 'email' && args.action === 'shared-recipient-resolve') {
      const target = preview.target as Record<string, unknown> | null;
      if (
        !target ||
        typeof target.recoveryFence !== 'string' ||
        !/^[a-f0-9]{64}$/.test(target.recoveryFence)
      ) {
        throw new OperatorClientError(
          'The server did not return a valid shared recipient recovery fence. No change was requested.',
          'invalid_preview',
        );
      }
      recoveryFence = { recoveryFence: target.recoveryFence };
    }
    // An older platform ignores outboundOnly and would take over the domain's MX.
    if (
      args.group === 'email' &&
      args.action === 'domain-add' &&
      args.body.outboundOnly === true &&
      (preview.target as Record<string, unknown> | null)?.inboundMode !== 'none'
    ) {
      throw new OperatorClientError(
        'This platform does not support outbound-only email domains. Upgrade it first. No change was requested.',
        'unsupported',
      );
    }
    if (!(await confirmOperatorMutation(origin, preview, args))) {
      return;
    }
    const body = {
      ...args.body,
      ...(args.group === 'worker' && args.action === 'rollback-all'
        ? { versions: preview.versions }
        : {}),
      ...(args.group === 'project' && args.action === 'normalize'
        ? { expected: preview.changes }
        : {}),
      ...recoveryFence,
    };
    outputMutation(
      await client.request(args.path, { method: 'POST', body, timeoutMs: args.timeoutMs }),
      args,
    );
  } else if (args.follow) {
    await followOperatorLogs(client, args);
  } else {
    const result = await client.request(args.path, { query: args.query });
    if (args.action === 'logs' && args.group !== 'email') {
      outputLogs(result, args.json);
    } else if (
      args.group === 'system' &&
      args.action === 'asset-migrations' &&
      !args.json &&
      Array.isArray(result.deployments)
    ) {
      // Keep every migration count and protection flag visible without table truncation.
      console.log(
        [
          ...humanLines({ pagination: result.pagination }),
          'Deployments:',
          ...eventLines(result.deployments, '  '),
        ].join('\n'),
      );
    } else {
      output(result, args.json);
    }
    if (result.allOk === false) {
      process.exitCode = 1;
    }
  }
}
