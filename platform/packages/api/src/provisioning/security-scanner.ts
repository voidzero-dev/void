/**
 * Provision, verify and delete the installation's security scanner (design doc 0095,
 * spec §5.1): one controller Worker with its container application, plus a small gate
 * script in the platform dispatch namespace. The API reaches the controller only
 * through `env.DISPATCH.get(gate)`; the controller has no workers.dev route.
 *
 *   API ──DISPATCH──► gate (dispatch script) ──service──► controller Worker ──► container app
 *        ◄────────── SecurityScanControl (service binding, props = installation) ──┘
 *
 * Copied from `sandbox-controller.ts`: create with `If-None-Match: *`, an ownership
 * marker, workers.dev off, and a container application tied to the controller's
 * Durable Object namespace. Unlike Sandbox controllers (one per deployment, never
 * changed), this one is shared and is re-uploaded when a platform release ships a new
 * controller bundle.
 *
 * One Durable Object class and container application per engine (M13b): Engine B runs
 * the managed image; Engines A and C run their own image, copied by digest into this
 * account's registry (`security-scanner-images.ts`). An engine gets its container
 * application only once its image is ready; until then the controller answers
 * `engine_unavailable` for it.
 *
 *   controller Worker ── ScannerController          ── app void-security-scanner-<h>
 *                     ├─ ScannerControllerEngineA   ── app void-security-scanner-engine-a-<h>
 *                     └─ ScannerControllerEngineC   ── app void-security-scanner-engine-c-<h>
 */
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import type { ApiEnv } from '../env.ts';
import { getSecurityScannerControllerSource } from '../security-scanner-controller-source.ts';
import {
  COPY_NAMESPACE_BINDING,
  COPY_PREFIX_BINDING,
  runtimeCopyPrefix,
} from '../security/runtime-copy-names.ts';
import { COPY_SANDBOX_SOURCE } from '../security/runtime-copy-sources.ts';
import { sweepSecurityRuntimeCopies } from '../security/runtime-copy-sweep.ts';
import {
  SECURITY_IMAGE_ENGINE_SLUG,
  SECURITY_IMAGE_ENGINES,
  type SecurityImageEngine,
} from '../security/scanner-images.ts';
import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  tryCreateContainerApplication,
  type ContainerApplicationInfo,
} from './containers.ts';
import { deleteSecurityScannerImages } from './security-scanner-images.ts';

export const SECURITY_SCANNER_CLASS = 'ScannerController';
export const SECURITY_SCANNER_BINDING = 'SCANNER';
export const SECURITY_SCANNER_CONTROL_BINDING = '__VOID_SECURITY_SCAN_CONTROL';
export const SECURITY_SCANNER_CONTROL_ENTRYPOINT = 'SecurityScanControl';
/** The Durable Object class and binding of each image engine (one container app each). */
export const SECURITY_SCANNER_ENGINE_CLASS: Readonly<Record<SecurityImageEngine, string>> = {
  agent_sdk: 'ScannerControllerEngineA',
  codex_sdk: 'ScannerControllerEngineC',
};
export const SECURITY_SCANNER_ENGINE_BINDING: Readonly<Record<SecurityImageEngine, string>> = {
  agent_sdk: 'SCANNER_ENGINE_A',
  codex_sdk: 'SCANNER_ENGINE_C',
};
/** JSON `{engine: ref}` of the images the controller may run; the controller reads it. */
export const SECURITY_SCANNER_IMAGES_BINDING = '__VOID_SECURITY_SCANNER_IMAGES';
const OWNER_BINDING = '__VOID_SECURITY_SCANNER_OWNER';
const SOURCE_BINDING = '__VOID_SECURITY_SCANNER_SOURCE';
const GATE_SERVICE_BINDING = 'SCANNER';
const PROTOCOL = 1;

/** The gate only forwards; it holds no secret and no logic. */
export const SECURITY_SCANNER_GATE_SOURCE =
  'export default { fetch(request, env) { return env.SCANNER.fetch(request); } };';

export type SecurityScannerTarget = Readonly<{
  accountId: string;
  apiToken: string;
  /** The API Worker's script name (its `SecurityScanControl` entrypoint). */
  apiService: string;
  dispatchNamespace: string;
  /** Names and ownership are derived from this (the installation id when known). */
  installationKey: string;
}>;

export function securityScannerTarget(
  env: Pick<
    ApiEnv['Bindings'],
    | 'CF_ACCOUNT_ID'
    | 'CF_API_TOKEN'
    | 'SANDBOX_CONTROL_SERVICE'
    | 'DISPATCH_NAMESPACE'
    | 'PLATFORM_INSTALLATION_ID'
  >,
): SecurityScannerTarget {
  // SANDBOX_CONTROL_SERVICE is the API Worker's own script name on every install.
  const apiService = env.SANDBOX_CONTROL_SERVICE ?? 'void-api';
  return {
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN,
    apiService,
    dispatchNamespace: env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE,
    installationKey: env.PLATFORM_INSTALLATION_ID ?? apiService,
  };
}

export type SecurityScannerEngineNames = Readonly<{
  /** Container application of the engine's Durable Object class. */
  application: string;
  /** Registry repository the engine image is copied into (same name). */
  repository: string;
}>;

export type SecurityScannerNames = Readonly<{
  worker: string;
  application: string;
  gate: string;
  engines: Readonly<Record<SecurityImageEngine, SecurityScannerEngineNames>>;
  /** Runtime copies (M30): their dispatch namespace, its outbound Worker, the name prefix. */
  copyNamespace: string;
  copySandbox: string;
  copyPrefix: string;
}>;

/** Ready image refs by engine: what the controller is uploaded with. */
export type SecurityScannerImages = Readonly<Partial<Record<SecurityImageEngine, string>>>;

/** Props on the control binding. The API checks them on every call. */
export type SecurityScannerIdentity = Readonly<{ protocol: 1; installation: string }>;

export type SecurityScannerErrorKind =
  | 'containers_unavailable'
  | 'missing'
  | 'ownership'
  | 'outdated'
  | 'application'
  | 'gate'
  | 'upload';

/** A provisioning step failed; `kind` says which, the message says what to do. */
export class SecurityScannerError extends Error {
  readonly kind: SecurityScannerErrorKind;
  constructor(kind: SecurityScannerErrorKind, message: string) {
    super(message);
    this.name = 'SecurityScannerError';
    this.kind = kind;
  }
}

type Binding = {
  type: string;
  name: string;
  text?: string;
  class_name?: string;
  namespace_id?: string;
  service?: string;
  entrypoint?: string;
};
type WorkerSettings = { bindings: Array<Binding> };

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Names derived per installation, so two installations in one account never share one. */
export async function securityScannerNames(installationKey: string): Promise<SecurityScannerNames> {
  const suffix = (await sha256Hex(`void-security-scanner:${installationKey}`)).slice(0, 12);
  const engine = (slug: string): SecurityScannerEngineNames => ({
    application: `void-security-scanner-${slug}-${suffix}`,
    repository: `void-security-scanner-${slug}-${suffix}`,
  });
  return {
    worker: `void-security-scanner-${suffix}`,
    application: `void-security-scanner-${suffix}`,
    gate: `void-security-scanner-gate-${suffix}`,
    copyNamespace: `void-security-copies-${suffix}`,
    copySandbox: `void-security-copy-sandbox-${suffix}`,
    copyPrefix: runtimeCopyPrefix(suffix),
    engines: {
      agent_sdk: engine(SECURITY_IMAGE_ENGINE_SLUG.agent_sdk),
      codex_sdk: engine(SECURITY_IMAGE_ENGINE_SLUG.codex_sdk),
    },
  };
}

export function securityScannerIdentity(installationKey: string): SecurityScannerIdentity {
  return { protocol: PROTOCOL, installation: installationKey };
}

function ownerMarker(installationKey: string): string {
  return JSON.stringify({ protocol: PROTOCOL, installation: installationKey });
}

function workerUrl(accountId: string, name: string): string {
  return `${CF_API_BASE}/${accountId}/workers/scripts/${name}`;
}

function gateUrl(target: SecurityScannerTarget, name: string): string {
  return `${CF_API_BASE}/${target.accountId}/workers/dispatch/namespaces/${target.dispatchNamespace}/scripts/${name}`;
}

async function readSettings(
  target: SecurityScannerTarget,
  name: string,
): Promise<WorkerSettings | undefined> {
  try {
    return await cfFetch<WorkerSettings>(
      `${workerUrl(target.accountId, name)}/settings`,
      target.apiToken,
    );
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

function plainText(
  settings: { bindings: ReadonlyArray<Binding> },
  name: string,
): string | undefined {
  return settings.bindings.find((binding) => binding.type === 'plain_text' && binding.name === name)
    ?.text;
}

function assertOwnership(settings: WorkerSettings, target: SecurityScannerTarget): void {
  if (plainText(settings, OWNER_BINDING) !== ownerMarker(target.installationKey)) {
    throw new SecurityScannerError(
      'ownership',
      'A Worker with the security scanner name exists but does not belong to this installation; refusing to change it.',
    );
  }
}

function findNamespace(
  settings: WorkerSettings,
  binding: string,
  className: string,
): string | undefined {
  return settings.bindings.find(
    (candidate) =>
      candidate.type === 'durable_object_namespace' &&
      candidate.name === binding &&
      candidate.class_name === className,
  )?.namespace_id;
}

function namespaceId(settings: WorkerSettings, engine?: SecurityImageEngine): string {
  const id = engine
    ? findNamespace(
        settings,
        SECURITY_SCANNER_ENGINE_BINDING[engine],
        SECURITY_SCANNER_ENGINE_CLASS[engine],
      )
    : findNamespace(settings, SECURITY_SCANNER_BINDING, SECURITY_SCANNER_CLASS);
  if (!id) {
    throw new SecurityScannerError(
      'missing',
      'The security scanner controller has no Durable Object namespace.',
    );
  }
  return id;
}

/** A controller from before M13b has only the Engine B class; its update adds the others. */
function hasEngineClasses(settings: WorkerSettings): boolean {
  return SECURITY_IMAGE_ENGINES.every(
    (engine) =>
      findNamespace(
        settings,
        SECURITY_SCANNER_ENGINE_BINDING[engine],
        SECURITY_SCANNER_ENGINE_CLASS[engine],
      ) !== undefined,
  );
}

/** Stable text for the images binding: engines in a fixed order. */
export function securityScannerImagesText(images: SecurityScannerImages): string {
  return JSON.stringify(
    Object.fromEntries(
      SECURITY_IMAGE_ENGINES.flatMap((engine) => {
        const ref = images[engine];
        return ref ? [[engine, ref]] : [];
      }),
    ),
  );
}

/** The engine images an uploaded controller runs (its images binding); unreadable = none. */
export function deployedSecurityScannerImages(settings: {
  bindings: ReadonlyArray<Binding>;
}): SecurityScannerImages {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plainText(settings, SECURITY_SCANNER_IMAGES_BINDING) ?? '{}');
  } catch {
    return {};
  }
  const images: Partial<Record<SecurityImageEngine, string>> = {};
  for (const engine of SECURITY_IMAGE_ENGINES) {
    const ref = (parsed as Record<string, unknown> | null)?.[engine];
    if (typeof ref === 'string') {
      images[engine] = ref;
    }
  }
  return images;
}

/** Same code and same authority binding (props are never echoed by `/settings`). */
function codeIsCurrent(
  settings: WorkerSettings,
  target: SecurityScannerTarget,
  digest: string,
  names: SecurityScannerNames,
): boolean {
  const control = settings.bindings.find(
    (binding) => binding.type === 'service' && binding.name === SECURITY_SCANNER_CONTROL_BINDING,
  );
  return (
    plainText(settings, SOURCE_BINDING) === digest &&
    plainText(settings, COPY_PREFIX_BINDING) === names.copyPrefix &&
    hasEngineClasses(settings) &&
    control?.service === target.apiService &&
    control.entrypoint === SECURITY_SCANNER_CONTROL_ENTRYPOINT
  );
}

/** Current code, running exactly these engine images. */
function isCurrent(
  settings: WorkerSettings,
  target: SecurityScannerTarget,
  digest: string,
  images: SecurityScannerImages,
  names: SecurityScannerNames,
): boolean {
  return (
    codeIsCurrent(settings, target, digest, names) &&
    plainText(settings, SECURITY_SCANNER_IMAGES_BINDING) === securityScannerImagesText(images)
  );
}

/** Every image in `wanted` runs in `deployed` (it may run more). */
function covers(deployed: SecurityScannerImages, wanted: SecurityScannerImages): boolean {
  return SECURITY_IMAGE_ENGINES.every(
    (engine) => wanted[engine] === undefined || deployed[engine] === wanted[engine],
  );
}

/**
 * The images to upload: those already deployed at a still-current ref (`keep`), plus the
 * ones made ready now. A deployed image leaves only when its release pin changes (its
 * ref is no longer in `keep`) or on uninstall, never because one probe step failed.
 */
function mergeImages(
  deployed: SecurityScannerImages,
  ready: SecurityScannerImages,
  keep: SecurityScannerImages,
): SecurityScannerImages {
  const images: Partial<Record<SecurityImageEngine, string>> = {};
  for (const engine of SECURITY_IMAGE_ENGINES) {
    const ref =
      ready[engine] ??
      (deployed[engine] !== undefined && deployed[engine] === keep[engine]
        ? deployed[engine]
        : undefined);
    if (ref !== undefined) {
      images[engine] = ref;
    }
  }
  return images;
}

/** The class migration: all classes on create; the engine classes on an older controller. */
function migrationFor(settings: WorkerSettings | undefined): Record<string, unknown> {
  const engineClasses = SECURITY_IMAGE_ENGINES.map(
    (engine) => SECURITY_SCANNER_ENGINE_CLASS[engine],
  );
  if (!settings) {
    return {
      migrations: {
        new_tag: 'v1',
        steps: [{ new_sqlite_classes: [SECURITY_SCANNER_CLASS, ...engineClasses] }],
      },
    };
  }
  if (!hasEngineClasses(settings)) {
    return {
      migrations: {
        old_tag: 'v1',
        new_tag: 'v2',
        steps: [{ new_sqlite_classes: engineClasses }],
      },
    };
  }
  // Updates keep the tag.
  return {};
}

async function uploadController(
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
  source: string,
  digest: string,
  existing: WorkerSettings | undefined,
  images: SecurityScannerImages,
): Promise<void> {
  const create = !existing;
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2026-09-01',
    bindings: [
      {
        type: 'durable_object_namespace',
        name: SECURITY_SCANNER_BINDING,
        class_name: SECURITY_SCANNER_CLASS,
      },
      ...SECURITY_IMAGE_ENGINES.map((engine) => ({
        type: 'durable_object_namespace',
        name: SECURITY_SCANNER_ENGINE_BINDING[engine],
        class_name: SECURITY_SCANNER_ENGINE_CLASS[engine],
      })),
      {
        type: 'service',
        name: SECURITY_SCANNER_CONTROL_BINDING,
        service: target.apiService,
        entrypoint: SECURITY_SCANNER_CONTROL_ENTRYPOINT,
        props: securityScannerIdentity(target.installationKey),
      },
      { type: 'plain_text', name: OWNER_BINDING, text: ownerMarker(target.installationKey) },
      { type: 'plain_text', name: SOURCE_BINDING, text: digest },
      {
        type: 'plain_text',
        name: SECURITY_SCANNER_IMAGES_BINDING,
        text: securityScannerImagesText(images),
      },
      // Runtime copies (M30): the only way into a copy, with the sandbox as its
      // outbound Worker, so every global fetch of a copy ends there.
      {
        type: 'dispatch_namespace',
        name: COPY_NAMESPACE_BINDING,
        namespace: names.copyNamespace,
        outbound: { worker: { service: names.copySandbox } },
      },
      { type: 'plain_text', name: COPY_PREFIX_BINDING, text: names.copyPrefix },
    ],
    ...migrationFor(existing),
    containers: [
      // Engine B runs the managed image; no registry image is needed (design doc 0095, R1).
      { class_name: SECURITY_SCANNER_CLASS, name: names.application, images: {} },
      // Engines A and C run their copied image, once it is ready.
      ...SECURITY_IMAGE_ENGINES.flatMap((engine) => {
        const ref = images[engine];
        return ref
          ? [
              {
                class_name: SECURITY_SCANNER_ENGINE_CLASS[engine],
                name: names.engines[engine].application,
                images: { default: ref },
              },
            ]
          : [];
      }),
    ],
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    'index.js',
    new Blob([source], { type: 'application/javascript+module' }),
    'index.js',
  );
  const response = await fetch(workerUrl(target.accountId, names.worker), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${target.apiToken}`,
      ...(create ? { 'If-None-Match': '*' } : {}),
    },
    body: form,
  });
  // 409/412 on create: another probe created it first; the re-read below checks it.
  if (!response.ok && !(create && (response.status === 409 || response.status === 412))) {
    throw new SecurityScannerError(
      'upload',
      `Security scanner controller upload failed (HTTP ${response.status}): ${(await response.text()).slice(0, 500)}`,
    );
  }
}

async function readGateBindings(
  target: SecurityScannerTarget,
  name: string,
): Promise<ReadonlyArray<Binding> | undefined> {
  // A GET of a missing dispatch script answers 200 with `script: null`, not 404, so
  // read the bindings directly: they answer 404 when the gate does not exist.
  try {
    return await cfFetch<ReadonlyArray<Binding>>(
      `${gateUrl(target, name)}/bindings`,
      target.apiToken,
    );
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

function gateIsCurrent(
  bindings: ReadonlyArray<Binding>,
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
): boolean {
  const service = bindings.find(
    (binding) => binding.type === 'service' && binding.name === GATE_SERVICE_BINDING,
  );
  return (
    plainText({ bindings: [...bindings] }, OWNER_BINDING) === ownerMarker(target.installationKey) &&
    service?.service === names.worker
  );
}

async function ensureGate(
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
): Promise<void> {
  const bindings = await readGateBindings(target, names.gate);
  if (bindings && gateIsCurrent(bindings, target, names)) {
    return;
  }
  // Only our own gate is replaced (an older one of ours is updated); one with no marker
  // or another installation's marker is left alone, as `deleteSecurityScanner` does.
  if (
    bindings &&
    plainText({ bindings: [...bindings] }, OWNER_BINDING) !== ownerMarker(target.installationKey)
  ) {
    throw new SecurityScannerError(
      'ownership',
      'A dispatch script with the security scanner gate name exists but does not belong to this installation; refusing to change it.',
    );
  }
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2026-09-01',
    bindings: [
      { type: 'service', name: GATE_SERVICE_BINDING, service: names.worker },
      { type: 'plain_text', name: OWNER_BINDING, text: ownerMarker(target.installationKey) },
    ],
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    'index.js',
    new Blob([SECURITY_SCANNER_GATE_SOURCE], { type: 'application/javascript+module' }),
    'index.js',
  );
  const response = await fetch(gateUrl(target, names.gate), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${target.apiToken}` },
    body: form,
  });
  if (!response.ok) {
    throw new SecurityScannerError(
      'gate',
      `Security scanner gate upload failed (HTTP ${response.status}).`,
    );
  }
}

function namespaceUrl(target: SecurityScannerTarget, name: string): string {
  return `${CF_API_BASE}/${target.accountId}/workers/dispatch/namespaces/${name}`;
}

/**
 * The runtime copies' dispatch namespace and the copy sandbox (M30): the namespace's
 * outbound Worker and the stubs a copy's platform and queue bindings point at. The
 * sandbox has no workers.dev route, no secret and keeps no data. Both are made before
 * the controller is uploaded, since its dispatch binding names them.
 */
export async function ensureSecurityCopyInfrastructure(
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
): Promise<void> {
  try {
    await cfFetch(namespaceUrl(target, names.copyNamespace), target.apiToken);
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 404)) {
      throw error;
    }
    try {
      await cfFetch(
        `${CF_API_BASE}/${target.accountId}/workers/dispatch/namespaces`,
        target.apiToken,
        {
          method: 'POST',
          body: JSON.stringify({ name: names.copyNamespace }),
        },
      );
    } catch (createError) {
      // Another probe created it in between.
      if (!(createError instanceof CloudflareApiError && createError.status === 409)) {
        throw createError;
      }
    }
  }
  const digest = await sha256Hex(COPY_SANDBOX_SOURCE);
  const settings = await readSettings(target, names.copySandbox);
  if (settings) {
    assertOwnership(settings, target);
    if (plainText(settings, SOURCE_BINDING) === digest) {
      return;
    }
  }
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2026-09-01',
    bindings: [
      { type: 'plain_text', name: OWNER_BINDING, text: ownerMarker(target.installationKey) },
      { type: 'plain_text', name: SOURCE_BINDING, text: digest },
    ],
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    'index.js',
    new Blob([COPY_SANDBOX_SOURCE], { type: 'application/javascript+module' }),
    'index.js',
  );
  const response = await fetch(workerUrl(target.accountId, names.copySandbox), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${target.apiToken}` },
    body: form,
  });
  if (!response.ok) {
    throw new SecurityScannerError(
      'upload',
      `Security copy sandbox upload failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }
  await cfFetch(`${workerUrl(target.accountId, names.copySandbox)}/subdomain`, target.apiToken, {
    method: 'POST',
    body: JSON.stringify({ enabled: false, previews_enabled: false }),
  });
}

/**
 * Uninstall of the copy side: every copy script in the namespace, the namespace, then
 * the sandbox. Copy stores are deleted by the caller's sweep first.
 */
async function deleteSecurityCopyInfrastructure(
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
): Promise<void> {
  const sandbox = await readSettings(target, names.copySandbox);
  if (sandbox) {
    assertOwnership(sandbox, target);
  }
  const namespace = await fetch(namespaceUrl(target, names.copyNamespace), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${target.apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!namespace.ok && namespace.status !== 404) {
    throw new SecurityScannerError(
      'upload',
      `Security copy namespace deletion failed (HTTP ${namespace.status}).`,
    );
  }
  if (!sandbox) {
    return;
  }
  const deleted = await fetch(workerUrl(target.accountId, names.copySandbox), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${target.apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!deleted.ok && deleted.status !== 404) {
    throw new SecurityScannerError(
      'upload',
      `Security copy sandbox deletion failed (HTTP ${deleted.status}).`,
    );
  }
}

/** The account can run Cloudflare Containers with this token (checked before anything else). */
export async function assertSecurityScannerContainers(
  target: SecurityScannerTarget,
): Promise<void> {
  try {
    await cfFetch(`${CF_API_BASE}/${target.accountId}/containers/applications`, target.apiToken);
  } catch (error) {
    throw new SecurityScannerError(
      'containers_unavailable',
      `Cloudflare Containers could not be listed (${error instanceof Error ? error.message : 'error'}).`,
    );
  }
}

/** Uploads tried when another probe's upload lands in between (each adds its images). */
const UPLOAD_ATTEMPTS = 3;

/**
 * Makes sure the controller (current bundle, with its engine images), its container
 * applications and the gate exist. Idempotent; the probe runs it before its self-tests.
 * `images` are the engine images made ready by this run. An engine image the controller
 * already runs stays when its ref is in `options.keep` (the current release pins); an
 * engine with no image has no container application and the controller refuses its scans.
 * Two probes at once converge: each re-reads after its upload and uploads again until the
 * controller runs at least its own images.
 */
export async function provisionSecurityScanner(
  target: SecurityScannerTarget,
  images: SecurityScannerImages = {},
  options: Readonly<{ keep?: SecurityScannerImages }> = {},
): Promise<
  Readonly<{
    names: SecurityScannerNames;
    applicationId: string;
    engineApplicationIds: Readonly<Partial<Record<SecurityImageEngine, string>>>;
    /** The engine images the controller now runs. */
    images: SecurityScannerImages;
  }>
> {
  const keep = options.keep ?? {};
  const names = await securityScannerNames(target.installationKey);
  await assertSecurityScannerContainers(target);
  const source = getSecurityScannerControllerSource();
  const digest = await sha256Hex(source);
  let settings = await readSettings(target, names.worker);
  if (settings) {
    assertOwnership(settings, target);
  }
  // The copy namespace and its outbound Worker exist before the controller binds them.
  await ensureSecurityCopyInfrastructure(target, names);
  let wanted = mergeImages(settings ? deployedSecurityScannerImages(settings) : {}, images, keep);
  for (
    let attempt = 1;
    !settings || !isCurrent(settings, target, digest, wanted, names);
    attempt++
  ) {
    await uploadController(target, names, source, digest, settings, wanted);
    settings = await readSettings(target, names.worker);
    if (!settings) {
      throw new SecurityScannerError(
        'missing',
        'The security scanner controller was not visible after upload. Run the probe again.',
      );
    }
    assertOwnership(settings, target);
    const deployed = deployedSecurityScannerImages(settings);
    if (codeIsCurrent(settings, target, digest, names) && covers(deployed, wanted)) {
      // Another probe may have added an image in between; keep what runs.
      wanted = deployed;
      break;
    }
    if (attempt >= UPLOAD_ATTEMPTS) {
      throw new SecurityScannerError(
        'outdated',
        'The security scanner controller differs from this platform release after upload. Run the probe again.',
      );
    }
    wanted = mergeImages(deployed, wanted, keep);
  }
  const running = wanted;
  await cfFetch(`${workerUrl(target.accountId, names.worker)}/subdomain`, target.apiToken, {
    method: 'POST',
    body: JSON.stringify({ enabled: false, previews_enabled: false }),
  });
  const applicationId = await ensureApplication(target, names.application, namespaceId(settings));
  const engineApplicationIds: Partial<Record<SecurityImageEngine, string>> = {};
  for (const engine of SECURITY_IMAGE_ENGINES) {
    if (running[engine]) {
      engineApplicationIds[engine] = await ensureApplication(
        target,
        names.engines[engine].application,
        namespaceId(settings, engine),
      );
    }
  }
  await ensureGate(target, names);
  return { names, applicationId, engineApplicationIds, images: running };
}

async function ensureApplication(
  target: SecurityScannerTarget,
  name: string,
  namespace: string,
): Promise<string> {
  const created = await tryCreateContainerApplication(target.accountId, target.apiToken, {
    name,
    namespaceId: namespace,
  });
  const application =
    created ?? (await findContainerApplication(target.accountId, target.apiToken, name));
  assertApplication(application, namespace);
  return application.id;
}

function assertApplication(
  application: ContainerApplicationInfo | undefined,
  namespace: string,
): asserts application is ContainerApplicationInfo {
  if (!application || application.durable_objects?.namespace_id !== namespace) {
    throw new SecurityScannerError(
      'application',
      'The security scanner container application is missing or belongs to another Durable Object namespace.',
    );
  }
}

/** Read-only check that everything `provisionSecurityScanner` makes is in place. */
export async function verifySecurityScanner(
  target: SecurityScannerTarget,
  images: SecurityScannerImages = {},
): Promise<void> {
  const names = await securityScannerNames(target.installationKey);
  const settings = await readSettings(target, names.worker);
  if (!settings) {
    throw new SecurityScannerError('missing', 'The security scanner controller is missing.');
  }
  assertOwnership(settings, target);
  if (
    !isCurrent(
      settings,
      target,
      await sha256Hex(getSecurityScannerControllerSource()),
      images,
      names,
    )
  ) {
    throw new SecurityScannerError(
      'outdated',
      'The security scanner controller is from another platform release.',
    );
  }
  assertApplication(
    await findContainerApplication(target.accountId, target.apiToken, names.application),
    namespaceId(settings),
  );
  for (const engine of SECURITY_IMAGE_ENGINES) {
    if (images[engine]) {
      assertApplication(
        await findContainerApplication(
          target.accountId,
          target.apiToken,
          names.engines[engine].application,
        ),
        namespaceId(settings, engine),
      );
    }
  }
  const gate = await readGateBindings(target, names.gate);
  if (!gate || !gateIsCurrent(gate, target, names)) {
    throw new SecurityScannerError('gate', 'The security scanner gate is missing or changed.');
  }
}

/**
 * Uninstall: the gate first (nothing can call in), then the billable container
 * applications (one per engine), then the controller Worker, then the engine images
 * copied into the account registry. A container application whose controller is gone
 * cannot be proven ours, so it is left for the operator.
 */
export async function deleteSecurityScanner(target: SecurityScannerTarget): Promise<void> {
  const names = await securityScannerNames(target.installationKey);
  const settings = await readSettings(target, names.worker);
  const applications = await Promise.all(
    [
      { engine: undefined, name: names.application },
      ...SECURITY_IMAGE_ENGINES.map((engine) => ({
        engine,
        name: names.engines[engine].application,
      })),
    ].map(async (entry) => ({
      ...entry,
      application: await findContainerApplication(target.accountId, target.apiToken, entry.name),
    })),
  );
  if (settings) {
    assertOwnership(settings, target);
  } else if (applications.some((entry) => entry.application)) {
    throw new SecurityScannerError(
      'ownership',
      'Cannot verify ownership of a security scanner container application whose controller is missing.',
    );
  }
  const gate = await readGateBindings(target, names.gate);
  if (gate) {
    if (plainText({ bindings: [...gate] }, OWNER_BINDING) !== ownerMarker(target.installationKey)) {
      throw new SecurityScannerError(
        'ownership',
        'The security scanner gate does not belong to this installation; refusing to delete it.',
      );
    }
    const deleted = await fetch(gateUrl(target, names.gate), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${target.apiToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!deleted.ok && deleted.status !== 404) {
      throw new SecurityScannerError(
        'gate',
        `Security scanner gate deletion failed (HTTP ${deleted.status}).`,
      );
    }
  }
  const repositories = SECURITY_IMAGE_ENGINES.map((engine) => names.engines[engine].repository);
  if (!settings) {
    // A run whose image or copy cleanup failed after the controller was deleted: these
    // are named per installation, so a retry still removes them.
    await deleteSecurityCopies(target, names);
    await deleteSecurityScannerImages(target, repositories);
    return;
  }
  for (const { engine, application } of applications) {
    if (!application) {
      continue;
    }
    const namespace = engine
      ? findNamespace(
          settings,
          SECURITY_SCANNER_ENGINE_BINDING[engine],
          SECURITY_SCANNER_ENGINE_CLASS[engine],
        )
      : namespaceId(settings);
    if (namespace === undefined || application.durable_objects?.namespace_id !== namespace) {
      throw new SecurityScannerError(
        'application',
        'Refusing to delete a security scanner container application of another namespace.',
      );
    }
    await deleteContainerApplicationIdempotent(target.accountId, target.apiToken, application.id);
  }
  const response = await fetch(workerUrl(target.accountId, names.worker), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${target.apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new SecurityScannerError(
      'upload',
      `Security scanner controller deletion failed (HTTP ${response.status}).`,
    );
  }
  await deleteSecurityCopies(target, names);
  // The copied engine images: storage the installation no longer needs.
  await deleteSecurityScannerImages(target, repositories);
}

/** Every runtime copy (scripts, then stores), the copy namespace and the sandbox. */
async function deleteSecurityCopies(
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
): Promise<void> {
  await sweepSecurityRuntimeCopies(
    {
      accountId: target.accountId,
      apiToken: target.apiToken,
      namespace: names.copyNamespace,
      sandbox: names.copySandbox,
      prefix: names.copyPrefix,
    },
    new Set(),
  );
  await deleteSecurityCopyInfrastructure(target, names);
}
