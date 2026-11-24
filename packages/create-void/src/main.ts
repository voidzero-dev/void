import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cancel, isCancel, log, outro, text } from '@voidzero-dev/vite-plus-prompts';
import { resolve } from 'pathslash';
import pc from 'picocolors';
import { parseCreateArgs, validateProjectName } from './args.ts';
import { detectPM, pmExec, pmInstall, run, writePnpmBuildPolicy } from './pm.ts';

const pm = detectPM();

async function main() {
  console.log();

  const createArgs = parseCreateArgs(process.argv.slice(2));
  let appName = createArgs.appName;

  if (!appName && !process.stdin.isTTY) {
    log.error('create-void: Pass a project name when running without an interactive terminal.');
    process.exit(1);
  }

  if (!appName) {
    const name = await text({
      message: 'Project name:',
      defaultValue: 'my-app',
      placeholder: 'my-app',
      validate: validateProjectName,
    });
    if (isCancel(name) || typeof name !== 'string') {
      cancel('Cancelled.');
      process.exit(0);
    }
    appName = name;
  }

  const targetDir = resolve(appName);

  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      log.error(`create-void: Directory '${pc.bold(appName)}' is not empty.`);
      process.exit(1);
    }
  }

  // The release publishes the scaffolder and CLI at the same version. Preserve
  // that exact version, including prereleases, instead of switching to latest.
  const { version: voidVersion } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  mkdirSync(targetDir, { recursive: true });

  const pkg = {
    name: appName,
    private: true,
    type: 'module',
    devDependencies: {
      void: voidVersion,
    },
  };

  writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  // pnpm 12 fails the first install when a dependency has an unapproved build
  // script. Write Void's narrow policy before installing the CLI so a fresh
  // project can bootstrap without disabling pnpm's build-script protection.
  writePnpmBuildPolicy(targetDir, pm);

  log.step('Installing Void...');
  await run(pmInstall(pm), targetDir);

  log.step('Scaffolding starter...');
  await run([...pmExec(pm), 'void', 'init', ...createArgs.initArgs], targetDir);

  log.step('Installing starter dependencies...');
  await run(pmInstall(pm), targetDir);

  outro(`\n${pc.green(`✓ Created ${appName}`)}`, { withGuide: false });
  outro(`cd ${appName} && ${pm === 'npm' ? 'npm run' : pm} dev`);
}

await main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
