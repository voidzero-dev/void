import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { writeLocalDatabaseUrl } from '../../src/cli/db.ts';
import { createNeonDatabaseProvider } from '../../src/database-providers/neon.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('database provider adapters', () => {
  it('provisions Neon projects and returns the generated connection string', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        project: { id: 'project-123' },
        connection_uris: [{ connection_uri: 'postgresql://user:pass@host/app?sslmode=require' }],
      }),
    );
    const adapter = createNeonDatabaseProvider({
      apiKey: 'test-key',
      apiBaseUrl: 'https://neon.example/v2',
      fetch: fetchMock,
    });

    const result = await adapter.provision({
      name: 'my-app',
      dialect: 'postgresql',
      region: 'aws-us-east-1',
    });

    expect(result.connectionString).toBe('postgresql://user:pass@host/app?sslmode=require');
    expect(result.dashboardUrl).toContain('project-123');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://neon.example/v2/projects',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        body: JSON.stringify({ project: { name: 'my-app', region_id: 'aws-us-east-1' } }),
      }),
    );
  });

  it('updates DATABASE_URL without discarding other local env values', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-db-connect-'));
    roots.push(root);
    writeFileSync(join(root, '.env'), 'API_KEY=test\nDATABASE_URL="old"\n');

    writeLocalDatabaseUrl(root, 'postgresql://user:p@ss@host/app');

    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
      'API_KEY=test\nDATABASE_URL="postgresql://user:p@ss@host/app"\n',
    );
  });
});
