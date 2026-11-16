import { describe, expect, it } from 'vite-plus/test';
import { parseDeployArgs } from '../../src/cli/args.ts';

describe('parseDeployArgs', () => {
  it('parses explicit atomic Cloudflare deployment', () => {
    expect(parseDeployArgs(['--platform', 'cloudflare', '--atomic']).atomic).toBe(true);
  });
  it('parses --project slug', () => {
    expect(parseDeployArgs(['--project', 'my-app'])).toEqual({
      projectSlug: 'my-app',
      dir: undefined,
      spa: undefined,
      skipBuild: undefined,
      debug: undefined,
    });
  });

  it('returns empty args when no options are provided', () => {
    expect(parseDeployArgs([])).toEqual({
      projectSlug: undefined,
      dir: undefined,
      spa: undefined,
      skipBuild: undefined,
      debug: undefined,
    });
  });

  it('parses --debug flag', () => {
    const result = parseDeployArgs(['--debug']);
    expect(result.debug).toBe(true);
  });

  it('parses --dir flag', () => {
    const result = parseDeployArgs(['--dir', 'public']);
    expect(result.dir).toBe('public');
  });

  it('parses --spa flag', () => {
    const result = parseDeployArgs(['--spa']);
    expect(result.spa).toBe(true);
  });

  it('parses --skip-build flag', () => {
    const result = parseDeployArgs(['--skip-build']);
    expect(result.skipBuild).toBe(true);
  });

  it('parses all flags together', () => {
    const result = parseDeployArgs([
      '--project',
      'my-app',
      '--dir',
      'dist',
      '--spa',
      '--skip-build',
    ]);
    expect(result.projectSlug).toBe('my-app');
    expect(result.dir).toBe('dist');
    expect(result.spa).toBe(true);
    expect(result.skipBuild).toBe(true);
  });

  it('throws when --project has no value', () => {
    expect(() => parseDeployArgs(['--project'])).toThrow('deploy: --project requires a slug.');
  });

  it('throws when --project value looks like another flag', () => {
    expect(() => parseDeployArgs(['--project', '--foo'])).toThrow(
      'deploy: --project requires a slug.',
    );
  });

  it('throws for duplicate --project flags', () => {
    expect(() => parseDeployArgs(['--project', 'a', '--project', 'b'])).toThrow(
      'deploy: --project can only be specified once.',
    );
  });

  it('throws for unknown options', () => {
    expect(() => parseDeployArgs(['--foo'])).toThrow("deploy: Unknown option '--foo'.");
  });

  it('throws for unexpected positional arguments', () => {
    expect(() => parseDeployArgs(['my-app'])).toThrow("deploy: Unexpected argument 'my-app'.");
  });

  it.each([['--platform', 'cloudflare'], ['--platform=cloudflare']])(
    'parses Cloudflare selection %j',
    (...args) => {
      expect(parseDeployArgs(args).platform).toBe('cloudflare');
    },
  );

  it('parses --platform void', () => {
    expect(parseDeployArgs(['--platform', 'void']).platform).toBe('void');
  });

  it('rejects an unsupported or missing platform', () => {
    expect(() => parseDeployArgs(['--platform', 'other'])).toThrow(
      "deploy: --platform must be 'cloudflare' or 'void'.",
    );
    expect(() => parseDeployArgs(['--platform'])).toThrow(
      "deploy: --platform requires a value ('cloudflare' or 'void').",
    );
  });

  it('rejects duplicate platforms even if the final value is valid', () => {
    expect(() => parseDeployArgs(['--platform', 'other', '--platform=cloudflare'])).toThrow(
      'deploy: --platform can only be specified once.',
    );
  });

  it.each([['--backend'], ['--backend', 'cloudflare'], ['--backend=cloudflare']])(
    'rejects the removed alias %j',
    (...args) => {
      expect(() => parseDeployArgs(args)).toThrow("deploy: Unknown option '--backend'.");
    },
  );

  it('accepts the existing provisioning flag on Cloudflare', () => {
    expect(parseDeployArgs(['--platform', 'cloudflare', '--provision']).provision).toBe(true);
    expect(() => parseDeployArgs(['--provision'])).toThrow(
      'deploy: --provision requires --platform cloudflare.',
    );
    expect(() => parseDeployArgs(['--platform', 'void', '--provision'])).toThrow(
      'deploy: --provision requires --platform cloudflare.',
    );
  });

  it('parses --require-email only on Cloudflare', () => {
    expect(parseDeployArgs(['--platform', 'cloudflare', '--require-email']).requireEmail).toBe(
      true,
    );
    expect(parseDeployArgs(['--platform', 'cloudflare']).requireEmail).toBeUndefined();
    expect(() => parseDeployArgs(['--require-email'])).toThrow(
      'deploy: --require-email requires --platform cloudflare.',
    );
    expect(() => parseDeployArgs(['--platform', 'void', '--require-email'])).toThrow(
      'deploy: --require-email requires --platform cloudflare.',
    );
  });

  it('explains that Cloudflare resolves no Void project', () => {
    expect(() => parseDeployArgs(['--platform', 'cloudflare', '--project', 'foo'])).toThrow(
      /--project is not supported with --platform cloudflare.*no Void project is involved/,
    );
  });

  it('parses static-directory, SPA and skip-build flags on Cloudflare', () => {
    expect(
      parseDeployArgs(['--platform', 'cloudflare', '--dir', 'dist', '--spa', '--skip-build']),
    ).toMatchObject({
      platform: 'cloudflare',
      dir: 'dist',
      spa: true,
      skipBuild: true,
    });
  });
});

describe('parseDeployArgs --preview', () => {
  it('parses a Cloudflare preview with JSON output', () => {
    expect(
      parseDeployArgs(['--platform', 'cloudflare', '--skip-build', '--preview', 'pr-64', '--json']),
    ).toMatchObject({ platform: 'cloudflare', skipBuild: true, preview: 'pr-64', json: true });
  });

  it('requires --platform cloudflare and a name', () => {
    expect(() => parseDeployArgs(['--preview', 'pr-64'])).toThrow(
      '--preview requires --platform cloudflare',
    );
    expect(() => parseDeployArgs(['--platform', 'void', '--preview', 'pr-64'])).toThrow(
      '--preview requires --platform cloudflare',
    );
    expect(() => parseDeployArgs(['--platform', 'cloudflare', '--preview'])).toThrow(
      '--preview requires a name',
    );
    expect(() =>
      parseDeployArgs(['--platform', 'cloudflare', '--preview', 'a', '--preview', 'b']),
    ).toThrow('only be specified once');
  });

  it.each(['--atomic', '--provision', '--require-email'])('rejects %s with --preview', (flag) => {
    expect(() => parseDeployArgs(['--platform', 'cloudflare', '--preview', 'pr-64', flag])).toThrow(
      `${flag} cannot be combined with --preview`,
    );
  });

  it('accepts --json only with --preview', () => {
    expect(() => parseDeployArgs(['--platform', 'cloudflare', '--json'])).toThrow(
      '--json is available only with --preview',
    );
  });
});
