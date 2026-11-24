import type { DeployArtifact } from './artifact.ts';
import { canonicalJson } from './canonical-json.ts';

/** Commit to all executable bytes, asset hashes, bindings, migrations, and routing. */
export async function deployArtifactDigest(artifact: DeployArtifact): Promise<string> {
  // Describe only the standard host capabilities we need, without introducing
  // DOM declarations into Node or Workers consumers of this shared package.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Web Crypto and TextEncoder are available on both supported hosts.
  const host = globalThis as typeof globalThis & {
    crypto: {
      subtle: { digest(algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> };
    };
    TextEncoder: new () => { encode(value: string): Uint8Array<ArrayBuffer> };
  };
  const data = canonicalJson({
    manifest: artifact.manifest,
    assetManifest: artifact.assetManifest,
    workerFiles: artifact.workerFiles ?? {},
  });
  const bytes = await host.crypto.subtle.digest('SHA-256', new host.TextEncoder().encode(data));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
