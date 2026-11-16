import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

// @cloudflare/vite-plugin resolves workerd with ["workerd","worker","module","browser"];
// export keys match in order, so the worker branches must stay before "browser".

type ExportEntry = string | { [condition: string]: ExportEntry };

function resolveConditional(entry: ExportEntry, conditions: ReadonlySet<string>): string | null {
  if (typeof entry === 'string') {
    return entry;
  }
  for (const key of Object.keys(entry)) {
    if (key === 'default' || conditions.has(key)) {
      const nested = resolveConditional(entry[key]!, conditions);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
  exports: Record<string, ExportEntry>;
};

const envExport = pkg.exports['./env'];
if (!envExport) {
  throw new Error('Expected `./env` entry in void/package.json exports');
}

describe('void/env export map', () => {
  it('resolves to the server variant under Cloudflare workerd conditions', () => {
    const resolved = resolveConditional(
      envExport,
      new Set(['workerd', 'worker', 'module', 'browser', 'import']),
    );
    expect(resolved).toBe('./dist/runtime/env/public.mjs');
  });

  it('resolves to the server variant under Node SSR conditions', () => {
    const resolved = resolveConditional(envExport, new Set(['node', 'module', 'import']));
    expect(resolved).toBe('./dist/runtime/env/public.mjs');
  });

  it('resolves to the client stub under browser conditions', () => {
    const resolved = resolveConditional(envExport, new Set(['browser', 'module', 'import']));
    expect(resolved).toBe('./dist/runtime/env/public-client.mjs');
  });
});
