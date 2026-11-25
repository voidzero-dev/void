import { canonicalJson } from '@void/deploy-core';
import { describe, expect, it } from 'vite-plus/test';
import {
  classifyServerMigrationPlan,
  sha256Hex,
  validateSubmittedExecutionPlans,
} from '../../src/migrations/execution-plan.ts';

async function buildPlan(input: {
  name: string;
  sql: string;
  kind: 'single-statement' | 'breakpoint-framed' | 'legacy-unsplit-multi-statement';
  stability: 'stable' | 'legacy';
  statements?: Array<string>;
}): Promise<Record<string, unknown>> {
  const plan: Record<string, unknown> = {
    classifierVersion: 1,
    dialect: 'sqlite',
    kind: input.kind,
    name: input.name,
    sqlHash: await sha256Hex(input.sql.replaceAll(/\r\n?/g, '\n')),
    stability: input.stability,
  };
  if (input.kind === 'breakpoint-framed') {
    plan.statements = input.statements ?? [];
  }
  plan.planHash = await sha256Hex(canonicalJson(plan));
  return plan;
}

describe('migration execution plans', () => {
  it('classifies and hashes breakpoint-framed migrations', async () => {
    const sql = 'CREATE TABLE a (id TEXT);\n--> statement-breakpoint\nCREATE TABLE b (id TEXT);';
    await expect(classifyServerMigrationPlan({ name: '001.sql', sql })).resolves.toEqual(
      expect.objectContaining({
        classifierVersion: 1,
        dialect: 'sqlite',
        kind: 'breakpoint-framed',
        name: '001.sql',
        stability: 'stable',
        statements: ['CREATE TABLE a (id TEXT);', 'CREATE TABLE b (id TEXT);'],
      }),
    );
  });

  it('rejects submitted plans whose statements do not match server classification', async () => {
    const sql =
      "INSERT INTO logs(message) VALUES('--> statement-breakpoint');\n" +
      'CREATE TABLE later (id TEXT);';
    const error = await validateSubmittedExecutionPlans(
      [{ name: '001.sql', sql }],
      [
        await buildPlan({
          name: '001.sql',
          sql,
          kind: 'breakpoint-framed',
          stability: 'stable',
          statements: ["INSERT INTO logs(message) VALUES('", "');\nCREATE TABLE later (id TEXT);"],
        }),
      ],
    );

    expect(error).toContain('kind does not match server classification');
  });

  it('accepts submitted plans that match server classification', async () => {
    const sql = 'CREATE TABLE a (id TEXT);\n--> statement-breakpoint\nCREATE TABLE b (id TEXT);';
    await expect(
      validateSubmittedExecutionPlans(
        [{ name: '001.sql', sql }],
        [
          await buildPlan({
            name: '001.sql',
            sql,
            kind: 'breakpoint-framed',
            stability: 'stable',
            statements: ['CREATE TABLE a (id TEXT);', 'CREATE TABLE b (id TEXT);'],
          }),
        ],
      ),
    ).resolves.toBeNull();
  });
});
