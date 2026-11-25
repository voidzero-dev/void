import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { securityScans } from '../../src/schema.ts';
import { securityScanInputPrefix } from '../../src/security/enqueue.ts';
import { queueExposureCatchUpScans } from '../../src/security/exposure.ts';
import { projectSecuritySettings } from '../../src/security/schema.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { saveSecurityPolicy } from './security-fixtures.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  await saveSecurityPolicy(env, { mode: 'public' });
});

async function exposedProject() {
  const user = await createTestUser(env.db, `expo-${crypto.randomUUID()}`);
  const project = await createTestProject(env.db, user.id);
  const deployment = await createTestDeployment(env.db, project.id, 'live');
  await env.db.insert(securityScans).values({
    id: `ss_skip_${project.id}`,
    project_id: project.id,
    deployment_id: deployment.id,
    status: 'skipped',
    status_reason: 'protected',
    trigger: 'deploy',
    finished_at: new Date().toISOString(),
  } as typeof securityScans.$inferInsert);
  await env.STATIC_ASSETS_R2.put(
    `${securityScanInputPrefix(project.id, deployment.id)}modules.json`,
    '[]',
  );
  return { project, deployment };
}

describe('exposure catch-up', () => {
  it('queues one exposure scan for a public project whose deploy was skipped while protected', async () => {
    const { project } = await exposedProject();
    expect(await queueExposureCatchUpScans(env, env.db)).toBe(1);
    expect(await queueExposureCatchUpScans(env, env.db)).toBe(0);
    const rows = await env.db
      .select()
      .from(securityScans)
      .where(eq(securityScans.project_id, project.id));
    expect(rows.filter((row) => row.trigger === 'exposure')).toHaveLength(1);
  });

  it('queues nothing for a project whose rule is never (M34)', async () => {
    const { project } = await exposedProject();
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: project.id, policy_override: 'never' });
    expect(await queueExposureCatchUpScans(env, env.db)).toBe(0);
  });

  it('does not queue another scan after a failed exposure scan', async () => {
    const { project, deployment } = await exposedProject();
    expect(await queueExposureCatchUpScans(env, env.db)).toBe(1);
    await env.db
      .update(securityScans)
      .set({ status: 'failed', finished_at: new Date().toISOString() })
      .where(eq(securityScans.trigger, 'exposure'));
    expect(await queueExposureCatchUpScans(env, env.db)).toBe(0);
    const rows = await env.db
      .select()
      .from(securityScans)
      .where(eq(securityScans.deployment_id, deployment.id));
    expect(
      rows.filter((row) => row.project_id === project.id && row.trigger === 'exposure'),
    ).toHaveLength(1);
  });
});
