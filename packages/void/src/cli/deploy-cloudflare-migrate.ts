import { runMySqlMigrations } from '../migrations/runner-mysql.ts';
import { runPgMigrations } from '../migrations/runner-pg.ts';
import {
  verifyGeneratedDeployConfig,
  verifyCloudflareDeployArtifact,
} from './deploy-artifact-validation.ts';
import { ensureCloudflareAuthSecret } from './deploy-cloudflare-auth.ts';
import type { CloudflareBuild } from './deploy-cloudflare-build.ts';
import type { CloudflareDeploySource, CloudflarePreflight } from './deploy-cloudflare-preflight.ts';
import { log } from './deploy-helpers.ts';
import {
  applyAndVerifyRemoteD1Migrations,
  logD1RestoreAfterDeployFailure,
} from './deploy-migrations.ts';
import { CloudflareAuthSecretError } from './deploy-resources.ts';
import { type CloudflareDeployDeps } from './deploy-types.ts';
import { type CliLogger } from './log-file.ts';
import { getErrorMessage } from './output.ts';
import { readDeploymentPlatform } from './project.ts';

export type CloudflareMigration = Awaited<ReturnType<typeof migrateCloudflareWorker>>;

/** Provision the auth secret and apply database migrations, then verify the artifact. */
export async function migrateCloudflareWorker(input: {
  readonly root: string;
  readonly deps: CloudflareDeployDeps;
  readonly exit: (code: number) => never;
  readonly cliLog: CliLogger;
  readonly source: CloudflareDeploySource;
  readonly preflight: CloudflarePreflight;
  readonly build: CloudflareBuild;
}): Promise<{
  workerWasMissingBeforeSecretProvisioning: boolean;
  initialAuthSecret: string | undefined;
  appliedMigrations: number;
  /** Restores the D1 state from before this deploy's migrations, when it applied any. */
  d1RestoreCommand: string | undefined;
}> {
  const { root, deps, exit, cliLog } = input;
  const {
    configPath,
    authEnabled,
    desired,
    needsAI,
    aiBindingName,
    needsImages,
    imagesBindingName,
    expectedCrons,
    dialect,
    migrationsDir,
  } = input.source;
  const {
    accountId,
    workerName,
    bindingIdentitySnapshot,
    passthroughIdentitySnapshot,
    passthroughRawFields,
    expectedContainers,
    expectedDurableObjectState,
    runWrangler,
    assertUploaderStillPinned,
    schemaFacts,
  } = input.preflight;
  const { migrations, d1MigrateToken } = input.build;

  let workerWasMissingBeforeSecretProvisioning = false;
  let initialAuthSecret: string | undefined;
  const verifyOptions = {
    accountId,
    workerName,
    desired,
    bindingIdentitySnapshot,
    passthroughIdentitySnapshot,
    passthroughRawFields,
    needsAI,
    aiBindingName,
    needsImages,
    imagesBindingName,
    authEnabled,
    expectedContainers,
    expectedDurableObjectBindings: expectedDurableObjectState.bindings,
    expectedMigrations: expectedDurableObjectState.migrations,
    expectedCrons,
  };

  // Persistent Better Auth secret: adopted when present, otherwise generated once and verified,
  // before the first remote migration or upload.
  if (authEnabled) {
    // Without `secrets.required`, the next upload could drop a newly written secret.
    const inheritance = (deps.verifyDeployConfig ?? verifyGeneratedDeployConfig)(
      root,
      verifyOptions,
    );
    if (!inheritance.ok) {
      log.error(
        [
          'deploy: the generated deploy config cannot preserve the Better Auth secret — refusing to deploy.',
          inheritance.reason,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return exit(1);
    }
    try {
      const authSecret = await (deps.ensureAuthSecret ?? ensureCloudflareAuthSecret)({
        root,
        configPath,
        accountId,
        workerName,
        runWrangler,
        beforeWranglerRun: assertUploaderStillPinned,
      });
      workerWasMissingBeforeSecretProvisioning = authSecret.workerWasMissing === true;
      initialAuthSecret = authSecret.candidateSecret;
      cliLog.info('cloudflare_auth_secret_ready', { created: authSecret.created });
    } catch (error) {
      if (error instanceof CloudflareAuthSecretError) {
        // The uploader check has already logged its own failure.
        if (error.reason !== 'uploader-changed') {
          log.error(error.message);
        }
        return exit(1);
      }
      throw error;
    }
  }

  let appliedMigrations = 0;

  // Cloudflare never returns the Hyperdrive password, so the deploy environment provides the
  // production URL. A rerun skips migrations already recorded as finished. A failed PostgreSQL
  // file rolls back. A failed MySQL file rolls back its data changes, but MySQL commits DDL on
  // its own, so earlier statements of that file can stay applied.
  if (dialect !== 'sqlite' && migrations.length > 0) {
    const mysql = dialect === 'mysql';
    const label = mysql ? 'MySQL' : 'PostgreSQL';
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      log.error(`deploy: DATABASE_URL disappeared before ${label} migrations could run.`);
      return exit(1);
    }
    try {
      const applyMigrations = mysql
        ? (deps.applyMySqlMigrations ?? runMySqlMigrations)
        : (deps.applyPostgresMigrations ?? runPgMigrations);
      const applied = await applyMigrations(migrationsDir, databaseUrl);
      appliedMigrations = applied.length;
      cliLog.info(mysql ? 'cloudflare_mysql_migrations' : 'cloudflare_postgres_migrations', {
        applied: applied.length,
      });
      if (applied.length > 0) {
        log.step(`Applied ${applied.length} ${label} migration${applied.length === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      log.error(`deploy: ${label} migrations failed — ${getErrorMessage(err)}`);
      return exit(1);
    }
  }

  const d1 = await applyAndVerifyRemoteD1Migrations(
    d1MigrateToken,
    configPath,
    runWrangler,
    assertUploaderStillPinned,
    readDeploymentPlatform(root) !== 'cloudflare',
  );
  if (!d1) {
    return exit(1);
  }
  const d1RestoreCommand = d1.restoreCommand;

  if (
    !verifyCloudflareDeployArtifact(root, deps, {
      ...verifyOptions,
      requiredSecretNames: schemaFacts.requiredKeys,
    })
  ) {
    if (d1RestoreCommand) {
      logD1RestoreAfterDeployFailure(d1RestoreCommand);
    }
    return exit(1);
  }
  return {
    workerWasMissingBeforeSecretProvisioning,
    initialAuthSecret,
    appliedMigrations,
    d1RestoreCommand,
  };
}
