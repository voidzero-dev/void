import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  addQueueConsumer,
  cfFetch,
  createD1Database,
  createR2Bucket,
  setD1ReadReplication,
  createHyperdrive,
  ensureHyperdriveCachingDisabled,
  getDispatchWorkerProxyToken,
  parseHyperdriveConnectionString,
  removeQueueConsumer,
  restoreQueueConsumer,
  snapshotQueueConsumer,
  updateHyperdrive,
} from '../../src/provisioning/cloudflare-api.ts';

const ACCOUNT = 'acc_test';
const TOKEN = 'token_test';
const QUEUE_ID = 'queue-uuid';
const SCRIPT = 'void-dispatch';

describe('R2 bucket creation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['apac', undefined] as const)(
    'sends the optional location hint %s',
    async (locationHint) => {
      const request = vi.fn().mockResolvedValue(cfSuccess({ name: 'app-storage' }));
      vi.stubGlobal('fetch', request);
      await createR2Bucket(ACCOUNT, TOKEN, 'app-storage', locationHint);
      expect(request).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'app-storage', ...(locationHint ? { locationHint } : {}) }),
        }),
      );
    },
  );
});

function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

function cfError(message: string): Response {
  return Response.json({ success: false, errors: [{ code: 100, message }] }, { status: 400 });
}

describe('Cloudflare API deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['headers', 'body'])(
    'aborts a queue request stalled while reading %s without retrying the mutation',
    async (stalledAt) => {
      let signal: AbortSignal | undefined;
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal!;
        if (stalledAt === 'headers') {
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal!.reason), { once: true });
          });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"success":true,"result":'));
              signal?.addEventListener('abort', () => controller.error(signal!.reason), {
                once: true,
              });
            },
          }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      const pending = cfFetch(
        'https://api.cloudflare.com/client/v4/accounts/test/queues/q/consumers',
        TOKEN,
        {
          method: 'POST',
          body: '{}',
        },
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toMatchObject({
        message: expect.stringMatching(/timed out.*POST.*consumers/i),
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('preserves caller cancellation and clears the request deadline', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Stopped by caller', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      }),
    );
    const pending = cfFetch('https://api.cloudflare.com/client/v4/test', TOKEN, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after a successful request or a provider error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(cfSuccess({ id: 'consumer' }))
      .mockResolvedValueOnce(cfError('insufficient permissions'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(cfFetch('https://api.cloudflare.com/client/v4/test', TOKEN)).resolves.toEqual({
      id: 'consumer',
    });
    await expect(cfFetch('https://api.cloudflare.com/client/v4/test', TOKEN)).rejects.toThrow(
      'insufficient permissions',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createD1Database', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, false, true])(
    'creates a database with readReplication %s',
    async (readReplication) => {
      const fetchMock = vi.fn().mockResolvedValue(cfSuccess({ uuid: 'db-uuid', name: 'app-db' }));
      vi.stubGlobal('fetch', fetchMock);

      await createD1Database(ACCOUNT, TOKEN, 'app-db', { readReplication });

      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'app-db',
            ...(readReplication !== undefined && {
              read_replication: { mode: readReplication ? 'auto' : 'disabled' },
            }),
          }),
        }),
      );
    },
  );

  it.each([true, false])(
    'sets read replication to %s on an existing database',
    async (readReplication) => {
      const fetchMock = vi.fn().mockResolvedValue(cfSuccess({}));
      vi.stubGlobal('fetch', fetchMock);

      await setD1ReadReplication(ACCOUNT, TOKEN, 'db-uuid', readReplication);

      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/db-uuid`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            read_replication: { mode: readReplication ? 'auto' : 'disabled' },
          }),
        }),
      );
    },
  );
});

describe('addQueueConsumer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns {status:"created"} when the POST creates a new consumer', async () => {
    fetchMock.mockResolvedValueOnce(cfSuccess({ consumer_id: 'c1' }));

    const result = await addQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT);

    expect(result).toEqual({ status: 'created' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns {status:"updated"} when the consumer already exists under our script', async () => {
    // POST fails with "already has a consumer"
    fetchMock.mockResolvedValueOnce(cfError('queue already has a consumer'));
    // GET lists our consumer
    fetchMock.mockResolvedValueOnce(
      cfSuccess([{ consumer_id: 'c1', script: SCRIPT, settings: {} }]),
    );
    // PUT to update settings
    fetchMock.mockResolvedValueOnce(cfSuccess({ consumer_id: 'c1' }));

    const result = await addQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT, { batch_size: 1 });

    expect(result).toEqual({ status: 'updated' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('PUT');
  });

  it('returns {status:"conflict", ownerScript} when a different script owns the consumer', async () => {
    fetchMock.mockResolvedValueOnce(cfError('queue already has a consumer'));
    fetchMock.mockResolvedValueOnce(
      cfSuccess([{ consumer_id: 'c1', script: 'other-script', settings: {} }]),
    );

    const result = await addQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT, { batch_size: 1 });

    expect(result).toEqual({ status: 'conflict', ownerScript: 'other-script' });
    // POST + GET, but no PUT on the conflicting consumer
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when POST fails for a reason other than "already exists"', async () => {
    fetchMock.mockResolvedValueOnce(cfError('insufficient permissions'));

    await expect(addQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT)).rejects.toThrow(
      /insufficient permissions/i,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('queue consumer snapshots', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('snapshots and restores exact settings', async () => {
    const snapshot = {
      consumer_id: 'c1',
      script: SCRIPT,
      type: 'worker',
      settings: { batch_size: 7, max_retries: 3 },
    };
    fetchMock.mockResolvedValueOnce(cfSuccess([snapshot]));
    await expect(snapshotQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT)).resolves.toEqual(
      snapshot,
    );

    fetchMock.mockResolvedValueOnce(cfSuccess([{ ...snapshot, settings: { batch_size: 1 } }]));
    fetchMock.mockResolvedValueOnce(cfSuccess({ consumer_id: 'c1' }));
    await restoreQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT, snapshot);

    const restoreRequest = fetchMock.mock.calls[2][1] as RequestInit;
    expect(restoreRequest.method).toBe('PUT');
    expect(JSON.parse(String(restoreRequest.body))).toEqual({
      script_name: SCRIPT,
      type: 'worker',
      settings: { batch_size: 7, max_retries: 3 },
    });
  });

  it('removes only the matching script consumer', async () => {
    fetchMock.mockResolvedValueOnce(
      cfSuccess([
        { consumer_id: 'other', script: 'other-worker', type: 'worker', settings: {} },
        { consumer_id: 'ours', script: SCRIPT, type: 'worker', settings: {} },
      ]),
    );
    fetchMock.mockResolvedValueOnce(cfSuccess(null));

    await removeQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT);

    expect(fetchMock.mock.calls[1][0]).toContain('/consumers/ours');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });
});

describe('Hyperdrive connection strings', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses postgres connection strings into Cloudflare origin fields', () => {
    expect(
      parseHyperdriveConnectionString(
        'postgresql://user:p%40ss@example.com:6543/app_db?sslmode=require',
      ),
    ).toEqual({
      origin: {
        database: 'app_db',
        host: 'example.com',
        password: 'p@ss',
        port: 6543,
        scheme: 'postgresql',
        user: 'user',
      },
    });
  });

  it('defaults PostgreSQL Hyperdrive origins to port 5432 when omitted', () => {
    expect(
      parseHyperdriveConnectionString(
        'postgresql://user:pass@ep-aged-field-aql3zcv7.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require',
      ),
    ).toEqual({
      origin: {
        database: 'neondb',
        host: 'ep-aged-field-aql3zcv7.c-8.us-east-1.aws.neon.tech',
        password: 'pass',
        port: 5432,
        scheme: 'postgresql',
        user: 'user',
      },
    });
  });

  it.each([
    'require',
    'verify-ca',
    'verify-full',
    'verify-full&sslrootcert=system',
    'verify-full&sslrootcert=/home/dev/prod-ca-2021.crt',
    'require&sslrootcert=./rds-ca.pem',
  ])('sends no Hyperdrive TLS settings for PostgreSQL sslmode=%s', (sslmode) => {
    expect(
      parseHyperdriveConnectionString(
        `postgresql://user:pass@db.example.com/app_db?sslmode=${sslmode}`,
      ),
    ).not.toHaveProperty('mtls');
  });

  it.each(['disable', 'prefer', 'no-verify'])(
    'rejects PostgreSQL sslmode=%s before calling Cloudflare',
    async (sslmode) => {
      await expect(
        createHyperdrive(
          ACCOUNT,
          TOKEN,
          'proj-hyperdrive',
          `postgresql://user:pass@db.example.com/app?sslmode=${sslmode}`,
        ),
      ).rejects.toThrow(/Unsupported sslmode/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('parses MySQL connection strings and defaults to port 3306', () => {
    expect(parseHyperdriveConnectionString('mysql://user:p%40ss@mysql.example.com/app_db')).toEqual(
      {
        origin: {
          database: 'app_db',
          host: 'mysql.example.com',
          password: 'p@ss',
          port: 3306,
          scheme: 'mysql',
          user: 'user',
        },
      },
    );
  });

  it('sends parsed origin fields when creating Hyperdrive configs', async () => {
    fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'hd_1', name: 'proj-hyperdrive' }));

    await createHyperdrive(
      ACCOUNT,
      TOKEN,
      'proj-hyperdrive',
      'postgres://user:pass@db.example.com:5432/app?sslmode=verify-full&sslrootcert=/home/dev/prod-ca-2021.crt',
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: 'proj-hyperdrive',
      caching: { disabled: true },
      origin: {
        database: 'app',
        host: 'db.example.com',
        password: 'pass',
        port: 5432,
        scheme: 'postgres',
        user: 'user',
      },
    });
  });

  it('sends no TLS settings when updating Hyperdrive configs, so Cloudflare keeps the existing ones', async () => {
    fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'hd_1', name: 'proj-hyperdrive' }));

    await updateHyperdrive(
      ACCOUNT,
      TOKEN,
      'hd_1',
      'postgresql://user:pass@db.example.com/app?sslmode=verify-full&sslrootcert=system',
      'proj-hyperdrive',
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: 'proj-hyperdrive',
      caching: { disabled: true },
      origin: {
        database: 'app',
        host: 'db.example.com',
        password: 'pass',
        port: 5432,
        scheme: 'postgresql',
        user: 'user',
      },
    });
  });

  it('leaves a Hyperdrive config with caching already off unchanged', async () => {
    fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'hd_1', caching: { disabled: true } }));

    await ensureHyperdriveCachingDisabled(ACCOUNT, TOKEN, 'hd_1');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc_test/hyperdrive/configs/hd_1',
    );
    expect([undefined, 'GET']).toContain((init as RequestInit).method);
  });

  it('turns caching off with a PATCH that sends no origin', async () => {
    fetchMock
      .mockResolvedValueOnce(
        cfSuccess({
          id: 'hd_1',
          caching: { disabled: false, max_age: 60, stale_while_revalidate: 15 },
        }),
      )
      .mockResolvedValueOnce(cfSuccess({ id: 'hd_1' }));

    await ensureHyperdriveCachingDisabled(ACCOUNT, TOKEN, 'hd_1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc_test/hyperdrive/configs/hd_1',
    );
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      caching: { disabled: true },
    });
  });

  it('rejects malformed database URLs before calling Cloudflare', async () => {
    await expect(
      createHyperdrive(ACCOUNT, TOKEN, 'proj-hyperdrive', 'postgresql://user@db.example.com/app'),
    ).rejects.toThrow(/password/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported database URL schemes before calling Cloudflare', async () => {
    await expect(
      createHyperdrive(ACCOUNT, TOKEN, 'proj-hyperdrive', 'sqlite://user:pass@db.example.com/app'),
    ).rejects.toThrow(/mysql:\/\//i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getDispatchWorkerProxyToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns {kind:"found", token} for the __VOID_PROXY_TOKEN binding baked into the worker', async () => {
    fetchMock.mockResolvedValueOnce(
      cfSuccess([
        { type: 'plain_text', name: '__PROJECT_ID', text: 'proj_a' },
        { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-token-value' },
        { type: 'queue', name: 'QUEUE_EMAILS', queue_name: 'proj_a-emails' },
      ]),
    );

    const result = await getDispatchWorkerProxyToken(ACCOUNT, TOKEN, 'void-users', 'user-a-dpl_1');

    expect(result).toEqual({ kind: 'found', token: 'baked-token-value' });
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toMatch(
      /\/workers\/dispatch\/namespaces\/void-users\/scripts\/user-a-dpl_1\/bindings$/,
    );
  });

  it('returns {kind:"missing"} when bindings list has no __VOID_PROXY_TOKEN', async () => {
    fetchMock.mockResolvedValueOnce(
      cfSuccess([{ type: 'plain_text', name: '__PROJECT_ID', text: 'proj_a' }]),
    );

    const result = await getDispatchWorkerProxyToken(ACCOUNT, TOKEN, 'void-users', 'user-a-dpl_1');

    expect(result).toEqual({ kind: 'missing' });
  });

  it('returns {kind:"error"} with the underlying Error on CF API failure (rate limit / auth / network)', async () => {
    fetchMock.mockResolvedValueOnce(cfError('rate limited'));

    const result = await getDispatchWorkerProxyToken(ACCOUNT, TOKEN, 'void-users', 'user-missing');

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toMatch(/rate limited/i);
    }
  });

  it('returns {kind:"error"} when fetch itself throws (network failure)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await getDispatchWorkerProxyToken(ACCOUNT, TOKEN, 'void-users', 'user-net-fail');

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toMatch(/ECONNRESET/);
    }
  });
});
