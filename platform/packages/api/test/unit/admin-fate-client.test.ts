import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FateClient, view } from 'react-fate';
import { expect, it, vi } from 'vite-plus/test';
import {
  createAdminFateClient,
  type AdminFateClient,
  type AdminDeploymentDetail,
} from '../../src/admin/fate/client.ts';
import {
  DeploymentLogSettingsView,
  healthRequest,
  UserSuggestionsView,
} from '../../src/admin/fate/views.ts';
import { SystemStatusCard } from '../../src/admin/react/views/SystemStatusCard.tsx';

function write(client: AdminFateClient, type: string, data: Record<string, unknown>) {
  client.write(type, data, new Set(Object.keys(data)));
}

it('renders cached health on the first render without a loading flash or another request', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    const { operations } = JSON.parse(String(init?.body)) as { operations: Array<{ id: string }> };
    return Response.json({
      version: 1,
      results: operations.map(({ id }: { id: string }) => ({
        id,
        ok: true,
        data: {
          id: 'health',
          allOk: true,
          checks: [{ name: 'api', ok: true, latencyMs: 1 }],
          checkedAt: Date.now(),
        },
      })),
    });
  });
  const client = createAdminFateClient({ url: 'http://localhost/admin/fate', fetch });
  await client.request(healthRequest);
  const props = { client, children: createElement(SystemStatusCard, { checkNames: ['api'] }) };
  const markup = renderToStaticMarkup(createElement(FateClient, props));
  expect(markup).toContain('data-state="healthy"');
  expect(markup).not.toContain('data-state="loading"');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps log controls per deployment through server writes and hydration, within one client session', async () => {
  const create = () => createAdminFateClient({ url: 'http://localhost/admin/fate' });
  const client = create();
  const id = '/admin/deployments/first';
  write(client, 'AdminDeploymentDetail', { id, manifest: null });
  const ref = client.ref('AdminDeploymentDetail', id, DeploymentLogSettingsView);
  expect(client.peekView(DeploymentLogSettingsView, ref)?.data).toMatchObject({
    logRange: '1h',
    logLimit: 100,
    logFilter: '',
  });
  await client.mutations.deploymentLogs.configure({
    input: { id, logRange: '24h', logLimit: 200, logFilter: 'error' },
  });
  await client.mutations.deploymentLogs.configure({ input: { id, logFilter: 'warn' } });
  expect(client.peekView(DeploymentLogSettingsView, ref)?.data).toMatchObject({
    logRange: '24h',
    logLimit: 200,
    logFilter: 'warn',
  });
  await client.mutations.deploymentLogs.configure({ input: { id, logFilter: 'error' } });
  write(client, 'AdminDeploymentDetail', { id, manifest: { bindings: { kv: ['CACHE'] } } });
  expect(client.peekView(DeploymentLogSettingsView, ref)?.data).toMatchObject({
    logRange: '24h',
    logLimit: 200,
    logFilter: 'error',
  });
  write(client, 'AdminDeploymentDetail', { id: '/admin/deployments/second' });
  const second = client.ref(
    'AdminDeploymentDetail',
    '/admin/deployments/second',
    DeploymentLogSettingsView,
  );
  expect(client.peekView(DeploymentLogSettingsView, second)?.data.logRange).toBe('1h');
  const hydrated = create();
  hydrated.hydrate(client.dehydrate());
  expect(
    hydrated.peekView(
      DeploymentLogSettingsView,
      hydrated.ref('AdminDeploymentDetail', id, DeploymentLogSettingsView),
    )?.data.logFilter,
  ).toBe('error');
  const newSession = create();
  write(newSession, 'AdminDeploymentDetail', { id });
  expect(
    newSession.peekView(
      DeploymentLogSettingsView,
      newSession.ref('AdminDeploymentDetail', id, DeploymentLogSettingsView),
    )?.data.logFilter,
  ).toBe('');
});

it('shares memo results across views and recomputes them only when their data changes', async () => {
  const client = createAdminFateClient({ url: 'http://localhost/admin/fate' });
  const id = '/admin/deployments/one';
  const ManifestView = view<AdminDeploymentDetail>()({ manifestJson: true });
  write(client, 'AdminDeploymentDetail', { id, manifest: { bindings: { kv: ['CACHE'] } } });
  const ref = client.ref('AdminDeploymentDetail', id, ManifestView);
  expect(client.peekView(ManifestView, ref)?.data.manifestJson).toBe(
    JSON.stringify({ bindings: { kv: ['CACHE'] } }, null, 2),
  );
  const usersId = '/admin/users';
  write(client, 'AdminUsersPage', {
    id: usersId,
    users: [{ id: 'user', login: 'alice', email: 'alice@example.com' }],
  });
  const users = client.ref('AdminUsersPage', usersId, UserSuggestionsView);
  const suggestions = client.peekView(UserSuggestionsView, users)!.data.suggestions;
  expect(suggestions).toEqual([
    { id: 'user', label: 'alice', description: 'alice@example.com · user' },
  ]);
  expect((await client.readView(UserSuggestionsView, users)).data.suggestions).toBe(suggestions);
  write(client, 'AdminUsersPage', { id: usersId, tz: 'UTC' });
  expect(client.peekView(UserSuggestionsView, users)!.data.suggestions).toBe(suggestions);
  write(client, 'AdminUsersPage', {
    id: usersId,
    users: [{ id: 'user', login: 'updated', email: null }],
  });
  expect(client.peekView(UserSuggestionsView, users)!.data.suggestions[0]?.label).toBe('updated');
});
