import { createPlatformDeploymentManifest } from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';
import { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import {
  assertPlatformRuntimeLogsSupported,
  projectWorkerObservability,
  shouldUpdateProjectWorkerRuntimeLogs,
  updateProjectWorkerRuntimeLogs,
  type PlatformRuntimeLogsClient,
} from '../../src/cli/platform-runtime-logs.ts';

const full = createPlatformDeploymentManifest({
  application: { baseDomain: 'example.com', zoneName: 'example.com' },
  displayName: 'Example',
  installationSlug: 'example',
});
const minimal = createPlatformDeploymentManifest({
  application: { baseDomain: 'example.com', zoneName: 'example.com' },
  displayName: 'Example',
  installationSlug: 'example',
  runtimeLogs: 'minimal',
});

function fakeClient(scripts: ReadonlyArray<string>, failing: ReadonlySet<string> = new Set()) {
  const patched: Array<{ script: string; settings: unknown }> = [];
  let active = 0;
  let peak = 0;
  const client: PlatformRuntimeLogsClient = {
    listDispatchNamespaceScripts: async (accountId, namespace) => {
      expect([accountId, namespace]).toEqual(['account', 'example-users']);
      return scripts;
    },
    patchDispatchNamespaceScriptSettings: async (_accountId, _namespace, script, settings) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (failing.has(script)) {
        throw new Error('rate limited');
      }
      patched.push({ script, settings });
    },
  };
  return { client, patched, peak: () => peak };
}

const target = { accountId: 'account', namespace: 'example-users', installationId: 'example-1' };

describe('project Worker runtime logs', () => {
  it('matches the observability the API uploads', () => {
    expect(projectWorkerObservability(true)).toEqual({ enabled: false });
    expect(projectWorkerObservability(false)).toEqual({
      enabled: true,
      logs: { invocation_logs: true, head_sampling_rate: 1 },
    });
  });

  it('updates only project Workers, a few at a time', async () => {
    const scripts = [
      ...Array.from({ length: 9 }, (_, index) => `user-app-dpl${index}`),
      'void-do-project1-0123456789abcdef',
    ];
    const fake = fakeClient([...scripts, 'other-script']);
    const warning = await updateProjectWorkerRuntimeLogs(fake.client, { ...target, minimal: true });
    expect(warning).toBeUndefined();
    expect(fake.patched.map((entry) => entry.script).sort()).toEqual(scripts);
    expect(fake.patched[0]!.settings).toEqual({ observability: { enabled: false } });
    expect(fake.peak()).toBeLessThanOrEqual(4);

    const back = fakeClient(['user-app-dpl0']);
    await updateProjectWorkerRuntimeLogs(back.client, { ...target, minimal: false });
    expect(back.patched[0]!.settings).toEqual({
      observability: { enabled: true, logs: { invocation_logs: true, head_sampling_rate: 1 } },
    });
  });

  it('returns a warning instead of failing', async () => {
    const fake = fakeClient(['user-a-1', 'user-b-1'], new Set(['user-b-1']));
    expect(await updateProjectWorkerRuntimeLogs(fake.client, { ...target, minimal: true })).toBe(
      'Could not update the Workers Logs setting of 1 project Worker (user-b-1). Run `void platform repair example-1` to finish.',
    );
    expect(fake.patched.map((entry) => entry.script)).toEqual(['user-a-1']);

    const off = fakeClient(['user-b-1'], new Set(['user-b-1']));
    expect(await updateProjectWorkerRuntimeLogs(off.client, { ...target, minimal: false })).toBe(
      'Could not update the Workers Logs setting of 1 project Worker (user-b-1). Run `void platform upgrade example-1 --runtime-logs full` again to finish.',
    );

    const listing: PlatformRuntimeLogsClient = {
      listDispatchNamespaceScripts: async () => {
        throw new Error('Cloudflare API error: forbidden.');
      },
      patchDispatchNamespaceScriptSettings: async () => {},
    };
    expect(await updateProjectWorkerRuntimeLogs(listing, { ...target, minimal: true })).toBe(
      'Could not list project Workers to update their Workers Logs setting: Cloudflare API error: forbidden. Run `void platform repair example-1` to finish.',
    );
  });

  it('runs while minimal, when the mode changes, or when the flag is given', () => {
    const check = (previous: typeof full | null, next: typeof full, explicit = false) =>
      shouldUpdateProjectWorkerRuntimeLogs({ previous, next, explicit });
    expect(check(full, minimal)).toBe(true);
    expect(check(minimal, full)).toBe(true);
    // An earlier run may have stopped before this step.
    expect(check(minimal, minimal)).toBe(true);
    expect(check(full, full)).toBe(false);
    expect(check(full, full, true)).toBe(true);
    expect(check(null, full)).toBe(false);
  });

  it('requires a runtime that honours minimal runtime logs', () => {
    expect(() => assertPlatformRuntimeLogsSupported(minimal, {})).toThrow(
      'This platform runtime cannot keep runtime logs minimal',
    );
    expect(() => assertPlatformRuntimeLogsSupported(minimal, { runtimeLogs: 1 })).not.toThrow();
    expect(() => assertPlatformRuntimeLogsSupported(full, {})).not.toThrow();
  });

  it('sends the settings as a multipart part without replacing bindings', async () => {
    let seen: { url: string; method?: string; type: string | null; part: unknown } | undefined;
    const client = new PlatformCloudflareClient('token', {
      apiBase: 'https://cloudflare.example.test/client/v4',
      fetcher: async (input, init) => {
        const body = init?.body as FormData;
        const part = body.get('settings') as Blob;
        seen = {
          url: String(input),
          method: init?.method,
          type: new Headers(init?.headers).get('content-type'),
          part: { type: part.type, value: JSON.parse(await part.text()) },
        };
        return Response.json({ success: true, result: {} });
      },
    });
    await client.patchDispatchNamespaceScriptSettings('account', 'example-users', 'user-a-1', {
      observability: { enabled: false },
    });
    expect(seen).toEqual({
      url: 'https://cloudflare.example.test/client/v4/accounts/account/workers/dispatch/namespaces/example-users/scripts/user-a-1/settings',
      method: 'PATCH',
      type: null,
      part: { type: 'application/json', value: { observability: { enabled: false } } },
    });
  });
});
