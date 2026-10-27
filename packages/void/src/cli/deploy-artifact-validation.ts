import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual as deepEqual } from 'node:util';
import {
  parseRootWranglerConfig,
  readConfigEntryString as readD1EntryString,
  readStoredResourceName,
  assertExistingCloudflareConfig,
  type ExistingCloudflareWorker,
  type ApprovedCloudflareKvBinding,
} from '@void/deploy-cloudflare';
import { dirname, resolve } from 'pathslash';
import { type RoutingConfig } from '../config.ts';
import {
  deployPointerPath,
  desiredIdentityBindings,
  DEPLOY_BINDING_IDENTITY_FIELDS,
  bindingIdentityKey,
  collectConfigBindingIdentities,
  DEPLOY_PASSTHROUGH_ASSERT_FIELDS,
  DEPLOY_WHOLE_OBJECT_PINNED_FIELDS,
  isEmptyPassthroughValue,
  verifyNoInjectedExternalDurableObject,
  DEFAULT_VOID_AI_BINDING,
  verifyNoInjectedDestructiveMigration,
  normalizeContainerImagePaths,
  collectEmittedQueueGroupNames,
} from './deploy-binding-snapshot.ts';
import { log } from './deploy-helpers.ts';
import { BETTER_AUTH_SECRET_NAME } from './deploy-resources.ts';
import { buildSchemaProbeEnv } from './deploy-transport.ts';
import { type BindingIdentitySnapshot, type CloudflareDeployDeps } from './deploy-types.ts';
import type {
  EnvSchemaProbeInput,
  EnvSchemaProbeResult,
  EnvSchemaValidateResult,
} from './env-schema-probe.ts';
import {
  deriveSelfHostEnvContextFromVars,
  dischargeSelfHostEnvContext,
  readEmittedWorkerVars,
  selfHostSchemaFailureMessage,
  SelfHostEnvValidationError,
  SelfHostFirstDeployError,
  SelfHostSchemaError,
  SelfHostSecretListError,
  type SelfHostSchemaFacts,
} from './env-validation.ts';
import { readGeneratedWranglerConfigFile } from './generated-wrangler-config.ts';
import { getErrorMessage } from './output.ts';
import type { DesiredResourceSet } from './provision.ts';
import { bindingEntriesForField } from './wrangler.ts';

/**
 * Derive the env schema's server and required key names in an isolated subprocess, so project
 * code never runs in the credentialed parent. Loaded lazily to keep it out of managed deploys.
 */
export async function resolveEnvSchemaFactsDefault(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
): Promise<EnvSchemaProbeResult> {
  const { resolveEnvSchemaFactsViaSubprocess } = await import('./env-schema-probe.ts');
  return resolveEnvSchemaFactsViaSubprocess(input, env);
}

/** Validate the emitted Worker vars in the same isolated subprocess; returns failing names only. */
async function validateEmittedVarsDefault(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
): Promise<EnvSchemaValidateResult> {
  const { validateEmittedVarsViaSubprocess } = await import('./env-schema-probe.ts');
  return validateEmittedVarsViaSubprocess(input, env);
}

export function resolveGeneratedDeployConfigPathDefault(root: string): string {
  const pointerPath = deployPointerPath(root);
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { configPath?: unknown };
  if (typeof pointer.configPath !== 'string' || pointer.configPath.length === 0) {
    throw new Error(`Generated Cloudflare deploy pointer ${pointerPath} has no configPath.`);
  }
  return resolve(dirname(pointerPath), pointer.configPath);
}

export function readGeneratedDeployConfig(root: string): {
  path: string;
  config: Record<string, unknown>;
} {
  const redirectedPath = resolveGeneratedDeployConfigPathDefault(root);
  try {
    return { path: redirectedPath, config: readGeneratedWranglerConfigFile(redirectedPath) };
  } catch {
    throw new Error(
      `Generated Cloudflare deploy config ${redirectedPath} is missing or invalid JSON/JSONC.`,
    );
  }
}

/** Older project plugins can repeat root flags; normalize only the generated artifact. */
export function deduplicateGeneratedCompatibilityFlags(
  configPath: string,
  rootConfigPath: string,
): void {
  if (resolve(configPath) === resolve(rootConfigPath) || !existsSync(configPath)) {
    return;
  }
  const config = parseRootWranglerConfig(configPath);
  const flags = config.compatibility_flags;
  if (!Array.isArray(flags) || !flags.every((flag): flag is string => typeof flag === 'string')) {
    return;
  }
  const uniqueFlags = [...new Set(flags)];
  if (uniqueFlags.length !== flags.length) {
    config.compatibility_flags = uniqueFlags;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

/**
 * Check whether Void contributes worker-side routing rules.
 */
export function hasConfiguredVoidWorkerRoutingRules(routing: RoutingConfig | undefined): boolean {
  return (
    routing !== undefined &&
    (routing.alwaysUseHttps === true ||
      [routing.redirects, routing.rewrites, routing.fallbacks, routing.headers].some(
        (rules) => rules !== undefined && Object.keys(rules).length > 0,
      ))
  );
}

/**
 * Remove the CF plugin's deploy pointer before building. The plugin rewrites it only when it
 * emits a Worker, so the post-build checks then accept only a pointer this build wrote.
 */
export function removeDeployPointer(root: string): void {
  rmSync(deployPointerPath(root), { force: true });
}

/**
 * Check the generated deploy config before upload: the pinned account and Worker name, required
 * secrets, and every binding, container, migration, queue and cron against the pre-build pins,
 * so a build that adds, drops or retargets one fails closed. Returns `{ ok: false, reason }` on
 * any mismatch, or when the config is missing or unreadable.
 */
export function verifyGeneratedDeployConfig(
  root: string,
  expected: {
    accountId: string;
    workerName: string;
    desired?: DesiredResourceSet;
    bindingIdentitySnapshot?: BindingIdentitySnapshot;
    /** Pre-build entries for binding fields Void never emits. */
    passthroughIdentitySnapshot?: Map<string, Map<string, Record<string, unknown>>>;
    /** Pre-build raw values for whole-object fields, `durable_objects`, `ai` and `migrations`. */
    passthroughRawFields?: Map<string, unknown>;
    /** Whether the source uses Workers AI; only then may the build add Void's AI binding. */
    needsAI?: boolean;
    /** Custom `inference.bindings.ai` name authorized for Void's emitted AI binding. */
    aiBindingName?: string;
    /** Require BETTER_AUTH_SECRET in `secrets.required` so the upload keeps the remote value. */
    authEnabled?: boolean;
    /** Additional Worker secret names the generated version must inherit. */
    requiredSecretNames?: Array<string>;
    /** Containers the build should emit: the root's, plus Void's sandbox container when used. */
    expectedContainers?: Array<Record<string, unknown>>;
    /** Exact pre-build Durable Object bindings, including Void's sandbox and live additions. */
    expectedDurableObjectBindings?: Array<Record<string, unknown>>;
    /** Exact pre-build migration sequence, including Void's sandbox and live additions. */
    expectedMigrations?: Array<Record<string, unknown>>;
    /** Cron schedules the build should emit, derived from the source before the build. */
    expectedCrons?: Array<string>;
  },
): { ok: boolean; reason?: string } {
  const deployConfigPath = deployPointerPath(root);
  if (!existsSync(deployConfigPath)) {
    return {
      ok: false,
      reason: `expected the CF plugin's deploy config at ${deployConfigPath}, but it was not written by the build (a stale pointer is removed before building, so only a fresh one from this build is trusted).`,
    };
  }
  let redirectedPath: string;
  try {
    const parsed = JSON.parse(readFileSync(deployConfigPath, 'utf-8')) as { configPath?: unknown };
    if (typeof parsed.configPath !== 'string' || parsed.configPath.length === 0) {
      return { ok: false, reason: `${deployConfigPath} has no "configPath" pointer.` };
    }
    redirectedPath = resolve(dirname(deployConfigPath), parsed.configPath);
  } catch {
    return { ok: false, reason: `${deployConfigPath} is not valid JSON.` };
  }
  if (!existsSync(redirectedPath)) {
    return { ok: false, reason: `generated wrangler config ${redirectedPath} does not exist.` };
  }
  let generated: Record<string, unknown>;
  try {
    generated = readGeneratedWranglerConfigFile(redirectedPath);
  } catch {
    return {
      ok: false,
      reason: `generated wrangler config ${redirectedPath} is not valid JSON/JSONC.`,
    };
  }
  if (generated.account_id !== expected.accountId) {
    return {
      ok: false,
      reason: `generated config account_id ${JSON.stringify(generated.account_id)} does not match the pinned account ${JSON.stringify(expected.accountId)}.`,
    };
  }
  if (generated.name !== expected.workerName) {
    return {
      ok: false,
      reason: `generated config worker name ${JSON.stringify(generated.name)} does not match the expected worker ${JSON.stringify(expected.workerName)}.`,
    };
  }
  const expectedRequiredSecrets = new Set(expected.requiredSecretNames ?? []);
  if (expected.authEnabled) {
    expectedRequiredSecrets.add(BETTER_AUTH_SECRET_NAME);
  }
  if (expectedRequiredSecrets.size > 0) {
    const secrets = generated.secrets;
    const required =
      typeof secrets === 'object' && secrets !== null && !Array.isArray(secrets)
        ? (secrets as Record<string, unknown>).required
        : undefined;
    if (
      !Array.isArray(required) ||
      !required.every((name): name is string => typeof name === 'string') ||
      [...expectedRequiredSecrets].some((name) => !required.includes(name))
    ) {
      return {
        ok: false,
        reason:
          `generated config must include ${[...expectedRequiredSecrets].join(', ')} in ` +
          '`secrets.required` so wrangler inherits the persistent secrets during upload.',
      };
    }
  }
  // Id-bearing bindings (D1, KV, R2, Hyperdrive) must match the in-memory pre-build pins, so a
  // build that rewrote both the root config and the artifact is still caught.
  if (expected.bindingIdentitySnapshot) {
    const snapshot = expected.bindingIdentitySnapshot;
    // Every desired binding is still emitted with its pinned id.
    if (expected.desired) {
      for (const { kind, binding } of desiredIdentityBindings(expected.desired)) {
        const { field, idField } = DEPLOY_BINDING_IDENTITY_FIELDS[kind];
        const pinnedId = snapshot.get(bindingIdentityKey(field, binding));
        // Unprovisioned bindings are the drift check's job.
        if (pinnedId === undefined) {
          continue;
        }
        const generatedId = readStoredResourceName(generated, field, binding, idField);
        if (generatedId === undefined) {
          return {
            ok: false,
            reason: `generated config is missing the ${field} binding ${JSON.stringify(binding)} (pinned identity ${JSON.stringify(pinnedId)}) — a named environment or alternate config flattened a different binding set.`,
          };
        }
        if (generatedId !== pinnedId) {
          return {
            ok: false,
            reason: `generated config ${field} binding ${JSON.stringify(binding)} has identity ${JSON.stringify(generatedId)} but the pinned pre-build identity is ${JSON.stringify(pinnedId)} — refusing to deploy a flattened/alternate or tampered binding set.`,
          };
        }
      }
    }
    // Every emitted id-bearing binding was pinned, with the same id.
    const generatedIdentities = collectConfigBindingIdentities(generated);
    for (const { field, binding, id } of generatedIdentities) {
      const pinnedId = snapshot.get(bindingIdentityKey(field, binding));
      if (pinnedId === undefined) {
        return {
          ok: false,
          reason: `generated config declares a ${field} binding ${JSON.stringify(binding)} that was not present before the build — refusing to deploy an id-bearing binding the build injected.`,
        };
      }
      if (id !== pinnedId) {
        return {
          ok: false,
          reason: `generated config ${field} binding ${JSON.stringify(binding)} has identity ${JSON.stringify(id)} but the pinned pre-build identity is ${JSON.stringify(pinnedId)} — refusing to deploy a rewritten binding set.`,
        };
      }
    }
    // Every pinned binding, desired or hand-declared, is still emitted.
    const emittedIdentityKeys = new Set<string>();
    for (const { field, binding } of generatedIdentities) {
      emittedIdentityKeys.add(bindingIdentityKey(field, binding));
    }
    for (const key of snapshot.keys()) {
      if (!emittedIdentityKeys.has(key)) {
        const separator = key.indexOf(':');
        const field = key.slice(0, separator);
        const binding = key.slice(separator + 1);
        return {
          ok: false,
          reason: `generated config no longer declares the ${field} binding ${JSON.stringify(binding)} that was present before the build — refusing to deploy a build that dropped an id-bearing binding the root config declared.`,
        };
      }
    }
  }
  // Binding fields Void never emits: each emitted entry must equal its pre-build entry. Fields
  // outside the assert set stay unchecked, so a binding type added later cannot fail a valid build.
  if (expected.passthroughIdentitySnapshot) {
    const passthrough = expected.passthroughIdentitySnapshot;
    for (const field of DEPLOY_PASSTHROUGH_ASSERT_FIELDS) {
      if (DEPLOY_WHOLE_OBJECT_PINNED_FIELDS.includes(field) || generated[field] === undefined) {
        continue;
      }
      let emittedEntries: Array<{ name: string; entry: Record<string, unknown> }>;
      try {
        emittedEntries = bindingEntriesForField(field, generated[field]);
      } catch {
        return {
          ok: false,
          reason: `generated config declares a malformed ${field} binding — refusing to deploy a binding set that cannot be verified.`,
        };
      }
      const pinned = passthrough.get(field) ?? new Map<string, Record<string, unknown>>();
      for (const { name, entry } of emittedEntries) {
        const pinnedEntry = pinned.get(name);
        if (pinnedEntry === undefined) {
          return {
            ok: false,
            reason: `generated config declares a ${field} binding ${JSON.stringify(name)} that was not present before the build — refusing to deploy a ${field} binding the build injected.`,
          };
        }
        if (!deepEqual(entry, pinnedEntry)) {
          return {
            ok: false,
            reason: `generated config ${field} binding ${JSON.stringify(name)} differs from the pre-build config — refusing to deploy a ${field} binding the build rewrote.`,
          };
        }
      }
    }
    // Every pinned binding is still emitted. Whole-object fields are checked below.
    for (const [field, pinnedEntries] of passthrough) {
      if (DEPLOY_WHOLE_OBJECT_PINNED_FIELDS.includes(field) || pinnedEntries.size === 0) {
        continue;
      }
      const emittedNames = new Set<string>();
      if (generated[field] !== undefined) {
        try {
          for (const { name } of bindingEntriesForField(field, generated[field])) {
            emittedNames.add(name);
          }
        } catch {
          // A malformed field emits no names, so every pinned name is reported missing.
        }
      }
      for (const name of pinnedEntries.keys()) {
        if (!emittedNames.has(name)) {
          return {
            ok: false,
            reason: `generated config no longer declares the ${field} binding ${JSON.stringify(name)} that was present before the build — refusing to deploy a build that dropped a ${field} binding the source declared.`,
          };
        }
      }
    }
  }
  // Fields compared as whole values against the pre-build root (`unsafe`, tail consumers, routes,
  // `addresses`, …). An empty value passes only when the root's is empty too, except `addresses`:
  // `[]` deletes every email routing rule the Worker owns, so it must match exactly.
  if (expected.passthroughRawFields) {
    const raw = expected.passthroughRawFields;
    for (const field of DEPLOY_WHOLE_OBJECT_PINNED_FIELDS) {
      const emitted = generated[field];
      const rootValue = raw.get(field);
      if (
        field !== 'addresses' &&
        isEmptyPassthroughValue(emitted) &&
        isEmptyPassthroughValue(rootValue)
      ) {
        continue;
      }
      if (!deepEqual(emitted, rootValue)) {
        return {
          ok: false,
          reason: `generated config ${field} value does not match the pre-build config — refusing to deploy a ${field} value the build added, removed, or rewrote.`,
        };
      }
    }
    const externalDo = verifyNoInjectedExternalDurableObject(
      generated.durable_objects,
      raw.get('durable_objects'),
    );
    if (!externalDo.ok) {
      return externalDo;
    }
    const emittedAi = generated.ai;
    const rootAi = raw.get('ai');
    if (rootAi !== undefined) {
      // A root ai binding must survive unchanged; removing it fails too.
      if (!deepEqual(emittedAi, rootAi)) {
        return {
          ok: false,
          reason: `generated config ai binding does not match the pre-build root ai binding — refusing to deploy an ai binding the build removed or rewrote.`,
        };
      }
    } else if (emittedAi !== undefined) {
      // Otherwise only Void's own AI binding, and only when the source uses Workers AI.
      const expectedAi = { binding: expected.aiBindingName ?? DEFAULT_VOID_AI_BINDING };
      if (!(expected.needsAI === true && deepEqual(emittedAi, expectedAi))) {
        return {
          ok: false,
          reason: `generated config declares an ai binding the build injected — the pre-build inference found no Workers AI use in the source and the root config declares no ai binding.`,
        };
      }
    }
    // Void emits only creation migrations; a destructive one must come from the root config.
    const destructiveMigration = verifyNoInjectedDestructiveMigration(
      generated.migrations,
      raw.get('migrations'),
    );
    if (!destructiveMigration.ok) {
      return destructiveMigration;
    }
  }
  if (expected.expectedDurableObjectBindings) {
    let emittedBindings: Array<Record<string, unknown>>;
    try {
      emittedBindings = bindingEntriesForField('durable_objects', generated.durable_objects).map(
        ({ entry }) => entry,
      );
    } catch {
      return {
        ok: false,
        reason: 'generated config durable_objects bindings could not be verified.',
      };
    }
    const byName = (left: Record<string, unknown>, right: Record<string, unknown>) =>
      String(left.name).localeCompare(String(right.name));
    if (
      !deepEqual(
        [...emittedBindings].sort(byName),
        [...expected.expectedDurableObjectBindings].sort(byName),
      )
    ) {
      return {
        ok: false,
        reason:
          'generated config durable_objects bindings differ from the pre-build binding set — refusing to deploy a binding the build added, removed, or retargeted.',
      };
    }
  }
  if (expected.expectedMigrations) {
    if (generated.migrations !== undefined && !Array.isArray(generated.migrations)) {
      return { ok: false, reason: 'generated config migrations could not be verified.' };
    }
    const emittedMigrations = Array.isArray(generated.migrations) ? generated.migrations : [];
    if (!deepEqual(emittedMigrations, expected.expectedMigrations)) {
      return {
        ok: false,
        reason:
          'generated config migrations differ from the pre-build migration sequence — refusing to deploy a migration the build added, removed, or retargeted.',
      };
    }
  }
  // Containers must equal the expected set, keyed by `class_name`: an emitted container
  // provisions a billable application that runs its image.
  if (expected.expectedContainers) {
    const emittedContainers: Array<unknown> = Array.isArray(generated.containers)
      ? generated.containers
      : [];
    const expectedContainers = expected.expectedContainers;
    if (emittedContainers.length !== 0 || expectedContainers.length !== 0) {
      const expectedByClass = new Map<string, Record<string, unknown>>();
      const expectedNoClass: Array<unknown> = [];
      for (const container of expectedContainers) {
        const className = readD1EntryString(container, 'class_name');
        if (className === undefined) {
          expectedNoClass.push(container);
        } else {
          expectedByClass.set(className, container);
        }
      }
      const emittedByClass = new Map<string, unknown>();
      const emittedNoClass: Array<unknown> = [];
      for (const container of emittedContainers) {
        const className = readD1EntryString(container, 'class_name');
        if (className === undefined) {
          emittedNoClass.push(container);
        } else {
          emittedByClass.set(className, container);
        }
      }
      // Injected / retargeted — every emitted container must be expected AND byte-identical.
      for (const [className, container] of emittedByClass) {
        const expectedContainer = expectedByClass.get(className);
        if (expectedContainer === undefined) {
          return {
            ok: false,
            reason: `generated config declares a container application ${JSON.stringify(className)} that Void did not derive from source — refusing to deploy a container application the build injected.`,
          };
        }
        if (
          !deepEqual(
            normalizeContainerImagePaths(container, dirname(redirectedPath)),
            normalizeContainerImagePaths(expectedContainer, root),
          )
        ) {
          return {
            ok: false,
            reason: `generated config container application ${JSON.stringify(className)} does not match the pre-build config — refusing to deploy a container application the build retargeted.`,
          };
        }
      }
      // Dropped — every expected container must still be emitted.
      for (const className of expectedByClass.keys()) {
        if (!emittedByClass.has(className)) {
          return {
            ok: false,
            reason: `generated config no longer declares the container application ${JSON.stringify(className)} that Void derived from source — refusing to deploy a build that dropped a container application.`,
          };
        }
      }
      // Class-less containers — deepEqual multiset (never a Void-emitted shape).
      for (const emitted of emittedNoClass) {
        const matchIndex = expectedNoClass.findIndex((candidate) => deepEqual(emitted, candidate));
        if (matchIndex === -1) {
          return {
            ok: false,
            reason: `generated config declares a container application that Void did not derive from source — refusing to deploy a container application the build injected.`,
          };
        }
        expectedNoClass.splice(matchIndex, 1);
      }
      if (expectedNoClass.length > 0) {
        return {
          ok: false,
          reason: `generated config no longer declares a container application that was present before the build — refusing to deploy a build that dropped a container application.`,
        };
      }
    }
  }
  // Every emitted queue must be one Void derived from source.
  if (expected.desired) {
    const desiredQueues = new Set(expected.desired.queues);
    const emittedProducers = collectEmittedQueueGroupNames(generated.queues, 'producers');
    const emittedConsumers = collectEmittedQueueGroupNames(generated.queues, 'consumers');
    for (const name of [...emittedProducers, ...emittedConsumers]) {
      if (!desiredQueues.has(name)) {
        return {
          ok: false,
          reason: `generated config declares a queue binding ${JSON.stringify(name)} that Void did not derive from source — refusing to deploy a queue binding the build injected.`,
        };
      }
    }
    // Void emits every desired queue as both a producer and a consumer; both must remain.
    for (const name of expected.desired.queues) {
      if (!emittedProducers.has(name) || !emittedConsumers.has(name)) {
        return {
          ok: false,
          reason: `generated config no longer binds the queue ${JSON.stringify(name)} as both a producer and a consumer that Void derived from source — refusing to deploy a build that dropped a queue binding the source declared.`,
        };
      }
    }
  }
  // Emitted cron schedules must equal the expected multiset. A missing or non-array
  // `triggers.crons` counts as none.
  if (expected.expectedCrons) {
    const triggers = generated.triggers;
    const emittedCrons: Array<unknown> =
      typeof triggers === 'object' &&
      triggers !== null &&
      Array.isArray((triggers as Record<string, unknown>).crons)
        ? ((triggers as Record<string, unknown>).crons as Array<unknown>)
        : [];
    const expectedCronCounts = new Map<string, number>();
    for (const schedule of expected.expectedCrons) {
      expectedCronCounts.set(schedule, (expectedCronCounts.get(schedule) ?? 0) + 1);
    }
    // Injected / retargeted — every emitted schedule must have a remaining expected count.
    for (const schedule of emittedCrons) {
      const remaining = typeof schedule === 'string' ? (expectedCronCounts.get(schedule) ?? 0) : 0;
      if (typeof schedule !== 'string' || remaining <= 0) {
        return {
          ok: false,
          reason: `generated config declares a cron trigger schedule ${JSON.stringify(schedule)} that Void did not derive from source — refusing to deploy a schedule the build injected.`,
        };
      }
      expectedCronCounts.set(schedule, remaining - 1);
    }
    // Dropped — any leftover count is a schedule the build removed.
    for (const [schedule, remaining] of expectedCronCounts) {
      if (remaining > 0) {
        return {
          ok: false,
          reason: `generated config no longer installs the cron trigger schedule ${JSON.stringify(schedule)} that Void derived from source — refusing to deploy a build that dropped a cron trigger.`,
        };
      }
    }
  }
  return { ok: true };
}

/** Check the built Worker against the pinned deployment target before upload. */
export function verifyCloudflareDeployArtifact(
  root: string,
  deps: CloudflareDeployDeps,
  options: Parameters<typeof verifyGeneratedDeployConfig>[1],
): boolean {
  const verification = (deps.verifyDeployConfig ?? verifyGeneratedDeployConfig)(root, options);
  if (!verification.ok) {
    log.error(
      [
        'deploy: the generated deploy config does not match the pinned target — refusing to deploy.',
        verification.reason,
        'This typically means CLOUDFLARE_ENV / CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH (in the',
        'environment or a production `.env`) selected a different named environment or config',
        'at build time. This backend always deploys the canonical top-level config — remove',
        'them and rebuild.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return false;
  }

  return true;
}

/** Validate emitted Worker vars and required secrets against post-build ground truth. */
export async function validateCloudflarePostBuildEnv(options: {
  root: string;
  configPath: string;
  accountId: string;
  apiBaseUrl: string;
  workerName: string;
  schemaFacts: SelfHostSchemaFacts;
  authEnabled: boolean;
  existingWorker: ExistingCloudflareWorker | null;
  approvedHandoffKv: Array<ApprovedCloudflareKvBinding>;
  deps: CloudflareDeployDeps;
  assertUploaderStillPinned: () => boolean;
}): Promise<boolean> {
  const {
    root,
    configPath,
    accountId,
    apiBaseUrl,
    workerName,
    schemaFacts,
    authEnabled,
    existingWorker,
    approvedHandoffKv,
    deps,
    assertUploaderStillPinned,
  } = options;
  const emitted = (deps.readEmittedWorkerVars ?? readEmittedWorkerVars)(root);
  if (existingWorker) {
    const generated = readGeneratedDeployConfig(root);
    assertExistingCloudflareConfig(existingWorker, generated.config, true, approvedHandoffKv);
  }
  if (!emitted.ok) {
    log.error(
      [
        'deploy: could not read the worker vars the build emitted — refusing to validate secrets.',
        `  ${emitted.reason}`,
        'The build must emit dist/ssr/wrangler.json for this backend. Rerun the build, or deploy',
        'this app with `void deploy` (the managed platform).',
      ].join('\n'),
    );
    return false;
  }
  const emittedVars = emitted.vars;
  // Better Auth's signing secret belongs in the secret store, never in plaintext vars.
  if (authEnabled && Object.prototype.hasOwnProperty.call(emittedVars, BETTER_AUTH_SECRET_NAME)) {
    log.error(
      [
        `deploy: ${BETTER_AUTH_SECRET_NAME} must be stored as a Cloudflare Worker secret, not a plaintext worker var.`,
        'Remove it from Worker vars and rerun. This deploy command preserves an',
        'existing remote value or creates a persistent one automatically when it is missing.',
      ].join('\n'),
    );
    return false;
  }

  const plaintextServerKeys = schemaFacts.serverKeys.filter((key) => key in emittedVars);
  if (plaintextServerKeys.length > 0) {
    log.error(
      [
        'deploy: server env keys cannot ship as plaintext Worker vars:',
        ...plaintextServerKeys.map((key) => `  • ${key}`),
        'Remove them from Worker vars and set them with `void secret put <NAME>`.',
      ].join('\n'),
    );
    return false;
  }

  // A required key the build did not emit must exist as a remote secret. Value validation runs
  // project code, so it stays in the isolated probe.
  const envContext = deriveSelfHostEnvContextFromVars(emittedVars, schemaFacts);
  if (schemaFacts.hasSchema) {
    let validateResult: EnvSchemaValidateResult;
    try {
      validateResult = await (deps.validateEmittedVars ?? validateEmittedVarsDefault)(
        { root },
        buildSchemaProbeEnv(accountId, apiBaseUrl),
      );
    } catch (err) {
      log.error(
        `deploy: could not validate the emitted worker vars against the env schema — ${getErrorMessage(err)}`,
      );
      return false;
    }
    if (validateResult.kind === 'schema-error') {
      log.error(`deploy: ${selfHostSchemaFailureMessage(validateResult.reason)}`);
      return false;
    }
    envContext.invalidKeys = validateResult.invalidKeys;
  }
  // The deploy provisions the auth secret itself later, so the generic gate must not reject it.
  if (authEnabled) {
    envContext.absentRequired = envContext.absentRequired.filter(
      (key) => key !== BETTER_AUTH_SECRET_NAME,
    );
    envContext.invalidKeys = envContext.invalidKeys.filter(
      (key) => key !== BETTER_AUTH_SECRET_NAME,
    );
  }
  // The probe above ran project code, so re-check the uploader before the credentialed secret list.
  if (!assertUploaderStillPinned()) {
    return false;
  }
  try {
    await (deps.dischargeSelfHostEnv ?? dischargeSelfHostEnvContext)(envContext, {
      root,
      configPath,
      accountId,
      // The probe could have rewritten the config's `name`; pin the expected Worker.
      workerName,
    });
  } catch (err) {
    if (
      err instanceof SelfHostFirstDeployError ||
      err instanceof SelfHostSecretListError ||
      err instanceof SelfHostEnvValidationError ||
      err instanceof SelfHostSchemaError
    ) {
      log.error(err.message);
      return false;
    }
    throw err;
  }

  return true;
}
