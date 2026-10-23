import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseCloudflareVersionMessage,
  readCloudflareTriggerConfig,
  type CloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import { recordInstallationStep, type PlatformInstallationManifest } from '@void/platform';
import { join } from 'pathslash';
import {
  readActivePlatformWorkerSnapshot,
  readPlatformWorkerOwnershipMarker,
} from './platform-installer-inspection.ts';
import { runPlatformWrangler } from './platform-installer-process.ts';
import {
  type PlatformWorkerKey,
  type PlatformWorkerCutoverSnapshot,
  type InterruptedWorkerCutover,
} from './platform-installer-types.ts';
import { latestPlatformWorkerCutoverGeneration } from './platform-registry.ts';

export function withoutCompletedPlatformWorkerMigrations(
  config: Record<string, unknown>,
  activeMigrationTag: string | null,
): Record<string, unknown> {
  const migrations = Array.isArray(config.migrations) ? config.migrations : [];
  const target = migrations.at(-1);
  if (
    activeMigrationTag === null ||
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    (target as { tag?: unknown }).tag !== activeMigrationTag
  ) {
    return config;
  }
  const result = { ...config };
  delete result.migrations;
  return result;
}

export function readTriggerConfigFromObject(
  config: Record<string, unknown>,
): CloudflareTriggerConfig {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-triggers-'));
  try {
    const path = join(directory, 'wrangler.json');
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return readCloudflareTriggerConfig(path);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function nextTrafficGeneration(manifest: PlatformInstallationManifest): number {
  return (
    Math.max(
      0,
      ...manifest.steps.flatMap((step) => {
        const match = /^traffic-enabled:(\d+)$/.exec(step.key);
        return match ? [Number(match[1])] : [];
      }),
    ) + 1
  );
}

export function nextWorkerCutoverGeneration(manifest: PlatformInstallationManifest): number {
  return latestPlatformWorkerCutoverGeneration(manifest) + 1;
}

export function recordWorkerSecretUpdateState(
  manifest: PlatformInstallationManifest,
  generation: number,
  state: 'pending' | 'committed',
  intentId: string,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-secret-updates:${generation}:${state}`,
      resultHash: intentId,
    },
    completedAt,
  );
}

export function workerCutoverUpdatesSecrets(
  manifest: PlatformInstallationManifest,
  generation: number,
): boolean {
  return manifest.steps.some((step) => step.key === `worker-secret-updates:${generation}:pending`);
}

export function recordWorkerCutoverStage(
  manifest: PlatformInstallationManifest,
  generation: number,
  key: PlatformWorkerKey,
  previousVersionId: string | null,
  stagedVersionId: string,
  workerName: string,
  previousTriggers: CloudflareTriggerConfig,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-cutover:${generation}:staged:${key}`,
      resultHash: Buffer.from(
        JSON.stringify({
          previousTriggers,
          previousVersionId,
          schema: 1,
          stagedVersionId,
          workerName,
        }),
      ).toString('base64url'),
    },
    completedAt,
  );
}

export function recordWorkerCutoverResolution(
  manifest: PlatformInstallationManifest,
  generation: number,
  resolution: 'committed' | 'restored',
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-cutover:${generation}:${resolution}`,
      resultHash: resolution,
    },
    completedAt,
  );
}

export function recordWorkerUnsafeTraffic(
  manifest: PlatformInstallationManifest,
  generation: number,
  key: PlatformWorkerKey,
  workerName: string,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-cutover:${generation}:unsafe-traffic:${key}`,
      resultHash: workerName,
    },
    completedAt,
  );
}

function parseWorkerCutoverSnapshot(value: string): PlatformWorkerCutoverSnapshot | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      previousTriggers?: unknown;
      previousVersionId?: unknown;
      schema?: unknown;
      stagedVersionId?: unknown;
      workerName?: unknown;
    };
    const metadata = parseCloudflareVersionMessage(
      `void:${JSON.stringify({
        migrations: [],
        schema: 2,
        triggerConfig: parsed.previousTriggers,
      })}`,
    );
    if (
      parsed.schema !== 1 ||
      (parsed.previousVersionId !== null && typeof parsed.previousVersionId !== 'string') ||
      typeof parsed.stagedVersionId !== 'string' ||
      parsed.stagedVersionId === '' ||
      typeof parsed.workerName !== 'string' ||
      parsed.workerName === '' ||
      metadata?.schema !== 2
    ) {
      return null;
    }
    return {
      previousTriggers: metadata.triggerConfig,
      previousVersionId: parsed.previousVersionId,
      stagedVersionId: parsed.stagedVersionId,
      workerName: parsed.workerName,
    };
  } catch {
    return null;
  }
}

function workerCutoverGenerations(manifest: PlatformInstallationManifest) {
  const generations = new Map<
    number,
    {
      resolution: 'committed' | 'restored' | null;
      staged: Map<
        PlatformWorkerKey,
        {
          previousVersionId: string | null;
          previousTriggers: CloudflareTriggerConfig;
          stagedVersionId: string;
          workerName: string;
        }
      >;
      unsafeTraffic: Set<PlatformWorkerKey>;
    }
  >();
  for (const step of manifest.steps) {
    const resolution = /^worker-cutover:(\d+):(committed|restored)$/.exec(step.key);
    if (resolution) {
      const generation = Number(resolution[1]);
      const entry = generations.get(generation) ?? {
        resolution: null,
        staged: new Map(),
        unsafeTraffic: new Set(),
      };
      entry.resolution = resolution[2] as 'committed' | 'restored';
      generations.set(generation, entry);
      continue;
    }
    const unsafeTraffic =
      /^worker-cutover:(\d+):unsafe-traffic:(api|proxy|emailGateway|tail|dispatch)$/.exec(step.key);
    if (unsafeTraffic) {
      const generation = Number(unsafeTraffic[1]);
      const entry = generations.get(generation) ?? {
        resolution: null,
        staged: new Map(),
        unsafeTraffic: new Set(),
      };
      entry.unsafeTraffic.add(unsafeTraffic[2] as PlatformWorkerKey);
      generations.set(generation, entry);
      continue;
    }
    const staged = /^worker-cutover:(\d+):staged:(api|proxy|emailGateway|tail|dispatch)$/.exec(
      step.key,
    );
    if (!staged) {
      continue;
    }
    const generation = Number(staged[1]);
    const snapshot = parseWorkerCutoverSnapshot(step.resultHash);
    if (!snapshot) {
      throw new Error(`platform: Invalid Worker cutover checkpoint ${step.key}.`);
    }
    const entry = generations.get(generation) ?? {
      resolution: null,
      staged: new Map(),
      unsafeTraffic: new Set(),
    };
    entry.staged.set(staged[2] as PlatformWorkerKey, snapshot);
    generations.set(generation, entry);
  }
  return generations;
}

export function interruptedWorkerCutover(
  manifest: PlatformInstallationManifest,
): InterruptedWorkerCutover | null {
  const unresolved = [...workerCutoverGenerations(manifest).entries()]
    .filter(([, entry]) => entry.resolution === null && entry.staged.size > 0)
    .sort(([left], [right]) => right - left)[0];
  return unresolved
    ? {
        generation: unresolved[0],
        staged: unresolved[1].staged,
        unsafeTraffic: unresolved[1].unsafeTraffic,
      }
    : null;
}

export async function verifyPlatformWorkerCutoverVersions(
  manifest: PlatformInstallationManifest,
  generation: number,
  configs: Record<PlatformWorkerKey, Record<string, unknown>>,
  accountId: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
  workerKeys: ReadonlyArray<PlatformWorkerKey> = [
    'api',
    'proxy',
    'emailGateway',
    'tail',
    'dispatch',
  ],
): Promise<void> {
  // Shared email setup commits the retained Worker set before its provider
  // mutations. Final verification must still inspect that exact generation.
  const cutover = workerCutoverGenerations(manifest).get(generation);
  if (!cutover || cutover.resolution === 'restored' || cutover.staged.size !== workerKeys.length) {
    throw new Error(
      `platform: Worker cutover generation ${generation} is missing a complete immutable-version checkpoint.`,
    );
  }
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-cutover-verify-'));
  try {
    for (const key of workerKeys) {
      const snapshot = cutover.staged.get(key);
      if (!snapshot) {
        throw new Error(
          `platform: Worker cutover generation ${generation} is missing its ${key} checkpoint.`,
        );
      }
      const config = configs[key];
      const configPath = join(directory, `${key}.wrangler.json`);
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      const active = await readActivePlatformWorkerSnapshot(
        configPath,
        accountId,
        snapshot.workerName,
        readPlatformWorkerOwnershipMarker(config),
        runner,
      );
      if (active.versionId !== snapshot.stagedVersionId) {
        throw new Error(
          `platform: Worker ${snapshot.workerName} changed concurrently from staged version ${snapshot.stagedVersionId} to ${active.versionId}; refusing to enable platform traffic.`,
        );
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function recordWorkerTrafficState(
  manifest: PlatformInstallationManifest,
  generation: number,
  enabled: boolean,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-traffic-state:${generation}`,
      resultHash: enabled ? 'enabled' : 'disabled',
    },
    completedAt,
  );
}

export function stablePublicEndpointState(existing: PlatformInstallationManifest | null): boolean {
  if (!existing) {
    return false;
  }
  // `void platform disable` removes traffic without redeploying Workers, so it
  // does not create a Worker cutover marker. Its durable desired state is
  // authoritative over the last successful install/upgrade marker.
  if (existing.status === 'disabled' || existing.desiredState === 'disabled') {
    return false;
  }
  const latest = existing.steps
    .flatMap((step) => {
      const match = /^worker-traffic-state:(\d+)$/.exec(step.key);
      return match ? [{ generation: Number(match[1]), state: step.resultHash }] : [];
    })
    .sort((left, right) => right.generation - left.generation)[0];
  if (latest) {
    return latest.state === 'enabled';
  }
  // Older manifests do not have a Worker traffic marker. Only a completed
  // install proves that their endpoints were ever intentionally published.
  // Fresh and interrupted installs begin with desiredState=enabled, so using
  // desired state here would let a resume bypass the initial traffic gate.
  return existing.status === 'installed';
}

export function resolvePlatformPreviousTriggerConfig(
  versionSnapshot: CloudflareTriggerConfig,
  configuredSnapshot: CloudflareTriggerConfig,
  publicEndpoints: boolean,
): CloudflareTriggerConfig {
  if (publicEndpoints) {
    return versionSnapshot;
  }
  // Disable removes public traffic without uploading a new immutable Worker
  // version, so the active version message can still describe the last enabled
  // routes. The durable lifecycle state owns those three traffic fields while
  // the version message remains authoritative for cron, queue, and workflow
  // triggers that disable does not change.
  return {
    ...versionSnapshot,
    preview_urls: configuredSnapshot.preview_urls,
    routes: configuredSnapshot.routes,
    workers_dev: configuredSnapshot.workers_dev,
  };
}
