import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PlatformClient } from '../../src/cli/client.ts';
import { emailAllow } from '../../src/cli/email.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as output from '../../src/cli/output.ts';

/**
 * What `void email allow <address>` prints for each shape the api answers
 * with. The one contract under test: "Verification email sent" is printed
 * ONLY when a link actually went out. Cloudflare mails its link on create
 * only, and a 201 does not prove a create — the api adopts an address
 * Cloudflare already held pending (the owner's own, from another project or
 * a hand add), and answers that with `verificationSent: false`.
 */

type AllowResponse = Awaited<ReturnType<PlatformClient['addEmailDestination']>> & {
  verificationSent?: boolean;
};

const ADDRESS = 'owner@example.com';

function response(overrides: Partial<AllowResponse>): AllowResponse {
  return {
    id: 'edst_1',
    address: ADDRESS,
    status: 'pending',
    verified_at: null,
    created_at: '2026-09-14T00:00:00Z',
    created: false,
    ...overrides,
  };
}

function client(body: AllowResponse): Pick<PlatformClient, 'addEmailDestination'> {
  return { addEmailDestination: vi.fn(async () => body) };
}

type LogSpy = ReturnType<typeof vi.spyOn>;

let successSpy: LogSpy;
let infoSpy: LogSpy;
let warnSpy: LogSpy;

beforeEach(() => {
  successSpy = vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function printed(spy: LogSpy): string {
  return (spy.mock.calls as Array<Array<unknown>>).map((call) => String(call[0])).join('\n');
}

describe('void email allow', () => {
  it('reports a send when Cloudflare registered the address just now (201)', async () => {
    await emailAllow(client(response({ created: true })), 'prj_1', ADDRESS);

    expect(printed(successSpy)).toBe(`Verification email sent to ${ADDRESS}.`);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reports a send when the platform mailed its own link (first add and repeat)', async () => {
    await emailAllow(
      client(response({ created: true, platformVerificationPending: true })),
      'prj_1',
      ADDRESS,
    );
    await emailAllow(
      client(response({ created: false, platformVerificationPending: true })),
      'prj_1',
      ADDRESS,
    );

    expect(successSpy).toHaveBeenCalledTimes(2);
    expect(printed(successSpy)).not.toContain('already verified');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT claim a send when Cloudflare already held the address pending', async () => {
    // The api created the project's row (201) but Cloudflare refused the
    // create: the only link the owner has is the one from the first add.
    await emailAllow(
      client(response({ created: true, verificationSent: false })),
      'prj_1',
      ADDRESS,
    );

    expect(successSpy).not.toHaveBeenCalled();
    const text = printed(warnSpy);
    expect(text).toContain('no new verification email was sent');
    expect(text).toContain(`void email disallow ${ADDRESS}`);
    expect(text).toContain('every project that lists it');
  });

  it('does NOT claim a send on a repeat add of a Cloudflare-pending address', async () => {
    // With and without the marker: an api that predates `verificationSent`
    // answers the repeat with a bare 200, and that already means "nothing sent".
    await emailAllow(client(response({ created: false })), 'prj_1', ADDRESS);
    await emailAllow(
      client(response({ created: false, verificationSent: false })),
      'prj_1',
      ADDRESS,
    );

    expect(successSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(2);
    for (const call of infoSpy.mock.calls as Array<Array<unknown>>) {
      expect(String(call[0])).toContain('a repeat add sends nothing new');
      expect(String(call[0])).toContain(`void email disallow ${ADDRESS}`);
    }
  });

  it('reports an already-verified address as such', async () => {
    await emailAllow(
      client(response({ status: 'verified', verified_at: '2026-09-01T00:00:00Z' })),
      'prj_1',
      ADDRESS,
    );

    expect(printed(infoSpy)).toBe(`${ADDRESS} is already verified.`);
    expect(successSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
