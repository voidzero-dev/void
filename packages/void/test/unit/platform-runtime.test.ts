import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPlatformRuntimeDirectory,
  parsePlatformRuntimeManifest,
  readPlatformRuntimeManifest,
  resolvePlatformRuntime,
} from '@void/platform/installer';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { describe, expect, it } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import { loadPlatformRuntime } from '../../src/cli/platform-installer.ts';

describe('platform runtime manifest', () => {
  it('declares durable deployment execution without rejecting legacy runtime manifests', () => {
    const current = readPlatformRuntimeManifest();
    const { deploymentExecution: _deploymentExecution, ...legacy } = current;
    expect(parsePlatformRuntimeManifest(legacy).deploymentExecution).toBeUndefined();
    expect(
      parsePlatformRuntimeManifest({ ...legacy, deploymentExecution: 1 }).deploymentExecution,
    ).toBe(1);
    expect(() => parsePlatformRuntimeManifest({ ...legacy, deploymentExecution: 2 })).toThrow(
      'deployment execution protocol',
    );
  });

  it('packages migration inputs without Drizzle authoring snapshots', () => {
    const runtimeDirectory = getPlatformRuntimeDirectory();
    const manifest = readPlatformRuntimeManifest();
    const migrationsDirectory = join(runtimeDirectory, 'drizzle');

    expect(readdirSync(migrationsDirectory).sort()).toEqual(
      [
        'compatibility.json',
        'meta',
        ...manifest.database.migrations.map((migration) => `${migration.tag}.sql`),
      ].sort(),
    );
    expect(readdirSync(join(migrationsDirectory, 'meta'))).toEqual(['_journal.json']);
    const compatibility = JSON.parse(
      readFileSync(join(migrationsDirectory, 'compatibility.json'), 'utf8'),
    );
    expect(compatibility.lineage).toBe(manifest.database.lineage);
    expect(compatibility.rollbackSafeFrom).toEqual(manifest.database.rollbackSafeFrom);
  });

  it('omits build-only source maps and their references from packaged Workers', () => {
    const runtimeDirectory = getPlatformRuntimeDirectory();
    const manifest = readPlatformRuntimeManifest();

    expect(
      readdirSync(runtimeDirectory, { recursive: true, encoding: 'utf8' }).filter((path) =>
        path.endsWith('.map'),
      ),
    ).toEqual([]);
    for (const artifact of Object.values(manifest.artifacts)) {
      const contents = readFileSync(join(runtimeDirectory, artifact.path), 'utf8');
      expect(contents.match(/^\/\/# sourceMappingURL=.*$/gm) ?? []).toEqual([]);
    }
  });

  it('rejects malformed and internally inconsistent manifests', () => {
    const manifest = readPlatformRuntimeManifest();

    expect(() => parsePlatformRuntimeManifest({ ...manifest, schemaVersion: 1 })).toThrow(
      'schemaVersion must be 2',
    );
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        database: { ...manifest.database, schemaDigest: '0'.repeat(64) },
      }),
    ).toThrow('schema digest does not match');
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          api: { ...manifest.artifacts.api, path: '../api.js' },
        },
      }),
    ).toThrow('must stay inside the package');
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        assets: {
          adminClient: { ...manifest.assets?.adminClient, path: 'other/client.js' },
        },
      }),
    ).toThrow('admin client asset path must be');
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        assets: {
          ...manifest.assets,
          adminStyle: { ...manifest.assets?.adminStyle, path: 'other/style.css' },
        },
      }),
    ).toThrow('admin style asset path must be');
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        database: {
          ...manifest.database,
          rollbackSafeFrom: [
            manifest.database.rollbackSafeFrom[0],
            manifest.database.rollbackSafeFrom[0],
          ],
        },
      }),
    ).toThrow('compatibility entries must be unique');
    expect(() =>
      parsePlatformRuntimeManifest({ ...manifest, sourceRevision: 'revision with spaces' }),
    ).toThrow('sourceRevision is invalid');
    expect(() => parsePlatformRuntimeManifest({ ...manifest, usageProtocolVersion: 3 })).toThrow(
      'usageProtocolVersion must be 0, 1, or 2',
    );
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        safetyProtocols: { sandboxDrain: 4 },
      }),
    ).toThrow('safetyProtocols.sandboxDrain must be 0, 1, 2, or 3');
    const { usageProtocolVersion: _usageProtocolVersion, ...legacy } = manifest;
    expect(parsePlatformRuntimeManifest(legacy).usageProtocolVersion).toBe(0);
    const { assets: _assets, ...legacyAssets } = manifest;
    expect(parsePlatformRuntimeManifest(legacyAssets).assets).toBeUndefined();
    const { safetyProtocols: _safetyProtocols, ...legacySafety } = manifest;
    expect(parsePlatformRuntimeManifest(legacySafety).safetyProtocols).toEqual({ sandboxDrain: 0 });
    const { emailGateway: _gateway, ...fourArtifacts } = manifest.artifacts;
    const { emailProtocolVersion: _emailProtocolVersion, ...preEmailRuntime } = manifest;
    expect(() => parsePlatformRuntimeManifest(preEmailRuntime)).toThrow(
      'An emailGateway runtime artifact requires email protocol version 1',
    );
    expect(
      parsePlatformRuntimeManifest({
        ...preEmailRuntime,
        artifacts: fourArtifacts,
      }).artifacts.emailGateway,
    ).toBeUndefined();
    expect(() => parsePlatformRuntimeManifest({ ...manifest, artifacts: fourArtifacts })).toThrow(
      'Email protocol version 1 requires an emailGateway runtime artifact',
    );
  });

  it('resolves packaged and explicit runtime directories with provenance', () => {
    const packaged = resolvePlatformRuntime();
    const custom = resolvePlatformRuntime(getPlatformRuntimeDirectory());

    expect(packaged.source).toBe('package');
    expect(custom.source).toBe('custom');
    expect(custom.directory).toBe(packaged.directory);
    expect(custom.manifest).toEqual(packaged.manifest);
    expect(custom.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(custom.manifestSha256).toBe(packaged.manifestSha256);
    expect(() => resolvePlatformRuntime('does-not-exist')).toThrow(
      'runtime directory is unavailable',
    );
  });

  it('starts the packaged API Worker in the bundled local runtime', async () => {
    const runtimeDirectory = getPlatformRuntimeDirectory();
    const runtime = readPlatformRuntimeManifest();
    const miniflareOptions = convertV4MiniflareOptions({
      bindings: { PLATFORM_TRAFFIC_STATE: 'staging' },
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat'],
      modules: true,
      scriptPath: join(runtimeDirectory, runtime.artifacts.api.path),
      assets: { directory: join(runtimeDirectory, 'api', 'assets') },
    });
    const workers = miniflareOptions.workers as Array<{ config: Record<string, unknown> }>;
    // The legacy-options converter omits this flag, though Wrangler sets it
    // when a Worker entrypoint and assets directory are deployed together.
    workers[0].config.assets = {
      directory: join(runtimeDirectory, 'api', 'assets'),
      hasUserWorker: true,
    };
    const miniflare = new Miniflare(miniflareOptions);

    try {
      await miniflare.ready;
      expect((await miniflare.dispatchFetch('http://localhost/health')).status).toBe(503);
      const client = await miniflare.dispatchFetch('http://localhost/admin/client.js');
      expect(client.status).toBe(200);
      expect(client.headers.get('Content-Type')).toContain('text/javascript');
      expect(digest(Buffer.from(await client.text()))).toBe(runtime.assets?.adminClient.sha256);
      const style = await miniflare.dispatchFetch('http://localhost/admin/style.css');
      expect(style.status).toBe(200);
      expect(style.headers.get('Content-Type')).toContain('text/css');
      expect(digest(Buffer.from(await style.text()))).toBe(runtime.assets?.adminStyle?.sha256);
    } finally {
      await miniflare.dispose();
    }
  });

  it.each(['dispatch', 'emailGateway', 'proxy', 'tail'] as const)(
    'starts the packaged %s Worker in the bundled local runtime',
    async (name) => {
      const runtimeDirectory = getPlatformRuntimeDirectory();
      const runtime = readPlatformRuntimeManifest();
      const miniflare = new Miniflare(
        convertV4MiniflareOptions({
          bindings: {
            PLATFORM_HEALTH_PROBE_TOKEN: 'probe',
            PLATFORM_TRAFFIC_STATE: 'staging',
          },
          compatibilityDate: '2026-02-24',
          compatibilityFlags: name === 'proxy' || name === 'emailGateway' ? ['nodejs_compat'] : [],
          modules: true,
          scriptPath: join(runtimeDirectory, runtime.artifacts[name]!.path),
        }),
      );

      try {
        await miniflare.ready;
        if (name !== 'tail') {
          const response = await miniflare.dispatchFetch('http://localhost/health', {
            headers: { 'X-Void-Platform-Probe': 'probe' },
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ ok: true });
        }
      } finally {
        await miniflare.dispose();
      }
    },
  );

  it('rejects a custom runtime whose artifacts changed after its manifest was built', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'void-custom-runtime-test-'));
    const runtimeDirectory = join(temporary, 'runtime');
    try {
      cpSync(getPlatformRuntimeDirectory(), runtimeDirectory, { recursive: true });
      const runtime = loadPlatformRuntime(runtimeDirectory);
      const apiPath = join(runtimeDirectory, runtime.manifest.artifacts.api.path);
      writeFileSync(apiPath, `${readFileSync(apiPath, 'utf8')}\n// changed\n`);

      expect(() => loadPlatformRuntime(runtimeDirectory)).toThrow('integrity verification');
      cpSync(getPlatformRuntimeDirectory(), runtimeDirectory, { recursive: true });
      const assetPath = join(runtimeDirectory, runtime.manifest.assets!.adminClient.path);
      writeFileSync(assetPath, `${readFileSync(assetPath, 'utf8')}\n// changed\n`);
      expect(() => loadPlatformRuntime(runtimeDirectory)).toThrow('integrity verification');
      cpSync(getPlatformRuntimeDirectory(), runtimeDirectory, { recursive: true });
      const stylePath = join(runtimeDirectory, runtime.manifest.assets!.adminStyle!.path);
      writeFileSync(stylePath, `${readFileSync(stylePath, 'utf8')}\n/* changed */\n`);
      expect(() => loadPlatformRuntime(runtimeDirectory)).toThrow('integrity verification');
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });
});

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
