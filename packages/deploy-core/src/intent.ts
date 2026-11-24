import type { DeployManifest } from './index.ts';
import { createDeployResourcePlan } from './resource-plan.ts';
import type { DeployResourcePlan } from './resource-plan.ts';
import type { DeployAppType } from './target.ts';

export type DeployRuntimeFeatures = Readonly<{
  assets: boolean;
  auth: boolean;
  cron: boolean;
  queues: boolean;
  migrations: boolean;
  ai: boolean;
  durableObjects: boolean;
  webSockets: boolean;
  live: boolean;
  sandbox: boolean;
  isr: boolean;
  prerender: boolean;
}>;

/** Canonical, target-neutral interpretation of a deployment manifest. */
export type DeployIntent = Readonly<{
  appType: DeployAppType;
  hasWorker: boolean;
  manifest: DeployManifest;
  resourcePlan: DeployResourcePlan;
  features: DeployRuntimeFeatures;
}>;

/**
 * Interpret a manifest once before a target assigns provider names and ids.
 * This function performs no I/O and does not mutate the manifest.
 */
export function createDeployIntent(manifest: DeployManifest): DeployIntent {
  const appType = manifest.type ?? (manifest.framework ? 'framework' : 'void');
  const webSockets = (manifest.websocket?.classes.length ?? 0) > 0;
  const live = manifest.live !== undefined;
  const sandbox = manifest.sandbox !== undefined;

  return {
    appType,
    hasWorker: appType === 'void' || appType === 'framework',
    manifest,
    resourcePlan: createDeployResourcePlan(manifest),
    features: {
      assets: manifest.assetConfig !== undefined,
      auth: manifest.auth === true,
      cron: (manifest.schedules?.length ?? 0) > 0,
      queues: (manifest.queues?.length ?? 0) > 0,
      migrations: (manifest.migrations?.pending ?? 0) > 0,
      ai: manifest.bindings.ai === true,
      durableObjects: webSockets || live || sandbox,
      webSockets,
      live,
      sandbox,
      isr:
        manifest.revalidate !== undefined ||
        manifest.pathRevalidate !== undefined ||
        (manifest.pages?.some((page) => page.revalidate !== undefined) ?? false),
      prerender: (manifest.prerender?.length ?? 0) > 0,
    },
  };
}
