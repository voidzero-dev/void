import { createHash } from 'node:crypto';
import {
  canonicalJson,
  canonicalSql,
  classifySqlMigration,
  getMigrationPlanHashInput,
  MIGRATION_CLASSIFIER_VERSION,
  splitSqlStatements,
  tokenizeSql,
} from '@void/deploy-core';
import type { MigrationPlanHashInput } from '@void/deploy-core';

export const DESTRUCTIVE_PRAGMA = '-- void:allow-destructive';

export type MigrationExecutionPlan = MigrationPlanHashInput & {
  planHash: string;
  warnings?: Array<string>;
};

export type MigrationPlanBundle = {
  protocolVersion: 2;
  classifierVersion: number;
  migrationListHash: string;
  destructiveValidation: 'passed';
  plans: Array<MigrationExecutionPlan>;
};

function sha256Hex(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function hashPlan(plan: MigrationPlanHashInput): string {
  return sha256Hex(canonicalJson(getMigrationPlanHashInput(plan)));
}

function computeMigrationListHash(plans: ReadonlyArray<MigrationExecutionPlan>): string {
  return sha256Hex(canonicalJson(plans.map((plan) => [plan.name, plan.sqlHash, plan.planHash])));
}

/** Blank out comments, strings and quoted identifiers, keeping offsets stable. */
export function getExecutableSql(sql: string): string {
  let out = '';
  for (const segment of tokenizeSql(sql)) {
    if (segment.kind === 'sql') {
      out += sql.slice(segment.start, segment.end);
    } else {
      out += ' '.repeat(segment.end - segment.start);
    }
  }
  return out;
}

function includesTransactionControl(sql: string): string | null {
  const executable = getExecutableSql(sql);
  const match = executable.match(
    /(?:^|;)\s*(BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE|TRANSACTION))?|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i,
  );
  return match?.[1]?.toUpperCase() ?? null;
}

export function classifyMigration(migration: {
  name: string;
  sql: string;
}): MigrationExecutionPlan {
  const sql = canonicalSql(migration.sql);
  const sqlHash = sha256Hex(sql);
  const transactionControl = includesTransactionControl(sql);
  if (transactionControl) {
    throw new Error(
      `Migration ${migration.name} contains ${transactionControl}; Void owns the stable D1 transaction boundary.`,
    );
  }

  const classification = classifySqlMigration(sql);
  if (classification.kind === 'breakpoint-framed' && classification.statements.length === 0) {
    throw new Error(`Migration ${migration.name} has statement breakpoints but no SQL statements.`);
  }
  const base: MigrationPlanHashInput = {
    ...classification,
    classifierVersion: MIGRATION_CLASSIFIER_VERSION,
    dialect: 'sqlite',
    name: migration.name,
    sqlHash,
  };
  return {
    ...base,
    planHash: hashPlan(base),
    ...(classification.kind === 'legacy-unsplit-multi-statement' && splitSqlStatements(sql) === null
      ? {
          warnings: [
            `Add a \`--> statement-breakpoint\` line after each complete SQL statement in migration ${migration.name}.`,
          ],
        }
      : {}),
  };
}

export function buildMigrationPlanBundle(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
): MigrationPlanBundle {
  const plans = migrations.map((migration) => classifyMigration(migration));
  return {
    classifierVersion: MIGRATION_CLASSIFIER_VERSION,
    destructiveValidation: 'passed',
    migrationListHash: computeMigrationListHash(plans),
    plans,
    protocolVersion: 2,
  };
}
