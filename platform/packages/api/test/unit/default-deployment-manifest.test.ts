import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApplicationRoutes, parsePlatformDeploymentManifest } from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';

const manifestPath = resolve(import.meta.dirname, '../../../../deployments/void-cloud.json');

describe('Void Cloud deployment manifest', () => {
  it('captures the public production topology without deployment credentials or resource ids', () => {
    const raw = readFileSync(manifestPath, 'utf8');
    const manifest = parsePlatformDeploymentManifest(JSON.parse(raw));
    expect(manifest.resources.apiWorker).toBe('void-api');
    expect(manifest.resources.dispatchNamespace).toBe('void-users');
    expect(manifest.resources.tailWorker).toBe('void-tail');
    expect(createApplicationRoutes(manifest.application)).toEqual([
      { pattern: '*.void.app/*', zoneName: 'void.app' },
      { pattern: '*.void.app', zoneName: 'void.app' },
      { pattern: '*/*', zoneName: 'void.app' },
      { pattern: '*', zoneName: 'void.app' },
    ]);
    expect(raw).not.toMatch(/account.?id|zone.?id|api.?token|client.?secret|access.?key/i);
    expect(raw).not.toMatch(/[a-f0-9]{32}/i);
  });
});
