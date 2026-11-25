#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
// The link must use native filesystem paths so Windows launchers and symlink targets stay valid.
// oxlint-disable-next-line no-restricted-imports
import { dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const localCliPath = join(repositoryRoot, 'packages/void/dist/cli/cli.mjs');

export function resolvePnpmGlobalBin(runPnpm = defaultRunPnpm) {
  const result = runPnpm(['bin', '--global']);
  if (result.status !== 0) {
    throw new Error(
      `Could not find pnpm's global bin directory.${result.stderr ? `\n${result.stderr.trim()}` : ''}`,
    );
  }
  const globalBin = result.stdout.trim();
  if (!globalBin) {
    throw new Error('pnpm returned an empty global bin directory.');
  }
  return resolve(globalBin);
}

export function installVoidDev({ cliPath, globalBin, platform = process.platform }) {
  const cli = resolve(cliPath);
  const cliEntry = readEntry(cli);
  if (!cliEntry?.isFile()) {
    throw new Error(`The local Void CLI has not been built at ${cli}.`);
  }

  mkdirSync(globalBin, { recursive: true });
  const commandPath = voidDevCommandPath(globalBin, platform);
  const current = readEntry(commandPath);

  if (platform === 'win32') {
    const expected = windowsLauncher(cli);
    if (current) {
      if (current.isFile() && readFileSync(commandPath, 'utf8') === expected) {
        return { action: 'already-installed', commandPath };
      }
      throw occupiedCommandError(commandPath);
    }
    writeFileSync(commandPath, expected, { encoding: 'utf8', mode: 0o755 });
  } else {
    if (current) {
      if (current.isSymbolicLink() && linkedTarget(commandPath) === cli) {
        return { action: 'already-installed', commandPath };
      }
      throw occupiedCommandError(commandPath);
    }
    symlinkSync(cli, commandPath, 'file');
  }

  return { action: 'installed', commandPath };
}

export function uninstallVoidDev({ cliPath, globalBin, platform = process.platform }) {
  const cli = resolve(cliPath);
  const commandPath = voidDevCommandPath(globalBin, platform);
  const current = readEntry(commandPath);
  if (!current) {
    return { action: 'not-installed', commandPath };
  }

  const owned =
    platform === 'win32'
      ? current.isFile() && readFileSync(commandPath, 'utf8') === windowsLauncher(cli)
      : current.isSymbolicLink() && linkedTarget(commandPath) === cli;
  if (!owned) {
    throw occupiedCommandError(commandPath, 'Refusing to remove it');
  }

  rmSync(commandPath);
  return { action: 'removed', commandPath };
}

function defaultRunPnpm(args) {
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stderr: result.stderr || '',
    stdout: result.stdout || '',
  };
}

function linkedTarget(commandPath) {
  return resolve(dirname(commandPath), readlinkSync(commandPath));
}

function occupiedCommandError(commandPath, action = 'Refusing to overwrite it') {
  return new Error(`${commandPath} already exists and is not this checkout's Void CLI. ${action}.`);
}

function readEntry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function voidDevCommandPath(globalBin, platform) {
  return join(globalBin, platform === 'win32' ? 'void-dev.cmd' : 'void-dev');
}

function windowsLauncher(cliPath) {
  const escapedCliPath = cliPath.replaceAll('%', '%%').replaceAll('"', '""');
  return `@REM void-dev local checkout launcher\r\n@node "${escapedCliPath}" %*\r\n`;
}

function globalBinIsOnPath(globalBin, environment = process.env) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return (environment.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => resolve(entry) === resolve(globalBin));
}

function run() {
  const operation = process.argv[2];
  if (operation !== 'install' && operation !== 'uninstall') {
    throw new Error('Usage: node scripts/void-dev-link.mjs <install|uninstall>');
  }

  const globalBin = resolvePnpmGlobalBin();
  const result =
    operation === 'install'
      ? installVoidDev({ cliPath: localCliPath, globalBin })
      : uninstallVoidDev({ cliPath: localCliPath, globalBin });

  if (result.action === 'installed') {
    console.log(`Installed void-dev at ${result.commandPath}.`);
  } else if (result.action === 'already-installed') {
    console.log(`void-dev is already linked at ${result.commandPath}.`);
  } else if (result.action === 'removed') {
    console.log(`Removed void-dev from ${result.commandPath}.`);
  } else {
    console.log('void-dev is not installed.');
  }

  if (operation === 'install' && !globalBinIsOnPath(globalBin)) {
    console.warn(`${globalBin} is not on PATH. Add it before running void-dev.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
