import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { parsePlatformLoginConfiguration, parsePlatformAdmissionPolicy } from '@void/platform';
import type {
  PlatformLoginConfiguration,
  PlatformLoginKind,
  PlatformAdmissionPolicy,
} from '@void/platform';
import { confirm, multiselect, password, select, text } from '@voidzero-dev/vite-plus-prompts';
import { openBrowser } from './auth.ts';
import { readOperatorToken, resolveOperatorOrigin } from './operator-auth.ts';
import { OperatorClient } from './operator-client.ts';
import { humanLines } from './operator-cmd.ts';
import { printSuccess, formatUrl } from './output.ts';
import type { PlatformConfigArgs } from './platform-config-args.ts';
import { platformPromptAnswer } from './platform-setup.ts';

type Method = {
  id: string;
  label: string;
  enabled: boolean;
  revision: number;
  configuration: PlatformLoginConfiguration;
};
type Listing = {
  initialized: boolean;
  methods: Array<Method>;
  callbackUrl?: string;
  revision?: number;
  admission?: PlatformAdmissionPolicy;
  protection?: unknown;
};

function print(result: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(result, null, 2) : humanLines(result).join('\n'));
}

function printApplied(result: Record<string, unknown>, args: PlatformConfigArgs): void {
  print(result, args.json);
  if (!args.json && !args.plan) {
    printSuccess('Platform authentication configuration updated.');
  }
}

async function apply(
  client: OperatorClient,
  path: string,
  body: Record<string, unknown>,
  args: PlatformConfigArgs,
): Promise<Record<string, unknown>> {
  const preview = await client.request(path, { method: 'POST', body: { ...body, dryRun: true } });
  if (args.plan) {
    return preview;
  }
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      throw new Error(
        'platform: Configuration changes require --yes or --plan in non-interactive mode.',
      );
    }
    console.error(JSON.stringify(preview, null, 2));
    if (
      !platformPromptAnswer(
        await confirm({ message: `Apply this change to ${client.origin}?`, initialValue: false }),
      )
    ) {
      throw new Error('platform: Cancelled.');
    }
  }
  return client.request(path, { method: 'POST', body });
}

export async function waitForPlatformLoginTest(
  client: OperatorClient,
  launch: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (
    typeof launch.id !== 'string' ||
    typeof launch.expiresAt !== 'string' ||
    typeof launch.url !== 'string'
  ) {
    throw new Error('platform: Invalid login test response.');
  }
  const url = new URL(launch.url);
  if (
    url.origin !== client.origin ||
    url.pathname !== '/auth/test' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('platform: The login test belongs to a different platform.');
  }
  const expiry = Date.parse(launch.expiresAt);
  if (!Number.isFinite(expiry) || expiry > Date.now() + 11 * 60 * 1000) {
    throw new Error('platform: Invalid login test expiry.');
  }
  console.log(`Complete the login test in your browser: ${formatUrl(url.href)}`);
  openBrowser(url.href);
  while (Date.now() < expiry) {
    signal?.throwIfAborted();
    const result = await client.request(`/config/auth/tests/${encodeURIComponent(launch.id)}`, {
      signal,
    });
    if (result.complete === true) {
      return result;
    }
    await delay(1000, undefined, { signal });
  }
  throw new Error('platform: The login test expired. Run it again.');
}

async function testMethod(
  client: OperatorClient,
  id: string,
  args: PlatformConfigArgs,
): Promise<Record<string, unknown>> {
  const path = `/config/auth/connections/${encodeURIComponent(id)}/test`;
  if (args.plan) {
    return client.request(path, { method: 'POST', body: { dryRun: true } });
  }
  const launch = await client.request(path, { method: 'POST', body: {} });
  if (!process.stdin.isTTY || args.json) {
    return launch;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  try {
    return await waitForPlatformLoginTest(client, launch, controller.signal);
  } finally {
    process.removeListener('SIGINT', abort);
  }
}

async function configurationInput(
  args: PlatformConfigArgs,
  existing?: Method,
): Promise<{ configuration: PlatformLoginConfiguration; clientSecret?: string }> {
  let input: Record<string, unknown> = existing ? { ...existing.configuration } : {};
  if (args.file) {
    const file: unknown = JSON.parse(await readFile(args.file, 'utf8'));
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('platform: Configuration files must contain a JSON object.');
    }
    if ('clientSecret' in file) {
      throw new Error(
        'platform: Supply the client secret with --client-secret-env, not in the configuration file.',
      );
    }
    input = { ...input, ...file };
  }
  const kind = (existing?.configuration.kind ?? args.target) as PlatformLoginKind;
  if (
    (input.kind !== undefined && input.kind !== kind) ||
    (existing && input.id !== existing.id) ||
    (args.id && input.id !== undefined && input.id !== args.id)
  ) {
    throw new Error(
      'platform: The file must match the selected connection ID and kind. Use add for a different connection.',
    );
  }
  const id = existing?.id ?? args.id ?? input.id;
  input.kind = kind;
  input.id =
    id ||
    input.id ||
    (kind === 'github' || kind === 'google' ? kind : kind === 'oidc' ? 'company' : 'access');
  const interactive = !!process.stdin.isTTY && !args.file;
  if (interactive) {
    if (!existing && kind !== 'github' && kind !== 'google' && !args.id) {
      input.id = platformPromptAnswer(
        await text({ message: 'Connection ID:', initialValue: String(input.id) }),
      );
    }
    input.label = platformPromptAnswer(
      await text({
        message: 'Login button label:',
        initialValue: String(
          input.label ??
            {
              github: 'GitHub',
              google: 'Google',
              oidc: 'Company SSO',
              'cloudflare-access': 'Cloudflare Access',
            }[kind],
        ),
      }),
    );
    if (kind === 'oidc' || kind === 'cloudflare-access') {
      input.issuer = platformPromptAnswer(
        await text({ message: 'OIDC issuer URL:', initialValue: String(input.issuer ?? '') }),
      );
    }
    input.clientId = platformPromptAnswer(
      await text({ message: 'Client ID:', initialValue: String(input.clientId ?? '') }),
    );
    if (kind === 'google') {
      const domains = platformPromptAnswer(
        await text({
          message: 'Allowed Workspace domains (comma-separated; blank allows any Google account):',
          initialValue: Array.isArray(input.allowedDomains) ? input.allowedDomains.join(', ') : '',
        }),
      );
      input.allowedDomains = domains
        .split(',')
        .map((domain) => domain.trim())
        .filter(Boolean);
    }
    if (kind === 'oidc' || kind === 'cloudflare-access') {
      const groups = platformPromptAnswer(
        await text({
          message: 'Allowed groups (comma-separated; blank uses the provider’s access policy):',
          initialValue: Array.isArray(input.requiredGroups) ? input.requiredGroups.join(', ') : '',
        }),
      );
      input.requiredGroups = groups
        .split(',')
        .map((group) => group.trim())
        .filter(Boolean);
    }
  }
  const configuration = parsePlatformLoginConfiguration(input);
  if (existing && configuration.id !== existing.id) {
    throw new Error('platform: Use add to create a connection with a new ID.');
  }
  let secret = args.clientSecretEnv ? process.env[args.clientSecretEnv] : undefined;
  if (args.clientSecretEnv && !secret) {
    throw new Error(`platform: ${args.clientSecretEnv} must contain the client secret.`);
  }
  if (!args.clientSecretEnv && interactive) {
    secret =
      platformPromptAnswer(
        await password({
          message: existing
            ? 'Client secret (leave blank to keep the saved secret):'
            : 'Client secret:',
        }),
      ) || undefined;
  }
  if (!existing && !secret) {
    throw new Error(
      'platform: Provide --client-secret-env or enter a client secret interactively.',
    );
  }
  return { configuration, ...(secret ? { clientSecret: secret } : {}) };
}

export async function runPlatformAuthConfig(args: PlatformConfigArgs): Promise<void> {
  if (args.action === 'recover') {
    const { runPlatformAuthRecovery } = await import('./platform-auth-recovery.ts');
    return runPlatformAuthRecovery(args);
  }
  if (args.action === 'protection') {
    const { runPlatformProtectionConfig } = await import('./platform-auth-protection.ts');
    return runPlatformProtectionConfig(args);
  }
  const origin = resolveOperatorOrigin(args.connection);
  const client = new OperatorClient(origin, readOperatorToken(origin));
  const listing = (await client.request('/config/auth')) as Listing;
  if (!args.action) {
    if (!process.stdin.isTTY || args.json) {
      print(listing, args.json);
      return;
    }
    if (!listing.initialized) {
      printApplied(await apply(client, '/config/auth/initialize', {}, args), args);
      console.log('Run void platform auth login, then return to void platform config auth.');
      return;
    }
    const chosen = platformPromptAnswer(
      await select({
        message: 'Platform authentication:',
        options: [
          ...listing.methods.map((method) => ({
            value: method.id,
            label: `${stripVTControlCharacters(method.label)} (${method.enabled ? 'enabled' : 'disabled'})`,
          })),
          { value: ':add', label: 'Add login method' },
          { value: ':admission', label: 'Who can join?' },
          { value: ':protection', label: 'Platform protection (Cloudflare Access)' },
        ],
      }),
    );
    if (chosen === ':protection') {
      const target = platformPromptAnswer(
        await select({
          message: 'Platform protection:',
          options: [
            { value: 'show', label: 'Show current protection' },
            { value: 'enable', label: 'Create or connect Access protection' },
            { value: 'disable', label: 'Remove runtime protection and revoke sessions' },
          ],
        }),
      );
      return runPlatformAuthConfig({ ...args, action: 'protection', target });
    }
    if (chosen === ':admission') {
      return runPlatformAuthConfig({ ...args, action: 'admission' });
    }
    if (chosen === ':add') {
      const kind = platformPromptAnswer(
        await select({
          message: 'Login method:',
          options: [
            { value: 'github', label: 'GitHub' },
            { value: 'google', label: 'Google' },
            { value: 'oidc', label: 'Generic OIDC' },
            { value: 'cloudflare-access', label: 'Cloudflare Access' },
          ],
        }),
      );
      return runPlatformAuthConfig({ ...args, action: 'add', target: kind });
    }
    const method = listing.methods.find((method) => method.id === chosen)!;
    const action = platformPromptAnswer(
      await select({
        message: stripVTControlCharacters(method.label),
        options: [
          { value: 'test' as const, label: 'Test login' },
          { value: 'configure' as const, label: 'Edit configuration' },
          {
            value: method.enabled ? ('disable' as const) : ('enable' as const),
            label: method.enabled ? 'Disable' : 'Enable',
          },
          { value: 'link' as const, label: 'Link this login to my account' },
        ],
      }),
    );
    return runPlatformAuthConfig({ ...args, action, target: chosen });
  }
  if (args.action === 'list') {
    print(listing, args.json);
    return;
  }
  if (args.action === 'initialize') {
    printApplied(await apply(client, '/config/auth/initialize', {}, args), args);
    return;
  }
  if (!listing.initialized) {
    throw new Error('platform: Run void platform config auth initialize, then sign in again.');
  }
  if (args.action === 'admission') {
    let admission: unknown;
    if (args.file) {
      admission = JSON.parse(await readFile(args.file, 'utf8'));
    } else {
      if (!process.stdin.isTTY || args.json) {
        throw new Error('platform: Supply --file with the signup policy in non-interactive mode.');
      }
      const mode = platformPromptAnswer(
        await select({
          message: 'Who can create an account?',
          initialValue: listing.admission?.mode ?? 'restricted',
          options: [
            { value: 'restricted', label: 'Invited or allowlisted users' },
            { value: 'company', label: 'Company-approved users — automatic accounts' },
            { value: 'public', label: 'Public signup — all enabled logins' },
          ],
        }),
      );
      if (mode === 'company') {
        const access =
          !!listing.protection &&
          platformPromptAnswer(
            await confirm({
              message: 'Allow everyone approved by Cloudflare Access protection?',
              initialValue: true,
            }),
          );
        const eligible = listing.methods.filter(
          (method) =>
            method.enabled &&
            method.configuration.kind !== 'github' &&
            (method.configuration.kind !== 'google' ||
              method.configuration.allowedDomains.length > 0),
        );
        if (!access && eligible.length === 0) {
          throw new Error(
            'platform: Configure a company-restricted login or Access protection first.',
          );
        }
        const connections = eligible.length
          ? platformPromptAnswer(
              await multiselect({
                message: 'Login methods whose company policies qualify new users:',
                required: !access,
                options: eligible.map((method) => ({
                  value: method.id,
                  label: stripVTControlCharacters(method.label),
                })),
              }),
            )
          : [];
        admission = { mode, access, connections };
      } else {
        admission = { mode };
      }
    }
    printApplied(
      await apply(
        client,
        '/config/auth/admission',
        { revision: listing.revision, admission: parsePlatformAdmissionPolicy(admission) },
        args,
      ),
      args,
    );
    return;
  }
  const method = listing.methods.find((method) => method.id === args.target);
  if (args.action !== 'add' && !method) {
    throw new Error('platform: Login method not found. Run void platform config auth list.');
  }
  if (args.action === 'show') {
    print(method, args.json);
    return;
  }
  if (args.action === 'test') {
    const tested = await testMethod(client, args.target, args);
    print(tested, args.json);
    if (!args.json && !args.plan && tested.complete === true) {
      printSuccess('Platform login verified.');
    }
    return;
  }
  if (args.action === 'add' || args.action === 'configure') {
    console.error(
      `Register this callback URL with the provider: ${listing.callbackUrl ?? `${origin}/auth/callback`}`,
    );
    const input = await configurationInput(args, args.action === 'configure' ? method : undefined);
    const result = await apply(
      client,
      `/config/auth/connections/${encodeURIComponent(input.configuration.id)}/configure`,
      { ...input, revision: args.action === 'add' ? null : method!.revision },
      args,
    );
    printApplied(result, args);
    if (!args.plan && !args.json) {
      console.log(
        `Test and enable it with void platform config auth enable ${input.configuration.id}.`,
      );
    }
    return;
  }
  let testId = args.testId;
  if ((args.action === 'enable' || args.action === 'link') && !testId) {
    if (!process.stdin.isTTY || args.plan || args.json) {
      throw new Error('platform: Complete a login test and supply its --test-id.');
    }
    const tested = await testMethod(client, args.target, args);
    print(tested, args.json);
    if (tested.complete !== true || typeof tested.id !== 'string') {
      throw new Error('platform: Complete the browser test before enabling or linking this login.');
    }
    testId = tested.id;
    if (
      args.action === 'enable' &&
      platformPromptAnswer(
        await confirm({
          message: 'Link this verified identity to your administrator account?',
          initialValue: true,
        }),
      )
    ) {
      await apply(
        client,
        `/config/auth/connections/${encodeURIComponent(args.target)}/link`,
        { revision: method!.revision, testId },
        args,
      );
    }
  }
  printApplied(
    await apply(
      client,
      `/config/auth/connections/${encodeURIComponent(args.target)}/${args.action}`,
      { revision: method!.revision, ...(testId ? { testId } : {}) },
      args,
    ),
    args,
  );
}
