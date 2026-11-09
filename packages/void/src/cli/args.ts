import { parseArgs } from 'node:util';
import type { RunDeployOptions } from './deploy-types.ts';

export function parseDeployArgs(
  args: Array<string>,
): Omit<RunDeployOptions, 'reuseExistingWorker'> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        project: { type: 'string' },
        dir: { type: 'string' },
        spa: { type: 'boolean' },
        'skip-build': { type: 'boolean' },
        'skip-migrations': { type: 'boolean' },
        debug: { type: 'boolean' },
        platform: { type: 'string' },
        provision: { type: 'boolean' },
        'require-email': { type: 'boolean' },
        atomic: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('argument missing') || message.includes('argument is ambiguous')) {
      const optionMatch = message.match(/Option '(--[a-z-]+)/);
      if (optionMatch?.[1] === '--platform') {
        throw new Error("deploy: --platform requires a value ('cloudflare' or 'void').");
      }
      throw new Error('deploy: --project requires a slug.');
    }

    const unknownOptionMatch = message.match(/Unknown option '([^']+)'/);
    if (unknownOptionMatch) {
      throw new Error(`deploy: Unknown option '${unknownOptionMatch[1]}'.`);
    }

    throw new Error(`deploy: ${message}.`);
  }

  const tokens = parsed.tokens ?? [];
  const projectTokens = tokens.filter(
    (token) => token.kind === 'option' && token.name === 'project',
  );
  if (projectTokens.length > 1) {
    throw new Error('deploy: --project can only be specified once.');
  }

  const platformTokens = tokens.filter(
    (token) => token.kind === 'option' && token.name === 'platform',
  );
  if (platformTokens.length > 1) {
    throw new Error('deploy: --platform can only be specified once.');
  }

  if (parsed.positionals.length > 0) {
    throw new Error(`deploy: Unexpected argument '${parsed.positionals[0]}'.`);
  }

  const projectValue = parsed.values.project;
  const projectSlug = typeof projectValue === 'string' ? projectValue : undefined;
  if (typeof projectSlug === 'string' && projectSlug.startsWith('-')) {
    throw new Error('deploy: --project requires a slug.');
  }

  const dir = typeof parsed.values.dir === 'string' ? parsed.values.dir : undefined;
  const spa = parsed.values.spa === true ? true : undefined;
  const skipBuild = parsed.values['skip-build'] === true ? true : undefined;
  const debug = parsed.values.debug === true ? true : undefined;

  const platformValue =
    typeof parsed.values.platform === 'string' ? parsed.values.platform : undefined;
  if (platformValue !== undefined && platformValue !== 'cloudflare' && platformValue !== 'void') {
    throw new Error("deploy: --platform must be 'cloudflare' or 'void'.");
  }
  const platform = platformValue;

  const provision = parsed.values.provision === true ? true : undefined;
  if (provision && platform !== 'cloudflare') {
    throw new Error('deploy: --provision requires --platform cloudflare.');
  }

  // Native Cloudflare email: fail the deploy — before any upload — instead of
  // continuing without email when the domain is not set up and nobody can press Enter
  // (CI / non-TTY). Only the Cloudflare backend runs the email step.
  const requireEmail = parsed.values['require-email'] === true ? true : undefined;
  const atomic = parsed.values.atomic === true ? true : undefined;
  if (requireEmail && platform !== 'cloudflare') {
    throw new Error('deploy: --require-email requires --platform cloudflare.');
  }

  // The Cloudflare backend deploys to the user's OWN account and therefore never
  // resolves a Void project. Static flags are target-neutral: both backends honor
  // `--dir` and `--spa` through their respective static deployment adapters.
  if (platform === 'cloudflare') {
    if (projectSlug !== undefined) {
      throw new Error(
        'deploy: --project is not supported with --platform cloudflare — this platform deploys ' +
          'to your own Cloudflare account and no Void project is involved.',
      );
    }
  }

  return {
    projectSlug,
    dir,
    spa,
    skipBuild,
    skipMigrations: parsed.values['skip-migrations'] === true ? true : undefined,
    debug,
    platform,
    provision,
    requireEmail,
    atomic,
  };
}
