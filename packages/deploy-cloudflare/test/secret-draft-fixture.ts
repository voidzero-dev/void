/** Sanitized beta shape observed on an immutable cf-created secret placeholder. */
export function voidSecretDraftVersion(): Record<string, unknown> & {
  id: string;
  annotations: Record<string, string>;
  bindings: Array<{ name: string; type: string }>;
  modules: Array<{ name: string; content_type: string; content_base64: string }>;
  compatibility_date: string;
} {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    number: 2,
    startup_time_ms: 2,
    compatibility_date: '2026-10-01',
    main_module: 'index.js',
    annotations: { 'workers/triggered_by': 'secret' },
    usage_model: 'standard',
    urls: [],
    source: 'cf_cli',
    created_on: '2026-10-01T23:16:24.453175Z',
    modules: [
      {
        name: 'index.js',
        content_type: 'application/javascript+module',
        content_base64: Buffer.from(
          'export default { fetch() { return new Response(""); } };\n',
        ).toString('base64'),
      },
    ],
    bindings: [{ name: 'TOKEN', type: 'secret_text' }],
    env: { TOKEN: { type: 'secret_text' } },
    author_id: 'synthetic-author',
  };
}

/** Sanitized shape of the placeholder that Void's transport uploads and deploys in one request. */
export function apiSecretDraftVersion(): ReturnType<typeof voidSecretDraftVersion> {
  return {
    ...voidSecretDraftVersion(),
    number: 1,
    startup_time_ms: 0,
    annotations: {
      'workers/message': 'void:secret-draft',
      'workers/triggered_by': 'create_version_api',
    },
    source: 'api',
  };
}
