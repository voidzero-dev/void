// Fake image registries for the scanner image copy (design doc 0095 M13b): the published
// image on ghcr.io, the operator's registry.cloudflare.com, and the Cloudflare API route
// that hands out registry credentials. Install it in front of `mockCfApi` (or alone) with
// `vi.stubGlobal('fetch', registry.fetch(next))`. Records every registry call in order.

import { createHash } from 'node:crypto';

export type FakeImage = Readonly<{
  /** `sha256:…` of the manifest bytes: what `scanner-images.json` pins. */
  digest: string;
  manifest: Uint8Array<ArrayBuffer>;
  blobs: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  config: string;
  layers: ReadonlyArray<string>;
}>;

const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

function sha(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A small linux/amd64 image (or another platform, for the refusal test). */
export function fakeImage(
  options: { layers?: number; architecture?: string; mediaType?: string; index?: boolean } = {},
): FakeImage {
  const encoder = new TextEncoder();
  const config = encoder.encode(
    JSON.stringify({ os: 'linux', architecture: options.architecture ?? 'amd64', config: {} }),
  );
  const layers = Array.from({ length: options.layers ?? 2 }, (_, index) =>
    encoder.encode(`layer ${index} ${'x'.repeat(100 + index)}`),
  );
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>([[sha(config), config]]);
  for (const layer of layers) {
    blobs.set(sha(layer), layer);
  }
  const body = options.index
    ? {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [{ digest: sha(config), platform: { os: 'linux', architecture: 'amd64' } }],
      }
    : {
        schemaVersion: 2,
        mediaType: options.mediaType ?? OCI_MANIFEST,
        config: {
          mediaType: 'application/vnd.oci.image.config.v1+json',
          digest: sha(config),
          size: config.byteLength,
        },
        layers: layers.map((layer) => ({
          mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          digest: sha(layer),
          size: layer.byteLength,
        })),
      };
  const manifest = encoder.encode(JSON.stringify(body));
  return {
    digest: sha(manifest),
    manifest,
    blobs,
    config: sha(config),
    layers: layers.map(sha),
  };
}

type Repo = {
  manifests: Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string }>;
  tags: Map<string, string>;
};

export type FakeRegistry = ReturnType<typeof createFakeRegistry>;

/**
 * `ghcr` holds the published images by `<owner>/<name>`; `cloudflare` is the account
 * registry by `<account>/<repo>`, with blobs shared across the account like the real one.
 */
export function createFakeRegistry(
  options: {
    published?: Record<string, FakeImage>;
    credentialsStatus?: number;
    /** Called before each destination blob upload; return a status to refuse it. */
    onUpload?: (digest: string) => number | undefined;
    /** `/containers/image-preparations` status per call (default 'ready'). */
    prepare?: (image: string) => string;
  } = {},
) {
  const calls: Array<string> = [];
  const published = new Map(Object.entries(options.published ?? {}));
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  const repos = new Map<string, Repo>();
  let gcRuns = 0;
  let uploadId = 0;
  const uploads = new Map<string, string>();

  const repo = (name: string): Repo => {
    let found = repos.get(name);
    if (!found) {
      found = { manifests: new Map(), tags: new Map() };
      repos.set(name, found);
    }
    return found;
  };

  const prepared: Array<string> = [];
  const handle = async (url: URL, init: RequestInit | undefined): Promise<Response | null> => {
    const method = init?.method ?? 'GET';
    if (
      url.hostname === 'api.cloudflare.com' &&
      url.pathname.endsWith('/containers/image-preparations')
    ) {
      const { image } = JSON.parse(String(init?.body)) as { image: string };
      prepared.push(image);
      calls.push(`POST prepare ${image}`);
      return Response.json({
        success: true,
        errors: [],
        result: { image, status: options.prepare?.(image) ?? 'ready' },
      });
    }
    if (
      url.hostname === 'api.cloudflare.com' &&
      url.pathname.endsWith('/containers/registries/registry.cloudflare.com/credentials')
    ) {
      calls.push(`${method} credentials`);
      const status = options.credentialsStatus ?? 200;
      return status === 200
        ? Response.json({
            success: true,
            errors: [],
            result: { username: 'v1', password: 'registry-password' },
          })
        : Response.json(
            { success: false, errors: [{ code: 10_000, message: 'Authentication error' }] },
            { status },
          );
    }
    if (url.hostname === 'ghcr.io') {
      calls.push(`${method} ghcr${url.pathname}`);
      if (url.pathname === '/token') {
        return Response.json({ token: 'anonymous-pull' });
      }
      const [, version, owner, name, kind, reference] = url.pathname.split('/');
      const image = published.get(`${owner}/${name}`);
      if (version !== 'v2' || !image) {
        return new Response('not found', { status: 404 });
      }
      if (kind === 'manifests' && reference === image.digest) {
        const type = (JSON.parse(new TextDecoder().decode(image.manifest)) as { mediaType: string })
          .mediaType;
        return new Response(image.manifest, { headers: { 'content-type': type } });
      }
      const blob = kind === 'blobs' && reference ? image.blobs.get(reference) : undefined;
      return blob ? new Response(blob) : new Response('not found', { status: 404 });
    }
    if (url.hostname !== 'registry.cloudflare.com') {
      return null;
    }
    calls.push(`${method} cf${url.pathname}`);
    if (url.pathname === '/v2/gc/layers') {
      gcRuns++;
      return new Response(null, { status: 202 });
    }
    const parts = url.pathname.split('/');
    // /v2/<account>/<repo>/<kind>/<reference...>
    const name = `${parts[2]}/${parts[3]}`;
    const kind = parts[4];
    const reference = parts.slice(5).join('/');
    if (kind === 'blobs' && reference === 'uploads/' && method === 'POST') {
      const id = `u${++uploadId}`;
      uploads.set(id, name);
      return new Response(null, {
        status: 202,
        headers: { location: `/v2/${name}/blobs/uploads/${id}?state=x` },
      });
    }
    if (kind === 'blobs' && reference.startsWith('uploads/') && method === 'PUT') {
      const digest = url.searchParams.get('digest') ?? '';
      const refused = options.onUpload?.(digest);
      if (refused !== undefined) {
        return new Response('refused', { status: refused });
      }
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      if (sha(bytes) !== digest) {
        return new Response('digest invalid', { status: 400 });
      }
      blobs.set(digest, bytes);
      return new Response(null, { status: 201 });
    }
    if (kind === 'blobs' && method === 'HEAD') {
      return new Response(null, { status: blobs.has(reference) ? 200 : 404 });
    }
    const entry = repos.get(name);
    if (kind === 'tags' && reference === 'list') {
      return entry && entry.tags.size > 0
        ? Response.json({ name, tags: [...entry.tags.keys()] })
        : new Response('not found', { status: 404 });
    }
    if (kind === 'manifests') {
      const digest = reference.startsWith('sha256:') ? reference : entry?.tags.get(reference);
      if (method === 'PUT') {
        const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
        const pushed = sha(bytes);
        const target = repo(name);
        target.manifests.set(pushed, {
          bytes,
          type: new Headers(init?.headers).get('content-type') ?? '',
        });
        if (!reference.startsWith('sha256:')) {
          target.tags.set(reference, pushed);
        }
        return new Response(null, { status: 201, headers: { 'docker-content-digest': pushed } });
      }
      const stored = digest ? entry?.manifests.get(digest) : undefined;
      if (!stored || !digest) {
        return new Response(null, { status: 404 });
      }
      if (method === 'DELETE') {
        entry!.manifests.delete(digest);
        for (const [tag, value] of entry!.tags) {
          if (value === digest) {
            entry!.tags.delete(tag);
          }
        }
        return new Response(null, { status: 202 });
      }
      return new Response(method === 'HEAD' ? null : stored.bytes, {
        headers: { 'docker-content-digest': digest, 'content-type': stored.type },
      });
    }
    return new Response('not found', { status: 404 });
  };

  return {
    calls,
    blobs,
    prepared,
    repos,
    gcRuns: () => gcRuns,
    /** A digest held in the account registry under `<account>/<repo>`. */
    hasManifest: (name: string, digest: string) => repos.get(name)?.manifests.has(digest) ?? false,
    /** Wraps `next` (for example `mockCfApi`): registry URLs are answered here. */
    fetch(next?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
      return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const answered = await handle(url, init);
        if (answered) {
          return answered;
        }
        if (!next) {
          throw new Error(`fake registry: unexpected ${init?.method ?? 'GET'} ${url}`);
        }
        return next(input, init);
      };
    },
  };
}
