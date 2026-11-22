import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import * as p from '@voidzero-dev/vite-plus-prompts';
import { resolve } from 'pathslash';
import pc from 'picocolors';
import { parseCreateArgs, validateProjectName } from './args.ts';
import { detectPM, runVoidInit } from './pm.ts';

const pm = detectPM();

async function main() {
  console.log();

  const createArgs = parseCreateArgs(process.argv.slice(2));
  let appName = createArgs.appName;

  if (!appName && !process.stdin.isTTY) {
    p.log.error('create-void: Pass a project name when running without an interactive terminal.');
    process.exit(1);
  }

  if (!appName) {
    const name = await p.text({
      message: 'Project name:',
      defaultValue: 'my-app',
      placeholder: 'my-app',
      validate: validateProjectName,
    });
    if (p.isCancel(name) || typeof name !== 'string') {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    appName = name;
  }

  const targetDir = resolve(appName);

  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      p.log.error(`create-void: Directory '${pc.bold(appName)}' is not empty.`);
      process.exit(1);
    }
  }

  // The release publishes the scaffolder and CLI at the same version. Preserve
  // that exact version, including prereleases, instead of switching to latest.
  const { version: voidVersion } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  mkdirSync(targetDir, { recursive: true });

  p.log.step('Scaffolding starter...');
  await runVoidInit(pm, voidVersion, createArgs.initArgs, targetDir);

  p.outro(`\n${pc.green(`✓ Created ${appName}`)}`, { withGuide: false });
  p.outro(`cd ${appName} && ${pm === 'npm' ? 'npm run' : pm} dev`);
}

main().catch((err) => {
  p.log.error(err.message);
  process.exit(1);
});
