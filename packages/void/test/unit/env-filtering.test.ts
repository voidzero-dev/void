import { describe, it, expect } from 'vite-plus/test';
import {
  getRuntimeBinding,
  getRuntimeEnv,
  withRuntimeEnv,
  requireRuntimeBinding,
} from '../../src/runtime/env/runtime.ts';

describe('internal binding filtering (real implementation)', () => {
  const testEnv = {
    DB: 'd1-binding',
    __VOID_PROXY_TOKEN: 'secret-token',
    __PROJECT_ID: 'proj_123',
  };

  it.each(['__VOID_PROXY_TOKEN', '__PROJECT_ID'])('hides %s from every env accessor', (name) => {
    withRuntimeEnv(testEnv, () => {
      const env = getRuntimeEnv();
      expect(env[name]).toBeUndefined();
      expect(name in env).toBe(false);
      expect(Object.keys(env)).not.toContain(name);
      expect(getRuntimeBinding(name)).toBeUndefined();
      expect(() => requireRuntimeBinding(name)).toThrow(
        `env: Missing Cloudflare binding '${name}'`,
      );
    });
  });

  it('keeps user bindings visible', () => {
    withRuntimeEnv(testEnv, () => {
      const env = getRuntimeEnv();
      expect(env.DB).toBe('d1-binding');
      expect('DB' in env).toBe(true);
      expect(Object.keys(env)).toContain('DB');
      expect(getRuntimeBinding('DB')).toBe('d1-binding');
    });
  });
});
