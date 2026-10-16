import { describe, expect, it } from 'vite-plus/test';
import {
  claimImagePreload,
  releaseImagePreload,
  type ImagePreloadClaim,
  type ImagePreloads,
} from '../../src/runtime/image-preloads.ts';

function createClaim(): ImagePreloadClaim & { promotions: number } {
  return {
    promotions: 0,
    promote() {
      this.promotions++;
    },
  };
}

describe('image preload claims', () => {
  it('lets the first claim for a key render the link', () => {
    const preloads: ImagePreloads = new Map();
    const first = createClaim();
    const second = createClaim();
    const other = createClaim();
    expect(claimImagePreload(preloads, first, 'a')).toBe(true);
    expect(claimImagePreload(preloads, second, 'a')).toBe(false);
    expect(claimImagePreload(preloads, other, 'b')).toBe(true);
    // Claiming the same key again changes nothing.
    expect(claimImagePreload(preloads, first, 'a')).toBe(true);
    expect(claimImagePreload(preloads, second, 'a')).toBe(false);
    expect(first.promotions + second.promotions + other.promotions).toBe(0);
  });

  it('promotes the next claim when the first is released', () => {
    const preloads: ImagePreloads = new Map();
    const first = createClaim();
    const second = createClaim();
    const third = createClaim();
    claimImagePreload(preloads, first, 'a');
    claimImagePreload(preloads, second, 'a');
    claimImagePreload(preloads, third, 'a');

    // Releasing a claim that does not render the link promotes nobody.
    releaseImagePreload(preloads, second);
    expect(second.promotions + third.promotions).toBe(0);

    releaseImagePreload(preloads, first);
    expect(third.promotions).toBe(1);
    expect(claimImagePreload(preloads, third, 'a')).toBe(true);

    releaseImagePreload(preloads, third);
    expect(preloads.size).toBe(0);
    // Releasing twice is harmless.
    releaseImagePreload(preloads, third);
  });

  it('releases the previous key when a claim changes key', () => {
    const preloads: ImagePreloads = new Map();
    const first = createClaim();
    const second = createClaim();
    claimImagePreload(preloads, first, 'a');
    claimImagePreload(preloads, second, 'a');

    expect(claimImagePreload(preloads, first, 'b')).toBe(true);
    expect(second.promotions).toBe(1);
    expect(claimImagePreload(preloads, second, 'a')).toBe(true);

    // Dropping the key (no preload) releases it too.
    expect(claimImagePreload(preloads, first, undefined)).toBe(false);
    expect(preloads.has('b')).toBe(false);
  });

  it('renders every link without a preload context', () => {
    const claim = createClaim();
    expect(claimImagePreload(undefined, claim, 'a')).toBe(true);
    expect(claimImagePreload(undefined, createClaim(), 'a')).toBe(true);
    releaseImagePreload(undefined, claim);
    expect(claim.promotions).toBe(0);
  });
});
