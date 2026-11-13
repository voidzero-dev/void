import { readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import {
  AI_LOGGING_MODES,
  parsePlanAiLoggingInput,
  type AiLoggingMode,
} from '@void/platform/ai-logging';
import {
  PLAN_EDITABLE_LIMIT_KEYS,
  PLAN_LIMITS,
  parsePlanLimitsPatch,
  parsePlanName,
  parseBuildInstanceType,
  parsePlatformPlanId,
  type PlatformPlanCatalog,
  type PlatformPlanDefinition,
} from '@void/platform/plans';
import {
  type CANCEL_SYMBOL,
  confirm,
  isCancel,
  select,
  text,
} from '@voidzero-dev/vite-plus-prompts';
import { utcTime } from './operator-ai-logging.ts';
import { readOperatorToken, resolveOperatorOrigin } from './operator-auth.ts';
import { OperatorClient, OperatorClientError } from './operator-client.ts';
import { printSuccess } from './output.ts';
import type { PlatformPlansArgs } from './platform-plans-args.ts';

type PlanAiLoggingModes = Readonly<Record<string, string>>;

type AiLoggingListing = {
  modes: PlanAiLoggingModes;
  publish: { complete: boolean; error?: string } | null;
  remaining: number;
};

type Listing = {
  catalog: PlatformPlanCatalog;
  accounts: Array<{ planId: string; count: number }>;
  /** Plan AI logging defaults. Platforms before plan defaults do not send it. */
  aiLogging?: AiLoggingListing;
};

const aiLoggingLabels: Record<AiLoggingMode, string> = {
  inherit: 'inherit (AI Gateway setting)',
  off: 'off',
  metadata: 'metadata (no prompts or responses)',
  full: 'full (prompts and responses)',
};

function planAiLogging(modes: PlanAiLoggingModes | undefined, planId: string): string {
  const mode = modes && Object.hasOwn(modes, planId) ? modes[planId] : undefined;
  return typeof mode === 'string' ? stripVTControlCharacters(mode) : 'inherit';
}

function aiLoggingPending(listing: Listing): boolean {
  return Boolean(listing.aiLogging?.publish && !listing.aiLogging.publish.complete);
}

/** Refuses plan AI logging on a platform whose API would refuse or drop it. */
function assertPlanAiLoggingSupported(listing: Listing, body: Record<string, unknown>): void {
  if (body.aiLogging !== undefined && !listing.aiLogging) {
    throw new Error(
      'platform: This platform does not support plan AI logging defaults. Upgrade the platform first with `void platform upgrade`.',
    );
  }
}

const limitLabels: Record<(typeof PLAN_EDITABLE_LIMIT_KEYS)[number], string> = {
  requestsPerMonth: 'Requests per billing month',
  cpuMsPerRequest: 'Default CPU per request (ms)',
  maxCpuMsPerRequest: 'Maximum app CPU per request (ms)',
  subRequestsPerInvocation: 'Subrequests per invocation',
  deploysPerDay: 'Deployments per day',
  aiNeuronsPerMonth: 'AI neurons per billing month',
  retainedDeployments: 'Retained Worker deployments',
  sandboxRuntimeSecondsPerMonth: 'Sandbox runtime per billing month (seconds)',
  sandboxMaxConcurrentInstances: 'Concurrent Sandbox instances',
  concurrentBuilds: 'Concurrent builds',
  buildTimeoutMinutes: 'Build timeout (minutes)',
};

function limitValue(value: number, key?: (typeof PLAN_EDITABLE_LIMIT_KEYS)[number]): string {
  if (value === 0 && key === 'buildTimeoutMinutes') {
    return 'platform maximum (60 minutes)';
  }
  return value === 0 ? 'unlimited' : value.toLocaleString('en-US');
}

function shortSlugsLabel(allowed: boolean): string {
  return allowed ? 'allowed' : 'not allowed';
}

function writePlanDiff(
  from: PlatformPlanDefinition,
  to: PlatformPlanDefinition,
  write: (line: string) => void,
  aiLogging?: Readonly<{ from: string; to: string }>,
): void {
  if (aiLogging && aiLogging.from !== aiLogging.to) {
    write(`AI Gateway logging: ${aiLogging.from} → ${aiLogging.to}`);
  }
  if (from.buildInstanceType !== to.buildInstanceType) {
    write(`Build size: ${from.buildInstanceType} → ${to.buildInstanceType}`);
  }
  if (from.allowShortSlugs !== to.allowShortSlugs) {
    write(
      `Short project slugs: ${shortSlugsLabel(from.allowShortSlugs)} → ${shortSlugsLabel(to.allowShortSlugs)}`,
    );
  }
  for (const key of PLAN_EDITABLE_LIMIT_KEYS) {
    if (from.limits[key] !== to.limits[key]) {
      write(
        `${limitLabels[key]}: ${limitValue(from.limits[key], key)} → ${limitValue(to.limits[key], key)}`,
      );
    }
  }
}

function showListing(listing: Listing, json: boolean): void {
  if (json) {
    print(listing);
    return;
  }
  console.log(`Default for new accounts: ${listing.catalog.defaultPlanId}`);
  for (const plan of listing.catalog.plans) {
    const count = listing.accounts.find((entry) => entry.planId === plan.id)?.count ?? 0;
    console.log(`${label(plan)} — ${count} accounts`);
  }
  if (listing.catalog.reconciliation && !listing.catalog.reconciliation.complete) {
    console.log('Account updates are pending. Run void platform config plans sync --yes.');
  }
  if (aiLoggingPending(listing)) {
    console.log(
      `AI logging publish is pending for ${listing.aiLogging!.remaining} projects. Run void platform config plans sync --yes.`,
    );
  }
}

function showPreview(
  preview: Record<string, unknown>,
  before: PlatformPlanCatalog,
  beforeAiLogging: PlanAiLoggingModes | undefined,
  write = console.error,
): void {
  const after = preview.catalog as PlatformPlanCatalog;
  const change = preview.aiLogging as
    | { modes?: PlanAiLoggingModes; modesBefore?: PlanAiLoggingModes }
    | undefined;
  const afterAiLogging = change?.modes;
  // The preview reads the saved defaults under the catalog lock; the listing may be cached.
  const savedAiLogging = change?.modesBefore ?? beforeAiLogging;
  const aiLogging = (from: string, to: string) =>
    afterAiLogging
      ? { from: planAiLogging(savedAiLogging, from), to: planAiLogging(afterAiLogging, to) }
      : undefined;
  write(`Change: ${preview.action} ${preview.target}`);
  write(`Accounts affected: ${preview.affectedAccounts}`);
  const publish = preview.aiLoggingPublish as { remaining?: unknown } | undefined;
  if (typeof publish?.remaining === 'number' && publish.remaining > 0) {
    write(`AI logging settings to publish: ${publish.remaining} projects`);
  }
  for (const warning of (preview.warnings ?? []) as Array<string>) {
    write(stripVTControlCharacters(warning));
  }
  if (typeof preview.usageSampleSize === 'number' && preview.usageSampleSize > 0) {
    write(`Usage preview samples ${preview.usageSampleSize} accounts.`);
  }
  if (before.defaultPlanId !== after.defaultPlanId) {
    write(`Default for new accounts: ${before.defaultPlanId} → ${after.defaultPlanId}`);
  }
  for (const plan of after.plans) {
    const previous = before.plans.find((entry) => entry.id === plan.id);
    if (!previous) {
      write(`Add ${label(plan)}; build size ${plan.buildInstanceType}`);
      for (const key of PLAN_EDITABLE_LIMIT_KEYS) {
        write(`  ${limitLabels[key]}: ${limitValue(plan.limits[key], key)}`);
      }
      write(`  Short project slugs: ${shortSlugsLabel(plan.allowShortSlugs)}`);
      if (afterAiLogging) {
        write(`  AI Gateway logging: ${planAiLogging(afterAiLogging, plan.id)}`);
      }
      continue;
    }
    if (previous.name !== plan.name) {
      write(`Name: ${previous.name} → ${plan.name}`);
    }
    if (previous.archived !== plan.archived) {
      write(`${plan.id}: ${plan.archived ? 'archive for new assignments' : 'restore assignments'}`);
    }
    writePlanDiff(previous, plan, write, aiLogging(plan.id, plan.id));
  }
  for (const plan of before.plans) {
    if (!after.plans.some((entry) => entry.id === plan.id)) {
      write(`Remove ${label(plan)}`);
      const replacement = after.plans.find((entry) => entry.id === preview.replacementPlanId);
      if (replacement) {
        write(`Move accounts to ${label(replacement)}`);
        writePlanDiff(plan, replacement, write, aiLogging(plan.id, replacement.id));
      }
    }
  }
  for (const account of (preview.overLimitAccounts ?? []) as Array<{
    id: string;
    login: string;
    reasons: Array<string>;
  }>) {
    write(
      `Already above proposed limits: ${stripVTControlCharacters(account.login)} (${account.id}): ${account.reasons.join(', ')}`,
    );
  }
}

function value<T>(input: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(input) || typeof input === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return input;
}

function print(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

function label(plan: PlatformPlanDefinition): string {
  return `${stripVTControlCharacters(plan.name)} (${plan.id}${plan.archived ? ', archived' : ''})`;
}

async function choosePlan(
  catalog: PlatformPlanCatalog,
  message: string,
  options: { activeOnly?: boolean; exclude?: string } = {},
): Promise<string> {
  const plans = catalog.plans.filter(
    (plan) => plan.id !== options.exclude && (!options.activeOnly || !plan.archived),
  );
  if (!plans.length) {
    throw new Error('platform: No eligible plans are available.');
  }
  return value(
    await select({
      message,
      options: plans.map((plan) => ({ value: plan.id, label: label(plan) })),
    }),
  );
}

async function changesInput(
  args: PlatformPlansArgs,
  plan?: PlatformPlanDefinition,
  listing?: Listing,
): Promise<Record<string, unknown>> {
  if (args.file) {
    const input: unknown = JSON.parse(await readFile(args.file, 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('platform: A plan file must contain a JSON object.');
    }
    const object = input as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      if (!['name', 'limits', 'buildInstanceType', 'allowShortSlugs', 'aiLogging'].includes(key)) {
        throw new Error(
          `platform: Unknown plan field ${key}. Use name, limits, buildInstanceType, allowShortSlugs, or aiLogging.`,
        );
      }
    }
    try {
      parsePlanAiLoggingInput(object.aiLogging);
    } catch (error) {
      throw new Error(`platform: ${(error as Error).message}`);
    }
    if (object.allowShortSlugs !== undefined && typeof object.allowShortSlugs !== 'boolean') {
      throw new Error('platform: allowShortSlugs must be a boolean.');
    }
    return {
      ...object,
      ...(object.name !== undefined ? { name: parsePlanName(object.name) } : {}),
      ...(object.buildInstanceType !== undefined
        ? { buildInstanceType: parseBuildInstanceType(object.buildInstanceType) }
        : {}),
      ...(object.limits !== undefined ? { limits: parsePlanLimitsPatch(object.limits) } : {}),
      ...(args.name ? { name: parsePlanName(args.name) } : {}),
    };
  }
  if (args.name) {
    return { name: parsePlanName(args.name) };
  }
  if (!process.stdin.isTTY || args.json) {
    if (args.action === 'add') {
      throw new Error(
        'platform: Supply --name or --file when adding a plan in non-interactive mode.',
      );
    }
    throw new Error('platform: Supply --name or --file with the changes in non-interactive mode.');
  }
  if (args.action === 'add') {
    return {
      name: parsePlanName(value(await text({ message: 'Plan name:', initialValue: args.target }))),
    };
  }
  const field = value(
    await select({
      message: 'What would you like to change?',
      options: [
        { value: 'name', label: 'Plan name' },
        ...PLAN_EDITABLE_LIMIT_KEYS.map((key) => ({
          value: key,
          label: `${limitLabels[key]}: ${limitValue(plan!.limits[key], key)}`,
        })),
        { value: 'buildInstanceType', label: 'Build instance size' },
        ...(listing?.aiLogging
          ? [
              {
                value: 'aiLogging',
                label: `AI Gateway logging: ${planAiLogging(listing.aiLogging.modes, plan!.id)}`,
              },
            ]
          : []),
      ],
    }),
  );
  if (field === 'aiLogging') {
    return {
      aiLogging: value(
        await select({
          message: 'AI Gateway logging for projects on this plan without a project setting:',
          initialValue: planAiLogging(listing!.aiLogging!.modes, plan!.id),
          options: AI_LOGGING_MODES.map((mode) => ({ value: mode, label: aiLoggingLabels[mode] })),
        }),
      ),
    };
  }
  if (field === 'name') {
    return {
      name: parsePlanName(value(await text({ message: 'Plan name:', initialValue: plan!.name }))),
    };
  }
  if (field === 'buildInstanceType') {
    return {
      buildInstanceType: value(
        await select({
          message: 'Build instance size:',
          initialValue: plan!.buildInstanceType,
          options: [
            { value: 'standard-3', label: 'Standard: 2 vCPU, 8 GiB' },
            { value: 'standard-4', label: 'Large: 4 vCPU, 12 GiB' },
          ],
        }),
      ),
    };
  }
  const current = plan!.limits[field as (typeof PLAN_EDITABLE_LIMIT_KEYS)[number]];
  const input = value(
    await text({
      message: `${limitLabels[field as (typeof PLAN_EDITABLE_LIMIT_KEYS)[number]]} (${field === 'buildTimeoutMinutes' ? '0 uses the platform maximum of 60 minutes' : '0 means unlimited'}):`,
      initialValue: String(current),
      validate: (value) =>
        /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value))
          ? undefined
          : 'Enter a nonnegative whole number.',
    }),
  );
  return { limits: parsePlanLimitsPatch({ [field]: Number(input) }) };
}

async function apply(
  client: OperatorClient,
  path: string,
  body: Record<string, unknown>,
  args: PlatformPlansArgs,
  listing: Listing,
): Promise<void> {
  const { catalog } = listing;
  assertPlanAiLoggingSupported(listing, body);
  if (!args.plan && !args.yes && (!process.stdin.isTTY || args.json)) {
    throw new Error(
      'platform: Configuration changes require --yes or --plan in non-interactive mode.',
    );
  }
  const preview = await client.request(path, { method: 'POST', body: { ...body, dryRun: true } });
  if (args.plan) {
    if (args.json) {
      print(preview);
    } else {
      showPreview(preview, catalog, listing.aiLogging?.modes, console.log);
    }
    return;
  }
  if (!Number.isSafeInteger(preview.expectedRevision)) {
    throw new Error('platform: The platform returned an invalid plan revision.');
  }
  if (!args.yes) {
    showPreview(preview, catalog, listing.aiLogging?.modes);
    if (
      !value(
        await confirm({ message: `Apply this change to ${client.origin}?`, initialValue: false }),
      )
    ) {
      throw new Error('platform: Cancelled.');
    }
  }
  let result = await save(client, path, { ...body, expectedRevision: preview.expectedRevision });
  const committedCatalog = result.catalog as PlatformPlanCatalog;
  if (!Number.isSafeInteger(committedCatalog?.revision)) {
    throw new Error(
      'platform: The platform returned an invalid saved plan revision. Inspect the catalog before retrying.',
    );
  }
  const committedRevision = committedCatalog.revision;
  const applied = result;
  let previousCursor = catalog.reconciliation?.cursor ?? null;
  let published = 0;
  let expectedBy: string | null = null;
  while (true) {
    const reconciliation = result.reconciliation as Progress | undefined;
    const aiLogging = result.aiLoggingPublish as Progress | undefined;
    if (aiLogging && Number.isSafeInteger(aiLogging.processed)) {
      published += aiLogging.processed!;
    }
    if (typeof aiLogging?.expectedBy === 'string') {
      expectedBy = aiLogging.expectedBy;
    }
    const accountsPending = reconciliation?.complete === false;
    if (!accountsPending && aiLogging?.complete !== false && !aiLogging?.error) {
      break;
    }
    const currentCatalog = result.catalog as PlatformPlanCatalog;
    const cursor = currentCatalog.reconciliation?.cursor ?? null;
    const accountsStuck =
      accountsPending && (!progressed(reconciliation) || cursor === previousCursor);
    const aiLoggingStuck =
      aiLogging?.complete === false ? !progressed(aiLogging) : !!aiLogging?.error;
    if (accountsStuck || aiLoggingStuck || currentCatalog.revision !== committedRevision) {
      const pending = { ...applied, ...result };
      print(pending);
      throw new OperatorClientError(
        accountsStuck || !aiLoggingStuck
          ? 'Plan configuration was saved, but account updates are pending. Run void platform config plans sync --yes.'
          : 'Plan configuration was saved, but the AI logging setting is not published to every project yet. Run void platform config plans sync --yes.',
        'plan_sync_pending',
        undefined,
        pending,
      );
    }
    if (accountsPending) {
      previousCursor = cursor;
    }
    result = await save(client, '/config/plans/sync', { expectedRevision: committedRevision });
  }
  const completed = { ...applied, ...result };
  if (args.json) {
    print(completed);
  } else {
    printSuccess(
      `Saved ${applied.action ?? 'plans.sync'} ${applied.target ?? ''}. Account updates complete.`,
    );
    const change = preview.aiLogging as
      | { planIds?: Array<unknown>; includeUnknown?: boolean }
      | undefined;
    if (published > 0 || change?.planIds?.length || change?.includeUnknown) {
      const by = utcTime(expectedBy);
      console.log(
        `AI logging published to ${published} projects${by ? `; expected by ${by} (normally within 2 minutes)` : ''}.`,
      );
    }
  }
}

/**
 * Send a plan change or sync page. The API answers `ok: false` when the catalog saved but an
 * account or AI logging page failed; that body still carries the saved catalog, so return it and
 * let the caller name the resumption command instead of a generic partial failure.
 */
async function save(
  client: OperatorClient,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await client.request(path, { method: 'POST', body });
  } catch (error) {
    const details = error instanceof OperatorClientError ? error.details : undefined;
    if (
      error instanceof OperatorClientError &&
      error.code === 'partial_failure' &&
      details &&
      typeof details === 'object' &&
      'catalog' in details
    ) {
      return details as Record<string, unknown>;
    }
    throw error;
  }
}

type Progress = {
  complete?: boolean;
  processed?: number;
  remaining?: number;
  expectedBy?: string | null;
  error?: unknown;
};

/** A sync step that wrote something and reported no error. */
function progressed(progress: Progress): boolean {
  return !progress.error && Number.isSafeInteger(progress.processed) && progress.processed! > 0;
}

export async function runPlatformPlansConfig(args: PlatformPlansArgs): Promise<void> {
  const origin = resolveOperatorOrigin(args.connection);
  const client = new OperatorClient(origin, readOperatorToken(origin));
  const listing = (await client.request('/config/plans')) as unknown as Listing;
  const { catalog } = listing;
  if (!args.action) {
    if (!process.stdin.isTTY || args.json) {
      showListing(listing, args.json);
      return;
    }
    const selected = value(
      await select({
        message: 'Platform plans:',
        options: [
          ...catalog.plans.map((plan) => ({
            value: plan.id,
            label: `${label(plan)}${plan.id === catalog.defaultPlanId ? ' — default' : ''}`,
            hint: `${listing.accounts.find((entry) => entry.planId === plan.id)?.count ?? 0} accounts`,
          })),
          { value: ':add', label: 'Add a plan by copying an existing plan' },
          { value: ':default', label: 'Choose the default for new accounts' },
          ...((catalog.reconciliation && !catalog.reconciliation.complete) ||
          aiLoggingPending(listing)
            ? [{ value: ':sync', label: 'Continue pending account and AI logging updates' }]
            : []),
        ],
      }),
    );
    if (selected === ':sync') {
      return runPlatformPlansConfig({ ...args, action: 'sync' });
    }
    if (selected === ':default') {
      const target = await choosePlan(catalog, 'Default plan for new accounts:', {
        activeOnly: true,
      });
      return runPlatformPlansConfig({ ...args, action: 'default', target });
    }
    if (selected === ':add') {
      const target = parsePlatformPlanId(
        value(
          await text({ message: 'New plan ID (stable; lowercase letters, digits, and hyphens):' }),
        ),
      );
      const copy = await choosePlan(catalog, 'Copy limits and build size from:');
      return runPlatformPlansConfig({ ...args, action: 'add', target, copy });
    }
    const plan = catalog.plans.find((entry) => entry.id === selected)!;
    const action = value(
      await select({
        message: label(plan),
        options: [
          { value: 'show' as const, label: 'Show limits and account count' },
          { value: 'set' as const, label: 'Edit name or limits' },
          {
            value: plan.archived ? ('restore' as const) : ('archive' as const),
            label: plan.archived
              ? 'Restore assignments to this plan'
              : 'Archive for new assignments',
          },
          ...(Object.hasOwn(PLAN_LIMITS, plan.id)
            ? [{ value: 'reset' as const, label: 'Reset to original limits and build size' }]
            : []),
          { value: 'remove' as const, label: 'Remove this plan' },
        ],
      }),
    );
    return runPlatformPlansConfig({ ...args, action, target: selected });
  }
  if (args.action === 'show') {
    if (!args.target) {
      showListing(listing, args.json);
    } else {
      const result = await client.request(`/config/plans/${encodeURIComponent(args.target)}`);
      if (args.json) {
        print(result);
      } else {
        const plan = result.plan as PlatformPlanDefinition;
        console.log(`${label(plan)}${result.default ? ' — default for new accounts' : ''}`);
        console.log(`Accounts: ${result.accounts}; build size: ${plan.buildInstanceType}`);
        console.log(`Short project slugs: ${shortSlugsLabel(plan.allowShortSlugs)}`);
        for (const key of PLAN_EDITABLE_LIMIT_KEYS) {
          console.log(`${limitLabels[key]}: ${limitValue(plan.limits[key], key)}`);
        }
        if (typeof result.aiLogging === 'string') {
          console.log(`AI Gateway logging: ${stripVTControlCharacters(result.aiLogging)}`);
        }
        const publish = result.aiLoggingPublish as
          | { complete?: boolean; remaining?: number; error?: string }
          | null
          | undefined;
        if (publish && publish.complete === false) {
          console.log(
            `AI logging publish pending: ${publish.remaining ?? 0} projects remaining${publish.error ? ` (${stripVTControlCharacters(publish.error)})` : ''}. Run void platform config plans sync --yes.`,
          );
        }
      }
    }
    return;
  }
  let body: Record<string, unknown> = {};
  let path = `/config/plans/${encodeURIComponent(args.target)}/${args.action}`;
  const plan = catalog.plans.find((entry) => entry.id === args.target);
  if (args.action === 'add') {
    let copy = args.copy;
    if (!copy) {
      if (!process.stdin.isTTY || args.json) {
        throw new Error(
          'platform: Adding a plan requires --copy <plan-id> in non-interactive mode.',
        );
      }
      copy = await choosePlan(catalog, 'Copy limits and build size from:');
    }
    body = { id: args.target, copyFrom: copy, ...(await changesInput(args)) };
    path = '/config/plans/add';
  } else if (args.action === 'default') {
    body = { planId: args.target };
    path = '/config/plans/default';
  } else if (args.action === 'sync') {
    path = '/config/plans/sync';
  } else {
    if (!plan) {
      throw new Error('platform: Plan not found. Run void platform config plans show.');
    }
    if (args.action === 'set') {
      body = await changesInput(args, plan, listing);
    } else if (args.action === 'archive' || args.action === 'restore') {
      path = `/config/plans/${encodeURIComponent(args.target)}/archive`;
      body = { archived: args.action === 'archive' };
    } else if (args.action === 'remove') {
      let replacement = args.replacement;
      const needsReplacement =
        args.target === catalog.defaultPlanId ||
        (listing.accounts.find((entry) => entry.planId === args.target)?.count ?? 0) > 0;
      if (!replacement && needsReplacement && process.stdin.isTTY && !args.json) {
        replacement = await choosePlan(catalog, 'Move accounts and any default to:', {
          activeOnly: true,
          exclude: args.target,
        });
      }
      body = replacement ? { replacementPlanId: replacement } : {};
    }
  }
  await apply(client, path, body, args, listing);
}
