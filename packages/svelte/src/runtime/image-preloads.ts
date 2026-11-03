/**
 * Context key of the `ImagePreloads` of one render root. `App.svelte`, island
 * wrappers and island hydration each provide a fresh map.
 */
export const IMAGE_PRELOADS_KEY = '__void_image_preloads';

/** An `Image` that wants a preload link. */
export type ImagePreloadClaim = {
  /** The preload key this `Image` claimed. */
  key?: string;
  /** Called when this `Image` becomes the one that renders the link for its key. */
  promote(): void;
};

/**
 * The `Image`s of one render root that want each preload link, in render
 * order. Only the first renders the link, so a render has one preload link
 * per image, as `next/image` gets from React.
 */
export type ImagePreloads = Map<string, Array<ImagePreloadClaim>>;

/**
 * Claims `key` for `claim`, releasing the key it held before. Returns whether
 * `claim` renders the preload link: it is the first claim for `key`, or there
 * is no `preloads` to share links through.
 */
export function claimImagePreload(
  preloads: ImagePreloads | undefined,
  claim: ImagePreloadClaim,
  key: string | undefined,
): boolean {
  if (!preloads) {
    return true;
  }
  if (claim.key !== key) {
    releaseImagePreload(preloads, claim);
    if (key !== undefined) {
      const claims = preloads.get(key);
      if (claims) {
        claims.push(claim);
      } else {
        preloads.set(key, [claim]);
      }
      claim.key = key;
    }
  }
  return key !== undefined && preloads.get(key)?.[0] === claim;
}

/** Releases the key `claim` holds; the next claim for that key renders the link. */
export function releaseImagePreload(
  preloads: ImagePreloads | undefined,
  claim: ImagePreloadClaim,
): void {
  const key = claim.key;
  if (!preloads || key === undefined) {
    return;
  }
  claim.key = undefined;
  const claims = preloads.get(key);
  const index = claims ? claims.indexOf(claim) : -1;
  if (!claims || index === -1) {
    return;
  }
  claims.splice(index, 1);
  if (claims.length === 0) {
    preloads.delete(key);
  } else if (index === 0) {
    claims[0].promote();
  }
}
