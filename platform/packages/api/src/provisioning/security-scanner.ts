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
 */
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import type { ApiEnv } from '../env.ts';
import { getSecurityScannerControllerSource } from '../security-scanner-controller-source.ts';
import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  tryCreateContainerApplication,
  type ContainerApplicationInfo,
} from './containers.ts';

export const SECURITY_SCANNER_CLASS = 'ScannerController';
export const SECURITY_SCANNER_BINDING = 'SCANNER';
export const SECURITY_SCANNER_CONTROL_BINDING = '__VOID_SECURITY_SCAN_CONTROL';
export const SECURITY_SCANNER_CONTROL_ENTRYPOINT = 'SecurityScanControl';
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

export type SecurityScannerNames = Readonly<{
  worker: string;
  application: string;
  gate: string;
}>;

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
  return {
    worker: `void-security-scanner-${suffix}`,
    application: `void-security-scanner-${suffix}`,
    gate: `void-security-scanner-gate-${suffix}`,
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

function namespaceId(settings: WorkerSettings): string {
  const binding = settings.bindings.find(
    (candidate) =>
      candidate.type === 'durable_object_namespace' &&
      candidate.name === SECURITY_SCANNER_BINDING &&
      candidate.class_name === SECURITY_SCANNER_CLASS,
  );
  if (!binding?.namespace_id) {
    throw new SecurityScannerError(
      'missing',
      'The security scanner controller has no Durable Object namespace.',
    );
  }
  return binding.namespace_id;
}

/** Same upload, same code, same authority binding (props are never echoed by `/settings`). */
function isCurrent(
  settings: WorkerSettings,
  target: SecurityScannerTarget,
  digest: string,
): boolean {
  const control = settings.bindings.find(
    (binding) => binding.type === 'service' && binding.name === SECURITY_SCANNER_CONTROL_BINDING,
  );
  return (
    plainText(settings, SOURCE_BINDING) === digest &&
    control?.service === target.apiService &&
    control.entrypoint === SECURITY_SCANNER_CONTROL_ENTRYPOINT
  );
}

async function uploadController(
  target: SecurityScannerTarget,
  names: SecurityScannerNames,
  source: string,
  digest: string,
  create: boolean,
): Promise<void> {
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2026-09-01',
    bindings: [
      {
        type: 'durable_object_namespace',
        name: SECURITY_SCANNER_BINDING,
        class_name: SECURITY_SCANNER_CLASS,
      },
      {
        type: 'service',
        name: SECURITY_SCANNER_CONTROL_BINDING,
        service: target.apiService,
        entrypoint: SECURITY_SCANNER_CONTROL_ENTRYPOINT,
        props: securityScannerIdentity(target.installationKey),
      },
      { type: 'plain_text', name: OWNER_BINDING, text: ownerMarker(target.installationKey) },
      { type: 'plain_text', name: SOURCE_BINDING, text: digest },
    ],
    // The class migration ships with the first upload only; updates keep its tag.
    ...(create
      ? { migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: [SECURITY_SCANNER_CLASS] }] } }
      : {}),
    // Engine B runs the managed image; no registry image is needed (design doc 0095, R1).
    containers: [{ class_name: SECURITY_SCANNER_CLASS, name: names.application, images: {} }],
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
  try {
    await cfFetch(gateUrl(target, name), target.apiToken);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
  return cfFetch<ReadonlyArray<Binding>>(`${gateUrl(target, name)}/bindings`, target.apiToken);
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

/**
 * Makes sure the controller (current bundle), its container application and the gate
 * exist. Idempotent; the probe runs it before its self-test.
 */
export async function provisionSecurityScanner(
  target: SecurityScannerTarget,
): Promise<Readonly<{ names: SecurityScannerNames; applicationId: string }>> {
  const names = await securityScannerNames(target.installationKey);
  try {
    await cfFetch(`${CF_API_BASE}/${target.accountId}/containers/applications`, target.apiToken);
  } catch (error) {
    throw new SecurityScannerError(
      'containers_unavailable',
      `Cloudflare Containers could not be listed (${error instanceof Error ? error.message : 'error'}).`,
    );
  }
  const source = getSecurityScannerControllerSource();
  const digest = await sha256Hex(source);
  let settings = await readSettings(target, names.worker);
  if (settings) {
    assertOwnership(settings, target);
  }
  if (!settings || !isCurrent(settings, target, digest)) {
    await uploadController(target, names, source, digest, !settings);
    settings = await readSettings(target, names.worker);
    if (!settings) {
      throw new SecurityScannerError(
        'missing',
        'The security scanner controller was not visible after upload. Run the probe again.',
      );
    }
    assertOwnership(settings, target);
    if (!isCurrent(settings, target, digest)) {
      throw new SecurityScannerError(
        'outdated',
        'The security scanner controller differs from this platform release after upload. Run the probe again.',
      );
    }
  }
  await cfFetch(`${workerUrl(target.accountId, names.worker)}/subdomain`, target.apiToken, {
    method: 'POST',
    body: JSON.stringify({ enabled: false, previews_enabled: false }),
  });
  const namespace = namespaceId(settings);
  const created = await tryCreateContainerApplication(target.accountId, target.apiToken, {
    name: names.application,
    namespaceId: namespace,
  });
  const application =
    created ??
    (await findContainerApplication(target.accountId, target.apiToken, names.application));
  assertApplication(application, namespace);
  await ensureGate(target, names);
  return { names, applicationId: application.id };
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
export async function verifySecurityScanner(target: SecurityScannerTarget): Promise<void> {
  const names = await securityScannerNames(target.installationKey);
  const settings = await readSettings(target, names.worker);
  if (!settings) {
    throw new SecurityScannerError('missing', 'The security scanner controller is missing.');
  }
  assertOwnership(settings, target);
  if (!isCurrent(settings, target, await sha256Hex(getSecurityScannerControllerSource()))) {
    throw new SecurityScannerError(
      'outdated',
      'The security scanner controller is from another platform release.',
    );
  }
  assertApplication(
    await findContainerApplication(target.accountId, target.apiToken, names.application),
    namespaceId(settings),
  );
  const gate = await readGateBindings(target, names.gate);
  if (!gate || !gateIsCurrent(gate, target, names)) {
    throw new SecurityScannerError('gate', 'The security scanner gate is missing or changed.');
  }
}

/**
 * Uninstall: the gate first (nothing can call in), then the billable container
 * application, then the controller Worker. A container application whose controller
 * is gone cannot be proven ours, so it is left for the operator.
 */
export async function deleteSecurityScanner(target: SecurityScannerTarget): Promise<void> {
  const names = await securityScannerNames(target.installationKey);
  const settings = await readSettings(target, names.worker);
  const application = await findContainerApplication(
    target.accountId,
    target.apiToken,
    names.application,
  );
  if (settings) {
    assertOwnership(settings, target);
  } else if (application) {
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
  if (!settings) {
    return;
  }
  if (application) {
    if (application.durable_objects?.namespace_id !== namespaceId(settings)) {
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
}
