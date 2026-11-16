import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import type { AstNode } from '../shared/ast.ts';
import { listConventionFiles } from '../shared/convention-files.ts';
import {
  readStaticExports,
  staticLiteral,
  unwrapStaticExpression,
} from '../shared/static-exports.ts';

export type JobDefinition = {
  /** Relative file path from jobs/ */
  filePath: string;
  /** Deterministic job name (path without extension) */
  name: string;
  /** Cron expressions from `export const cron = "..."` or `export const cron = ["...", "..."]` */
  crons: Array<string>;
};

function extractJobName(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, '');
}

function extractCronExpressions(source: string, filePath: string): Array<string> {
  const initializer = unwrapStaticExpression(
    readStaticExports(filePath, source, new Set(['cron'])).initializers.get('cron'),
  );
  if (!initializer) {
    throw new Error(
      `cron: Invalid job file '${filePath}'. Add \`export const cron = "<schedule>"\`.`,
    );
  }
  const values =
    initializer.type === 'ArrayExpression'
      ? ((initializer.elements as Array<AstNode | null> | undefined) ?? [])
      : [initializer];
  if (values.length === 0) {
    throw new Error(`cron: Invalid job file '${filePath}'. Cron array cannot be empty.`);
  }
  return values.map((value) => {
    const cron = staticLiteral(value ?? undefined);
    if (typeof cron !== 'string' || !cron.trim()) {
      throw new Error(
        `cron: Invalid job file '${filePath}'. Cron expression must be a nonempty string literal.`,
      );
    }
    return cron.trim();
  });
}

export function scanJobsSync(cronsDir: string): Array<JobDefinition> {
  return listConventionFiles(cronsDir)
    .sort((leftFilePath, rightFilePath) => leftFilePath.localeCompare(rightFilePath))
    .map((filePath) => {
      const source = readFileSync(join(cronsDir, filePath), 'utf-8');
      return {
        filePath,
        name: extractJobName(filePath),
        crons: extractCronExpressions(source, filePath),
      };
    });
}
