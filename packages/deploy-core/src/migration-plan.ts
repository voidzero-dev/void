import { tokenizeSql } from './sql-tokenize.ts';

export const MIGRATION_CLASSIFIER_VERSION = 1;
export const UNSPLIT_MULTI_STATEMENT_PRAGMA = '-- void:allow-unsplit-multi-statement';

export type SqlMigrationClassification =
  | { kind: 'single-statement'; stability: 'stable' }
  | { kind: 'breakpoint-framed'; stability: 'stable'; statements: Array<string> }
  | { kind: 'legacy-unsplit-multi-statement'; stability: 'legacy'; allowLegacy: boolean };

export type MigrationPlanHashInput = SqlMigrationClassification & {
  name: string;
  dialect: 'sqlite';
  classifierVersion: number;
  sqlHash: string;
};

export function canonicalSql(sql: string): string {
  const withoutBom = sql.charCodeAt(0) === 0xfe_ff ? sql.slice(1) : sql;
  return withoutBom.replaceAll(/\r\n?/g, '\n');
}

export function hasStandalonePragma(sql: string, pragma: string): boolean {
  return canonicalSql(sql)
    .split('\n')
    .some((line) => line.trim() === pragma);
}

/** Yield `--> statement-breakpoint` line comments outside literals. */
function* breakpointComments(normalized: string): Generator<{ start: number; end: number }> {
  for (const segment of tokenizeSql(normalized)) {
    if (
      segment.kind === 'line-comment' &&
      normalized.slice(segment.start, segment.end).trim() === '--> statement-breakpoint'
    ) {
      yield segment;
    }
  }
}

function splitBreakpointFramedSql(sql: string): Array<string> {
  const normalized = canonicalSql(sql);
  const statements: Array<string> = [];
  let cursor = 0;

  for (const segment of breakpointComments(normalized)) {
    const statement = normalized.slice(cursor, segment.start).trim();
    if (statement) {
      statements.push(statement);
    }
    cursor = segment.end;
  }

  const statement = normalized.slice(cursor).trim();
  if (statement) {
    statements.push(statement);
  }
  return statements;
}

function hasStatementBreakpointOutsideLiterals(sql: string): boolean {
  return !breakpointComments(canonicalSql(sql)).next().done;
}

type StatementScan = {
  normalized: string;
  /** Statement ranges in `normalized`, each ending after its `;` when present. */
  ranges: Array<{ start: number; end: number }>;
  /** Whether bare SQL (outside literals and comments) contains BEGIN or TRIGGER. */
  hasCompoundBody: boolean;
};

function scanStatements(sql: string): StatementScan {
  const normalized = canonicalSql(sql);
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  let inStatement = false;
  let hasCompoundBody = false;

  for (const segment of tokenizeSql(normalized)) {
    if (segment.kind === 'line-comment' || segment.kind === 'block-comment') {
      continue;
    }
    if (segment.kind === 'string' || segment.kind === 'ident-quote') {
      inStatement = true;
      continue;
    }
    if (/\b(?:BEGIN|TRIGGER)\b/i.test(normalized.slice(segment.start, segment.end))) {
      hasCompoundBody = true;
    }
    for (let index = segment.start; index < segment.end; index++) {
      const character = normalized[index];
      if (character === ';') {
        if (inStatement) {
          ranges.push({ start: cursor, end: index + 1 });
          inStatement = false;
        }
        cursor = index + 1;
        continue;
      }
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
        inStatement = true;
      }
    }
  }

  if (inStatement) {
    ranges.push({ start: cursor, end: normalized.length });
  }
  return { normalized, ranges, hasCompoundBody };
}

export function isSingleStatement(sql: string): boolean {
  return scanStatements(sql).ranges.length === 1;
}

/**
 * Split SQL on top-level semicolons, ignoring literals and comments. Returns
 * null when a statement may contain a compound `BEGIN ... END` body (such as
 * CREATE TRIGGER), whose inner semicolons cannot be told apart lexically.
 */
export function splitSqlStatements(sql: string): Array<string> | null {
  const { normalized, ranges, hasCompoundBody } = scanStatements(sql);
  if (hasCompoundBody) {
    return null;
  }
  return ranges.map((range) => normalized.slice(range.start, range.end).trim());
}

/** Classify SQL without imposing the caller's execution policy or hashing implementation. */
export function classifySqlMigration(sql: string): SqlMigrationClassification {
  if (hasStatementBreakpointOutsideLiterals(sql)) {
    return {
      kind: 'breakpoint-framed',
      stability: 'stable',
      statements: splitBreakpointFramedSql(sql),
    };
  }
  if (isSingleStatement(sql)) {
    return { kind: 'single-statement', stability: 'stable' };
  }
  return {
    kind: 'legacy-unsplit-multi-statement',
    stability: 'legacy',
    allowLegacy: hasStandalonePragma(sql, UNSPLIT_MULTI_STATEMENT_PRAGMA),
  };
}

/** Preserve the classifier-v1 hash preimage; policy markers and warnings are not hashed. */
export function getMigrationPlanHashInput(plan: MigrationPlanHashInput): unknown {
  const base: Record<string, unknown> = {
    classifierVersion: plan.classifierVersion,
    dialect: plan.dialect,
    kind: plan.kind,
    name: plan.name,
    sqlHash: plan.sqlHash,
    stability: plan.stability,
  };
  if (plan.kind === 'breakpoint-framed') {
    base.statements = plan.statements;
  }
  return base;
}
