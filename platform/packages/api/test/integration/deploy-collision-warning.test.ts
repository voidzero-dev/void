import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import app from '../../src/index.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestProjectSecret,
  mockCfApi,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function buildDeployRequest(projectId: string, jwt: string, manifest: object): Request {
  const workerSrc = "export default { fetch() { return new Response('ok'); } }";
  return new Request(`http://localhost/projects/${projectId}/deploy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      manifest: { assetManifestVersion: 2, ...manifest },
      assetManifest: {},
      source: null,
      commit: null,
      repositoryUrl: null,
      commitUrl: null,
      gitRef: null,
      preflight: null,
      workerFiles: { 'index.js': bytesToBase64(new TextEncoder().encode(workerSrc)) },
    }),
  });
}

describe('manifest var / secret collision warning', () => {
  it('uploads each binding once and warns when a secret overrides a manifest var', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'collision-app');
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'secret-value');
    const fetchMock = mockCfApi();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await app.fetch(
      buildDeployRequest(project.id, user.jwt, {
        version: 3,
        bindings: {},
        vars: { API_KEY: 'from-manifest', API_URL: 'https://api.example.test' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    await res.text();

    // Logger emits a structured JSON line via console.warn; the relevant
    // record carries `msg: 'var_secret_collisions'` and the colliding name
    // in `collisions`.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('var_secret_collisions'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('API_KEY'));

    const uploadCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/workers/dispatch/') && (init as RequestInit)?.method === 'PUT',
    );
    expect(uploadCall).toBeDefined();
    const form = (uploadCall![1] as RequestInit).body as FormData;
    const metadata = JSON.parse(await (form.get('metadata') as Blob).text()) as {
      bindings: Array<{ name: string; type: string; text?: string }>;
    };
    expect(metadata.bindings.filter(({ name }) => name === 'API_KEY')).toEqual([
      { type: 'secret_text', name: 'API_KEY', text: 'secret-value' },
    ]);
    expect(metadata.bindings).toContainEqual({
      type: 'plain_text',
      name: 'API_URL',
      text: 'https://api.example.test',
    });
    const names = metadata.bindings.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
  });
});
