import { defineDatabaseProvider } from '../database-provider.ts';
import type { DatabaseProviderAdapter, DatabaseProvisionResult } from '../database-provider.ts';

type NeonProviderOptions = {
  apiKey?: string;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

function getConnectionString(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct = record.connection_uri ?? record.connectionString;
  if (typeof direct === 'string') {
    return direct;
  }
  if (Array.isArray(record.connection_uris)) {
    for (const item of record.connection_uris) {
      const result = getConnectionString(item);
      if (result) {
        return result;
      }
    }
  }
  return undefined;
}

export function createNeonDatabaseProvider(
  options: NeonProviderOptions = {},
): DatabaseProviderAdapter {
  const apiKey = options.apiKey ?? process.env.NEON_API_KEY;
  const apiBaseUrl = options.apiBaseUrl ?? 'https://console.neon.tech/api/v2';
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return defineDatabaseProvider({
    id: 'neon',
    label: 'Neon',
    dialects: ['postgresql'],
    async provision(input): Promise<DatabaseProvisionResult> {
      if (!apiKey) {
        throw new Error('NEON_API_KEY is required to provision a Neon database.');
      }
      if (input.dialect !== 'postgresql') {
        throw new Error('Neon provisions PostgreSQL databases only.');
      }

      const response = await fetchImpl(`${apiBaseUrl}/projects`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project: {
            name: input.name,
            ...(input.region ? { region_id: input.region } : {}),
          },
        }),
        signal: input.signal,
      });
      const payload = (await response.json().catch(() => undefined)) as
        | Record<string, unknown>
        | undefined;
      if (!response.ok) {
        const message =
          typeof payload?.message === 'string'
            ? payload.message
            : `${response.status} ${response.statusText}`.trim();
        throw new Error(`Neon provisioning failed: ${message}`);
      }

      const connectionString = getConnectionString(payload);
      if (!connectionString) {
        throw new Error('Neon created the project but did not return a connection string.');
      }
      const project = payload?.project as Record<string, unknown> | undefined;
      const projectId = typeof project?.id === 'string' ? project.id : undefined;
      return {
        connectionString,
        dashboardUrl: projectId ? `https://console.neon.tech/app/projects/${projectId}` : undefined,
      };
    },
  });
}
