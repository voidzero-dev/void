#!/usr/bin/env node

import { log } from '@voidzero-dev/vite-plus-prompts';
import { accountSubcommands, parseAccountArgs } from './account-args.ts';
import { getOwnVersion } from './agents.ts';
import { parseDeployArgs } from './args.ts';
import { authSubcommands, parseAuthArgs } from './auth-args.ts';
import { buildSubcommands, parseBuildArgs } from './build-args.ts';
import { cloudflareSubcommands, parseCloudflareArgs } from './cloudflare-args.ts';
import { formatCloudflareUserMessage } from './cloudflare-user-output.ts';
import { parseConnectArgs } from './connect-args.ts';
import { dbSubcommands, parseDbArgs } from './db-args.ts';
import { domainSubcommands, parseDomainArgs } from './domain-args.ts';
import { emailSubcommands, parseEmailArgs } from './email-args.ts';
import { envSubcommands, parseEnvArgs } from './env-args.ts';
import { genSubcommands, parseGenArgs } from './gen-args.ts';
import { githubSubcommands, parseGithubArgs } from './github-args.ts';
import { getHelpPath, printGlobalHelp, printHelpPage, printVoidHeader } from './help.ts';
import { parseInfoArgs } from './info-args.ts';
import { operatorGroups } from './operator-args.ts';
import { OperatorClientError } from './operator-client.ts';
import { formatUrl, pc } from './output.ts';
import { parsePlatformArgs, platformSubcommands } from './platform-args.ts';
import { parsePrepareArgs } from './prepare-args.ts';
import { projectSubcommands, parseProjectArgs } from './project-args.ts';
import { secretSubcommands, parseSecretArgs } from './secret-args.ts';
import type { SubcommandDef, SubcommandResult } from './subcommand-prompt.ts';

function buildArgs(result: SubcommandResult, trailingArgs: Array<string>): Array<string> {
  const out = [result.subcommand];
  if (result.arg) {
    out.push(result.arg);
  }
  if (result.extraArgs) {
    out.push(...result.extraArgs);
  }
  if (result.flags) {
    for (const [flag, value] of Object.entries(result.flags)) {
      out.push(flag);
      if (typeof value === 'string') {
        out.push(value);
      }
    }
  }
  for (const a of trailingArgs) {
    if (a.startsWith('-')) {
      out.push(a);
    }
  }
  return out;
}

async function runSubcommandGroup<T>(
  command: string,
  subcommands: Array<SubcommandDef>,
  parse: (args: Array<string>) => T,
  run: (root: string, parsed: T) => Promise<void>,
) {
  const root = process.cwd();
  const sub = args[1];
  const hasNamedSubcommand = args
    .slice(1)
    .some((arg) => subcommands.some(({ name }) => name === arg));
  try {
    if ((!sub || (sub.startsWith('-') && !hasNamedSubcommand)) && process.stdin.isTTY) {
      const { promptSubcommand } = await import('./subcommand-prompt.ts');
      if (command === 'platform' && !sub) {
        log.info(
          'A Void platform lets a team deploy Void apps to a shared Cloudflare account.\n' +
            'This command sets up and manages platforms. Join with `void connect <url>`.\n' +
            `Docs: ${formatUrl('https://void.cloud/guide/self-hosted-platform')}`,
        );
      }
      const result = await promptSubcommand(command, subcommands);
      if (!result) {
        process.exit(0);
      }
      const parsed = parse(buildArgs(result, args.slice(1)));
      await run(root, parsed);
    } else {
      const parsed = parse(args.slice(1));
      await run(root, parsed);
    }
  } catch (err) {
    if (command === 'platform' && args.includes('--json')) {
      console.error(
        JSON.stringify(
          err instanceof OperatorClientError
            ? err.toJSON()
            : {
                error: 'invalid_command',
                message: err instanceof Error ? err.message : String(err),
              },
        ),
      );
      process.exit(1);
    }
    const message = formatCloudflareUserMessage(err instanceof Error ? err.message : String(err));
    if (command === 'platform') {
      const platformMessage = message.replace(/^platform:/, pc.bold(pc.red('platform:')));
      console.error(
        err instanceof OperatorClientError && err.details !== undefined
          ? `${platformMessage}\nPartial result:\n${JSON.stringify(err.details, null, 2)}`
          : platformMessage,
      );
    } else {
      log.error(message);
    }
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const command = args[0];
const helpPath = getHelpPath(args);

const subcommandGroups: Record<string, () => Promise<void>> = {
  auth: () =>
    runSubcommandGroup('auth', authSubcommands, parseAuthArgs, (root, parsed) =>
      import('./auth-router.ts').then(({ runAuthRouter }) => runAuthRouter(root, parsed)),
    ),
  account: () =>
    runSubcommandGroup('account', accountSubcommands, parseAccountArgs, (root, parsed) =>
      import('./account-cmd.ts').then(({ runAccountCommand }) => runAccountCommand(root, parsed)),
    ),
  platform: () =>
    runSubcommandGroup('platform', platformSubcommands, parsePlatformArgs, (root, parsed) =>
      import('./platform-cmd.ts').then(({ runPlatformCommand }) =>
        runPlatformCommand(root, parsed),
      ),
    ),
  cloudflare: () =>
    runSubcommandGroup('cloudflare', cloudflareSubcommands, parseCloudflareArgs, (root, parsed) =>
      import('./cloudflare-cmd.ts').then(({ runCloudflareCommand }) =>
        runCloudflareCommand(root, parsed),
      ),
    ),
  project: () =>
    runSubcommandGroup('project', projectSubcommands, parseProjectArgs, (root, parsed) =>
      import('./project-cmd.ts').then(({ runProjectCommand }) => runProjectCommand(root, parsed)),
    ),
  secret: () =>
    runSubcommandGroup('secret', secretSubcommands, parseSecretArgs, (root, parsed) =>
      import('./secret.ts').then(({ runSecretCommand }) => runSecretCommand(root, parsed)),
    ),
  domain: () =>
    runSubcommandGroup('domain', domainSubcommands, parseDomainArgs, (root, parsed) =>
      import('./domain.ts').then(({ runDomainCommand }) => runDomainCommand(root, parsed)),
    ),
  email: () =>
    runSubcommandGroup('email', emailSubcommands, parseEmailArgs, (root, parsed) =>
      import('./email.ts').then(({ runEmailCommand }) => runEmailCommand(root, parsed)),
    ),
  db: () =>
    runSubcommandGroup('db', dbSubcommands, parseDbArgs, (root, parsed) =>
      import('./db.ts').then(({ runDbCommand }) => runDbCommand(root, parsed)),
    ),
  env: () =>
    runSubcommandGroup('env', envSubcommands, parseEnvArgs, (root, parsed) =>
      import('./env.ts').then(({ runEnvCommand }) => runEnvCommand(root, parsed)),
    ),
  gen: () =>
    runSubcommandGroup('gen', genSubcommands, parseGenArgs, (root, parsed) =>
      import('./gen.ts').then(({ runGenCommand }) => runGenCommand(root, parsed)),
    ),
  github: () =>
    runSubcommandGroup('github', githubSubcommands, parseGithubArgs, (root, parsed) =>
      import('./github-cmd.ts').then(({ runGithubCommand }) => runGithubCommand(root, parsed)),
    ),
  build: () =>
    runSubcommandGroup('build', buildSubcommands, parseBuildArgs, (root, parsed) =>
      import('./build-cmd.ts').then(({ runBuildCommand }) => runBuildCommand(root, parsed)),
    ),
};

if (helpPath) {
  if (helpPath.length === 0) {
    printGlobalHelp();
  } else {
    try {
      printHelpPage(helpPath);
    } catch (err) {
      log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }
} else if (command === 'deploy') {
  const root = process.cwd();
  let deployArgs;
  try {
    deployArgs = parseDeployArgs(args.slice(1));
  } catch (err) {
    log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  import('./deploy.ts').then(({ runDeploy }) => {
    runDeploy(root, deployArgs).catch((err) => {
      log.error(formatCloudflareUserMessage(err.message ?? String(err)));
      process.exit(1);
    });
  });
} else if (command === 'connect') {
  (async () => {
    const parsed = parseConnectArgs(args.slice(1));
    const { runConnectCommand } = await import('./connect.ts');
    await runConnectCommand(process.cwd(), parsed);
  })().catch((err) => {
    log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
} else if (command && Object.hasOwn(subcommandGroups, command)) {
  subcommandGroups[command]!();
} else if (command === 'info') {
  import('./info.ts').then(async ({ runInfoCommand }) => {
    try {
      await runInfoCommand(process.cwd(), parseInfoArgs(args.slice(1)));
    } catch (err) {
      const message = formatCloudflareUserMessage(err instanceof Error ? err.message : String(err));
      if (args.includes('--json')) {
        console.error(JSON.stringify({ error: 'invalid_command', message }));
      } else {
        log.error(message);
      }
      process.exit(1);
    }
  });
} else if (command === 'prepare') {
  const root = process.cwd();
  try {
    parsePrepareArgs(args.slice(1));
  } catch (err) {
    log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  import('./prepare.ts').then(({ runPrepareCommand }) => {
    runPrepareCommand(root).catch((err) => {
      log.error(formatCloudflareUserMessage(err.message ?? String(err)));
      process.exit(1);
    });
  });
} else if (command === 'init') {
  const root = process.cwd();
  import('./init.ts').then(({ runInitCommand, parseInitArgs }) => {
    let initArgs;
    try {
      initArgs = parseInitArgs(args.slice(1));
    } catch (err) {
      log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
    runInitCommand(root, initArgs).catch((err) => {
      log.error(formatCloudflareUserMessage(err.message ?? String(err)));
      process.exit(1);
    });
  });
} else if (command === 'migrate') {
  if (args.length > 1) {
    log.error('migrate: This command takes no arguments.');
    process.exit(1);
  }
  import('./migrate.ts').then(({ runMigrateCommand }) => {
    runMigrateCommand(process.cwd()).catch((err) => {
      log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    });
  });
} else if (command === '-v' || command === '--version') {
  console.log(getOwnVersion());
} else if (command) {
  log.error(`cli: Unknown command '${command}'. Run \`void --help\` for usage.`);
  process.exit(1);
} else if (!command && process.stdin.isTTY) {
  // Interactive top-level prompt
  const topLevelCommands: Array<SubcommandDef> = [
    {
      name: 'init',
      hint: '--tsconfig | --github | --git | --no-git',
      description: 'Set up void in a new or existing project',
    },
    { name: 'migrate', description: 'Migrate legacy project configuration' },
    {
      name: 'info',
      hint: '--json',
      description: 'Inspect persistent resource names in this project',
    },
    { name: 'connect', description: 'Connect to Cloudflare or a Void platform' },
    { name: 'deploy', description: 'Build and deploy, or link an existing Cloudflare Worker' },
    {
      name: 'auth',
      hint: 'login | status | logout',
      description: 'Sign in to this project’s Cloudflare or Void destination',
    },
    {
      name: 'account',
      hint: 'login | link | logout | whoami | token',
      description: 'Manage your Void platform account',
    },
    {
      name: 'platform',
      hint: ['config', ...operatorGroups, 'install'].join(' | '),
      description:
        'Install platforms and administer plans, users, projects, access, and operations',
    },
    {
      name: 'cloudflare',
      hint: 'login | status | logout',
      description: 'Manage Cloudflare sign-in and inspect the deployment account',
    },
    {
      name: 'project',
      hint: 'status | link | list | team | token | zero-trust | logs | requests | rollback | cancel | delete | purge-cache',
      description: 'Manage projects, teams, deployments, and scoped CI credentials',
    },
    { name: 'secret', hint: 'list | put | delete | sync', description: 'Manage project secrets' },
    {
      name: 'domain',
      hint: 'add | delete | list | status',
      description: 'Configure custom domains',
    },
    {
      name: 'email',
      hint: 'usage | logs | destinations | allow | disallow | alias | domain | status | setup',
      description: 'Inspect email activity and manage verified recipients',
    },
    {
      name: 'github',
      hint: 'install | installations | connect | update | status | disconnect | link | join',
      description: 'Connect a GitHub repository for automatic deploys',
    },
    {
      name: 'build',
      hint: 'logs',
      description: 'Inspect remote builds',
    },
    {
      name: 'db',
      hint: dbSubcommands.map(({ name }) => name).join(' | '),
      description: 'Database migrations and management',
    },
    {
      name: 'env',
      hint: 'check | types',
      description: 'Validate env.ts or generate types',
    },
    {
      name: 'gen',
      hint: 'model | migration | route | middleware | ssr | cron | queue',
      description: 'Scaffold routes, models, and more',
    },
    {
      name: 'prepare',
      description: 'Generate .void artifacts without starting Vite',
    },
    { name: 'help', description: 'Show help message' },
  ];

  (async () => {
    printVoidHeader();

    const { promptSubcommand } = await import('./subcommand-prompt.ts');
    const result = await promptSubcommand('', topLevelCommands);
    if (!result) {
      process.exit(0);
    }

    const cmd = result.subcommand;
    const root = process.cwd();

    if (Object.hasOwn(subcommandGroups, cmd)) {
      return subcommandGroups[cmd]!();
    }

    switch (cmd) {
      case 'connect': {
        const { runConnectCommand } = await import('./connect.ts');
        await runConnectCommand(root, parseConnectArgs([]));
        return;
      }
      case 'init': {
        const { runInitCommand, parseInitArgs } = await import('./init.ts');
        await runInitCommand(root, parseInitArgs([]));
        return;
      }
      case 'migrate': {
        const { runMigrateCommand } = await import('./migrate.ts');
        await runMigrateCommand(root);
        return;
      }
      case 'deploy': {
        const { runDeploy } = await import('./deploy.ts');
        await runDeploy(root);
        return;
      }
      case 'info': {
        const { runInfoCommand } = await import('./info.ts');
        await runInfoCommand(root, parseInfoArgs([]));
        return;
      }
      case 'prepare': {
        const { runPrepareCommand } = await import('./prepare.ts');
        await runPrepareCommand(root);
        return;
      }
      case 'help':
        printGlobalHelp();
        return;
    }
  })().catch((err) => {
    log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
} else {
  printGlobalHelp();
}
