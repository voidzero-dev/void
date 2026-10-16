import { platformProjectHostname, readPlatformApplication } from '@void/platform';
import type { ApiEnv } from '../env.ts';
import type { Project } from '../types.ts';
import { isCfAssetPlainText } from './migrations.ts';

// Cap on the number of presign requests in a single batch. Presigning is
// CPU-light (one HMAC chain per call) but unbounded fanout still costs
// memory and lets a malformed CLI burn server CPU without bound. 5000 is
// well above the largest realistic dist/ asset count. Asset manifests on the
// JSON-mode deploy share the same cap for symmetry.
export const MAX_UPLOAD_URLS_BATCH = 5000;

export const DEFAULT_TAIL_SERVICE_NAME = 'void-tail';

// Per-module cap for Worker modules that older CLIs send inline as base64
// `workerFiles`. It bounds the memory one decoded module holds in the request;
// it is not a Cloudflare limit. Modules uploaded to R2 (`workerInput`) are
// checked against CLOUDFLARE_WORKER_SIZE_LIMIT_BYTES instead.
export const MAX_WORKER_FILE_BYTES = 32 * 1024 * 1024;

// Mirrors Cloudflare's Worker size limit: 64 MiB uncompressed on every plan,
// counting every module except source maps. Cloudflare limits source maps
// separately and enforces that limit itself.
// https://developers.cloudflare.com/workers/platform/limits/#worker-size
export const CLOUDFLARE_WORKER_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

// A finalize accepts direct Worker uploads at most this old. The stale-input
// sweep (`dispatchPendingDeployments`) removes unclaimed inputs after 24 hours,
// so an accepted upload cannot be swept while its deploy is admitted or runs.
export const WORKER_UPLOAD_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Decode a base64 string to bytes with the lowest peak residency the
 * runtime allows. Prefers the (TC39 stage-4) `Uint8Array.fromBase64` helper
 * which performs the decode in a single allocation; falls back to the
 * `atob` + per-byte copy path on runtimes that don't expose it (notably
 * Node, where the integration tests run — the production CF Workers compat
 * date is 2026-02-12 and ships the helper natively).
 *
 * For a 32 MiB module the fast path drops peak residency from
 * roughly `raw + bin + decoded ≈ 86 + 64 + 32 = 182 MiB` to
 * `raw + decoded ≈ 86 + 32 = 118 MiB`, which fits under the 128 MiB
 * isolate cap with margin.
 */
export function decodeBase64ToBytes(raw: string): Uint8Array {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array })
    .fromBase64;
  if (typeof fromBase64 === 'function') {
    return fromBase64(raw);
  }
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Public URLs for a project: active custom domains first, then the platform hostname. */
export function projectPublicUrls(
  env: ApiEnv['Bindings'],
  project: Project,
  domains: ReadonlyArray<Readonly<{ hostname: string; status: string }>>,
): Array<string> {
  return [
    ...domains.filter((domain) => domain.status === 'active').map((d) => `https://${d.hostname}`),
    `https://${platformProjectHostname(project, readPlatformApplication(env))}`,
  ];
}

export const CF_RETRY = { maxRetries: 3, delayMs: 1000 };

// Readiness probe: confirms the new worker is live in the dispatch namespace
// before dispatching migrations. Absorbs CF's WfP propagation delay.
// Backoff: 0 + 1 + 2 + 4 + 8 + 16 + 32 = ~63s max window.
export const CF_READINESS_RETRY = { maxRetries: 6, delayMs: 1000 };

export function sanitizeDeployErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (
    isCfAssetPlainText(trimmed) ||
    // JSON.parse SyntaxError truncates the original text (e.g. `Unexpected token 'A', "Assets hav"...`)
    // so the full substring won't match — detect the truncated form too
    /Unexpected token.*"Assets hav/.test(trimmed)
  ) {
    return 'asset upload returned an unexpected Cloudflare response';
  }
  return message;
}

// Bounded concurrency for the R2 head check that verifies declared assets
// were actually uploaded by the CLI before the JSON-mode deploy proceeds.
// 20 matches R2's typical head-throughput sweet spot — verifying 5000
// assets at this concurrency completes in well under the deploy heartbeat
// interval.
export const R2_HEAD_VERIFY_CONCURRENCY = 20;

// Keep each project-row-lock tenure bounded while reconciling external asset
// stores. A fresh retained/in-flight hash snapshot is taken for every batch.
export const ASSET_GC_LOCK_BATCH = 100;

// Retention is post-cutover and best effort. Cap the asset hashes one deploy
// evicts or sweeps (each costs up to a KV delete and an R2 head) so eviction
// only briefly delays the `done` event, and the orphan sweep that runs in
// `waitUntil` after the response stays short.
export const ASSET_GC_MAX_HASHES_PER_DEPLOY = 200;

// Per-blake3 / per-md5 validation: 32 lowercase hex characters.
export const HEX_32_REGEX = /^[0-9a-f]{32}$/;

// Body cap for JSON-mode deploy POSTs. Older CLIs send Worker modules inline
// as base64 `workerFiles`, which dominate the body; current CLIs upload them
// to R2 first (`workerInput`) and send only their names, sizes, and digests.
// The cap keeps the inline path's parsed body well under the 128 MiB Worker
// memory limit. Asset bytes never travel in this body — they go direct-to-R2
// via presigned PUTs.
export const MAX_JSON_DEPLOY_BODY_BYTES = 64 * 1024 * 1024;

export type UploadUrlsRequestAsset = Readonly<{
  blake3: string;
  md5: string;
  size: number;
  contentType: string;
}>;

// Main module Cloudflare runs when the manifest does not name `workerMain`.
export const DEFAULT_WORKER_MAIN_MODULE = 'index.js';

// Extensions the CLI collects from the worker build output, plus the JSON
// modules `moduleContentType` understands.
const WORKER_MODULE_EXTENSION_REGEX = /\.(?:js|mjs|cjs|wasm|map|txt|json)$/;
// C0 controls, DEL, and C1 controls.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTER_REGEX = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Explain why `name` cannot be a Worker module, or return null when it can.
 * Module names become multipart part names next to the platform's own
 * `metadata` part in the Cloudflare upload, so they must be plain relative
 * module paths.
 */
export function workerModuleNameError(name: string): string | null {
  if (name.length === 0) {
    return 'must not be empty';
  }
  if (CONTROL_CHARACTER_REGEX.test(name)) {
    return 'must not contain control characters';
  }
  if (name.includes('\\')) {
    return 'must use forward slashes';
  }
  if (name.startsWith('/')) {
    return 'must be a relative path';
  }
  if (name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'must not contain empty, "." or ".." path segments';
  }
  if (name.toLowerCase() === 'metadata') {
    return 'is reserved';
  }
  if (!WORKER_MODULE_EXTENSION_REGEX.test(name)) {
    return 'must end in .js, .mjs, .cjs, .wasm, .map, .txt or .json';
  }
  return null;
}

/**
 * Explain why an uploaded module set cannot be deployed, or return null when
 * every name is a valid module and the main module is among them.
 */
export function workerFilesError(
  names: ReadonlyArray<string>,
  workerMain: string | undefined,
): string | null {
  for (const name of names) {
    const nameError = workerModuleNameError(name);
    if (nameError) {
      return `workerFiles entry ${JSON.stringify(name)} ${nameError}`;
    }
  }
  const mainModule = workerMain ?? DEFAULT_WORKER_MAIN_MODULE;
  if (names.length > 0 && !names.includes(mainModule)) {
    return `workerFiles must include the main module ${JSON.stringify(mainModule)}`;
  }
  return null;
}

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One Worker module the CLI uploads to R2 before it finalizes a deploy. */
export type WorkerUploadModule = Readonly<{ name: string; size: number; sha256: string }>;

/** A direct Worker upload the CLI finished before calling the deploy endpoint. */
export type WorkerInput = Readonly<{ id: string; modules: ReadonlyArray<WorkerUploadModule> }>;

export type WorkerUploadProblem = Readonly<{
  status: 400 | 413;
  error?: 'worker_too_large';
  message: string;
}>;

function roundedMiB(bytes: number): string {
  return String(Math.ceil((bytes / 1024 / 1024) * 10) / 10);
}

/**
 * Explain why a direct Worker upload's module list cannot be accepted, or
 * return null. Names follow `workerModuleNameError`; the main module is
 * checked once the manifest is known, at finalize.
 */
export function workerUploadModulesProblem(
  value: unknown,
  label: string,
): WorkerUploadProblem | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_UPLOAD_URLS_BATCH) {
    return {
      status: 400,
      message: `${label} must be an array of 1 to ${MAX_UPLOAD_URLS_BATCH} modules`,
    };
  }
  const names = new Set<string>();
  let codeBytes = 0;
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index];
    const at = `${label}[${index}]`;
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { status: 400, message: `${at} must be an object` };
    }
    const { name, size, sha256 } = entry as Record<string, unknown>;
    if (typeof name !== 'string') {
      return { status: 400, message: `${at}.name must be a string` };
    }
    const nameError = workerModuleNameError(name);
    if (nameError) {
      return { status: 400, message: `${at}.name ${JSON.stringify(name)} ${nameError}` };
    }
    if (names.has(name)) {
      return { status: 400, message: `${at}.name ${JSON.stringify(name)} is listed twice` };
    }
    names.add(name);
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      return { status: 400, message: `${at}.size must be a non-negative integer` };
    }
    if (typeof sha256 !== 'string' || !SHA256_HEX_REGEX.test(sha256)) {
      return { status: 400, message: `${at}.sha256 must be 64 lowercase hex characters` };
    }
    if (moduleContentType(name) !== 'application/source-map') {
      codeBytes += size;
    }
  }
  if (codeBytes > CLOUDFLARE_WORKER_SIZE_LIMIT_BYTES) {
    return {
      status: 413,
      error: 'worker_too_large',
      message: `The Worker is ${roundedMiB(codeBytes)} MiB without source maps, and Cloudflare allows ${roundedMiB(CLOUDFLARE_WORKER_SIZE_LIMIT_BYTES)} MiB.`,
    };
  }
  return null;
}

/** Explain why a deploy body's `workerInput` cannot be accepted, or return null. */
export function workerInputProblem(value: unknown): WorkerUploadProblem | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 400, message: 'workerInput must be an object with id and modules' };
  }
  const { id, modules } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    return {
      status: 400,
      message: 'workerInput.id must be the id returned by /deploy/worker-upload-urls',
    };
  }
  return workerUploadModulesProblem(modules, 'workerInput.modules');
}

export function moduleContentType(filename: string): string {
  if (filename.endsWith('.wasm')) {
    return 'application/wasm';
  }
  if (filename.endsWith('.map')) {
    return 'application/source-map';
  }
  if (filename.endsWith('.json')) {
    return 'application/json';
  }
  if (filename.endsWith('.txt')) {
    return 'text/plain';
  }
  return 'application/javascript+module';
}
