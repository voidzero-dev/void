import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformClient } from '../../src/cli/client.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const fetchMock = vi.fn<typeof fetch>();
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = withPlatformDiscovery(fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(): PlatformClient {
  return new PlatformClient('test-token', { apiUrl: 'https://api.example.test' });
}

const project = { id: 'proj_1', slug: 'my-app', role: 'collaborator' };

describe('targeted project lookup', () => {
  it('lists interactive choices without requesting deployment and traffic summaries', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([project]));
    await expect(client().listProjectChoices()).resolves.toEqual([project]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/projects/choices',
    ]);
  });

  it('resolves a slug without loading the project list', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ project }));

    await expect(client().findProjectBySlug('my app')).resolves.toEqual(project);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.test/projects/resolve?slug=my+app',
    );
  });

  it('returns null for a missing slug', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ project: null }));
    await expect(client().findProjectBySlug('missing')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['listProjectChoices', 'findProjectBySlug'] as const)(
    'reports a 404 from %s as an API error',
    async (method) => {
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'not found' }, { status: 404 }));
      const api = client();
      await expect(
        method === 'findProjectBySlug' ? api.findProjectBySlug('my-app') : api.listProjectChoices(),
      ).rejects.toMatchObject({ name: 'PlatformApiError', status: 404 });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('loads a linked project by ID and treats 404 as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(project));
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'not found' }, { status: 404 }));

    const api = client();
    await expect(api.getProject('proj_1')).resolves.toEqual(project);
    await expect(api.getProject('missing')).resolves.toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/projects/proj_1',
      'https://api.example.test/projects/missing',
    ]);
  });
});
