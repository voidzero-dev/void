import type { SubcommandDef } from './subcommand-prompt.ts';

export const previewSubcommands: Array<SubcommandDef> = [
  {
    name: 'delete',
    hint: '<name>',
    description: 'Delete a Cloudflare Preview and all its deployments',
  },
];

export type PreviewArgs = { subcommand: 'delete'; name: string };

export function parsePreviewArgs(args: Array<string>): PreviewArgs {
  const [subcommand, name, extra] = args;
  if (subcommand !== 'delete') {
    throw new Error('preview: Usage: void preview delete <name>.');
  }
  if (!name || name.startsWith('-')) {
    throw new Error('preview: delete requires a preview name (for example pr-64).');
  }
  if (extra) {
    throw new Error(`preview: Unexpected argument '${extra}'.`);
  }
  return { subcommand, name };
}
