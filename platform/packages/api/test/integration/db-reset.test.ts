import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import {
  builds,
  deployments,
  githubWebhookRedeliveries,
  oauthAccounts,
  platformSettings,
  projectMembers,
  projectOwnershipPeriods,
  projects,
  users,
} from '../../src/schema.ts';
import {
  createTestBuild,
  captureQueries,
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
  await clearTables(env.db);
});

afterAll(async () => {
  await teardownEnv();
});

it('resets linked fixtures and independent ledgers in one query without resetting migrations', async () => {
  const migrations = await env.db.execute(
    sql`select * from drizzle.__drizzle_migrations order by id`,
  );
  expect(migrations.rows.length).toBeGreaterThan(0);

  const user = await createTestUser(env.db);
  const project = await createTestProject(env.db, user.id);
  const deployment = await createTestDeployment(env.db, project.id);
  const build = await createTestBuild(env.db, {
    projectId: project.id,
    userId: user.id,
  });
  await env.db.update(builds).set({ deployment_id: deployment.id }).where(eq(builds.id, build.id));
  await env.db.insert(projectMembers).values({
    project_id: project.id,
    user_id: user.id,
    role: 'reader',
  });
  await env.db.insert(githubWebhookRedeliveries).values({
    id: 'redelivery-reset',
    guid: 'guid-reset',
    delivery_id: '42',
  });
  await env.db.insert(platformSettings).values({ key: 'reset-test', value: { enabled: true } });

  const { queries } = await captureQueries(env.db, () => clearTables(env.db));
  expect(queries).toHaveLength(1);
  for (const table of [
    users,
    oauthAccounts,
    projects,
    deployments,
    builds,
    projectMembers,
    projectOwnershipPeriods,
    githubWebhookRedeliveries,
    platformSettings,
  ]) {
    expect(await env.db.select().from(table)).toEqual([]);
  }
  expect(
    (await env.db.execute(sql`select * from drizzle.__drizzle_migrations order by id`)).rows,
  ).toEqual(migrations.rows);

  await clearTables(env.db);
  expect((await createTestUser(env.db)).id).not.toBe(user.id);
});
