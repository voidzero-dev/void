import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { writeProvisionedWranglerConfig } from '../../src/cli/wrangler.ts';
import {
  materializeCloudflareConfig,
  persistCloudflareConfig,
  restoreCloudflarePreviewPointer,
  seedCloudflareConfig,
  stashCloudflareDeployPointer,
} from '../../src/cloudflare-config.ts';

const root = packageFixturePath(import.meta.dirname, '.tmp-cloudflare-config-test');

function config(source: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'void.config.ts'), source);
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('materializeCloudflareConfig', () => {
  it('stashes a build deploy pointer for preview and restores it only when needed', () => {
    config('export default {};\n');
    const directory = join(root, '.wrangler', 'deploy');
    mkdirSync(directory, { recursive: true });
    const pointer = join(directory, 'config.json');
    const original = '{"configPath":"../../dist/ssr/wrangler.json"}';
    writeFileSync(pointer, original);
    stashCloudflareDeployPointer(root);
    expect(existsSync(pointer)).toBe(false);
    expect(restoreCloudflarePreviewPointer(root)).toBe(true);
    expect(readFileSync(pointer, 'utf8')).toBe(original);
  });

  it('passes through custom Cloudflare settings and keeps the generated file outside Wrangler discovery', () => {
    config(
      'export default { cloudflare: { name: "app", vars: { FOO: "bar" }, limits: { cpu_ms: 50 } } };\n',
    );
    const path = materializeCloudflareConfig(root);
    expect(path).toBe(toSlash(join(root, '.void-wrangler.jsonc')));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      name: 'app',
      vars: { FOO: 'bar' },
      limits: { cpu_ms: 50 },
    });
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
    expect(existsSync(join(root, 'void.lock.json'))).toBe(false);
  });

  it('retains provisioned fields while explicit authored changes win', () => {
    config('export default { cloudflare: { name: "app", vars: { FOO: "old" } } };\n');
    const path = materializeCloudflareConfig(root);
    writeFileSync(
      path,
      JSON.stringify({ name: 'app', account_id: '123', vars: { FOO: 'old', GENERATED: 'yes' } }),
    );
    persistCloudflareConfig(root);
    writeFileSync(
      join(root, 'void.config.ts'),
      'export default { cloudflare: { name: "new", vars: { FOO: "new" } } };\n',
    );
    expect(JSON.parse(readFileSync(materializeCloudflareConfig(root), 'utf8'))).toEqual({
      name: 'new',
      account_id: '123',
      vars: { FOO: 'new', GENERATED: 'yes' },
    });
  });

  it('retains provisioned bindings when authored binding arrays change', () => {
    config(
      'export default { cloudflare: { d1_databases: [{ binding: "CUSTOM", database_id: "old" }] } };\n',
    );
    const path = materializeCloudflareConfig(root);
    writeFileSync(
      path,
      JSON.stringify({
        d1_databases: [
          { binding: 'CUSTOM', database_id: 'old' },
          { binding: 'DB', database_id: 'provisioned-id' },
        ],
      }),
    );
    persistCloudflareConfig(root);
    writeFileSync(
      join(root, 'void.config.ts'),
      'export default { cloudflare: { d1_databases: [{ binding: "CUSTOM", database_id: "new" }] } };\n',
    );
    expect(
      JSON.parse(readFileSync(materializeCloudflareConfig(root), 'utf8')).d1_databases,
    ).toEqual([
      { binding: 'CUSTOM', database_id: 'new' },
      { binding: 'DB', database_id: 'provisioned-id' },
    ]);
  });

  it('restores exact JSONC provenance from a migration seed', () => {
    config('export default { cloudflare: { name: "app" } };\n');
    const raw =
      '// void:published-traffic:v1:eyJ3b3JrZXJzX2RldiI6ZmFsc2UsInByZXZpZXdfdXJscyI6ZmFsc2UsInJvdXRlcyI6W119\n{ "name": "app" }\n';
    seedCloudflareConfig(root, { name: 'app' }, raw);
    expect(readFileSync(materializeCloudflareConfig(root), 'utf8')).toBe(raw);
  });

  it('rejects a root Wrangler file alongside typed config', () => {
    config('export default {};\n');
    writeFileSync(join(root, 'wrangler.jsonc'), '{}');
    expect(() => materializeCloudflareConfig(root)).toThrow('Run `void migrate`');
  });

  it('records provisioned settings and reconstructs them from the checked-in files', () => {
    config('export default { cloudflare: { name: "app", vars: { CUSTOM: "yes" } } };\n');
    const path = materializeCloudflareConfig(root);
    writeProvisionedWranglerConfig(root, {
      accountId: 'account-1',
      compatibilityDate: '2026-02-24',
    });
    expect(existsSync(join(root, 'void.lock.json'))).toBe(true);
    rmSync(path);
    expect(JSON.parse(readFileSync(materializeCloudflareConfig(root), 'utf8'))).toEqual({
      name: 'app',
      vars: { CUSTOM: 'yes' },
      account_id: 'account-1',
      compatibility_date: '2026-02-24',
    });
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
  });

  it('accepts an edit to resolved lock settings and refreshes generated text', () => {
    config('export default { cloudflare: { name: "app" } };\n');
    const path = materializeCloudflareConfig(root);
    writeFileSync(path, JSON.stringify({ name: 'app', addresses: ['old@example.com'] }));
    persistCloudflareConfig(root);
    const lockPath = join(root, 'void.lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    delete lock.resolved.addresses;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    expect(JSON.parse(readFileSync(materializeCloudflareConfig(root), 'utf8'))).toEqual({
      name: 'app',
    });
    expect(JSON.parse(JSON.parse(readFileSync(lockPath, 'utf8')).text)).toEqual({ name: 'app' });
  });

  it('leaves an equivalently formatted checked-in lock unchanged', () => {
    config('export default { cloudflare: { compatibility_flags: ["nodejs_als"] } };\n');
    const path = materializeCloudflareConfig(root);
    writeFileSync(path, JSON.stringify({ compatibility_flags: ['nodejs_als'], account_id: '123' }));
    persistCloudflareConfig(root);
    const lockPath = join(root, 'void.lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const formatted = `${JSON.stringify(lock)}\n`;
    writeFileSync(lockPath, formatted);
    materializeCloudflareConfig(root);
    expect(readFileSync(lockPath, 'utf8')).toBe(formatted);
  });
});
