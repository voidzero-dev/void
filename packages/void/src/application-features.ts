import type { InferenceConfig, VoidConfig } from './config.ts';
import { imageOptimizerConfigured } from './image-config.ts';
import type { InferredBindings } from './inference/walk.ts';
import type { DetectedFramework } from './plugin-inference.ts';

/** Apply explicitly named overrides while preserving unrelated source features. */
export function applyBindingOverrides(
  inferred: InferredBindings,
  overrides?: InferenceConfig['bindings'],
): InferredBindings {
  const bindings = { ...inferred };
  if (overrides) {
    const keys = {
      db: 'needsD1',
      kv: 'needsKV',
      storage: 'needsR2',
      ai: 'needsAI',
      email: 'needsEmail',
      images: 'needsImages',
    } as const;
    for (const [key, inferredKey] of Object.entries(keys)) {
      const value = overrides[key as keyof typeof keys];
      if (value !== undefined) {
        bindings[inferredKey] = Boolean(value);
      }
    }
  }
  return bindings;
}

/**
 * Whether the default `/_void/image` optimizer serves this app: a Void app
 * (frameworks own their routes) on Cloudflare with server output and the
 * default loader.
 */
export function isImageOptimizerEnabled(
  config: Pick<VoidConfig, 'images' | 'target' | 'output'>,
  framework: DetectedFramework | undefined,
): boolean {
  return (
    framework === undefined &&
    imageOptimizerConfigured(config.images, { target: config.target, output: config.output })
  );
}

/**
 * `Image` and `getImageProps` need the Images binding only while the default
 * `/_void/image` optimizer serves the app. An `env.IMAGES` read always does.
 */
export function applyImageOptimizerRequirement(
  inferred: InferredBindings,
  imageOptimizer: boolean,
): InferredBindings {
  return imageOptimizer && inferred.usesImageOptimizer && !inferred.needsImages
    ? { ...inferred, needsImages: true }
    : inferred;
}

/** Shared database requirement for development and both deployment targets. */
export function needsApplicationDatabase(
  bindings: Pick<InferredBindings, 'needsD1' | 'needsAuth'>,
  migrationCount: number,
): boolean {
  return bindings.needsD1 || bindings.needsAuth || migrationCount > 0;
}
