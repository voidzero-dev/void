import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { generateBindingTypes, syncBindingTypes } from '../../src/codegen/binding-types.ts';
import { ensureProjectTsconfig } from '../../src/codegen/project-tsconfig.ts';

const roots: Array<string> = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('custom Cloudflare binding types', () => {
  it('generates nested, array and singleton bindings, with quoted names and stable ordering', () => {
    const dts = generateBindingTypes({
      cloudflare: {
        ratelimits: [{ name: 'RATE-LIMIT' }],
        services: [{ binding: 'AUTH' }],
        queues: {
          producers: [{ binding: 'JOBS', queue: 'jobs' }],
          consumers: [{ queue: 'ignored' }],
        },
        durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
        workflows: [{ binding: 'WORKFLOW' }],
        browser: { binding: 'BROWSER' },
        kv_namespaces: [{ binding: 'CACHE' }, { binding: 'KV' }],
        assets: { binding: 'FILES' },
        vars: { NOT_A_BINDING: 'value' },
      },
    });
    expect(dts).toContain('interface VoidGeneratedEnvBindings');
    for (const declaration of [
      '"AUTH": Fetcher;',
      '"BROWSER": BrowserRun;',
      '"CACHE": KVNamespace;',
      '"FILES": Fetcher;',
      '"JOBS": Queue;',
      '"RATE-LIMIT": RateLimit;',
      '"ROOM": DurableObjectNamespace;',
      '"WORKFLOW": Workflow;',
    ]) {
      expect(dts).toContain(declaration);
    }
    expect(dts).not.toContain('"KV":');
    expect(dts).not.toContain('NOT_A_BINDING');
    expect(dts).not.toContain('ignored');
    expect(dts!.indexOf('"AUTH"')).toBeLessThan(dts!.indexOf('"ROOM"'));
  });

  it.each(['node', 'bun', 'deno'] as const)('removes stale types for target %s', (target) => {
    const root = mkdtempSync(join(tmpdir(), 'void-binding-types-'));
    roots.push(root);
    syncBindingTypes(root, { cloudflare: { ai: { binding: 'CUSTOM_AI' } } });
    expect(existsSync(join(root, '.void/bindings.d.ts'))).toBe(true);
    syncBindingTypes(root, { target, cloudflare: { ai: { binding: 'CUSTOM_AI' } } });
    expect(existsSync(join(root, '.void/bindings.d.ts'))).toBe(false);
  });

  it('includes types in the project config and removes stale types when bindings disappear', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-binding-types-'));
    roots.push(root);
    syncBindingTypes(root, { cloudflare: { ai: { binding: 'CUSTOM_AI' } } });
    ensureProjectTsconfig(root);
    expect(JSON.parse(readFileSync(join(root, '.void/tsconfig.json'), 'utf8')).files).toContain(
      'bindings.d.ts',
    );
    syncBindingTypes(root, {});
    ensureProjectTsconfig(root);
    expect(existsSync(join(root, '.void/bindings.d.ts'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, '.void/tsconfig.json'), 'utf8')).files).not.toContain(
      'bindings.d.ts',
    );
  });
});
