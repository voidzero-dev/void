import { createServer } from 'node:http';
import { expect, it } from 'vite-plus/test';
import { publishCloudflareWorkerSettings } from '../../src/cli/cf-worker-settings.ts';

async function fixture(
  run: (
    options: Parameters<typeof publishCloudflareWorkerSettings>[0],
    requests: Array<unknown>,
  ) => Promise<void>,
  status = 200,
  success = true,
) {
  const requests: Array<unknown> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ method: request.method, path: request.url, body: JSON.parse(body) });
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success, result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind');
  }
  try {
    await run(
      {
        apiBaseUrl: `http://127.0.0.1:${address.port}`,
        accountId: 'synthetic-account',
        workerName: 'synthetic-worker',
        headers: { Authorization: 'Bearer synthetic-token' },
      },
      requests,
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

it.each([
  { logpush: false },
  { logpush: true },
  { observability: { enabled: false } },
  { logpush: false, observability: { enabled: true, logs: { destinations: [] } } },
])('publishes only explicitly configured Worker settings: %j', async (settings) => {
  await fixture(async (options, requests) => {
    await publishCloudflareWorkerSettings({ ...options, ...settings });
    expect(requests).toEqual([
      {
        method: 'PATCH',
        path: '/accounts/synthetic-account/workers/scripts/synthetic-worker/script-settings',
        body: settings,
      },
    ]);
  });
});

it('skips publication when both settings are omitted', async () => {
  await fixture(async (options, requests) => {
    await publishCloudflareWorkerSettings(options);
    expect(requests).toEqual([]);
  });
});

it.each([{ logpush: 'false' }, { observability: null }])(
  'rejects invalid explicit settings before publication: %j',
  async (settings) => {
    await fixture(async (options, requests) => {
      await expect(publishCloudflareWorkerSettings({ ...options, ...settings })).rejects.toThrow(
        /not readable/,
      );
      expect(requests).toEqual([]);
    });
  },
);

it.each([
  [403, false],
  [200, false],
] as const)(
  'reports an unsuccessful settings update (HTTP %s, success=%s)',
  async (status, success) => {
    await fixture(
      async (options) => {
        await expect(
          publishCloudflareWorkerSettings({ ...options, logpush: false }),
        ).rejects.toThrow(/did not update Worker settings/);
      },
      status,
      success,
    );
  },
);
