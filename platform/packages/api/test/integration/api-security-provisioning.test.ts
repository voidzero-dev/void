import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  deleteSecurityScanner,
  provisionSecurityScanner,
  securityScannerNames,
  SECURITY_SCANNER_CLASS,
  SecurityScannerError,
  verifySecurityScanner,
  type SecurityScannerTarget,
} from '../../src/provisioning/security-scanner.ts';
import { mockCfApi, setupEnv, teardownEnv, type MockCfApiHandle, type TestEnv } from './helpers.ts';

// The installation's security scanner: controller Worker + container application +
// gate script in the dispatch namespace (design doc 0095, M6).

let env: TestEnv;
let target: SecurityScannerTarget;

beforeAll(async () => {
  env = await setupEnv();
  target = {
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN,
    apiService: 'void-api-test',
    dispatchNamespace: 'void-users-test',
    installationKey: 'inst_scanner_test',
  };
});
afterAll(teardownEnv);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Upload = { url: string; method: string; headers: Headers; metadata: Record<string, unknown> };

async function uploads(cf: MockCfApiHandle): Promise<Array<Upload>> {
  const result: Array<Upload> = [];
  for (const [input, init] of cf.mock.calls as Array<[string, RequestInit | undefined]>) {
    if (init?.method !== 'PUT' || !(init.body instanceof FormData)) {
      continue;
    }
    const metadata = JSON.parse(await (init.body.get('metadata') as Blob).text());
    result.push({
      url: String(input),
      method: init.method,
      headers: new Headers(init.headers),
      metadata,
    });
  }
  return result;
}

describe('security scanner provisioning', () => {
  it('creates the controller, its container application and the gate', async () => {
    const cf = mockCfApi();
    const names = await securityScannerNames(target.installationKey);
    const { applicationId } = await provisionSecurityScanner(target);

    const [controller, gate, ...rest] = await uploads(cf);
    expect(rest).toEqual([]);
    expect(controller!.url).toContain(`/workers/scripts/${names.worker}`);
    expect(controller!.headers.get('If-None-Match')).toBe('*');
    const metadata = controller!.metadata as {
      bindings: Array<Record<string, unknown>>;
      migrations: unknown;
      containers: unknown;
    };
    expect(metadata.migrations).toEqual({
      new_tag: 'v1',
      steps: [{ new_sqlite_classes: [SECURITY_SCANNER_CLASS] }],
    });
    expect(metadata.containers).toEqual([
      { class_name: SECURITY_SCANNER_CLASS, name: names.application, images: {} },
    ]);
    expect(metadata.bindings).toContainEqual({
      type: 'service',
      name: '__VOID_SECURITY_SCAN_CONTROL',
      service: 'void-api-test',
      entrypoint: 'SecurityScanControl',
      props: { protocol: 1, installation: 'inst_scanner_test' },
    });
    // The controller gets no token, secret or database binding.
    expect(
      metadata.bindings.filter(
        (binding) =>
          !['plain_text', 'service', 'durable_object_namespace'].includes(String(binding.type)),
      ),
    ).toEqual([]);

    expect(gate!.url).toContain(
      `/workers/dispatch/namespaces/void-users-test/scripts/${names.gate}`,
    );
    expect((gate!.metadata as { bindings: unknown }).bindings).toContainEqual({
      type: 'service',
      name: 'SCANNER',
      service: names.worker,
    });

    const app = cf.state.containerApps.get(applicationId);
    expect(app?.name).toBe(names.application);
    expect(app?.durable_objects?.namespace_id).toBe(
      cf.state.hostScripts.get(names.worker)?.classes.get(SECURITY_SCANNER_CLASS),
    );
    // workers.dev stays off: the API reaches the controller only through the gate.
    const subdomain = (cf.mock.calls as Array<[string, RequestInit | undefined]>).find(([url]) =>
      String(url).endsWith(`/workers/scripts/${names.worker}/subdomain`),
    );
    expect(JSON.parse(String(subdomain?.[1]?.body))).toEqual({
      enabled: false,
      previews_enabled: false,
    });
    await verifySecurityScanner(target);
  });

  it('reuses everything on a second run with the same bundle', async () => {
    const cf = mockCfApi();
    const first = await provisionSecurityScanner(target);
    const before = (await uploads(cf)).length;
    const second = await provisionSecurityScanner(target);
    expect(second.applicationId).toBe(first.applicationId);
    expect((await uploads(cf)).length).toBe(before);
    expect(cf.state.containerApps.size).toBe(1);
  });

  it('re-uploads a controller from another release without repeating its migration', async () => {
    const cf = mockCfApi();
    await provisionSecurityScanner(target);
    const names = await securityScannerNames(target.installationKey);
    const script = cf.state.hostScripts.get(names.worker)!;
    script.bindings = script.bindings.map((binding) =>
      binding.name === '__VOID_SECURITY_SCANNER_SOURCE'
        ? { ...binding, text: 'old-digest' }
        : binding,
    );
    await expect(verifySecurityScanner(target)).rejects.toMatchObject({ kind: 'outdated' });
    const before = (await uploads(cf)).length;
    await provisionSecurityScanner(target);
    const update = (await uploads(cf)).slice(before)[0]!;
    expect(update.url).toContain(`/workers/scripts/${names.worker}`);
    expect(update.headers.get('If-None-Match')).toBeNull();
    expect(update.metadata.migrations).toBeUndefined();
    await verifySecurityScanner(target);
  });

  it('refuses a Worker with the scanner name that another installation owns', async () => {
    const cf = mockCfApi();
    const names = await securityScannerNames(target.installationKey);
    cf.seedHostScript({
      scriptName: names.worker,
      bindings: [
        {
          type: 'plain_text',
          name: '__VOID_SECURITY_SCANNER_OWNER',
          text: JSON.stringify({ protocol: 1, installation: 'someone-else' }),
        },
      ],
    });
    const error = await provisionSecurityScanner(target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecurityScannerError);
    expect(error).toMatchObject({ kind: 'ownership' });
    expect(await uploads(cf)).toEqual([]);
    expect(cf.state.containerApps.size).toBe(0);
  });

  it("refuses a gate that has no owner marker or another installation's marker", async () => {
    const names = await securityScannerNames(target.installationKey);
    for (const marker of [
      undefined,
      JSON.stringify({ protocol: 1, installation: 'someone-else' }),
    ]) {
      const cf = mockCfApi();
      const seeded = [
        { type: 'service', name: 'SCANNER', service: 'their-controller' },
        ...(marker === undefined
          ? []
          : [{ type: 'plain_text', name: '__VOID_SECURITY_SCANNER_OWNER', text: marker }]),
      ];
      cf.seedHostScript({ scriptName: names.gate, bindings: seeded });
      const error = await provisionSecurityScanner(target).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SecurityScannerError);
      expect(error).toMatchObject({ kind: 'ownership' });
      // The controller may be created, but the gate is never replaced.
      const gateUploads = (await uploads(cf)).filter((upload) =>
        upload.url.includes(`/scripts/${names.gate}`),
      );
      expect(gateUploads).toEqual([]);
    }
  });

  it('updates its own gate when it points at an old controller', async () => {
    const cf = mockCfApi();
    const names = await securityScannerNames(target.installationKey);
    await provisionSecurityScanner(target);
    const gate = cf.state.hostScripts.get(names.gate)!;
    gate.bindings = gate.bindings.map((binding) =>
      binding.name === 'SCANNER' ? { ...binding, service: 'old-controller' } : binding,
    );
    const before = (await uploads(cf)).length;
    await provisionSecurityScanner(target);
    const update = (await uploads(cf)).slice(before);
    expect(update.map((upload) => upload.url)).toEqual([
      expect.stringContaining(`/scripts/${names.gate}`),
    ]);
  });

  it('names the missing Containers access before anything is created', async () => {
    const cf = mockCfApi({
      listContainerApps: () =>
        Response.json(
          { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
          { status: 403 },
        ),
    });
    await expect(provisionSecurityScanner(target)).rejects.toMatchObject({
      kind: 'containers_unavailable',
    });
    expect(await uploads(cf)).toEqual([]);
  });

  it('two installations in one account get different names', async () => {
    const a = await securityScannerNames('inst_a');
    const b = await securityScannerNames('inst_b');
    expect(a.worker).not.toBe(b.worker);
    expect(a.application).not.toBe(b.application);
    expect(a.gate).not.toBe(b.gate);
    expect(a.worker.length).toBeLessThanOrEqual(63);
  });

  it('deletes the gate, then the container application, then the controller', async () => {
    const cf = mockCfApi();
    const names = await securityScannerNames(target.installationKey);
    const { applicationId } = await provisionSecurityScanner(target);
    cf.state.recordedCalls.length = 0;
    await deleteSecurityScanner(target);
    cf.expectCallOrder(
      { method: 'DELETE', url: `/dispatch/namespaces/void-users-test/scripts/${names.gate}` },
      { method: 'DELETE', url: `/containers/applications/${applicationId}` },
      { method: 'DELETE', url: `/workers/scripts/${names.worker}` },
    );
    expect(cf.state.containerApps.size).toBe(0);
    expect(cf.state.hostScripts.has(names.worker)).toBe(false);
    // Nothing left: a second delete is a no-op.
    await deleteSecurityScanner(target);
  });

  it('leaves a container application alone when its controller is gone', async () => {
    const cf = mockCfApi();
    const names = await securityScannerNames(target.installationKey);
    cf.seedContainerApp({ name: names.application, namespaceId: 'ns-unknown' });
    await expect(deleteSecurityScanner(target)).rejects.toMatchObject({ kind: 'ownership' });
    expect(cf.state.containerApps.size).toBe(1);
  });
});
