import type { SubcommandDef } from './subcommand-prompt.ts';

const LOG_LEVELS = new Set(['error', 'warn', 'info', 'log', 'debug', 'all']);
// A status class (`5xx`), an exact code in the 100-599 HTTP range (`500`), or
// `all`. Exact codes are range-bounded so a typo like `600` errors instead of
// silently returning an empty result.
const STATUS_FILTER = /^([1-5]xx|[1-5]\d{2}|all)$/;
const TEAM_ROLES = new Set(['reader', 'collaborator', 'admin']);

type TeamRole = 'reader' | 'collaborator' | 'admin';

export const projectSubcommands: Array<SubcommandDef> = [
  { name: 'status', arg: '[name]', description: 'Show deployments (omit name for linked project)' },
  { name: 'link', arg: '[name]', description: 'Link directory to a project' },
  { name: 'list', description: 'List your projects' },
  {
    name: 'token',
    arg: '<create|list|renew|revoke>',
    description: 'Manage project-scoped CI deploy credentials',
  },
  {
    name: 'team',
    hint: 'list | invite | invitations | role | remove | revoke | leave | pending | accept | decline',
    description: 'Manage project members and invitations',
  },
  {
    name: 'zero-trust',
    hint: 'status | protect | public | reconcile',
    description: 'Inspect or override Cloudflare Zero Trust protection',
  },
  { name: 'logs', description: 'Show runtime logs from the deployed project' },
  { name: 'requests', description: 'Show request-level traffic (status, method, timing)' },
  {
    name: 'rollback',
    arg: '[deployId]',
    description: 'Roll back to a previous deployment',
    flags: [
      {
        name: '--platform',
        arg: 'cloudflare',
        description: 'Roll back after a one-off deploy with --platform cloudflare',
      },
    ],
  },
  { name: 'cancel', arg: '[deployId]', description: 'Cancel an active deployment' },
  {
    name: 'delete',
    arg: '[name]',
    description: 'Delete a project (omit name to delete linked project)',
  },
  { name: 'purge-cache', description: 'Purge all cached pages (Void platform)' },
];

export type ProjectArgs =
  | { subcommand: 'status'; name: string }
  | { subcommand: 'link'; name: string }
  | { subcommand: 'list' }
  | {
      subcommand: 'zero-trust';
      action: '' | 'status' | 'protect' | 'public' | 'reconcile';
      projectSlug: string;
    }
  | { subcommand: 'team'; action: '' }
  | {
      subcommand: 'team';
      action: 'list' | 'invitations' | 'leave';
      projectSlug: string;
    }
  | {
      subcommand: 'team';
      action: 'invite';
      email: string;
      role: TeamRole;
      projectSlug: string;
    }
  | {
      subcommand: 'team';
      action: 'role';
      userId: string;
      role: TeamRole;
      projectSlug: string;
    }
  | {
      subcommand: 'team';
      action: 'remove';
      userId: string;
      projectSlug: string;
    }
  | {
      subcommand: 'team';
      action: 'revoke';
      invitationId: string;
      projectSlug: string;
    }
  | {
      subcommand: 'team';
      action: 'pending';
    }
  | {
      subcommand: 'team';
      action: 'accept' | 'decline';
      invitationId: string;
    }
  | {
      subcommand: 'token';
      action: 'create' | 'list' | 'renew' | 'revoke';
      credentialId: string;
      projectSlug: string;
      name: string;
      expiresInDays?: number;
      json: boolean;
    }
  | {
      subcommand: 'logs';
      filter: string;
      range: string;
      deployment: string;
      level: string;
    }
  | { subcommand: 'requests'; status: string; range: string }
  | { subcommand: 'rollback'; deployId: string; platform?: 'cloudflare' }
  | { subcommand: 'cancel'; deployId: string }
  | { subcommand: 'delete'; name: string; force: boolean }
  | { subcommand: 'purge-cache'; projectSlug: string };

export function parseProjectArgs(args: Array<string>): ProjectArgs {
  const [subcommand, ...rest] = args;

  if (subcommand === 'status' || subcommand === 'link') {
    return { subcommand, name: parseOptionalPositional(rest) };
  }

  if (subcommand === 'list') {
    if (rest.length > 0) {
      throw new Error(`project: Unexpected argument '${rest[0]}'.`);
    }
    return { subcommand };
  }

  if (subcommand === 'token') {
    const action = rest.shift();
    if (!action || !['create', 'list', 'renew', 'revoke'].includes(action)) {
      throw new Error('project: Usage: void project token <create|list|renew|revoke>.');
    }
    let credentialId = '';
    let projectSlug = '';
    let name = '';
    let expiresInDays: number | undefined;
    let json = false;
    for (let index = 0; index < rest.length; index++) {
      const value = rest[index]!;
      if (value === '--project' && rest[index + 1]) {
        projectSlug = rest[++index]!;
      } else if (value === '--name' && rest[index + 1]) {
        name = rest[++index]!;
      } else if (value === '--expires-in' && rest[index + 1]) {
        const parsed = Number(rest[++index]);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
          throw new Error('project: --expires-in must be an integer from 1 to 90 days.');
        }
        expiresInDays = parsed;
      } else if (value === '--json') {
        json = true;
      } else if (value.startsWith('-')) {
        throw new Error(`project: Unknown flag '${value}'.`);
      } else if ((action === 'renew' || action === 'revoke') && !credentialId) {
        credentialId = value;
      } else {
        throw new Error(`project: Unexpected argument '${value}'.`);
      }
    }
    if ((action === 'renew' || action === 'revoke') && !credentialId) {
      throw new Error(`project: ${action} requires a credential ID.`);
    }
    if (action !== 'create' && name) {
      throw new Error('project: --name is only valid with token create.');
    }
    if (action !== 'create' && action !== 'renew' && expiresInDays !== undefined) {
      throw new Error('project: --expires-in is only valid with token create or token renew.');
    }
    return {
      subcommand,
      action: action as 'create' | 'list' | 'renew' | 'revoke',
      credentialId,
      projectSlug,
      name,
      expiresInDays,
      json,
    };
  }

  if (subcommand === 'team') {
    return parseTeamArgs(rest);
  }

  if (subcommand === 'zero-trust') {
    const [action = '', ...args] = rest;
    if (action && !['status', 'protect', 'public', 'reconcile'].includes(action)) {
      throw new Error(
        'project: Usage: void project zero-trust <status|protect|public|reconcile> [--project <slug>].',
      );
    }
    let projectSlug = '';
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--project') {
        const value = args[++index];
        if (!value || value.startsWith('-')) {
          throw new Error('project: --project requires a value.');
        }
        if (projectSlug) {
          throw new Error("project: Duplicate flag '--project'.");
        }
        projectSlug = value;
      } else {
        throw new Error(`project: Unexpected argument '${arg}'.`);
      }
    }
    return {
      subcommand,
      action: action as '' | 'status' | 'protect' | 'public' | 'reconcile',
      projectSlug,
    };
  }

  if (subcommand === 'logs') {
    let filter = '';
    let range = '1h';
    let deployment = '';
    let level = '';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--filter' && rest[i + 1]) {
        filter = rest[++i];
      } else if (rest[i] === '--range' && rest[i + 1]) {
        range = rest[++i];
      } else if (rest[i] === '--deployment' && rest[i + 1]) {
        deployment = rest[++i];
      } else if (rest[i] === '--level' && rest[i + 1]) {
        const value = rest[++i];
        if (!LOG_LEVELS.has(value)) {
          throw new Error(
            `project: Invalid --level '${value}'. Use one of error|warn|info|log|debug|all.`,
          );
        }
        level = value;
      } else {
        throw new Error(`project: Unexpected argument '${rest[i]}'.`);
      }
    }
    return { subcommand, filter, range, deployment, level };
  }

  if (subcommand === 'requests') {
    let status = '';
    let range = '1h';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--status' && rest[i + 1]) {
        const value = rest[++i];
        if (!STATUS_FILTER.test(value)) {
          throw new Error(
            `project: Invalid --status '${value}'. Use a class like 5xx or an exact code like 500.`,
          );
        }
        status = value;
      } else if (rest[i] === '--range' && rest[i + 1]) {
        range = rest[++i];
      } else {
        throw new Error(`project: Unexpected argument '${rest[i]}'.`);
      }
    }
    return { subcommand, status, range };
  }

  if (subcommand === 'rollback') {
    let platform: 'cloudflare' | undefined;
    const positional: Array<string> = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--platform' || arg.startsWith('--platform=')) {
        const value = arg === '--platform' ? rest[++i] : arg.slice('--platform='.length);
        if (value !== 'cloudflare') {
          throw new Error(
            `project: \`rollback --platform\` accepts only 'cloudflare', got '${value ?? ''}'.`,
          );
        }
        platform = 'cloudflare';
      } else {
        positional.push(arg);
      }
    }
    return {
      subcommand,
      deployId: parseOptionalPositional(positional),
      ...(platform ? { platform } : {}),
    };
  }

  if (subcommand === 'cancel') {
    return { subcommand, deployId: parseOptionalPositional(rest) };
  }

  if (subcommand === 'delete') {
    let name = '';
    let force = false;
    for (const arg of rest) {
      if (arg === '--force' || arg === '-f') {
        force = true;
      } else if (arg.startsWith('-')) {
        throw new Error(`project: Unknown flag '${arg}'.`);
      } else if (name) {
        throw new Error(`project: Unexpected argument '${arg}'.`);
      } else {
        name = arg;
      }
    }
    return { subcommand, name, force };
  }

  if (subcommand === 'purge-cache') {
    let projectSlug = '';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--project' && rest[i + 1]) {
        projectSlug = rest[++i];
      } else {
        throw new Error(`project: Unexpected argument '${rest[i]}'.`);
      }
    }
    return { subcommand, projectSlug };
  }

  throw new Error(
    'project: Usage: void project <status|link|list|team|token|zero-trust|logs|requests|rollback|cancel|delete|purge-cache>.',
  );
}

function parseOptionalPositional(rest: Array<string>): string {
  const [value, extra] = rest;
  if (value?.startsWith('-')) {
    throw new Error(`project: Unknown flag '${value}'.`);
  }
  if (extra) {
    throw new Error(`project: Unexpected argument '${extra}'.`);
  }
  return value ?? '';
}

function parseTeamArgs(rest: Array<string>): ProjectArgs {
  const [action, ...args] = rest;
  const usage =
    'project: Usage: void project team <list|invite|invitations|role|remove|revoke|leave|pending|accept|decline>.';
  if (!action) {
    return { subcommand: 'team', action: '' };
  }

  const positionals: Array<string> = [];
  let projectSlug = '';
  let role = '';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--project' || arg === '--role') {
      const value = args[++index];
      if (!value || value.startsWith('-')) {
        throw new Error(`project: ${arg} requires a value.`);
      }
      if (arg === '--project') {
        if (projectSlug) {
          throw new Error("project: Duplicate flag '--project'.");
        }
        projectSlug = value;
      } else {
        if (role) {
          throw new Error("project: Duplicate flag '--role'.");
        }
        role = value;
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`project: Unknown flag '${arg}'.`);
    } else {
      positionals.push(arg);
    }
  }

  if (role && !TEAM_ROLES.has(role)) {
    throw new Error(`project: Invalid role '${role}'. Use one of reader|collaborator|admin.`);
  }
  if (['pending', 'accept', 'decline'].includes(action) && projectSlug) {
    throw new Error(`project: --project is not used with team ${action}.`);
  }

  if (action === 'list' || action === 'invitations' || action === 'leave') {
    if (positionals.length || role) {
      throw new Error(`project: Usage: void project team ${action} [--project <slug>].`);
    }
    return { subcommand: 'team', action, projectSlug };
  }
  if (action === 'invite') {
    if (positionals.length !== 1 || !role) {
      throw new Error(
        'project: Usage: void project team invite <registered-email> --role <reader|collaborator|admin> [--project <slug>].',
      );
    }
    const email = positionals[0]!;
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new Error('project: Invitee must be a registered email address.');
    }
    return { subcommand: 'team', action, email, role: role as TeamRole, projectSlug };
  }
  if (action === 'role') {
    if (positionals.length !== 2 || role) {
      throw new Error(
        'project: Usage: void project team role <user-id> <reader|collaborator|admin> [--project <slug>].',
      );
    }
    const nextRole = positionals[1]!;
    if (!TEAM_ROLES.has(nextRole)) {
      throw new Error(`project: Invalid role '${nextRole}'. Use one of reader|collaborator|admin.`);
    }
    return {
      subcommand: 'team',
      action,
      userId: positionals[0]!,
      role: nextRole as TeamRole,
      projectSlug,
    };
  }
  if (action === 'remove') {
    if (positionals.length !== 1 || role) {
      throw new Error('project: Usage: void project team remove <user-id> [--project <slug>].');
    }
    return { subcommand: 'team', action, userId: positionals[0]!, projectSlug };
  }
  if (action === 'revoke') {
    if (positionals.length !== 1 || role) {
      throw new Error(
        'project: Usage: void project team revoke <invitation-id> [--project <slug>].',
      );
    }
    return { subcommand: 'team', action, invitationId: positionals[0]!, projectSlug };
  }
  if (action === 'pending') {
    if (positionals.length || role) {
      throw new Error('project: Usage: void project team pending.');
    }
    return { subcommand: 'team', action };
  }
  if (action === 'accept' || action === 'decline') {
    if (positionals.length !== 1 || role) {
      throw new Error(`project: Usage: void project team ${action} <invitation-id>.`);
    }
    return { subcommand: 'team', action, invitationId: positionals[0]! };
  }
  throw new Error(usage);
}
