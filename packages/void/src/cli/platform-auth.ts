import { runCloudflareAuthCommand, type CloudflareAuthRunner } from './cloudflare-auth.ts';
import {
  PlatformCloudflareApiError,
  type CloudflareAccount,
  type PlatformCloudflareClient,
} from './platform-cloudflare.ts';
import { planCreatesZone, planWritesDns } from './platform-plan-writes.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

export type PlatformCloudflareCredential = Readonly<{
  source: 'environment' | 'saved' | 'oauth';
  token: string;
}>;

export type PlatformCloudflareAuthDependencies = Readonly<{
  interactive?: boolean;
  runWrangler?: CloudflareAuthRunner;
  /** Account management authority recovered for the selected installation. */
  savedManagementToken?: string;
}>;

export type PlatformManagementAccess = Readonly<{
  protection: boolean;
  readOnly: boolean;
}>;

/** Use the selected credential for read-only checks before taking lifecycle locks. */
export async function verifyPlatformCloudflareCredential(
  client: Pick<PlatformCloudflareClient, 'listAccounts' | 'listWorkerNames' | 'request'>,
  input: {
    account: CloudflareAccount;
    source: PlatformCloudflareCredential['source'];
    r2Buckets: ReadonlyArray<string>;
    allowMissingR2Buckets?: boolean;
  },
): Promise<void> {
  const source =
    input.source === 'saved'
      ? 'saved management token'
      : input.source === 'environment'
        ? 'environment API token'
        : 'Cloudflare browser login';
  const retry =
    input.source === 'oauth'
      ? 'Run `void cloudflare login`, or set CLOUDFLARE_API_TOKEN for this account, then retry.'
      : 'Set CLOUDFLARE_API_TOKEN for this account, then retry.';
  const check = async (
    label: string,
    permission: string,
    action: () => Promise<unknown>,
    allowMissing = false,
  ) => {
    try {
      await action();
    } catch (cause) {
      const status = cause instanceof PlatformCloudflareApiError ? cause.status : null;
      if (status === 404 && allowMissing) {
        return;
      }
      const detail =
        status === 401 || status === 403
          ? `Check that the credential is valid, scoped to this account, and includes ${permission}. ${retry}`
          : status === 404
            ? 'Check the bucket name and account scope before retrying.'
            : status === 429
              ? 'Cloudflare rate-limited this check. Retry shortly.'
              : 'Retry the command after Cloudflare connectivity is restored.';
      throw new Error(
        `platform: ${label} is unavailable${status === null ? '' : ` (HTTP ${status})`} using the ${source}. ${detail}`,
        { cause },
      );
    }
  };
  let accounts: ReadonlyArray<CloudflareAccount> = [];
  await check('Cloudflare account access', 'Account → Account Settings → Read', async () => {
    accounts = await client.listAccounts();
  });
  if (!accounts.some((account) => account.id === input.account.id)) {
    throw new Error(
      `platform: The ${source} cannot access Cloudflare account ${JSON.stringify(input.account.name)} (${input.account.id}). ${retry}`,
    );
  }
  await check('Cloudflare Workers access', 'Account → Workers Scripts → Edit', () =>
    client.listWorkerNames(input.account.id),
  );
  for (const name of new Set(input.r2Buckets)) {
    await check(
      `R2 bucket ${JSON.stringify(name)}`,
      'Account → Workers R2 Storage → Edit',
      () =>
        client.request(
          `/accounts/${encodeURIComponent(input.account.id)}/r2/buckets/${encodeURIComponent(name)}`,
        ),
      input.allowMissingR2Buckets,
    );
  }
}

/** Check Access inventory permissions before the installer starts provisioning. */
export async function verifyPlatformManagementAccess(
  client: Pick<PlatformCloudflareClient, 'request'>,
  accountId: string,
  access: PlatformManagementAccess,
): Promise<void> {
  const base = `/accounts/${encodeURIComponent(accountId)}/access`;
  await Promise.all([
    client.request(`${base}/organizations`),
    ...[
      'identity_providers',
      'groups',
      'policies',
      'apps',
      ...(access.protection ? ['service_tokens'] : []),
    ].map((resource) => client.request(`${base}/${resource}?per_page=1`)),
  ]);
}

export function assertPlatformOperatorCredentialCanApplyPlan(
  credential: PlatformCloudflareCredential,
  plan: Pick<PlatformInstallPlan, 'actions'>,
  access?: PlatformManagementAccess,
): void {
  if (!platformOperatorNeedsManagementToken(credential, plan, access)) {
    return;
  }
  const createsZone = planCreatesZone(plan);
  const writesDns = planWritesDns(plan);
  const permissions = [
    ...(createsZone ? ['Account → Zone → Edit'] : []),
    ...(writesDns ? ['Zone → DNS → Edit'] : []),
    ...(access
      ? [
          `Account → Access: Apps and Policies → ${access.readOnly ? 'Read' : 'Edit'}`,
          'Account → Access: Organizations, Identity Providers, and Groups → Read',
          ...(access.protection
            ? [`Account → Access: Service Tokens → ${access.readOnly ? 'Read' : 'Edit'}`]
            : []),
        ]
      : []),
  ];
  throw new Error(
    `platform: Cloudflare browser login cannot authorize the planned ${access ? 'Access setup' : 'zone or DNS changes'}. Set CLOUDFLARE_API_TOKEN with ${permissions.join(' and ')}, scoped to the selected account${createsZone || writesDns ? ' and application zone' : ''}, then rerun the command.`,
  );
}

export function platformOperatorNeedsManagementToken(
  credential: PlatformCloudflareCredential,
  plan: Pick<PlatformInstallPlan, 'actions'>,
  access?: PlatformManagementAccess,
): boolean {
  return (
    credential.source === 'oauth' && (!!access || planCreatesZone(plan) || planWritesDns(plan))
  );
}

export async function resolvePlatformCloudflareCredential(
  dependencies: PlatformCloudflareAuthDependencies = {},
): Promise<PlatformCloudflareCredential> {
  const { credential } = await resolvePlatformCloudflareCredentialWithInput(
    async () => undefined,
    dependencies,
  );
  return credential;
}

/** Check saved credentials during input, but never start browser login until it succeeds. */
export async function resolvePlatformCloudflareCredentialWithInput<T>(
  readInput: () => Promise<T>,
  dependencies: PlatformCloudflareAuthDependencies = {},
): Promise<Readonly<{ input: T; credential: PlatformCloudflareCredential }>> {
  const controller = new AbortController();
  const runner =
    dependencies.runWrangler ??
    ((args) => runCloudflareAuthCommand(process.cwd(), args, controller.signal));
  const runWrangler: CloudflareAuthRunner = (args, capture) => {
    controller.signal.throwIfAborted();
    return runner(args, capture);
  };
  // Handle failures immediately: a rejected background check must neither
  // interrupt the active prompt nor become an unhandled rejection.
  const pending = readExistingCredential(dependencies, runWrangler).then(
    (credential) => ({ ok: true as const, credential }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const cancel = () => controller.abort();
  const assertNotCancelled = () => {
    if (controller.signal.aborted) {
      throw new Error('platform: Cancelled.');
    }
  };
  try {
    const input = await readInput();
    // The prompt handles Ctrl+C while reading. Once it restores cooked input,
    // handle SIGINT ourselves so cancelling auth prints a useful message.
    process.once('SIGINT', cancel);
    const result = await pending;
    assertNotCancelled();
    if (!result.ok) {
      throw result.error;
    }
    if (result.credential) {
      return { input, credential: result.credential };
    }

    const login = await runWrangler({ type: 'auth.login' }, false);
    assertNotCancelled();
    if (login.status !== 0 || login.signal || login.error) {
      throw new Error('platform: Cloudflare browser login did not complete.');
    }
    const credential = await readWranglerOAuthCredential(runWrangler);
    assertNotCancelled();
    if (!credential) {
      throw new Error('platform: Cloudflare sign-in completed without a usable OAuth credential.');
    }
    return { input, credential };
  } finally {
    process.removeListener('SIGINT', cancel);
    // Cancelling the input also stops the child process. The background work
    // cannot launch a browser, even if it settles after this function exits.
    controller.abort();
  }
}

async function readExistingCredential(
  dependencies: PlatformCloudflareAuthDependencies,
  runWrangler: CloudflareAuthRunner,
): Promise<PlatformCloudflareCredential | null> {
  const environmentToken =
    process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim() || '';
  if (environmentToken) {
    return { source: 'environment', token: environmentToken };
  }
  const savedManagementToken = dependencies.savedManagementToken?.trim();
  if (savedManagementToken) {
    return { source: 'saved', token: savedManagementToken };
  }

  if (!(dependencies.interactive ?? process.stdin.isTTY === true)) {
    throw new Error(
      'platform: Cloudflare authentication is required. Run `void cloudflare login` interactively, or set CLOUDFLARE_API_TOKEN in CI.',
    );
  }
  return await readWranglerOAuthCredential(runWrangler);
}

export async function readWranglerOAuthCredential(
  runWrangler: CloudflareAuthRunner,
): Promise<PlatformCloudflareCredential | null> {
  const result = await runWrangler({ type: 'auth.token' }, true);
  if (result.status !== 0 || result.signal || result.error) {
    return null;
  }
  const parsed = result.data as { token?: unknown; type?: unknown } | undefined;
  if (
    !parsed ||
    parsed.type !== 'oauth' ||
    typeof parsed.token !== 'string' ||
    !parsed.token.trim()
  ) {
    return null;
  }
  return { source: 'oauth', token: parsed.token.trim() };
}
