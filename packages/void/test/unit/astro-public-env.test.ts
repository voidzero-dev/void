import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createAstroPublicEnvPlugin, findImportMetaEnv } from '../../src/plugin-framework.ts';

const CODE = 'const values = import.meta.env;\n';
const tempDirs: Array<string> = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real `env-public.mjs` and a symlinked directory that points to it. */
function createEnvPublicFile() {
  const root = mkdtempSync(join(tmpdir(), 'void-astro-public-env-'));
  tempDirs.push(root);
  const real = join(root, 'real');
  mkdirSync(real);
  const file = join(real, 'env-public.mjs');
  writeFileSync(file, CODE);
  const linked = join(root, 'linked');
  // A junction needs no extra rights on Windows.
  symlinkSync(real, linked, 'junction');
  return { file, linkedFile: join(linked, 'env-public.mjs'), root };
}

function transform(
  file: string,
  input: {
    id: string;
    env?: Record<string, unknown>;
    define?: Record<string, unknown>;
    environment?: string;
  },
) {
  const plugin = createAstroPublicEnvPlugin(file);
  const configResolved = plugin.configResolved as (config: ResolvedConfig) => void;
  configResolved({ env: input.env ?? {} } as ResolvedConfig);
  const hook = plugin.transform as {
    handler: (this: unknown, code: string, id: string) => { code: string } | undefined;
  };
  const result = hook.handler.call(
    { environment: { name: input.environment ?? 'ssr', config: { define: input.define } } },
    CODE,
    input.id,
  );
  return result?.code;
}

describe('findImportMetaEnv', () => {
  it('finds each read of the whole object', () => {
    const code = 'a = import.meta.env; b = (import.meta.env).VITE_X; c = import.meta.env.VITE_Y;';
    expect(findImportMetaEnv(code)).toEqual([4, 26, 55]);
  });

  it('skips longer names and property paths', () => {
    for (const code of [
      'a.import.meta.env',
      '$import.meta.env',
      '_import.meta.env',
      'ximport.meta.env',
      'import.meta.envX',
      'import.meta.env$',
      'import.meta.env_',
      'import.meta.env2',
    ]) {
      expect(findImportMetaEnv(code), code).toEqual([]);
    }
  });
});

describe('void:astro-public-env', () => {
  it('replaces the read with VITE_ values, where a define wins and stays code', () => {
    const { file } = createEnvPublicFile();
    const code = transform(file, {
      id: file,
      env: { VITE_A: 'from env', VITE_B: 'kept', STRIPE_KEY: 'sk_secret', registry: 'sk_reg' },
      define: {
        'import.meta.env.VITE_A': '"defined"',
        'import.meta.env.VITE_NUMBER': 42,
        'import.meta.env.SECRET': '"no"',
        'process.env.VITE_OTHER': '"no"',
      },
    });
    expect(code).toBe(
      'const values = ({"VITE_A": "defined", "VITE_B": "kept", "VITE_NUMBER": 42});\n',
    );
  });

  it('matches the module through a symlinked path', () => {
    const { file, linkedFile } = createEnvPublicFile();
    expect(transform(file, { id: linkedFile, env: { VITE_A: 'a' } })).toBe(
      'const values = ({"VITE_A": "a"});\n',
    );
  });

  it('leaves the client build and other env-public.mjs files alone', () => {
    const { file, root } = createEnvPublicFile();
    expect(transform(file, { id: file, environment: 'client' })).toBeUndefined();
    const other = join(root, 'other', 'env-public.mjs');
    mkdirSync(join(root, 'other'));
    writeFileSync(other, CODE);
    expect(transform(file, { id: other })).toBeUndefined();
  });
});
