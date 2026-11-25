import type { InstallationResource } from '@void/platform';
import { describe, expect, it, vi } from 'vite-plus/test';
import { hyperdriveOriginFromConnectionString } from '../../src/cli/platform-cloudflare.ts';
import {
  fitPlatformHyperdriveToDatabase,
  platformHyperdriveConnectionLimit,
} from '../../src/cli/platform-hyperdrive-connections.ts';

const resource: InstallationResource = {
  key: 'hyperdrive',
  kind: 'hyperdrive',
  id: 'database',
  name: 'void-platform-db',
  ownership: 'created',
  state: 'ready',
  configHash: 'hash',
};

function fakeClient(originConnectionLimit: number | undefined) {
  return {
    getHyperdriveConfig: vi.fn(async () => ({
      id: resource.id,
      name: resource.name,
      cachingDisabled: true,
      origin: hyperdriveOriginFromConnectionString('postgresql://user:pw@db.example.com/platform'),
      ...(originConnectionLimit === undefined ? {} : { originConnectionLimit }),
    })),
    setHyperdriveOriginConnectionLimit: vi.fn(async () => {}),
  };
}

describe('Hyperdrive origin connection limit', () => {
  it('keeps five slots for direct connections and never goes below the Hyperdrive minimum', () => {
    expect(platformHyperdriveConnectionLimit(22)).toBe(17);
    expect(platformHyperdriveConnectionLimit(97)).toBe(92);
    expect(platformHyperdriveConnectionLimit(8)).toBe(5);
    expect(platformHyperdriveConnectionLimit(0)).toBe(5);
  });

  it('lowers the default limit of a Hyperdrive Void created to fit a small database', async () => {
    // max_connections=25 with 3 superuser slots: the live e2e install had a limit of 60.
    const client = fakeClient(60);
    const onProgress = vi.fn();
    await fitPlatformHyperdriveToDatabase({
      client,
      accountId: 'account',
      resource,
      readConnectionSlots: async () => 22,
      onProgress,
    });
    expect(client.setHyperdriveOriginConnectionLimit).toHaveBeenCalledExactlyOnceWith(
      'account',
      'database',
      17,
    );
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('from 60 to 17'));
  });

  it.each([17, 10])('keeps a limit of %s that already fits', async (limit) => {
    const client = fakeClient(limit);
    await fitPlatformHyperdriveToDatabase({
      client,
      accountId: 'account',
      resource,
      readConnectionSlots: async () => 22,
    });
    expect(client.setHyperdriveOriginConnectionLimit).not.toHaveBeenCalled();
  });

  it('never raises a limit or writes one Cloudflare did not report', async () => {
    const client = fakeClient(undefined);
    await fitPlatformHyperdriveToDatabase({
      client,
      accountId: 'account',
      resource,
      readConnectionSlots: async () => 22,
    });
    expect(client.setHyperdriveOriginConnectionLimit).not.toHaveBeenCalled();
  });

  it('only warns about an adopted Hyperdrive, which its owner manages', async () => {
    const client = fakeClient(60);
    const onProgress = vi.fn();
    await fitPlatformHyperdriveToDatabase({
      client,
      accountId: 'account',
      resource: { ...resource, ownership: 'adopted' },
      readConnectionSlots: async () => 22,
      onProgress,
    });
    expect(client.setHyperdriveOriginConnectionLimit).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Set its origin connection limit to 17 or lower'),
    );
  });

  it('skips the check when the database lock cannot read connection slots', async () => {
    const client = fakeClient(60);
    await fitPlatformHyperdriveToDatabase({
      client,
      accountId: 'account',
      resource,
      readConnectionSlots: undefined,
    });
    expect(client.getHyperdriveConfig).not.toHaveBeenCalled();
    expect(client.setHyperdriveOriginConnectionLimit).not.toHaveBeenCalled();
  });
});
