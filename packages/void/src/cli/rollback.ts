import { outro, log, select, confirm, isCancel, cancel } from '@voidzero-dev/vite-plus-prompts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { createSpinner, dim, formatCount, formatRelativeTime, printSuccess } from './output.ts';
import { readDeploymentPlatform, readProjectConfig } from './project.ts';

export async function runRollbackCommand(
  root: string,
  deployId?: string,
  explicitPlatform?: 'cloudflare',
): Promise<void> {
  console.log();

  // A one-off `deploy --platform cloudflare` keeps the saved platform, so its rollback names
  // the platform explicitly.
  const platform = readDeploymentPlatform(root);
  if (explicitPlatform === 'cloudflare' || platform === 'cloudflare') {
    return runCloudflareRollback(root, deployId, platform !== 'cloudflare');
  }
  if (platform === 'none') {
    throw new Error('rollback: Deployment is disabled. Run `void init` to choose a platform.');
  }

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }

  const linked = readProjectConfig(root);
  if (!linked) {
    log.error('No linked project. Run `void project link` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });
  const { deployments, activeDeploymentId } = await client.listDeployments(linked.projectId);

  // Filter to retained deployments that aren't the active one
  const candidates = deployments.filter(
    (d) => d.retained && d.status === 'live' && d.id !== activeDeploymentId,
  );

  if (candidates.length === 0) {
    log.warn('No retained deployments available for rollback.');
    outro(dim('Deploy more versions to enable rollback.'));
    return;
  }

  let targetId: string;

  if (deployId) {
    const target = candidates.find((d) => d.id === deployId);
    if (!target) {
      log.error(
        `Deployment ${deployId} is not available for rollback (not retained or not found).`,
      );
      process.exit(1);
    }
    targetId = deployId;
  } else {
    const result = await select({
      message: 'Select a deployment to roll back to:',
      options: candidates.map((d) => ({
        value: d.id,
        label: `${d.id} ${dim(d.deployed_at ? formatRelativeTime(d.deployed_at) : '')}`,
        hint: d.source ? `via ${d.source}` : undefined,
      })),
    });

    if (isCancel(result)) {
      cancel('Rollback cancelled.');
      process.exit(0);
    }
    targetId = result as string;
  }

  // Compute migration diff client-side for warning
  const active = deployments.find((d) => d.id === activeDeploymentId);
  const target = candidates.find((d) => d.id === targetId)!;
  const currentMigrations: Array<string> = active?.applied_migrations
    ? JSON.parse(active.applied_migrations)
    : [];
  const targetMigrations: Array<string> = target.applied_migrations
    ? JSON.parse(target.applied_migrations)
    : [];
  const migrationDiff = currentMigrations.filter((m) => !targetMigrations.includes(m));
  await confirmUnrevertedMigrations(migrationDiff, 'deployment');

  const s = createSpinner();
  s.start('Rolling back...');

  try {
    // Echo the confirmed diff so the server can reject if `currentActive`
    // drifted between our preflight and its in-lock re-read.
    const result = await client.rollback(linked.projectId, targetId, {
      allowDestructive: migrationDiff.length > 0 ? migrationDiff : undefined,
    });
    s.stop('Rollback complete.');

    if (result.ok) {
      log.info('Traffic is now serving the rolled-back deployment.');
      printSuccess(`Rolled back to ${targetId}.`);
    } else {
      log.error(result.error ?? 'Rollback failed.');
      process.exit(1);
    }
  } catch (err) {
    s.stop('Rollback failed.');
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function runCloudflareRollback(
  root: string,
  deployId: string | undefined,
  restorePlatformFlag: boolean,
): Promise<void> {
  const {
    activateCloudflareExistingVersion,
    readCloudflareWorkerStatus,
    resolveCloudflareOperationContext,
  } = await import('./cloudflare-operations.ts');
  const context = resolveCloudflareOperationContext(root);
  const status = await readCloudflareWorkerStatus(context);
  const deployedVersionIds = new Set(status.deployedVersionIds);
  const candidates = [...status.versions]
    .reverse()
    .filter(
      (version) => version.id !== status.activeVersionId && deployedVersionIds.has(version.id),
    );
  if (candidates.length === 0) {
    log.warn('No previous Cloudflare Worker Versions are available for rollback.');
    outro(dim('Deploy more versions to enable rollback.'));
    return;
  }

  const requestedMatches = deployId
    ? candidates.filter((version) => version.id === deployId || version.id.startsWith(deployId))
    : [];
  if (requestedMatches.length > 1) {
    log.error(`Version prefix ${deployId} is ambiguous; pass the complete version id.`);
    process.exit(1);
  }
  let target = requestedMatches[0];
  if (deployId && !target) {
    log.error(`Version ${deployId} is not available for rollback.`);
    process.exit(1);
  }
  if (!target) {
    const result = await select({
      message: 'Select a version to roll back to:',
      options: candidates.map((version) => ({
        value: version.id,
        label: `${version.id} ${dim(version.createdAt ? formatRelativeTime(version.createdAt) : '')}`,
        hint: version.metadata
          ? formatCount(version.metadata.migrations.length, 'migration')
          : 'migration state unknown',
      })),
    });
    if (isCancel(result)) {
      cancel('Rollback cancelled.');
      process.exit(0);
    }
    target = candidates.find((version) => version.id === result)!;
  }

  const current = status.versions.find((version) => version.id === status.activeVersionId);
  if (
    target.metadata?.schema !== 2 ||
    current?.metadata?.schema !== 2 ||
    target.metadata.triggerConfig.preserve ||
    current.metadata.triggerConfig.preserve
  ) {
    log.info(
      'This rollback keeps the current domains, routes, and schedules. The selected version has no complete trigger snapshot.',
    );
  }
  if (!current?.metadata || !target.metadata) {
    log.warn(
      'Void migration metadata is unavailable for one of these versions. Database migrations are forward-only and will not be reverted.',
    );
    await confirmRollbackOrExit();
  } else {
    const targetSet = new Set(target.metadata.migrations);
    const migrationDiff = current.metadata.migrations.filter(
      (migration) => !targetSet.has(migration),
    );
    await confirmUnrevertedMigrations(migrationDiff, 'version', restorePlatformFlag);
  }

  const spinner = createSpinner();
  spinner.start('Rolling back...');
  try {
    await activateCloudflareExistingVersion(context, target, current);
    spinner.stop('Rollback complete.');
  } catch (error) {
    spinner.stop('Rollback failed.');
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  log.info('Traffic is now serving the selected Cloudflare Worker Version.');
  printSuccess(`Rolled back to ${target.id}.`);
}

async function confirmRollbackOrExit(): Promise<void> {
  const proceed = await confirm({ message: 'Proceed with rollback?' });
  if (isCancel(proceed) || !proceed) {
    cancel('Rollback cancelled.');
    process.exit(0);
  }
}

/** List migrations the rollback will not revert and ask before continuing. */
async function confirmUnrevertedMigrations(
  migrationDiff: Array<string>,
  noun: 'deployment' | 'version',
  restorePlatformFlag = false,
): Promise<void> {
  if (migrationDiff.length === 0) {
    return;
  }
  log.warn(
    `The current database has ${formatCount(migrationDiff.length, 'migration')} applied after this ${noun}:`,
  );
  for (const migration of migrationDiff) {
    log.message(`  ${dim('•')} ${migration}`);
  }
  log.message(
    dim(
      'Rolling back will NOT revert these migrations. The older code will run against the current schema.',
    ),
  );
  if (noun === 'version') {
    log.message(
      dim(
        `For D1, \`void db restore${restorePlatformFlag ? ' --platform cloudflare' : ''} --bookmark <bookmark>\` undoes them with the restore point deploy printed before migrating. ` +
          'Restore points expire after 7 days on Workers Free and 30 days on Paid; undo older migrations with a new migration.',
      ),
    );
  }
  await confirmRollbackOrExit();
}
