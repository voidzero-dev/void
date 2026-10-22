import { parsePlatformLoginId } from '@void/platform';
import { OPERATOR_MAX_TIMEOUT_MS } from './operator-client.ts';

/** Public operator commands. This table also drives nested CLI help. */
export type OperatorCommand = {
  group: string;
  action: string;
  description: string;
  positional?: Array<string>;
  optionalPositional?: boolean;
  usage?: Array<string>;
  values?: Record<string, string>;
  booleans?: Record<string, string>;
  method?: 'POST';
  path: string;
};

export const operatorCommands: Array<OperatorCommand> = [
  {
    group: 'auth',
    action: 'login',
    description: 'Sign in as a platform administrator',
    path: '/session',
    values: { provider: 'OAuth provider' },
    booleans: {
      'token-stdin': 'Read a full API session from stdin for explicit operator session exchange',
    },
  },
  {
    group: 'auth',
    action: 'logout',
    description: 'Revoke the current operator session and remove its local credential',
    path: '/session/logout',
  },
  {
    group: 'auth',
    action: 'status',
    description: 'Inspect operator identity, expiry, and capabilities',
    path: '/session',
  },
  {
    group: 'auth',
    action: 'token',
    description: 'Print an operator token; exchange an API session with --token-stdin',
    path: '/session',
    booleans: {
      'token-stdin': 'Read a full API session from stdin for explicit operator session exchange',
    },
  },
  {
    group: 'user',
    action: 'list',
    description: 'List users',
    path: '/users',
    values: { search: 'Search login or email' },
  },
  {
    group: 'user',
    action: 'show',
    description: 'Inspect a user, usage, and projects',
    path: '/users/:id',
    positional: ['id'],
  },
  {
    group: 'user',
    action: 'plan',
    description: 'Change a user plan',
    path: '/users/:id/plan',
    positional: ['id', 'plan'],
    method: 'POST',
  },
  {
    group: 'user',
    action: 'suspend',
    description: 'Suspend a user and their projects',
    path: '/users/:id/suspend',
    positional: ['id'],
    values: { reason: 'Reason for suspension' },
    method: 'POST',
  },
  {
    group: 'user',
    action: 'restore',
    description: 'Restore a suspended user',
    path: '/users/:id/restore',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'user',
    action: 'delete',
    description: 'Delete a user and all owned resources',
    path: '/users/:id/delete',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'project',
    action: 'list',
    description: 'List tenant projects',
    path: '/projects',
    values: { user: 'Owner user ID', search: 'Search projects' },
  },
  {
    group: 'project',
    action: 'show',
    description: 'Inspect a project and its resources',
    path: '/projects/:id',
    positional: ['id'],
  },
  {
    group: 'project',
    action: 'delete',
    description: 'Delete a project and its resources',
    path: '/projects/:id/delete',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'project',
    action: 'normalize',
    description: 'Verify and normalize legacy project deployment and queue identities',
    path: '/projects/:id/normalize',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'project',
    action: 'owner',
    description: 'Transfer project ownership to another registered user',
    path: '/projects/:id/owner',
    positional: ['id', 'userId'],
    method: 'POST',
  },
  {
    group: 'zero-trust',
    action: 'status',
    description: 'Inspect saved platform Zero Trust configuration and project state counts',
    path: '/zero-trust',
    booleans: {
      check: 'Also check the saved settings against Cloudflare Access (several API calls)',
    },
  },
  {
    group: 'zero-trust',
    action: 'configure',
    description: 'Configure and reconcile project Zero Trust protection',
    path: '/zero-trust/configure',
    values: {
      'identity-providers': 'Comma-separated Access identity provider IDs',
      policies: 'Comma-separated reusable Access policy IDs',
      'existing-projects': 'Required when enabling: protected or public for existing projects',
    },
    booleans: {
      'token-stdin': 'Read the Access management API token from stdin',
      'protect-new-projects': 'Protect newly created projects by default',
      'public-apps': 'Manage public app rules without identity policies',
    },
    method: 'POST',
  },
  {
    group: 'zero-trust',
    action: 'reconcile',
    description: 'Repair platform and project Access configuration drift',
    path: '/zero-trust/reconcile',
    method: 'POST',
  },
  {
    group: 'zero-trust',
    action: 'disable',
    description: 'Remove Void-managed Access applications and make projects public',
    path: '/zero-trust/disable',
    method: 'POST',
  },
  {
    group: 'zero-trust',
    action: 'project-status',
    description: 'Inspect one project Zero Trust override and effective state',
    path: '/zero-trust/projects/:id',
    positional: ['id'],
  },
  {
    group: 'zero-trust',
    action: 'project-protect',
    description: 'Protect one project, overriding the platform default',
    path: '/zero-trust/projects/:id',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'zero-trust',
    action: 'project-public',
    description: 'Make one project public, overriding the platform default',
    path: '/zero-trust/projects/:id',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'zero-trust',
    action: 'project-reconcile',
    description: 'Repair Access configuration drift for one project',
    path: '/zero-trust/projects/:id/reconcile',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'deployment',
    action: 'list',
    description: 'List tenant deployments',
    path: '/deployments',
    values: { project: 'Project ID', search: 'Search deployments', status: 'Deployment status' },
  },
  {
    group: 'deployment',
    action: 'show',
    description: 'Inspect a deployment',
    path: '/deployments/:id',
    positional: ['id'],
  },
  {
    group: 'deployment',
    action: 'cancel',
    description: 'Cancel a deployment',
    path: '/deployments/:id/cancel',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'deployment',
    action: 'migrate-assets',
    description: 'Copy and verify legacy deployment assets in scoped R2 storage',
    path: '/deployments/:id/migrate-assets',
    positional: ['id'],
    values: { cursor: 'Resume from the last successful asset migration cursor' },
    method: 'POST',
  },
  {
    group: 'deployment',
    action: 'logs',
    description: 'Read runtime logs (JSON follow emits one object per line)',
    path: '/deployments/:id/logs',
    positional: ['id'],
    values: { since: 'Duration or ISO timestamp', cursor: 'Opaque continuation cursor' },
    booleans: { follow: 'Poll new logs until interrupted or the build ends' },
  },
  {
    group: 'build',
    action: 'show',
    description: 'Inspect a managed build',
    path: '/builds/:id',
    positional: ['id'],
  },
  {
    group: 'build',
    action: 'logs',
    description: 'Read build logs (JSON follow emits one object per line)',
    path: '/builds/:id/logs',
    positional: ['id'],
    values: { since: 'Last received sequence number' },
    booleans: { follow: 'Poll new logs until interrupted or the build ends' },
  },
  {
    group: 'signup',
    action: 'show',
    description: 'Inspect signup restrictions and allowlist',
    path: '/signup',
  },
  {
    group: 'signup',
    action: 'restrict',
    description: 'Restrict signup to the allowlist',
    path: '/signup/restrict',
    method: 'POST',
  },
  {
    group: 'signup',
    action: 'open',
    description: 'Open public signup',
    path: '/signup/open',
    method: 'POST',
  },
  {
    group: 'signup',
    action: 'allow',
    description: 'Add a GitHub, email, or exact login identity grant',
    path: '/signup/allow',
    positional: ['type', 'pattern'],
    usage: [
      'void platform signup allow <github|email> <pattern> [options]',
      'void platform signup allow identity <connection-id> <subject> [options]',
    ],
    values: { note: 'Allowlist note' },
    method: 'POST',
  },
  {
    group: 'signup',
    action: 'disallow',
    description: 'Remove a GitHub, email, or exact login identity grant',
    path: '/signup/disallow',
    positional: ['type', 'pattern'],
    usage: [
      'void platform signup disallow <github|email> <pattern> [options]',
      'void platform signup disallow identity <connection-id> <subject> [options]',
    ],
    method: 'POST',
  },
  {
    group: 'signup',
    action: 'remove',
    description: 'Remove a GitHub or email allowlist pattern (compatibility alias)',
    path: '/signup/remove',
    positional: ['type', 'pattern'],
    method: 'POST',
  },
  { group: 'invitation', action: 'list', description: 'List invitations', path: '/invitations' },
  {
    group: 'invitation',
    action: 'send',
    description: 'Send invitations to comma-separated email addresses',
    path: '/invitations/send',
    positional: ['emails'],
    method: 'POST',
  },
  {
    group: 'invitation',
    action: 'revoke',
    description: 'Revoke an invitation',
    path: '/invitations/:id/revoke',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'system',
    action: 'overview',
    description: 'Inspect platform usage and capacity',
    path: '/system/overview',
  },
  {
    group: 'system',
    action: 'health',
    description: 'Check platform health',
    path: '/system/health',
  },
  {
    group: 'system',
    action: 'cli-versions',
    description: 'Inspect CLI version adoption and deployment statistics',
    path: '/system/cli-versions',
  },
  {
    group: 'system',
    action: 'asset-migrations',
    description: 'Inventory legacy assets in active and retained deployments',
    path: '/system/asset-migrations',
    values: { page: 'One-based page number', limit: 'Maximum 100 records per page' },
  },
  {
    group: 'system',
    action: 'events',
    description: 'List operator audit events',
    path: '/system/events',
  },
  {
    group: 'system',
    action: 'backfill-queue-tokens',
    description: 'Repair missing queue authentication tokens',
    path: '/system/backfill-queue-tokens',
    method: 'POST',
  },
  {
    group: 'system',
    action: 'sandbox-drain',
    description: 'Drain and verify managed Sandbox container applications',
    path: '/system/sandbox-drain',
    values: { cursor: 'Opaque cursor returned by --plan' },
    method: 'POST',
  },
  {
    group: 'system',
    action: 'rotate-proxy-tokens',
    description: 'Rotate project proxy tokens on tenant Workers',
    path: '/system/rotate-proxy-tokens',
    values: { project: 'Project ID' },
    booleans: { all: 'Rotate every project' },
    method: 'POST',
  },
  {
    group: 'email',
    action: 'policy',
    description: 'Show the recipient policy for the shared sender',
    path: '/email/policy',
  },
  {
    group: 'email',
    action: 'policy-set',
    description: 'Set the recipient policy: verified, domains, or any',
    path: '/email/policy',
    positional: ['mode'],
    values: { domains: 'Comma-separated recipient domains for mode=domains' },
    method: 'POST',
  },
  {
    group: 'email',
    action: 'settings',
    description: 'Show platform email settings',
    path: '/email/settings',
  },
  {
    group: 'email',
    action: 'settings-set',
    description: 'Set who manages email domains: self-serve or admin',
    path: '/email/settings',
    values: { domains: 'self-serve or admin' },
    method: 'POST',
  },
  {
    group: 'email',
    action: 'limit',
    description: "Set a project's monthly and burst recipient submission caps",
    path: '/email/projects/:project/limit',
    positional: ['project'],
    values: {
      monthly: 'Recipient submissions per UTC calendar month',
      burst: 'Recipient submissions per rolling 60-second window',
    },
    method: 'POST',
  },
  {
    group: 'email',
    action: 'logs',
    description: 'Inspect retained email receipt and recipient outcomes for a project',
    path: '/email/projects/:project/logs',
    positional: ['project'],
  },
  {
    group: 'email',
    action: 'attempts',
    description: 'List unresolved email send attempts awaiting operator reconciliation',
    path: '/email/attempts',
    values: { project: 'Project id or slug' },
  },
  {
    group: 'email',
    action: 'attempt-resolve',
    description: 'Resolve a stopped send as outcome unknown and release its cleanup fence',
    path: '/email/attempts/:id/resolve',
    positional: ['id'],
    values: { reason: 'Audit reason without recipient or message content' },
    booleans: { ended: 'Attest that the original provider execution has ended' },
    method: 'POST',
  },
  {
    group: 'email',
    action: 'operation-resolve',
    description: 'Resolve an ended ambiguous email setup write with operator attestation',
    path: '/email/operations/:id/resolve',
    positional: ['id'],
    values: {
      outcome: 'Provider outcome: applied or not-applied',
      reason: 'Audit reason for the verified provider outcome',
    },
    booleans: { ended: 'Attest that the original provider execution has ended' },
    method: 'POST',
  },
  {
    group: 'email',
    action: 'shared-recipients',
    description: 'Inspect shared inbound recipient rules and interrupted creation intents',
    path: '/email/shared-recipients',
    values: { project: 'Project id or slug, including a project awaiting deletion' },
  },
  {
    group: 'email',
    action: 'shared-recipient-resolve',
    description: 'Resolve an ended ambiguous shared recipient creation after provider inspection',
    path: '/email/shared-recipients/:id/resolve',
    positional: ['id'],
    values: {
      outcome: 'Provider outcome: applied or not-applied',
      reason: 'Audit reason for the verified provider outcome',
    },
    booleans: { ended: 'Attest that the original provider execution has ended' },
    method: 'POST',
  },
  {
    group: 'email',
    action: 'domains',
    description: 'List email domains registered on this platform',
    path: '/email/domains',
    values: { project: 'Project id or slug' },
  },
  {
    group: 'email',
    action: 'domain-add',
    description: 'Register an email domain for a project with the platform credential',
    path: '/email/domains',
    positional: ['domain'],
    values: { project: 'Project id or slug' },
    booleans: {
      'token-stdin': 'Read a scoped Cloudflare API token from stdin',
      'outbound-only': 'Send only; leave the MX records and inbound mail with the current provider',
    },
    method: 'POST',
  },
  {
    group: 'email',
    action: 'domain-status',
    description: "Inspect an email domain's setup, credential and relay",
    path: '/email/domains/:domain',
    positional: ['domain'],
  },
  {
    group: 'email',
    action: 'domain-sync',
    description: 'Reconcile an email domain with its Cloudflare setup',
    path: '/email/domains/:domain/sync',
    positional: ['domain'],
    method: 'POST',
  },
  {
    group: 'email',
    action: 'domain-rotate-secret',
    description: "Rotate an email domain's ingress secret",
    path: '/email/domains/:domain/rotate-secret',
    positional: ['domain'],
    method: 'POST',
  },
  {
    group: 'email',
    action: 'domain-remove',
    description: 'Remove an email domain and its Cloudflare setup',
    path: '/email/domains/:domain/remove',
    positional: ['domain'],
    booleans: {
      'token-stdin': 'Read a replacement Cloudflare token for blocked project cleanup from stdin',
    },
    method: 'POST',
  },
  {
    group: 'worker',
    action: 'list',
    description: 'List hosted platform workers',
    path: '/workers',
    values: { environment: 'production or staging' },
  },
  {
    group: 'worker',
    action: 'show',
    description: 'Inspect hosted worker versions',
    path: '/workers/:id',
    positional: ['id'],
    values: { environment: 'production or staging' },
  },
  {
    group: 'worker',
    action: 'rollback',
    description: 'Roll back a hosted worker to a version',
    path: '/workers/:id/rollback',
    positional: ['id', 'versionId'],
    values: { environment: 'production or staging' },
    method: 'POST',
  },
  {
    group: 'worker',
    action: 'rollback-all',
    description: 'Roll back all hosted workers to their previous versions',
    path: '/workers/rollback-all',
    values: { environment: 'production or staging' },
    method: 'POST',
  },
  {
    group: 'worker',
    action: 'events',
    description: 'List hosted worker events or inspect a batch',
    path: '/workers/events',
    positional: ['batchId'],
    optionalPositional: true,
    values: { environment: 'production or staging' },
  },
];

export const operatorGroups: Array<string> = [
  ...new Set(operatorCommands.map(({ group }) => group)),
];
export type OperatorArgs = {
  subcommand: 'operator';
  group: string;
  action: string;
  connection: string;
  json: boolean;
  plan: boolean;
  yes: boolean;
  follow: boolean;
  tokenStdin: boolean;
  provider?: string;
  timeoutMs?: number;
  method: 'GET' | 'POST';
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
};

export function parseOperatorArgs(args: Array<string>): OperatorArgs {
  const positional: Array<string> = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const booleanFlags = new Set([
    'json',
    'plan',
    'yes',
    // No command declares `--force`; parsing it as a boolean reports it as an unknown flag.
    'force',
    ...operatorCommands.flatMap((command) => Object.keys(command.booleans ?? {})),
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`platform: Unknown flag '${arg}'.`);
    }
    const flag = arg.slice(2);
    if (flags.has(flag) || Object.hasOwn(values, flag)) {
      throw new Error(`platform: Duplicate flag '${arg}'.`);
    }
    if (booleanFlags.has(flag)) {
      flags.add(flag);
    } else {
      const value = args[++index];
      if (!value || value.startsWith('-')) {
        throw new Error(`platform: ${arg} requires a value.`);
      }
      values[flag] = value;
    }
  }
  const [group = '', action = '', ...parameters] = positional;
  if (!operatorGroups.includes(group)) {
    throw new Error('platform: Unknown operator command group.');
  }
  const parsed: OperatorArgs = {
    subcommand: 'operator',
    group,
    action,
    connection: values.connection ?? '',
    json: flags.has('json'),
    plan: flags.has('plan'),
    yes: flags.has('yes'),
    follow: flags.has('follow'),
    tokenStdin: flags.has('token-stdin'),
    provider: values.provider,
    method: 'GET',
    path: '',
    query: {},
    body: {},
  };
  if (!action && args.length === 1) {
    return parsed;
  }
  const command = operatorCommands.find(
    (entry) => entry.group === group && entry.action === action,
  );
  if (!command) {
    throw new Error(
      `platform: Usage: void platform ${group} <${operatorCommands
        .filter((entry) => entry.group === group)
        .map(({ action }) => action)
        .join('|')}>.`,
    );
  }
  const count = command.positional?.length ?? 0;
  const identitySignupEntry =
    group === 'signup' && ['allow', 'disallow'].includes(action) && parameters[0] === 'identity';
  if (group === 'signup' && action === 'remove' && parameters[0] === 'identity') {
    throw new Error(
      'platform: Use `void platform signup disallow identity <connection-id> <subject>`.',
    );
  }
  const expectedCount = identitySignupEntry ? 3 : count;
  if (
    parameters.length > expectedCount ||
    (!command.optionalPositional && parameters.length !== expectedCount)
  ) {
    throw new Error(
      `platform: Usage: ${command.usage?.[identitySignupEntry ? 1 : 0]?.replace(/ \[options\]$/, '') ?? `void platform ${group} ${action}${command.positional?.map((name) => ` <${name}>`).join('') ?? ''}`}.`,
    );
  }
  const paged =
    action === 'list' ||
    action === 'events' ||
    action === 'logs' ||
    action === 'attempts' ||
    action === 'shared-recipients';
  const allowed = new Set([
    'connection',
    ...(command.method ? ['timeout'] : []),
    ...Object.keys(command.values ?? {}),
    ...(paged ? ['limit', ...(action !== 'logs' || group === 'email' ? ['page'] : [])] : []),
  ]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) {
      throw new Error(`platform: Unknown flag '--${name}' for ${group} ${action}.`);
    }
  }
  for (const name of flags) {
    if (
      ![
        'json',
        ...(command.method ? ['yes', 'plan'] : []),
        ...Object.keys(command.booleans ?? {}),
      ].includes(name)
    ) {
      throw new Error(`platform: Unknown flag '--${name}' for ${group} ${action}.`);
    }
  }
  if (parsed.plan && parsed.yes) {
    throw new Error('platform: --plan and --yes cannot be combined.');
  }
  parsed.path = command.path;
  parsed.method = command.method ?? 'GET';
  if (identitySignupEntry) {
    const connectionId = parameters[1]!;
    const subject = parameters[2]!;
    try {
      parsePlatformLoginId(connectionId);
    } catch {
      throw new Error('platform: Invalid login connection ID.');
    }
    if (!subject || subject.length > 255) {
      throw new Error('platform: Identity subject must be 1–255 characters.');
    }
    parsed.body = { type: 'identity', connectionId, subject };
  } else {
    for (const [index, name] of (command.positional ?? []).entries()) {
      const value = parameters[index];
      if (value === undefined) {
        continue;
      }
      if (value === '.' || value === '..') {
        throw new Error('platform: An object ID cannot be a dot path segment.');
      }
      if (parsed.path.includes(`:${name}`)) {
        parsed.path = parsed.path.replace(`:${name}`, encodeURIComponent(value));
      } else if (group === 'worker' && action === 'events') {
        parsed.path += `/${encodeURIComponent(value)}`;
      } else {
        parsed.body[name] =
          name === 'emails' ? value.split(',').map((email) => email.trim()) : value;
      }
    }
  }
  for (const [name, value] of Object.entries(values)) {
    if (name === 'connection' || name === 'provider') {
      continue;
    }
    if (name === 'timeout') {
      const maximum = OPERATOR_MAX_TIMEOUT_MS / 1_000;
      if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) {
        throw new Error(`platform: --timeout must be an integer from 1 to ${maximum} seconds.`);
      }
      parsed.timeoutMs = Number(value) * 1_000;
      continue;
    }
    if (name === 'page' || name === 'limit') {
      const maximum =
        name === 'limit' ? (action === 'logs' && group !== 'email' ? 500 : 100) : 1_000_000;
      if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) {
        throw new Error(`platform: --${name} must be an integer from 1 to ${maximum}.`);
      }
    }
    if (
      name === 'since' &&
      group === 'build' &&
      (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    ) {
      throw new Error('platform: --since must be a nonnegative safe integer for build logs.');
    }
    if (name === 'environment' && !['production', 'staging'].includes(value)) {
      throw new Error('platform: --environment must be production or staging.');
    }
    if (parsed.method === 'POST') {
      parsed.body[name] = value;
    } else {
      parsed.query[name] = value;
    }
  }
  if (parsed.body.type && !['github', 'email', 'identity'].includes(String(parsed.body.type))) {
    throw new Error('platform: Signup grant type must be github, email, or identity.');
  }
  // Command-specific booleans other than the session's own `--token-stdin`
  // ride the body, where the server reads them as JSON booleans.
  for (const name of Object.keys(command.booleans ?? {})) {
    if (name !== 'token-stdin' && flags.has(name)) {
      parsed.body[name] = true;
    }
  }
  if (group === 'zero-trust' && action === 'configure') {
    if (!parsed.tokenStdin) {
      throw new Error('platform: zero-trust configure requires --token-stdin.');
    }
    const identityProviderIds = values['identity-providers']
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const policyIds = values.policies
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const existingProjects = values['existing-projects'];
    const publicAccess = flags.has('public-apps');
    if (
      publicAccess &&
      (identityProviderIds?.length ||
        policyIds?.length ||
        flags.has('protect-new-projects') ||
        existingProjects === 'protected')
    ) {
      throw new Error(
        'platform: --public-apps cannot include identity policies or protected project choices.',
      );
    }
    if (!publicAccess && (!identityProviderIds?.length || !policyIds?.length)) {
      throw new Error(
        'platform: zero-trust configure requires --identity-providers and --policies.',
      );
    }
    // Required only when enabling; the platform rejects it once enabled.
    if (
      existingProjects !== undefined &&
      existingProjects !== 'protected' &&
      existingProjects !== 'public'
    ) {
      throw new Error('platform: --existing-projects must be protected or public.');
    }
    parsed.body = {
      identityProviderIds: identityProviderIds ?? [],
      policyIds: policyIds ?? [],
      ...(publicAccess ? { publicAccess: true } : {}),
      ...(existingProjects ? { existingProjects } : {}),
      protectNewProjects: flags.has('protect-new-projects'),
    };
  } else if (group === 'zero-trust' && action === 'status') {
    // A GET carries its options in the query string.
    delete parsed.body.check;
    if (flags.has('check')) {
      parsed.query.check = 'true';
    }
  } else if (group === 'zero-trust' && action === 'project-protect') {
    parsed.body.protected = true;
  } else if (group === 'zero-trust' && action === 'project-public') {
    parsed.body.protected = false;
  } else if (group === 'email' && action === 'domain-add' && flags.has('outbound-only')) {
    delete parsed.body['outbound-only'];
    parsed.body.outboundOnly = true;
  }
  return parsed;
}
