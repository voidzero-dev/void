import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  deleteSecurityScannerImages,
  digestTag,
  ensureSecurityScannerImage,
  scannerImageRef,
} from '../../src/provisioning/security-scanner-images.ts';
import {
  parseSecurityScannerImagePins,
  securityScannerImagePins,
  type SecurityScannerImagePin,
} from '../../src/security/scanner-images.ts';
import { createFakeRegistry, fakeImage } from '../__mocks__/image-registry.ts';

// Copying the digest-pinned Engine A/C image into the operator's registry (design doc
// 0095 M13b, spike S1b option A), against fake ghcr.io and registry.cloudflare.com.

const TARGET = { accountId: 'acct', apiToken: 'token' };
const REPO = 'void-security-scanner-engine-a-0123456789ab';
const pin = (digest: string | null): SecurityScannerImagePin => ({
  engine: 'agent_sdk',
  repository: 'ghcr.io/voidzero-dev/void-security-scanner-engine-a',
  digest,
});
const later = () => Date.now() + 60_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

function install(registry: ReturnType<typeof createFakeRegistry>) {
  vi.stubGlobal('fetch', registry.fetch());
}

describe('scanner image pins', () => {
  it('ships a ghcr.io repository per engine, with no digest until a release publishes one', () => {
    expect(securityScannerImagePins()).toEqual([
      expect.objectContaining({
        engine: 'agent_sdk',
        repository: expect.stringMatching(/^ghcr\.io\//),
      }),
      expect.objectContaining({
        engine: 'codex_sdk',
        repository: expect.stringMatching(/^ghcr\.io\//),
      }),
    ]);
    for (const entry of securityScannerImagePins()) {
      expect(entry.repository).not.toMatch(/claude|codex|gpt/i);
    }
  });

  it('refuses a malformed pin instead of reading it as unpublished', () => {
    const good = { repository: 'ghcr.io/voidzero-dev/a', digest: null };
    expect(() =>
      parseSecurityScannerImagePins({ agent_sdk: good, codex_sdk: { ...good, digest: 'latest' } }),
    ).toThrow('digest must be');
    expect(() =>
      parseSecurityScannerImagePins({
        agent_sdk: { ...good, repository: 'docker.io/library/node' },
        codex_sdk: good,
      }),
    ).toThrow('ghcr.io repository');
  });
});

describe('ensureSecurityScannerImage', () => {
  it('reports an engine the release has no image for, with no call', async () => {
    const registry = createFakeRegistry();
    install(registry);
    expect(
      await ensureSecurityScannerImage(TARGET, pin(null), REPO, { deadline: later() }),
    ).toEqual({
      ok: false,
      step: 'unpublished',
      detail: 'This platform release has no scanner image for this engine.',
    });
    expect(registry.calls).toEqual([]);
  });

  it('copies config, layers and the pinned manifest, then prepares the copy by digest', async () => {
    const image = fakeImage({ layers: 3 });
    const registry = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-a': image },
    });
    install(registry);
    const result = await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, {
      deadline: later(),
    });
    const ref = scannerImageRef('acct', REPO, image.digest);
    expect(ref).toBe(`registry.cloudflare.com/acct/${REPO}@${image.digest}`);
    expect(result).toEqual({ ok: true, ref, copied: true });
    expect(registry.hasManifest(`acct/${REPO}`, image.digest)).toBe(true);
    expect(registry.repos.get(`acct/${REPO}`)?.tags.get(digestTag(image.digest))).toBe(
      image.digest,
    );
    for (const digest of [image.config, ...image.layers]) {
      expect(registry.blobs.has(digest)).toBe(true);
    }
    expect(registry.prepared).toEqual([ref]);
    // Short-lived credentials with push, pull only; the source is read anonymously.
    expect(registry.calls[0]).toBe('POST credentials');
  });

  it('skips the copy when the account already holds the digest', async () => {
    const image = fakeImage();
    const registry = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-a': image },
    });
    install(registry);
    await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, { deadline: later() });
    registry.calls.length = 0;
    const again = await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, {
      deadline: later(),
    });
    expect(again).toMatchObject({ ok: true, copied: false });
    expect(registry.calls.filter((call) => call.includes('ghcr'))).toEqual([]);
    expect(registry.calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
  });

  it('stops at the deadline and goes on from the copied layers next time', async () => {
    const image = fakeImage({ layers: 3 });
    let clock = 0;
    const now = () => clock;
    const registry = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-a': image },
      // The deadline passes while the first layer uploads.
      onUpload: (digest) => {
        if (digest === image.layers[0]) {
          clock = 2;
        }
        return undefined;
      },
    });
    install(registry);
    const first = await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, {
      deadline: 1,
      now,
    });
    expect(first).toMatchObject({ ok: false, step: 'pending' });
    expect(registry.blobs.has(image.layers[0]!)).toBe(true);
    expect(registry.blobs.has(image.layers[1]!)).toBe(false);
    expect(registry.hasManifest(`acct/${REPO}`, image.digest)).toBe(false);

    registry.calls.length = 0;
    clock = 0;
    const second = await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, {
      deadline: 100,
      now,
    });
    expect(second).toMatchObject({ ok: true, copied: true });
    // The first layer is not read again.
    expect(registry.calls).not.toContain(
      `GET ghcr/v2/voidzero-dev/void-security-scanner-engine-a/blobs/${image.layers[0]}`,
    );
  });

  it('cuts off a layer still in flight at the deadline instead of waiting for it', async () => {
    const image = fakeImage({ layers: 2 });
    const registry = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-a': image },
    });
    const next = registry.fetch();
    // ghcr.io never finishes sending the second layer.
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith(`/blobs/${image.layers[1]}`)
        ? new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
        : next(input, init),
    );
    const started = Date.now();
    const result = await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, {
      deadline: Date.now() + 200,
    });
    expect(result).toMatchObject({ ok: false, step: 'pending' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(registry.blobs.has(image.layers[0]!)).toBe(true);
  });

  it('refuses a manifest that does not match the pin, an index and a non-amd64 image', async () => {
    const image = fakeImage();
    const other = fakeImage({ layers: 1 });
    for (const [published, pinned, detail] of [
      [{ ...image, digest: other.digest }, other.digest, 'does not match its digest'],
      [fakeImage({ index: true }), undefined, 'is an index'],
      [fakeImage({ architecture: 'arm64' }), undefined, 'not linux/amd64'],
    ] as const) {
      const registry = createFakeRegistry({
        published: { 'voidzero-dev/void-security-scanner-engine-a': published },
      });
      install(registry);
      const result = await ensureSecurityScannerImage(
        TARGET,
        pin(pinned ?? published.digest),
        REPO,
        { deadline: later() },
      );
      expect(result).toMatchObject({ ok: false, step: 'source' });
      expect(result.ok ? '' : result.detail).toContain(detail);
      expect(registry.prepared).toEqual([]);
    }
  });

  it('names the token permission when registry credentials are refused', async () => {
    const image = fakeImage();
    const registry = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-a': image },
      credentialsStatus: 403,
    });
    install(registry);
    const result = await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, {
      deadline: later(),
    });
    expect(result).toMatchObject({ ok: false, step: 'credentials' });
    expect(result.ok ? '' : result.detail).toContain('Containers → Edit');
  });

  it('reports a refused layer upload and an image still being prepared', async () => {
    const image = fakeImage();
    const refused = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-a': image },
      onUpload: (digest) => (digest === image.layers[1] ? 500 : undefined),
    });
    install(refused);
    expect(
      await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, { deadline: later() }),
    ).toMatchObject({ ok: false, step: 'copy' });

    const pending = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-a': image },
      prepare: () => 'pending',
    });
    install(pending);
    expect(
      await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, {
        deadline: Date.now() + 1_000,
      }),
    ).toMatchObject({ ok: false, step: 'pending' });
  });
});

describe('deleteSecurityScannerImages', () => {
  it('deletes every copied manifest, runs layer cleanup, and skips a missing repository', async () => {
    const image = fakeImage();
    const registry = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-a': image },
    });
    install(registry);
    await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, { deadline: later() });
    const deleted = await deleteSecurityScannerImages(TARGET, [REPO, 'never-copied']);
    expect(deleted).toEqual([`${REPO}@${image.digest}`]);
    expect(registry.hasManifest(`acct/${REPO}`, image.digest)).toBe(false);
    expect(registry.gcRuns()).toBe(1);

    expect(await deleteSecurityScannerImages(TARGET, [REPO])).toEqual([]);
    expect(registry.gcRuns()).toBe(1);
  });

  it('fails instead of skipping an image it cannot read, or a failed layer cleanup', async () => {
    const image = fakeImage();
    const registry = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-a': image },
    });
    install(registry);
    await ensureSecurityScannerImage(TARGET, pin(image.digest), REPO, { deadline: later() });
    const answer = (refuse: (method: string, path: string) => boolean) => {
      const next = registry.fetch();
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        return refuse(init?.method ?? 'GET', url.pathname)
          ? new Response(null, { status: 500 })
          : next(input, init);
      });
    };
    answer((method, path) => method === 'HEAD' && path.includes('/manifests/sha256-'));
    await expect(deleteSecurityScannerImages(TARGET, [REPO])).rejects.toThrow('(HTTP 500)');
    expect(registry.hasManifest(`acct/${REPO}`, image.digest)).toBe(true);

    answer((_method, path) => path === '/v2/gc/layers');
    await expect(deleteSecurityScannerImages(TARGET, [REPO])).rejects.toThrow(
      'The registry layer cleanup failed (HTTP 500).',
    );
  });
});
