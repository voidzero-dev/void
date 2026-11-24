import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { prepareContainerImage } from '../../src/provisioning/containers.ts';

const image = 'registry.cloudflare.com/account/sandbox@sha256:' + 'a'.repeat(64);
const response = (status: string, returnedImage = image) =>
  Response.json({ success: true, result: { image: returnedImage, status } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('managed Container image preparation', () => {
  it('waits for a pending custom image to become ready', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response('pending'))
      .mockResolvedValue(response('ready'));
    vi.stubGlobal('fetch', fetch);
    const result = prepareContainerImage('account', 'token', image);
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account/containers/image-preparations',
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ image });
  });

  it.each(['error', 'unknown'])('rejects a %s result', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status)));
    await expect(prepareContainerImage('account', 'token', image)).rejects.toThrow(
      'preparation failed',
    );
  });

  it('rejects preparation of a different image', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('ready', 'another-image')));
    await expect(prepareContainerImage('account', 'token', image)).rejects.toThrow('another image');
  });

  it('bounds an image that remains pending', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => response('pending')),
    );
    const result = expect(prepareContainerImage('account', 'token', image)).rejects.toThrow(
      'timed out',
    );
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await result;
  });

  it('does not probe Cloudflare for its built-in base image', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await prepareContainerImage('account', 'token', 'cloudflare/debian-trixie');
    expect(fetch).not.toHaveBeenCalled();
  });
});
