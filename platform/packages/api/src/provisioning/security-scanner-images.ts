/**
 * Copy a digest-pinned Engine A/C scanner image into the operator's own Cloudflare
 * registry and prepare it (design doc 0095 M13b, spike S1b option A). A container app
 * with the `durable_object` scheduling policy only runs images from
 * `registry.cloudflare.com/<this account>/…`, and nothing is built on the operator's
 * machine (spec §5.1), so the API Worker streams the published image across:
 *
 *   ghcr.io (anonymous pull) ──manifest by digest, sha256 checked──┐
 *        │ config blob: sha256 checked, must be linux/amd64         │
 *        │ layers: streamed, the destination registry checks digests │
 *        ▼                                                           ▼
 *   registry.cloudflare.com/<account>/<repo>  (short-lived push credentials)
 *        ▼
 *   /containers/image-preparations  → ready
 *
 * Blobs already in the destination are skipped, so a copy cut off by the time budget
 * goes on where it stopped at the next probe. Every request ends by the deadline: a layer
 * still in flight then is cut off and copied again next time, so the probe never waits
 * longer than its budget. Nothing here holds the token beyond the
 * request that uses it; registry credentials last 15 minutes.
 */
import type { SecurityScannerImagePin } from '../security/scanner-images.ts';
import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';

export const CLOUDFLARE_REGISTRY = 'registry.cloudflare.com';
const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];
const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
];
const ACCEPT = [...MANIFEST_TYPES, ...INDEX_TYPES].join(', ');
/** The config blob is JSON; a few MiB at most. */
const CONFIG_LIMIT = 4 * 1024 * 1024;
const MANIFEST_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const BLOB_TIMEOUT_MS = 10 * 60_000;
const PREPARE_POLL_MS = 2_000;
/** The shortest time a request gets, so a call made right at the deadline can still answer. */
const MIN_REQUEST_MS = 1_000;

/** The deadline of one copy; each request gets what is left of it (capped). */
type Clock = Readonly<{ deadline: number; now: () => number }>;

function within(clock: Clock | undefined, capMs: number): AbortSignal {
  const left = clock ? clock.deadline - clock.now() : capMs;
  return AbortSignal.timeout(Math.max(MIN_REQUEST_MS, Math.min(capMs, left)));
}

export type ScannerImageStep =
  | 'unpublished'
  | 'credentials'
  | 'source'
  | 'copy'
  | 'prepare'
  | 'pending';

export type ScannerImageResult = Readonly<
  { ok: true; ref: string; copied: boolean } | { ok: false; step: ScannerImageStep; detail: string }
>;

export type ScannerImageTarget = Readonly<{ accountId: string; apiToken: string }>;

class ImageStepError extends Error {
  readonly step: ScannerImageStep;
  constructor(step: ScannerImageStep, message: string) {
    super(message);
    this.step = step;
  }
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The image ref a container app runs: the copy in this account, by digest. */
export function scannerImageRef(accountId: string, repository: string, digest: string): string {
  return `${CLOUDFLARE_REGISTRY}/${accountId}/${repository}@${digest}`;
}

function registryBase(accountId: string, repository: string): string {
  return `https://${CLOUDFLARE_REGISTRY}/v2/${accountId}/${repository}`;
}

/** A tag that names the digest, so the copy is listed and can be found to delete it. */
export function digestTag(digest: string): string {
  return digest.replace(':', '-');
}

async function registryAuth(
  target: ScannerImageTarget,
  permissions: ReadonlyArray<'push' | 'pull'>,
  clock?: Clock,
): Promise<string> {
  let credentials: { username?: unknown; password?: unknown };
  try {
    credentials = await cfFetch<{ username?: unknown; password?: unknown }>(
      `${CF_API_BASE}/${target.accountId}/containers/registries/${CLOUDFLARE_REGISTRY}/credentials`,
      target.apiToken,
      {
        method: 'POST',
        body: JSON.stringify({ expiration_minutes: 15, permissions }),
        signal: within(clock, REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    const status = error instanceof CloudflareApiError ? ` (HTTP ${error.status})` : '';
    throw new ImageStepError(
      'credentials',
      `The runtime token could not get registry credentials${status}. It needs Account → Containers → Edit.`,
    );
  }
  if (typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
    throw new ImageStepError('credentials', 'The registry credentials answer had no password.');
  }
  return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > limit) {
    await response.body?.cancel();
    throw new ImageStepError('source', 'The published image manifest or config is too large.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) {
    throw new ImageStepError('source', 'The published image manifest or config is too large.');
  }
  return bytes;
}

type Manifest = {
  mediaType?: string;
  config?: { digest?: unknown; size?: unknown; mediaType?: unknown };
  layers?: Array<{ digest?: unknown; size?: unknown }>;
  manifests?: unknown;
};

type BlobRef = { digest: string; size: number };

function blobOf(value: { digest?: unknown; size?: unknown } | undefined): BlobRef {
  if (
    !value ||
    typeof value.digest !== 'string' ||
    !value.digest.startsWith('sha256:') ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    throw new ImageStepError('source', 'The published image manifest lists a malformed blob.');
  }
  return { digest: value.digest, size: value.size };
}

type Source = { base: string; headers: Record<string, string> };

/** Anonymous pull from ghcr.io (the published images are public). */
async function openSource(pin: SecurityScannerImagePin, clock: Clock): Promise<Source> {
  const path = pin.repository.slice('ghcr.io/'.length);
  const response = await fetch(
    `https://ghcr.io/token?scope=${encodeURIComponent(`repository:${path}:pull`)}&service=ghcr.io`,
    { signal: within(clock, REQUEST_TIMEOUT_MS) },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new ImageStepError('source', `ghcr.io refused a pull token (HTTP ${response.status}).`);
  }
  const { token } = (await response.json()) as { token?: unknown };
  if (typeof token !== 'string') {
    throw new ImageStepError('source', 'ghcr.io answered without a pull token.');
  }
  return { base: `https://ghcr.io/v2/${path}`, headers: { Authorization: `Bearer ${token}` } };
}

async function readManifest(
  source: Source,
  digest: string,
  clock: Clock,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; manifest: Manifest; mediaType: string }> {
  const response = await fetch(`${source.base}/manifests/${digest}`, {
    headers: { ...source.headers, Accept: ACCEPT },
    signal: within(clock, REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ImageStepError(
      'source',
      `The published scanner image ${digest} is not readable (HTTP ${response.status}).`,
    );
  }
  const bytes = await readLimited(response, MANIFEST_LIMIT);
  if (`sha256:${await sha256Hex(bytes)}` !== digest) {
    throw new ImageStepError('source', 'The published image manifest does not match its digest.');
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
  } catch {
    throw new ImageStepError('source', 'The published image manifest is not JSON.');
  }
  const mediaType =
    manifest.mediaType ?? response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (INDEX_TYPES.includes(mediaType) || Array.isArray(manifest.manifests)) {
    // The release script pins the single linux/amd64 manifest, never an index.
    throw new ImageStepError('source', 'The pinned scanner image is an index, not one manifest.');
  }
  if (!MANIFEST_TYPES.includes(mediaType)) {
    throw new ImageStepError('source', `The pinned scanner image has media type "${mediaType}".`);
  }
  return { bytes, manifest, mediaType };
}

async function fetchBlob(source: Source, blob: BlobRef, signal: AbortSignal): Promise<Response> {
  const response = await fetch(`${source.base}/blobs/${blob.digest}`, {
    headers: source.headers,
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ImageStepError(
      'source',
      `A published image layer is not readable (HTTP ${response.status}).`,
    );
  }
  return response;
}

async function hasBlob(base: string, auth: string, digest: string, clock: Clock): Promise<boolean> {
  const response = await fetch(`${base}/blobs/${digest}`, {
    method: 'HEAD',
    headers: { Authorization: auth },
    signal: within(clock, REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.ok;
}

type FixedLengthStreamConstructor = new (length: number) => TransformStream<Uint8Array, Uint8Array>;

/** Workers needs a known length to send a streamed body with Content-Length. */
function sizedBody(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as { FixedLengthStream?: FixedLengthStreamConstructor })
    .FixedLengthStream;
  if (!Fixed) {
    return body;
  }
  return body.pipeThrough(new Fixed(size));
}

async function pushBlob(
  base: string,
  auth: string,
  blob: BlobRef,
  body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>,
  clock: Clock,
  signal: AbortSignal,
): Promise<void> {
  const start = await fetch(`${base}/blobs/uploads/`, {
    method: 'POST',
    headers: { Authorization: auth },
    signal: within(clock, REQUEST_TIMEOUT_MS),
  });
  await start.body?.cancel();
  const location = start.headers.get('location');
  if (start.status !== 202 || !location) {
    throw new ImageStepError(
      'copy',
      `The account registry refused an upload (HTTP ${start.status}).`,
    );
  }
  const url = new URL(location, `https://${CLOUDFLARE_REGISTRY}`);
  url.searchParams.set('digest', blob.digest);
  const put = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(blob.size),
    },
    body: body instanceof Uint8Array ? body : sizedBody(body, blob.size),
    signal,
    // Node's fetch needs this for a stream body; Workers ignores it.
    ...({ duplex: 'half' } as Record<string, string>),
  });
  await put.body?.cancel();
  if (put.status !== 201) {
    throw new ImageStepError('copy', `The account registry refused a layer (HTTP ${put.status}).`);
  }
}

async function hasManifest(
  base: string,
  auth: string,
  digest: string,
  clock: Clock,
): Promise<boolean> {
  const response = await fetch(`${base}/manifests/${digest}`, {
    method: 'HEAD',
    headers: { Authorization: auth, Accept: ACCEPT },
    signal: within(clock, REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.ok;
}

function timeLeft(clock: Clock): void {
  if (clock.deadline - clock.now() <= 0) {
    throw new ImageStepError(
      'pending',
      'The scanner image copy is not finished yet. The parts already copied are kept.',
    );
  }
}

/** Copies the pinned image unless the account registry already holds that digest. */
async function copyImage(
  target: ScannerImageTarget,
  pin: SecurityScannerImagePin & { digest: string },
  repository: string,
  clock: Clock,
): Promise<boolean> {
  const auth = await registryAuth(target, ['push', 'pull'], clock);
  const base = registryBase(target.accountId, repository);
  if (await hasManifest(base, auth, pin.digest, clock)) {
    return false;
  }
  const source = await openSource(pin, clock);
  const { bytes, manifest, mediaType } = await readManifest(source, pin.digest, clock);
  const config = blobOf(manifest.config);
  const layers = (Array.isArray(manifest.layers) ? manifest.layers : []).map(blobOf);
  if (layers.length === 0) {
    throw new ImageStepError('source', 'The published image manifest has no layers.');
  }
  // The config is small: read it, check its digest and that the image is linux/amd64
  // (Cloudflare runs amd64), then upload the same bytes.
  const configResponse = await fetchBlob(source, config, within(clock, REQUEST_TIMEOUT_MS));
  const configBytes = await readLimited(configResponse, CONFIG_LIMIT);
  if (`sha256:${await sha256Hex(configBytes)}` !== config.digest) {
    throw new ImageStepError('source', 'The published image config does not match its digest.');
  }
  let platform: { os?: unknown; architecture?: unknown } = {};
  try {
    platform = JSON.parse(new TextDecoder().decode(configBytes)) as typeof platform;
  } catch {
    throw new ImageStepError('source', 'The published image config is not JSON.');
  }
  if (platform.os !== 'linux' || platform.architecture !== 'amd64') {
    throw new ImageStepError('source', 'The pinned scanner image is not linux/amd64.');
  }
  if (!(await hasBlob(base, auth, config.digest, clock))) {
    await pushBlob(base, auth, config, configBytes, clock, within(clock, REQUEST_TIMEOUT_MS));
  }
  for (const layer of layers) {
    timeLeft(clock);
    if (await hasBlob(base, auth, layer.digest, clock)) {
      continue;
    }
    // One signal for the read and the write: a layer still in flight at the deadline is
    // cut off and copied again by the next probe.
    const signal = within(clock, BLOB_TIMEOUT_MS);
    const response = await fetchBlob(source, layer, signal);
    await pushBlob(base, auth, layer, response.body!, clock, signal);
  }
  // The destination registry checked every blob digest; the manifest is the pinned bytes.
  const put = await fetch(`${base}/manifests/${digestTag(pin.digest)}`, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': mediaType },
    body: bytes,
    signal: within(clock, REQUEST_TIMEOUT_MS),
  });
  await put.body?.cancel();
  if (put.status !== 201) {
    throw new ImageStepError(
      'copy',
      `The account registry refused the manifest (HTTP ${put.status}).`,
    );
  }
  const pushed = put.headers.get('docker-content-digest');
  if (pushed !== null && pushed !== pin.digest) {
    throw new ImageStepError('copy', 'The account registry stored another manifest digest.');
  }
  return true;
}

async function prepare(target: ScannerImageTarget, ref: string, clock: Clock): Promise<void> {
  for (;;) {
    let result: { image?: string; status?: string };
    try {
      result = await cfFetch<{ image?: string; status?: string }>(
        `${CF_API_BASE}/${target.accountId}/containers/image-preparations`,
        target.apiToken,
        {
          method: 'POST',
          body: JSON.stringify({ image: ref }),
          signal: within(clock, REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      if (clock.deadline - clock.now() <= 0) {
        throw new ImageStepError('pending', 'Cloudflare is still preparing the scanner image.');
      }
      throw new ImageStepError(
        'prepare',
        `Cloudflare could not prepare the scanner image (${error instanceof Error ? error.message : 'error'}).`,
      );
    }
    if (result.image !== ref) {
      throw new ImageStepError('prepare', 'Cloudflare prepared another image than the one asked.');
    }
    if (result.status === 'ready') {
      return;
    }
    if (result.status !== 'pending') {
      throw new ImageStepError('prepare', `Cloudflare image preparation ended "${result.status}".`);
    }
    const left = clock.deadline - clock.now();
    if (left <= PREPARE_POLL_MS) {
      throw new ImageStepError('pending', 'Cloudflare is still preparing the scanner image.');
    }
    await new Promise((resolve) => setTimeout(resolve, PREPARE_POLL_MS));
  }
}

/**
 * Makes the pinned image runnable in this account: copy (when missing), then prepare.
 * Never throws; a step that fails or runs out of time is reported, and Engine B is not
 * affected.
 */
export async function ensureSecurityScannerImage(
  target: ScannerImageTarget,
  pin: SecurityScannerImagePin,
  repository: string,
  options: Readonly<{ deadline: number; now?: () => number }>,
): Promise<ScannerImageResult> {
  const now = options.now ?? Date.now;
  if (pin.digest === null) {
    return {
      ok: false,
      step: 'unpublished',
      detail: 'This platform release has no scanner image for this engine.',
    };
  }
  const digest = pin.digest;
  const clock: Clock = { deadline: options.deadline, now };
  try {
    const copied = await copyImage(target, { ...pin, digest }, repository, clock);
    const ref = scannerImageRef(target.accountId, repository, digest);
    await prepare(target, ref, clock);
    return { ok: true, ref, copied };
  } catch (error) {
    if (error instanceof ImageStepError) {
      return { ok: false, step: error.step, detail: error.message };
    }
    if (clock.deadline - clock.now() <= 0) {
      // A request cut off by the deadline: the next probe goes on from what is copied.
      return {
        ok: false,
        step: 'pending',
        detail: 'The scanner image copy is not finished yet. The parts already copied are kept.',
      };
    }
    return {
      ok: false,
      step: 'copy',
      detail: `The scanner image copy failed (${error instanceof Error ? error.message : 'error'}).`,
    };
  }
}

/**
 * Uninstall: removes every manifest in the installation's scanner image repositories,
 * then asks the registry to drop the unreferenced layers. A missing repository is fine.
 */
export async function deleteSecurityScannerImages(
  target: ScannerImageTarget,
  repositories: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const auth = await registryAuth(target, ['push', 'pull']);
  const deleted: Array<string> = [];
  for (const repository of repositories) {
    const base = registryBase(target.accountId, repository);
    const list = await fetch(`${base}/tags/list`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (list.status === 404) {
      await list.body?.cancel();
      continue;
    }
    if (!list.ok) {
      await list.body?.cancel();
      throw new Error(`Listing scanner images failed (HTTP ${list.status}).`);
    }
    const { tags } = (await list.json()) as { tags?: unknown };
    for (const tag of Array.isArray(tags) ? tags : []) {
      if (typeof tag !== 'string') {
        continue;
      }
      const head = await fetch(`${base}/manifests/${tag}`, {
        method: 'HEAD',
        headers: { Authorization: auth, Accept: ACCEPT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await head.body?.cancel();
      if (head.status === 404) {
        continue;
      }
      const digest = head.headers.get('docker-content-digest');
      if (head.status !== 200 || !digest) {
        // Never report a cleanup as done while an image may still be stored.
        throw new Error(`Reading scanner image ${repository}:${tag} failed (HTTP ${head.status}).`);
      }
      const removed = await fetch(`${base}/manifests/${digest}`, {
        method: 'DELETE',
        headers: { Authorization: auth, Accept: ACCEPT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await removed.body?.cancel();
      if (!removed.ok && removed.status !== 404) {
        throw new Error(`Deleting a scanner image failed (HTTP ${removed.status}).`);
      }
      deleted.push(`${repository}@${digest}`);
    }
  }
  if (deleted.length > 0) {
    const gc = await fetch(`https://${CLOUDFLARE_REGISTRY}/v2/gc/layers`, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await gc.body?.cancel();
    if (!gc.ok) {
      throw new Error(`The registry layer cleanup failed (HTTP ${gc.status}).`);
    }
  }
  return deleted;
}
