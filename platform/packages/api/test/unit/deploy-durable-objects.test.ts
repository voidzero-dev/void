import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { verifyManagedDurableObjectApplicationBindings } from '../../src/provisioning/durable-objects.ts';
import {
  buildDurableObjectUploadMigrations,
  buildLiveUploadBindings,
  buildSandboxUploadBindings,
  buildWebSocketUploadBindings,
  enrichLiveManifest,
  enrichWebSocketManifest,
  validateManifestShape,
} from '../../src/routes/deploy.ts';
import type { DeployManifest } from '../../src/types.ts';

describe('enrichWebSocketManifest', () => {
  it('reuses previous websocket migrations when class sets are unchanged', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [
          {
            pattern: '/chat/:room',
            filePath: 'chat/[room].ws.ts',
            className: 'ChatRoom',
            mode: 'room',
            hasAuthGate: true,
          },
        ],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [
            {
              pattern: '/chat/:room',
              filePath: 'chat/[room].ws.ts',
              className: 'ChatRoom',
              mode: 'room',
              hasAuthGate: true,
            },
          ],
          classes: ['ChatRoom', 'ChatRoom'],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom']);
    expect(result.manifest.websocket?.migrations).toEqual(previousManifest.websocket?.migrations);
  });

  it('appends migration when a genuinely new class is added', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom', 'PresenceRoom'],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(2);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom', 'PresenceRoom']);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
      { tag: 'ws-v2', newSqliteClasses: ['PresenceRoom'] },
    ]);
  });

  it('does not emit deletedClasses when classes are removed', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom', 'LegacyRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom', 'LegacyRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom'],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    // No version bump — no migration step needed (no new classes)
    expect(result.nextVersion).toBe(1);
    // Class list updated but no new migration appended
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom']);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom', 'LegacyRoom'] },
    ]);
  });

  it('does not emit deletedClasses when all classes are removed', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest({ version: 3, bindings: {} }, previousManifest, 1);

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(1);
    // No new migration — nothing for CF to do
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
    ]);
    expect(result.manifest.websocket?.classes).toEqual([]);
  });

  it('does not re-emit newClasses for a class that was previously created then removed', () => {
    // Scenario: class created in v1, removed in deploy 2, re-added in deploy 3
    // The class namespace already exists in CF — must NOT appear in newClasses again
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: [], // was removed in a previous deploy
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom'], // re-added
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    // No version bump — ChatRoom already exists in CF from ws-v1
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom']);
    // No new migration step — ChatRoom is not "new"
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
    ]);
  });

  it('only emits newClasses for genuinely new classes when mixed with returning classes', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: [],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom', 'PresenceRoom'], // ChatRoom returns, PresenceRoom is new
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(2);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom', 'PresenceRoom']);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
      { tag: 'ws-v2', newSqliteClasses: ['PresenceRoom'] },
    ]);
  });

  it('falls back to previousClasses when migration history is absent (legacy projects)', () => {
    // Legacy project: classes exist in CF but no migration history was recorded
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom'],
        migrations: [], // no history — predates the migration system
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom', 'PresenceRoom'],
          migrations: [],
        },
      },
      previousManifest,
      0,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(1);
    // Only PresenceRoom is new — ChatRoom already exists (from previousClasses fallback)
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newSqliteClasses: ['PresenceRoom'] },
    ]);
  });

  it('re-creates a class that was previously deleted via legacy deletedClasses', () => {
    // Legacy project had a class created then deleted (old behavior).
    // The namespace was actually destroyed — must re-create it.
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: [],
        migrations: [
          { tag: 'ws-v1', newClasses: ['ChatRoom'] },
          { tag: 'ws-v2', deletedClasses: ['ChatRoom'] }, // namespace was destroyed
        ],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom'], // re-adding after deletion
          migrations: [],
        },
      },
      previousManifest,
      2,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(3);
    // ChatRoom must appear in newClasses because its namespace was deleted
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
      { tag: 'ws-v2', deletedClasses: ['ChatRoom'] },
      { tag: 'ws-v3', newSqliteClasses: ['ChatRoom'] },
    ]);
  });

  it('uses SQLite storage for a fresh hosted WebSocket deployment', () => {
    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: { routes: [], classes: ['ChatRoom'] },
      },
      null,
      0,
    );

    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newSqliteClasses: ['ChatRoom'] },
    ]);
  });
});

describe('buildDurableObjectUploadMigrations for WebSocket-only deployments', () => {
  it('returns Cloudflare upload metadata with new_tag and steps', () => {
    expect(
      buildDurableObjectUploadMigrations([
        { tag: 'ws-v1', newClasses: ['ChatRoom', 'LegacyRoom'] },
        { tag: 'ws-v2', newClasses: ['PresenceRoom'] },
      ]),
    ).toEqual({
      new_tag: 'ws-v2',
      steps: [{ new_classes: ['ChatRoom', 'LegacyRoom'] }, { new_classes: ['PresenceRoom'] }],
    });
  });

  it('returns undefined when there are no websocket migrations', () => {
    expect(buildDurableObjectUploadMigrations([])).toBeUndefined();
    expect(buildDurableObjectUploadMigrations(undefined)).toBeUndefined();
  });

  it('serializes SQLite WebSocket migrations without changing legacy steps', () => {
    expect(
      buildDurableObjectUploadMigrations([
        { tag: 'ws-v1', newClasses: ['LegacyRoom'] },
        { tag: 'ws-v2', newSqliteClasses: ['ChatRoom'] },
      ]),
    ).toEqual({
      new_tag: 'ws-v2',
      steps: [{ new_classes: ['LegacyRoom'] }, { new_sqlite_classes: ['ChatRoom'] }],
    });
  });
});

describe('buildWebSocketUploadBindings', () => {
  it('serializes durable object namespaces from websocket routes', () => {
    expect(
      buildWebSocketUploadBindings({
        routes: [
          {
            pattern: '/ws/chat/:room',
            filePath: 'routes/ws/chat/[room].ws.ts',
            className: 'WsChatRoomWs',
            bindingName: 'CHAT_ROOM',
            mode: 'room',
            hasAuthGate: false,
          },
          {
            pattern: '/ws/presence',
            filePath: 'routes/ws/presence.ws.ts',
            className: 'WsPresenceWs',
            mode: 'socket',
            hasAuthGate: false,
          },
        ],
        classes: ['WsChatRoomWs', 'WsPresenceWs'],
      }),
    ).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'CHAT_ROOM',
        class_name: 'WsChatRoomWs',
      },
      {
        type: 'durable_object_namespace',
        name: 'WsPresenceWs',
        class_name: 'WsPresenceWs',
      },
    ]);
  });

  it('falls back to class names when route metadata is unavailable', () => {
    expect(
      buildWebSocketUploadBindings({
        routes: [],
        classes: ['WsPresenceWs', 'WsChatRoomWs', 'WsPresenceWs'],
      }),
    ).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'WsChatRoomWs',
        class_name: 'WsChatRoomWs',
      },
      {
        type: 'durable_object_namespace',
        name: 'WsPresenceWs',
        class_name: 'WsPresenceWs',
      },
    ]);
  });
});

describe('enrichLiveManifest', () => {
  it('adds a SQLite Durable Object migration for the live stream class', () => {
    const result = enrichLiveManifest(
      {
        version: 3,
        bindings: {},
        live: {
          bindingName: 'VOID_LIVE',
          className: 'VoidLiveStreamDurableObject',
          storage: 'sqlite',
          classes: ['VoidLiveStreamDurableObject'],
        },
      },
      null,
      0,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.live?.migrations).toEqual([
      { tag: 'live-v1', newSqliteClasses: ['VoidLiveStreamDurableObject'] },
    ]);
  });

  it('reuses previous live migrations when the class is unchanged', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      live: {
        bindingName: 'VOID_LIVE',
        className: 'VoidLiveStreamDurableObject',
        storage: 'sqlite',
        classes: ['VoidLiveStreamDurableObject'],
        migrations: [{ tag: 'live-v1', newSqliteClasses: ['VoidLiveStreamDurableObject'] }],
      },
    };

    const result = enrichLiveManifest(
      {
        version: 3,
        bindings: {},
        live: {
          bindingName: 'VOID_LIVE',
          className: 'VoidLiveStreamDurableObject',
          storage: 'sqlite',
          classes: ['VoidLiveStreamDurableObject', 'VoidLiveStreamDurableObject'],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.live?.classes).toEqual(['VoidLiveStreamDurableObject']);
    expect(result.manifest.live?.migrations).toEqual(previousManifest.live?.migrations);
  });

  it('does not preserve previous live metadata when the current manifest omits live', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      live: {
        bindingName: 'VOID_LIVE',
        className: 'VoidLiveStreamDurableObject',
        storage: 'sqlite',
        classes: ['VoidLiveStreamDurableObject'],
        migrations: [{ tag: 'live-v1', newSqliteClasses: ['VoidLiveStreamDurableObject'] }],
      },
    };

    const result = enrichLiveManifest({ version: 3, bindings: {} }, previousManifest, 1);

    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.live).toBeUndefined();
  });

  it('uses the shared Durable Object migration version sequence', () => {
    const result = enrichLiveManifest(
      {
        version: 3,
        bindings: {},
        live: {
          bindingName: 'VOID_LIVE',
          className: 'VoidLiveStreamDurableObject',
          storage: 'sqlite',
          classes: ['VoidLiveStreamDurableObject'],
        },
      },
      null,
      3,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(4);
    expect(result.manifest.live?.migrations).toEqual([
      { tag: 'live-v4', newSqliteClasses: ['VoidLiveStreamDurableObject'] },
    ]);
  });
});

describe('buildSandboxUploadMetadata', () => {
  const sandbox = {
    bindingName: 'SANDBOX',
    className: 'Sandbox',
    containerName: 'void-sandbox',
    image: 'docker.io/cloudflare/sandbox:0.8.11',
  };

  it('gives the tenant only the trusted Sandbox service', () => {
    expect(buildSandboxUploadBindings(sandbox, 'void-sb-project-deployment')).toEqual([
      {
        type: 'service',
        name: '__VOID_SANDBOX',
        service: 'void-sb-project-deployment',
      },
    ]);
  });

  it('combines live SQLite Durable Object migrations for Worker upload metadata', () => {
    expect(
      buildDurableObjectUploadMigrations(
        [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
        [{ tag: 'live-v2', newSqliteClasses: ['VoidLiveStreamDurableObject'] }],
      ),
    ).toEqual({
      new_tag: 'live-v2',
      steps: [
        { new_classes: ['ChatRoom'] },
        { new_sqlite_classes: ['VoidLiveStreamDurableObject'] },
      ],
    });
  });

  it('serializes live Durable Object binding metadata', () => {
    expect(
      buildLiveUploadBindings({
        bindingName: 'VOID_LIVE',
        className: 'VoidLiveStreamDurableObject',
        storage: 'sqlite',
        classes: ['VoidLiveStreamDurableObject'],
      }),
    ).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'VOID_LIVE',
        class_name: 'VoidLiveStreamDurableObject',
      },
    ]);
  });

  it('preserves chronological migration tag order across websocket and live migrations', () => {
    expect(
      buildDurableObjectUploadMigrations(
        [
          { tag: 'ws-v1', newClasses: ['ChatRoom'] },
          { tag: 'ws-v3', newClasses: ['PresenceRoom'] },
        ],
        [{ tag: 'live-v2', newSqliteClasses: ['VoidLiveStreamDurableObject'] }],
      ),
    ).toEqual({
      new_tag: 'ws-v3',
      steps: [
        { new_classes: ['ChatRoom'] },
        { new_sqlite_classes: ['VoidLiveStreamDurableObject'] },
        { new_classes: ['PresenceRoom'] },
      ],
    });
  });
});

describe('validateManifestShape sandbox + static/spa rejection', () => {
  const sandbox = {
    bindingName: 'SANDBOX',
    className: 'Sandbox',
    containerName: 'void-sandbox',
    image: 'docker.io/cloudflare/sandbox:0.8.11',
  };

  it('rejects manifest.sandbox when type is "static"', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        type: 'static',
        sandbox,
      }),
    ).toBe('sandbox is not supported for static/spa deployments');
  });

  it('rejects manifest.sandbox when type is "spa"', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        type: 'spa',
        sandbox,
      }),
    ).toBe('sandbox is not supported for static/spa deployments');
  });

  it('accepts manifest.sandbox when type is "void"', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        type: 'void',
        sandbox,
      }),
    ).toBeNull();
  });

  it('accepts manifest.sandbox when type is omitted (defaults to void/framework)', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        sandbox,
      }),
    ).toBeNull();
  });

  it('accepts manifest.sandbox when type is "framework"', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        type: 'framework',
        sandbox,
      }),
    ).toBeNull();
  });
});

describe('verifyManagedDurableObjectApplicationBindings', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const env = {
    CF_ACCOUNT_ID: 'acc-123',
    CF_API_TOKEN: 'tok-123',
    DISPATCH_NAMESPACE: 'void-prod',
  };
  const manifest: DeployManifest = {
    version: 3,
    bindings: {},
    durableObjects: {
      bindings: [{ bindingName: 'TRACKER', className: 'TrackerDo', storage: 'sqlite' }],
      runtime: { protocol: 1, namespaces: { TrackerDo: 'ns-expected' } },
    },
  };

  it('resolves on first read when bindings match immediately', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        errors: [],
        result: [
          { name: 'TRACKER', type: 'durable_object_namespace', namespace_id: 'ns-expected' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      verifyManagedDurableObjectApplicationBindings(env, 'worker-1', manifest),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries empty application bindings without looking up Worker settings', async () => {
    let bindingCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toMatch(/\/scripts\/worker-1\/bindings$/);
      bindingCalls += 1;
      return Response.json({
        success: true,
        errors: [],
        result:
          bindingCalls === 1
            ? []
            : [{ name: 'TRACKER', type: 'durable_object_namespace', namespace_id: 'ns-expected' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      verifyManagedDurableObjectApplicationBindings(env, 'worker-1', manifest, { delaysMs: [0] }),
    ).resolves.toBeUndefined();
    expect(bindingCalls).toBe(2);
  });

  it('rejects when bindings never match across all retry attempts', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        errors: [],
        result: [{ name: 'TRACKER', type: 'durable_object_namespace', namespace_id: 'ns-stale' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      verifyManagedDurableObjectApplicationBindings(env, 'worker-1', manifest, {
        delaysMs: [0, 0, 0],
      }),
    ).rejects.toThrow('Application custom Durable Object binding could not be verified.');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(['response body', 'retry delay'])('honors the deadline during a %s', async (phase) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (phase === 'retry delay') {
        return Response.json({ success: true, errors: [], result: [] });
      }
      const signal = init.signal!;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const rejected = expect(
      verifyManagedDurableObjectApplicationBindings(env, 'worker-1', manifest, {
        deadline: Date.now() + 100,
      }),
    ).rejects.toThrow(
      'The deployment reached its time limit while verifying application Durable Object bindings.',
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
