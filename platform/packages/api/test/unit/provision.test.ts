import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { Db } from '../../src/db.ts';
import { provisionBindings } from '../../src/provisioning/provision.ts';
import type { DeployManifest, Resource } from '../../src/types.ts';

vi.mock('../../src/provisioning/cloudflare-api', () => ({
  createD1Database: vi.fn().mockResolvedValue({ uuid: 'd1-uuid-123', name: 'test-DB' }),
  setD1ReadReplication: vi.fn().mockResolvedValue(undefined),
  ensureHyperdriveCachingDisabled: vi.fn().mockResolvedValue(undefined),
  createKVNamespace: vi.fn().mockResolvedValue({ id: 'kv-id-456', title: 'test-KV' }),
  createR2Bucket: vi.fn().mockResolvedValue({ name: 'test-STORAGE' }),
  createQueue: vi.fn().mockResolvedValue({ queue_id: 'queue-id-789', queue_name: 'test-queue' }),
  deleteD1Database: vi.fn().mockResolvedValue(undefined),
  deleteKVNamespace: vi.fn().mockResolvedValue(undefined),
  deleteR2Bucket: vi.fn().mockResolvedValue(undefined),
  deleteQueue: vi.fn().mockResolvedValue(undefined),
  getD1DatabaseByName: vi.fn().mockResolvedValue({ uuid: 'd1-looked-up', name: 'test-DB' }),
  getKVNamespaceByTitle: vi.fn().mockResolvedValue({ id: 'kv-looked-up', title: 'test-KV' }),
  getQueueByName: vi.fn().mockResolvedValue({ queue_id: 'queue-looked-up', queue_name: 'test-q' }),
}));

vi.mock('../../src/db', () => ({
  getProjectResources: vi.fn().mockResolvedValue([]),
  createResource: vi
    .fn()
    .mockImplementation(
      (_db: unknown, projectId: string, type: string, cfId: string, bindingName: string) =>
        Promise.resolve({
          id: `res_mock`,
          project_id: projectId,
          type,
          cf_id: cfId,
          binding_name: bindingName,
          created_at: new Date().toISOString(),
        }),
    ),
}));

import { getProjectResources, createResource } from '../../src/db.ts';
import {
  createD1Database,
  setD1ReadReplication,
  ensureHyperdriveCachingDisabled,
  createKVNamespace,
  createR2Bucket,
  createQueue,
  deleteD1Database,
  getD1DatabaseByName,
  getKVNamespaceByTitle,
  getQueueByName,
} from '../../src/provisioning/cloudflare-api.ts';

const ACCOUNT_ID = 'test-account';
const API_TOKEN = 'test-token';
const PROJECT_ID = 'proj_abc123';
const PROJECT_SLUG = 'test-slug';
const PROXY_TOKEN = 'test-proxy-token';
const mockDb = {} as Db;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectResources).mockResolvedValue([]);
});

describe('provisionBindings', () => {
  it.each([
    ['apac', 'weur', 'apac'],
    [undefined, 'weur', 'weur'],
    [undefined, undefined, undefined],
  ] as const)('uses R2 hint %s over platform default %s', async (hint, fallback, expected) => {
    await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      {
        version: 5,
        bindings: { r2: ['STORAGE'] },
        storage: hint ? { locationHint: hint } : undefined,
      },
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN, storageLocationHint: fallback },
    );
    expect(createR2Bucket).toHaveBeenCalledWith(
      ACCOUNT_ID,
      API_TOKEN,
      'proj-abc123-storage',
      expected,
    );
  });

  it('keeps an existing R2 bucket when its requested location changes', async () => {
    vi.mocked(getProjectResources).mockResolvedValue([
      { type: 'r2', binding_name: 'STORAGE', cf_id: 'existing-bucket' } as Resource,
    ]);
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      { version: 5, bindings: { r2: ['STORAGE'] }, storage: { locationHint: 'apac' } },
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );
    expect(createR2Bucket).not.toHaveBeenCalled();
    expect(bindings).toContainEqual({
      type: 'r2_bucket',
      name: 'STORAGE',
      bucket_name: 'existing-bucket',
    });
  });
  it('provisions D1 when manifest requires it and no resource exists', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createD1Database).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-db', {
      readReplication: undefined,
    });
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, 'd1', 'd1-uuid-123', 'DB');
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'd1-uuid-123' });
    // + 4 always-injected platform bindings
    expect(bindings).toHaveLength(5);
  });

  it('rolls back the CF resource it created when the resources-row INSERT fails', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    // Model a concurrent-teardown FK violation: the row INSERT throws AFTER CF
    // created the D1 database. Without rollback this leaves an orphaned CF object
    // with no durable handle (the cascade-capture sweep never sees it).
    vi.mocked(createResource).mockRejectedValueOnce(new Error('insert failed (FK violation)'));

    await expect(
      provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest, 'void-proxy', {
        projectSlug: PROJECT_SLUG,
        proxyToken: PROXY_TOKEN,
      }),
    ).rejects.toThrow('insert failed');

    // CF created it...
    expect(createD1Database).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-db', {
      readReplication: undefined,
    });
    // ...and the rollback deleted exactly that object.
    expect(deleteD1Database).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'd1-uuid-123');
  });

  it('does NOT roll back a CF resource adopted via the already-exists lookup', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    // createCfResource hits "already exists" → lookupCfResource adopts a
    // pre-existing object we do NOT own. Even if the row INSERT then fails, we
    // must not delete someone else's resource.
    vi.mocked(createD1Database).mockRejectedValueOnce(new Error('database already exists'));
    vi.mocked(createResource).mockRejectedValueOnce(new Error('insert failed (FK violation)'));

    await expect(
      provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest, 'void-proxy', {
        projectSlug: PROJECT_SLUG,
        proxyToken: PROXY_TOKEN,
      }),
    ).rejects.toThrow('insert failed');

    expect(deleteD1Database).not.toHaveBeenCalled();
  });

  it('provisions KV when manifest requires it', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { kv: ['KV'] } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createKVNamespace).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-kv');
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, 'kv', 'kv-id-456', 'KV');
    expect(bindings[0]).toEqual({ type: 'kv_namespace', name: 'KV', namespace_id: 'kv-id-456' });
    expect(bindings).toHaveLength(5);
  });

  it('provisions R2 when manifest requires it', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { r2: ['STORAGE'] } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createR2Bucket).toHaveBeenCalledWith(
      ACCOUNT_ID,
      API_TOKEN,
      'proj-abc123-storage',
      undefined,
    );
    expect(createResource).toHaveBeenCalledWith(
      mockDb,
      PROJECT_ID,
      'r2',
      'test-STORAGE',
      'STORAGE',
    );
    expect(bindings[0]).toEqual({
      type: 'r2_bucket',
      name: 'STORAGE',
      bucket_name: 'test-STORAGE',
    });
    expect(bindings).toHaveLength(5);
  });

  it('provisions queue and stores queue_id (UUID) as cf_id', async () => {
    const manifest: DeployManifest = {
      version: 3,
      bindings: {},
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createQueue).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-emails');
    expect(createResource).toHaveBeenCalledWith(
      mockDb,
      PROJECT_ID,
      'queue',
      'queue-id-789',
      'emails',
    );
    expect(bindings[0]).toEqual({
      type: 'queue',
      name: 'QUEUE_EMAILS',
      queue_name: 'proj-abc123-emails',
      queue_id: 'queue-id-789',
    });
    expect(bindings).toHaveLength(5);
  });

  it('skips provisioning when resources already exist', async () => {
    const existingResources: Array<Resource> = [
      {
        id: 'res_existing',
        project_id: PROJECT_ID,
        type: 'd1',
        cf_id: 'existing-d1-id',
        binding_name: 'DB',
        created_at: new Date().toISOString(),
        metadata: {},
      },
    ];
    vi.mocked(getProjectResources).mockResolvedValue(existingResources);

    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createD1Database).not.toHaveBeenCalled();
    expect(setD1ReadReplication).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'existing-d1-id' });
    expect(bindings).toHaveLength(5);
  });

  describe('existing project database', () => {
    const manifest: DeployManifest = { version: 1, bindings: { hyperdrive: ['HYPERDRIVE'] } };

    beforeEach(() => {
      vi.mocked(getProjectResources).mockResolvedValue([
        {
          id: 'res_hd',
          project_id: PROJECT_ID,
          type: 'hyperdrive',
          cf_id: 'existing-hd-id',
          binding_name: 'HYPERDRIVE',
          created_at: new Date().toISOString(),
          metadata: {},
        },
      ]);
    });

    it('checks Hyperdrive caching for an existing project database', async () => {
      const bindings = await provisionBindings(
        mockDb,
        ACCOUNT_ID,
        API_TOKEN,
        PROJECT_ID,
        manifest,
        'void-proxy',
        { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
      );

      expect(ensureHyperdriveCachingDisabled).toHaveBeenCalledWith(
        ACCOUNT_ID,
        API_TOKEN,
        'existing-hd-id',
      );
      expect(bindings[0]).toEqual({ type: 'hyperdrive', name: 'HYPERDRIVE', id: 'existing-hd-id' });
      expect(bindings).toHaveLength(5);
    });

    it('fails the deploy when the Hyperdrive caching check fails', async () => {
      vi.mocked(ensureHyperdriveCachingDisabled).mockRejectedValueOnce(
        new Error('Cloudflare API error: not found'),
      );

      await expect(
        provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest, 'void-proxy', {
          projectSlug: PROJECT_SLUG,
          proxyToken: PROXY_TOKEN,
        }),
      ).rejects.toThrow('not found');
    });
  });

  it.each(['a'.repeat(32), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'])(
    'reuses queue ID %s without a name lookup or database repair',
    async (id) => {
      vi.mocked(getProjectResources).mockResolvedValue([
        {
          id: 'res_queue',
          project_id: PROJECT_ID,
          type: 'queue',
          cf_id: id,
          binding_name: 'emails',
          created_at: new Date().toISOString(),
          metadata: {},
        },
      ]);
      const bindings = await provisionBindings(
        mockDb,
        ACCOUNT_ID,
        API_TOKEN,
        PROJECT_ID,
        { version: 3, bindings: {}, queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }] },
        'void-proxy',
        { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
      );
      expect(bindings[0]).toMatchObject({ type: 'queue', queue_id: id });
      expect(getQueueByName).not.toHaveBeenCalled();
      expect(createResource).not.toHaveBeenCalled();
      expect(createQueue).not.toHaveBeenCalled();
    },
  );

  it('handles multiple bindings in one deploy', async () => {
    const manifest: DeployManifest = {
      version: 1,
      bindings: { d1: ['DB'], kv: ['KV'], r2: ['STORAGE'] },
    };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createD1Database).toHaveBeenCalledOnce();
    expect(createKVNamespace).toHaveBeenCalledOnce();
    expect(createR2Bucket).toHaveBeenCalledOnce();
    // 3 provisioned + 4 always-injected platform bindings
    expect(bindings).toHaveLength(7);
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'd1-uuid-123' });
    expect(bindings[1]).toEqual({ type: 'kv_namespace', name: 'KV', namespace_id: 'kv-id-456' });
    expect(bindings[2]).toEqual({
      type: 'r2_bucket',
      name: 'STORAGE',
      bucket_name: 'test-STORAGE',
    });
  });

  it('handles empty manifest (only proxy bindings injected)', async () => {
    const manifest: DeployManifest = { version: 1, bindings: {} };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createKVNamespace).not.toHaveBeenCalled();
    expect(createR2Bucket).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
    // Proxy bindings are always injected
    expect(bindings).toHaveLength(4);
    expect(bindings[0]).toEqual({ type: 'service', name: '__VOID_PROXY', service: 'void-proxy' });
  });

  it('always injects proxy bindings with the issued token', async () => {
    const manifest: DeployManifest = { version: 1, bindings: {} };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(bindings).toHaveLength(4);
    expect(bindings[0]).toEqual({ type: 'service', name: '__VOID_PROXY', service: 'void-proxy' });
    expect(bindings[1]).toEqual({ type: 'plain_text', name: '__PROJECT_ID', text: PROJECT_ID });
    expect(bindings[2]).toEqual({
      type: 'plain_text',
      name: '__VOID_PROXY_TOKEN',
      text: PROXY_TOKEN,
    });
  });

  it('always injects __VOID_PROJECT_SLUG, for sandbox and non-sandbox projects alike', async () => {
    // `void/email` defaults an outbound `from` to `<slug>+noreply@<domain>` on
    // EVERY worker, so this is the single unconditional producer — and the
    // sandbox runtime reads the same name.
    const manifest: DeployManifest = { version: 1, bindings: {} };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(bindings).toContainEqual({
      type: 'plain_text',
      name: '__VOID_PROJECT_SLUG',
      text: PROJECT_SLUG,
    });
  });

  it('injects __VOID_EMAIL_DOMAIN from the configured platform mail domain', async () => {
    // Per-environment, never hard-coded: production is `mail.void.cloud` and
    // staging `mail.voidcloud.dev`, and the proxy validates senders
    // against its own copy of the same value.
    const manifest: DeployManifest = { version: 1, bindings: {} };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      {
        projectSlug: PROJECT_SLUG,
        proxyToken: PROXY_TOKEN,
        emailSenderDomain: 'mail.voidcloud.dev',
      },
    );

    expect(bindings).toContainEqual({
      type: 'plain_text',
      name: '__VOID_EMAIL_DOMAIN',
      text: 'mail.voidcloud.dev',
    });
  });

  it('omits __VOID_EMAIL_DOMAIN entirely when no mail domain is configured', async () => {
    // Injecting an empty string would build a malformed `slug+noreply@` the
    // proxy rejects for an unrelated reason. Omitted, the framework fails
    // naming `__VOID_EMAIL_DOMAIN`, which points straight at the misconfig.
    const manifest: DeployManifest = { version: 1, bindings: {} };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN, emailSenderDomain: '' },
    );

    expect(bindings.some((b) => b.name === '__VOID_EMAIL_DOMAIN')).toBe(false);
  });

  it('injects proxy bindings alongside other provisioned bindings', async () => {
    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'], ai: true } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    // D1 + 4 platform bindings
    expect(bindings).toHaveLength(5);
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'd1-uuid-123' });
    expect(bindings[1]).toEqual({ type: 'service', name: '__VOID_PROXY', service: 'void-proxy' });
    expect(bindings[2]).toEqual({ type: 'plain_text', name: '__PROJECT_ID', text: PROJECT_ID });
    expect(bindings[3]).toEqual({
      type: 'plain_text',
      name: '__VOID_PROXY_TOKEN',
      text: PROXY_TOKEN,
    });
  });

  it('provisions only missing resources when some already exist', async () => {
    const existingResources: Array<Resource> = [
      {
        id: 'res_existing',
        project_id: PROJECT_ID,
        type: 'd1',
        cf_id: 'existing-d1-id',
        binding_name: 'DB',
        created_at: new Date().toISOString(),
        metadata: {},
      },
    ];
    vi.mocked(getProjectResources).mockResolvedValue(existingResources);

    const manifest: DeployManifest = {
      version: 1,
      bindings: { d1: ['DB'], kv: ['KV'] },
    };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createKVNamespace).toHaveBeenCalledOnce();
    // 2 provisioned + 4 always-injected platform bindings
    expect(bindings).toHaveLength(6);
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'existing-d1-id' });
    expect(bindings[1]).toEqual({ type: 'kv_namespace', name: 'KV', namespace_id: 'kv-id-456' });
  });
});

describe('ensureResource — already exists fallback', () => {
  for (const state of ['created', 'reused', 'adopted'] as const) {
    it.each([undefined, false, true])(
      `${state} D1 applies only explicitly configured replication: %s`,
      async (readReplication) => {
        if (state === 'reused') {
          vi.mocked(getProjectResources).mockResolvedValue([
            { type: 'd1', binding_name: 'DB', cf_id: 'existing-d1-id' } as Resource,
          ]);
        } else if (state === 'adopted') {
          vi.mocked(createD1Database).mockRejectedValueOnce(new Error('already exists'));
        }
        await provisionBindings(
          mockDb,
          ACCOUNT_ID,
          API_TOKEN,
          PROJECT_ID,
          {
            version: 3,
            bindings: { d1: ['DB'] },
            ...(readReplication !== undefined && { database: { readReplication } }),
          },
          'void-proxy',
          { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
        );
        if (state !== 'reused') {
          expect(createD1Database).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-db', {
            readReplication,
          });
        }
        if (state !== 'created' && readReplication !== undefined) {
          expect(setD1ReadReplication).toHaveBeenCalledExactlyOnceWith(
            ACCOUNT_ID,
            API_TOKEN,
            state === 'reused' ? 'existing-d1-id' : 'd1-looked-up',
            readReplication,
          );
        } else {
          expect(setD1ReadReplication).not.toHaveBeenCalled();
        }
      },
    );
  }

  it("falls back to lookup when D1 create returns 'already exists'", async () => {
    vi.mocked(createD1Database).mockRejectedValueOnce(
      new Error('Cloudflare API error: A database with that name already exists'),
    );

    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createD1Database).toHaveBeenCalledOnce();
    expect(getD1DatabaseByName).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-db');
    expect(setD1ReadReplication).not.toHaveBeenCalled();
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, 'd1', 'd1-looked-up', 'DB');
    expect(bindings[0]).toEqual({ type: 'd1', name: 'DB', id: 'd1-looked-up' });
  });

  it("falls back to lookup when KV create returns 'already exists'", async () => {
    vi.mocked(createKVNamespace).mockRejectedValueOnce(
      new Error('Cloudflare API error: A namespace with that title already exists'),
    );

    const manifest: DeployManifest = { version: 1, bindings: { kv: ['KV'] } };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createKVNamespace).toHaveBeenCalledOnce();
    expect(getKVNamespaceByTitle).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-kv');
    expect(bindings[0]).toEqual({ type: 'kv_namespace', name: 'KV', namespace_id: 'kv-looked-up' });
  });

  it("falls back to lookup when queue create returns 'already exists'", async () => {
    vi.mocked(createQueue).mockRejectedValueOnce(
      new Error('Cloudflare API error: A queue with that name already exists'),
    );

    const manifest: DeployManifest = {
      version: 3,
      bindings: {},
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      'void-proxy',
      { projectSlug: PROJECT_SLUG, proxyToken: PROXY_TOKEN },
    );

    expect(createQueue).toHaveBeenCalledOnce();
    expect(getQueueByName).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, 'proj-abc123-emails');
    expect(bindings[0]).toEqual({
      type: 'queue',
      name: 'QUEUE_EMAILS',
      queue_name: 'proj-abc123-emails',
      queue_id: 'queue-looked-up',
    });
  });

  it("propagates non-'already exists' errors", async () => {
    vi.mocked(createD1Database).mockRejectedValueOnce(
      new Error('Cloudflare API error: rate limit exceeded'),
    );

    const manifest: DeployManifest = { version: 1, bindings: { d1: ['DB'] } };
    await expect(
      provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest, 'void-proxy', {
        projectSlug: PROJECT_SLUG,
        proxyToken: PROXY_TOKEN,
      }),
    ).rejects.toThrow('rate limit exceeded');

    expect(getD1DatabaseByName).not.toHaveBeenCalled();
  });
});
