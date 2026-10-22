import { confirm, log, note } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type {
  EmailAliasResponse,
  EmailSettingsResponse,
  PlatformClient,
} from '../../src/cli/client.ts';
import { emailAlias } from '../../src/cli/email.ts';
import * as output from '../../src/cli/output.ts';

/**
 * `void email alias [name]`. Without a name it shows the shared mail address;
 * with one it sets a permanent alias, which needs `--yes` or a confirmed prompt.
 */

/** What the mocked `confirm` returns for Ctrl-C; the mocked `isCancel` knows only this. */
const CANCEL = Symbol('cancel');

vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return {
    ...actual,
    note: vi.fn(),
    confirm: vi.fn(),
    isCancel: (value: unknown) => value === CANCEL,
  };
});

const DOMAIN = 'mail.void.test';

function settings(overrides: Partial<EmailSettingsResponse> = {}): EmailSettingsResponse {
  return {
    domains: { management: 'self-serve', projectSlug: 'my-long-project' },
    emailAlias: null,
    sharedInbound: {
      recipient: `my-long-project@${DOMAIN}`,
      status: 'ready',
      reason: null,
      observedAt: null,
    },
    ...overrides,
  };
}

function aliasResponse(overrides: Partial<EmailAliasResponse> = {}): EmailAliasResponse {
  return {
    emailAlias: 'short',
    address: `short@${DOMAIN}`,
    sharedInbound: {
      recipient: `short@${DOMAIN}`,
      status: 'ready',
      reason: null,
      observedAt: null,
    },
    ...overrides,
  };
}

function client(
  body: EmailSettingsResponse = settings(),
  result: EmailAliasResponse = aliasResponse(),
): Pick<PlatformClient, 'getEmailSettings' | 'setEmailAlias'> {
  return {
    getEmailSettings: vi.fn(async () => body),
    setEmailAlias: vi.fn(async () => result),
  };
}

type LogSpy = ReturnType<typeof vi.spyOn>;

let successSpy: LogSpy;
let infoSpy: LogSpy;
let errorSpy: LogSpy;

beforeEach(() => {
  successSpy = vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
  errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
  vi.mocked(note).mockClear();
  vi.mocked(confirm).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function printed(spy: LogSpy): string {
  return (spy.mock.calls as Array<Array<unknown>>).map((call) => String(call[0])).join('\n');
}

function notedBlocks(): string {
  return vi
    .mocked(note)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

describe('void email alias (no name)', () => {
  it('shows the alias address and the slug address that keeps working', async () => {
    const api = client(
      settings({
        emailAlias: 'short',
        sharedInbound: {
          recipient: `short@${DOMAIN}`,
          status: 'ready',
          reason: null,
          observedAt: null,
        },
      }),
    );

    await emailAlias(api, 'prj_1', undefined);

    const block = notedBlocks();
    expect(block).toContain(`Address:  short@${DOMAIN}`);
    expect(block).toContain('Inbound:  ready');
    expect(block).toContain(`Also:     my-long-project@${DOMAIN} (the project slug)`);
    expect(printed(infoSpy)).not.toContain('void email alias <name>');
    expect(api.setEmailAlias).not.toHaveBeenCalled();
  });

  it('shows the alias as the address when the slug row is the one not ready', async () => {
    const api = client(
      settings({
        emailAlias: 'short',
        sharedInbound: {
          recipient: `my-long-project@${DOMAIN}`,
          status: 'pending',
          reason: 'no email handler deployed',
          observedAt: null,
        },
      }),
    );

    await emailAlias(api, 'prj_1', undefined);

    const block = notedBlocks();
    expect(block).toContain(`Address:  short@${DOMAIN}`);
    expect(block).toContain(`Inbound:  pending (my-long-project@${DOMAIN})`);
    expect(block).toContain(`Also:     my-long-project@${DOMAIN} (the project slug)`);
  });

  it('shows the slug address and hints at an alias when none is set', async () => {
    const api = client();

    await emailAlias(api, 'prj_1', undefined, { yes: true });

    const block = notedBlocks();
    expect(block).toContain(`Address:  my-long-project@${DOMAIN}`);
    expect(block).not.toContain('Also:');
    expect(printed(infoSpy)).toContain('Run `void email alias <name>`');
    // `--yes` without a name has nothing to set.
    expect(api.setEmailAlias).not.toHaveBeenCalled();
  });

  it('says so when the platform has no shared mail domain', async () => {
    const api = client(settings({ sharedDomain: null, sharedInbound: null }));

    await emailAlias(api, 'prj_1', undefined);

    expect(printed(infoSpy)).toBe('This platform has no shared mail domain.');
    expect(note).not.toHaveBeenCalled();
  });

  it('shows the alias on a platform that sends from the shared domain but has no inbound route', async () => {
    const api = client(
      settings({ emailAlias: 'short', sharedDomain: DOMAIN, sharedInbound: null }),
    );

    await emailAlias(api, 'prj_1', undefined);

    const block = notedBlocks();
    expect(block).toContain(`Address:  short@${DOMAIN}`);
    expect(block).toContain('Inbound:  not set up on this platform');
    expect(block).toContain(`Also:     my-long-project@${DOMAIN} (the project slug)`);
  });
});

describe('void email alias <name>', () => {
  it('sets the alias with --yes without asking, and prints the address', async () => {
    const api = client();

    await emailAlias(api, 'prj_1', 'short', { yes: true });

    expect(confirm).not.toHaveBeenCalled();
    expect(api.setEmailAlias).toHaveBeenCalledWith('prj_1', 'short');
    expect(printed(successSpy)).toBe(`Email alias set: short@${DOMAIN}`);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('says when inbound mail at the new alias is not ready yet', async () => {
    const api = client(
      settings(),
      aliasResponse({
        sharedInbound: {
          recipient: `short@${DOMAIN}`,
          status: 'pending',
          reason: 'no email handler deployed',
          observedAt: null,
        },
      }),
    );

    await emailAlias(api, 'prj_1', 'short', { yes: true });

    expect(printed(successSpy)).toBe(`Email alias set: short@${DOMAIN}`);
    const text = printed(infoSpy);
    expect(text).toContain('Inbound mail is pending: no email handler deployed.');
    expect(text).toContain('`void email alias`');
  });

  it('names the slug address when its rule is the one not ready after setting the alias', async () => {
    const api = client(
      settings(),
      aliasResponse({
        sharedInbound: {
          recipient: `my-long-project@${DOMAIN}`,
          status: 'blocked',
          reason: 'an unrelated rule conflicts',
          observedAt: null,
        },
      }),
    );

    await emailAlias(api, 'prj_1', 'short', { yes: true });

    expect(printed(infoSpy)).toContain(
      `Inbound mail at my-long-project@${DOMAIN} is blocked: an unrelated rule conflicts.`,
    );
  });

  it('exits 1 without a prompt or a request when not interactive and --yes is missing', async () => {
    const api = client();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(
      emailAlias(api, 'prj_1', 'short', { yes: false, isInteractive: false }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(printed(errorSpy)).toContain('Pass --yes');
    expect(confirm).not.toHaveBeenCalled();
    expect(api.setEmailAlias).not.toHaveBeenCalled();
  });

  it('does not set the alias when the prompt is declined', async () => {
    const api = client();
    vi.mocked(confirm).mockResolvedValue(false);

    await emailAlias(api, 'prj_1', 'short', { yes: false, isInteractive: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(confirm).mock.calls[0]![0];
    expect(prompt.message).toContain('"short"');
    expect(prompt.message).toContain('cannot be changed');
    expect(prompt.initialValue).toBe(false);
    expect(api.setEmailAlias).not.toHaveBeenCalled();
    expect(printed(infoSpy)).toBe('Cancelled. No alias was set.');
  });

  it('does not set the alias when the prompt is cancelled', async () => {
    const api = client();
    vi.mocked(confirm).mockResolvedValue(CANCEL as never);

    await emailAlias(api, 'prj_1', 'short', { yes: false, isInteractive: true });

    expect(api.setEmailAlias).not.toHaveBeenCalled();
    expect(printed(infoSpy)).toBe('Cancelled. No alias was set.');
  });

  it('sets the alias when the prompt is accepted', async () => {
    const api = client();
    vi.mocked(confirm).mockResolvedValue(true);

    await emailAlias(api, 'prj_1', 'short', { yes: false, isInteractive: true });

    expect(api.setEmailAlias).toHaveBeenCalledWith('prj_1', 'short');
    expect(printed(successSpy)).toBe(`Email alias set: short@${DOMAIN}`);
  });
});
