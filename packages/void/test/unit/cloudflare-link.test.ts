import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  maybeLinkCloudflareDeploy,
  prepareExistingCloudflareDeploy,
  readCloudflareLink,
  completeCloudflareLink,
  recordCloudflareCandidate,
} from '../../src/cli/cloudflare-link.ts';
import { readDeploymentPlatform } from '../../src/cli/project.ts';
import { materializeCloudflareConfig } from '../../src/cloudflare-config.ts';
import { DEPLOY_CONFIG_MARKER } from '../../src/config-write.ts';

let root: string;
const config =
  '// Existing site\n{"name":"site","account_id":"personal","compatibility_date":"2026-02-24"}';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-cf-link-'));
  vi.stubEnv('VOID_PROJECT', '');
  writeFileSync(join(root, 'wrangler.jsonc'), config);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('Cloudflare deployment onboarding', () => {
  it('offers reuse once without changing files before the target is verified', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    expect(await maybeLinkCloudflareDeploy(root, {}, { interactive: true, confirm })).toBe(
      'existing',
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readDeploymentPlatform(root)).toBeNull();
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(config);
  });

  it('offers to link a Worker with a deploy-generated config and a saved lock', async () => {
    rmSync(join(root, 'wrangler.jsonc'));
    writeFileSync(
      join(root, 'void.config.ts'),
      `${DEPLOY_CONFIG_MARKER}\nexport default { cloudflare: { name: 'site' } };\n`,
    );
    const source = { name: 'site' };
    const resolved = { ...source, account_id: 'personal' };
    writeFileSync(
      join(root, 'void.lock.json'),
      JSON.stringify({ version: 1, source, resolved, text: JSON.stringify(resolved) }),
    );
    const confirm = vi.fn().mockResolvedValue(true);

    expect(await maybeLinkCloudflareDeploy(root, {}, { interactive: true, confirm })).toBe(
      'existing',
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(readDeploymentPlatform(root)).toBeNull();
  });
  it('offers to link a Worker whose config starts with a UTF-8 BOM', async () => {
    const bomConfig = `\uFEFF${config}`;
    writeFileSync(join(root, 'wrangler.jsonc'), bomConfig);
    expect(
      await maybeLinkCloudflareDeploy(
        root,
        {},
        { interactive: true, confirm: vi.fn().mockResolvedValue(true) },
      ),
    ).toBe('existing');
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(bomConfig);
  });
  it('offers to link a Worker configured through a custom Astro JSONC path', async () => {
    rmSync(join(root, 'wrangler.jsonc'));
    writeFileSync(join(root, 'wrangler.build.jsonc'), config);
    writeFileSync(
      join(root, 'astro.config.mjs'),
      'import cloudflare from "@astrojs/cloudflare"; export default { adapter: cloudflare({ configPath: "./wrangler.build.jsonc" }) };\n',
    );
    expect(
      await maybeLinkCloudflareDeploy(
        root,
        {},
        {
          interactive: true,
          confirm: vi.fn().mockResolvedValue(true),
        },
      ),
    ).toBe('existing');
  });
  it.each([false, Symbol('cancel')])(
    'leaves declined/cancelled projects unchanged (%s)',
    async (answer) => {
      expect(
        await maybeLinkCloudflareDeploy(
          root,
          {},
          { interactive: true, confirm: vi.fn().mockResolvedValue(answer) },
        ),
      ).toBe('cancelled');
      expect(existsSync(join(root, '.void'))).toBe(false);
      expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(config);
    },
  );
  it.each([
    { platform: 'void' as const },
    { platform: 'cloudflare' as const },
    { projectSlug: 'chosen' },
  ])('honors an explicit destination %j', async (options) => {
    const confirm = vi.fn();
    expect(
      await maybeLinkCloudflareDeploy(root, options, { interactive: true, confirm }),
    ).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });
  it.each([
    { platform: 'void' },
    { platform: 'cloudflare' },
    { platform: 'none' },
    { projectId: 'project', slug: 'linked' },
  ])('honors saved destination %j', async (state) => {
    mkdirSync(join(root, '.void'));
    writeFileSync(join(root, '.void/project.json'), JSON.stringify(state));
    expect(
      await maybeLinkCloudflareDeploy(root, {}, { interactive: true, confirm: vi.fn() }),
    ).toBeNull();
  });
  it('does not infer the destination from SDK usage or unrelated metadata', async () => {
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"void":"*"}}');
    mkdirSync(join(root, '.void'));
    writeFileSync(join(root, '.void/project.json'), '{"voidInternalStaging":false}');
    expect(
      await maybeLinkCloudflareDeploy(
        root,
        {},
        { interactive: true, confirm: vi.fn().mockResolvedValue(true) },
      ),
    ).toBe('existing');
  });
  it('requires explicit selection in CI', async () => {
    await expect(maybeLinkCloudflareDeploy(root, {}, { interactive: false })).rejects.toThrow(
      '--platform cloudflare',
    );
    expect(existsSync(join(root, '.void'))).toBe(false);
  });
  it('does not shadow TOML or malformed config', async () => {
    rmSync(join(root, 'wrangler.jsonc'));
    writeFileSync(join(root, 'wrangler.toml'), 'name="site"');
    await expect(maybeLinkCloudflareDeploy(root)).rejects.toThrow('wrangler.toml');
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
    rmSync(join(root, 'wrangler.toml'));
    writeFileSync(join(root, 'wrangler.jsonc'), '{invalid');
    await expect(maybeLinkCloudflareDeploy(root)).rejects.toThrow('valid wrangler.jsonc');
  });
});

describe('verified existing Worker link', () => {
  const worker = {
    versionId: 'original',
    bindings: [{ name: 'TOKEN', type: 'secret_text' }],
    runtime: { compatibility_date: '2026-02-24', compatibility_flags: [] },
    script: { handlers: ['fetch', 'scheduled'] },
  };
  function options() {
    return {
      root,
      configPath: join(root, 'wrangler.jsonc'),
      accountId: 'personal',
      reuse: true,
      runWrangler: vi.fn(),
      readExistingWorker: vi.fn().mockResolvedValue(worker),
    };
  }
  it('saves verified selection and preserves retry guards until deployment succeeds', async () => {
    const deps = options();
    await prepareExistingCloudflareDeploy(deps);
    expect(readDeploymentPlatform(root)).toBe('cloudflare');
    expect(readCloudflareLink(root)).toEqual({ accountId: 'personal', workerName: 'site' });
    const written = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    expect(written).toContain('// Existing site');
    expect(written).toContain('"keep_vars": true');
    expect(written).not.toContain('TOKEN');
    await prepareExistingCloudflareDeploy({ ...deps, reuse: false });
    expect(deps.readExistingWorker).toHaveBeenCalledTimes(2);
    completeCloudflareLink(root);
    expect(readCloudflareLink(root)).toBeNull();
    expect(readDeploymentPlatform(root)).toBe('cloudflare');
  });
  it('does not save or modify config on failed verification', async () => {
    const deps = options();
    deps.readExistingWorker.mockRejectedValue(new Error('forbidden'));
    await expect(prepareExistingCloudflareDeploy(deps)).rejects.toThrow('forbidden');
    expect(readDeploymentPlatform(root)).toBeNull();
    expect(readCloudflareLink(root)).toBeNull();
    expect(readFileSync(deps.configPath, 'utf8')).toBe(config);
  });
  it.each([
    ['legacy', '__VOID_VERSION_METADATA'],
    ['legacy', 'APP_VERSION'],
    ['typed', '__VOID_VERSION_METADATA'],
    ['typed', 'APP_VERSION'],
  ])('preserves omitted existing metadata %s config / %s binding', async (kind, binding) => {
    const deps = options();
    deps.readExistingWorker.mockResolvedValue({
      ...worker,
      bindings: [...worker.bindings, { name: binding, type: 'version_metadata' }],
    });
    const authored = 'export default { cloudflare: { name: "site", account_id: "personal" } };\n';
    if (kind === 'typed') {
      rmSync(deps.configPath);
      writeFileSync(join(root, 'void.config.ts'), authored);
      deps.configPath = materializeCloudflareConfig(root);
    }

    await prepareExistingCloudflareDeploy(deps);

    expect(readFileSync(deps.configPath, 'utf8')).toContain(`"binding": "${binding}"`);
    expect(readDeploymentPlatform(root)).toBe('cloudflare');
    expect(readCloudflareLink(root)).toEqual({ accountId: 'personal', workerName: 'site' });
    if (kind === 'typed') {
      expect(readFileSync(join(root, 'void.config.ts'), 'utf8')).toBe(authored);
      expect(existsSync(join(root, 'void.lock.json'))).toBe(true);
      expect(JSON.parse(readFileSync(materializeCloudflareConfig(root), 'utf8'))).toMatchObject({
        version_metadata: { binding },
      });
    } else {
      expect(readFileSync(deps.configPath, 'utf8')).toContain('// Existing site');
    }
    await prepareExistingCloudflareDeploy({ ...deps, reuse: false });
  });
  it.each([
    { remote: ['APP_VERSION'], authored: 'OTHER_VERSION' },
    { remote: [], authored: 'APP_VERSION' },
    { remote: ['APP_VERSION', 'OTHER_VERSION'], authored: undefined },
  ])('rejects unsafe metadata handoffs %j without writing state', async ({ remote, authored }) => {
    const deps = options();
    deps.readExistingWorker.mockResolvedValue({
      ...worker,
      bindings: [...worker.bindings, ...remote.map((name) => ({ name, type: 'version_metadata' }))],
    });
    if (authored !== undefined) {
      writeFileSync(
        deps.configPath,
        JSON.stringify({ name: 'site', version_metadata: { binding: authored } }),
      );
    }
    const original = readFileSync(deps.configPath, 'utf8');

    await expect(prepareExistingCloudflareDeploy(deps)).rejects.toThrow('version_metadata');

    expect(readFileSync(deps.configPath, 'utf8')).toBe(original);
    expect(readCloudflareLink(root)).toBeNull();
    expect(readDeploymentPlatform(root)).toBeNull();
  });
  it('refuses a changed identity on retry before remote calls', async () => {
    const deps = options();
    await prepareExistingCloudflareDeploy(deps);
    deps.readExistingWorker.mockClear();
    await expect(
      prepareExistingCloudflareDeploy({ ...deps, accountId: 'other', reuse: false }),
    ).rejects.toThrow('differs');
    expect(deps.readExistingWorker).not.toHaveBeenCalled();
  });
  it('persists verified candidate receipts across handoff preparation retries', async () => {
    const deps = options();
    await prepareExistingCloudflareDeploy(deps);
    const initialLink = readCloudflareLink(root)!;
    recordCloudflareCandidate(root, initialLink, 'original', 'candidate-1');
    await prepareExistingCloudflareDeploy({ ...deps, reuse: false });
    const retryLink = readCloudflareLink(root)!;
    recordCloudflareCandidate(root, retryLink, 'original', 'candidate-2');
    expect(readCloudflareLink(root)).toEqual({
      accountId: 'personal',
      workerName: 'site',
      candidateReceipt: {
        parentVersionId: 'original',
        versionIds: ['candidate-1', 'candidate-2'],
      },
    });
  });
  it('starts a new handoff receipt when the inspected live version has changed', async () => {
    const deps = options();
    await prepareExistingCloudflareDeploy(deps);
    recordCloudflareCandidate(root, readCloudflareLink(root)!, 'original', 'candidate-1');
    deps.readExistingWorker.mockResolvedValue({ ...worker, versionId: 'new-live' });

    await prepareExistingCloudflareDeploy({ ...deps, reuse: false });
    const retryLink = readCloudflareLink(root)!;
    expect(retryLink.candidateReceipt).toBeUndefined();
    recordCloudflareCandidate(root, retryLink, 'new-live', 'candidate-2');
    expect(readCloudflareLink(root)?.candidateReceipt).toEqual({
      parentVersionId: 'new-live',
      versionIds: ['candidate-2'],
    });
  });
  it('rejects candidate receipts for a different target or active parent', async () => {
    const deps = options();
    await prepareExistingCloudflareDeploy(deps);
    const link = readCloudflareLink(root)!;
    expect(() =>
      recordCloudflareCandidate(root, { ...link, accountId: 'other' }, 'original', 'candidate'),
    ).toThrow('changed');
    recordCloudflareCandidate(root, link, 'original', 'candidate');
    expect(() =>
      recordCloudflareCandidate(root, readCloudflareLink(root)!, 'different', 'candidate-2'),
    ).toThrow('changed');
  });
});
