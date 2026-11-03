import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployArtifactDigest } from '@void/deploy-core';
import { beforeEach, afterEach, it, expect, vi } from 'vite-plus/test';
import { prepareDeployArtifact } from '../../src/deploy.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-prepared-artifact-'));
  mkdirSync(join(root, 'dist/server'), { recursive: true });
  mkdirSync(join(root, 'dist/client'), { recursive: true });
  writeFileSync(
    join(root, 'dist/server/index.js'),
    "export default { fetch() { return new Response('hello') } }",
  );
  writeFileSync(
    join(root, 'dist/server/wrangler.json'),
    JSON.stringify({
      main: 'index.js',
      compatibility_date: '2026-10-08',
      compatibility_flags: ['nodejs_compat'],
    }),
  );
  writeFileSync(join(root, 'dist/client/index.html'), '<h1>Hello</h1>');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Packaging must not contact a provider');
    }),
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
it('packages real Worker and asset bytes without credentials or provider calls', async () => {
  const result = await prepareDeployArtifact(root);
  expect(Buffer.from(result.artifact.workerFiles!['index.js']!, 'base64').toString()).toContain(
    "new Response('hello')",
  );
  expect(Buffer.from(result.assets['/index.html']!, 'base64').toString()).toBe('<h1>Hello</h1>');
  expect(result.artifact.manifest.assetManifestVersion).toBe(2);
  expect(result.artifact.manifest.bindings).toEqual({});
  expect(result.artifact.manifest).not.toHaveProperty('vars');
  expect(result.artifact.assetManifest['/index.html']).toMatchObject({
    blake3: expect.stringMatching(/^[a-f0-9]{32}$/),
    md5: expect.stringMatching(/^[a-f0-9]{32}$/),
    size: 14,
  });
  expect(fetch).not.toHaveBeenCalled();
  const digest = await deployArtifactDigest(result.artifact);
  expect(
    await deployArtifactDigest({
      ...result.artifact,
      workerFiles: { 'index.js': btoa('other executable') },
    }),
  ).not.toBe(digest);
  expect(
    await deployArtifactDigest({
      ...result.artifact,
      manifest: { ...result.artifact.manifest, bindings: { kv: ['KV'] } },
    }),
  ).not.toBe(digest);
});
it('includes configured Worker vars without copying dotenv or generated vars', async () => {
  writeFileSync(
    join(root, 'void.config.ts'),
    "export default { worker: { vars: { API_URL: 'https://api.example.test', EMPTY_SETTING: '' } } };",
  );
  writeFileSync(join(root, '.env'), 'API_URL=https://local.example.test\nLOCAL_ONLY=local-value\n');
  writeFileSync(
    join(root, 'dist/server/wrangler.json'),
    JSON.stringify({
      main: 'index.js',
      compatibility_date: '2026-10-08',
      compatibility_flags: ['nodejs_compat'],
      vars: { API_URL: 'https://built.example.test', BUILD_ONLY: 'generated-value' },
    }),
  );

  const result = await prepareDeployArtifact(root);

  expect(result.artifact.manifest.vars).toEqual({
    API_URL: 'https://api.example.test',
    EMPTY_SETTING: '',
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('omits empty configured Worker vars', async () => {
  writeFileSync(join(root, 'void.config.ts'), 'export default { worker: { vars: {} } };');

  const result = await prepareDeployArtifact(root);

  expect(result.artifact.manifest).not.toHaveProperty('vars');
  expect(fetch).not.toHaveBeenCalled();
});
it('fails when Worker build output is missing', async () => {
  rmSync(join(root, 'dist/server'), { recursive: true });
  await expect(prepareDeployArtifact(root)).rejects.toThrow('Worker output not found');
});
it('packages native Durable Objects for managed deployment without namespace authority', async () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vite: '*' } }));
  mkdirSync(join(root, 'durable-objects'));
  writeFileSync(
    join(root, 'durable-objects/workspace.ts'),
    "import {defineDurableObject} from 'void/durable'; export default defineDurableObject({name:'workspace',class: class Workspace {}});",
  );
  const result = await prepareDeployArtifact(root);
  expect(result.artifact.manifest.version).toBe(4);
  expect(result.artifact.manifest.durableObjects).toEqual({
    bindings: [
      { bindingName: 'WORKSPACE', className: 'WorkspaceDurableObject', storage: 'sqlite' },
    ],
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('packages a detected Vite SPA as assets without a Worker or provider calls', async () => {
  rmSync(join(root, 'dist/server'), { recursive: true });
  rmSync(join(root, 'dist/client'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vite: '*' } }));
  writeFileSync(join(root, 'dist/index.html'), '<div id="root"></div>');
  const result = await prepareDeployArtifact(root);
  expect(result.artifact.manifest).toMatchObject({ type: 'spa', bindings: {} });
  expect(result.artifact.manifest.assetConfig).toMatchObject({
    not_found_handling: 'single-page-application',
  });
  expect(result.artifact.workerFiles).toBeUndefined();
  expect(Buffer.from(result.assets['/index.html']!, 'base64').toString()).toBe(
    '<div id="root"></div>',
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each([true, false, undefined])(
  'honors static output directories and HTTPS policy %s without packaging stale Worker output',
  async (alwaysUseHttps) => {
    writeFileSync(
      join(root, 'void.config.ts'),
      `export default { inference: { appType: 'static', outputDir: 'site' }, routing: { alwaysUseHttps: ${alwaysUseHttps}, notFound: '404-page' }, worker: { vars: { API_URL: 'https://api.example.test' } } };`,
    );
    mkdirSync(join(root, 'site'));
    writeFileSync(join(root, 'site/index.html'), '<h1>Static</h1>');
    writeFileSync(join(root, 'site/_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
    writeFileSync(join(root, 'site/_redirects'), '/old /new 301\n');
    const result = await prepareDeployArtifact(root);
    expect(result.artifact.manifest).toMatchObject({
      type: 'static',
      assetConfig: { not_found_handling: '404-page' },
      headerRules: [{ pattern: '/*', headers: [['X-Content-Type-Options', 'nosniff']] }],
      redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
    });
    expect(result.artifact.workerFiles).toBeUndefined();
    expect(result.artifact.manifest.alwaysUseHttps).toBe(alwaysUseHttps);
    expect(Object.hasOwn(result.artifact.manifest, 'alwaysUseHttps')).toBe(
      alwaysUseHttps !== undefined,
    );
    expect(result.artifact.manifest).not.toHaveProperty('vars');
    expect(Object.keys(result.assets)).toEqual(['/index.html']);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('keeps SPA plus API apps on the Worker deployment path', async () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vite: '*' } }));
  mkdirSync(join(root, 'routes'));
  writeFileSync(join(root, 'routes/api.ts'), 'export const GET = () => ({ ok: true });');
  const result = await prepareDeployArtifact(root);
  expect(result.artifact.manifest.type).toBe('void');
  expect(result.artifact.workerFiles).toHaveProperty('index.js');
  expect(fetch).not.toHaveBeenCalled();
});

it('does not silently drop an SSG backend without an explicit app type', async () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { vitepress: '*' } }));
  mkdirSync(join(root, 'routes'));
  await expect(prepareDeployArtifact(root)).rejects.toThrow('also has backend code');
});

it('rejects missing or empty static build output', async () => {
  writeFileSync(
    join(root, 'void.config.ts'),
    `export default { inference: { appType: 'spa', outputDir: 'missing' } };`,
  );
  await expect(prepareDeployArtifact(root)).rejects.toThrow('Static build output is missing');
  mkdirSync(join(root, 'missing'));
  await expect(prepareDeployArtifact(root)).rejects.toThrow('Static build output is empty');
  expect(fetch).not.toHaveBeenCalled();
});

it.each([true, false, undefined])(
  'preserves HTTPS policy %s in a prepared Worker artifact',
  async (alwaysUseHttps) => {
    writeFileSync(
      join(root, 'void.config.ts'),
      `export default { routing: { alwaysUseHttps: ${alwaysUseHttps} } };`,
    );
    const result = await prepareDeployArtifact(root);
    expect(result.artifact.manifest.alwaysUseHttps).toBe(alwaysUseHttps);
    expect(Object.hasOwn(result.artifact.manifest, 'alwaysUseHttps')).toBe(
      alwaysUseHttps !== undefined,
    );
  },
);
