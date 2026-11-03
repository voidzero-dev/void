import type { PlatformDiscoveryDocument, PlatformInstallationManifest } from '@void/platform';
import { isCancel, log, select, text } from '@voidzero-dev/vite-plus-prompts';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensurePlatformAccessToken, isCloudflareAccessChallenge } from './cf-access.ts';
import { printSuccess, formatUrl, pc } from './output.ts';
import type { PlatformArgs } from './platform-args.ts';
import { PlatformDisabledError, readPlatformDiscoveryResponse } from './platform-discovery.ts';
import {
  getActivePlatformConnection,
  listPlatformConnections,
  normalizePlatformApiUrl,
  savePlatformConnection,
  selectPlatformConnection,
  listInstallationManifests,
  platformConnectionSlug,
  type PlatformConnection,
} from './platform-registry.ts';

function normalizePlatformInputUrl(input: string): string {
  const value = input.trim();
  const protocol = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value)
    ? 'http'
    : 'https';
  return normalizePlatformApiUrl(value.includes('://') ? value : `${protocol}://${value}`);
}

export async function discoverPlatform(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<PlatformDiscoveryDocument> {
  const apiUrl = normalizePlatformInputUrl(input);
  ensurePlatformAccessToken(apiUrl);
  const request = () =>
    fetcher(`${apiUrl}/.well-known/void-platform`, {
      headers: { Accept: 'application/json', ...cfAccessHeaders(process.env, apiUrl) },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  let response = await request();
  if (isCloudflareAccessChallenge(response)) {
    await response.body?.cancel();
    ensurePlatformAccessToken(apiUrl, true);
    response = await request();
  }
  return readPlatformDiscoveryResponse(apiUrl, response);
}

export async function promptPlatformUrl(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('platform: A platform URL is required in non-interactive mode.');
  }
  const value = await text({
    message: 'Void platform API URL:',
    placeholder: 'platform.example.com',
    validate: (input) => {
      if (!input) {
        return 'Enter a platform URL.';
      }
      try {
        normalizePlatformInputUrl(input);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return value;
}

async function resolveConnection(selector: string): Promise<PlatformConnection> {
  if (selector) {
    return selectPlatformConnection(selector);
  }
  const connections = listPlatformConnections();
  if (connections.length === 0) {
    throw new Error('platform: No platforms configured. Run `void connect <url>`.');
  }
  if (connections.length === 1) {
    return selectPlatformConnection(connections[0]!.id);
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      'platform: Multiple platforms are configured; specify a slug, name, ID, or URL.',
    );
  }
  const picked = await select({
    message: 'Select a Void platform:',
    options: connections.map((connection) => ({
      label: connection.displayName,
      hint: connection.apiUrl,
      value: connection.id,
    })),
  });
  if (isCancel(picked)) {
    throw new Error('platform: Cancelled.');
  }
  return selectPlatformConnection(String(picked));
}

function showPlatform(
  connection: PlatformConnection,
  installations: ReadonlyArray<PlatformInstallationManifest>,
): void {
  const slug = platformConnectionSlug(connection, installations);
  console.log(`  ${pc.bold(connection.displayName)}${slug ? ` ${pc.dim(`(${slug})`)}` : ''}`);
  console.log(`    ${formatUrl(connection.apiUrl)}`);
  if (connection.applicationDomain) {
    console.log(
      connection.applicationDomain.endsWith('.workers.dev')
        ? '    apps: workers.dev (testing)'
        : `    apps: *.${connection.applicationDomain}`,
    );
  }
}

export function saveDiscoveredPlatform(discovery: PlatformDiscoveryDocument): PlatformConnection {
  return savePlatformConnection({
    accountId: null,
    apiUrl: discovery.apiUrl,
    applicationDomain: discovery.applicationDomain,
    displayName: discovery.displayName,
    installationId: discovery.installationId,
    kind: discovery.installationId ? 'installed' : 'connected',
    proxyUrl: discovery.proxyUrl,
  });
}

export async function runPlatformCommand(_root: string, args: PlatformArgs): Promise<void> {
  if (args.subcommand === 'config') {
    if ('configGroup' in args) {
      if (args.configGroup === '') {
        if (!process.stdin.isTTY) {
          throw new Error(
            'platform: Choose void platform config auth or void platform config plans.',
          );
        }
        const group = await select({
          message: 'Platform configuration:',
          options: [
            { value: 'auth', label: 'Authentication and protection' },
            { value: 'plans', label: 'Plans and limits' },
          ],
        });
        if (isCancel(group)) {
          return;
        }
        const { parsePlatformArgs } = await import('./platform-args.ts');
        return runPlatformCommand(_root, parsePlatformArgs(['config', group]));
      }
      const { runPlatformPlansConfig } = await import('./platform-plans-config.ts');
      await runPlatformPlansConfig(args);
      return;
    }
    const { runPlatformAuthConfig } = await import('./platform-auth-config.ts');
    await runPlatformAuthConfig(args);
    return;
  }
  if (args.subcommand === 'operator') {
    const { runOperatorCommand } = await import('./operator-cmd.ts');
    await runOperatorCommand(args);
    return;
  }
  if (args.subcommand === 'list') {
    const connections = listPlatformConnections();
    if (connections.length === 0) {
      log.info('No platforms configured. Run `void connect <url>`.');
      return;
    }
    const active = getActivePlatformConnection();
    const installations = listInstallationManifests();
    if (active) {
      console.log(pc.blue(pc.bold('Currently selected platform:')));
      showPlatform(active, installations);
    } else {
      console.log('No platform selected.');
    }
    const others = connections.filter((connection) => connection.id !== active?.id);
    if (others.length > 0) {
      console.log('');
      console.log(pc.blue(pc.bold('Other platforms:')));
      for (const [index, connection] of others.entries()) {
        if (index > 0) {
          console.log('');
        }
        showPlatform(connection, installations);
      }
      console.log('');
      console.log(pc.gray('run `void platform use <id>` to select one'));
    }
    return;
  }

  if (args.subcommand === 'use') {
    const connection = await resolveConnection(args.selector);
    printSuccess(`Using ${pc.bold(connection.displayName)} (${connection.apiUrl}).`);
    return;
  }

  if (args.subcommand === 'status') {
    const local = args.selector
      ? listInstallationManifests().find(
          (manifest) => manifest.id === args.selector && manifest.status !== 'uninstalled',
        )
      : undefined;
    const connection = local ? null : await resolveConnection(args.selector);
    const saved =
      local ??
      (connection?.installationId
        ? listInstallationManifests().find((manifest) => manifest.id === connection.installationId)
        : undefined);
    if (saved) {
      showSavedInstallationStatus(saved);
    }
    const apiUrl = local?.endpoints.apiUrl ?? connection?.apiUrl;
    if (!apiUrl) {
      log.info('No verified API endpoint is saved yet. Live traffic availability is unknown.');
      return;
    }
    let discovery: PlatformDiscoveryDocument;
    try {
      discovery = await discoverPlatform(apiUrl);
    } catch (error) {
      if (error instanceof PlatformDisabledError && !error.maintenance) {
        console.log('Platform: disabled (API and application traffic are paused).');
        if (!saved?.operation) {
          console.log(`Enable it: void platform enable${saved ? ` ${saved.id}` : ''}`);
        }
        return;
      }
      if (saved) {
        log.info(
          'Live availability could not be confirmed. The saved checkpoint above may be out of date.',
        );
      }
      if (error instanceof PlatformDisabledError) {
        throw new Error(
          `platform: Traffic at ${apiUrl} is paused for an upgrade or repair. Check again when it finishes.`,
          { cause: error },
        );
      }
      throw error;
    }
    log.info(`${discovery.displayName} is reachable.`);
    console.log(`API: ${formatUrl(discovery.apiUrl)}`);
    console.log(`Proxy: ${formatUrl(discovery.proxyUrl)}`);
    if (discovery.applicationRouting?.workersDev && !discovery.applicationRouting.zoneName) {
      console.log('Application domain: workers.dev (testing)');
      console.log('Add a domain: void platform domain set <domain>');
    } else {
      console.log(`Applications: *.${discovery.applicationDomain}`);
    }
    console.log(`Version: ${discovery.platformVersion}`);
    console.log(
      `Capabilities: ${Object.entries(discovery.capabilities)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .join(', ')}`,
    );
    return;
  }

  const { runPlatformLifecycleCommand } = await import('./platform-lifecycle.ts');
  await runPlatformLifecycleCommand(args);
}

function showSavedInstallationStatus(manifest: PlatformInstallationManifest): void {
  console.log(`Saved installation: ${manifest.id} (${manifest.status})`);
  console.log(`Checkpoint: ${manifest.updatedAt}`);
  if (manifest.deployment.runtimeLogs) {
    console.log(`Runtime logs: ${manifest.deployment.runtimeLogs}`);
  }
  if (manifest.operation) {
    const operation = manifest.operation;
    console.log(`Saved operation: ${operation.action} — ${operation.phase}`);
    console.log(`Runtime: ${operation.fromVersion ?? 'new installation'} → ${operation.toVersion}`);
  }
  if (manifest.endpoints.apiUrl) {
    console.log(`Administrator status: ${formatUrl(`${manifest.endpoints.apiUrl}/admin/status`)}`);
  }
}
