import { randomBytes } from 'node:crypto';

export const STAGING_API = 'https://api.staging.void.cloud';
const PROJECT_SLUG = 'kitchen-sink';

type Secret = { name: string; value: string };
type Client = {
  apiUrl: string;
  listProjects(): Promise<Array<{ id: string; slug: string }>>;
  listSecrets(projectId: string): Promise<Array<{ name: string }>>;
  setSecret(projectId: string, name: string, value: string): Promise<unknown>;
};

function isStoredSecretError(error: unknown, name: string): boolean {
  if (
    !(error instanceof Error) ||
    error.name !== 'PlatformApiError' ||
    !('status' in error) ||
    error.status !== 502 ||
    !('body' in error) ||
    typeof error.body !== 'string'
  ) {
    return false;
  }
  try {
    const body = JSON.parse(error.body) as {
      error?: unknown;
      name?: unknown;
      liveUpdated?: unknown;
    };
    return (
      body?.error === 'secret stored but live propagation failed' &&
      body.name === name &&
      body.liveUpdated === false
    );
  } catch {
    return false;
  }
}

/** Fill only missing staging fixture values; never import a developer's .env. */
export async function initializeStagingEnv(
  client: Client,
  validate: (entries: Array<Secret>) => Promise<void>,
  onStep: (step: string) => void = () => {},
): Promise<Array<string>> {
  onStep('checking the staging API');
  if (client.apiUrl !== STAGING_API) {
    throw new Error('Kitchen-sink fixture setup requires the staging API.');
  }
  onStep('listing projects');
  const projects = (await client.listProjects()).filter((project) => project.slug === PROJECT_SLUG);
  onStep('selecting the kitchen-sink project');
  if (projects.length !== 1) {
    throw new Error(
      'Kitchen-sink fixture setup requires exactly one existing kitchen-sink project.',
    );
  }
  const projectId = projects[0].id;
  onStep('listing secret names');
  const existing = new Set((await client.listSecrets(projectId)).map((secret) => secret.name));
  const entries: Array<Secret> = [];
  for (const name of ['APP_NAME', 'SECRET_KEY', 'API_URL']) {
    if (!existing.has(name)) {
      entries.push({
        name,
        value:
          name === 'SECRET_KEY'
            ? Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('')
            : name === 'APP_NAME'
              ? 'Kitchen Sink'
              : 'https://api.example.com',
      });
    }
  }
  if (entries.length === 0) {
    return [];
  }
  // Validate the whole batch before any write, like `void secret sync`.
  onStep('validating env.ts');
  await validate(entries);
  for (const { name, value } of entries) {
    onStep(`setting ${name}`);
    try {
      await client.setSecret(projectId, name, value);
    } catch (error) {
      if (!isStoredSecretError(error, name)) {
        throw error;
      }
      // The API persisted the value before attempting to update the old worker.
      // This fixture is deployed immediately afterward with all stored secrets.
      // Verify persistence without retrying the write or logging its response.
      onStep(`verifying stored ${name}`);
      if (!(await client.listSecrets(projectId)).some((secret) => secret.name === name)) {
        throw error;
      }
    }
  }
  return entries.map(({ name }) => name);
}
