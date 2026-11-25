/**
 * Provision the installation's security scanner (design doc 0095, spec §5.1): one
 * controller Worker with its container applications, plus a small gate script in the
 * platform dispatch namespace. The API reaches the controller only through
 * `env.DISPATCH.get(gate)`; the controller has no workers.dev route.
 *
 *   API ──DISPATCH──► gate (dispatch script) ──service──► controller Worker ──► container app
 *        ◄────────── SecurityScanControl (service binding, props = installation) ──┘
 *
 * Like `sandbox-controller.ts`: create with `If-None-Match: *`, an ownership marker,
 * workers.dev off, and a container application tied to the controller's Durable Object
 * namespace. Unlike Sandbox controllers, this one is shared and is re-uploaded when a
 * platform release ships a new controller bundle.
 *
 * One Durable Object class and container application per engine: Engine B runs the
 * managed image; Engines A and C run their own image, copied by digest into this
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
import { SECURITY_IMAGE_ENGINE_SLUG, SECURITY_IMAGE_ENGINES } from '../security/scanner-images.ts';
import type { SecurityImageEngine } from '../security/scanner-images.ts';
import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';
import { findContainerApplication, tryCreateContainerApplication } from './containers.ts';

/** The Durable Object class and binding of Engine B and of each image engine. */
const ENGINE_B_CLASS = { binding: 'SCANNER', className: 'ScannerController' };
const ENGINE_CLASSES: Readonly<
  Record<SecurityImageEngine, Readonly<{ binding: string; className: string }>>
> = {
  agent_sdk: { binding: 'SCANNER_ENGINE_A', className: 'ScannerControllerEngineA' },
  codex_sdk: { binding: 'SCANNER_ENGINE_C', className: 'ScannerControllerEngineC' },
};
const CONTROL_BINDING = '__VOID_SECURITY_SCAN_CONTROL';
const CONTROL_ENTRYPOINT = 'SecurityScanControl';
/** JSON `{engine: ref}` of the images the controller may run; the controller reads it. */
const IMAGES_BINDING = '__VOID_SECURITY_SCANNER_IMAGES';
const OWNER_BINDING = '__VOID_SECURITY_SCANNER_OWNER';
const SOURCE_BINDING = '__VOID_SECURITY_SCANNER_SOURCE';
const GATE_SERVICE_BINDING = 'SCANNER';
const PROTOCOL = 1;

/** The gate only forwards; it holds no secret and no logic. */
const GATE_SOURCE =
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

export type SecurityScannerNames = Readonly<{
  worker: string;
  application: string;
  gate: string;
  /** Per image engine: its container application and the registry repository (same name). */
  engines: Readonly<
    Record<SecurityImageEngine, Readonly<{ application: string; repository: string }>>
  >;
  /** Runtime copies (M30): their dispatch namespace, its outbound Worker, the name prefix. */
  copyNamespace: string;
  copySandbox: string;
  copyPrefix: string;
}>;

/** Ready image refs by engine: what the controller is uploaded with. */
export type SecurityScannerImages = Readonly<Partial<Record<SecurityImageEngine, string>>>;

/** Props on the control binding. The API checks them on every call. */
export type SecurityScannerIdentity = Readonly<{ protocol: 1; installation: string }>;

/** A provisioning step failed; `kind` says which, the message says what to do. */
export class SecurityScannerError extends Error {
  readonly kind:
    | 'containers_unavailable'
    | 'missing'
    | 'ownership'
    | 'outdated'
    | 'application'
    | 'gate'
    | 'upload';
  constructor(kind: SecurityScannerError['kind'], message: string) {
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Names derived per installation, so two installations in one account never share one. */
export async function securityScannerNames(installationKey: string): Promise<SecurityScannerNames> {
  const suffix = (await sha256Hex(`void-security-scanner:${installationKey}`)).slice(0, 12);
  const engine = (slug: string) => ({
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

/** A read that answers 404 is a missing resource. */
async function orMissing<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function readBindings(
  target: SecurityScannerTarget,
  name: string,
): Promise<ReadonlyArray<Binding> | undefined> {
  const settings = await orMissing(
    cfFetch<{ bindings: Array<Binding> }>(
      `${workerUrl(target.accountId, name)}/settings`,
      target.apiToken,
    ),
  );
  return settings?.bindings;
}

function plainText(bindings: ReadonlyArray<Binding>, name: string): string | undefined {
  return bindings.find((binding) => binding.type === 'plain_text' && binding.name === name)?.text;
}

function owned(bindings: ReadonlyArray<Binding>, target: SecurityScannerTarget): boolean {
  return plainText(bindings, OWNER_BINDING) === ownerMarker(target.installationKey);
}

function assertOwnership(bindings: ReadonlyArray<Binding>, target: SecurityScannerTarget): void {
  if (!owned(bindings, target)) {
    throw new SecurityScannerError(
      'ownership',
      'A Worker with the security scanner name exists but does not belong to this installation; refusing to change it.',
    );
  }
}

/** The Durable Object namespace of Engine B's class, or of an image engine's class. */
function findNamespace(
  bindings: ReadonlyArray<Binding>,
  engine?: SecurityImageEngine,
): string | undefined {
  const { binding, className } = engine ? ENGINE_CLASSES[engine] : ENGINE_B_CLASS;
  return bindings.find(
    (candidate) =>
      candidate.type === 'durable_object_namespace' &&
      candidate.name === binding &&
      candidate.class_name === className,
  )?.namespace_id;
}

function namespaceId(bindings: ReadonlyArray<Binding>, engine?: SecurityImageEngine): string {
  const id = findNamespace(bindings, engine);
  if (!id) {
    throw new SecurityScannerError(
      'missing',
      'The security scanner controller has no Durable Object namespace.',
    );
  }
  return id;
}

/** A controller from before the engine images has only the Engine B class; its update adds the others. */
function hasEngineClasses(bindings: ReadonlyArray<Binding>): boolean {
  return SECURITY_IMAGE_ENGINES.every((engine) => findNamespace(bindings, engine) !== undefined);
}

/** Stable text for the images binding: engines in a fixed order. */
function imagesText(images: SecurityScannerImages): string {
  return JSON.stringify(
    Object.fromEntries(
      SECURITY_IMAGE_ENGINES.flatMap((engine) =>
        images[engine] ? [[engine, images[engine]]] : [],
      ),
    ),
  );
}

/** The engine images an uploaded controller runs (its images binding); unreadable = none. */
function deployedImages(bindings: ReadonlyArray<Binding>): SecurityScannerImages {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(plainText(bindings, IMAGES_BINDING) ?? '{}') as Record<
      string,
      unknown
    > | null;
  } catch {
    return {};
  }
  const images: Partial<Record<SecurityImageEngine, string>> = {};
  for (const engine of SECURITY_IMAGE_ENGINES) {
    const ref = parsed?.[engine];
    if (typeof ref === 'string') {
      images[engine] = ref;
    }
  }
  return images;
}

/** Same code and same authority binding (props are never echoed by `/settings`). */
function codeIsCurrent(
  bindings: ReadonlyArray<Binding>,
  target: SecurityScannerTarget,
  digest: string,
  names: SecurityScannerNames,
): boolean {
  const control = bindings.find(
    (binding) => binding.type === 'service' && binding.name === CONTROL_BINDING,
  );
  return (
    plainText(bindings, SOURCE_BINDING) === digest &&
    plainText(bindings, COPY_PREFIX_BINDING) === names.copyPrefix &&
    hasEngineClasses(bindings) &&
    control?.service === target.apiService &&
    control.entrypoint === CONTROL_ENTRYPOINT
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
    const ref = ready[engine] ?? (deployed[engine] === keep[engine] ? deployed[engine] : undefined);
    if (ref !== undefined) {
      images[engine] = ref;
    }
  }
  return images;
}

/** Uploads one script (module `index.js`) with these bindings and extra metadata. */
async function putScript(
  url: string,
  apiToken: string,
  source: string,
  metadata: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.append(
    'metadata',
    new Blob(
      [JSON.stringify({ main_module: 'index.js', compatibility_date: '2026-09-01', ...metadata })],
      { type: 'application/json' },
    ),
  );
  form.append(
    'index.js',
    new Blob([source], { type: 'application/javascript+module' }),
    'index.js',
  );
  return fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}`, ...headers },
    body: form,
  });
}

async function disableWorkersDev(target: SecurityScannerTarget, name: string): Promise<void> {
  await cfFetch(`${workerUrl(target.accountId, name)}/subdomain`, target.apiToken, {
    method: 'POST',
    body: JSON.stringify({ enabled: false, previews_enabled: false }),
  });
}

function ownerBinding(target: SecurityScannerTarget): Binding {
  return { type: 'plain_text', name: OWNER_BINDING, text: ownerMarker(target.installationKey) };
}

async function uploadController(
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
  source: string,
  digest: string,
  existing: ReadonlyArray<Binding> | undefined,
  images: SecurityScannerImages,
): Promise<void> {
  const engineClasses = SECURITY_IMAGE_ENGINES.map((engine) => ENGINE_CLASSES[engine].className);
  // All classes on create; the engine classes on an older controller; updates keep the tag.
  const migrations = !existing
    ? {
        migrations: {
          new_tag: 'v1',
          steps: [{ new_sqlite_classes: [ENGINE_B_CLASS.className, ...engineClasses] }],
        },
      }
    : hasEngineClasses(existing)
      ? {}
      : {
          migrations: {
            old_tag: 'v1',
            new_tag: 'v2',
            steps: [{ new_sqlite_classes: engineClasses }],
          },
        };
  const response = await putScript(
    workerUrl(target.accountId, names.worker),
    target.apiToken,
    source,
    {
      bindings: [
        ...[ENGINE_B_CLASS, ...SECURITY_IMAGE_ENGINES.map((engine) => ENGINE_CLASSES[engine])].map(
          ({ binding, className }) => ({
            type: 'durable_object_namespace',
            name: binding,
            class_name: className,
          }),
        ),
        {
          type: 'service',
          name: CONTROL_BINDING,
          service: target.apiService,
          entrypoint: CONTROL_ENTRYPOINT,
          props: securityScannerIdentity(target.installationKey),
        },
        ownerBinding(target),
        { type: 'plain_text', name: SOURCE_BINDING, text: digest },
        { type: 'plain_text', name: IMAGES_BINDING, text: imagesText(images) },
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
      ...migrations,
      containers: [
        // Engine B runs the managed image; no registry image is needed (design doc 0095, R1).
        { class_name: ENGINE_B_CLASS.className, name: names.application, images: {} },
        ...SECURITY_IMAGE_ENGINES.flatMap((engine) => {
          const ref = images[engine];
          return ref
            ? [
                {
                  class_name: ENGINE_CLASSES[engine].className,
                  name: names.engines[engine].application,
                  images: { default: ref },
                },
              ]
            : [];
        }),
      ],
    },
    existing ? {} : { 'If-None-Match': '*' },
  );
  // 409/412 on create: another probe created it first; the re-read checks it.
  if (!response.ok && !(!existing && (response.status === 409 || response.status === 412))) {
    throw new SecurityScannerError(
      'upload',
      `Security scanner controller upload failed (HTTP ${response.status}): ${(await response.text()).slice(0, 500)}`,
    );
  }
}

async function ensureGate(
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
): Promise<void> {
  // A GET of a missing dispatch script answers 200 with `script: null`, not 404, so
  // read the bindings directly: they answer 404 when the gate does not exist.
  const bindings = await orMissing(
    cfFetch<ReadonlyArray<Binding>>(`${gateUrl(target, names.gate)}/bindings`, target.apiToken),
  );
  if (bindings) {
    // Only our own gate is replaced (an older one of ours is updated).
    if (!owned(bindings, target)) {
      throw new SecurityScannerError(
        'ownership',
        'A dispatch script with the security scanner gate name exists but does not belong to this installation; refusing to change it.',
      );
    }
    const service = bindings.find(
      (binding) => binding.type === 'service' && binding.name === GATE_SERVICE_BINDING,
    );
    if (service?.service === names.worker) {
      return;
    }
  }
  const response = await putScript(gateUrl(target, names.gate), target.apiToken, GATE_SOURCE, {
    bindings: [
      { type: 'service', name: GATE_SERVICE_BINDING, service: names.worker },
      ownerBinding(target),
    ],
  });
  if (!response.ok) {
    throw new SecurityScannerError(
      'gate',
      `Security scanner gate upload failed (HTTP ${response.status}).`,
    );
  }
}

/**
 * The runtime copies' dispatch namespace and the copy sandbox (M30): the namespace's
 * outbound Worker and the stubs a copy's platform and queue bindings point at. The
 * sandbox has no workers.dev route, no secret and keeps no data. Both are made before
 * the controller is uploaded, since its dispatch binding names them.
 */
async function ensureSecurityCopyInfrastructure(
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
): Promise<void> {
  const namespaces = `${CF_API_BASE}/${target.accountId}/workers/dispatch/namespaces`;
  const namespace = await orMissing(
    cfFetch(`${namespaces}/${names.copyNamespace}`, target.apiToken),
  );
  if (namespace === undefined) {
    try {
      await cfFetch(namespaces, target.apiToken, {
        method: 'POST',
        body: JSON.stringify({ name: names.copyNamespace }),
      });
    } catch (error) {
      // Another probe created it in between.
      if (!(error instanceof CloudflareApiError && error.status === 409)) {
        throw error;
      }
    }
  }
  const digest = await sha256Hex(COPY_SANDBOX_SOURCE);
  const bindings = await readBindings(target, names.copySandbox);
  if (bindings) {
    assertOwnership(bindings, target);
    if (plainText(bindings, SOURCE_BINDING) === digest) {
      return;
    }
  }
  const response = await putScript(
    workerUrl(target.accountId, names.copySandbox),
    target.apiToken,
    COPY_SANDBOX_SOURCE,
    {
      bindings: [ownerBinding(target), { type: 'plain_text', name: SOURCE_BINDING, text: digest }],
    },
  );
  if (!response.ok) {
    throw new SecurityScannerError(
      'upload',
      `Security copy sandbox upload failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }
  await disableWorkersDev(target, names.copySandbox);
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
  let bindings = await readBindings(target, names.worker);
  if (bindings) {
    assertOwnership(bindings, target);
  }
  // The copy namespace and its outbound Worker exist before the controller binds them.
  await ensureSecurityCopyInfrastructure(target, names);
  let wanted = mergeImages(bindings ? deployedImages(bindings) : {}, images, keep);
  for (
    let attempt = 1;
    !bindings ||
    !codeIsCurrent(bindings, target, digest, names) ||
    plainText(bindings, IMAGES_BINDING) !== imagesText(wanted);
    attempt++
  ) {
    await uploadController(target, names, source, digest, bindings, wanted);
    bindings = await readBindings(target, names.worker);
    if (!bindings) {
      throw new SecurityScannerError(
        'missing',
        'The security scanner controller was not visible after upload. Run the probe again.',
      );
    }
    assertOwnership(bindings, target);
    const deployed = deployedImages(bindings);
    if (
      codeIsCurrent(bindings, target, digest, names) &&
      // Every image in `wanted` runs (another probe may have added one; keep what runs).
      SECURITY_IMAGE_ENGINES.every(
        (engine) => wanted[engine] === undefined || deployed[engine] === wanted[engine],
      )
    ) {
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
  await disableWorkersDev(target, names.worker);
  const ensureApplication = async (name: string, namespace: string): Promise<string> => {
    const application =
      (await tryCreateContainerApplication(target.accountId, target.apiToken, {
        name,
        namespaceId: namespace,
      })) ?? (await findContainerApplication(target.accountId, target.apiToken, name));
    if (!application || application.durable_objects?.namespace_id !== namespace) {
      throw new SecurityScannerError(
        'application',
        'The security scanner container application is missing or belongs to another Durable Object namespace.',
      );
    }
    return application.id;
  };
  const applicationId = await ensureApplication(names.application, namespaceId(bindings));
  const engineApplicationIds: Partial<Record<SecurityImageEngine, string>> = {};
  for (const engine of SECURITY_IMAGE_ENGINES) {
    if (wanted[engine]) {
      engineApplicationIds[engine] = await ensureApplication(
        names.engines[engine].application,
        namespaceId(bindings, engine),
      );
    }
  }
  await ensureGate(target, names);
  return { names, applicationId, engineApplicationIds, images: wanted };
}
