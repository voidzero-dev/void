import { sql as drizzleSql } from 'drizzle-orm';
import { type Context } from 'hono';
import { retryWithBackoff } from '../cf-api.ts';
import {
  updateDeploymentStatus,
  setAppliedMigrations,
  appendProjectMigrations,
  type Db,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { type DeployLogger } from '../observability/logger.ts';
import { provisionBindings } from '../provisioning/provision.ts';
import {
  type DeployManifest,
  type DeployEvent,
  type Deployment,
  type DeploymentStatus,
} from '../types.ts';
import { assertDeploymentCanProceed } from './guards.ts';
import {
  isCfAssetPlainText,
  probeWorkerMigrationCapabilities,
  dispatchStableAppMigration,
  formatMigrationFailure,
  dispatchStableAuthMigration,
  type UserWorkerMigrationResult,
  CF_MIGRATION_RETRY,
  normalizeUserWorkerMigrationResult,
} from './migrations.ts';
import { requireActiveDeployAccess } from './recovery.ts';
import { CF_READINESS_RETRY } from './shared.ts';

export async function migrateDeploymentWorker(input: {
  readonly manifest: DeployManifest;
  currentStep: string;
  readonly markPhase: (next: string) => void;
  readonly logger: DeployLogger;
  currentStatus: DeploymentStatus;
  readonly cutoverProtected: boolean;
  readonly context: Context<ApiEnv>;
  readonly deployment: Deployment;
  readonly projectId: string;
  readonly emit: (event: DeployEvent) => void;
  readonly workerBindings: Awaited<ReturnType<typeof provisionBindings>>;
  readonly workerName: string;
  readonly actor: ApiEnv['Variables']['user'];
}) {
  const {
    manifest,
    markPhase,
    logger,
    cutoverProtected,
    context,
    deployment,
    projectId,
    emit,
    workerBindings,
    workerName,
    actor,
  } = input;

  let migrationsApplied = 0;
  if (manifest.migrations && manifest.migrations.pending > 0) {
    input.currentStep = 'migration';
    markPhase('migrate');
    logger.info('status_transition', 'status_change', {
      from: input.currentStatus,
      to: 'migrating',
    });
    if (!cutoverProtected) {
      await updateDeploymentStatus(context.get('db'), deployment.id, 'migrating');
      input.currentStatus = 'migrating';
    }
    await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);
    emit({ event: 'worker_readiness' });

    const proxyToken = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN')?.text ?? '';
    const lockProjectForDeploy = async (tx: Db): Promise<void> => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      await requireActiveDeployAccess(tx, projectId, actor.id);
    };
    const readinessError = 'worker readiness probe failed: new worker not reachable after retries';
    let readinessFailure = 'no readiness attempts completed';
    try {
      await retryWithBackoff<true>(
        async (attempt) => {
          const attemptStart = Date.now();
          const maxAttempts = CF_READINESS_RETRY.maxRetries + 1;
          try {
            const userWorker = context.env.DISPATCH.get(workerName);
            const readyResponse = await userWorker.fetch(
              new Request('https://internal/__void/ready', {
                signal: AbortSignal.timeout(10_000),
              }),
            );
            const text = await readyResponse.text();
            if (isCfAssetPlainText(text)) {
              readinessFailure = 'last readiness response was a Cloudflare asset propagation stub';
              logger.warn('migrate', 'readiness_probe_attempt_failed', {
                attempt,
                maxAttempts,
                latencyMs: Date.now() - attemptStart,
                code: 'cf_plain_text',
                bodyPreview: text.slice(0, 200),
              });
              return undefined;
            }
            try {
              const data = JSON.parse(text);
              if (data.ready === true) {
                return true;
              }
            } catch {
              // fall through
            }
            readinessFailure = `last readiness response was HTTP ${readyResponse.status}: ${text.slice(0, 200)}`;
            logger.warn('migrate', 'readiness_probe_attempt_failed', {
              attempt,
              maxAttempts,
              latencyMs: Date.now() - attemptStart,
              status: readyResponse.status,
              bodyPreview: text.slice(0, 200),
            });
            return undefined;
          } catch (err) {
            readinessFailure = `last readiness request threw: ${err instanceof Error ? err.message : String(err)}`;
            logger.warn('migrate', 'readiness_probe_attempt_failed', {
              attempt,
              maxAttempts,
              latencyMs: Date.now() - attemptStart,
              code: 'threw',
              err: err instanceof Error ? err.message : String(err),
            });
            return undefined;
          }
        },
        {
          ...CF_READINESS_RETRY,
          errorMessage: readinessError,
        },
      );
    } catch {
      throw new Error(`${readinessError} (${readinessFailure})`);
    }

    if (manifest.migrationMode === 'skip') {
      await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);
      logger.info('migrate', 'skipped', { pending: manifest.migrations.pending });
      return { migrationsApplied };
    }

    const manifestProtocol = manifest.migrations.protocolVersion;
    const probe =
      manifestProtocol === 2
        ? await probeWorkerMigrationCapabilities(
            context.env.DISPATCH.get(workerName),
            proxyToken,
            logger,
          )
        : null;
    const stableCapabilities = probe && probe.ok ? probe.caps : null;
    const canUseStable =
      stableCapabilities &&
      stableCapabilities.dialect === manifest.migrations.dialect &&
      stableCapabilities.classifierVersion === manifest.migrations.classifierVersion &&
      stableCapabilities.migrationListHash === manifest.migrations.migrationListHash;

    if (manifestProtocol === 2 && !canUseStable) {
      const reason = !probe
        ? 'no capability probe performed'
        : !probe.ok
          ? probe.reason
          : (() => {
              const c = probe.caps;
              const m = manifest.migrations;
              const diffs: Array<string> = [];
              if (c.dialect !== m.dialect) {
                diffs.push(`dialect worker=${c.dialect} manifest=${m.dialect}`);
              }
              if (c.classifierVersion !== m.classifierVersion) {
                diffs.push(
                  `classifierVersion worker=${c.classifierVersion} manifest=${m.classifierVersion}`,
                );
              }
              if (c.migrationListHash !== m.migrationListHash) {
                diffs.push(
                  `migrationListHash worker=${c.migrationListHash} manifest=${m.migrationListHash}`,
                );
              }
              return `deployed worker build differs from manifest (${diffs.join('; ')})`;
            })();
      logger.warn('migrate', 'capability_negotiation_failed', { reason });
      throw new Error(`migration protocol v2 capability negotiation failed: ${reason}`);
    }

    emit({ event: 'migration_start', pending: manifest.migrations.pending });

    if (canUseStable) {
      const attemptId = generateId('migatt');
      const stableOutcome = await context.get('db').transaction(async (tx) => {
        await lockProjectForDeploy(tx);
        const appResult = await dispatchStableAppMigration(
          context.env.DISPATCH.get(workerName),
          proxyToken,
          attemptId,
          deployment.id,
          logger,
        );
        const confirmed = [
          ...(appResult.confirmedApplied ?? []),
          ...(appResult.confirmedSkipped ?? []),
        ];
        if (confirmed.length > 0) {
          await appendProjectMigrations(tx, projectId, confirmed, deployment.id);
          await setAppliedMigrations(tx, deployment.id, confirmed);
        }
        return { confirmed, result: appResult };
      });

      for (const warning of stableOutcome.result.warnings ?? []) {
        logger.warn('migrate', 'warning', { message: warning });
        emit({ event: 'migration_warning', message: warning });
      }
      if (!stableOutcome.result.ok) {
        throw new Error(`migration failed: ${formatMigrationFailure(stableOutcome.result)}`);
      }
      for (const m of stableOutcome.result.migrations) {
        if (m.status === 'applied' || m.applied) {
          emit({
            event: 'migration',
            name: m.name,
            durationMs: m.durationMs,
            stability: m.stability,
          });
          migrationsApplied++;
        }
      }
      if (stableCapabilities.endpoints.auth) {
        // Persist the remotely committed app result before auth runs, and
        // release the project lock before this request's 300-second timeout.
        await context.get('db').transaction(lockProjectForDeploy);
        await dispatchStableAuthMigration(context.env.DISPATCH.get(workerName), proxyToken);
      }
    } else {
      const result = await context.get('db').transaction(async (tx) => {
        await lockProjectForDeploy(tx);
        const externalResult = await retryWithBackoff<UserWorkerMigrationResult>(
          async (attempt) => {
            const attemptStart = Date.now();
            const maxAttempts = CF_MIGRATION_RETRY.maxRetries + 1;
            const userWorker = context.env.DISPATCH.get(workerName);
            const migrateResponse = await userWorker.fetch(
              new Request('https://internal/__void/migrate', {
                method: 'POST',
                headers: { 'x-void-internal': proxyToken },
                signal: AbortSignal.timeout(300_000),
              }),
            );

            const text = await migrateResponse.text();
            if (isCfAssetPlainText(text)) {
              logger.warn('migrate', 'attempt_failed', {
                attempt,
                bodyPreview: text.slice(0, 200),
                code: 'cf_plain_text',
                latencyMs: Date.now() - attemptStart,
                maxAttempts,
              });
              return undefined;
            }

            try {
              return normalizeUserWorkerMigrationResult(JSON.parse(text), text.slice(0, 500));
            } catch {
              if (migrateResponse.ok) {
                logger.warn('migrate', 'attempt_failed', {
                  attempt,
                  bodyPreview: text.slice(0, 500),
                  code: 'non_json_2xx',
                  latencyMs: Date.now() - attemptStart,
                  maxAttempts,
                  status: migrateResponse.status,
                });
                return undefined;
              }
              throw new Error(
                `migration failed (${migrateResponse.status}): ${text.slice(0, 200)}`,
              );
            }
          },
          {
            ...CF_MIGRATION_RETRY,
            errorMessage: 'migration dispatch failed after retries',
          },
        );
        const allApplied = externalResult.migrations
          .filter((migration) => !migration.error)
          .map((migration) => migration.name);
        if (allApplied.length > 0) {
          await appendProjectMigrations(tx, projectId, allApplied, deployment.id);
          await setAppliedMigrations(tx, deployment.id, allApplied);
        }
        return externalResult;
      });

      if (!result.ok) {
        throw new Error(`migration failed: ${formatMigrationFailure(result)}`);
      }
      for (const m of result.migrations) {
        if (m.applied) {
          emit({ event: 'migration', name: m.name, durationMs: m.durationMs });
          migrationsApplied++;
        }
      }
    }
    await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);
  }
  return { migrationsApplied };
}
