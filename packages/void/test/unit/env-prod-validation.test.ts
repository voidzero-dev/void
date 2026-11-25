import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { formatEnvReport, validateProdEnv } from '../../src/cli/env-validation.ts';
import { number, string } from '../../src/runtime/env/helpers.ts';
import { defineEnv } from '../../src/runtime/env/public.ts';

// The fixture env.ts only has to exist: tests register the shared schema with defineEnv.

const roots: Array<string> = [];

function createTempProject(opts?: { withEnvTs?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'void-deploy-env-'));
  roots.push(root);
  if (opts?.withEnvTs !== false) {
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
  }
  return root;
}

function writeDotenv(root: string, name: string, contents: string): void {
  writeFileSync(join(root, name), contents);
}

beforeEach(() => {
  // defineEnv({}) resets the shared schema registry.
  defineEnv({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('validateProdEnv — deploy-time schema enforcement', () => {
  it('rejects schema-declared server keys in managed Worker vars even when a remote secret exists', async () => {
    const root = createTempProject();
    defineEnv({ ADMIN_TOKEN: string().optional() });

    await expect(
      validateProdEnv(root, {
        productionOnly: true,
        remoteSecrets: ['ADMIN_TOKEN'],
        workerVars: { ADMIN_TOKEN: 'must-not-be-uploaded' },
      }),
    ).rejects.toThrow('Server env keys cannot be Worker plaintext vars: ADMIN_TOKEN');
  });

  it('permits public Worker vars outside the server schema', async () => {
    const root = createTempProject();
    defineEnv({ ADMIN_TOKEN: string() });
    const { report } = await validateProdEnv(root, {
      productionOnly: true,
      remoteSecrets: ['ADMIN_TOKEN'],
      workerVars: { API_URL: 'https://api.example.test' },
    });
    expect(report.valid).toBe(true);
  });

  it('returns hasSchema=false when the project has no env.ts (skips validation)', async () => {
    const root = createTempProject({ withEnvTs: false });
    const result = await validateProdEnv(root, { productionOnly: true });
    expect(result.hasSchema).toBe(false);
    expect(result.report.valid).toBe(true);
  });

  it('reports missing required keys when no remote secrets supply them', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string(), DATABASE_URL: string() });

    const { hasSchema, report } = await validateProdEnv(root, { productionOnly: true });

    expect(hasSchema).toBe(true);
    expect(report.valid).toBe(false);
    expect(report.missing.sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
    const formatted = formatEnvReport(report);
    expect(formatted).toContain('STRIPE_KEY');
    expect(formatted).toContain('DATABASE_URL');
    expect(formatted).toContain('Missing required env vars');
  });

  it('treats remote secrets as "present" so a prod secret satisfies a required key', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string(), PORT: number() });

    const { report } = await validateProdEnv(root, {
      productionOnly: true,
      remoteSecrets: ['STRIPE_KEY', 'PORT'],
    });

    expect(report.valid).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.invalid).toEqual([]);
  });

  it('never reads .env during production validation', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string(), PORT: number() });
    writeDotenv(root, '.env', 'STRIPE_KEY=base\nPORT=3000\n');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(false);
    expect(report.missing.sort()).toEqual(['PORT', 'STRIPE_KEY']);
  });

  it('reads only .env in local mode', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });
    writeDotenv(root, '.env', 'STRIPE_KEY=sk_dev\n');

    const { report } = await validateProdEnv(root, { productionOnly: false });

    expect(report.valid).toBe(true);
  });

  it('ignores server values from the production shell', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });
    vi.stubEnv('STRIPE_KEY', 'sk_live');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(false);
    expect(report.missing).toEqual(['STRIPE_KEY']);
  });

  it('validates client-prefixed values from the production shell', async () => {
    const root = createTempProject();
    defineEnv({ VITE_PORT: number() });
    vi.stubEnv('VITE_PORT', 'not-a-number');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(false);
    expect(report.missing).toEqual([]);
    expect(report.invalid.map((i) => i.key)).toEqual(['VITE_PORT']);
    const formatted = formatEnvReport(report);
    expect(formatted).toContain('Invalid env vars');
    expect(formatted).toContain('VITE_PORT');
  });

  it('rejects reserved __VOID_ names in .env for a local check, with or without env.ts', async () => {
    for (const withEnvTs of [true, false]) {
      const root = createTempProject({ withEnvTs });
      writeDotenv(
        root,
        '.env',
        'API_URL=http://localhost\n__VOID_PROXY_TOKEN=x\n__VOID_EMAIL_FROM=y\n',
      );

      const error = await validateProdEnv(root, { productionOnly: false }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        '.env defines names reserved for Void: __VOID_PROXY_TOKEN, __VOID_EMAIL_FROM.',
      );
      expect((error as Error).message).toContain('Void sets these itself');
      expect((error as Error).message).toContain('x-void-dev-trigger header printed at dev start');
    }
  });

  it('rejects reserved names written as export K=v or K: v in .env', async () => {
    const root = createTempProject({ withEnvTs: false });
    writeDotenv(
      root,
      '.env',
      'API_URL=http://localhost\nexport __VOID_PROXY_TOKEN=x\n__VOID_EMAIL_FROM: a@b.c\n',
    );

    await expect(validateProdEnv(root, { productionOnly: false })).rejects.toThrow(
      '.env defines names reserved for Void: __VOID_PROXY_TOKEN, __VOID_EMAIL_FROM.',
    );
  });

  it('ignores __VOID_ in a .env comment or value', async () => {
    const root = createTempProject({ withEnvTs: false });
    writeDotenv(root, '.env', '# __VOID_X=1\nAPI_URL=http://localhost/__VOID_X\n');

    await expect(validateProdEnv(root, { productionOnly: false })).resolves.toMatchObject({
      hasSchema: false,
    });
  });

  it('does not read .env names during production validation', async () => {
    const root = createTempProject({ withEnvTs: false });
    writeDotenv(root, '.env', '__VOID_PROXY_TOKEN=x\n');

    await expect(validateProdEnv(root, { productionOnly: true })).resolves.toMatchObject({
      hasSchema: false,
    });
  });

  it('ignores a reserved name set only in the shell', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });
    writeDotenv(root, '.env', 'STRIPE_KEY=sk_dev\n');
    vi.stubEnv('__VOID_PROXY_TOKEN', 'shell');

    const { report } = await validateProdEnv(root, { productionOnly: false });
    expect(report.valid).toBe(true);
  });

  it.each([false, true])(
    'rejects reserved __VOID_ names declared in env.ts (productionOnly: %s)',
    async (productionOnly) => {
      const root = createTempProject();
      defineEnv({ STRIPE_KEY: string(), __VOID_TOKEN: string().optional() });

      await expect(validateProdEnv(root, { productionOnly })).rejects.toThrow(
        'env.ts declares names reserved for Void: __VOID_TOKEN.',
      );
    },
  );
});
