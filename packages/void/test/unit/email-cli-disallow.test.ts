import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PlatformClient } from '../../src/cli/client.ts';
import { emailDisallow } from '../../src/cli/email.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as output from '../../src/cli/output.ts';

type Destination = Awaited<ReturnType<PlatformClient['listEmailDestinations']>>[number];

const ADDRESS = 'owner@example.com';

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'edst_1',
    address: ADDRESS,
    status: 'verified',
    verified_at: '2026-09-01T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function client(
  rows: Array<Destination>,
): Pick<PlatformClient, 'listEmailDestinations' | 'removeEmailDestination'> {
  return {
    listEmailDestinations: vi.fn(async () => rows),
    removeEmailDestination: vi.fn(async () => ({ ok: true })),
  };
}

type LogSpy = ReturnType<typeof vi.spyOn>;

let successSpy: LogSpy;

beforeEach(() => {
  successSpy = vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function printed(spy: LogSpy): string {
  return (spy.mock.calls as Array<Array<unknown>>).map((call) => String(call[0])).join('\n');
}

describe('void email disallow', () => {
  it('removes the matching destination and reports the revocation without a deploy', async () => {
    const c = client([destination()]);

    await emailDisallow(c, 'prj_1', ADDRESS);

    expect(c.removeEmailDestination).toHaveBeenCalledWith('prj_1', 'edst_1');
    const text = printed(successSpy);
    expect(text).toBe(
      `Removed ${ADDRESS}. New sends to it are refused immediately; already admitted attempts may finish.`,
    );
    expect(text).not.toMatch(/deploy/);
  });

  it('matches the address case-insensitively and echoes the stored spelling', async () => {
    const c = client([destination({ address: 'Owner@Example.com' })]);

    await emailDisallow(c, 'prj_1', ADDRESS);

    expect(c.removeEmailDestination).toHaveBeenCalledWith('prj_1', 'edst_1');
    expect(printed(successSpy)).toContain('Removed Owner@Example.com.');
  });
});
