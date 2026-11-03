import type { SubcommandDef } from './subcommand-prompt.ts';

const PLATFORM_FLAG = {
  name: '--platform',
  arg: '<cloudflare|void>',
  description: 'Your own Cloudflare account (`cloudflare`) instead of the Void platform',
};

export const emailSubcommands: Array<SubcommandDef> = [
  { name: 'usage', description: 'Show monthly recipient attempts, inbound receipts, and quota' },
  { name: 'logs', description: 'Show recent email delivery activity' },
  { name: 'destinations', description: 'List verified recipient addresses for outbound mail' },
  { name: 'allow', arg: '<address>', description: 'Add a recipient and trigger CF verification' },
  { name: 'disallow', arg: '<address>', description: 'Remove a verified recipient' },
  {
    name: 'alias',
    arg: '[name]',
    description: 'Show the shared mail address, or set a shorter permanent name for it',
  },
  // The verb is collected as the arg so `domain list` completes in the interactive prompt;
  // `domain add` then errors naming the missing <domain>, like a typed invocation.
  {
    name: 'domain',
    arg: '<add|status|list|sync|rotate-secret|remove>',
    description: 'Send and receive at your own domain on a Cloudflare zone',
  },
  {
    name: 'status',
    description:
      'Show the email setup state on your own Cloudflare account (--platform cloudflare)',
    flags: [PLATFORM_FLAG],
  },
  {
    name: 'setup',
    description: 'Set email up on your own Cloudflare account (--platform cloudflare)',
    flags: [PLATFORM_FLAG],
  },
];

const EMAIL_SUBCOMMANDS = [
  'usage',
  'logs',
  'destinations',
  'allow',
  'disallow',
  'alias',
  'domain',
  'status',
  'setup',
] as const;

const EMAIL_DOMAIN_VERBS = ['add', 'status', 'list', 'sync', 'rotate-secret', 'remove'] as const;
type EmailDomainVerb = (typeof EMAIL_DOMAIN_VERBS)[number];

export interface EmailArgs {
  subcommand: (typeof EMAIL_SUBCOMMANDS)[number];
  /** The nested `void email domain <verb>` verb — set only when subcommand is 'domain'. */
  domainVerb?: EmailDomainVerb;
  /** The domain positional of a domain verb (absent for `domain list`). */
  domain?: string;
  projectSlug?: string;
  limit?: number;
  address?: string;
  /** `cloudflare` is the developer's own account; `void` (the default) is the Void platform. */
  platform?: 'cloudflare' | 'void';
  /** `void email alias <name> --yes` sets the permanent alias without a prompt. */
  yes?: boolean;
}

/**
 * Read a value-taking flag in its `--flag value` or `--flag=value` form. Returns the
 * raw value, or `undefined` when the flag is the last token or is followed by another
 * option — the same rule `parseArgs` applies for `void deploy`, so `--platform --limit 3`
 * is a missing value, not a value of `--limit`.
 */
function readFlagValue(
  rest: ReadonlyArray<string>,
  i: number,
  flag: string,
): { value: string | undefined; next: number } {
  const token = rest[i]!;
  if (token.startsWith(`${flag}=`)) {
    return { value: token.slice(flag.length + 1), next: i };
  }
  const value = rest[i + 1];
  if (value === undefined || value.startsWith('-')) {
    return { value: undefined, next: i };
  }
  return { value, next: i + 1 };
}

export function parseEmailArgs(args: Array<string>): EmailArgs {
  const subcommand = args[0] as EmailArgs['subcommand'];
  if (!subcommand || !(EMAIL_SUBCOMMANDS as ReadonlyArray<string>).includes(subcommand)) {
    throw new Error(
      'email: Usage: void email <usage|logs|destinations|allow|disallow|alias|domain|status|setup> [args] [--project <name>] [--limit <n>] [--platform cloudflare].',
    );
  }

  let limit: number | undefined;
  // One raw value per occurrence, so a repeated flag is an error even when its last value
  // is valid (the same rule as `void deploy`).
  const projectValues: Array<string> = [];
  const platformValues: Array<string> = [];
  const positional: Array<string> = [];
  let yes = false;

  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    // A bare flag must not fall through as a positional, which the read-only subcommands
    // never reject.
    if (rest[i] === '--project' || rest[i]?.startsWith('--project=')) {
      const { value, next } = readFlagValue(rest, i, '--project');
      // An empty value (`--project=`, an empty shell variable) is missing: `''` is not
      // nullish, so `runEmailCommand` would skip `VOID_PROJECT` and use the linked project.
      if (value === undefined || value.trim() === '') {
        throw new Error('email: --project requires a value (a project name).');
      }
      projectValues.push(value);
      i = next;
    } else if (rest[i] === '--limit' || rest[i]?.startsWith('--limit=')) {
      const { value: raw, next } = readFlagValue(rest, i, '--limit');
      if (raw === undefined) {
        throw new Error('email: --limit requires a value (a positive integer).');
      }
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`email: --limit must be a positive integer (got '${raw}').`);
      }
      limit = n;
      i = next;
    } else if (rest[i] === '--platform' || rest[i]?.startsWith('--platform=')) {
      const { value, next } = readFlagValue(rest, i, '--platform');
      if (value === undefined) {
        throw new Error("email: --platform requires a value ('cloudflare' or 'void').");
      }
      platformValues.push(value);
      i = next;
    } else if (rest[i] === '--yes' && subcommand === 'alias') {
      yes = true;
    } else if (rest[i] === '--backend' || rest[i]?.startsWith('--backend=')) {
      throw new Error("email: Unknown option '--backend'.");
    } else if (rest[i] === '--subdomain' || rest[i]?.startsWith('--subdomain=')) {
      throw new Error("email: Unknown option '--subdomain'.");
    } else {
      positional.push(rest[i]);
    }
  }

  if (projectValues.length > 1) {
    throw new Error('email: --project can only be specified once.');
  }
  const projectSlug = projectValues[0];

  if (platformValues.length > 1) {
    throw new Error('email: --platform can only be specified once.');
  }

  let platform: EmailArgs['platform'];
  const platformValue = platformValues[0];
  if (platformValue !== undefined) {
    if (platformValue !== 'cloudflare' && platformValue !== 'void') {
      throw new Error("email: --platform must be 'cloudflare' or 'void'.");
    }
    platform = platformValue;
  }

  // The `domain` group parses its own positionals (verb + domain); the one-positional
  // rule below would read the verb as the address.
  if (subcommand === 'domain') {
    if (platform === 'cloudflare') {
      throw new Error(
        'email: --platform cloudflare applies to `void email status` and `void email setup` only (`domain` is a Void platform command).',
      );
    }
    return parseEmailDomainArgs(positional, { projectSlug, limit, platform });
  }

  if (positional.length > 1) {
    throw new Error(
      `email: \`void email ${subcommand}\` takes exactly one positional argument (got ${positional.length}: ${positional.map((p) => JSON.stringify(p)).join(', ')}).`,
    );
  }

  const address = positional[0];

  if ((subcommand === 'allow' || subcommand === 'disallow') && !address) {
    throw new Error(`email: Usage: void email ${subcommand} <address> [--project <name>].`);
  }

  // `--platform cloudflare` reads the local project and the developer's own Cloudflare
  // session, never a Void project, so `--project` has nothing to select.
  if (platform === 'cloudflare') {
    if (subcommand !== 'status' && subcommand !== 'setup') {
      throw new Error(
        `email: --platform cloudflare applies to \`void email status\` and \`void email setup\` only (\`${subcommand}\` is a Void platform command).`,
      );
    }
    if (projectSlug !== undefined) {
      throw new Error(
        'email: --project cannot be combined with --platform cloudflare (it reads the local project, not a Void project).',
      );
    }
    if (address !== undefined) {
      throw new Error(
        `email: \`void email ${subcommand} --platform cloudflare\` takes no argument.`,
      );
    }
  }

  return { subcommand, projectSlug, limit, address, platform, ...(yes ? { yes } : {}) };
}

/**
 * `void email domain <verb> [<domain>]`. The parser only counts positionals; the command
 * and the API validate the domain itself.
 */
function parseEmailDomainArgs(
  positional: ReadonlyArray<string>,
  flags: {
    projectSlug?: string;
    limit?: number;
    platform?: EmailArgs['platform'];
  },
): EmailArgs {
  const verb = positional[0];
  if (!verb || !(EMAIL_DOMAIN_VERBS as ReadonlyArray<string>).includes(verb)) {
    throw new Error(
      'email: Usage: void email domain <add|status|list|sync|rotate-secret|remove> [<domain>] [--project <name>].',
    );
  }
  const domain = positional[1];
  if (verb === 'list') {
    if (domain !== undefined) {
      throw new Error('email: `void email domain list` takes no domain argument.');
    }
  } else if (domain === undefined) {
    throw new Error(`email: Usage: void email domain ${verb} <domain> [--project <name>].`);
  }
  if (positional.length > 2) {
    throw new Error(
      `email: \`void email domain ${verb}\` takes exactly one domain argument (got ${positional.length - 1}: ${positional
        .slice(1)
        .map((p) => JSON.stringify(p))
        .join(', ')}).`,
    );
  }
  return {
    subcommand: 'domain',
    domainVerb: verb as EmailDomainVerb,
    domain,
    projectSlug: flags.projectSlug,
    limit: flags.limit,
    platform: flags.platform,
  };
}
