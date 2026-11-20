import type { OperatorCommand } from './operator-args.ts';

/**
 * `void platform security …` (spec §13.4). The table feeds the generic operator parser
 * and the nested help. `applySecurityArgs` turns the raw flags into request bodies.
 * Projects are addressed by id, like every other operator command; the lists also take
 * a slug in `--project`.
 */
export const securityOperatorCommands: Array<OperatorCommand> = [
  {
    group: 'security',
    action: 'status',
    description:
      'Inspect capability, last probe, policy, queue depth, running scans and month totals',
    path: '/security/status',
  },
  {
    group: 'security',
    action: 'probe',
    description: 'Run the entitlement probe (checks Containers, Workers AI and model hosts)',
    path: '/security/probe',
    method: 'POST',
    noConfirm: true,
  },
  {
    group: 'security',
    action: 'policy',
    description: 'Set the scan mode (disabled, public or all), or one project’s own scan rule',
    path: '/security/policy',
    positional: ['mode'],
    usage: [
      'void platform security policy <disabled|public|all> [options]',
      'void platform security policy --project <project-id> <inherit|always|never> [options]',
    ],
    values: {
      project:
        'Project id whose own rule to set: inherit follows the mode, always scans it, never skips it',
    },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'models',
    description:
      'Set the default model, block or unblock models, or save your own OpenAI or Anthropic key',
    path: '/security/policy',
    usage: [
      'void platform security models [--default <id>] [--block <id,…>] [--unblock <id,…>] [--accept-provider-notice] [options]',
      'void platform security models --provider <openai|anthropic> (--key-stdin | --remove-key) [options]',
    ],
    values: {
      default: 'Default model id',
      block: 'Comma-separated model ids to block',
      unblock: 'Comma-separated model ids to unblock',
      provider: 'openai or anthropic: the provider whose key --key-stdin or --remove-key changes',
    },
    booleans: {
      'accept-provider-notice':
        'Accept the current provider notice (needed for a third-party model)',
      'key-stdin': 'Read your own provider API key from stdin; scans with that provider bill to it',
      'remove-key': 'Remove your saved provider key; scans go back to Unified Billing credits',
    },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'limits',
    description: 'Set scan limits: concurrent scans and the time one scan may run',
    path: '/security/policy',
    values: {
      concurrency: 'Scans that run at once (1 to 10)',
      'scan-timeout': 'Minutes one scan may run (5 to 60)',
    },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'budget',
    description:
      'Show the monthly caps and this month’s spend, or set the platform cap, the default project cap or one project’s limit',
    path: '/security/budget',
    usage: [
      'void platform security budget [--platform-usd <n> | --platform-off] [--project-default-usd <n>] [--project-caps <on|off>] [--project <project-id> (--usd <n> | --clear)] [options]',
    ],
    values: {
      'platform-usd': 'Platform cap in USD per month (turns the cap on)',
      'project-default-usd': 'Default project cap in USD per month (turns project caps on)',
      'project-caps': 'on applies the saved default to every project; off removes it',
      project: 'Project id whose limit to change (use with --usd or --clear)',
      usd: 'That project’s limit in USD per month, any amount',
    },
    booleans: {
      'platform-off': 'Turn the platform cap off',
      clear: 'Remove the project’s limit (the default applies again)',
    },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'findings',
    description: 'List findings across projects, oldest first',
    path: '/security/findings',
    values: {
      project: 'Project id or slug',
      state: 'open, resolved or all',
      severity: 'critical, high, medium, low or informational',
      format: 'sarif prints every matching finding as a SARIF 2.1.0 log',
    },
    booleans: { urgent: 'Only open critical or high findings that are confirmed' },
    paged: true,
  },
  {
    group: 'security',
    action: 'show',
    description: 'Show findings of a project, by comma-separated finding ids',
    path: '/projects/:id/security/findings/:fid',
    positional: ['id', 'fid'],
    usage: ['void platform security show <project-id> <finding-id,…> [options]'],
  },
  {
    group: 'security',
    action: 'resolve',
    description: 'Resolve findings as an installation admin',
    path: '/projects/:id/security/findings/:fid/resolve',
    positional: ['id', 'fid'],
    usage: [
      'void platform security resolve <project-id> <finding-id,…> --reason <fixed|false-positive|accepted-risk> --comment <text> [options]',
    ],
    values: {
      reason: 'fixed, false-positive or accepted-risk',
      comment: 'Why (required)',
    },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'reopen',
    description: 'Reopen resolved findings as an installation admin',
    path: '/projects/:id/security/findings/:fid/reopen',
    positional: ['id', 'fid'],
    usage: ['void platform security reopen <project-id> <finding-id,…> --comment <text> [options]'],
    values: { comment: 'Why (required)' },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'comment',
    description: 'Add a comment to findings as an installation admin',
    path: '/projects/:id/security/findings/:fid/comments',
    positional: ['id', 'fid', 'text'],
    usage: ['void platform security comment <project-id> <finding-id,…> <text> [options]'],
    method: 'POST',
  },
  {
    group: 'security',
    action: 'model',
    description: 'Set one project’s scan model, or go back to the platform default',
    path: '/projects/:id/security/model',
    positional: ['id', 'model'],
    optionalPositional: true,
    usage: ['void platform security model <project-id> <model-id|--default> [options]'],
    booleans: {
      default: 'Use the platform default model',
      'accept-provider-notice':
        'Accept the current provider notice (needed for a third-party model)',
    },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'scans',
    description: 'List scans across projects, newest first, with month totals',
    path: '/security/scans',
    values: {
      project: 'Project id or slug',
      status: 'Scan status, such as failed, refused or running',
      trigger: 'gate for public-request scans',
    },
    paged: true,
  },
  {
    group: 'security',
    action: 'rescan',
    description: 'Run a full scan of the live deployment (asks first; it can cost real money)',
    path: '/projects/:id/security/scans',
    positional: ['id'],
    booleans: {
      'client-assets': 'Also read the sources of the client bundles from their source maps',
    },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'backfill',
    description:
      'Scan every live deployment that was never scanned (asks first; it can cost real money)',
    path: '/security/backfill',
    method: 'POST',
  },
  {
    group: 'security',
    action: 'sweeps',
    description: 'Turn scheduled full sweeps of every live app on or off',
    path: '/security/policy',
    positional: ['state'],
    usage: ['void platform security sweeps <on|off> [--every-days <n>] [options]'],
    values: { 'every-days': 'Days between two sweeps of one project (7 to 90, default 30)' },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'fallback',
    description:
      'Re-scan once on the @cf default after a third-party scan is refused, fails or times out',
    path: '/security/policy',
    positional: ['state'],
    usage: ['void platform security fallback <on|off> [options]'],
    method: 'POST',
  },
  {
    group: 'security',
    action: 'digest',
    description: 'Turn the weekly security summary email to installation admins on or off',
    path: '/security/policy',
    positional: ['state'],
    usage: ['void platform security digest <on|off> [options]'],
    method: 'POST',
  },
  {
    group: 'security',
    action: 'webhook',
    description:
      'Send signed security events (ids and counts only) to an https URL, or turn it off',
    path: '/security/webhook',
    positional: ['url'],
    usage: ['void platform security webhook <https-url|off> [options]'],
    method: 'POST',
  },
  {
    group: 'security',
    action: 'cancel',
    description: 'Cancel a waiting or running scan',
    path: '/security/scans/:sid/cancel',
    positional: ['sid'],
    method: 'POST',
  },
  {
    group: 'security',
    action: 'public-gate',
    description: 'Turn “Scan before a project goes public” on or off',
    path: '/security/policy',
    positional: ['state'],
    usage: ['void platform security public-gate <on|off> [options]'],
    method: 'POST',
  },
  {
    group: 'security',
    action: 'public-requests',
    description: 'List public requests across projects, longest waiting first',
    path: '/security/public-requests',
    values: {
      project: 'Project id or slug',
      state: 'open, closed, all or one request state',
    },
    paged: true,
  },
  {
    group: 'security',
    action: 'bypass',
    description: 'Bypass the gate scan of a project’s public request',
    path: '/projects/:id/security/public-request/bypass',
    positional: ['id'],
    values: { reason: 'Why the scan is skipped (required, up to 4,000 characters)' },
    method: 'POST',
  },
  {
    group: 'security',
    action: 'bypasses',
    description: 'List bypass records, newest first',
    path: '/security/bypasses',
    values: { project: 'Project id or slug' },
    paged: true,
  },
];

const MODES = ['disabled', 'public', 'all'];
/** One project's own scan rule (M34). */
const OVERRIDES = ['inherit', 'always', 'never'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'];
const REASONS: Record<string, string> = {
  fixed: 'fixed',
  'false-positive': 'false_positive',
  false_positive: 'false_positive',
  'accepted-risk': 'accepted_risk',
  accepted_risk: 'accepted_risk',
};
const MAX_FINDING_IDS = 20;

function list(value: string, name: string): Array<string> {
  const items = [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (items.length === 0) {
    throw new Error(`platform: --${name} needs at least one id.`);
  }
  return items;
}

function wholeNumber(value: string, name: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`platform: --${name} must be a whole number.`);
  }
  return Number(value);
}

function dollars(value: string, name: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error(`platform: --${name} must be a dollar amount such as 50 or 12.50.`);
  }
  return Number(value);
}

export type SecurityParsed = {
  /** `budget` reads with no flags and writes with any cap flag, so the request is chosen here. */
  method?: 'GET' | 'POST';
  action?: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
};

/**
 * Fills the request for one security command. The path keeps `:fid` when the command
 * takes finding ids, and the ids ride the body as `findingIds` for the runner, which
 * sends one request per id. Internal body keys (`findingIds`, `acceptProviderNotice`,
 * `projectCapsOn`, `keyStdin`) never reach the server.
 */
export function applySecurityArgs(
  command: OperatorCommand,
  parameters: Array<string>,
  values: Record<string, string>,
  flags: Set<string>,
  parsed: SecurityParsed,
): void {
  const action = command.action;
  parsed.body = {};
  parsed.path = command.path;
  if (action === 'budget') {
    const writes =
      ['platform-usd', 'project-default-usd', 'project-caps', 'project', 'usd'].some(
        (name) => values[name] !== undefined,
      ) ||
      flags.has('platform-off') ||
      flags.has('clear');
    if (!writes) {
      parsed.method = 'GET';
      return;
    }
    parsed.method = 'POST';
    parsed.action = 'budget-set';
  }
  const projectId = parameters[0];
  if (projectId !== undefined) {
    if (projectId === '.' || projectId === '..') {
      throw new Error('platform: An object ID cannot be a dot path segment.');
    }
    if (command.path.includes(':id')) {
      parsed.path = parsed.path.replace(':id', encodeURIComponent(projectId));
    }
  }
  if (action === 'cancel') {
    parsed.path = parsed.path.replace(':sid', encodeURIComponent(parameters[0]!));
    return;
  }
  if (action === 'rescan' && flags.has('client-assets')) {
    parsed.body = { clientAssets: true };
    return;
  }
  if (action === 'findings') {
    if (flags.has('urgent')) {
      parsed.query.urgent = 'true';
    }
    if (values.format !== undefined) {
      if (values.format !== 'sarif') {
        throw new Error('platform: --format must be sarif.');
      }
      if (flags.has('json')) {
        throw new Error('platform: Use --format sarif or --json, not both.');
      }
      if (parsed.query.page !== undefined || parsed.query.limit !== undefined) {
        throw new Error(
          'platform: --format sarif exports every matching finding; drop --page and --limit.',
        );
      }
      // The export reads every page itself (`findings-sarif`); the server never sees it.
      delete parsed.query.format;
      parsed.action = 'findings-sarif';
    }
    if (values.state !== undefined && !['open', 'resolved', 'all'].includes(values.state)) {
      throw new Error('platform: --state must be open, resolved or all.');
    }
    if (values.severity !== undefined && !SEVERITIES.includes(values.severity)) {
      throw new Error(`platform: --severity must be one of: ${SEVERITIES.join(', ')}.`);
    }
    return;
  }
  if (action === 'scans' && values.trigger !== undefined && values.trigger !== 'gate') {
    throw new Error('platform: --trigger must be gate.');
  }
  if (action === 'show' || action === 'resolve' || action === 'reopen' || action === 'comment') {
    const ids = list(parameters[1]!, 'finding ids');
    if (ids.length > MAX_FINDING_IDS) {
      throw new Error(`platform: Name at most ${MAX_FINDING_IDS} findings at a time.`);
    }
    parsed.body.findingIds = ids;
    if (action === 'show') {
      return;
    }
  }
  switch (action) {
    case 'policy': {
      const mode = parameters[0]!;
      const project = values.project;
      if (project !== undefined) {
        if (!OVERRIDES.includes(mode)) {
          throw new Error(
            'platform: Usage: void platform security policy --project <project-id> <inherit|always|never>.',
          );
        }
        if (project === '.' || project === '..') {
          throw new Error('platform: An object ID cannot be a dot path segment.');
        }
        parsed.action = 'project-policy';
        parsed.path = `/projects/${encodeURIComponent(project)}/security/policy`;
        parsed.body = { override: mode };
        return;
      }
      if (OVERRIDES.includes(mode)) {
        throw new Error(
          `platform: ${mode} is a project rule; name the project: void platform security policy --project <project-id> ${mode}.`,
        );
      }
      if (!MODES.includes(mode)) {
        throw new Error('platform: Usage: void platform security policy <disabled|public|all>.');
      }
      parsed.body = { mode };
      return;
    }
    case 'sweeps': {
      const state = parameters[0]!;
      if (state !== 'on' && state !== 'off') {
        throw new Error(
          'platform: Usage: void platform security sweeps <on|off> [--every-days <n>].',
        );
      }
      parsed.body = {
        sweeps: {
          on: state === 'on',
          ...(values['every-days'] !== undefined
            ? { everyDays: wholeNumber(values['every-days'], 'every-days') }
            : {}),
        },
      };
      return;
    }
    case 'fallback':
    case 'digest': {
      const state = parameters[0]!;
      if (state !== 'on' && state !== 'off') {
        throw new Error(`platform: Usage: void platform security ${action} <on|off>.`);
      }
      parsed.body = { [action === 'fallback' ? 'fallbackToCf' : 'digest']: state === 'on' };
      return;
    }
    case 'webhook': {
      const url = parameters[0]!;
      if (url !== 'off' && !url.startsWith('https://')) {
        throw new Error('platform: Usage: void platform security webhook <https-url|off>.');
      }
      parsed.body = { url: url === 'off' ? null : url };
      return;
    }
    case 'public-gate': {
      const state = parameters[0]!;
      if (state !== 'on' && state !== 'off') {
        throw new Error('platform: Usage: void platform security public-gate <on|off>.');
      }
      parsed.body = { publicGate: state === 'on' };
      return;
    }
    case 'models': {
      const provider = values.provider;
      const keyStdin = flags.has('key-stdin');
      const removeKey = flags.has('remove-key');
      if (provider !== undefined || keyStdin || removeKey) {
        // A provider key has its own route and is changed apart from the policy.
        if (
          values.default ||
          values.block ||
          values.unblock ||
          flags.has('accept-provider-notice')
        ) {
          throw new Error(
            'platform: Change a provider key on its own; set models in a separate command.',
          );
        }
        if (provider !== 'openai' && provider !== 'anthropic') {
          throw new Error('platform: --provider must be openai or anthropic.');
        }
        if (keyStdin === removeKey) {
          throw new Error(
            'platform: Usage: void platform security models --provider <openai|anthropic> (--key-stdin | --remove-key).',
          );
        }
        parsed.action = 'provider-key';
        parsed.path = '/security/provider-keys';
        // `keyStdin` is internal: the runner reads the key and sends it as `key`.
        parsed.body = keyStdin ? { host: provider, keyStdin: true } : { host: provider, key: null };
        return;
      }
      if (!values.default && !values.block && !values.unblock) {
        throw new Error(
          'platform: Usage: void platform security models [--default <id>] [--block <id,…>] [--unblock <id,…>] [--accept-provider-notice], or --provider <openai|anthropic> (--key-stdin | --remove-key).',
        );
      }
      parsed.body = {
        ...(values.default ? { defaultModel: values.default } : {}),
        ...(values.block ? { block: list(values.block, 'block') } : {}),
        ...(values.unblock ? { unblock: list(values.unblock, 'unblock') } : {}),
        ...(flags.has('accept-provider-notice') ? { acceptProviderNotice: true } : {}),
      };
      return;
    }
    case 'limits': {
      const limits = {
        ...(values.concurrency
          ? { concurrency: wholeNumber(values.concurrency, 'concurrency') }
          : {}),
        ...(values['scan-timeout']
          ? { timeoutMinutes: wholeNumber(values['scan-timeout'], 'scan-timeout') }
          : {}),
      };
      if (Object.keys(limits).length === 0) {
        throw new Error(
          'platform: Usage: void platform security limits [--concurrency <n>] [--scan-timeout <minutes>].',
        );
      }
      parsed.body = { limits };
      return;
    }
    case 'budget': {
      const project = values.project;
      const platformFlags = ['platform-usd', 'project-default-usd', 'project-caps'].filter(
        (name) => values[name] !== undefined,
      );
      if (flags.has('platform-off')) {
        platformFlags.push('platform-off');
      }
      if (project !== undefined) {
        if (platformFlags.length > 0) {
          throw new Error(
            'platform: --project changes one project; do not combine it with platform cap flags.',
          );
        }
        if ((values.usd === undefined) === !flags.has('clear')) {
          throw new Error(
            'platform: Usage: void platform security budget --project <id> (--usd <amount> | --clear).',
          );
        }
        if (project === '.' || project === '..') {
          throw new Error('platform: An object ID cannot be a dot path segment.');
        }
        parsed.path = `/projects/${encodeURIComponent(project)}/security/budget`;
        parsed.body = { monthlyUsd: values.usd === undefined ? null : dollars(values.usd, 'usd') };
        return;
      }
      if (values.usd !== undefined || flags.has('clear')) {
        throw new Error('platform: --usd and --clear need --project <id>.');
      }
      if (values['platform-usd'] !== undefined && flags.has('platform-off')) {
        throw new Error('platform: Choose --platform-usd or --platform-off, not both.');
      }
      const caps = values['project-caps'];
      if (caps !== undefined && caps !== 'on' && caps !== 'off') {
        throw new Error('platform: --project-caps must be on or off.');
      }
      if (caps === 'off' && values['project-default-usd'] !== undefined) {
        throw new Error(
          'platform: --project-caps off cannot be combined with --project-default-usd.',
        );
      }
      const body: Record<string, unknown> = {};
      if (values['platform-usd'] !== undefined) {
        body.platformMonthlyUsd = dollars(values['platform-usd'], 'platform-usd');
      } else if (flags.has('platform-off')) {
        body.platformMonthlyUsd = null;
      }
      if (values['project-default-usd'] !== undefined) {
        body.projectDefaultMonthlyUsd = dollars(
          values['project-default-usd'],
          'project-default-usd',
        );
      } else if (caps === 'off') {
        body.projectDefaultMonthlyUsd = null;
      } else if (caps === 'on') {
        // The saved default amount; the runner reads it.
        body.projectCapsOn = true;
      }
      if (Object.keys(body).length === 0) {
        throw new Error(
          'platform: Usage: void platform security budget [--platform-usd <n> | --platform-off] [--project-default-usd <n> | --project-caps on|off] | --project <id> (--usd <n> | --clear).',
        );
      }
      parsed.body = body;
      return;
    }
    case 'resolve': {
      const reason = values.reason === undefined ? undefined : REASONS[values.reason];
      if (!reason) {
        throw new Error('platform: --reason is required: fixed, false-positive or accepted-risk.');
      }
      parsed.body.reason = reason;
      parsed.body.comment = requireText(values.comment, 'comment');
      return;
    }
    case 'reopen':
      parsed.body.comment = requireText(values.comment, 'comment');
      return;
    case 'comment':
      parsed.body.text = requireText(parameters[2], 'text');
      return;
    case 'model': {
      const useDefault = flags.has('default');
      const model = parameters[1];
      if (useDefault === (model !== undefined)) {
        throw new Error(
          'platform: Usage: void platform security model <project-id> <model-id|--default>.',
        );
      }
      parsed.body = {
        model: useDefault ? null : model,
        ...(flags.has('accept-provider-notice') ? { acceptProviderNotice: true } : {}),
      };
      return;
    }
    case 'bypass':
      parsed.body.reason = requireText(values.reason, 'reason');
      return;
    default:
      return;
  }
}

function requireText(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`platform: ${name} is required.`);
  }
  return value;
}
