import { execSync } from 'node:child_process';
import {
  parseRootWranglerConfig,
  readStoredResourceName,
  resolveD1MigrateTarget,
  assertCloudflareDurableObjectLifecycleSupported,
} from '@void/deploy-cloudflare';
import { dirname, relative } from 'pathslash';
import { type VoidConfig } from '../config.ts';
import { collectMigrations } from '../migrations/collect.ts';
import { SqliteMigrationError } from '../migrations/sqlite-validation.ts';
import { detectFramework } from '../plugin-inference.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from '../shared/env.ts';
import { CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV } from '../shared/version-metadata.ts';
import { prepareCfBuildOutput, prepareCfFrameworkBuildOutput } from './cf-build-output.ts';
import {
  readGeneratedDeployConfig,
  deduplicateGeneratedCompatibilityFlags,
  validateCloudflarePostBuildEnv,
  resolveGeneratedDeployConfigPathDefault,
} from './deploy-artifact-validation.ts';
import { DEPLOY_BINDING_IDENTITY_FIELDS, bindingIdentityKey } from './deploy-binding-snapshot.ts';
import type { CloudflareDeploySource, CloudflarePreflight } from './deploy-cloudflare-preflight.ts';
import { prepareCloudflareFrameworkArtifact } from './deploy-cloudflare-static.ts';
import { log, getExitCode } from './deploy-helpers.ts';
import {
  validateAuthMigrationSchema,
  assertRemoteMigrationsDeployable,
  checkWranglerMigrationApplySet,
} from './deploy-migrations.ts';
import {
  scrubManagedDeployBuildMarkers,
  scrubWranglerAuthCredentials,
  deployChildEnv,
} from './deploy-transport.ts';
import { type CloudflareDeployDeps } from './deploy-types.ts';
import { getErrorMessage } from './output.ts';
import { resolveProjectCommand, type FrameworkPreset } from './preset.ts';
import { deleteEnvVarCaseAware } from './provision.ts';

export type CloudflareBuild = Awaited<ReturnType<typeof buildCloudflareWorker>>;

/** Build the Worker without Cloudflare credentials, then run the post-build gates. */
export async function buildCloudflareWorker(input: {
  readonly root: string;
  readonly voidConfig: VoidConfig;
  readonly deps: CloudflareDeployDeps;
  readonly exit: (code: number) => never;
  readonly atomic: boolean;
  readonly frameworkPreset: FrameworkPreset | undefined;
  readonly detectedFramework: ReturnType<typeof detectFramework>;
  readonly source: CloudflareDeploySource;
  readonly preflight: CloudflarePreflight;
}): Promise<{
  migrations: ReturnType<typeof collectMigrations>;
  d1MigrateToken: string | undefined;
  generatedConfigPath: string;
  prepareBuildOutput: () => ReturnType<typeof prepareCfBuildOutput>;
}> {
  const { root, voidConfig, deps, exit, atomic, frameworkPreset, detectedFramework } = input;
  const {
    configPath,
    needsAI,
    aiBindingName,
    needsImages,
    imagesBindingName,
    migrationsDir,
    dialect,
    authEnabled,
    desired,
  } = input.source;
  const {
    accountId,
    apiBaseUrl,
    usesCf,
    existingWorker,
    workerName,
    schemaFacts,
    assertUploaderStillPinned,
    runWrangler,
    approvedHandoffKv,
    bindingIdentitySnapshot,
  } = input.preflight;

  const buildChildEnv = scrubManagedDeployBuildMarkers(
    scrubWranglerAuthCredentials(deployChildEnv(accountId, apiBaseUrl)),
  );
  // Tell void:env to build Worker vars from portable production dotenv files
  // only. Outside this deploy path Vite keeps its standard dotenv behavior,
  // but local files cannot be serialized into the artifact this command uploads.
  deleteEnvVarCaseAware(buildChildEnv, CLOUDFLARE_DEPLOY_BUILD_ENV);
  buildChildEnv[CLOUDFLARE_DEPLOY_BUILD_ENV] = '1';
  deleteEnvVarCaseAware(buildChildEnv, CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV);
  if (existingWorker) {
    buildChildEnv[CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV] = '1';
  }
  // The env-schema probes run with NODE_ENV=production; `vite build` keeps an ambient value, so
  // pin it here too.
  deleteEnvVarCaseAware(buildChildEnv, 'NODE_ENV');
  buildChildEnv.NODE_ENV = 'production';
  const runBuild =
    deps.runBuild ??
    ((env: NodeJS.ProcessEnv) => {
      const command = frameworkPreset
        ? (voidConfig.inference?.build ?? resolveProjectCommand(root, frameworkPreset.buildCommand))
        : resolveProjectCommand(root, 'vite build');
      execSync(command, { cwd: root, stdio: 'inherit', env });
    });
  // The build runs project code without credentials, but it can edit files, including the
  // pinned uploader. The uploader is re-checked after it and before every credentialed run.
  try {
    runBuild(buildChildEnv);
  } catch (err) {
    log.error(`deploy: build failed — ${getErrorMessage(err)}`);
    return exit(getExitCode(err));
  }
  log.step('Preparing deployment...');
  if (detectedFramework && frameworkPreset) {
    try {
      await (deps.prepareFrameworkArtifact ?? prepareCloudflareFrameworkArtifact)({
        root,
        configPath,
        accountId,
        workerName,
        voidConfig,
        framework: detectedFramework,
        preset: frameworkPreset,
        requiredSecretNames: schemaFacts.requiredKeys,
        ai: needsAI ? { binding: aiBindingName } : undefined,
        images: needsImages ? { binding: imagesBindingName } : undefined,
        preserveBindings: existingWorker !== null,
      });
    } catch (error) {
      log.error(
        `deploy: could not prepare ${detectedFramework.name} for Cloudflare — ${getErrorMessage(error)}`,
      );
      return exit(1);
    }
  }
  if (!assertUploaderStillPinned()) {
    return exit(1);
  }

  // Build plugins can add or rewrite migrations, and the remote apply reads the files on disk,
  // so every gate below uses this post-build set.
  const migrations = collectMigrations(migrationsDir);
  if (existingWorker && migrations.length) {
    throw new Error(
      'The build added database migrations. Link the existing site before making schema changes.',
    );
  }

  // A build plugin can add migrations after the pre-build source scan. Require the production URL
  // again against the post-build ground truth so no injected migration can be silently skipped.
  if (dialect !== 'sqlite' && migrations.length > 0 && !process.env.DATABASE_URL) {
    log.error(
      `deploy: the build added ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} migrations, but DATABASE_URL is not set. ` +
        'Refusing to upload a Worker against an unmigrated database.',
    );
    return exit(1);
  }

  // Worker Versions cannot apply a new Durable Object class migration to an existing Worker.
  // Check the active migration tag before any remote database or secret change.
  const lifecycleConfigPath = (
    deps.resolveGeneratedConfigPath ??
    ((projectRoot) => readGeneratedDeployConfig(projectRoot).path)
  )(root);
  if (atomic && !Array.isArray(parseRootWranglerConfig(lifecycleConfigPath).migrations)) {
    log.error(
      'deploy: atomic deployment is only for Workers with Durable Object migration history.',
    );
    return exit(1);
  }
  try {
    deduplicateGeneratedCompatibilityFlags(lifecycleConfigPath, configPath);
    await (deps.assertDurableObjectLifecycle ?? assertCloudflareDurableObjectLifecycleSupported)({
      runWrangler,
      configPath: lifecycleConfigPath,
      workerName,
      accountId,
      apiBaseUrl,
      allowPendingAtomicMigration: atomic,
    });
  } catch (error) {
    log.error(getErrorMessage(error));
    return exit(1);
  }

  if (
    !(await validateCloudflarePostBuildEnv({
      root,
      configPath,
      accountId,
      apiBaseUrl,
      workerName,
      schemaFacts,
      authEnabled,
      existingWorker,
      approvedHandoffKv,
      deps,
      assertUploaderStillPinned,
    }))
  ) {
    return exit(1);
  }

  // This backend never creates the Better Auth tables at runtime, so the checked-in D1
  // migrations must produce the schema the build generated.
  if (authEnabled && dialect === 'sqlite') {
    try {
      await (deps.validateAuthMigrations ?? validateAuthMigrationSchema)(root, migrations);
    } catch (err) {
      log.error(
        [
          'deploy: --platform cloudflare cannot verify the Void-managed Better Auth schema.',
          'The managed platform creates these tables at runtime (POST /__void/migrate/auth)',
          'after deploy; this self-host backend only applies checked-in db/migrations/*.sql, so',
          'they must already produce the Better Auth schema — tables, columns, and the primary',
          'keys, unique constraints and foreign keys it declares:',
          `  ${getErrorMessage(err)}`,
          ...(err instanceof SqliteMigrationError
            ? [
                'Repair the unapplied migration named above, then rerun deploy.',
                '`void db generate` diffs snapshots and cannot repair existing invalid SQL.',
              ]
            : [
                '`void db generate` includes the production Better Auth schema automatically.',
                'Run it, review and commit the generated migration, then rerun deploy.',
              ]),
        ].join('\n'),
      );
      return exit(1);
    }
  }

  // Nothing remote has changed yet, so a failed migration gate leaves no half-migrated account.
  let d1MigrateToken: string | undefined;
  if (desired.d1 || desired.hyperdrive) {
    // The managed deploy's gates (schema drift, journal coherence, destructive SQL) run even with
    // no migrations, since a schema without migrations is drift too.
    try {
      (deps.assertMigrationsDeployable ?? assertRemoteMigrationsDeployable)(
        root,
        dialect,
        migrationsDir,
        migrations,
      );
    } catch (err) {
      log.error(getErrorMessage(err));
      return exit(1);
    }

    // A D1 database used only for queries or auth may have no migrations folder at all.
    if (desired.d1 && migrations.length > 0) {
      // A missing `migrations_dir` defaults to `./migrations`, which may be an unrelated folder.
      const migrateConfig = parseRootWranglerConfig(configPath);
      const d1MigrationsDir = readStoredResourceName(
        migrateConfig,
        'd1_databases',
        desired.d1.binding,
        'migrations_dir',
      );
      if (!d1MigrationsDir) {
        log.error(
          [
            `deploy: D1 binding ${desired.d1.binding} has no "migrations_dir" in ${configPath}.`,
            'Refusing to run `wrangler d1 migrations apply` — wrangler would default to',
            '`./migrations` (relative to the config) and apply an unrelated folder to your',
            'remote database, or error. Automatic provisioning should have set this field;',
            'rerun `void deploy --platform cloudflare`, or add it yourself.',
          ].join('\n'),
        );
        return exit(1);
      }
      // The apply resolves its target by the first entry whose id, database_name or binding
      // matches the token, so use a token that resolves only to the validated binding.
      const migrateTarget = resolveD1MigrateTarget(migrateConfig, desired.d1.binding);
      if (!migrateTarget.ok) {
        log.error(
          [
            `deploy: cannot safely run D1 migrations for binding ${desired.d1.binding} — ${migrateTarget.reason}`,
            'wrangler resolves `d1 migrations apply <name>` by first-matching the name against',
            "each entry's database_name OR binding, so an ambiguous token could migrate a",
            'different database than the one validated. Give each D1 database a unique',
            'database_name (and binding), then rerun.',
          ].join('\n'),
        );
        return exit(1);
      }

      // The apply reads its database id from this post-build config; a build that rewrote it
      // would redirect the remote migration to another database.
      const { field: d1Field, idField: d1IdField } = DEPLOY_BINDING_IDENTITY_FIELDS.d1;
      const pinnedD1Id = bindingIdentitySnapshot.get(
        bindingIdentityKey(d1Field, desired.d1.binding),
      );
      const postBuildD1Id = readStoredResourceName(
        migrateConfig,
        d1Field,
        desired.d1.binding,
        d1IdField,
      );
      if (pinnedD1Id !== undefined && postBuildD1Id !== pinnedD1Id) {
        log.error(
          [
            `deploy: the ${desired.d1.binding} D1 database identity changed between validation and the remote migrate.`,
            `Refusing to run \`wrangler d1 migrations apply\` — the build rewrote ${d1IdField} in ${configPath}`,
            `(validated ${JSON.stringify(pinnedD1Id)}, now ${JSON.stringify(postBuildD1Id)}), which would redirect this`,
            'privileged remote migration to a different database. Rebuild from a clean checkout, then rerun.',
          ].join('\n'),
        );
        return exit(1);
      }

      // The files the apply will read must equal the validated set; a stray `seed.sql` matches
      // its `*.sql` glob but not the gates.
      const applyCheck = await (deps.checkMigrationApplySet ?? checkWranglerMigrationApplySet)(
        configPath,
        migrateConfig,
        desired.d1.binding,
        d1MigrationsDir,
        migrations,
        relative(root, migrationsDir),
      );
      if (!applyCheck.ok) {
        log.error(applyCheck.reason);
        return exit(1);
      }
      d1MigrateToken = migrateTarget.token;
    }
  }

  const generatedConfigPath = (
    deps.resolveGeneratedConfigPath ?? resolveGeneratedDeployConfigPathDefault
  )(root);
  const prepareBuildOutput = () =>
    frameworkPreset?.cloudflareArtifact === 'worker-output'
      ? prepareCfFrameworkBuildOutput({
          projectRoot: root,
          configPath: generatedConfigPath,
          accountId,
        })
      : prepareCfBuildOutput(dirname(generatedConfigPath), accountId);
  if (usesCf) {
    // Validate the exact upload format before changing a remote database or secret.
    const preflight = await prepareBuildOutput();
    if (!preflight) {
      log.error('deploy: cf could not prepare the built Worker for deployment.');
      return exit(1);
    }
    await preflight.dispose();
  }
  return { migrations, d1MigrateToken, generatedConfigPath, prepareBuildOutput };
}
