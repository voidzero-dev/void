import type { SubcommandDef } from './subcommand-prompt.ts';

export const domainSubcommands: Array<SubcommandDef> = [
  { name: 'add', arg: '<hostname>', description: 'Add a custom domain' },
  { name: 'delete', arg: '<hostname>', description: 'Remove a custom domain' },
  { name: 'list', description: 'List custom domains + status' },
  { name: 'status', arg: '<hostname>', description: 'Check domain verification status' },
];

export type DomainArgs = { projectSlug?: string; verbose?: boolean } & (
  | { subcommand: 'list'; hostname?: string }
  | { subcommand: 'add' | 'delete' | 'status'; hostname: string }
);

export function parseDomainArgs(args: Array<string>): DomainArgs {
  const subcommand = args[0] as DomainArgs['subcommand'];
  if (!subcommand || !['add', 'delete', 'list', 'status'].includes(subcommand)) {
    throw new Error(
      'domain: Usage: void domain <add|delete|list|status> [hostname] [--project <name>].',
    );
  }

  let hostname: string | undefined;
  let projectSlug: string | undefined;
  let verbose = false;

  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--project' && rest[i + 1]) {
      projectSlug = rest[++i];
    } else if (rest[i] === '--verbose') {
      verbose = true;
    } else if (rest[i].startsWith('-')) {
      throw new Error(`domain: Unknown flag '${rest[i]}'.`);
    } else if (!hostname) {
      hostname = rest[i];
    }
  }

  if (subcommand === 'list') {
    return { subcommand, hostname, projectSlug, verbose };
  }
  if (!hostname) {
    throw new Error(`domain: Usage: void domain ${subcommand} <hostname> [--project <name>].`);
  }

  return { subcommand, hostname, projectSlug, verbose };
}
