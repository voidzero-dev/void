import type { PlatformDeploymentManifest } from '@void/platform';
import { type CANCEL_SYMBOL, isCancel, log } from '@voidzero-dev/vite-plus-prompts';
import { openBrowser } from './auth.ts';
import { formatLink, pc } from './output.ts';
import type { PlatformManagementAccess } from './platform-auth.ts';
import { planCreatesZone, planWritesDns } from './platform-plan-writes.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

type PlatformSetupPage = Readonly<{
  title: string;
  url: string;
  instructions: string;
  linkInTitle?: boolean;
}>;

/** Return a prompt answer, or stop the platform command when the prompt was cancelled. */
export function platformPromptAnswer<T>(value: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return value;
}

export function platformSetupLink(page: Pick<PlatformSetupPage, 'title' | 'url'>): string {
  return formatLink(pc.underline(page.title), page.url);
}

export function platformSetupFieldHelp(
  key: string,
): Readonly<{ description: string; placeholder?: string }> | undefined {
  const docs = (page: string, section: string, title: string) =>
    platformSetupLink({
      title,
      url: `https://void.cloud/guide/platform/installation/${page}#${section}`,
    });
  switch (key) {
    case 'databaseUrl':
      return {
        placeholder: 'postgresql://user:pw@…/database',
        description:
          'Provide a PostgreSQL database URL for platform users, projects, and deployments. Use an empty hosted database, e.g. ' +
          platformSetupLink({ title: 'Neon', url: 'https://neon.com/' }) +
          '. ' +
          docs('prerequisites', 'platform-database', 'Database setup'),
      };
    case 'jwtSecret':
      return {
        description:
          `Create a JWT signing key for platform login tokens. Run ${pc.blue('openssl rand -base64 32')}. Save the key in your password manager. ` +
          docs('credentials', 'signing-and-encryption-keys', 'Key setup'),
      };
    case 'projectSecretKey':
      return {
        description:
          `Generate a project encryption key for app secrets. Run ${pc.blue('openssl rand -base64 32')} separately. Save this key for recovery. ` +
          docs('credentials', 'signing-and-encryption-keys', 'Key setup'),
      };
    default:
      return undefined;
  }
}

/** Dashboard keys use permission-catalog labels, which can differ from product names. */
function platformAccountTokenPermissions(includeAiGateway: boolean) {
  return [
    { key: 'account_settings', type: 'read' },
    { key: 'workers_scripts', type: 'edit' },
    { key: 'workers_kv_storage', type: 'edit' },
    { key: 'workers_r2', type: 'edit' },
    { key: 'd1', type: 'edit' },
    { key: 'queues', type: 'edit' },
    { key: 'account_analytics', type: 'read' },
    { key: 'workers_tail', type: 'read' },
    { key: 'query_cache', type: 'edit' },
    ...(includeAiGateway ? [{ key: 'aig', type: 'edit' }] : []),
  ];
}

/**
 * Account token links cannot preselect a zone: Cloudflare documents only
 * `permissionGroupKeys` and `name`, and the form puts zone permissions in an
 * "All Domains" policy. Tell the user which dashboard choice to change.
 */
function specifiedDomainsInstruction(zones: Array<string>): string {
  return `Change the zone policy from All Domains to Specified Domains → ${zones.join(' and ')}.`;
}

function plansZoneCreation(plan: PlatformInstallPlan): boolean {
  return plan.actions.some((action) => action.kind === 'zone' && action.action === 'create');
}

export function platformManagementSetupPage(
  plan: PlatformInstallPlan,
  options: { access: PlatformManagementAccess | false },
): PlatformSetupPage {
  const createsZone = plansZoneCreation(plan);
  const zoneName = plan.deployment.application.zoneName;
  const apiHostname = plan.deployment.controlPlane.apiHostname;
  const { access } = options;
  const zones = [
    ...(zoneName ? [zoneName] : []),
    ...(apiHostname && apiHostname !== zoneName && !apiHostname.endsWith(`.${zoneName}`)
      ? [`the zone for ${apiHostname}`]
      : []),
  ];
  const accessLevel = access && access.readOnly ? 'read' : 'edit';
  const appAccess = !!plan.deployment.appAccess;
  const appAccessLevel = appAccess ? 'edit' : accessLevel;
  const permissions = [
    ...platformAccountTokenPermissions(true),
    ...(zoneName || apiHostname || createsZone
      ? [
          { key: 'zone', type: createsZone ? 'edit' : 'read' },
          { key: 'dns', type: 'edit' },
          { key: 'workers_routes', type: 'edit' },
        ]
      : []),
    ...(access || appAccess
      ? [
          { key: 'access', type: appAccessLevel },
          { key: 'access_acct', type: 'read' },
          ...(access && access.protection
            ? [{ key: 'access_service_token', type: accessLevel }]
            : []),
        ]
      : []),
    ...(zoneName && plan.deployment.application.baseDomain !== zoneName
      ? [{ key: 'ssl_and_certificates', type: 'read' }]
      : []),
  ];
  return {
    title: 'Cloudflare management API token',
    linkInTitle: true,
    url:
      'https://dash.cloudflare.com/?' +
      new URLSearchParams({
        to: '/' + plan.account.id + '/api-tokens',
        name: plan.deployment.displayName + ' Management',
        permissionGroupKeys: JSON.stringify(permissions),
      }),
    instructions: [
      'This token lets the Void CLI install your platform. Void will now open a pre-configured token creation site. Please review the permissions and then paste the token here.',
      `Scope it to ${plan.account.name}.`,
      ...(createsZone
        ? [`Keep the zone policy on All Domains so Void can create ${zoneName}.`]
        : zones.length
          ? [specifiedDomainsInstruction(zones)]
          : []),
    ].join('\n'),
  };
}

export function platformSetupPages(plan: PlatformInstallPlan): {
  runtime: PlatformSetupPage;
  github: PlatformSetupPage;
  r2: PlatformSetupPage;
} {
  const needsGateway = plan.actions.some(
    (action) => action.kind === 'ai-gateway' && action.action === 'inspect',
  );
  const permissions = [
    ...platformAccountTokenPermissions(needsGateway),
    ...(plan.deployment.application.zoneName ? [{ key: 'cache', type: 'purge' }] : []),
    ...(plan.deployment.capabilities.customDomains
      ? [{ key: 'ssl_and_certificates', type: 'edit' }]
      : []),
    ...(plan.deployment.capabilities.sandbox
      ? [
          { key: 'containers', type: 'edit' },
          { key: 'cloudchamber', type: 'edit' },
        ]
      : []),
    // Email domain setup and destination consent use this token.
    ...(plan.deployment.capabilities.email
      ? [
          { key: 'zone', type: 'read' },
          { key: 'zone_settings', type: 'edit' },
          { key: 'email_routing_address', type: 'edit' },
          { key: 'email_routing_rule', type: 'edit' },
          { key: 'email_sending', type: 'edit' },
        ]
      : []),
  ];
  const zoneName = plan.deployment.application.zoneName;
  const query = new URLSearchParams({
    to: '/' + plan.account.id + '/api-tokens',
    name: plan.deployment.displayName + ' Runtime',
    permissionGroupKeys: JSON.stringify(permissions),
  });
  return {
    runtime: {
      title: 'Cloudflare runtime token',
      linkInTitle: true,
      url: 'https://dash.cloudflare.com/?' + query,
      instructions: [
        'Create a Cloudflare runtime token that Void can use to manage the platform. Please review the permissions and then paste the token here.',
        // A zone that Void creates later cannot be selected yet; All Domains
        // lets Cache Purge reach it once it exists.
        ...(zoneName && plansZoneCreation(plan)
          ? [
              `Keep the zone policy on All Domains so the token can purge cache on ${zoneName} after Void creates it.`,
            ]
          : zoneName
            ? [
                specifiedDomainsInstruction([
                  zoneName,
                  ...(plan.deployment.capabilities.email
                    ? ['every zone that will carry mail']
                    : []),
                ]),
              ]
            : []),
      ].join('\n'),
    },
    github: {
      title: 'GitHub OAuth App',
      url: 'https://github.com/settings/applications/new',
      instructions:
        'GitHub Auth will be used by the users of your Void Platform instance. Register a GitHub app and generate a client secret.\nHomepage: ' +
        plan.apiUrl +
        '\nRedirect URI: ' +
        plan.apiUrl +
        '/auth/callback',
    },
    r2: {
      title: 'R2 upload token',
      url:
        'https://dash.cloudflare.com/?' +
        new URLSearchParams({
          to: '/' + plan.account.id + '/r2/api-tokens/create',
          type: 'account',
          name: plan.deployment.displayName + ' Uploads',
          permission: 'object-write',
          bucketScope: 'all',
        }),
      instructions: [
        'Review the preselected Object Read & Write access to all buckets in this account.',
        'Create the token, then copy the Access Key ID and Secret Access Key into the CLI.',
      ].join('\n'),
    },
  };
}

export function formatPlatformSetupPlan(
  plan: PlatformInstallPlan,
  options: { managementToken?: boolean; managementAccess?: boolean } = {},
): string {
  const writesDns = planCreatesZone(plan) || planWritesDns(plan);
  const credentials = [
    ...(options.managementToken
      ? [
          options.managementAccess
            ? `Cloudflare management API token for ${writesDns ? 'DNS changes and ' : ''}Access setup`
            : 'Cloudflare management API token for DNS changes',
        ]
      : []),
    'PostgreSQL database URL',
    'Cloudflare runtime token',
    'R2 upload token',
    ...(plan.deployment.authentication.providers.includes('github')
      ? ['GitHub OAuth App client ID and secret']
      : []),
    ...plan.deployment.authentication.providers
      .filter((provider) => provider !== 'github')
      .map(
        (provider) =>
          (provider === 'google'
            ? 'Google OAuth'
            : provider === 'oidc'
              ? 'OIDC'
              : 'Cloudflare Access OIDC') + ' client ID and secret',
      ),
    ...(plan.deployment.authentication.accessProtection
      ? ['Cloudflare Access application and installer credentials']
      : []),
    ...(plan.deployment.appAccess
      ? ['Cloudflare Access check and app-management token when needed (stored encrypted)']
      : []),
    // Interactive installs generate these keys.
    ...(process.stdin.isTTY
      ? []
      : ['JWT signing key and project encryption key for non-interactive installs']),
  ];
  return [
    'The installation will guide you through setting up the following credentials:',
    '',
    ...credentials.map((credential) => `• ${credential}`),
  ].join('\n');
}

export type PlatformInstallCommandOptions = {
  commandName: 'void' | 'void-dev';
  accountId: string;
  installationSlug: string;
  displayName: string;
  applicationDomain: string;
  zoneName: string;
  controlPlaneDomain: string;
  dashboardUrl?: string;
  customDomains?: boolean;
  dedicatedZone: boolean;
  workersDev: boolean;
  authConfig?: string;
  authentication?: PlatformDeploymentManifest['authentication'];
  appAccess?: PlatformDeploymentManifest['appAccess'];
  hyperdrive?: string;
  runtime: string;
  runtimeLogs?: 'full' | 'minimal';
  resumeId?: string;
  yes: boolean;
};

export function platformInstallCommandArguments(
  options: PlatformInstallCommandOptions,
): Array<string> {
  const parts = [options.commandName, 'platform', 'install'];
  const flag = (name: string, value: string) => {
    if (value) {
      parts.push(name, value);
    }
  };
  if (options.resumeId) {
    parts.push('--resume');
    flag('--name', options.resumeId);
  } else {
    flag('--name', options.installationSlug);
    flag('--account', options.accountId);
    flag('--display-name', options.displayName);
    if (options.workersDev) {
      parts.push('--workers-dev');
    } else {
      flag('--application-domain', options.applicationDomain);
      flag('--zone', options.zoneName);
      if (options.dedicatedZone) {
        parts.push('--dedicated-zone');
      } else {
        parts.push('--no-dedicated-zone');
      }
      if (options.customDomains) {
        parts.push('--custom-domains');
      }
    }
    flag('--control-plane-domain', options.controlPlaneDomain);
    if (!options.controlPlaneDomain) {
      parts.push('--no-control-plane-domain');
    }
  }
  flag('--hyperdrive', options.hyperdrive ?? '');
  flag('--auth-config', options.authConfig ?? '');
  if (!options.resumeId && options.appAccess) {
    flag('--app-access', options.appAccess);
  }
  if (!options.authConfig && !options.resumeId && options.authentication) {
    flag('--login-methods', options.authentication.providers.join(','));
    parts.push(
      options.authentication.accessProtection ? '--access-protection' : '--no-access-protection',
    );
  }
  flag('--dashboard-url', options.dashboardUrl ?? '');
  flag('--runtime', options.runtime);
  flag('--runtime-logs', options.runtimeLogs ?? '');
  if (options.yes) {
    parts.push('--yes');
  }
  return parts;
}

export function formatPlatformInstallCommand(options: PlatformInstallCommandOptions): string {
  return platformInstallCommandArguments(options)
    .map((value) => {
      if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
        return value;
      }
      return process.platform === 'win32'
        ? `'${value.replaceAll("'", "''")}'`
        : `'${value.replaceAll("'", "'\\''")}'`;
    })
    .join(' ');
}

export function openPlatformSetupPage(
  page: PlatformSetupPage,
  dependencies: { interactive?: boolean; open?: (url: string) => void } = {},
): void {
  log.info((page.linkInTitle ? platformSetupLink(page) : page.title) + '\n' + page.instructions);
  if (!page.linkInTitle) {
    console.log(platformSetupLink({ ...page, title: 'Open ' + page.title }));
  }
  if (dependencies.interactive ?? process.stdin.isTTY === true) {
    try {
      (dependencies.open ?? openBrowser)(page.url);
    } catch {
      log.info('Could not open the browser. Use the link above.');
    }
  }
}
