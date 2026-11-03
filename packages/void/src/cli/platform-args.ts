import {
  normalizePlatformDashboardUrl,
  PLATFORM_LOGIN_KINDS,
  type PlatformLoginKind,
  type PlatformAppAccess,
} from '@void/platform';
import { operatorGroups, parseOperatorArgs, type OperatorArgs } from './operator-args.ts';
import { parsePlatformConfigArgs, type PlatformConfigArgs } from './platform-config-args.ts';
import { parsePlatformPlansArgs, type PlatformPlansArgs } from './platform-plans-args.ts';
import type { SubcommandDef } from './subcommand-prompt.ts';

export const platformSubcommands: Array<SubcommandDef> = [
  {
    name: 'config',
    hint: 'Authentication, plans, and limits',
    description: 'Configure login methods, protection, plans, or limits',
  },
  ...operatorGroups.map((name) => ({
    name,
    hint:
      name === 'email'
        ? 'Domains, shared recipients, policy, limits, and recovery'
        : name === 'zero-trust'
          ? 'Configure Access protection and project overrides'
          : name === 'project'
            ? 'Inspect, normalize, transfer, or remove projects'
            : 'Operator commands',
    description: `Administer platform ${name}`,
  })),
  { name: 'list', description: 'List installed and connected platforms' },
  { name: 'use', arg: '[id]', description: 'Select the default Void platform' },
  { name: 'status', arg: '[id]', description: 'Inspect a platform and its health' },
  { name: 'discover', description: 'Recover installations from a Cloudflare account' },
  {
    name: 'domain',
    hint: 'Set an application domain',
    description: 'Add a domain to a workers.dev test platform',
  },
  {
    name: 'install',
    hint: 'Preview and save choices with --plan, then select the saved plan to install',
    description: 'Install a Void platform and choose who can access its apps',
  },
  { name: 'upgrade', arg: '[id]', description: 'Upgrade an installed Void platform' },
  { name: 'rollback', arg: '[id]', description: 'Restore a compatible earlier platform runtime' },
  {
    name: 'repair',
    arg: '[id]',
    description: 'Reconcile a platform, its dashboard origin, or unfinished login setup',
  },
  { name: 'disable', arg: '[id]', description: 'Disable traffic without deleting data' },
  { name: 'enable', arg: '[id]', description: 'Restore traffic for a disabled platform' },
  { name: 'uninstall', arg: '[id]', description: 'Safely remove an installed Void platform' },
];

export type PlatformArgs =
  | PlatformConfigArgs
  | PlatformPlansArgs
  | { subcommand: 'config'; configGroup: ''; plan: false; yes: false }
  | OperatorArgs
  | { subcommand: 'list' }
  | { subcommand: 'use'; selector: string }
  | { subcommand: 'status'; selector: string }
  | { subcommand: 'discover'; account: string; selector: string }
  | {
      subcommand: 'domain';
      domain: string;
      selector: string;
      zone: string;
      dedicatedZone: boolean;
      plan: boolean;
      yes: boolean;
    }
  | {
      subcommand: 'install';
      authConfig?: string;
      loginMethods?: Array<PlatformLoginKind>;
      accessProtection?: boolean;
      appAccess?: PlatformAppAccess;
      hyperdrive?: string;
      noControlPlaneDomain?: true;
      dedicatedZoneSpecified?: true;
      customDomains?: true;
      account: string;
      applicationDomain: string;
      controlPlaneDomain: string;
      dashboardUrl?: string;
      dedicatedZone: boolean;
      displayName: string;
      name: string;
      plan: boolean;
      resume: boolean;
      runtime: string;
      yes: boolean;
      zone: string;
      workersDev?: boolean;
      /** Omitted keeps the recorded value; `full` clears it. */
      runtimeLogs?: PlatformRuntimeLogsChoice;
    }
  | {
      subcommand: 'upgrade' | 'repair' | 'disable' | 'enable';
      /** repair only: replaces the login settings while first administrator setup is pending. */
      authConfig?: string;
      dashboardUrl?: string;
      customDomains?: true;
      /** upgrade only: omitted keeps the recorded value; `full` clears it. */
      runtimeLogs?: PlatformRuntimeLogsChoice;
      selector: string;
      plan: boolean;
      runtime: string;
      yes: boolean;
    }
  | {
      subcommand: 'rollback';
      selector: string;
      plan: boolean;
      runtime: string;
      fromRuntime: string;
      yes: boolean;
    }
  | {
      subcommand: 'uninstall';
      selector: string;
      plan: boolean;
      purgeData: boolean;
      /** Delete every resource the installation created; implies purgeData. */
      purgeResources: boolean;
      yes: boolean;
    };

export type PlatformRuntimeLogsChoice = 'full' | 'minimal';

function parseRuntimeLogs(value: string): PlatformRuntimeLogsChoice {
  if (value !== 'full' && value !== 'minimal') {
    throw new Error('platform: --runtime-logs must be full or minimal.');
  }
  return value;
}

function readValue(rest: Array<string>, index: number, flag: string): [string, number] {
  const value = rest[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`platform: ${flag} requires a value.`);
  }
  return [value, index + 1];
}

function parseSelector(
  rest: Array<string>,
  subcommand: string,
  options: { allowYes?: boolean } = {},
): { selector: string; plan: boolean; yes: boolean } {
  let selector = '';
  let plan = false;
  let yes = false;
  for (const arg of rest) {
    if (arg === '--plan') {
      plan = true;
    } else if (arg === '--yes' && options.allowYes) {
      yes = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`platform: Unknown flag '${arg}'.`);
    } else if (selector) {
      throw new Error(`platform: Unexpected argument '${arg}'.`);
    } else {
      selector = arg;
    }
  }
  if ((subcommand === 'use' || subcommand === 'status') && plan) {
    throw new Error("platform: Unknown flag '--plan'.");
  }
  return { selector, plan, yes };
}

function parseLifecycleSelector(
  rest: Array<string>,
  subcommand: 'upgrade' | 'rollback' | 'repair' | 'disable' | 'enable',
): {
  selector: string;
  plan: boolean;
  runtime: string;
  fromRuntime: string;
  yes: boolean;
  authConfig?: string;
  dashboardUrl?: string;
  customDomains?: true;
  runtimeLogs?: PlatformRuntimeLogsChoice;
} {
  const positional: Array<string> = [];
  let runtimeLogs: PlatformRuntimeLogsChoice | undefined;
  let runtime = '';
  let fromRuntime = '';
  let authConfig: string | undefined;
  let dashboardUrl: string | undefined;
  let customDomains = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === '--runtime') {
      if (subcommand === 'disable') {
        throw new Error("platform: Unknown flag '--runtime'.");
      }
      const [value, next] = readValue(rest, index, arg);
      runtime = value;
      index = next;
    } else if (arg === '--dashboard-url' && (subcommand === 'upgrade' || subcommand === 'repair')) {
      const [value, next] = readValue(rest, index, arg);
      dashboardUrl = normalizePlatformDashboardUrl(value);
      index = next;
    } else if (
      arg === '--custom-domains' &&
      (subcommand === 'upgrade' || subcommand === 'repair')
    ) {
      customDomains = true;
    } else if (arg === '--runtime-logs' && subcommand === 'upgrade') {
      const [value, next] = readValue(rest, index, arg);
      runtimeLogs = parseRuntimeLogs(value);
      index = next;
    } else if (arg === '--auth-config' && subcommand === 'repair') {
      const [value, next] = readValue(rest, index, arg);
      authConfig = value;
      index = next;
    } else if (arg === '--from-runtime' && subcommand === 'rollback') {
      const [value, next] = readValue(rest, index, arg);
      fromRuntime = value;
      index = next;
    } else {
      positional.push(arg);
    }
  }
  const parsed = parseSelector(positional, subcommand, { allowYes: true });
  if (subcommand === 'rollback' && !runtime) {
    throw new Error('platform: rollback requires --runtime <earlier-runtime-directory>.');
  }
  return {
    ...parsed,
    runtime,
    fromRuntime,
    ...(authConfig !== undefined ? { authConfig } : {}),
    ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
    ...(customDomains ? { customDomains: true as const } : {}),
    ...(runtimeLogs !== undefined ? { runtimeLogs } : {}),
  };
}

export function parsePlatformArgs(args: Array<string>): PlatformArgs {
  if (
    operatorGroups.includes(args[0] ?? '') ||
    ['--connection', '--json', '--plan', '--yes', '--timeout'].includes(args[0] ?? '')
  ) {
    return parseOperatorArgs(args);
  }
  const [subcommand, ...rest] = args;
  if (subcommand === 'config') {
    if (rest.length === 0) {
      return { subcommand: 'config', configGroup: '', plan: false, yes: false };
    }
    return rest[0] === 'plans' ? parsePlatformPlansArgs(rest) : parsePlatformConfigArgs(rest);
  }

  if (subcommand === 'domain') {
    if (rest.length === 0) {
      return {
        subcommand,
        domain: '',
        selector: '',
        zone: '',
        dedicatedZone: false,
        plan: false,
        yes: false,
      };
    }
    if (rest[0] !== 'set') {
      throw new Error(
        'platform: Usage: void platform domain set <domain> [--installation <id>] [--zone <domain>] [--dedicated-zone] [--plan] [--yes].',
      );
    }
    let domain = '';
    let selector = '';
    let zone = '';
    let plan = false;
    let yes = false;
    let dedicatedZone = false;
    for (let index = 1; index < rest.length; index++) {
      const arg = rest[index]!;
      if (arg === '--installation' || arg === '--zone') {
        const [value, next] = readValue(rest, index, arg);
        index = next;
        if (arg === '--zone') {
          zone = value;
        } else {
          selector = value;
        }
      } else if (arg === '--plan') {
        plan = true;
      } else if (arg === '--yes') {
        yes = true;
      } else if (arg === '--dedicated-zone') {
        dedicatedZone = true;
      } else if (!arg.startsWith('-') && !domain) {
        domain = arg;
      } else {
        throw new Error(`platform: Unexpected argument '${arg}'.`);
      }
    }
    if (!domain) {
      throw new Error('platform: domain set requires an application domain.');
    }
    if (plan && yes) {
      throw new Error('platform: Use either --plan or --yes.');
    }
    return { subcommand, domain, selector, zone, dedicatedZone, plan, yes };
  }

  if (subcommand === 'list') {
    if (rest.length > 0) {
      throw new Error(`platform: Unexpected argument '${rest[0]}'.`);
    }
    return { subcommand };
  }
  if (subcommand === 'use' || subcommand === 'status') {
    const { selector } = parseSelector(rest, subcommand);
    return { subcommand, selector };
  }
  if (subcommand === 'discover') {
    let account = '';
    let selector = '';
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      if (arg === '--account' || arg === '--installation') {
        const [value, next] = readValue(rest, index, arg);
        if (arg === '--account') {
          account = value;
        } else {
          selector = value;
        }
        index = next;
      } else {
        throw new Error(
          'platform: Usage: void platform discover [--account <id>] [--installation <id-or-name>].',
        );
      }
    }
    return { subcommand, account, selector };
  }
  if (
    subcommand === 'upgrade' ||
    subcommand === 'rollback' ||
    subcommand === 'repair' ||
    subcommand === 'disable' ||
    subcommand === 'enable'
  ) {
    const {
      selector,
      plan,
      runtime,
      fromRuntime,
      yes,
      authConfig,
      dashboardUrl,
      customDomains,
      runtimeLogs,
    } = parseLifecycleSelector(rest, subcommand);
    return subcommand === 'rollback'
      ? { subcommand, selector, plan, runtime, fromRuntime, yes }
      : {
          subcommand,
          selector,
          plan,
          runtime,
          yes,
          ...(authConfig !== undefined ? { authConfig } : {}),
          ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
          ...(customDomains ? { customDomains } : {}),
          ...(runtimeLogs !== undefined ? { runtimeLogs } : {}),
        };
  }
  if (subcommand === 'uninstall') {
    // --keep-zone is deprecated and accepted without effect: uninstall always keeps zones.
    const parsed = parseSelector(
      rest.filter((arg) => !['--purge-data', '--purge-resources', '--keep-zone'].includes(arg)),
      subcommand,
      { allowYes: true },
    );
    return {
      subcommand,
      selector: parsed.selector,
      plan: parsed.plan,
      purgeData: rest.includes('--purge-data') || rest.includes('--purge-resources'),
      purgeResources: rest.includes('--purge-resources'),
      yes: parsed.yes,
    };
  }
  if (subcommand === 'install') {
    const values = new Map<string, string>();
    let plan = false;
    let resume = false;
    let dedicatedZone = false;
    let yes = false;
    let noControlPlaneDomain = false;
    let noDedicatedZone = false;
    let accessProtection: boolean | undefined;
    const valueFlags = new Set([
      '--account',
      '--auth-config',
      '--login-methods',
      '--app-access',
      '--hyperdrive',
      '--application-domain',
      '--control-plane-domain',
      '--dashboard-url',
      '--display-name',
      '--name',
      '--runtime',
      '--runtime-logs',
      '--zone',
    ]);
    let workersDev = false;
    let customDomains = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (valueFlags.has(arg)) {
        const [value, next] = readValue(rest, i, arg);
        values.set(arg, value);
        i = next;
      } else if (arg === '--plan') {
        plan = true;
      } else if (arg === '--resume') {
        resume = true;
      } else if (arg === '--dedicated-zone') {
        dedicatedZone = true;
      } else if (arg === '--no-dedicated-zone') {
        noDedicatedZone = true;
      } else if (arg === '--no-control-plane-domain') {
        noControlPlaneDomain = true;
      } else if (arg === '--access-protection' || arg === '--no-access-protection') {
        const enabled = arg === '--access-protection';
        if (accessProtection !== undefined && accessProtection !== enabled) {
          throw new Error('platform: Choose either --access-protection or --no-access-protection.');
        }
        accessProtection = enabled;
      } else if (arg === '--yes') {
        yes = true;
      } else if (arg === '--workers-dev') {
        workersDev = true;
      } else if (arg === '--custom-domains') {
        customDomains = true;
      } else {
        throw new Error(`platform: Unexpected argument '${arg}'.`);
      }
    }
    if (noControlPlaneDomain && values.has('--control-plane-domain')) {
      throw new Error(
        'platform: Choose either --control-plane-domain or --no-control-plane-domain.',
      );
    }
    if (noDedicatedZone && dedicatedZone) {
      throw new Error('platform: Choose either --dedicated-zone or --no-dedicated-zone.');
    }
    if (
      values.has('--auth-config') &&
      (values.has('--login-methods') || accessProtection !== undefined)
    ) {
      throw new Error(
        'platform: --auth-config cannot be combined with login or Access protection options.',
      );
    }
    const appAccess = values.get('--app-access');
    if (appAccess !== undefined && !['public', 'platform', 'custom'].includes(appAccess)) {
      throw new Error('platform: --app-access accepts public, platform, or custom.');
    }
    const runtimeLogs = values.has('--runtime-logs')
      ? parseRuntimeLogs(values.get('--runtime-logs')!)
      : undefined;
    const loginMethods = values.get('--login-methods')?.split(',');
    if (
      loginMethods &&
      loginMethods.some((method) => !PLATFORM_LOGIN_KINDS.includes(method as PlatformLoginKind))
    ) {
      throw new Error(
        'platform: --login-methods accepts github, google, oidc, and cloudflare-access.',
      );
    }
    if (
      workersDev &&
      (values.has('--application-domain') || values.has('--zone') || dedicatedZone)
    ) {
      throw new Error(
        'platform: --workers-dev cannot be combined with a domain, zone, or --dedicated-zone.',
      );
    }
    if (customDomains && (workersDev || noDedicatedZone)) {
      throw new Error(
        'platform: --custom-domains needs a dedicated application zone; it cannot be combined with --workers-dev or --no-dedicated-zone.',
      );
    }
    return {
      subcommand,
      ...(noControlPlaneDomain ? { noControlPlaneDomain: true as const } : {}),
      ...(noDedicatedZone ? { dedicatedZoneSpecified: true as const } : {}),
      ...(customDomains ? { customDomains: true as const } : {}),
      ...(values.has('--hyperdrive') ? { hyperdrive: values.get('--hyperdrive')! } : {}),
      ...(loginMethods
        ? { loginMethods: [...new Set(loginMethods)] as Array<PlatformLoginKind> }
        : {}),
      ...(accessProtection !== undefined ? { accessProtection } : {}),
      ...(appAccess !== undefined ? { appAccess: appAccess as PlatformAppAccess } : {}),
      ...(workersDev ? { workersDev: true } : {}),
      ...(runtimeLogs !== undefined ? { runtimeLogs } : {}),
      ...(values.has('--auth-config') ? { authConfig: values.get('--auth-config')! } : {}),
      account: values.get('--account') ?? '',
      applicationDomain: values.get('--application-domain') ?? '',
      controlPlaneDomain: values.get('--control-plane-domain') ?? '',
      ...(values.has('--dashboard-url')
        ? { dashboardUrl: normalizePlatformDashboardUrl(values.get('--dashboard-url')!) }
        : {}),
      dedicatedZone,
      displayName: values.get('--display-name') ?? '',
      name: values.get('--name') ?? '',
      plan,
      resume,
      runtime: values.get('--runtime') ?? '',
      yes,
      zone: values.get('--zone') ?? '',
    };
  }

  throw new Error(
    'platform: Usage: void platform <config|auth|user|project|deployment|build|signup|invitation|email|system|worker|list|use|status|discover|install|domain|upgrade|rollback|repair|disable|enable|uninstall>.',
  );
}
