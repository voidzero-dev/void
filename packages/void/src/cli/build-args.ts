import type { SubcommandDef } from './subcommand-prompt.ts';

export const buildSubcommands: Array<SubcommandDef> = [
  {
    name: 'logs',
    arg: '[build]',
    description: 'Stream, tail, or download logs for a build',
  },
];

export type BuildArgs = {
  subcommand: 'logs';
  buildId?: string;
  follow: boolean;
  output?: string;
  projectName?: string;
};

export function parseBuildArgs(args: Array<string>): BuildArgs {
  const subcommand = args[0];
  const rest = args.slice(1);

  if (subcommand !== 'logs') {
    throw new Error(
      'build: Usage: void build logs [build] [--follow] [--output <file>] [--project <slug>].',
    );
  }

  let buildId: string | undefined;
  let follow = false;
  let output: string | undefined;
  let projectName: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '-f' || arg === '--follow') {
      follow = true;
    } else if (arg === '-o' || arg === '--output') {
      if (i + 1 >= rest.length) {
        throw new Error('build: --output requires a value.');
      }
      const value = rest[++i];
      if (value.trim() === '') {
        throw new Error('build: --output requires a value.');
      }
      output = value;
    } else if (arg === '-p' || arg === '--project') {
      if (i + 1 >= rest.length) {
        throw new Error('build: --project requires a value.');
      }
      const value = rest[++i];
      if (value.trim() === '') {
        throw new Error('build: --project requires a value.');
      }
      projectName = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`build: Unexpected argument '${arg}'.`);
    } else if (buildId) {
      throw new Error(`build: Unexpected argument '${arg}'.`);
    } else {
      buildId = arg;
    }
  }

  return { subcommand, buildId, follow, output, projectName };
}
