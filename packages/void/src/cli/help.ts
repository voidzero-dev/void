import { outro } from '@voidzero-dev/vite-plus-prompts';
import { getOwnVersion } from './agents.ts';
import { asciiArts } from './ascii.ts';
import { operatorCommands, operatorGroups } from './operator-args.ts';
import { categoryTitle, formatUrl, helpLine, note, pc, sectionTitle } from './output.ts';

type HelpCommand = {
  command: string;
  description: string;
};

type HelpPage = {
  summary: string;
  usage: Array<string>;
  commands?: Array<HelpCommand>;
  options?: Array<HelpCommand>;
  examples?: Array<HelpCommand>;
};

type HelpNode = HelpPage & { children?: HelpTree };
type HelpTree = Record<string, HelpNode>;

function operatorHelpTree(): HelpTree {
  return Object.fromEntries(
    operatorGroups.map((group) => {
      const commands = operatorCommands.filter((entry) => entry.group === group);
      return [
        group,
        {
          summary: `Administer platform ${group}. Operator credentials are separate from deployment credentials.`,
          usage: [`void platform ${group} <command> [options]`],
          commands: commands.map((entry) => ({
            command: entry.action,
            description: entry.description,
          })),
          children: Object.fromEntries(
            commands.map((entry) => [
              entry.action,
              {
                summary: `${entry.description}.`,
                usage: entry.usage ?? [
                  `void platform ${group} ${entry.action}${entry.positional?.map((name) => (entry.optionalPositional ? ` [${name}]` : ` <${name}>`)).join('') ?? ''} [options]`,
                ],
                options: [
                  {
                    command: '--connection <slug-or-url>',
                    description:
                      'Choose a registered connection; otherwise use VOID_API_URL or the active connection',
                  },
                  {
                    command: '--json',
                    description:
                      'Write structured JSON to stdout (JSON Lines while following logs)',
                  },
                  ...(entry.method
                    ? [
                        {
                          command: '--plan',
                          description: 'Validate and preview without changing anything',
                        },
                        {
                          command: '--yes',
                          description:
                            'Apply after preview without prompting; required in unattended scripts',
                        },
                        {
                          command: '--timeout <seconds>',
                          description:
                            'Mutation deadline (default 300 seconds; maximum 3600 seconds)',
                        },
                      ]
                    : []),
                  ...(['list', 'events', 'logs', 'attempts', 'shared-recipients'].includes(
                    entry.action,
                  )
                    ? [
                        {
                          command: '--limit <number>',
                          description:
                            entry.action === 'logs' && group !== 'email'
                              ? 'Maximum 500 log records'
                              : 'Maximum 100 records per page',
                        },
                        ...(entry.action !== 'logs' || group === 'email'
                          ? [{ command: '--page <number>', description: 'One-based page number' }]
                          : []),
                      ]
                    : []),
                  ...Object.entries(entry.values ?? {}).map(([flag, description]) => ({
                    command: `--${flag} <value>`,
                    description,
                  })),
                  ...Object.entries(entry.booleans ?? {}).map(([flag, description]) => ({
                    command: `--${flag}`,
                    description,
                  })),
                ],
              },
            ]),
          ),
        },
      ];
    }),
  );
}

const HELP_TREE: HelpTree = {
  connect: {
    summary:
      'Connect this project to Cloudflare or an existing Void platform. Platform hostnames default to HTTPS.',
    usage: ['void connect [url] [--platform <cloudflare|void>] [--no-login]'],
    options: [
      { command: '--platform <cloudflare|void>', description: 'Choose the deployment destination' },
      { command: '--no-login', description: 'Save a Void connection without authenticating' },
    ],
    examples: [
      { command: 'void connect', description: 'Choose a destination and sign in' },
      { command: 'void connect platform.example.com', description: 'Join a Void platform' },
      {
        command: 'void connect --platform cloudflare',
        description: 'Sign in and select a Cloudflare account',
      },
    ],
  },
  init: {
    summary: 'Set up Void in a new or existing project.',
    usage: ['void init [options]'],
    options: [
      { command: '--tsconfig', description: 'Update tsconfig.json and set up coding agents' },
      { command: '--git', description: 'Initialize a Git repository without prompting' },
      { command: '--no-git', description: 'Skip Git repository initialization' },
      { command: '--toolchain <name>', description: 'Scaffold with vite-plus or vite' },
      { command: '--framework <name>', description: 'Scaffold with react, vue, svelte, or solid' },
      {
        command: '--starter <name>',
        description: 'Scaffold the sqlite, postgresql, mysql, or static starter',
      },
      { command: '--deploy <target>', description: 'Deploy to cloudflare, void, or none' },
      {
        command: '--github',
        description: 'Create the GitHub Actions deploy workflow and set up coding agents',
      },
    ],
    examples: [
      { command: 'void init', description: 'Scaffold or configure the current project' },
      {
        command: 'void init --toolchain vite-plus --framework react --starter sqlite --deploy none',
        description: 'Scaffold without prompts',
      },
      { command: 'void init --github', description: 'Scaffold the GitHub Actions deploy workflow' },
    ],
  },
  migrate: {
    summary: 'Move legacy Void project settings into void.config.ts.',
    usage: ['void migrate'],
    examples: [{ command: 'void migrate', description: 'Convert void.json to void.config.ts' }],
  },
  deploy: {
    summary:
      'Build and deploy. Offers to link an existing Cloudflare Worker when no destination is configured.',
    usage: ['void deploy [options]'],
    options: [
      { command: '--project <name>', description: 'Deploy target project name' },
      { command: '--dir <path>', description: 'Deploy a static directory and skip build' },
      { command: '--spa', description: 'Use SPA mode for static deploys' },
      {
        command: '--skip-build',
        description: 'Skip the build step and use existing output (static deploys on Cloudflare)',
      },
      {
        command: '--platform <cloudflare|void>',
        description: 'Override the platform saved by void init',
      },
      {
        command: '--require-email',
        description:
          'Fail instead of deploying without email when the mail domain is not set up (with --platform cloudflare)',
      },
      {
        command: '--provision',
        description:
          'Run resource provisioning again, for example to enable D1 read replication (with --platform cloudflare)',
      },
      {
        command: '--atomic',
        description:
          'Publish a Durable Object Worker without pre-traffic staging (Cloudflare only)',
      },
      {
        command: '--debug',
        description: 'Mirror the deploy log to stderr (always written to ~/.void/logs)',
      },
    ],
    examples: [
      { command: 'void deploy', description: 'Deploy the linked project' },
      { command: 'void deploy --project my-app', description: 'Deploy to a specific project' },
      { command: 'void deploy --dir dist --spa', description: 'Deploy a static SPA directory' },
      {
        command: 'void deploy --platform cloudflare',
        description: 'Deploy to your own Cloudflare account',
      },
    ],
  },
  auth: {
    summary:
      'Authenticate with this project’s saved Cloudflare or Void destination. Without one, choose interactively or pass --platform.',
    usage: ['void auth <login|status|logout> [--platform cloudflare|void]'],
    commands: [
      { command: 'login', description: 'Sign in to the selected destination' },
      { command: 'status', description: 'Show the selected destination’s identity' },
      { command: 'logout', description: 'Sign out of the selected destination' },
    ],
    options: [
      { command: '--platform <cloudflare|void>', description: 'Choose the destination explicitly' },
    ],
    children: {
      login: basicSubcommand(
        'Sign in to the selected destination.',
        'void auth login [--platform cloudflare|void]',
      ),
      status: basicSubcommand(
        'Show the selected destination’s identity.',
        'void auth status [--platform cloudflare|void]',
      ),
      logout: basicSubcommand(
        'Sign out of the selected destination.',
        'void auth logout [--platform cloudflare|void]',
      ),
    },
  },
  account: {
    summary: 'Manage your Void platform account.',
    usage: ['void account <command>'],
    commands: [
      { command: 'login', description: 'Log in with an enabled platform login method' },
      { command: 'link [connection-id]', description: 'Link another login method to your account' },
      { command: 'logout', description: 'Log out and remove credentials' },
      { command: 'whoami', description: 'Show the logged-in username' },
      { command: 'token', description: 'Copy auth token to clipboard' },
    ],
    children: {
      login: basicSubcommand('Log in with an enabled platform login method.', 'void account login'),
      link: basicSubcommand(
        'Sign in again, then verify and link another login method to your existing account.',
        'void account link [connection-id]',
      ),
      logout: basicSubcommand('Log out and remove credentials.', 'void account logout'),
      whoami: basicSubcommand('Show the logged-in username.', 'void account whoami'),
      token: basicSubcommand('Copy auth token to clipboard.', 'void account token'),
    },
  },
  cloudflare: {
    summary: 'Manage Cloudflare authentication used by Void.',
    usage: ['void cloudflare <command>'],
    commands: [
      { command: 'login', description: 'Sign in or switch users with browser OAuth' },
      {
        command: 'status',
        description: 'Show identity, authentication, and the deployment account',
      },
      { command: 'logout', description: 'Remove the local browser session' },
    ],
    children: {
      login: basicSubcommand(
        'Sign in again or switch Cloudflare users with browser OAuth.',
        'void cloudflare login',
      ),
      status: basicSubcommand(
        'Show Cloudflare identity, authentication, accessible accounts, and the pinned deployment account.',
        'void cloudflare status',
      ),
      logout: basicSubcommand('Remove the local browser session.', 'void cloudflare logout'),
    },
  },
  platform: {
    summary:
      'Install Void platforms and administer users, projects, access, and operations. Use `void connect` to join one.',
    usage: ['void platform <command>'],
    commands: [
      ...operatorGroups.map((group) => ({
        command: `${group} <command>`,
        description: `Administer platform ${group}`,
      })),
      {
        command: 'config auth [command]',
        description: 'Configure login methods, company protection, and provider recovery',
      },
      {
        command: 'config plans [command]',
        description: 'Manage plans, account limits, and the default plan',
      },
      { command: 'list', description: 'List installed and connected platforms' },
      { command: 'use [id]', description: 'Select the default Void platform' },
      { command: 'status [id]', description: 'Inspect a platform and its health' },
      { command: 'discover', description: 'Recover installations from a Cloudflare account' },
      {
        command: 'domain set <domain>',
        description: 'Add an application domain to a test platform',
      },
      { command: 'install', description: 'Install a Void platform in Cloudflare' },
      { command: 'upgrade [id]', description: 'Upgrade an installed Void platform' },
      {
        command: 'rollback [id]',
        description: 'Restore a compatible earlier platform runtime',
      },
      {
        command: 'repair [id]',
        description: 'Reconcile an installed Void platform or its unfinished login setup',
      },
      { command: 'disable [id]', description: 'Disable traffic without deleting data' },
      { command: 'enable [id]', description: 'Restore traffic for a disabled platform' },
      { command: 'uninstall [id]', description: 'Safely remove an installed Void platform' },
    ],
    children: {
      ...operatorHelpTree(),
      config: {
        summary: 'Configure platform settings.',
        usage: ['void platform config <auth|plans> [command] [options]'],
        children: {
          plans: {
            summary: 'Manage plans and limits. Without a command, opens interactive configuration.',
            usage: [
              'void platform config plans [show|add|set|reset|archive|restore|remove|default|sync] [plan-id] [options]',
            ],
            commands: [
              {
                command: 'show [id]',
                description: 'Show the catalog or one plan and its account count',
              },
              {
                command: 'add <id> --copy <id> --name <name>',
                description: 'Copy an existing plan with a new stable ID',
              },
              {
                command: 'set <id>',
                description: 'Edit a plan name, limits, or build instance size',
              },
              {
                command: 'reset <id>',
                description: 'Restore a built-in plan’s original limits and build size',
              },
              {
                command: 'archive <id>',
                description: 'Keep current accounts while stopping new assignments',
              },
              {
                command: 'restore <id>',
                description: 'Allow assignments to an archived plan again',
              },
              {
                command: 'remove <id>',
                description: 'Remove an unused plan or move its accounts to a replacement',
              },
              { command: 'default <id>', description: 'Choose the plan new accounts receive' },
              { command: 'sync', description: 'Continue pending account limit updates' },
            ],
            options: [
              {
                command: '--connection <slug-or-url>',
                description: 'Select a registered platform',
              },
              {
                command: '--file <path>',
                description: 'Read plan settings and partial limits from JSON',
              },
              {
                command: '--name <name>',
                description: 'Set the display name when adding or editing',
              },
              { command: '--copy <id>', description: 'Copy this plan when adding a new one' },
              {
                command: '--replacement <id>',
                description: 'Move accounts and any default before removing a plan',
              },
              { command: '--plan', description: 'Preview the change and affected accounts' },
              { command: '--yes', description: 'Apply without prompting' },
              { command: '--json', description: 'Print structured output' },
            ],
          },
          auth: {
            summary:
              'Manage login methods and independent platform protection. Without a command, opens interactive configuration.',
            usage: [
              'void platform config auth [list|show|initialize|add|configure|test|enable|disable|link|admission|protection|recover] [method-or-action] [options]',
            ],
            commands: [
              {
                command: 'list',
                description: 'List configured login methods and platform protection',
              },
              {
                command: 'show <id>',
                description: 'Inspect a login method without displaying secrets',
              },
              {
                command: 'initialize',
                description: 'Import existing login settings before first configuration',
              },
              {
                command: 'add <github|google|oidc|cloudflare-access>',
                description: 'Configure a new login method',
              },
              { command: 'configure <id>', description: 'Stage an update to a login method' },
              { command: 'test <id>', description: 'Verify a login configuration in the browser' },
              { command: 'enable <id>', description: 'Enable a successfully tested configuration' },
              {
                command: 'disable <id>',
                description: 'Disable a method and revoke its human sessions',
              },
              {
                command: 'link <id>',
                description: 'Explicitly link a tested identity to your account',
              },
              {
                command: 'admission',
                description: 'Choose invited, company-approved, or public signup',
              },
              {
                command: 'protection <enable|disable|show>',
                description: 'Create or connect Access protection independently from login',
              },
              {
                command: 'recover <id>',
                description: 'Recover an existing administrator using installation authority',
              },
            ],
            options: [
              {
                command: '--connection <slug-or-url>',
                description: 'Select a registered platform',
              },
              {
                command: '--installation <id>',
                description: 'Select recovery authority for protection or provider recovery',
              },
              { command: '--id <id>', description: 'Name a new OIDC or Access connection' },
              { command: '--file <path>', description: 'Read nonsecret configuration from JSON' },
              {
                command: '--client-secret-env <name>',
                description: 'Read the client secret from an environment variable',
              },
              { command: '--test-id <id>', description: 'Use a completed test for enable or link' },
              { command: '--plan', description: 'Validate and preview a change' },
              { command: '--yes', description: 'Apply without prompting' },
              { command: '--json', description: 'Print structured output' },
            ],
          },
        },
      },
      domain: {
        summary: 'Add an application domain while keeping existing workers.dev URLs.',
        usage: ['void platform domain set <domain> [options]'],
        children: {
          set: {
            summary:
              'Set up DNS and verify HTTPS before making an application domain canonical. Rerun to resume.',
            usage: ['void platform domain set <domain> [options]'],
            options: [
              {
                command: '--installation <id>',
                description: 'Choose an installed platform; otherwise select interactively',
              },
              {
                command: '--zone <domain>',
                description: 'Containing Cloudflare zone; detected when it already exists',
              },
              {
                command: '--dedicated-zone',
                description: 'Add catch-all routes for a zone dedicated to this platform',
              },
              { command: '--plan', description: 'Preview without making changes' },
              { command: '--yes', description: 'Apply without an interactive confirmation' },
            ],
          },
        },
      },
      list: basicSubcommand('List installed and connected platforms.', 'void platform list'),
      use: basicSubcommand(
        'Select the default Void platform by installation slug, name, saved ID, or API URL.',
        'void platform use [id]',
      ),
      status: basicSubcommand('Inspect a platform and its health.', 'void platform status [id]'),
      discover: {
        summary: 'Recover owned platform installations from Cloudflare.',
        usage: ['void platform discover [--account <id>] [--installation <id-or-name>]'],
        options: [
          { command: '--account <id>', description: 'Cloudflare account id' },
          {
            command: '--installation <id-or-name>',
            description: 'Recover only one installation from a shared account',
          },
        ],
      },
      install: {
        summary: 'Install or resume a Void platform with a domain, or workers.dev for testing.',
        usage: ['void platform install [options]'],
        options: [
          {
            command: '--auth-config <path>',
            description:
              'Read login methods and signup policy from nonsecret JSON with environment secret references',
          },
          {
            command: '--login-methods <methods>',
            description: 'Comma-separated github, google, oidc, or cloudflare-access login methods',
          },
          {
            command: '--access-protection',
            description: 'Protect platform UI and APIs with Cloudflare Access',
          },
          { command: '--no-access-protection', description: 'Skip Cloudflare Access protection' },
          {
            command: '--app-access <public|platform|custom>',
            description:
              'Choose public apps, reuse platform Access, or select separate app policies',
          },
          {
            command: '--hyperdrive <create|id>',
            description: 'Create Hyperdrive or use the specified existing configuration',
          },
          { command: '--name <slug>', description: 'Installation name' },
          {
            command: '--workers-dev',
            description: 'Use workers.dev for testing. Add a domain later.',
          },
          { command: '--display-name <name>', description: 'Human-readable platform name' },
          { command: '--account <id>', description: 'Cloudflare account id' },
          {
            command: '--application-domain <domain>',
            description: 'Base domain for applications',
          },
          { command: '--zone <domain>', description: 'Cloudflare zone containing the app domain' },
          {
            command: '--dedicated-zone',
            description: 'Allow zone-wide application catch-all routes',
          },
          {
            command: '--no-dedicated-zone',
            description: 'Skip zone-wide application catch-all routes',
          },
          {
            command: '--custom-domains',
            description: 'Let projects add their own domains (requires --dedicated-zone)',
          },
          { command: '--control-plane-domain <domain>', description: 'Optional API hostname' },
          {
            command: '--no-control-plane-domain',
            description: 'Use the default workers.dev API hostname',
          },
          {
            command: '--dashboard-url <origin>',
            description: 'HTTPS origin of a separately deployed dashboard',
          },
          { command: '--plan', description: 'Print the exact plan without changing Cloudflare' },
          { command: '--resume', description: 'Resume the matching local installation' },
          {
            command: '--runtime <path>',
            description: 'Deploy an integrity-checked runtime directory instead of the package',
          },
          { command: '--yes', description: 'Acknowledge changes without an interactive prompt' },
        ],
      },
      upgrade: lifecycleHelp(
        'upgrade',
        'Upgrade an installed platform without deleting resources.',
      ),
      rollback: {
        summary: 'Restore a compatible earlier runtime without reversing database migrations.',
        usage: [
          'void platform rollback [id] --runtime <earlier-path> [--from-runtime <current-path>] [--plan] [--yes]',
        ],
        options: [
          { command: '--runtime <path>', description: 'Earlier compatible runtime to restore' },
          {
            command: '--from-runtime <path>',
            description: 'Current installed runtime when it differs from the packaged runtime',
          },
          { command: '--plan', description: 'Print the exact plan without making changes' },
          { command: '--yes', description: 'Acknowledge non-interactive Cloudflare changes' },
        ],
      },
      repair: lifecycleHelp(
        'repair',
        'Reconcile drift using the installation ownership manifest, or change the login settings while first administrator setup is pending.',
      ),
      disable: lifecycleHelp('disable', 'Disable platform traffic without deleting data.'),
      enable: lifecycleHelp('enable', 'Restore configured traffic for a disabled platform.'),
      uninstall: {
        summary: 'Safely remove installer-owned platform resources.',
        usage: ['void platform uninstall [id] [options]'],
        options: [
          { command: '--plan', description: 'Print the exact deletion and retention plan' },
          { command: '--yes', description: 'Acknowledge changes without an interactive prompt' },
          {
            command: '--purge-data',
            description: 'Delete installer-owned data even when it contains apps',
          },
          {
            command: '--purge-resources',
            description:
              'Delete every resource the installation created (includes --purge-data); keeps zones, adopted resources, and PostgreSQL',
          },
          {
            command: '--keep-zone',
            description: 'Deprecated. Has no effect: uninstall always keeps zones',
          },
        ],
      },
    },
  },
  project: {
    summary: 'Manage Void projects and deployments.',
    usage: ['void project <command>'],
    commands: [
      { command: 'status [name]', description: 'Show deployments for a project' },
      { command: 'link [name]', description: 'Link this directory to a project' },
      { command: 'list', description: 'List your projects' },
      { command: 'token <command>', description: 'Manage project-scoped CI deploy credentials' },
      { command: 'team <command>', description: 'Manage members and project invitations' },
      {
        command: 'zero-trust <command>',
        description: 'Inspect or override Cloudflare Zero Trust protection',
      },
      { command: 'logs', description: 'Show runtime logs from the deployed project' },
      { command: 'requests', description: 'Show request-level traffic (status, method, timing)' },
      { command: 'rollback [deployId]', description: 'Roll back to a previous deployment' },
      { command: 'cancel [deployId]', description: 'Cancel an active deployment' },
      { command: 'delete [name]', description: 'Delete a project and all its resources' },
      { command: 'purge-cache', description: 'Purge all cached pages (Void platform)' },
    ],
    children: {
      status: basicSubcommand(
        'Show deployments for a project.',
        'void project status [name]',
        'void project status my-app',
      ),
      link: basicSubcommand(
        'Link this directory to a Void project.',
        'void project link [name]',
        'void project link my-app',
      ),
      list: basicSubcommand('List your projects.', 'void project list'),
      token: {
        summary: 'Manage revocable, project-scoped credentials for CI deploys.',
        usage: ['void project token <create|list|renew|revoke> [options]'],
        options: [
          { command: '--project <name>', description: 'Project name override' },
          { command: '--name <label>', description: 'Credential label (create only)' },
          { command: '--expires-in <days>', description: 'Expiry from 1 to 90 days' },
          { command: '--json', description: 'Print machine-readable output' },
        ],
        examples: [
          {
            command: 'void project token create --name github-actions --expires-in 30',
            description: 'Create a CI deploy credential',
          },
          { command: 'void project token revoke <id>', description: 'Revoke a credential now' },
        ],
      },
      team: {
        summary: 'Manage members and invitations for Void platform projects.',
        usage: ['void project team <command>'],
        commands: [
          { command: 'list', description: 'List project members and roles' },
          { command: 'invite <email>', description: 'Invite a registered user by email' },
          { command: 'invitations', description: 'List invitations sent for a project' },
          { command: 'role <user-id> <role>', description: "Change a member's role" },
          { command: 'remove <user-id>', description: 'Remove a project member' },
          { command: 'revoke <invitation-id>', description: 'Revoke a project invitation' },
          { command: 'leave', description: 'Leave a shared project' },
          { command: 'pending', description: 'List invitations awaiting your response' },
          { command: 'accept <invitation-id>', description: 'Accept your invitation' },
          { command: 'decline <invitation-id>', description: 'Decline your invitation' },
        ],
        children: {
          list: withProjectOption(
            'List project members and roles.',
            'void project team list [options]',
          ),
          invite: {
            summary: 'Invite an existing Void platform user by registered email address.',
            usage: ['void project team invite <email> --role <role> [options]'],
            options: [
              { command: '--role <role>', description: 'reader, collaborator, or admin' },
              { command: '--project <name>', description: 'Project name override' },
            ],
          },
          invitations: withProjectOption(
            'List invitations sent for a project.',
            'void project team invitations [options]',
          ),
          role: withProjectOption(
            "Change a member's role to reader, collaborator, or admin.",
            'void project team role <user-id> <role> [options]',
          ),
          remove: withProjectOption(
            'Remove a member from the project.',
            'void project team remove <user-id> [options]',
          ),
          revoke: withProjectOption(
            'Revoke a pending project invitation.',
            'void project team revoke <invitation-id> [options]',
          ),
          leave: withProjectOption('Leave a shared project.', 'void project team leave [options]'),
          pending: basicSubcommand(
            'List invitations on the active platform connection (VOID_API_URL overrides it).',
            'void project team pending',
          ),
          accept: basicSubcommand(
            'Accept your invitation on the active platform connection, preserving project links.',
            'void project team accept <invitation-id>',
          ),
          decline: basicSubcommand(
            'Decline your invitation on the active platform connection (VOID_API_URL overrides it).',
            'void project team decline <invitation-id>',
          ),
        },
      },
      'zero-trust': {
        summary: 'Inspect and manage Zero Trust protection for a Void platform project.',
        usage: ['void project zero-trust <status|protect|public|reconcile> [options]'],
        commands: [
          { command: 'status', description: 'Show desired and effective protection state' },
          { command: 'protect', description: 'Protect the project' },
          { command: 'public', description: 'Make the project public' },
          { command: 'reconcile', description: 'Repair Cloudflare Access configuration drift' },
        ],
        options: [{ command: '--project <name>', description: 'Project name override' }],
        children: Object.fromEntries(
          ['status', 'protect', 'public', 'reconcile'].map((action) => [
            action,
            withProjectOption(
              action === 'status'
                ? 'Show desired and effective Zero Trust protection.'
                : action === 'protect'
                  ? 'Protect the project with the platform Access policy.'
                  : action === 'public'
                    ? 'Make the project public with a managed Access bypass.'
                    : 'Repair Cloudflare Access configuration drift for the project.',
              `void project zero-trust ${action} [options]`,
            ),
          ]),
        ),
      },
      logs: {
        summary: 'Show runtime logs from the deployed project.',
        usage: ['void project logs [options]'],
        options: [
          { command: '--filter <text>', description: 'Substring search over log messages' },
          {
            command: '--level <level>',
            description: 'Filter by level: error|warn|info|log|debug|all (default: all)',
          },
          { command: '--range <range>', description: 'Time range to query (default: 1h)' },
          { command: '--deployment <id>', description: 'Limit logs to one deployment' },
        ],
        examples: [
          { command: 'void project logs --range 30m', description: 'Show recent project logs' },
          {
            command: 'void project logs --level error',
            description: 'Show only error-level entries and exceptions',
          },
          {
            command: 'void project logs --filter websocket',
            description: 'Substring search over log messages',
          },
        ],
      },
      requests: {
        summary:
          'Show request-level traffic (status, method, type, timing). Surfaces 5xx that the edge router generated itself and requests to static/SPA projects that never invoke a worker — neither of which appears in `project logs`.',
        usage: ['void project requests [options]'],
        options: [
          {
            command: '--status <filter>',
            description: 'Filter by status: a class like 5xx or an exact code like 500',
          },
          { command: '--range <range>', description: 'Time range to query (default: 1h)' },
        ],
        examples: [
          {
            command: 'void project requests --status 5xx',
            description: 'Show recent server-error responses, including edge-generated ones',
          },
          {
            command: 'void project requests --range 24h',
            description: 'Show all request traffic in the last day',
          },
        ],
      },
      rollback: {
        summary: 'Roll back to a previous deployment.',
        usage: ['void project rollback [deployId] [--platform cloudflare]'],
        options: [
          {
            command: '--platform cloudflare',
            description: 'Roll back the Cloudflare Worker after a one-off Cloudflare deploy',
          },
        ],
      },
      cancel: basicSubcommand('Cancel an active deployment.', 'void project cancel [deployId]'),
      delete: {
        summary: 'Delete a project and all its resources.',
        usage: ['void project delete [name] [options]'],
        options: [{ command: '--force, -f', description: 'Delete without confirmation' }],
        examples: [{ command: 'void project delete my-app', description: 'Delete a project' }],
      },
      'purge-cache': {
        summary: 'Purge all cached pages for a Void platform project.',
        usage: ['void project purge-cache [options]'],
        options: [{ command: '--project <name>', description: 'Project name override' }],
      },
    },
  },
  secret: {
    summary: 'Manage production secrets for Void projects.',
    usage: ['void secret <command>'],
    commands: [
      { command: 'list', description: 'List project secrets' },
      { command: 'put <name>', description: 'Set a project secret' },
      { command: 'delete <name>', description: 'Delete a project secret' },
      { command: 'sync <file>', description: 'Sync secrets from a dotenv file' },
    ],
    children: {
      list: withProjectOption('List project secrets.', 'void secret list [options]'),
      put: withProjectOption('Set a project secret.', 'void secret put <name> [options]'),
      delete: withProjectOption('Delete a project secret.', 'void secret delete <name> [options]'),
      sync: withProjectOption(
        'Sync secrets from a dotenv file.',
        'void secret sync <file> [options]',
      ),
    },
  },
  domain: {
    summary: 'Configure custom domains for Void projects.',
    usage: ['void domain <command>'],
    commands: [
      { command: 'add <hostname>', description: 'Add a custom domain' },
      { command: 'delete <hostname>', description: 'Remove a custom domain' },
      { command: 'list', description: 'List custom domains and status' },
      { command: 'status <hostname>', description: 'Check domain verification status' },
    ],
    children: {
      add: withProjectOption('Add a custom domain.', 'void domain add <hostname> [options]'),
      delete: withProjectOption(
        'Remove a custom domain.',
        'void domain delete <hostname> [options]',
      ),
      list: withProjectOption('List custom domains and status.', 'void domain list [options]'),
      status: {
        summary:
          'Check domain verification status. Prints a rolled-up state with a one-line diagnostic.',
        usage: ['void domain status <hostname> [options]'],
        options: [
          { command: '--project <name>', description: 'Project name override' },
          {
            command: '--verbose',
            description: 'Also print the raw multi-line status breakdown',
          },
        ],
      },
    },
  },
  email: {
    summary:
      'Inspect email activity, manage verified recipients, and send and receive at your own domain.',
    usage: ['void email <command>'],
    commands: [
      { command: 'usage', description: 'Show monthly outbound/inbound counts and quota' },
      { command: 'logs', description: 'Show recent email delivery activity' },
      { command: 'destinations', description: 'List verified recipient addresses' },
      { command: 'allow <address>', description: 'Add a recipient and trigger CF verification' },
      { command: 'disallow <address>', description: 'Remove a recipient from the allowlist' },
      {
        command: 'alias [name]',
        description: 'Show the shared mail address, or set a shorter permanent name for it',
      },
      {
        command: 'domain <add|status|list|sync|rotate-secret|remove>',
        description: 'Send and receive at your own domain on a Cloudflare zone',
      },
      {
        command: 'status --platform cloudflare',
        description: 'Show the email setup state and address map on your own account',
      },
      {
        command: 'setup --platform cloudflare',
        description: 'Set email up on your own Cloudflare account (one confirmation)',
      },
    ],
    children: {
      usage: withProjectOption(
        'Show monthly outbound/inbound counts and quota.',
        'void email usage [options]',
      ),
      // Not `withProjectOption`: `logs` is the one email subcommand with a
      // flag of its own that actually does something, so the shared helper
      // would hide it. Same shape as `domain status` above.
      logs: {
        summary: 'Show recent email delivery activity.',
        usage: ['void email logs [options]'],
        options: [
          { command: '--project <name>', description: 'Project name override' },
          {
            command: '--limit <n>',
            description: 'How many entries to show (positive integer)',
          },
        ],
      },
      destinations: withProjectOption(
        'List verified recipient addresses.',
        'void email destinations [options]',
      ),
      allow: withProjectOption(
        'Add a recipient and trigger a Cloudflare verification email.',
        'void email allow <address> [options]',
      ),
      disallow: withProjectOption(
        'Remove a recipient from the verified allowlist.',
        'void email disallow <address> [options]',
      ),
      alias: {
        summary:
          'Show the project address on the shared mail domain, or give it a shorter name. The alias is permanent; the slug address keeps working.',
        usage: ['void email alias [options]', 'void email alias <name> [options]'],
        options: [
          { command: '--project <name>', description: 'Project name override' },
          { command: '--yes', description: 'Set the alias without asking (it cannot be changed)' },
        ],
      },
      // The one nested group: verbs parse in email-args.ts (`domain <add|status|list|sync|rotate-secret|remove>`).
      // Void-platform-only; custom inbound requires a zone apex.
      domain: {
        summary: 'Send and receive at your own domain on a Cloudflare zone.',
        usage: ['void email domain <verb> [<domain>] [options]'],
        commands: [
          {
            command: 'add <domain>',
            description: 'Register the domain with a scoped Cloudflare API token',
          },
          {
            command: 'status <domain>',
            description: 'Show inbound, outbound, management, and operation readiness',
          },
          { command: 'list', description: 'List registered email domains' },
          {
            command: 'rotate-secret <domain>',
            description: 'Rotate the shared zone ingress secret with a deployment probe',
          },
          {
            command: 'sync <domain>',
            description: 'Reconcile the zone connection and refresh readiness',
          },
          {
            command: 'remove <domain>',
            description: 'Disable the domain assignment and reconcile shared resources',
          },
        ],
        options: [{ command: '--project <name>', description: 'Project name override' }],
        children: {
          add: {
            summary: 'Register a Cloudflare zone apex you own for sending and receiving.',
            usage: ['void email domain add <domain> [options]'],
            options: [{ command: '--project <name>', description: 'Project name override' }],
          },
          status: withProjectOption(
            'Show a registered domain and its recorded readiness.',
            'void email domain status <domain> [options]',
          ),
          list: withProjectOption(
            'List registered email domains.',
            'void email domain list [options]',
          ),
          'rotate-secret': withProjectOption(
            'Rotate the shared zone ingress secret and verify the deployed generation.',
            'void email domain rotate-secret <domain> [options]',
          ),
          sync: withProjectOption(
            'Reconcile the zone connection and refresh readiness.',
            'void email domain sync <domain> [options]',
          ),
          remove: withProjectOption(
            'Disable the domain assignment and reconcile shared resources.',
            'void email domain remove <domain> [options]',
          ),
        },
      },
      // Native Cloudflare email: both read the local project + your wrangler session,
      // never a Void project, so neither takes `--project`.
      status: {
        summary: 'Show the email setup state and address map. Exit 1 when not ready.',
        usage: ['void email status --platform cloudflare'],
        options: [
          {
            command: '--platform cloudflare',
            description:
              'Your own Cloudflare account (required; on the Void platform use `void email usage`)',
          },
        ],
      },
      setup: {
        summary:
          'Set email up on your own Cloudflare account: enable Email Routing, onboard Email Sending, and record send_email + addresses in the Cloudflare config managed by Void. Asks once before changing the account.',
        usage: ['void email setup --platform cloudflare'],
        options: [
          {
            command: '--platform cloudflare',
            description: 'Your own Cloudflare account (required; the Void platform needs no setup)',
          },
        ],
      },
    },
  },
  github: {
    summary: 'Connect a GitHub repository for automatic deploys.',
    usage: ['void github <command>'],
    commands: [
      { command: 'install', description: 'Open the GitHub App install page in your browser' },
      { command: 'installations', description: 'List your GitHub App installations' },
      {
        command: 'connect [project]',
        description: 'Connect a repository to a project for auto-deploy',
      },
      {
        command: 'update [project]',
        description: "Update an existing connection's branch, build executor, or deploy workflow",
      },
      {
        command: 'status [project]',
        description: "Show a project's GitHub connection (repo, branch, executor, workflow)",
      },
      {
        command: 'disconnect [project]',
        description: 'Disconnect a project from its GitHub repository',
      },
      { command: 'link', description: 'Link your GitHub account to Void' },
      {
        command: 'join',
        description: "Join your organization's shared GitHub App installations",
      },
    ],
    children: {
      install: basicSubcommand(
        'Open the GitHub App install page in your browser.',
        'void github install',
      ),
      installations: basicSubcommand(
        'List your GitHub App installations.',
        'void github installations',
      ),
      link: basicSubcommand('Link your GitHub account to Void.', 'void github link'),
      join: basicSubcommand(
        "Join your organization's shared GitHub App installations.",
        'void github join',
      ),
      connect: {
        summary: 'Connect a repository to a project for automatic deploys.',
        usage: ['void github connect [project] [options]'],
        options: [
          { command: '--project <name>', description: 'Project name (alias for positional)' },
          { command: '--installation <id>', description: 'GitHub App installation ID' },
          { command: '--repo <owner/repo>', description: 'Repository full name (owner/repo)' },
          {
            command: '--branch <name>',
            description: 'Branch to deploy from (required in non-interactive mode)',
          },
          {
            command: '--executor <type>',
            description:
              'Build executor: container (default) | github_actions; prompted interactively when omitted',
          },
          {
            command: '--workflow <path>',
            description:
              'Authorized deploy workflow file (default .github/workflows/void-deploy.yml); prompted interactively when using github_actions',
          },
        ],
        examples: [
          {
            command: 'void github connect [project]',
            description: 'Connect a repository to a project',
          },
          {
            command: 'void github connect my-app --installation 42 --repo owner/repo --branch main',
            description: 'Non-interactive connect (all flags explicit)',
          },
          {
            command:
              'void github connect my-app --repo owner/repo --branch main --executor github_actions',
            description: 'Non-interactive connect using the GitHub Actions executor',
          },
        ],
      },
      update: {
        summary: "Update an existing connection's branch, build executor, or deploy workflow.",
        usage: ['void github update [project] [options]'],
        options: [
          { command: '--project <name>', description: 'Project name (alias for positional)' },
          { command: '--branch <name>', description: 'New branch to deploy from' },
          {
            command: '--executor <type>',
            description:
              'New build executor: container | github_actions; prompted interactively when omitted',
          },
          {
            command: '--workflow <path>',
            description:
              'New authorized deploy workflow file under .github/workflows/; prompted interactively when using github_actions',
          },
        ],
        examples: [
          {
            command: 'void github update my-app --executor github_actions',
            description: 'Switch an existing connection to the GitHub Actions executor',
          },
          {
            command: 'void github update my-app --branch release',
            description: 'Change the deploy branch',
          },
        ],
      },
      status: {
        summary: "Show a project's GitHub connection settings.",
        usage: ['void github status [project] [options]'],
        options: [
          { command: '--project <name>', description: 'Project name (alias for positional)' },
        ],
        examples: [
          {
            command: 'void github status',
            description: "Show the linked project's connection",
          },
          {
            command: 'void github status my-app',
            description: 'Show a specific project connection',
          },
        ],
      },
      disconnect: {
        summary: 'Disconnect a project from its GitHub repository.',
        usage: ['void github disconnect [project] [options]'],
        options: [
          { command: '--project <name>', description: 'Project name (alias for positional)' },
          {
            command: '--yes',
            description: 'Skip the confirmation prompt (required in non-interactive shells)',
          },
        ],
        examples: [
          {
            command: 'void github disconnect',
            description: "Disconnect the linked project's repository",
          },
          {
            command: 'void github disconnect my-app --yes',
            description: 'Disconnect a specific project without confirmation',
          },
        ],
      },
    },
  },
  build: {
    summary: 'Inspect remote builds.',
    usage: ['void build <command>'],
    commands: [
      { command: 'logs [build]', description: 'Stream, tail, or download logs for a build' },
    ],
    children: {
      logs: {
        summary: 'Stream, tail, or download logs for a build.',
        usage: ['void build logs [build] [options]'],
        options: [
          { command: '--follow, -f', description: 'Live-tail until the build finishes' },
          { command: '--output <file>, -o', description: 'Write logs to a file instead of stdout' },
          {
            command: '--project <slug>, -p',
            description: 'Target project (else linked / VOID_PROJECT)',
          },
        ],
        examples: [
          { command: 'void build logs', description: "Print the latest build's logs" },
          {
            command: 'void build logs -f',
            description: 'Follow the latest build until it finishes',
          },
          {
            command: 'void build logs bld_123 -o build.log',
            description: "Download a build's logs to a file",
          },
        ],
      },
    },
  },
  db: {
    summary: 'Manage local and remote database state.',
    usage: ['void db <command>'],
    commands: [
      {
        command: 'push',
        description: 'Push schema to the development database without migration files',
      },
      { command: 'generate', description: 'Generate SQL migrations from schema changes' },
      { command: 'status', description: 'Show migration status (local and remote)' },
      { command: 'reset', description: 'Reset local DB and re-run migrations' },
      { command: 'seed', description: 'Reset local DB, run migrations, and seed' },
      {
        command: 'execute <sql>',
        description: 'Run SQL against the database (--remote for deployed)',
      },
      { command: 'migrate', description: 'Apply pending migrations' },
      {
        command: 'studio',
        description: 'Open Drizzle Studio (--remote for deployed PostgreSQL/MySQL)',
      },
      { command: 'export', description: 'Export local database as SQL' },
      { command: 'connect', description: 'Connect or provision an external database' },
      { command: 'set-url', description: 'Update the external database URL' },
      {
        command: 'restore',
        description: 'Restore the deployed D1 database to an earlier point (direct Cloudflare)',
      },
      { command: 'rename-migrations', description: 'Rename migrations to timestamp format' },
    ],
    children: {
      push: basicSubcommand(
        'Push schema to the development database without migration files.',
        'void db push',
      ),
      generate: basicSubcommand('Generate SQL migrations from schema changes.', 'void db generate'),
      status: basicSubcommand('Show migration status for local and remote DBs.', 'void db status'),
      reset: {
        summary: 'Reset local DB and re-run migrations.',
        usage: ['void db reset [options]'],
        options: [
          {
            command: '--yes',
            description: 'Skip the prompt for a non-local PostgreSQL/MySQL database',
          },
        ],
      },
      seed: {
        summary: 'Reset local DB, run migrations, and seed data.',
        usage: ['void db seed [options]'],
        options: [
          { command: '--file <path>', description: 'Seed from a specific file' },
          {
            command: '--yes',
            description: 'Skip the prompt for a non-local PostgreSQL/MySQL database',
          },
        ],
      },
      execute: {
        summary:
          'Run SQL against the database (local by default; use --remote for the deployed database).',
        usage: ['void db execute <sql>', 'void db execute --file <path>'],
        options: [
          { command: '--file <path>', description: 'Run SQL from a file instead' },
          {
            command: '--remote',
            description:
              'Run against the deployed database (D1 via proxy; PostgreSQL via direct connection)',
          },
        ],
        examples: [
          { command: 'void db execute "select * from users"', description: 'Run inline SQL' },
          { command: 'void db execute --file query.sql', description: 'Run SQL from a file' },
          {
            command: 'void db execute --remote "select count(*) from users"',
            description: 'Query the deployed database',
          },
        ],
      },
      migrate: {
        summary: 'Apply pending migrations.',
        usage: ['void db migrate [options]'],
        options: [{ command: '--remote', description: 'Apply to the remote database' }],
      },
      studio: {
        summary:
          'Open Drizzle Studio against the database (local by default; use --remote for the deployed PostgreSQL or MySQL database).',
        usage: ['void db studio [options]'],
        options: [
          {
            command: '--remote',
            description: 'Open Studio against the deployed PostgreSQL or MySQL database (not D1)',
          },
        ],
        examples: [
          { command: 'void db studio', description: 'Open Studio for the local database' },
          {
            command: 'void db studio --remote',
            description: 'Open Studio against the deployed PostgreSQL or MySQL database',
          },
        ],
      },
      export: {
        summary: 'Export local database contents as SQL.',
        usage: ['void db export [options]'],
        options: [
          { command: '--output <path>', description: 'Export to a specific file path' },
          { command: '--no-data', description: 'Schema only (no INSERT statements)' },
          { command: '--no-schema', description: 'Data only (no CREATE TABLE)' },
          { command: '--table <name>', description: 'Export a single table' },
        ],
      },
      connect: {
        summary: 'Connect or provision an external PostgreSQL/MySQL database.',
        usage: [
          'void db connect [connection-string]',
          'void db connect --provider <name-or-module> [options]',
        ],
        options: [
          { command: '--provider <name-or-module>', description: 'Provision with an adapter' },
          { command: '--name <name>', description: 'Provider project/database name' },
          { command: '--region <region>', description: 'Provider region identifier' },
          { command: '--local-only', description: 'Do not sync a linked Void project' },
        ],
        examples: [
          {
            command: 'void db connect "postgresql://user:pass@host/db"',
            description: 'Connect an existing database',
          },
          {
            command: 'void db connect --provider neon --name my-app',
            description: 'Provision a Neon database using NEON_API_KEY',
          },
        ],
      },
      'set-url': basicSubcommand(
        'Update the external database connection string for deployment.',
        'void db set-url',
      ),
      restore: {
        summary:
          'Restore the deployed D1 database of a direct Cloudflare deploy to an earlier point. Discards every later write.',
        usage: [
          'void db restore --bookmark <bookmark> [--platform cloudflare] [--yes]',
          'void db restore --timestamp <iso-time> [--platform cloudflare] [--yes]',
        ],
        options: [
          { command: '--bookmark <bookmark>', description: 'Restore point printed by deploy' },
          {
            command: '--timestamp <iso-time>',
            description: 'Time with Z or an offset (7 days back on Workers Free, 30 on Paid)',
          },
          {
            command: '--platform cloudflare',
            description: 'Restore after a one-off deploy with --platform cloudflare',
          },
          {
            command: '--yes',
            description: 'Skip the confirmation prompt (required without a TTY)',
          },
        ],
        examples: [
          {
            command: 'void db restore --bookmark 00000085-0000024c-00004ef2-0a83ea2f',
            description: 'Undo the migrations of a deploy',
          },
          {
            command: 'void db restore --timestamp 2026-10-16T09:30:00Z',
            description: 'Restore the database to a time',
          },
        ],
      },
      'rename-migrations': basicSubcommand(
        'Rename migrations to timestamp-based format.',
        'void db rename-migrations',
      ),
    },
  },
  env: {
    summary: 'Validate env.ts and generate environment types.',
    usage: ['void env <command>'],
    commands: [
      { command: 'check', description: 'Validate local .env or remote secret names' },
      { command: 'types', description: 'Regenerate .void/env.d.ts from env.ts' },
    ],
    children: {
      check: {
        summary: 'Validate local .env or required remote secret names.',
        usage: ['void env check [options]'],
        options: [
          { command: '--remote', description: 'Check required server keys as remote secrets' },
        ],
      },
      types: basicSubcommand('Regenerate .void/env.d.ts from env.ts.', 'void env types'),
    },
  },
  gen: {
    summary: 'Scaffold routes, models, background jobs, and framework entries.',
    usage: ['void gen <command>'],
    commands: [
      {
        command: 'model <name> [cols...]',
        description: 'Scaffold a Drizzle table, API routes, and DB types',
      },
      { command: 'migration <name>', description: 'Generate an empty migration file' },
      { command: 'route <path>', description: 'Generate a route with handler exports' },
      { command: 'middleware <name>', description: 'Generate a numbered middleware file' },
      { command: 'ssr', description: 'Generate SSR entry, client, and App component' },
      { command: 'cron <name>', description: 'Generate a cron job file' },
      { command: 'queue <name>', description: 'Generate a queue consumer file' },
    ],
    children: {
      model: {
        summary: 'Scaffold a Drizzle table, list/create/get API routes, and database types.',
        usage: ['void gen model <name> [columns...]'],
        examples: [
          { command: 'void gen model post title:string body:text', description: 'Create a model' },
        ],
      },
      migration: basicSubcommand('Generate an empty migration file.', 'void gen migration <name>'),
      route: {
        summary: 'Generate a route with handler exports.',
        usage: ['void gen route <path> [options]'],
        options: [
          { command: '--methods <list>', description: 'Comma-separated methods (default: get)' },
        ],
        examples: [
          { command: 'void gen route api/posts --methods get,post', description: 'Create a route' },
        ],
      },
      middleware: basicSubcommand(
        'Generate a numbered middleware file.',
        'void gen middleware <name>',
      ),
      ssr: {
        summary: 'Generate SSR entry, client, and App component.',
        usage: ['void gen ssr [options]'],
        options: [
          { command: '--react', description: 'Use React' },
          { command: '--vue', description: 'Use Vue' },
          { command: '--svelte', description: 'Use Svelte' },
          { command: '--solid', description: 'Use Solid' },
        ],
      },
      cron: basicSubcommand('Generate a cron job file.', 'void gen cron <name>'),
      queue: basicSubcommand('Generate a queue consumer file.', 'void gen queue <name>'),
    },
  },
  info: {
    summary: 'Inspect persistent resource names in this project without deploying.',
    usage: ['void info [--json]'],
    options: [{ command: '--json', description: 'Write structured JSON to stdout' }],
    examples: [
      {
        command: 'void info',
        description: 'Find names to preserve before moving persistent definitions',
      },
    ],
  },
  prepare: {
    summary: 'Generate .void artifacts without starting Vite.',
    usage: ['void prepare'],
    examples: [{ command: 'void prepare', description: 'Refresh generated project types' }],
  },
};

function basicSubcommand(summary: string, usage: string, example?: string): HelpPage {
  return {
    summary,
    usage: [usage],
    examples: example ? [{ command: example, description: summary }] : undefined,
  };
}

function withProjectOption(summary: string, usage: string): HelpPage {
  return {
    summary,
    usage: [usage],
    options: [{ command: '--project <name>', description: 'Project name override' }],
  };
}

function lifecycleHelp(
  command: 'upgrade' | 'repair' | 'disable' | 'enable',
  summary: string,
): HelpPage {
  return {
    summary,
    usage: [
      `void platform ${command} [id] [--plan]${command === 'disable' ? '' : ' [--runtime <path>]'}${command === 'upgrade' || command === 'repair' ? ' [--dashboard-url <origin>] [--custom-domains]' : ''}${command === 'repair' ? ' [--auth-config <path>]' : ''} [--yes]`,
    ],
    options: [
      { command: '--plan', description: 'Print the exact plan without making changes' },
      ...(command === 'disable'
        ? []
        : [
            {
              command: '--runtime <path>',
              description: 'Deploy an integrity-checked runtime directory instead of the package',
            },
          ]),
      ...(command === 'upgrade' || command === 'repair'
        ? [
            {
              command: '--dashboard-url <origin>',
              description:
                'Configure a separately deployed dashboard; omission keeps its saved origin',
            },
            {
              command: '--custom-domains',
              description: 'Turn on project custom domains; omission keeps the saved setting',
            },
          ]
        : []),
      ...(command === 'repair'
        ? [
            {
              command: '--auth-config <path>',
              description:
                'While first administrator setup is pending, replace its login settings (install file format)',
            },
          ]
        : []),
      { command: '--yes', description: 'Acknowledge non-interactive Cloudflare changes' },
    ],
  };
}

export function printGlobalHelp(): void {
  printVoidHeader();

  note(
    [
      globalCommandLine(['init'], 'void init'),
      ...globalOptionLines(['init']),
      '',
      globalCommandLine(['migrate'], 'void migrate'),
      '',
      globalCommandLine(['info'], 'void info [--json]'),
      '',
      globalCommandLine(['connect'], 'void connect [url]'),
      ...globalOptionLines(['connect']),
      '',
      globalCommandLine(['deploy'], 'void deploy'),
      ...globalOptionLines(['deploy']),
      '',
      ...globalCommandGroup('auth'),
      '',
      ...globalCommandGroup('account'),
      '',
      ...globalCommandGroup('cloudflare'),
      '',
      ...globalCommandGroup('platform'),
      '',
      ...globalCommandGroup('project'),
      '',
      categoryTitle('secrets'),
      ...globalCommandLines('secret'),
      '',
      ...globalCommandGroup('domain'),
      '',
      ...globalCommandGroup('email'),
      '',
      ...globalCommandGroup('github'),
      '',
      ...globalCommandGroup('build'),
      '',
      categoryTitle('database'),
      ...globalCommandLines('db', {
        execute: 'execute <sql>',
        export: 'export [--output <path>]',
        seed: 'seed [--file <path>]',
        restore: 'restore --bookmark <b>',
      }),
      ...globalOptionLines(['db', 'execute']),
      ...globalOptionLines(['db', 'export']),
      '',
      ...globalCommandGroup('env'),
      ...globalOptionLines(['env', 'check']),
      '',
      categoryTitle('codegen'),
      globalCommandLine(['prepare'], 'void prepare'),
      ...globalCommandLines('gen', { route: 'route <path> [--methods]' }),
      '',
      categoryTitle('help'),
      helpLine('void help <command>', 'Show command-specific help'),
      helpLine('void <command> --help', 'Show command-specific help'),
    ].join('\n'),
    sectionTitle('Commands'),
  );

  note(
    [
      helpLine('VOID_TOKEN', 'Auth token (or use `void account login`)'),
      helpLine('VOID_PROJECT', 'Deploy target project name override'),
    ].join('\n'),
    sectionTitle('Environment'),
  );

  outro(formatUrl('https://void.cloud'));
}

export function printVoidHeader(): void {
  const version = getOwnVersion();
  const art = asciiArts[Math.floor(Math.random() * asciiArts.length)];
  console.log(pc.blue(`${art}  v${version}\n`));
}

export function getHelpPath(args: Array<string>): Array<string> | null {
  if (args.length === 0) {
    return null;
  }

  const command = args[0];
  if (command === 'help') {
    return args.slice(1);
  }
  if (command === '--help' || command === '-h') {
    return [];
  }
  if (args[1] === 'help') {
    return [command, ...args.slice(2)];
  }

  const helpIndex = args.findIndex((arg) => arg === '--help' || arg === '-h');
  if (helpIndex === -1) {
    return null;
  }

  return getKnownHelpPrefix(args.slice(0, helpIndex));
}

export function hasHelpPage(path: Array<string>): boolean {
  return findHelpPage(path) !== null;
}

export function printHelpPage(path: Array<string>): void {
  const page = findHelpPage(path);
  if (!page) {
    throw new Error(`Unknown help topic: ${formatHelpPath(path)}`);
  }

  const lines = [
    page.summary,
    '',
    categoryTitle('Usage'),
    ...page.usage.map((usage) => `  ${usage}`),
  ];

  appendHelpSection(lines, 'Commands', page.commands);
  appendHelpSection(lines, 'Options', page.options);
  appendHelpSection(lines, 'Examples', page.examples);

  if (page.commands) {
    lines.push('', `Run \`void help ${path.join(' ')} <command>\` for command-specific help.`);
  }

  note(lines.join('\n'), sectionTitle(`void ${path.join(' ')}`));
}

function appendHelpSection(
  lines: Array<string>,
  title: string,
  entries: Array<HelpCommand> | undefined,
): void {
  if (!entries || entries.length === 0) {
    return;
  }

  lines.push('', categoryTitle(title));
  for (const entry of entries) {
    lines.push(helpLine(entry.command, entry.description));
  }
}

function globalCommandGroup(group: keyof typeof HELP_TREE): Array<string> {
  return [categoryTitle(group), ...globalCommandLines(group)];
}

function globalCommandLines(
  group: keyof typeof HELP_TREE,
  commandOverrides?: Record<string, string>,
): Array<string> {
  const page = requiredPage([group]);
  return (page.commands ?? []).map((command) =>
    helpLine(
      `void ${group} ${commandOverrides?.[command.command.split(' ')[0]] ?? command.command}`,
      command.description,
    ),
  );
}

function globalCommandLine(path: Array<string>, command: string): string {
  return helpLine(command, formatGlobalDescription(requiredPage(path).summary));
}

function globalOptionLines(path: Array<string>): Array<string> {
  const page = requiredPage(path);
  return (page.options ?? []).map((option) => helpLine(`  ${option.command}`, option.description));
}

function requiredPage(path: Array<string>): HelpPage {
  const page = findHelpPage(path);
  if (!page) {
    throw new Error(`Missing help page: ${formatHelpPath(path)}`);
  }
  return page;
}

function formatGlobalDescription(summary: string): string {
  return summary.replace(/\.$/, '');
}

function findHelpPage(path: Array<string>): HelpPage | null {
  let tree: HelpTree | undefined = HELP_TREE;
  let page: HelpPage | null = null;

  for (const part of path) {
    const node: HelpNode | undefined = tree?.[part];
    if (!node) {
      return null;
    }
    page = node;
    tree = node.children;
  }

  return page;
}

function getKnownHelpPrefix(args: Array<string>): Array<string> {
  let tree: HelpTree | undefined = HELP_TREE;
  const path: Array<string> = [];

  for (const arg of args) {
    if (arg.startsWith('-')) {
      break;
    }
    const node: HelpNode | undefined = tree?.[arg];
    if (!node) {
      if (path.length === 0) {
        return [arg];
      }
      if (tree) {
        return [...path, arg];
      }
      break;
    }
    path.push(arg);
    tree = node.children;
  }

  return path;
}

function formatHelpPath(path: Array<string>): string {
  return path.length === 0 ? 'help' : path.join(' ');
}
