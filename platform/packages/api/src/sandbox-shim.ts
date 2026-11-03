// Immutable SDK 1.0.3 helper layer. Verify before extracting executable bytes.
// The published SDK image contains only this helper, not a runnable environment.
const LAYER_DIGEST = 'f7a1c91dcb86ff275307a455c11809413cf7c07d7dfc09f6222c87ed5a3b7ab3';
let shim: Promise<Uint8Array> | undefined;

export function getSandboxShim(): Promise<Uint8Array> {
  return (shim ??= download().catch((error) => {
    shim = undefined;
    throw error;
  }));
}

async function download(): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(30_000);
  const auth = await fetch(
    'https://auth.docker.io/token?service=registry.docker.io&scope=repository:cloudflare/sandbox:pull',
    { signal },
  );
  if (!auth.ok) {
    throw new Error('Sandbox helper download authorization failed.');
  }
  const { token } = await auth.json<{ token: string }>();
  const response = await fetch(
    `https://registry-1.docker.io/v2/cloudflare/sandbox/blobs/sha256:${LAYER_DIGEST}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Sandbox helper download failed (HTTP ${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== LAYER_DIGEST) {
    throw new Error('Sandbox helper integrity check failed.');
  }
  const tar = new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer(),
  );
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = decoder.decode(header.subarray(0, 100)).split('\0')[0];
    const size = Number.parseInt(
      decoder.decode(header.subarray(124, 136)).replaceAll('\0', '').trim(),
      8,
    );
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) {
      break;
    }
    if (name === 'usr/local/bin/sandbox-shim') {
      return tar.slice(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Sandbox helper is missing from the verified layer.');
}
