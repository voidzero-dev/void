/** Create a storage client for a specific R2Bucket instance. */
export function createStorage(bucket: R2Bucket): R2Bucket {
  return bucket;
}

import { requireRuntimeBinding } from './env.ts';

/** Default storage client — resolves `STORAGE` from the active runtime environment. */
export const storage: R2Bucket = new Proxy({} as R2Bucket, {
  get(_target, prop) {
    const bucket = requireRuntimeBinding<R2Bucket>('STORAGE');
    const value = Reflect.get(bucket as object, prop, bucket);
    return typeof value === 'function' ? value.bind(bucket) : value;
  },
});
