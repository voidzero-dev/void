import { describe, expect, it } from 'vite-plus/test';
import { isVoidSecretOnlyDraft, isWranglerSecretOnlyDraft } from '../../src/secret-draft.ts';
import { apiSecretDraftVersion, voidSecretDraftVersion } from '../secret-draft-fixture.ts';

describe('immutable SDK secret draft proof', () => {
  it('recognizes the placeholder that the secret transport deploys in one request', () => {
    const draft = apiSecretDraftVersion();
    expect(isVoidSecretOnlyDraft(draft)).toBe(true);
    expect(isVoidSecretOnlyDraft({ ...draft, source: 'cf_cli' })).toBe(false);
    expect(isVoidSecretOnlyDraft({ ...draft, source: 'dash' })).toBe(false);
    expect(
      isVoidSecretOnlyDraft({
        ...draft,
        annotations: { ...draft.annotations, 'workers/tag': 'release' },
      }),
    ).toBe(false);
    expect(
      isVoidSecretOnlyDraft({
        ...draft,
        annotations: { 'workers/triggered_by': 'create_version_api' },
      }),
    ).toBe(false);
    expect(isVoidSecretOnlyDraft({ ...draft, bindings: [], env: {} })).toBe(false);
  });

  it('recognizes the actual cf placeholder without treating its compatibility date as proof', () => {
    const draft = voidSecretDraftVersion();
    expect(isWranglerSecretOnlyDraft(draft)).toBe(false);
    expect(isVoidSecretOnlyDraft(draft)).toBe(true);
    expect(isVoidSecretOnlyDraft({ ...draft, modules: undefined })).toBe(false);
  });

  it.each([
    [
      'application code',
      {
        modules: [
          {
            name: 'index.js',
            content_type: 'application/javascript+module',
            content_base64: Buffer.from(
              'export default { fetch() { return new Response("application"); } };\n',
            ).toString('base64'),
          },
        ],
      },
    ],
    [
      'another module',
      {
        modules: [
          ...voidSecretDraftVersion().modules,
          { name: 'data.txt', content_type: 'text/plain', content_base64: '' },
        ],
      },
    ],
    ['different main', { main_module: 'other.js' }],
    ['stateful exports', { exports: { Room: { type: 'durable-object' } } }],
    ['assets', { assets: {} }],
    ['settings', { compatibility_flags: ['nodejs_compat'] }],
    [
      'a different annotation',
      { annotations: { 'workers/triggered_by': 'secret', 'workers/message': 'an application' } },
    ],
    [
      'a non-secret resource',
      {
        bindings: [
          ...voidSecretDraftVersion().bindings,
          { name: 'KV', type: 'kv_namespace', namespace_id: 'foreign' },
        ],
      },
    ],
    ['a secret key', { bindings: [{ name: 'TOKEN', type: 'secret_key' }] }],
    ['a secret value', { bindings: [{ name: 'TOKEN', type: 'secret_text', text: 'private' }] }],
    [
      'duplicate bindings',
      { bindings: [...voidSecretDraftVersion().bindings, ...voidSecretDraftVersion().bindings] },
    ],
    [
      'a contradictory env',
      { env: { TOKEN: { type: 'secret_text' }, OTHER: { type: 'text', value: 'private' } } },
    ],
    ['a public version URL', { urls: ['https://version.example.workers.dev'] }],
    ['an unknown uploader', { source: 'api' }],
    [
      'contradictory adapter bindings',
      { resources: { bindings: [{ name: 'OTHER', type: 'secret_text' }] } },
    ],
  ])('refuses %s', (_name, patch) => {
    expect(isVoidSecretOnlyDraft({ ...voidSecretDraftVersion(), ...patch })).toBe(false);
  });

  it('accepts only the adapter compatibility binding view, independent of object key order', () => {
    expect(
      isVoidSecretOnlyDraft({
        ...voidSecretDraftVersion(),
        resources: { bindings: [{ type: 'secret_text', name: 'TOKEN' }] },
      }),
    ).toBe(true);
  });
});
