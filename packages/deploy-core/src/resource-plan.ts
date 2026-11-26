import type { DeployManifest, QueueMeta } from './index.ts';

export type DeployResource =
  | { type: 'd1'; bindingName: string; readReplication?: boolean }
  | { type: 'kv'; bindingName: string }
  | { type: 'r2'; bindingName: string }
  | { type: 'queue'; bindingName: string; resourceName: string; consumer: QueueMeta }
  | { type: 'hyperdrive'; bindingName: string };

export type DeployResourcePlan = {
  resources: Array<DeployResource>;
  runtime: {
    ai: boolean;
    schedules: NonNullable<DeployManifest['schedules']>;
    websocket: DeployManifest['websocket'] | null;
    sandbox: DeployManifest['sandbox'] | null;
    live: DeployManifest['live'] | null;
  };
};

/**
 * Convert a deployment manifest into provider-neutral resource intent.
 *
 * Resource names, remote ids, and injected platform bindings belong to the
 * target adapter and are deliberately absent from this plan.
 */
export function createDeployResourcePlan(manifest: DeployManifest): DeployResourcePlan {
  const resources: Array<DeployResource> = [];

  for (const bindingName of manifest.bindings.d1 ?? []) {
    resources.push({
      type: 'd1',
      bindingName,
      ...(manifest.database?.readReplication !== undefined && {
        readReplication: manifest.database.readReplication,
      }),
    });
  }
  for (const bindingName of manifest.bindings.kv ?? []) {
    resources.push({ type: 'kv', bindingName });
  }
  for (const bindingName of manifest.bindings.r2 ?? []) {
    resources.push({ type: 'r2', bindingName });
  }
  for (const consumer of manifest.queues ?? []) {
    resources.push({
      type: 'queue',
      bindingName: consumer.bindingName,
      resourceName: consumer.name,
      consumer,
    });
  }
  for (const bindingName of manifest.bindings.hyperdrive ?? []) {
    resources.push({ type: 'hyperdrive', bindingName });
  }

  return {
    resources,
    runtime: {
      ai: manifest.bindings.ai === true,
      schedules: manifest.schedules ?? [],
      websocket: manifest.websocket ?? null,
      sandbox: manifest.sandbox ?? null,
      live: manifest.live ?? null,
    },
  };
}
