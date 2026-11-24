import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'pathslash';
import { writeFileAtomic } from '../shared/atomic-write.ts';
import { parsePlatformArgs } from './platform-args.ts';
import type { PlatformArgs } from './platform-args.ts';
import { parsePlatformHyperdriveSelection } from './platform-auth-database.ts';
import type { PlatformExternalHyperdrive } from './platform-plan.ts';
import { platformRegistryDirectory } from './platform-registry.ts';

type SavedPlatformInstallPlan = Readonly<{
  id: string;
  accountName: string;
  savedAt: string;
  args: Extract<PlatformArgs, { subcommand: 'install' }>;
  externalHyperdrive?: PlatformExternalHyperdrive;
}>;

function planId(args: Pick<SavedPlatformInstallPlan['args'], 'account' | 'name'>): string {
  return createHash('sha256')
    .update(JSON.stringify([args.account, args.name]))
    .digest('hex');
}

function parseSavedPlan(value: unknown): SavedPlatformInstallPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an installation plan.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    !Array.isArray(record.arguments) ||
    !record.arguments.every((arg) => typeof arg === 'string')
  ) {
    throw new Error('Invalid installation plan format.');
  }
  const args = parsePlatformArgs(record.arguments);
  if (
    args.subcommand !== 'install' ||
    args.plan ||
    args.resume ||
    args.yes ||
    !args.account ||
    !args.name ||
    !args.displayName
  ) {
    throw new Error('Saved plans must contain installation choices without mutation approval.');
  }
  if (
    typeof record.accountName !== 'string' ||
    !record.accountName ||
    typeof record.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.savedAt))
  ) {
    throw new Error('Invalid installation plan metadata.');
  }
  const externalHyperdrive =
    record.externalHyperdrive === undefined
      ? undefined
      : parsePlatformHyperdriveSelection(record.externalHyperdrive);
  if (externalHyperdrive && externalHyperdrive.id !== args.hyperdrive) {
    throw new Error('Saved Hyperdrive selection does not match the plan.');
  }
  return {
    id: planId(args),
    args,
    accountName: record.accountName,
    savedAt: record.savedAt,
    ...(externalHyperdrive ? { externalHyperdrive } : {}),
  };
}

export function savePlatformInstallChoices(
  arguments_: Array<string>,
  accountName: string,
  directory: string = platformRegistryDirectory(),
  externalHyperdrive?: PlatformExternalHyperdrive,
): SavedPlatformInstallPlan {
  const record = {
    schemaVersion: 1,
    arguments: arguments_,
    accountName,
    savedAt: new Date().toISOString(),
    externalHyperdrive,
  };
  const plan = parseSavedPlan(record);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    join(directory, `plan-${plan.id}.json`),
    JSON.stringify(record, null, 2) + '\n',
    0o600,
  );
  return plan;
}

function readSavedPlatformInstallPlan(path: string, id: string): SavedPlatformInstallPlan {
  try {
    const plan = parseSavedPlan(JSON.parse(readFileSync(path, 'utf8')));
    if (id !== plan.id) {
      throw new Error('Plan identity does not match its file.');
    }
    return plan;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw error;
    }
    throw new Error(
      `platform: Invalid saved installation plan ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function findSavedPlatformInstallPlan(
  account: string,
  name: string,
  directory: string = platformRegistryDirectory(),
): SavedPlatformInstallPlan | undefined {
  const id = planId({ account, name });
  try {
    return readSavedPlatformInstallPlan(join(directory, `plan-${id}.json`), id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export function listSavedPlatformInstallPlans(
  directory: string = platformRegistryDirectory(),
): ReadonlyArray<SavedPlatformInstallPlan> {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && /^plan-[a-f0-9]{64}\.json$/.test(entry.name))
    .map((entry) =>
      readSavedPlatformInstallPlan(join(directory, entry.name), entry.name.slice(5, -5)),
    )
    .sort(
      (left, right) => right.savedAt.localeCompare(left.savedAt) || left.id.localeCompare(right.id),
    );
}

export function removeSavedPlatformInstallPlan(
  args: SavedPlatformInstallPlan['args'],
  directory: string = platformRegistryDirectory(),
): void {
  rmSync(join(directory, `plan-${planId(args)}.json`), { force: true });
}
