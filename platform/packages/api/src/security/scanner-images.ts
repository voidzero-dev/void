/**
 * The Engine A and C scanner images this platform release runs (design doc 0095, M13b).
 * Void publishes each image once, at a digest; `scanner-images.json` holds that digest and
 * is written by `platform/scripts/publish-security-scanner-images.ts` at release time.
 * The API copies the image by that digest into the operator's own registry (spike S1b,
 * option A) before a container app may run it. `digest: null` means the release has no
 * image for that engine: its models stay unpickable (probe check 5).
 *
 *   ghcr.io/voidzero-dev/void-security-scanner-engine-a@sha256:…   (published by Void)
 *        │ copy by digest (registry API, streamed, from the API Worker)
 *        ▼
 *   registry.cloudflare.com/<account>/void-security-scanner-engine-a-<hash>@sha256:…
 *        │ /containers/image-preparations, then the controller's container app
 *        ▼
 *   ScannerControllerAgentSdk (one container app per engine)
 */
import type { SecurityEngine, SecurityThirdPartyHost } from '@void/platform/security-models';
import pins from './scanner-images.json' with { type: 'json' };

/** The engines that bring their own image. Engine B runs the managed image. */
export type SecurityImageEngine = Exclude<SecurityEngine, 'void_loop'>;

export const SECURITY_IMAGE_ENGINES: ReadonlyArray<SecurityImageEngine> = [
  'agent_sdk',
  'codex_sdk',
];

export type SecurityScannerImagePin = Readonly<{
  engine: SecurityImageEngine;
  /** `ghcr.io/<owner>/<name>`, no tag. */
  repository: string;
  /** `sha256:<64 hex>` of the linux/amd64 image manifest, or null when not published. */
  digest: string | null;
}>;

/** Short engine names used in Cloudflare resource names (no vendor names, spec §8.2). */
export const SECURITY_IMAGE_ENGINE_SLUG: Readonly<Record<SecurityImageEngine, string>> = {
  agent_sdk: 'engine-a',
  codex_sdk: 'engine-c',
};

export const SECURITY_IMAGE_ENGINE_HOST: Readonly<
  Record<SecurityImageEngine, SecurityThirdPartyHost>
> = {
  agent_sdk: 'anthropic',
  codex_sdk: 'openai',
};

export function isSecurityImageEngine(engine: unknown): engine is SecurityImageEngine {
  return engine === 'agent_sdk' || engine === 'codex_sdk';
}

export function securityImageEngineForHost(host: SecurityThirdPartyHost): SecurityImageEngine {
  return host === 'anthropic' ? 'agent_sdk' : 'codex_sdk';
}

function isHex(value: string): boolean {
  for (const char of value) {
    if (!((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f'))) {
      return false;
    }
  }
  return true;
}

export function isImageDigest(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('sha256:') &&
    value.length === 71 &&
    isHex(value.slice(7))
  );
}

function isRepositoryPart(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (const char of value) {
    const ok =
      (char >= 'a' && char <= 'z') ||
      (char >= '0' && char <= '9') ||
      char === '-' ||
      char === '_' ||
      char === '.';
    if (!ok) {
      return false;
    }
  }
  return true;
}

/** `ghcr.io/<owner>/<name>`: the only source registry the copy reads. */
export function isGhcrRepository(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const parts = value.split('/');
  return parts.length === 3 && parts[0] === 'ghcr.io' && parts.slice(1).every(isRepositoryPart);
}

/** Parses the release pins. A malformed entry is a build error, not a silent null. */
export function parseSecurityScannerImagePins(
  value: unknown,
): ReadonlyArray<SecurityScannerImagePin> {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return SECURITY_IMAGE_ENGINES.map((engine) => {
    const entry = record[engine];
    const fields =
      entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
    if (!fields || !isGhcrRepository(fields.repository)) {
      throw new Error(`scanner-images.json: ${engine} needs a ghcr.io repository.`);
    }
    const digest = fields.digest;
    if (digest !== null && !isImageDigest(digest)) {
      throw new Error(`scanner-images.json: ${engine} digest must be sha256:<64 hex> or null.`);
    }
    return { engine, repository: fields.repository, digest };
  });
}

const RELEASE_PINS = parseSecurityScannerImagePins(pins);

/** The images this platform release runs, one per image engine. */
export function securityScannerImagePins(): ReadonlyArray<SecurityScannerImagePin> {
  return RELEASE_PINS;
}
