/**
 * What a scan's runtime copy holds (design doc 0095, M30; spec §8.6). Pure: from the
 * deployment's manifest and the project's secret names to the copy's bindings.
 *
 *   manifest binding        copy
 *   d1 / kv / r2            a new EMPTY store per binding (D1 gets the live schema, no rows)
 *   Durable Objects         the same classes, new and empty (never the live namespace)
 *   queue producers         QueueStub in the copy sandbox (messages dropped)
 *   platform proxy          PlatformStub (AI, email, revalidation answer a stub)
 *   project secrets         fake values; text vars whose name looks secret too
 *   other text vars         kept
 *   hyperdrive, sandbox,    left out (named in `dropped`)
 *   assets, cron, consumers
 */
import { createDeployIntent } from '@void/deploy-core';
import type { SecurityEngine } from '@void/platform/security-models';
import type { DeployManifest } from '../types.ts';
import { runtimeCopyStoreName } from './runtime-copy-names.ts';
import { COPY_ENTRY_MODULE_NAME } from './runtime-copy-sources.ts';

/** Engines whose verify sessions can send requests to the copy (Engine B's own tool loop). */
export const SECURITY_RUNTIME_COPY_ENGINES: ReadonlySet<SecurityEngine> = new Set(['void_loop']);

/** Name words that make a text var a secret in the copy (its value is replaced). */
const SECRET_WORDS = ['SECRET', 'KEY', 'TOKEN', 'PASSWORD', 'CREDENTIAL', 'PRIVATE'] as const;

export const SECURITY_COPY_FAKE_PREFIX = 'void-copy-fake-';

export type SecurityCopyStore = Readonly<{
  kind: 'd1' | 'kv' | 'r2';
  binding: string;
  /** Cloudflare name of the copy's store (D1 name, KV title, R2 bucket). */
  name: string;
}>;

export type SecurityCopySkip = Readonly<{
  kind: 'skip';
  reason: 'no_manifest' | 'static' | 'engine';
}>;

export type SecurityCopyPlan = Readonly<{
  kind: 'copy';
  script: string;
  stores: ReadonlyArray<SecurityCopyStore>;
  /** Binding → class; every class is new in the copy. */
  durableObjects: ReadonlyArray<Readonly<{ binding: string; className: string }>>;
  queues: ReadonlyArray<string>;
  /** Text vars kept as they are. */
  vars: ReadonlyArray<Readonly<{ name: string; value: string }>>;
  /** Names that get a fake value: project secrets and secret-looking vars. */
  fakes: ReadonlyArray<string>;
  /** What the copy leaves out, for the logs and the tests. */
  dropped: ReadonlyArray<string>;
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: ReadonlyArray<string>;
}>;

export function looksSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_WORDS.some((word) => upper.includes(word));
}

function isStatic(manifest: DeployManifest): boolean {
  return manifest.type === 'static' || manifest.type === 'spa' || manifest.static !== undefined;
}

/** Whether a scan of this deployment gets a copy (task `runtime_copy`). */
export function securityRuntimeCopyWanted(
  manifest: DeployManifest | null,
  engine: SecurityEngine,
): boolean {
  try {
    return (
      planSecurityRuntimeCopy(manifest, { engine, script: 'x', secretNames: [] }).kind === 'copy'
    );
  } catch {
    // A manifest this code cannot read: the scan runs static-only, never fails here.
    return false;
  }
}

export function planSecurityRuntimeCopy(
  manifest: DeployManifest | null,
  options: Readonly<{
    engine: SecurityEngine;
    script: string;
    secretNames: ReadonlyArray<string>;
  }>,
): SecurityCopyPlan | SecurityCopySkip {
  if (!SECURITY_RUNTIME_COPY_ENGINES.has(options.engine)) {
    return { kind: 'skip', reason: 'engine' };
  }
  if (!manifest) {
    return { kind: 'skip', reason: 'no_manifest' };
  }
  if (isStatic(manifest)) {
    // Static-only apps have no Worker to run (spec §8.6).
    return { kind: 'skip', reason: 'static' };
  }
  const dropped: Array<string> = [];
  const stores: Array<SecurityCopyStore> = [];
  const queues: Array<string> = [];
  const counts = { d: 0, k: 0, r: 0 };
  const store = (kind: SecurityCopyStore['kind'], binding: string) => {
    const letter = kind === 'd1' ? 'd' : kind === 'kv' ? 'k' : 'r';
    stores.push({
      kind,
      binding,
      name: runtimeCopyStoreName(options.script, letter, counts[letter]++),
    });
  };
  // Older stored manifests may lack `bindings`.
  const intent = createDeployIntent({ ...manifest, bindings: manifest.bindings ?? {} });
  for (const resource of intent.resourcePlan.resources) {
    switch (resource.type) {
      case 'd1':
      case 'kv':
      case 'r2':
        store(resource.type, resource.bindingName);
        break;
      case 'queue':
        queues.push(resource.bindingName);
        break;
      case 'hyperdrive':
        dropped.push(`${resource.bindingName} (hyperdrive)`);
        break;
    }
  }
  const durableObjects = new Map<string, string>();
  for (const route of manifest.websocket?.routes ?? []) {
    durableObjects.set(route.bindingName ?? route.className, route.className);
  }
  const bound = new Set(durableObjects.values());
  for (const className of manifest.websocket?.classes ?? []) {
    if (!bound.has(className)) {
      durableObjects.set(className, className);
    }
  }
  if (manifest.live) {
    durableObjects.set(manifest.live.bindingName, manifest.live.className);
  }
  for (const binding of manifest.durableObjects?.bindings ?? []) {
    // The live app binds its verified namespace; the copy gets the class, new and empty.
    durableObjects.set(binding.bindingName, binding.className);
  }
  if (manifest.sandbox) {
    dropped.push(`${manifest.sandbox.bindingName} (sandbox)`);
  }
  if (manifest.schedules?.length) {
    dropped.push('cron triggers');
  }
  if (manifest.queues?.length) {
    dropped.push('queue consumers');
  }
  const secretNames = new Set(options.secretNames);
  const vars: Array<{ name: string; value: string }> = [];
  const fakes = new Set<string>(secretNames);
  for (const [name, value] of Object.entries(manifest.vars ?? {})) {
    if (secretNames.has(name)) {
      continue;
    }
    if (looksSecretName(name)) {
      fakes.add(name);
    } else {
      vars.push({ name, value });
    }
  }
  return {
    kind: 'copy',
    script: options.script,
    stores,
    durableObjects: [...durableObjects].map(([binding, className]) => ({ binding, className })),
    queues,
    vars,
    fakes: [...fakes].sort(),
    dropped: [...dropped, 'assets'],
    mainModule: manifest.workerMain ?? 'index.js',
    compatibilityDate: manifest.compatibilityDate ?? '2026-02-12',
    compatibilityFlags: manifest.compatibilityFlags ?? ['nodejs_compat'],
  };
}

export type SecurityCopyNames = Readonly<{
  /** The copy sandbox Worker (outbound Worker and stubs). */
  sandbox: string;
}>;

export type SecurityCopyIds = Readonly<{
  /** Store name → its Cloudflare id (D1 uuid, KV namespace id; R2 uses the name). */
  ids: ReadonlyMap<string, string>;
  /** Name → fake value. */
  fakes: ReadonlyMap<string, string>;
  projectId: string;
  projectSlug: string;
}>;

interface SecurityCopyScriptMetadata {
  [field: string]: unknown;
}

/** Upload metadata of the copy script. */
export function securityRuntimeCopyMetadata(
  plan: SecurityCopyPlan,
  names: SecurityCopyNames,
  ids: SecurityCopyIds,
): SecurityCopyScriptMetadata {
  const bindings: Array<Record<string, unknown>> = [];
  for (const store of plan.stores) {
    const id = ids.ids.get(store.name) ?? store.name;
    if (store.kind === 'd1') {
      bindings.push({ type: 'd1', name: store.binding, id });
    } else if (store.kind === 'kv') {
      bindings.push({ type: 'kv_namespace', name: store.binding, namespace_id: id });
    } else {
      bindings.push({ type: 'r2_bucket', name: store.binding, bucket_name: store.name });
    }
  }
  for (const { binding, className } of plan.durableObjects) {
    bindings.push({ type: 'durable_object_namespace', name: binding, class_name: className });
  }
  for (const queue of plan.queues) {
    bindings.push({
      type: 'service',
      name: queue,
      service: names.sandbox,
      entrypoint: 'QueueStub',
    });
  }
  for (const { name, value } of plan.vars) {
    bindings.push({ type: 'plain_text', name, text: value });
  }
  for (const name of plan.fakes) {
    bindings.push({ type: 'secret_text', name, text: ids.fakes.get(name) ?? '' });
  }
  bindings.push(
    // Platform bindings every Void Worker reads; the proxy is a stub, the token is fake.
    { type: 'service', name: '__VOID_PROXY', service: names.sandbox, entrypoint: 'PlatformStub' },
    { type: 'plain_text', name: '__PROJECT_ID', text: ids.projectId },
    {
      type: 'secret_text',
      name: '__VOID_PROXY_TOKEN',
      text: ids.fakes.get('__VOID_PROXY_TOKEN') ?? '',
    },
    { type: 'plain_text', name: '__VOID_PROJECT_SLUG', text: ids.projectSlug },
    // The copy guard's way out: the sandbox, which answers 403.
    { type: 'service', name: '__VOID_COPY_EGRESS', service: names.sandbox },
    {
      type: 'plain_text',
      name: '__VOID_COPY_STORES',
      text: JSON.stringify({
        d1: plan.stores.filter((store) => store.kind === 'd1').map((store) => store.binding),
        kv: plan.stores.filter((store) => store.kind === 'kv').map((store) => store.binding),
      }),
    },
  );
  const classes = [...new Set(plan.durableObjects.map((entry) => entry.className))].sort();
  return {
    main_module: COPY_ENTRY_MODULE_NAME,
    compatibility_date: plan.compatibilityDate,
    compatibility_flags: [...plan.compatibilityFlags],
    bindings,
    ...(classes.length > 0 ? { migrations: { new_tag: 'v1', new_sqlite_classes: classes } } : {}),
    observability: { enabled: false },
  };
}

/** Names that get a fake value in every copy, on top of the plan's `fakes`. */
export const SECURITY_COPY_PLATFORM_FAKES = ['__VOID_PROXY_TOKEN'] as const;
