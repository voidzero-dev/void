import { platformProjectWorkersDevHostname, platformWorkersDevAliasKey } from '@void/platform';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';
import { ensureProjectIngress, PROJECT_INGRESS_SOURCE } from '../../src/project-ingress.ts';

const project = { id: 'proj_123456abcdef', slug: 'kitchen-sink' };
const workersDev = { subdomain: 'test', installationId: 'team-123456abcdef' };
const application = {
  baseDomain: 'test.workers.dev',
  zoneName: '',
  dedicatedZone: false,
  workersDev,
};
function env() {
  return {
    PLATFORM_APPLICATION: JSON.stringify(application),
    PLATFORM_INSTALLATION_ID: workersDev.installationId,
    DISPATCH_WORKER_NAME: 'void-team-dispatch',
    CF_ACCOUNT_ID: 'account',
    CF_API_TOKEN: 'test-token',
    ROUTING: { put: vi.fn() },
  } as unknown as ApiEnv['Bindings'];
}
afterEach(() => vi.unstubAllGlobals());

describe('project workers.dev ingress', () => {
  it('does not create forwarding Workers for new apps after a domain is attached', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const bindings = env();
    bindings.PLATFORM_APPLICATION = JSON.stringify({
      ...application,
      baseDomain: 'example.com',
      zoneName: 'example.com',
    });
    bindings.ROUTING.get = vi.fn(async () => null) as unknown as KVNamespace['get'];
    await ensureProjectIngress(bindings, project);
    expect(fetcher).not.toHaveBeenCalled();
    expect(bindings.ROUTING.put).not.toHaveBeenCalled();
  });
  it('performs no provider or KV calls for domain-only platforms', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const bindings = env();
    delete bindings.PLATFORM_APPLICATION;
    await ensureProjectIngress(bindings, project);
    expect(fetcher).not.toHaveBeenCalled();
    expect(bindings.ROUTING.put).not.toHaveBeenCalled();
  });
  it('creates one forwarding Worker and safely retries a failed publication', async () => {
    let metadata: { bindings: Array<unknown> } | undefined;
    let uploads = 0;
    let publishes = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/settings')) {
        return Response.json(
          metadata
            ? { success: true, result: metadata }
            : { success: false, errors: [{ message: 'missing' }] },
          { status: metadata ? 200 : 404 },
        );
      }
      if (init?.body instanceof FormData) {
        uploads++;
        metadata = JSON.parse(String(init.body.get('metadata')));
        expect(await (init.body.get('index.js') as Blob).text()).toBe(PROJECT_INGRESS_SOURCE);
        return Response.json({ success: true, result: {} });
      }
      publishes++;
      return Response.json(
        { success: publishes > 1, result: {}, errors: [{ message: 'retry' }] },
        { status: publishes > 1 ? 200 : 503 },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const bindings = env();
    await expect(ensureProjectIngress(bindings, project)).rejects.toThrow('retry');
    await ensureProjectIngress(bindings, project);
    expect(uploads).toBe(1);
    expect(bindings.ROUTING.put).toHaveBeenCalledWith(
      platformWorkersDevAliasKey(platformProjectWorkersDevHostname(project, workersDev)),
      JSON.stringify(project),
    );
  });
  it('never uploads over a Worker with different ownership or bindings', async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { bindings: [] } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(ensureProjectIngress(env(), project)).rejects.toThrow('Refusing to replace');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('forwards the exact request and streaming response through its service binding', async () => {
    const { default: ingress } = (await import(
      `data:text/javascript,${encodeURIComponent(PROJECT_INGRESS_SOURCE)}`
    )) as {
      default: {
        fetch(
          request: Request,
          env: {
            VOID_APP_HOSTNAME: string;
            PLATFORM_DISPATCH: { fetch(request: Request): Promise<Response> };
          },
        ): Promise<Response>;
      };
    };
    const hostname = platformProjectWorkersDevHostname(project, workersDev);
    const request = new Request(`https://${hostname}/api/stream?one=two`);
    const response = new Response('data: test\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    const forward = vi.fn(async () => response);
    expect(
      await ingress.fetch(request, {
        VOID_APP_HOSTNAME: hostname,
        PLATFORM_DISPATCH: { fetch: forward },
      }),
    ).toBe(response);
    expect(forward).toHaveBeenCalledWith(request);
    const denied = await ingress.fetch(new Request('https://other.test.workers.dev/'), {
      VOID_APP_HOSTNAME: hostname,
      PLATFORM_DISPATCH: { fetch: forward },
    });
    expect(denied.status).toBe(404);
    expect(forward).toHaveBeenCalledTimes(1);
    const upgraded = { status: 101, webSocket: {} };
    forward.mockResolvedValueOnce(upgraded as unknown as Response);
    expect(
      await ingress.fetch(
        new Request(`https://${hostname}/socket`, { headers: { Upgrade: 'websocket' } }),
        { VOID_APP_HOSTNAME: hostname, PLATFORM_DISPATCH: { fetch: forward } },
      ),
    ).toBe(upgraded);
  });
});
