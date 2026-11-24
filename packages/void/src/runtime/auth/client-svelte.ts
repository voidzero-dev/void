import { createAuthClient as createBetterAuthClient } from 'better-auth/svelte';

export const createAuthClient: typeof createBetterAuthClient = createBetterAuthClient;
type BetterAuthClientInstance = ReturnType<typeof createAuthClient>;
export const auth: BetterAuthClientInstance = createBetterAuthClient({ basePath: '/api/auth' });
