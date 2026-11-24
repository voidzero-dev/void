import {
  canonicalJson,
  canonicalSql,
  classifySqlMigration,
  getMigrationPlanHashInput,
  MIGRATION_CLASSIFIER_VERSION,
} from '@void/deploy-core';
import type { MigrationPlanHashInput } from '@void/deploy-core';

export type ServerMigrationPlan = {
  name: string;
  dialect: 'sqlite';
  classifierVersion: number;
  sqlHash: string;
  planHash: string;
  stability: 'stable' | 'legacy';
} & (
  | { kind: 'single-statement' }
  | { kind: 'breakpoint-framed'; statements: Array<string> }
  | { kind: 'legacy-unsplit-multi-statement'; allowLegacy: boolean }
);

export async function validateSubmittedExecutionPlans(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
  plans: ReadonlyArray<Record<string, unknown>> | undefined,
): Promise<string | null> {
  if (plans === undefined) {
    return null;
  }
  if (!Array.isArray(plans) || plans.length !== migrations.length) {
    return 'executionPlans must match migrations length';
  }
  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index]!;
    const plan = plans[index]!;
    if (plan.name !== migration.name) {
      return `executionPlans[${index}].name must match migrations[${index}].name`;
    }
    if (plan.dialect !== 'sqlite') {
      return `executionPlans[${index}].dialect must be sqlite`;
    }
    if (plan.classifierVersion !== MIGRATION_CLASSIFIER_VERSION) {
      return `executionPlans[${index}].classifierVersion is unsupported`;
    }
    const serverPlan = await classifyServerMigrationPlan(migration);
    if (plan.sqlHash !== serverPlan.sqlHash) {
      return `executionPlans[${index}].sqlHash does not match migration SQL`;
    }
    const kind = plan.kind;
    if (
      kind !== 'single-statement' &&
      kind !== 'breakpoint-framed' &&
      kind !== 'legacy-unsplit-multi-statement'
    ) {
      return `executionPlans[${index}].kind is unsupported`;
    }
    if (kind !== serverPlan.kind) {
      return `executionPlans[${index}].kind does not match server classification`;
    }
    if (plan.stability !== serverPlan.stability) {
      return `executionPlans[${index}].stability does not match server classification`;
    }
    const hashInput: Record<string, unknown> = {
      classifierVersion: plan.classifierVersion,
      dialect: plan.dialect,
      kind,
      name: plan.name,
      sqlHash: plan.sqlHash,
      stability: plan.stability,
    };
    if (kind === 'breakpoint-framed') {
      const serverStatements = serverPlan.kind === 'breakpoint-framed' ? serverPlan.statements : [];
      if (
        !Array.isArray(plan.statements) ||
        !plan.statements.every((value: unknown) => typeof value === 'string')
      ) {
        return `executionPlans[${index}].statements must be an array of strings`;
      }
      if (
        plan.statements.length !== serverStatements.length ||
        plan.statements.some((statement: string, statementIndex: number) => {
          return statement !== serverStatements[statementIndex];
        })
      ) {
        return `executionPlans[${index}].statements do not match server classification`;
      }
      hashInput.statements = plan.statements;
    } else if ('statements' in plan) {
      return `executionPlans[${index}].statements are only allowed for breakpoint-framed plans`;
    }
    const planHash = await sha256Hex(canonicalJson(hashInput));
    if (plan.planHash !== planHash) {
      return `executionPlans[${index}].planHash does not match plan contents`;
    }
    if (plan.planHash !== serverPlan.planHash) {
      return `executionPlans[${index}].planHash does not match server classification`;
    }
  }
  return null;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function classifyServerMigrationPlan(migration: {
  name: string;
  sql: string;
}): Promise<ServerMigrationPlan> {
  const sql = canonicalSql(migration.sql);
  const planWithoutHash: MigrationPlanHashInput = {
    ...classifySqlMigration(sql),
    classifierVersion: MIGRATION_CLASSIFIER_VERSION,
    dialect: 'sqlite',
    name: migration.name,
    sqlHash: await sha256Hex(sql),
  };
  return {
    ...planWithoutHash,
    planHash: await sha256Hex(canonicalJson(getMigrationPlanHashInput(planWithoutHash))),
  };
}
