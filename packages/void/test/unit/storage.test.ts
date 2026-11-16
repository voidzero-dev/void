import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { createStorage } from '../../src/runtime/storage/index.ts';

describe('createStorage', () => {
  it('returns the bucket directly', () => {
    const bucket = {} as R2Bucket;
    expect(createStorage(bucket)).toBe(bucket);
  });
});
