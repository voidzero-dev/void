/** Create a storage client for a specific R2Bucket instance. */
export function createStorage(bucket: R2Bucket): R2Bucket {
  return bucket;
}

import { requireRuntimeBinding } from '../env/runtime.ts';

/** Default storage client — resolves `STORAGE` from the active runtime environment. */
export const storage: R2Bucket = new Proxy({} as R2Bucket, {
  get(_target, prop): unknown {
    const bucket = requireRuntimeBinding<R2Bucket>('STORAGE');
    const value: unknown = Reflect.get(bucket, prop, bucket);
    return typeof value === 'function' ? value.bind(bucket) : value;
  },
});
