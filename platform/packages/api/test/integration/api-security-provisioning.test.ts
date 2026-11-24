import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { ensureSecurityScannerImage } from '../../src/provisioning/security-scanner-images.ts';
import {
  deleteSecurityScanner,
  provisionSecurityScanner,
  securityScannerNames,
  SECURITY_SCANNER_CLASS,
  SECURITY_SCANNER_ENGINE_BINDING,
  SECURITY_SCANNER_ENGINE_CLASS,
  SECURITY_SCANNER_IMAGES_BINDING,
  SecurityScannerError,
  verifySecurityScanner,
} from '../../src/provisioning/security-scanner.ts';
import type { SecurityScannerTarget } from '../../src/provisioning/security-scanner.ts';
import { createFakeRegistry, fakeImage } from '../__mocks__/image-registry.ts';
import { mockCfApiRealDispatchScripts as cloudflare, setupEnv, teardownEnv } from './helpers.ts';
import type { MockCfApiHandle, TestEnv } from './helpers.ts';

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
    const cf = cloudflare();
    const names = await securityScannerNames(target.installationKey);
    const { applicationId } = await provisionSecurityScanner(target);

    const [sandbox, controller, gate, ...rest] = await uploads(cf);
    expect(rest).toEqual([]);
    // The runtime copy side (M30) comes first: its namespace and its sandbox Worker.
    expect(
      cf.mock.calls.map(
        ([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`,
      ),
    ).toContainEqual(expect.stringMatching(/^POST .*\/workers\/dispatch\/namespaces$/));
    expect(sandbox!.url).toContain(`/workers/scripts/${names.copySandbox}`);
    expect(controller!.url).toContain(`/workers/scripts/${names.worker}`);
    expect(controller!.headers.get('If-None-Match')).toBe('*');
    const metadata = controller!.metadata as {
      bindings: Array<Record<string, unknown>>;
      migrations: unknown;
      containers: unknown;
    };
    expect(metadata.migrations).toEqual({
      new_tag: 'v1',
      steps: [
        {
          new_sqlite_classes: [
            SECURITY_SCANNER_CLASS,
            SECURITY_SCANNER_ENGINE_CLASS.agent_sdk,
            SECURITY_SCANNER_ENGINE_CLASS.codex_sdk,
          ],
        },
      ],
    });
    // No engine image is ready: only Engine B has a container application.
    expect(metadata.containers).toEqual([
      { class_name: SECURITY_SCANNER_CLASS, name: names.application, images: {} },
    ]);
    expect(metadata.bindings).toContainEqual({
      type: 'plain_text',
      name: SECURITY_SCANNER_IMAGES_BINDING,
      text: '{}',
    });
    for (const engine of ['agent_sdk', 'codex_sdk'] as const) {
      expect(metadata.bindings).toContainEqual({
        type: 'durable_object_namespace',
        name: SECURITY_SCANNER_ENGINE_BINDING[engine],
        class_name: SECURITY_SCANNER_ENGINE_CLASS[engine],
      });
    }
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
    ).toEqual([
      {
        type: 'dispatch_namespace',
        name: '__VOID_SECURITY_COPIES',
        namespace: names.copyNamespace,
        outbound: { worker: { service: names.copySandbox } },
      },
    ]);

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
    const cf = cloudflare();
    const first = await provisionSecurityScanner(target);
    const before = (await uploads(cf)).length;
    const second = await provisionSecurityScanner(target);
    expect(second.applicationId).toBe(first.applicationId);
    expect((await uploads(cf)).length).toBe(before);
    expect(cf.state.containerApps.size).toBe(1);
  });

  it('re-uploads a controller from another release without repeating its migration', async () => {
    const cf = cloudflare();
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
    const cf = cloudflare();
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
      const cf = cloudflare();
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
    const cf = cloudflare();
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
    const cf = cloudflare({
      listContainerApps: () =>
        Response.json(
          { success: false, errors: [{ code: 10_000, message: 'Authentication error' }] },
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
    expect(a.engines.agent_sdk.application).not.toBe(b.engines.agent_sdk.application);
    expect(a.worker.length).toBeLessThanOrEqual(63);
    for (const names of [a.engines.agent_sdk, a.engines.codex_sdk]) {
      expect(names.application.length).toBeLessThanOrEqual(63);
      // No vendor name in an operator-visible resource name (spec §8.2).
      expect(names.application).not.toMatch(/claude|codex|anthropic|openai/);
    }
  });

  it('gives each ready engine image its own class and container application', async () => {
    const cf = cloudflare();
    const names = await securityScannerNames(target.installationKey);
    await provisionSecurityScanner(target);
    const before = (await uploads(cf)).length;
    const ref = `registry.cloudflare.com/${target.accountId}/${names.engines.agent_sdk.repository}@sha256:${'a'.repeat(64)}`;
    const result = await provisionSecurityScanner(target, { agent_sdk: ref });

    const [update, ...rest] = (await uploads(cf)).slice(before);
    expect(rest).toEqual([]);
    // Same classes, so the tag stays.
    expect(update!.metadata.migrations).toBeUndefined();
    expect(update!.metadata.containers).toEqual([
      { class_name: SECURITY_SCANNER_CLASS, name: names.application, images: {} },
      {
        class_name: SECURITY_SCANNER_ENGINE_CLASS.agent_sdk,
        name: names.engines.agent_sdk.application,
        images: { default: ref },
      },
    ]);
    expect(update!.metadata.bindings).toContainEqual({
      type: 'plain_text',
      name: SECURITY_SCANNER_IMAGES_BINDING,
      text: JSON.stringify({ agent_sdk: ref }),
    });
    const app = cf.state.containerApps.get(result.engineApplicationIds.agent_sdk!);
    expect(app?.name).toBe(names.engines.agent_sdk.application);
    expect(app?.durable_objects?.namespace_id).toBe(
      cf.state.hostScripts.get(names.worker)?.classes.get(SECURITY_SCANNER_ENGINE_CLASS.agent_sdk),
    );
    expect(result.engineApplicationIds.codex_sdk).toBeUndefined();
    expect(cf.state.containerApps.size).toBe(2);
    await verifySecurityScanner(target, { agent_sdk: ref });
    // The controller holds that image now; without it, it is outdated.
    await expect(verifySecurityScanner(target)).rejects.toMatchObject({ kind: 'outdated' });

    // Same images again: nothing is uploaded or created.
    const settled = (await uploads(cf)).length;
    await provisionSecurityScanner(target, { agent_sdk: ref });
    expect((await uploads(cf)).length).toBe(settled);
    expect(cf.state.containerApps.size).toBe(2);
  });

  it('keeps a deployed engine image at the current pin when this run did not ready it', async () => {
    const cf = cloudflare();
    const names = await securityScannerNames(target.installationKey);
    const ref = (hex: string) =>
      `registry.cloudflare.com/${target.accountId}/${names.engines.agent_sdk.repository}@sha256:${hex.repeat(64)}`;
    await provisionSecurityScanner(target, { agent_sdk: ref('a') });
    const before = (await uploads(cf)).length;
    // A probe whose copy step failed this time: nothing is uploaded, the engine stays.
    const kept = await provisionSecurityScanner(target, {}, { keep: { agent_sdk: ref('a') } });
    expect((await uploads(cf)).length).toBe(before);
    expect(kept.images).toEqual({ agent_sdk: ref('a') });
    expect(kept.engineApplicationIds.agent_sdk).toBeDefined();

    // A new release pin: the old image leaves the controller.
    const moved = await provisionSecurityScanner(target, {}, { keep: { agent_sdk: ref('b') } });
    expect(moved.images).toEqual({});
    const update = (await uploads(cf)).at(-1)!;
    expect(update.metadata.containers).toEqual([
      { class_name: SECURITY_SCANNER_CLASS, name: names.application, images: {} },
    ]);
  });

  it('uploads again when another probe drops this probe’s image in between', async () => {
    const cf = cloudflare();
    const names = await securityScannerNames(target.installationKey);
    await provisionSecurityScanner(target);
    const ref = `registry.cloudflare.com/${target.accountId}/${names.engines.codex_sdk.repository}@sha256:${'c'.repeat(64)}`;
    let raced = false;
    const next = cf as unknown as typeof fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const response = await next(input, init);
      if (!raced && init?.method === 'PUT' && String(input).endsWith(`/scripts/${names.worker}`)) {
        // The other probe's upload (no engine images) lands right after ours.
        raced = true;
        const images = cf.state.hostScripts
          .get(names.worker)!
          .bindings.find((binding) => binding.name === SECURITY_SCANNER_IMAGES_BINDING)!;
        images.text = '{}';
      }
      return response;
    });
    const before = (await uploads(cf)).length;
    const result = await provisionSecurityScanner(target, { codex_sdk: ref });
    expect(raced).toBe(true);
    expect((await uploads(cf)).length - before).toBe(2);
    expect(result.images).toEqual({ codex_sdk: ref });
    await verifySecurityScanner(target, { codex_sdk: ref });
  });

  it('adds the engine classes to a controller from before engine images', async () => {
    const cf = cloudflare();
    const names = await securityScannerNames(target.installationKey);
    await provisionSecurityScanner(target);
    // An M6 controller: only the Engine B class and binding.
    const script = cf.state.hostScripts.get(names.worker)!;
    script.bindings = script.bindings.filter(
      (binding) => binding.type !== 'durable_object_namespace' || binding.name === 'SCANNER',
    );
    const before = (await uploads(cf)).length;
    await provisionSecurityScanner(target);
    const update = (await uploads(cf)).slice(before)[0]!;
    expect(update.headers.get('If-None-Match')).toBeNull();
    expect(update.metadata.migrations).toEqual({
      old_tag: 'v1',
      new_tag: 'v2',
      steps: [
        {
          new_sqlite_classes: [
            SECURITY_SCANNER_ENGINE_CLASS.agent_sdk,
            SECURITY_SCANNER_ENGINE_CLASS.codex_sdk,
          ],
        },
      ],
    });
    await verifySecurityScanner(target);
  });

  it('deletes the gate, the container applications, the controller, then the copied images', async () => {
    const cf = cloudflare();
    const image = fakeImage();
    const registry = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-c': image },
    });
    vi.stubGlobal('fetch', registry.fetch(cf as unknown as typeof fetch));
    const names = await securityScannerNames(target.installationKey);
    const copied = await ensureSecurityScannerImage(
      target,
      {
        engine: 'codex_sdk',
        repository: 'ghcr.io/voidzero-dev/void-security-scanner-engine-c',
        digest: image.digest,
      },
      names.engines.codex_sdk.repository,
      { deadline: Date.now() + 60_000 },
    );
    expect(copied.ok).toBe(true);
    const { applicationId, engineApplicationIds } = await provisionSecurityScanner(target, {
      codex_sdk: copied.ok ? copied.ref : '',
    });
    cf.state.recordedCalls.length = 0;
    registry.calls.length = 0;
    await deleteSecurityScanner(target);
    cf.expectCallOrder(
      { method: 'DELETE', url: `/dispatch/namespaces/void-users-test/scripts/${names.gate}` },
      { method: 'DELETE', url: `/containers/applications/${applicationId}` },
      { method: 'DELETE', url: `/containers/applications/${engineApplicationIds.codex_sdk}` },
      { method: 'DELETE', url: `/workers/scripts/${names.worker}` },
    );
    expect(cf.state.containerApps.size).toBe(0);
    // The runtime copy side goes too (M30): its namespace and its sandbox Worker.
    cf.expectCallOrder(
      { method: 'DELETE', url: `/workers/dispatch/namespaces/${names.copyNamespace}` },
      { method: 'DELETE', url: `/workers/scripts/${names.copySandbox}` },
    );
    expect(cf.state.hostScripts.has(names.copySandbox)).toBe(false);
    expect(cf.state.hostScripts.has(names.worker)).toBe(false);
    expect(
      registry.hasManifest(
        `${target.accountId}/${names.engines.codex_sdk.repository}`,
        image.digest,
      ),
    ).toBe(false);
    expect(registry.calls).toContain('PUT cf/v2/gc/layers');
    // Nothing left: a second delete is a no-op.
    await deleteSecurityScanner(target);
  });

  it('removes the copied images on a retry after the image cleanup failed', async () => {
    const cf = cloudflare();
    const image = fakeImage();
    const registry = createFakeRegistry({
      published: { 'voidzero-dev/void-security-scanner-engine-c': image },
    });
    let refuseList = true;
    const next = registry.fetch(cf as unknown as typeof fetch);
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (refuseList && url.endsWith('/tags/list')) {
        return new Response(null, { status: 503 });
      }
      return next(input, init);
    });
    const names = await securityScannerNames(target.installationKey);
    const repository = `${target.accountId}/${names.engines.codex_sdk.repository}`;
    const copied = await ensureSecurityScannerImage(
      target,
      {
        engine: 'codex_sdk',
        repository: 'ghcr.io/voidzero-dev/void-security-scanner-engine-c',
        digest: image.digest,
      },
      names.engines.codex_sdk.repository,
      { deadline: Date.now() + 60_000 },
    );
    await provisionSecurityScanner(target, { codex_sdk: copied.ok ? copied.ref : '' });
    await expect(deleteSecurityScanner(target)).rejects.toThrow('(HTTP 503)');
    // The controller is gone, the image is still stored.
    expect(cf.state.hostScripts.has(names.worker)).toBe(false);
    expect(registry.hasManifest(repository, image.digest)).toBe(true);

    refuseList = false;
    await deleteSecurityScanner(target);
    expect(registry.hasManifest(repository, image.digest)).toBe(false);
  });

  it('leaves a container application alone when its controller is gone', async () => {
    const cf = cloudflare();
    const names = await securityScannerNames(target.installationKey);
    cf.seedContainerApp({ name: names.application, namespaceId: 'ns-unknown' });
    await expect(deleteSecurityScanner(target)).rejects.toMatchObject({ kind: 'ownership' });
    expect(cf.state.containerApps.size).toBe(1);
  });
});
