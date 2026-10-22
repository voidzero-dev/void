import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  getWorkerAssetsDir,
  getWorkerBundleDir,
  readBuildOutput,
} from '@cloudflare/build-output-utils';
import {
  convertToWranglerConfig,
  type ParsedInputConfig,
  type ParsedOutputWorkerConfig,
} from '@cloudflare/config';
import type { CloudflareCommandResult } from '@void/deploy-cloudflare';
import ignore from 'ignore';
import mime from 'mime';
import { extname, join, relative } from 'pathslash';
import { isGeneratedAssetHeaders } from '../asset-worker-bypass.ts';
import type { CfBuildOutput } from './cf-build-output.ts';
import { record as object } from './cf-config-migrate.ts';
import { getVoidUserAgent } from './cf-user-agent.ts';
import { Buffer } from './node-buffer.ts';

type Json = Record<string, unknown>;
export type CfCommand = (
  args: Array<string>,
  options: { cwd: string; capture: boolean; timeoutMs?: number; maxOutputBytes?: number },
) => CloudflareCommandResult | Promise<CloudflareCommandResult>;

class CloudflareApiError extends Error {
  readonly status: number;
  readonly code?: number;
  constructor(message: string, status: number, code?: number) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Worker binding types whose value comes from a secret rather than the build output. */
export function isSecretBindingType(type: unknown): boolean {
  return type === 'secret' || type === 'inherit' || type === 'unsafe:inherit';
}

function assertUploaderUnchanged(verifyUploader: () => boolean): void {
  if (!verifyUploader()) {
    throw new Error('The Cloudflare uploader changed during deployment.');
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`The Cloudflare ${label} is missing from the verified Worker output.`);
  }
  return value;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`The Cloudflare ${label} is missing from the verified Worker output.`);
  }
  return value;
}

const moduleContentTypes: Record<string, string> = {
  esm: 'application/javascript+module',
  cjs: 'application/javascript',
  wasm: 'application/wasm',
  text: 'text/plain',
  data: 'application/octet-stream',
  json: 'text/plain',
  sourcemap: 'application/source-map',
};

function bindingsFromOutput(
  env: Json,
  workerName: string,
  activeSecrets: NonNullable<CfBuildOutput['activeSecrets']>,
  explicitSecrets: Json,
): Array<Json> {
  const inherited = new Map(activeSecrets.bindings.map((binding) => [binding.name, binding.type]));
  const names = new Set([
    ...Object.keys(env),
    ...inherited.keys(),
    ...Object.keys(explicitSecrets),
  ]);
  const bindings: Array<Json> = [];
  for (const name of names) {
    const value = object(env[name]);
    const explicit = explicitSecrets[name];
    if (explicit !== undefined) {
      if (
        typeof explicit !== 'string' ||
        inherited.get(name) === 'secret_key' ||
        (value && value.type !== 'secret')
      ) {
        throw new Error(`Cloudflare secret ${name} has an invalid explicit value or binding.`);
      }
      bindings.push({ name, type: 'secret_text', text: explicit });
      continue;
    }
    if (inherited.has(name)) {
      if (value && !isSecretBindingType(value.type)) {
        throw new Error(`Cloudflare secret ${name} conflicts with a Worker binding.`);
      }
      bindings.push({ name, type: 'inherit', version_id: activeSecrets.versionId });
      continue;
    }
    if (!value) {
      throw new Error(`Cloudflare binding ${name} is missing from the Worker output.`);
    }
    switch (value.type) {
      case 'text':
        bindings.push({ name, type: 'plain_text', text: textValue(value.value, name) });
        break;
      case 'json':
        bindings.push({ name, type: 'json', json: value.value });
        break;
      case 'kv':
        bindings.push({ name, type: 'kv_namespace', namespace_id: requiredString(value.id, name) });
        break;
      case 'd1':
        bindings.push({ name, type: 'd1', database_id: requiredString(value.id, name) });
        break;
      case 'r2':
        bindings.push({
          name,
          type: 'r2_bucket',
          bucket_name: requiredString(value.name, name),
          ...(value.jurisdiction ? { jurisdiction: value.jurisdiction } : {}),
        });
        break;
      case 'durable-object':
        bindings.push({
          name,
          type: 'durable_object_namespace',
          class_name: requiredString(value.exportName, name),
          ...(value.worker !== workerName
            ? { script_name: requiredString(value.worker, name) }
            : {}),
        });
        break;
      case 'unsafe:durable_object_namespace':
        // The config translator uses this exact local form for Container DOs.
        // Do not turn arbitrary unsafe bindings into upload metadata.
        if (Object.keys(value).some((key) => !['type', 'class_name', 'dev'].includes(key))) {
          throw new Error(`Cloudflare binding ${name} is not a verified local Durable Object.`);
        }
        bindings.push({
          name,
          type: 'durable_object_namespace',
          class_name: requiredString(value.class_name, name),
        });
        break;
      case 'queue':
        bindings.push({
          name,
          type: 'queue',
          queue_name: requiredString(value.name, name),
          ...(value.deliveryDelay === undefined ? {} : { delivery_delay: value.deliveryDelay }),
        });
        break;
      case 'rate-limit':
        bindings.push({
          name,
          type: 'ratelimit',
          namespace_id: requiredString(value.namespace, name),
          simple: value.simple,
        });
        break;
      case 'ai':
      case 'browser':
      case 'images':
        bindings.push({ name, type: value.type });
        break;
      case 'hyperdrive':
        bindings.push({ name, type: 'hyperdrive', id: requiredString(value.id, name) });
        break;
      case 'worker':
        bindings.push({
          name,
          type: 'service',
          service: requiredString(value.worker, name),
          ...(value.exportName === undefined ? {} : { entrypoint: value.exportName }),
          ...(value.props === undefined ? {} : { props: value.props }),
        });
        break;
      case 'workflow':
        bindings.push({
          name,
          type: 'workflow',
          workflow_name: requiredString(value.name, name),
          ...(value.worker === workerName
            ? { class_name: requiredString(value.exportName, name) }
            : { script_name: requiredString(value.worker, name) }),
        });
        break;
      case 'send-email':
        bindings.push({
          name,
          type: 'send_email',
          ...(value.destinationAddress === undefined
            ? {}
            : { destination_address: value.destinationAddress }),
          ...(value.allowedDestinationAddresses === undefined
            ? {}
            : { allowed_destination_addresses: value.allowedDestinationAddresses }),
          ...(value.allowedSenderAddresses === undefined
            ? {}
            : { allowed_sender_addresses: value.allowedSenderAddresses }),
        });
        break;
      case 'analytics-engine-dataset':
        bindings.push({
          name,
          type: 'analytics_engine',
          ...(value.name === undefined ? {} : { dataset: value.name }),
        });
        break;
      case 'vectorize':
        bindings.push({
          name,
          type: 'vectorize',
          index_name: requiredString(value.name, name),
        });
        break;
      case 'dispatch-namespace': {
        const outbound = object(value.outbound);
        bindings.push({
          name,
          type: 'dispatch_namespace',
          namespace: requiredString(value.namespace, name),
          ...(outbound
            ? {
                outbound: {
                  worker: { service: requiredString(outbound.worker, name) },
                  ...(Array.isArray(outbound.parameters)
                    ? { params: outbound.parameters.map((parameter) => ({ name: parameter })) }
                    : {}),
                },
              }
            : {}),
        });
        break;
      }
      case 'assets':
        bindings.push({ name, type: 'assets' });
        break;
      case 'version-metadata':
        bindings.push({ name, type: 'version_metadata' });
        break;
      default:
        throw new Error(`Cloudflare binding ${name} cannot be uploaded with pinned secrets.`);
    }
  }
  return bindings;
}

const durableObjectStates = new Set([
  'created',
  'deleted',
  'renamed',
  'transferred',
  'expecting-transfer',
]);

/**
 * The `exports` that cf uploads for the same Build Output. cf converts them with
 * `@cloudflare/config`'s `convertToWranglerConfig` (cf `build-*.mjs`), and its
 * `resolveExportsUploadPayload` (cf `containers-*.mjs`) sends Worker entrypoints,
 * then Durable Objects, then Workflows reduced to their identity. Cloudflare
 * stages a version at 0% only when its exports are identical to the live
 * version's, and that version may have been uploaded by cf.
 */
export function exportsFromOutput(exports: unknown, bindings: Array<Json>): Json | undefined {
  if (exports === undefined) {
    return undefined;
  }
  const entries = object(exports);
  if (!entries) {
    throw new Error('Cloudflare Durable Object exports were not readable.');
  }
  const workflows = new Map<string, string>();
  for (const [name, raw] of Object.entries(entries)) {
    const value = object(raw);
    if (value?.type === 'workflow') {
      const workflowName = requiredString(value.name, `Workflow export ${name} name`);
      if (workflows.has(workflowName)) {
        throw new Error(`Cloudflare Workflow ${workflowName} has multiple local exports.`);
      }
      workflows.set(workflowName, name);
      continue;
    }
    if (value?.type === 'worker') {
      continue;
    }
    if (!value || value.type !== 'durable-object') {
      throw new Error(`Cloudflare export ${name} cannot be uploaded with pinned secrets.`);
    }
    const state = value.state ?? 'created';
    if (!durableObjectStates.has(String(state))) {
      throw new Error(`Cloudflare Durable Object export ${name} has an unsupported state.`);
    }
    if (state === 'renamed' || state === 'transferred') {
      requiredString(value[state === 'renamed' ? 'renamedTo' : 'transferredTo'], name);
    } else if (state !== 'deleted') {
      if (value.storage !== 'sqlite' && value.storage !== 'legacy-kv') {
        throw new Error(`Cloudflare Durable Object export ${name} has no storage type.`);
      }
      if (value.container !== undefined) {
        requiredString(value.container, name);
      }
      if (state === 'expecting-transfer') {
        requiredString(value.transferFrom, name);
      }
    }
  }
  for (const binding of bindings) {
    if (binding.type !== 'workflow') {
      continue;
    }
    const localExport = workflows.get(String(binding.workflow_name));
    if (
      localExport !== undefined &&
      (binding.script_name !== undefined || binding.class_name !== localExport)
    ) {
      throw new Error(
        `Cloudflare Workflow binding ${binding.name} conflicts with its local export.`,
      );
    }
  }
  // The converter reads only `worker.exports` for this field.
  const converted =
    object(
      convertToWranglerConfig({
        worker: { exports: entries },
        containers: [],
      } as unknown as ParsedInputConfig).exports,
    ) ?? {};
  const result: Json = {};
  for (const type of ['worker', 'durable-object', 'workflow']) {
    for (const [name, value] of Object.entries(converted)) {
      const entry = object(value);
      if (entry?.type !== type) {
        continue;
      }
      // cf uploads Workflow identity only. Execution settings stay in the immutable
      // Build Output and are applied by its separate typed trigger deployment.
      result[name] = type === 'workflow' ? { type, name: entry.name } : entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function preflightWorkflowExports(options: {
  exports: Json | undefined;
  accountUrl: string;
  workerName: string;
  token: string;
  verifyUploader: () => boolean;
}): Promise<void> {
  for (const raw of Object.values(options.exports ?? {})) {
    const entry = object(raw);
    if (entry?.type !== 'workflow') {
      continue;
    }
    const name = requiredString(entry.name, 'Workflow name');
    let workflow: Json;
    try {
      workflow = await apiResult(
        `${options.accountUrl}/workflows/${encodeURIComponent(name)}`,
        options.token,
        'GET',
        undefined,
        options.verifyUploader,
      );
    } catch (cause) {
      if (cause instanceof CloudflareApiError && cause.status === 404 && cause.code === 10200) {
        continue;
      }
      throw cause;
    }
    // The canonical uploader prompts before reassigning an account-wide name.
    // The pinned path must not silently adopt another Worker's Workflow.
    if (
      workflow.name !== name ||
      workflow.script_name !== options.workerName ||
      typeof workflow.class_name !== 'string' ||
      !workflow.class_name
    ) {
      throw new Error(`Cloudflare Workflow ${name} is not owned by this Worker.`);
    }
  }
}

function assetConfigFromOutput(value: unknown): Json | undefined {
  if (value === undefined) {
    return undefined;
  }
  const config = object(value);
  if (!config) {
    throw new Error('Cloudflare asset configuration was not readable.');
  }
  const supported = new Set(['basePath', 'htmlHandling', 'notFoundHandling', 'runWorkerFirst']);
  if (Object.keys(config).some((key) => !supported.has(key))) {
    throw new Error('Cloudflare asset configuration has an unsupported setting.');
  }
  return {
    ...(config.basePath === undefined ? {} : { base_path: config.basePath }),
    ...(config.htmlHandling === undefined ? {} : { html_handling: config.htmlHandling }),
    ...(config.notFoundHandling === undefined
      ? {}
      : { not_found_handling: config.notFoundHandling }),
    ...(config.runWorkerFirst === undefined ? {} : { run_worker_first: config.runWorkerFirst }),
  };
}

/**
 * The version API placement. Smart placement is normalized the same way as cf's own version
 * uploads. Targeted placement is rejected: the Workers beta version endpoint can drop its
 * target, and an atomic upload is live before a read-back could catch that.
 */
function placementFromOutput(placement: ParsedOutputWorkerConfig['placement']): Json | undefined {
  if (!placement) {
    return undefined;
  }
  const hint = 'hint' in placement ? placement.hint : undefined;
  if (hint || placement.mode === 'smart') {
    return { mode: 'smart', ...(hint ? { hint } : {}) };
  }
  const target =
    ('region' in placement && placement.region && 'region') ||
    ('host' in placement && placement.host && 'host') ||
    ('hostname' in placement && placement.hostname && 'hostname');
  if (target) {
    throw new Error(
      `Cloudflare placement.${target} cannot be deployed while the Worker has secrets. Remove cloudflare.placement from void.config.ts, or set it to { mode: 'smart' }.`,
    );
  }
  return undefined;
}

async function apiResult(
  url: string,
  token: string,
  method: string,
  body: Json | FormData | undefined,
  verifyUploader: () => boolean,
  timeout = 120_000,
): Promise<Json> {
  assertUploaderUnchanged(verifyUploader);
  const form = body instanceof FormData;
  const response = await fetch(url, {
    method,
    headers: {
      'User-Agent': getVoidUserAgent(),
      Authorization: `Bearer ${token}`,
      ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
  });
  const parsed = object(await response.json());
  const result = object(parsed?.result);
  if (!response.ok || parsed?.success !== true || !result) {
    const error = Array.isArray(parsed?.errors) ? object(parsed.errors[0]) : null;
    const code = Number.isSafeInteger(error?.code) ? ` [code: ${error!.code}]` : '';
    throw new CloudflareApiError(
      `Cloudflare version upload failed (${response.status})${code}.`,
      response.status,
      typeof error?.code === 'number' ? error.code : undefined,
    );
  }
  return result;
}

type ContainerPlan = { name: string; className: string; images: Json; settings: Json };

/** Durable Object namespace bindings that point at this Worker's own class. */
function localNamespaceBindings(
  bindings: Array<unknown>,
  className: string,
  workerName: string,
): Array<Json> {
  return bindings
    .map(object)
    .filter(
      (binding): binding is Json =>
        binding?.type === 'durable_object_namespace' &&
        binding.class_name === className &&
        (binding.script_name === undefined || binding.script_name === workerName) &&
        binding.environment === undefined &&
        binding.dispatch_namespace === undefined,
    );
}

function assertContainerApplicationIdentity(
  application: Json,
  plan: ContainerPlan,
  namespace: string,
): void {
  if (
    application.id !== namespace ||
    application.name !== plan.name ||
    application.scheduling_policy !== 'durable_object' ||
    object(application.durable_objects)?.namespace_id !== namespace
  ) {
    throw new Error(
      `Cloudflare Container ${plan.name} application identity does not match the uploaded namespace.`,
    );
  }
}

function assertContainerApplicationSettings(application: Json, plan: ContainerPlan): void {
  const desired = object(plan.settings.configuration) ?? {};
  const current = object(application.configuration) ?? {};
  const changedConfiguration = Object.entries(desired).some(([key, value]) => {
    if (key === 'wrangler_ssh') {
      const ssh = object(current.wrangler_ssh) ?? {};
      const expected = object(value) ?? {};
      return (
        !isDeepStrictEqual(ssh.enabled ?? false, expected.enabled) ||
        (expected.enabled === true &&
          expected.port !== undefined &&
          !isDeepStrictEqual(ssh.port, expected.port))
      );
    }
    if (key === 'experimental_flags' && Array.isArray(value)) {
      const flags = current.experimental_flags ?? [];
      return !Array.isArray(flags) || !isDeepStrictEqual([...flags].sort(), [...value].sort());
    }
    return !isDeepStrictEqual(current[key] ?? [], value);
  });
  // The provider may omit disabled/default settings or add unrelated configuration fields.
  // Compare only authored fields; an explicit empty key list still rejects existing keys.
  const logs = object(object(plan.settings.observability)?.logs);
  const currentLogs = object(object(application.observability)?.logs);
  if (
    changedConfiguration ||
    (logs !== null && !isDeepStrictEqual(currentLogs?.enabled ?? false, logs.enabled))
  ) {
    throw new Error(
      `Cloudflare Container ${plan.name} settings differ from the live application. Version-aware deployment cannot safely change these shared settings. Keep the existing Container settings in your configuration, or update this Container explicitly in the Cloudflare dashboard before retrying.`,
    );
  }
}

async function preflightContainerApplications(
  plans: Array<ContainerPlan>,
  bindings: Array<unknown>,
  accountUrl: string,
  workerName: string,
  token: string,
  verifyUploader: () => boolean,
): Promise<void> {
  for (const plan of plans) {
    const matches = localNamespaceBindings(bindings, plan.className, workerName).filter(
      (binding) => binding.namespace_id !== undefined,
    );
    const namespaces = new Set(matches.map((binding) => binding.namespace_id));
    if (namespaces.size > 1) {
      throw new Error(`Cloudflare Container ${plan.name} active namespace was ambiguous.`);
    }
    const namespace = [...namespaces][0];
    if (namespace === undefined) {
      if (Object.keys(plan.images).length === 0) {
        throw new Error(
          `Cloudflare Container ${plan.name} has no images and no verified existing namespace application.`,
        );
      }
      continue;
    }
    if (typeof namespace !== 'string' || !/^[a-f0-9]{32}$/.test(namespace)) {
      throw new Error('The active Container namespace ID was invalid.');
    }
    try {
      const application = await apiResult(
        `${accountUrl}/containers/applications/${encodeURIComponent(namespace)}`,
        token,
        'GET',
        undefined,
        verifyUploader,
      );
      assertContainerApplicationIdentity(application, plan, namespace);
      assertContainerApplicationSettings(application, plan);
    } catch (cause) {
      if (
        !(cause instanceof CloudflareApiError) ||
        cause.status !== 404 ||
        Object.keys(plan.images).length === 0
      ) {
        throw cause;
      }
    }
  }
}

function containerPlansFromOutput(
  containers: Awaited<ReturnType<typeof readBuildOutput>>['containers'],
  exports: Json | undefined,
  bindings: Array<Json>,
): Array<ContainerPlan> {
  const plans: Array<ContainerPlan> = [];
  for (const { config } of containers) {
    if (config.schedulingPolicy !== 'durable-object') {
      throw new Error(
        'Scheduler-managed Cloudflare Containers cannot be uploaded with pinned secrets.',
      );
    }
    const classes = Object.entries(exports ?? {}).filter(
      ([, value]) => object(value)?.container === config.name,
    );
    if (classes.length !== 1) {
      throw new Error(`Cloudflare Container ${config.name} needs exactly one local SQLite export.`);
    }
    const [className, raw] = classes[0];
    const declaration = object(raw)!;
    const localBindings = bindings.filter(
      (binding) =>
        binding.type === 'durable_object_namespace' &&
        binding.class_name === className &&
        binding.script_name === undefined,
    );
    if (declaration.storage !== 'sqlite' || localBindings.length === 0) {
      throw new Error(
        `Cloudflare Container ${config.name} needs a local SQLite Durable Object binding.`,
      );
    }
    const unsafe = object(config.unsafe);
    const configuration = object(unsafe?.configuration);
    if (
      (unsafe && Object.keys(unsafe).some((key) => key !== 'configuration')) ||
      (configuration && Object.keys(configuration).some((key) => key !== 'experimental_flags'))
    ) {
      throw new Error(`Cloudflare Container ${config.name} has an unsupported setting.`);
    }
    const settings: Json = {
      ...(configuration || config.ssh || config.authorizedKeys
        ? {
            configuration: {
              ...(configuration ?? {}),
              ...(config.ssh ? { wrangler_ssh: config.ssh } : {}),
              ...(config.authorizedKeys
                ? {
                    authorized_keys: config.authorizedKeys.map(({ name, publicKey }) => ({
                      name,
                      public_key: publicKey,
                    })),
                  }
                : {}),
            },
          }
        : {}),
      ...(config.observability
        ? {
            observability: {
              logs: {
                enabled:
                  config.observability.enabled === true ||
                  config.observability.logs?.enabled === true,
              },
            },
          }
        : {}),
    };
    plans.push({ name: config.name, className, images: config.images ?? {}, settings });
  }
  for (const [name, raw] of Object.entries(exports ?? {})) {
    const container = object(raw)?.container;
    if (
      container !== undefined &&
      !plans.some((plan) => plan.name === container && plan.className === name)
    ) {
      throw new Error(
        `Cloudflare export ${name} references a Container outside the verified output.`,
      );
    }
  }
  return plans;
}

async function dockerImageDigest(
  image: string,
  timeout: number,
  verifyUploader: () => boolean,
): Promise<string> {
  assertUploaderUnchanged(verifyUploader);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      process.env.WRANGLER_DOCKER_BIN ?? 'docker',
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', image],
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) =>
        error
          ? reject(new Error('Cloudflare Container image digest could not be verified after push.'))
          : resolve(stdout),
    );
  });
  const digests: unknown = JSON.parse(stdout);
  const repository = image.replace(/:[^/:]+$/, '');
  const matching = Array.isArray(digests)
    ? digests.filter(
        (digest) =>
          typeof digest === 'string' &&
          digest.startsWith(`${repository}@sha256:`) &&
          /^[a-f0-9]{64}$/.test(digest.slice(digest.lastIndexOf(':') + 1)),
      )
    : [];
  if (matching.length !== 1) {
    throw new Error('Cloudflare Container image digest could not be verified after push.');
  }
  return matching[0] as string;
}

async function prepareContainerMetadata(options: {
  plans: Array<ContainerPlan>;
  directory: string;
  accountUrl: string;
  accountId: string;
  token: string;
  verifyUploader: () => boolean;
  runCf?: CfCommand;
}): Promise<Array<Json>> {
  if (options.plans.length === 0) {
    return [];
  }
  const deadline = Date.now() + 15 * 60_000;
  const remaining = () => {
    const duration = deadline - Date.now();
    if (duration <= 0) {
      throw new Error('Cloudflare Container image preparation timed out.');
    }
    return duration;
  };
  const prepared = new Map<string, string>();
  const result: Array<Json> = [];
  for (const plan of options.plans) {
    const images: Json = {};
    for (const [name, raw] of Object.entries(plan.images)) {
      const source = object(raw)!;
      const reference = requiredString(
        source.localReference ?? source.reference,
        `Container ${plan.name} image`,
      );
      let image = prepared.get(reference);
      if (!image) {
        image = reference;
        if (source.localReference !== undefined) {
          if (!options.runCf || !options.verifyUploader()) {
            throw new Error('The verified Cloudflare Container image uploader is unavailable.');
          }
          const pushed = await options.runCf(['containers', 'push', '--tag', reference], {
            cwd: options.directory,
            capture: true,
            timeoutMs: remaining(),
            maxOutputBytes: 16 * 1024 * 1024,
          });
          if (pushed.status !== 0 || pushed.signal || pushed.error) {
            throw new Error('Cloudflare Container image push failed.');
          }
          const matches = [...pushed.stdout.matchAll(/Pushed image:\s*(\S+)/g)];
          const remote = matches.length === 1 ? matches[0][1] : '';
          if (
            !remote.startsWith(`registry.cloudflare.com/${options.accountId}/`) ||
            [...remote].some(
              (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
            )
          ) {
            throw new Error(
              'Cloudflare Container image push did not return the verified account registry.',
            );
          }
          image = await dockerImageDigest(
            remote,
            Math.min(120_000, remaining()),
            options.verifyUploader,
          );
        }
        for (;;) {
          const ready = await apiResult(
            `${options.accountUrl}/containers/image-preparations`,
            options.token,
            'POST',
            { image },
            options.verifyUploader,
            Math.min(120_000, remaining()),
          );
          if (ready.image !== image) {
            throw new Error('Cloudflare Container image preparation returned another image.');
          }
          if (ready.status === 'ready') {
            break;
          }
          if (ready.status !== 'pending') {
            throw new Error(
              'Cloudflare Container image preparation failed or returned an unsupported state.',
            );
          }
          await delay(Math.min(2_000, remaining()));
        }
        prepared.set(reference, image);
      }
      images[name] = image;
    }
    result.push({
      name: plan.name,
      class_name: plan.className,
      ...(Object.keys(images).length ? { images } : {}),
    });
  }
  return result;
}

async function ensureContainerApplications(options: {
  plans: Array<ContainerPlan>;
  containers: Array<Json>;
  accountUrl: string;
  workerName: string;
  versionId: string;
  token: string;
  verifyUploader: () => boolean;
}): Promise<void> {
  if (options.plans.length === 0) {
    return;
  }
  const deadline = Date.now() + 60_000;
  let version: Json;
  for (;;) {
    try {
      version = await apiResult(
        `${options.accountUrl}/workers/scripts/${encodeURIComponent(options.workerName)}/versions/${encodeURIComponent(options.versionId)}`,
        options.token,
        'GET',
        undefined,
        options.verifyUploader,
        Math.max(1, Math.min(30_000, deadline - Date.now())),
      );
      break;
    } catch (cause) {
      if (
        !(cause instanceof CloudflareApiError) ||
        cause.code !== 100146 ||
        Date.now() >= deadline
      ) {
        throw cause;
      }
      await delay(Math.min(2_000, deadline - Date.now()));
    }
  }
  const versionBindings = object(version.resources)?.bindings;
  if (version.id !== options.versionId || !Array.isArray(versionBindings)) {
    throw new Error('The uploaded Container namespace could not be verified.');
  }
  const metadata = object(object(version.resources)?.script_runtime)?.containers;
  if (
    !Array.isArray(metadata) ||
    metadata.length !== options.containers.length ||
    options.containers.some((expected) => {
      const matching = metadata
        .map(object)
        .filter(
          (entry) =>
            entry !== null &&
            entry.name === expected.name &&
            entry.class_name === expected.class_name,
        );
      return (
        matching.length !== 1 ||
        !isDeepStrictEqual(matching[0]!.images ?? {}, expected.images ?? {})
      );
    })
  ) {
    throw new Error(
      'The uploaded Worker version did not retain the verified Container image metadata.',
    );
  }
  for (const plan of options.plans) {
    const matches = localNamespaceBindings(versionBindings, plan.className, options.workerName);
    const namespaces = new Set(matches.map((binding) => binding.namespace_id));
    if (matches.length === 0 || namespaces.size !== 1) {
      throw new Error(
        `Cloudflare Container ${plan.name} has no unambiguous uploaded local namespace.`,
      );
    }
    const namespace = requiredString([...namespaces][0], `Container ${plan.name} namespace`);
    if (!/^[a-f0-9]{32}$/.test(namespace)) {
      throw new Error('The uploaded Container namespace ID was invalid.');
    }
    const url = `${options.accountUrl}/containers/applications/${encodeURIComponent(namespace)}`;
    let application: Json;
    try {
      application = await apiResult(url, options.token, 'GET', undefined, options.verifyUploader);
    } catch (cause) {
      if (!(cause instanceof CloudflareApiError) || cause.status !== 404) {
        throw cause;
      }
      application = await apiResult(
        `${options.accountUrl}/containers/applications`,
        options.token,
        'POST',
        {
          name: plan.name,
          scheduling_policy: 'durable_object',
          durable_objects: { namespace_id: namespace },
          ...plan.settings,
        },
        options.verifyUploader,
      );
    }
    assertContainerApplicationIdentity(application, plan, namespace);
    // Candidate upload must not mutate settings shared with the live version. Traffic-only
    // activation cannot publish or roll back these settings, so reject differences instead.
    assertContainerApplicationSettings(application, plan);
    const confirmed = await apiResult(url, options.token, 'GET', undefined, options.verifyUploader);
    assertContainerApplicationIdentity(confirmed, plan, namespace);
    assertContainerApplicationSettings(confirmed, plan);
  }
}

/**
 * The `_headers` file a native build generated for its fingerprinted files.
 * This API takes it as a `_headers` module, as cf does on its JSON version
 * uploads. A user-authored `_headers` is not sent on this path.
 */
function readGeneratedAssetHeaders(output: CfBuildOutput): string | undefined {
  if (!output.assetsDirectory) {
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(join(getWorkerAssetsDir(output.directory), '_headers'), 'utf8');
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return undefined;
    }
    throw cause;
  }
  return isGeneratedAssetHeaders(text) ? text : undefined;
}

async function uploadAssets(options: {
  output: CfBuildOutput;
  accountUrl: string;
  workerName: string;
  token: string;
  verifyUploader: () => boolean;
}): Promise<string | undefined> {
  if (!options.output.assetsDirectory) {
    return undefined;
  }
  const directory = getWorkerAssetsDir(options.output.directory);
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, string>();
  const ignored = ignore().add([
    '/.assetsignore',
    '/_headers',
    '/_redirects',
    '.DS_Store',
    '.env',
    '.env.*',
    '.dev.vars',
    '.dev.vars.*',
  ]);
  const ignorePath = join(directory, '.assetsignore');
  try {
    ignored.add(readFileSync(ignorePath, 'utf8'));
  } catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) {
      throw cause;
    }
  }
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) {
      continue;
    }
    if (!entry.isFile()) {
      throw new Error('The Cloudflare asset output contains an unsupported entry.');
    }
    const path = join(entry.parentPath, entry.name);
    const relativeName = relative(directory, path).replaceAll('\\', '/');
    if (ignored.ignores(relativeName)) {
      continue;
    }
    const name = `/${relativeName}`;
    const content = readFileSync(path);
    const extension = extname(entry.name).slice(1);
    const hash = createHash('sha256')
      .update(content.toString('base64') + extension)
      .digest('hex')
      .slice(0, 32);
    manifest[name] = { hash, size: content.length };
    byHash.set(hash, path);
  }
  const session = await apiResult(
    `${options.accountUrl}/workers/scripts/${encodeURIComponent(options.workerName)}/assets-upload-session`,
    options.token,
    'POST',
    { manifest },
    options.verifyUploader,
  );
  const uploadJwt = requiredString(session.jwt, 'asset upload token');
  if (!Array.isArray(session.buckets)) {
    throw new Error('Cloudflare did not provide asset upload batches.');
  }
  if (session.buckets.length === 0) {
    return uploadJwt;
  }
  let completionJwt: string | undefined;
  for (const bucket of session.buckets) {
    if (!Array.isArray(bucket) || !bucket.every((hash) => typeof hash === 'string')) {
      throw new Error('Cloudflare returned an invalid asset upload batch.');
    }
    const form = new FormData();
    for (const hash of bucket) {
      const path = byHash.get(hash);
      if (!path) {
        throw new Error('Cloudflare requested an asset outside the verified Worker output.');
      }
      // Cloudflare stores each multipart part's MIME type on the asset. A string
      // field has no Content-Type and makes browser modules unloadable.
      form.append(
        hash,
        new File([readFileSync(path).toString('base64')], hash, {
          type: mime.getType(path) ?? 'application/null',
        }),
      );
    }
    const uploaded = await apiResult(
      `${options.accountUrl}/workers/assets/upload?base64=true`,
      uploadJwt,
      'POST',
      form,
      options.verifyUploader,
    );
    if (uploaded.jwt !== undefined) {
      completionJwt = requiredString(uploaded.jwt, 'asset completion token');
    }
  }
  return requiredString(completionJwt, 'asset completion token');
}

/** The Workers beta API is the only upload endpoint that accepts a version UUID as an inheritance source. */
export async function uploadPinnedCloudflareVersion(options: {
  output: CfBuildOutput;
  accountId: string;
  apiBaseUrl: string;
  workerName: string;
  token: string;
  message?: string;
  secretsFilePath?: string;
  atomic: boolean;
  verifyUploader: () => boolean;
  runCf?: CfCommand;
}): Promise<{ id: string; urls: Array<string> }> {
  const activeSecrets = options.output.activeSecrets;
  if (!activeSecrets) {
    throw new Error('The active Worker secret source was not verified.');
  }
  const built = await readBuildOutput(options.output.directory);
  const config = built.workers.default.config;
  if (
    config.name !== options.workerName ||
    !config.manifest ||
    config.manifest.type !== 'complete'
  ) {
    throw new Error('The verified Cloudflare Worker output changed before upload.');
  }
  const unsupported = Object.keys(config).filter(
    (key) =>
      !new Set([
        'name',
        'compatibilityDate',
        'compatibilityFlags',
        'assets',
        'domains',
        'observability',
        'workersDev',
        'previewUrls',
        'unsafe',
        'env',
        'exports',
        'manifest',
        'triggers',
        'limits',
        'placement',
        'cache',
        // Worker-level settings that version uploads cannot set. Observability is
        // published separately during post-activation trigger synchronization.
        'logpush',
        'tailConsumers',
      ]).has(key),
  );
  if (unsupported.length) {
    throw new Error(
      `Cloudflare Worker setting ${unsupported[0]} cannot be uploaded with pinned secrets.`,
    );
  }
  const placement = placementFromOutput(config.placement);
  const unsafe = object(config.unsafe);
  const metadata = object(unsafe?.metadata);
  if (
    (unsafe && Object.keys(unsafe).some((key) => key !== 'metadata')) ||
    (metadata && Object.keys(metadata).some((key) => key !== 'keep_bindings')) ||
    (metadata?.keep_bindings !== undefined &&
      (!Array.isArray(metadata.keep_bindings) ||
        !metadata.keep_bindings.every((type) => typeof type === 'string')))
  ) {
    throw new Error('Cloudflare Worker upload metadata has an unsupported setting.');
  }
  const explicitSecrets = options.secretsFilePath
    ? object(JSON.parse(readFileSync(options.secretsFilePath, 'utf8')))
    : {};
  if (!explicitSecrets) {
    throw new Error('The explicit Cloudflare secrets file was not readable.');
  }
  const bindings = bindingsFromOutput(
    (config.env ?? {}) as Json,
    options.workerName,
    activeSecrets,
    explicitSecrets,
  );
  const exports = exportsFromOutput(config.exports, bindings);
  const containerPlans = containerPlansFromOutput(built.containers, exports, bindings);
  const accountUrl = `${options.apiBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(options.accountId)}`;
  // The scripts uploader normally carries forward remote vars. Preserve only
  // those implicit bindings from the live version, never the inactive upload.
  const active = await apiResult(
    `${accountUrl}/workers/workers/${encodeURIComponent(options.workerName)}/versions/${encodeURIComponent(activeSecrets.versionId)}`,
    options.token,
    'GET',
    undefined,
    options.verifyUploader,
  );
  if (active.id !== activeSecrets.versionId || !Array.isArray(active.bindings)) {
    throw new Error('The active Cloudflare Worker bindings could not be verified.');
  }
  const activeBindingNames = new Set<string>();
  const candidateNames = new Set(bindings.map((binding) => String(binding.name)));
  const keptTypes = new Set((metadata?.keep_bindings as Array<string> | undefined) ?? []);
  for (const entry of active.bindings) {
    const binding = object(entry);
    if (!binding || typeof binding.name !== 'string' || typeof binding.type !== 'string') {
      throw new Error('The active Cloudflare Worker bindings could not be verified.');
    }
    activeBindingNames.add(binding.name);
    if (
      !candidateNames.has(binding.name) &&
      keptTypes.has(binding.type) &&
      ['plain_text', 'json'].includes(binding.type)
    ) {
      bindings.push({
        name: binding.name,
        type: 'inherit',
        version_id: activeSecrets.versionId,
      });
      candidateNames.add(binding.name);
    }
  }
  if (activeSecrets.bindings.some(({ name }) => !activeBindingNames.has(name))) {
    throw new Error('The active Cloudflare Worker secrets changed before upload.');
  }
  const assetConfig = assetConfigFromOutput(config.assets);
  if (bindings.some((binding) => binding.type === 'assets') && !options.output.assetsDirectory) {
    throw new Error('The Cloudflare Worker has an assets binding without verified assets.');
  }
  const modules: Array<Json> = [];
  for (const [name, entry] of Object.entries(config.manifest.modules)) {
    const type = moduleContentTypes[entry.type];
    if (!type || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`Cloudflare Worker module ${name} cannot be uploaded with pinned secrets.`);
    }
    modules.push({
      name,
      content_type: type,
      content_base64: readFileSync(
        join(getWorkerBundleDir(options.output.directory), name),
      ).toString('base64'),
    });
  }
  const generatedHeaders = readGeneratedAssetHeaders(options.output);
  if (generatedHeaders !== undefined) {
    modules.push({
      name: '_headers',
      content_type: 'text/plain',
      content_base64: Buffer.from(generatedHeaders).toString('base64'),
    });
  }
  await preflightWorkflowExports({
    exports,
    accountUrl,
    workerName: options.workerName,
    token: options.token,
    verifyUploader: options.verifyUploader,
  });
  await preflightContainerApplications(
    containerPlans,
    active.bindings,
    accountUrl,
    options.workerName,
    options.token,
    options.verifyUploader,
  );
  const containers = await prepareContainerMetadata({
    plans: containerPlans,
    directory: options.output.directory,
    accountUrl,
    accountId: options.accountId,
    token: options.token,
    verifyUploader: options.verifyUploader,
    runCf: options.runCf,
  });
  const jwt = await uploadAssets({
    output: options.output,
    accountUrl,
    workerName: options.workerName,
    token: options.token,
    verifyUploader: options.verifyUploader,
  });
  const uploaded = await apiResult(
    `${accountUrl}/workers/workers/${encodeURIComponent(options.workerName)}/versions${options.atomic ? '?deploy=true' : ''}`,
    options.token,
    'POST',
    {
      main_module: config.manifest.mainModule,
      modules,
      compatibility_date: config.compatibilityDate,
      compatibility_flags: config.compatibilityFlags,
      bindings,
      ...(config.limits
        ? { limits: { cpu_ms: config.limits.cpuMs, subrequests: config.limits.subrequests } }
        : {}),
      ...(placement ? { placement } : {}),
      ...(config.cache
        ? {
            cache_options: {
              enabled: config.cache.enabled,
              cross_version_cache: config.cache.crossVersionCache,
            },
          }
        : {}),
      ...(exports ? { exports } : {}),
      ...(containers.length ? { containers } : {}),
      ...(jwt ? { assets: { jwt, ...(assetConfig ? { config: assetConfig } : {}) } } : {}),
      annotations: { 'workers/message': options.message ?? '' },
    },
    options.verifyUploader,
  );
  const versionId = uploaded.id;
  if (
    typeof versionId !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(versionId)
  ) {
    throw new Error(
      'Cloudflare accepted the Worker upload but returned an invalid version identity. Read back the Worker deployment before retrying.',
    );
  }
  try {
    await ensureContainerApplications({
      plans: containerPlans,
      containers,
      accountUrl,
      workerName: options.workerName,
      versionId,
      token: options.token,
      verifyUploader: options.verifyUploader,
    });
  } catch {
    throw new Error(
      `Cloudflare Worker version ${versionId} was uploaded${options.atomic ? ' and may already be published' : ''}, but its Container applications could not be verified. Read back the Worker deployment and Container identities before retrying.`,
    );
  }
  return {
    id: versionId,
    urls: Array.isArray(uploaded.urls)
      ? uploaded.urls.filter((url): url is string => typeof url === 'string')
      : [],
  };
}
