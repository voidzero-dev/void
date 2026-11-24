import type { OperatorArgs } from './operator-args.ts';
import { OperatorClientError } from './operator-client.ts';
import type { OperatorClient } from './operator-client.ts';
import { dim, printSuccess } from './output.ts';
import { sarifToolVersion, securityFindingsSarif } from './security-sarif.ts';
import type { SarifFinding } from './security-sarif.ts';

type Result = Record<string, unknown>;

/** What the runner borrows from `operator-cmd.ts` (passed in, so the two files do not import each other). */
export type SecurityIo = {
  output: (value: unknown, json: boolean) => void;
  outputMutation: (result: Result, args: OperatorArgs) => void;
  confirm: (
    origin: string,
    preview: Result,
    args: Pick<OperatorArgs, 'yes' | 'plan' | 'json'>,
  ) => Promise<boolean>;
};

const NOT_INSTALLED =
  'Security audits are not installed. Run: void platform upgrade --security-audits';

/** The platform answers 501 `platform capability unavailable` when the capability is off. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof OperatorClientError &&
      error.status === 501 &&
      error.code === 'platform capability unavailable'
    ) {
      throw new OperatorClientError(NOT_INSTALLED, error.code, error.status, error.details);
    }
    throw error;
  }
}

/** The path of one finding: the command path keeps `:fid` until here. */
function findingPath(path: string, id: string): string {
  return path.replace(':fid', encodeURIComponent(id));
}

function findingIds(args: OperatorArgs): Array<string> {
  const ids = args.body.findingIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

function validPreview(preview: Result): void {
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
}

async function previewOf(
  client: OperatorClient,
  args: OperatorArgs,
  path: string,
  body: Result,
): Promise<Result> {
  const preview = await client.request(path, {
    method: 'POST',
    body: { ...body, dryRun: true },
    timeoutMs: args.timeoutMs,
  });
  validPreview(preview);
  return preview;
}

/** The policy preview carries the whole policy; the change lines are what a person reads. */
function shown(preview: Result): Result {
  const { policy: _policy, ...rest } = preview;
  return rest;
}

function money(value: unknown): string {
  return typeof value === 'number' ? `$${value.toFixed(2)}` : 'an unknown amount';
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/** Reads. `show` takes comma-separated finding ids. */
async function runRead(client: OperatorClient, args: OperatorArgs, io: SecurityIo): Promise<void> {
  if (args.action === 'show') {
    const ids = findingIds(args);
    const details: Array<Result> = [];
    for (const id of ids) {
      details.push(await client.request(findingPath(args.path, id)));
    }
    io.output(details.length === 1 ? details[0] : { findings: details }, args.json);
    return;
  }
  if (args.action === 'findings-sarif') {
    return exportFindingsSarif(client, args);
  }
  io.output(await client.request(args.path, { query: args.query }), args.json);
}

/** The SARIF export reads this many pages of 100 findings, at most. */
const SARIF_MAX_PAGES = 100;

/** `findings --format sarif`: every matching finding, page by page, as one SARIF log. */
async function exportFindingsSarif(client: OperatorClient, args: OperatorArgs): Promise<void> {
  const findings: Array<SarifFinding> = [];
  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, SARIF_MAX_PAGES); page++) {
    const result = await client.request(args.path, {
      query: { ...args.query, page: String(page), limit: '100' },
    });
    const rows = Array.isArray(result.findings) ? (result.findings as Array<SarifFinding>) : [];
    findings.push(...rows);
    totalPages = number(result.totalPages) ?? 1;
    if (rows.length === 0) {
      break;
    }
  }
  console.log(
    JSON.stringify(securityFindingsSarif(findings, { version: sarifToolVersion() }), null, 2),
  );
  if (totalPages > SARIF_MAX_PAGES) {
    process.stderr.write(
      `Only the first ${SARIF_MAX_PAGES * 100} findings are in the file. Narrow it with --project, --severity or --urgent.\n`,
    );
  }
}

/** One policy-shaped change: preview, confirm, then apply at the previewed revision. */
async function changeWithRevision(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
  body: Result,
): Promise<void> {
  const preview = await previewOf(client, args, args.path, body);
  if (!(await io.confirm(origin, shown(preview), args))) {
    return;
  }
  const revision = number(preview.expectedRevision);
  if (revision === undefined) {
    throw new OperatorClientError(
      'The server did not return a policy revision. No change was requested.',
      'invalid_preview',
    );
  }
  const result = await client.request(args.path, {
    method: 'POST',
    body: { ...body, expectedRevision: revision },
    timeoutMs: args.timeoutMs,
  });
  io.outputMutation(result, args);
}

/** The notice version the platform currently asks operators to accept. */
async function currentNoticeVersion(client: OperatorClient): Promise<number> {
  const policy = await client.request('/security/policy');
  const notice = policy.providerNotice as { version?: unknown } | undefined;
  const version = number(notice?.version);
  if (version === undefined) {
    throw new OperatorClientError(
      'The platform did not report its provider notice version.',
      'invalid_response',
    );
  }
  return version;
}

async function runFindings(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
): Promise<void> {
  const ids = findingIds(args);
  const { findingIds: _ids, ...fields } = args.body;
  const items: Array<{ id: string; path: string; body: Result; preview: Result }> = [];
  // Preview every finding before the first write, so a typo in the last id changes nothing.
  for (const id of ids) {
    const path = findingPath(args.path, id);
    let body: Result = { ...fields };
    if (args.action !== 'comment') {
      // The path ends in `/resolve` or `/reopen`; the finding itself is one level up.
      const show = await client.request(path.slice(0, path.lastIndexOf('/')));
      const finding = show.finding as { revision?: unknown } | undefined;
      const revision = number(finding?.revision);
      if (revision === undefined) {
        throw new OperatorClientError(
          `The platform did not report the revision of ${id}.`,
          'invalid_response',
        );
      }
      body = { ...body, expectedRevision: revision };
    }
    items.push({ id, path, body, preview: await previewOf(client, args, path, body) });
  }
  const combined: Result =
    items.length === 1
      ? items[0]!.preview
      : {
          dryRun: true,
          action: items[0]!.preview.action,
          target: { findings: items.map((item) => item.id) },
          previews: items.map((item) => item.preview),
        };
  if (!(await io.confirm(origin, combined, args))) {
    return;
  }
  const results: Array<Result> = [];
  let failed = 0;
  for (const item of items) {
    try {
      results.push(
        await client.request(item.path, {
          method: 'POST',
          body: item.body,
          timeoutMs: args.timeoutMs,
        }),
      );
    } catch (error) {
      failed++;
      results.push({
        ok: false,
        id: item.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (items.length === 1 && failed === 0) {
    io.outputMutation(results[0]!, args);
    return;
  }
  io.output({ results }, args.json);
  if (failed > 0) {
    throw new OperatorClientError(
      `${failed} of ${items.length} findings were not changed. See the results above; the others were.`,
      'partial_failure',
    );
  }
  if (!args.json) {
    printSuccess(`Platform security ${args.action} completed.`);
  }
}

async function runBudget(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
): Promise<void> {
  const body: Result = { ...args.body };
  if (args.path.startsWith('/projects/')) {
    // One project's limit: a plain write, no revision.
    const preview = await previewOf(client, args, args.path, body);
    if (!(await io.confirm(origin, preview, args))) {
      return;
    }
    const result = await client.request(args.path, {
      method: 'POST',
      body,
      timeoutMs: args.timeoutMs,
    });
    io.outputMutation(result, args);
    const budget = result.budget as { capSource?: unknown; capUsd?: unknown } | undefined;
    const set = body.monthlyUsd;
    if (
      !args.json &&
      typeof set === 'number' &&
      budget?.capSource === 'own' &&
      typeof budget.capUsd === 'number' &&
      budget.capUsd < set
    ) {
      const project = decodeURIComponent(args.path.split('/')[2]!);
      console.log(
        `${project}'s own cap (${money(budget.capUsd)}) is lower and still applies. A project admin can raise it: void project security budget --usd ${set}`,
      );
    }
    return;
  }
  if (body.projectCapsOn === true) {
    // `--project-caps on` with no amount applies the saved default to every project.
    delete body.projectCapsOn;
    const current = await client.request('/security/budget');
    const saved = (current.projectDefault as { monthlyUsd?: unknown } | undefined)?.monthlyUsd;
    if (typeof saved !== 'number') {
      throw new OperatorClientError(
        'The platform did not report the default project cap. Set one: --project-default-usd <amount>.',
        'invalid_response',
      );
    }
    body.projectDefaultMonthlyUsd = saved;
  }
  await changeWithRevision(client, origin, args, io, body);
}

async function runRescan(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
): Promise<void> {
  const preview = await previewOf(client, args, args.path, args.body);
  if (args.body.clientAssets === true && preview.clientAssets !== true) {
    throw new OperatorClientError(
      'This platform cannot read client bundle sources yet. Upgrade it, or run the rescan without --client-assets.',
      'unsupported',
    );
  }
  if (!args.json && !args.plan) {
    // The server's preview is the cost check (edge #43): say what it would run and what it can cost.
    const target = preview.target as unknown;
    const id = typeof preview.deploymentId === 'string' ? preview.deploymentId : String(target);
    const model = typeof preview.model === 'string' ? preview.model : 'the scan model';
    const whole =
      preview.clientAssets === true
        ? 'This reviews the whole app, and the sources of its client bundles.'
        : 'This reviews the whole app.';
    const first =
      preview.alreadyScanned === true
        ? `Live deployment ${id} was already scanned. Run a full scan with ${model}? ${whole}`
        : `Run a full scan of live deployment ${id} with ${model}? ${whole}`;
    process.stderr.write(
      `${first}${typeof preview.worstCaseUsd === 'number' ? ` It can cost up to ${money(preview.worstCaseUsd)}.` : ''}\n${dim('Monthly caps apply; raise the cap first if a rescan is refused.')}\n`,
    );
  }
  if (!(await io.confirm(origin, preview, args))) {
    return;
  }
  const result = await client.request(args.path, {
    method: 'POST',
    body: args.body,
    timeoutMs: args.timeoutMs,
  });
  io.output(result, args.json);
  if (args.json) {
    return;
  }
  // The scan is only queued here: it waits its turn like any scan.
  const scanId = typeof result.scanId === 'string' ? ` (${result.scanId})` : '';
  // The path is `/projects/<id>/security/scans`.
  const project =
    typeof result.project === 'string'
      ? result.project
      : decodeURIComponent(args.path.split('/')[2] ?? '');
  printSuccess(
    `Rescan queued${scanId}. Check it: void platform security scans --project ${project}`,
  );
}

async function runBackfill(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
): Promise<void> {
  const preview = await previewOf(client, args, args.path, args.body);
  const count = number(preview.willQueue) ?? 0;
  if (!args.json && !args.plan) {
    const remaining = number(preview.remaining) ?? 0;
    const cost =
      typeof preview.worstCaseUsd === 'number'
        ? ` Together they can cost up to ${money(preview.worstCaseUsd)}.`
        : '';
    const missing = number(preview.noStoredCode) ?? 0;
    const missingText =
      missing > 0
        ? `${missing} never-scanned live ${missing === 1 ? 'deployment has' : 'deployments have'} no stored code, so ${missing === 1 ? 'it cannot' : 'they cannot'} be scanned. Deploy ${missing === 1 ? 'that project' : 'those projects'} again.\n`
        : '';
    process.stderr.write(
      count === 0
        ? `${missing > 0 ? 'Nothing to backfill.' : 'Every live deployment in scope already has a scan. Nothing to backfill.'}\n${missingText}`
        : `Scan ${count} live ${count === 1 ? 'deployment' : 'deployments'} that were never scanned?${cost}${remaining > 0 ? ` ${remaining} more wait for the next backfill.` : ''}\n${missingText}${dim('Monthly caps apply when each scan starts.')}\n`,
    );
  }
  if (count === 0 && !args.plan) {
    io.output(preview, args.json);
    return;
  }
  if (!(await io.confirm(origin, preview, args))) {
    return;
  }
  const result = await client.request(args.path, {
    method: 'POST',
    body: args.body,
    timeoutMs: args.timeoutMs,
  });
  io.outputMutation(result, args);
}

async function runWebhook(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
): Promise<void> {
  const preview = await previewOf(client, args, args.path, args.body);
  if (!(await io.confirm(origin, preview, args))) {
    return;
  }
  const result = await client.request(args.path, {
    method: 'POST',
    body: args.body,
    timeoutMs: args.timeoutMs,
  });
  io.outputMutation(result, args);
  if (!args.json && typeof result.secret === 'string') {
    process.stderr.write(
      `${dim('Save the signing secret above now; it is not shown again. Check each request: X-Void-Signature is t=<seconds>,v1=<HMAC-SHA256 hex of "<t>.<body>">.')}\n`,
    );
  }
}

/** Longest provider key read from stdin; the server takes at most 1,024 characters. */
const MAX_PROVIDER_KEY_INPUT = 8192;

/** Reads one provider API key piped on stdin. The key is never printed. */
export async function readProviderKeyStdin(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (stdin.isTTY) {
    throw new OperatorClientError(
      '--key-stdin needs the key piped on standard input, for example from your password manager.',
      'invalid_key_input',
    );
  }
  let input = '';
  for await (const chunk of stdin) {
    input += String(chunk);
    if (input.length > MAX_PROVIDER_KEY_INPUT) {
      throw new OperatorClientError('The key on standard input is too long.', 'invalid_key_input');
    }
  }
  const key = input.trim();
  if (!key || Array.from(key).some((char) => char <= ' ')) {
    throw new OperatorClientError(
      'Standard input must hold one API key on one line.',
      'invalid_key_input',
    );
  }
  return key;
}

/** `models --provider <host> --key-stdin | --remove-key`: preview, confirm, apply. */
async function runProviderKey(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
): Promise<void> {
  const { keyStdin, ...fields } = args.body;
  // Read before any request, once for the preview and the change.
  const body: Result =
    keyStdin === true ? { ...fields, key: await readProviderKeyStdin() } : fields;
  const preview = await previewOf(client, args, args.path, body);
  if (!(await io.confirm(origin, preview, args))) {
    return;
  }
  const result = await client.request(args.path, {
    method: 'POST',
    body,
    timeoutMs: args.timeoutMs,
  });
  io.outputMutation(result, args);
  if (!args.json && typeof result.message === 'string') {
    process.stderr.write(`${dim(result.message)}\n`);
  }
}

async function runModel(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
): Promise<void> {
  const { acceptProviderNotice, ...fields } = args.body;
  const body: Result = { ...fields };
  if (acceptProviderNotice === true) {
    body.acceptProviderNoticeVersion = await currentNoticeVersion(client);
  }
  const preview = await previewOf(client, args, args.path, body);
  if (!(await io.confirm(origin, preview, args))) {
    return;
  }
  const result = await client.request(args.path, {
    method: 'POST',
    body,
    timeoutMs: args.timeoutMs,
  });
  io.outputMutation(result, args);
}

async function runMutation(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
): Promise<void> {
  switch (args.action) {
    case 'probe': {
      // A check, not a change: it records the result and has no preview.
      io.output(
        await client.request(args.path, { method: 'POST', body: {}, timeoutMs: args.timeoutMs }),
        args.json,
      );
      return;
    }
    case 'policy':
    case 'limits':
    case 'public-gate':
    case 'sweeps':
    case 'fallback':
    case 'digest':
      return changeWithRevision(client, origin, args, io, { ...args.body });
    case 'webhook':
      return runWebhook(client, origin, args, io);
    case 'provider-key':
      return runProviderKey(client, origin, args, io);
    case 'models': {
      const { acceptProviderNotice, ...fields } = args.body;
      const body: Result = { ...fields };
      if (acceptProviderNotice === true) {
        body.acceptProviderNoticeVersion = await currentNoticeVersion(client);
      }
      return changeWithRevision(client, origin, args, io, body);
    }
    case 'budget-set':
      return runBudget(client, origin, args, io);
    case 'resolve':
    case 'reopen':
    case 'comment':
      return runFindings(client, origin, args, io);
    case 'model':
      return runModel(client, origin, args, io);
    case 'rescan':
      return runRescan(client, origin, args, io);
    case 'backfill':
      return runBackfill(client, origin, args, io);
    default: {
      // cancel, bypass: a preview, then the same body.
      const preview = await previewOf(client, args, args.path, args.body);
      if (!(await io.confirm(origin, preview, args))) {
        return;
      }
      const result = await client.request(args.path, {
        method: 'POST',
        body: args.body,
        timeoutMs: args.timeoutMs,
      });
      io.outputMutation(result, args);
    }
  }
}

export async function runSecurityOperatorCommand(
  client: OperatorClient,
  origin: string,
  args: OperatorArgs,
  io: SecurityIo,
): Promise<void> {
  await guarded(() =>
    args.method === 'POST' ? runMutation(client, origin, args, io) : runRead(client, args, io),
  );
}
