import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { PlatformEmailEnv } from '../../src/email.ts';
import {
  deployments,
  projectMembers,
  projects,
  projectZeroTrust,
  users,
} from '../../src/schema.ts';
import {
  enqueueSecurityCapNotifications,
  enqueueSecurityNotification,
  runSecurityNotifications,
  SECURITY_FINDINGS_COOLDOWN_MS,
  SECURITY_NOTIFICATION_BACKOFF_MS,
} from '../../src/security/notifications.ts';
import {
  resolveInstallationAdminRecipients,
  resolveProjectAdminRecipients,
  resolveProjectSecurityRecipients,
  resolvePublicRequestRecipients,
} from '../../src/security/recipients.ts';
import {
  projectSecuritySettings,
  securityFindingEvents,
  securityFindings,
  securityNotifications,
  securityProjectSpend,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/security/schema.ts';
import {
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
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
});

type Sent = { to: string; subject: string; text: string; html: string };

function mailer(options: { failFor?: ReadonlyArray<string> } = {}) {
  const sent: Array<Sent> = [];
  const attempts: Array<string> = [];
  const mail: PlatformEmailEnv = {
    EMAIL: {
      send: async (message: Sent) => {
        attempts.push(message.to);
        if (options.failFor?.includes(message.to)) {
          throw new Error('mail down');
        }
        sent.push(message);
        return { messageId: 'm' };
      },
    } as unknown as SendEmail,
    EMAIL_FROM: 'Void <noreply@example.com>',
    DASHBOARD_URL: undefined,
  };
  return { mail, sent, attempts };
}

async function person(
  name: string,
  options: { email?: string | null; role?: 'user' | 'admin' } = {},
) {
  const user = await createTestUser(env.db, `${name}-${crypto.randomUUID()}`);
  const email = options.email === undefined ? `${name}@example.com` : options.email;
  await env.db
    .update(users)
    .set({ email, role: options.role ?? 'user' })
    .where(eq(users.id, user.id));
  return { ...user, email };
}

async function setup() {
  const owner = await person('owner');
  const project = await createTestProject(env.db, owner.id);
  return { owner, project };
}

async function member(
  projectId: string,
  userId: string,
  role: 'reader' | 'collaborator' | 'admin',
) {
  await env.db.insert(projectMembers).values({ project_id: projectId, user_id: userId, role });
}

/** A deployment by `authorId` and a succeeded scan of it. */
async function scannedDeploy(
  projectId: string,
  scanId: string,
  authorId: string | null,
  finishedAt = new Date().toISOString(),
) {
  const deployment = await createTestDeployment(env.db, projectId, 'live');
  await env.db
    .update(deployments)
    .set({ initiated_by_user_id: authorId, commit: 'abcdef1234567' })
    .where(eq(deployments.id, deployment.id));
  await env.db.insert(securityScans).values({
    id: scanId,
    project_id: projectId,
    deployment_id: deployment.id,
    status: 'succeeded',
    trigger: 'deploy',
    tier: 'full',
    coverage: 'complete',
    files_scanned: 7,
    model_used: '@cf/zai-org/glm-5.3',
    finished_at: finishedAt,
  });
  return deployment;
}

function queueFindings(projectId: string, scanId: string) {
  return enqueueSecurityNotification(env.db, { kind: 'findings', projectId, scanId });
}

/** A time after the queued rows are due: a row is due from the database clock at its insert. */
const dueNow = () => Date.now() + 5000;

let findingNumber = 0;
async function newFinding(
  projectId: string,
  scanId: string,
  options: { severity?: 'critical' | 'high' | 'medium'; title?: string } = {},
) {
  const number = ++findingNumber;
  const id = `sf_test${number}`;
  await env.db.insert(securityFindings).values({
    id,
    project_id: projectId,
    number,
    fingerprint_key: `fp-${id}`,
    verdict: 'confirmed',
    severity: options.severity ?? 'high',
    title: options.title ?? `Finding ${number}`,
    category: 'injection',
    file: 'src/a.ts',
    first_scan_id: scanId,
    last_seen_scan_id: scanId,
  });
  await env.db.insert(securityFindingEvents).values({
    id: `sfe_test${number}`,
    finding_id: id,
    project_id: projectId,
    scan_id: scanId,
    actor_kind: 'scanner',
    action: 'created',
  });
  return { id, number };
}

describe('findings email recipients (spec §12)', () => {
  it('sends to the owner, the admins and each deploy author, once each (#46)', async () => {
    const { owner, project } = await setup();
    const admin = await person('admin');
    const authorA = await person('a');
    const authorB = await person('b');
    const authorC = await person('c');
    await member(project.id, admin.id, 'admin');
    await member(project.id, authorA.id, 'collaborator');
    await member(project.id, authorB.id, 'collaborator');
    // The admin also deployed: one email, with the owner/admin reason.
    await scannedDeploy(project.id, 'scan_1', authorA.id);
    const second = await scannedDeploy(project.id, 'scan_2', authorB.id);
    await scannedDeploy(project.id, 'scan_3', admin.id);
    // Not a member at all any more: skipped.
    await scannedDeploy(project.id, 'scan_4', authorC.id);

    const recipients = await resolveProjectSecurityRecipients(env.db, project.id, {
      scanIds: ['scan_1', 'scan_2', 'scan_3', 'scan_4'],
    });
    const byUser = new Map(recipients.map((recipient) => [recipient.userId, recipient.reason]));
    expect([...byUser.keys()].sort()).toEqual([owner.id, admin.id, authorA.id, authorB.id].sort());
    expect(byUser.get(owner.id)).toEqual({ kind: 'owner_admin' });
    expect(byUser.get(admin.id)).toEqual({ kind: 'owner_admin' });
    expect(byUser.get(authorB.id)).toEqual({ kind: 'author', deploymentIds: [second.id] });
  });

  it('includes the authors of deployments a coalesced scan superseded (#46)', async () => {
    const { owner, project } = await setup();
    const authors = [await person('a'), await person('b'), await person('c')];
    const deploymentIds: Array<string> = [];
    for (const [index, author] of authors.entries()) {
      await member(project.id, author.id, 'collaborator');
      deploymentIds.push((await scannedDeploy(project.id, `scan_${index}`, author.id)).id);
    }
    // scan_0 -> scan_1 -> scan_2: only the last one ran.
    for (const [from, to] of [
      ['scan_0', 'scan_1'],
      ['scan_1', 'scan_2'],
    ] as const) {
      await env.db
        .update(securityScans)
        .set({ status: 'superseded', superseded_by_scan_id: to })
        .where(eq(securityScans.id, from));
    }

    const recipients = await resolveProjectSecurityRecipients(env.db, project.id, {
      scanIds: ['scan_2'],
    });
    const byUser = new Map(recipients.map((recipient) => [recipient.userId, recipient.reason]));
    expect([...byUser.keys()].sort()).toEqual([owner.id, ...authors.map((a) => a.id)].sort());
    expect(byUser.get(authors[0].id)).toEqual({
      kind: 'author',
      deploymentIds: [deploymentIds[0]],
    });
  });

  it('skips an author who lost deploy before the send (#47)', async () => {
    const { project } = await setup();
    const author = await person('author');
    await member(project.id, author.id, 'collaborator');
    await scannedDeploy(project.id, 'scan_1', author.id);
    await env.db
      .update(projectMembers)
      .set({ role: 'reader' })
      .where(eq(projectMembers.user_id, author.id));
    const demoted = await resolveProjectSecurityRecipients(env.db, project.id, {
      scanIds: ['scan_1'],
    });
    expect(demoted.some((recipient) => recipient.userId === author.id)).toBe(false);

    await env.db.delete(projectMembers).where(eq(projectMembers.user_id, author.id));
    const removed = await resolveProjectSecurityRecipients(env.db, project.id, {
      scanIds: ['scan_1'],
    });
    expect(removed.some((recipient) => recipient.userId === author.id)).toBe(false);
  });

  it('adds no author for a deployment with no user (#48)', async () => {
    const { owner, project } = await setup();
    await scannedDeploy(project.id, 'scan_1', null);
    const recipients = await resolveProjectSecurityRecipients(env.db, project.id, {
      scanIds: ['scan_1'],
    });
    expect(recipients.map((recipient) => recipient.userId)).toEqual([owner.id]);
  });

  it('follows an owner transfer, worked out at send time (#25)', async () => {
    const { owner, project } = await setup();
    const next = await person('next');
    await env.db.update(projects).set({ user_id: next.id }).where(eq(projects.id, project.id));
    const recipients = await resolveProjectAdminRecipients(env.db, project.id);
    expect(recipients.map((recipient) => recipient.userId)).toEqual([next.id]);
    expect(recipients.some((recipient) => recipient.userId === owner.id)).toBe(false);
  });

  it('skips a user with no email or a suspended account (#27)', async () => {
    const { owner, project } = await setup();
    const quiet = await person('quiet', { email: null });
    const suspended = await person('suspended');
    await member(project.id, quiet.id, 'admin');
    await member(project.id, suspended.id, 'admin');
    await env.db.update(users).set({ suspended_reason: 'abuse' }).where(eq(users.id, suspended.id));
    const recipients = await resolveProjectAdminRecipients(env.db, project.id);
    expect(recipients.map((recipient) => recipient.userId)).toEqual([owner.id]);
  });
});

describe('public request and installation recipients', () => {
  it('follows the new owner while a request is open (#69)', async () => {
    const { owner, project } = await setup();
    const requester = await person('requester');
    await member(project.id, requester.id, 'admin');
    const next = await person('next');
    await env.db.update(projects).set({ user_id: next.id }).where(eq(projects.id, project.id));
    const recipients = await resolvePublicRequestRecipients(env.db, project.id, requester.id);
    const ids = recipients.map((recipient) => recipient.userId);
    expect(ids).toContain(next.id);
    expect(ids).not.toContain(owner.id);
    expect(recipients.find((recipient) => recipient.userId === requester.id)?.reason).toEqual({
      kind: 'requester',
    });
  });

  it('skips a requester who lost settings; the others still get it (#70)', async () => {
    const { owner, project } = await setup();
    const requester = await person('requester');
    await member(project.id, requester.id, 'admin');
    await env.db
      .update(projectMembers)
      .set({ role: 'collaborator' })
      .where(eq(projectMembers.user_id, requester.id));
    const recipients = await resolvePublicRequestRecipients(env.db, project.id, requester.id);
    expect(recipients.map((recipient) => recipient.userId)).toEqual([owner.id]);
    await env.db.delete(projectMembers).where(eq(projectMembers.user_id, requester.id));
    expect(
      (await resolvePublicRequestRecipients(env.db, project.id, requester.id)).map(
        (recipient) => recipient.userId,
      ),
    ).toEqual([owner.id]);
  });

  it('lists installation admins with an email and no suspension', async () => {
    const root = await person('root', { role: 'admin' });
    await person('root-quiet', { role: 'admin', email: null });
    const away = await person('root-away', { role: 'admin' });
    await env.db.update(users).set({ suspended_reason: 'x' }).where(eq(users.id, away.id));
    await person('plain');
    const recipients = await resolveInstallationAdminRecipients(env.db);
    expect(recipients.map((recipient) => recipient.userId)).toEqual([root.id]);
    expect(recipients[0].reason).toEqual({ kind: 'installation_admin' });
  });
});

describe('the outbox', () => {
  it('sends one email per recipient per scan, and not again (exit: one email per scan)', async () => {
    const { owner, project } = await setup();
    const admin = await person('admin');
    await member(project.id, admin.id, 'admin');
    await scannedDeploy(project.id, 'scan_1', owner.id);
    await newFinding(project.id, 'scan_1', { severity: 'critical', title: 'SQL built from query' });
    await newFinding(project.id, 'scan_1', { severity: 'medium' });
    expect(await queueFindings(project.id, 'scan_1')).toBe(true);
    // The same scan queued twice is one row.
    expect(await queueFindings(project.id, 'scan_1')).toBe(false);

    const { mail, sent } = mailer();
    const run = await runSecurityNotifications(env.db, mail);
    expect(run).toMatchObject({ sent: 1, skipped: 0, failed: 0, nextAt: null });
    expect(sent.map((message) => message.to).sort()).toEqual([
      'admin@example.com',
      'owner@example.com',
    ]);
    expect(sent[0].subject).toContain(
      `${project.slug}: 2 new security findings (1 critical, 1 medium)`,
    );
    expect(sent[0].text).toContain('SQL built from query');

    await runSecurityNotifications(env.db, mail);
    expect(sent).toHaveLength(2);
  });

  it('holds a second scan for 30 minutes, then sends it (cooldown)', async () => {
    const { project } = await setup();
    await scannedDeploy(project.id, 'scan_1', null);
    await newFinding(project.id, 'scan_1');
    await scannedDeploy(project.id, 'scan_2', null);
    await newFinding(project.id, 'scan_2');
    const { mail, sent } = mailer();
    const t0 = dueNow();

    await queueFindings(project.id, 'scan_1');
    await runSecurityNotifications(env.db, mail, t0);
    expect(sent).toHaveLength(1);

    await queueFindings(project.id, 'scan_2');
    const early = await runSecurityNotifications(env.db, mail, t0 + 60_000);
    expect(sent).toHaveLength(1);
    expect(early.nextAt).not.toBeNull();
    expect(Math.abs(early.nextAt! - (t0 + SECURITY_FINDINGS_COOLDOWN_MS))).toBeLessThan(5000);

    const late = await runSecurityNotifications(
      env.db,
      mail,
      t0 + SECURITY_FINDINGS_COOLDOWN_MS + 5000,
    );
    expect(late.sent).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('merges scans that wait together into one email with every author', async () => {
    const { project } = await setup();
    const a = await person('a');
    const b = await person('b');
    await member(project.id, a.id, 'collaborator');
    await member(project.id, b.id, 'collaborator');
    await scannedDeploy(project.id, 'scan_1', a.id);
    await newFinding(project.id, 'scan_1');
    await scannedDeploy(project.id, 'scan_2', b.id);
    await newFinding(project.id, 'scan_2');
    for (const scanId of ['scan_1', 'scan_2']) {
      await queueFindings(project.id, scanId);
    }
    const { mail, sent } = mailer();
    const run = await runSecurityNotifications(env.db, mail);
    expect(run.sent).toBe(2);
    expect(sent.map((message) => message.to).sort()).toEqual([
      'a@example.com',
      'b@example.com',
      'owner@example.com',
    ]);
    expect(sent[0].subject).toContain('2 new security findings');
    expect(sent[0].text).toContain('2 security scans');
  });

  it('skips a scan whose findings were resolved before the send', async () => {
    const { project } = await setup();
    await scannedDeploy(project.id, 'scan_1', null);
    const finding = await newFinding(project.id, 'scan_1');
    await env.db
      .update(securityFindings)
      .set({
        state: 'resolved',
        resolution: 'false_positive',
        resolved_at: new Date().toISOString(),
      })
      .where(eq(securityFindings.id, finding.id));
    await queueFindings(project.id, 'scan_1');
    const { mail, sent } = mailer();
    expect(await runSecurityNotifications(env.db, mail)).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent).toEqual([]);
  });

  it('counts a raise to critical as new again, even when the finding was already urgent (§9.4 decision)', async () => {
    const { project } = await setup();
    await scannedDeploy(project.id, 'scan_1', null);
    const finding = await newFinding(project.id, 'scan_1', { severity: 'high' });
    await queueFindings(project.id, 'scan_1');
    const { mail, sent } = mailer();
    const t0 = dueNow();
    await runSecurityNotifications(env.db, mail, t0);
    expect(sent).toHaveLength(1);

    // A later scan raises the same finding from high to critical. The event keeps no old
    // severity, so the email cannot tell this from medium to critical and sends it again.
    await scannedDeploy(project.id, 'scan_2', null);
    await env.db
      .update(securityFindings)
      .set({ severity: 'critical' })
      .where(eq(securityFindings.id, finding.id));
    await env.db.insert(securityFindingEvents).values({
      id: 'sfe_raise',
      finding_id: finding.id,
      project_id: project.id,
      scan_id: 'scan_2',
      actor_kind: 'scanner',
      action: 'severity_changed',
    });
    await queueFindings(project.id, 'scan_2');
    await runSecurityNotifications(env.db, mail, t0 + SECURITY_FINDINGS_COOLDOWN_MS + 1000);
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain('(critical)');
  });

  it('does not announce a raise that ends below high', async () => {
    const { project } = await setup();
    await scannedDeploy(project.id, 'scan_1', null);
    const finding = await newFinding(project.id, 'scan_1', { severity: 'medium' });
    await env.db
      .delete(securityFindingEvents)
      .where(eq(securityFindingEvents.finding_id, finding.id));
    await env.db.insert(securityFindingEvents).values({
      id: 'sfe_raise_medium',
      finding_id: finding.id,
      project_id: project.id,
      scan_id: 'scan_1',
      actor_kind: 'scanner',
      action: 'severity_changed',
    });
    await queueFindings(project.id, 'scan_1');
    const { mail, sent } = mailer();
    expect(await runSecurityNotifications(env.db, mail)).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent).toEqual([]);
  });

  it('skips quietly when email is unbound (#27)', async () => {
    const { project } = await setup();
    await scannedDeploy(project.id, 'scan_1', null);
    await newFinding(project.id, 'scan_1');
    await queueFindings(project.id, 'scan_1');
    const run = await runSecurityNotifications(env.db, {
      EMAIL: undefined,
    });
    expect(run.nextAt).toBeNull();
    const [row] = await env.db.select().from(securityNotifications);
    expect(row.status).toBe('skipped');
  });

  it('retries with back-off and gives up after the third attempt', async () => {
    const { project } = await setup();
    await scannedDeploy(project.id, 'scan_1', null);
    await newFinding(project.id, 'scan_1');
    await queueFindings(project.id, 'scan_1');
    const { mail, sent, attempts } = mailer({ failFor: ['owner@example.com'] });
    const t0 = dueNow();

    const first = await runSecurityNotifications(env.db, mail, t0);
    expect(first.sent).toBe(0);
    expect(Math.abs(first.nextAt! - (t0 + SECURITY_NOTIFICATION_BACKOFF_MS[0]))).toBeLessThan(5000);
    // Not due yet: no new attempt.
    await runSecurityNotifications(env.db, mail, t0 + 1000);
    expect(attempts).toHaveLength(1);

    const second = await runSecurityNotifications(env.db, mail, t0 + 61_000);
    expect(
      Math.abs(second.nextAt! - (t0 + 61_000 + SECURITY_NOTIFICATION_BACKOFF_MS[1])),
    ).toBeLessThan(5000);
    const third = await runSecurityNotifications(env.db, mail, t0 + 61_000 + 301_000);
    expect(third).toMatchObject({ failed: 1, nextAt: null });
    expect(attempts).toHaveLength(3);
    expect(sent).toEqual([]);
    const [row] = await env.db.select().from(securityNotifications);
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('does not repeat the email to the others when one address fails', async () => {
    const { project } = await setup();
    const admin = await person('admin');
    await member(project.id, admin.id, 'admin');
    await scannedDeploy(project.id, 'scan_1', null);
    await newFinding(project.id, 'scan_1');
    await queueFindings(project.id, 'scan_1');
    const { mail, sent, attempts } = mailer({ failFor: ['admin@example.com'] });
    expect(await runSecurityNotifications(env.db, mail)).toMatchObject({ sent: 1 });
    expect(sent.map((message) => message.to)).toEqual(['owner@example.com']);
    await runSecurityNotifications(env.db, mail);
    expect(attempts).toHaveLength(2);
  });

  it('emails every installation admin for a bypass and records it (exit)', async () => {
    const { owner, project } = await setup();
    await person('root-a', { role: 'admin' });
    await person('root-b', { role: 'admin' });
    const request = await openRequest(project.id, owner.id);
    await env.db.insert(securityScanBypasses).values({
      id: 'sbp_1',
      project_id: project.id,
      request_id: request.id,
      deployment_id: 'dpl_a3f0',
      actor_kind: 'user',
      actor_user_id: owner.id,
      actor_role: 'owner',
      reason: `Scanner down <b>${'z'.repeat(400)}`,
      request_state: 'held_no_result',
    });
    await enqueueSecurityNotification(env.db, {
      kind: 'scan_bypass',
      projectId: project.id,
      requestId: request.id,
      bypassId: 'sbp_1',
    });
    const { mail, sent } = mailer();
    expect(await runSecurityNotifications(env.db, mail)).toMatchObject({ sent: 1 });
    expect(sent.map((message) => message.to).sort()).toEqual([
      'root-a@example.com',
      'root-b@example.com',
    ]);
    expect(sent[0].subject).toBe(
      `[Void Cloud] ${project.slug}: security scan bypassed by the owner`,
    );
    expect(sent[0].text).toContain('owner@example.com (owner)');
    expect(sent[0].text).not.toContain('z'.repeat(301));
    expect(sent[0].html).not.toContain('<b>Scanner');
    const [bypass] = await env.db
      .select()
      .from(securityScanBypasses)
      .where(eq(securityScanBypasses.id, 'sbp_1'));
    expect(bypass.notified_at).not.toBeNull();
  });

  it('says files were left unread, not "did not finish (succeeded)", in the held and bypass emails', async () => {
    const { owner, project } = await setup();
    await person('root-a', { role: 'admin' });
    await scannedDeploy(project.id, 'scan_unread', null);
    const request = await openRequest(project.id, owner.id, 'held_no_result');
    await env.db
      .update(securityPublicRequests)
      .set({ held_reason: 'unread_files', gate_scan_id: 'scan_unread' })
      .where(eq(securityPublicRequests.id, request.id));
    await enqueueSecurityNotification(env.db, {
      kind: 'public_held',
      projectId: project.id,
      requestId: request.id,
      state: 'held_no_result',
      gateScanId: 'scan_unread',
    });
    await env.db.insert(securityScanBypasses).values({
      id: 'sbp_unread',
      project_id: project.id,
      request_id: request.id,
      deployment_id: 'dpl_target',
      actor_kind: 'user',
      actor_user_id: owner.id,
      actor_role: 'owner',
      reason: 'Fonts are binary',
      request_state: 'held_no_result',
      held_reason: 'unread_files',
      gate_scan_id: 'scan_unread',
    });
    await enqueueSecurityNotification(env.db, {
      kind: 'scan_bypass',
      projectId: project.id,
      requestId: request.id,
      bypassId: 'sbp_unread',
    });
    const { mail, sent } = mailer();
    await runSecurityNotifications(env.db, mail);
    const held = sent.find((message) => message.subject.includes('stays protected'));
    const bypass = sent.find((message) => message.subject.includes('bypassed'));
    expect(held?.subject).toBe(
      `[Void Cloud] ${project.slug} stays protected: the security scan could not read some project files`,
    );
    expect(held?.text).toContain('Fix them and deploy again, or bypass the scan.');
    expect(held?.text).not.toContain('Ask again');
    expect(bypass?.text).toContain('the scan could not read some project files');
    expect(bypass?.text).not.toContain('succeeded');
  });

  async function openRequest(
    projectId: string,
    userId: string,
    state:
      | 'held_findings'
      | 'held_no_result'
      | 'needs_deploy'
      | 'passed'
      | 'bypassed'
      | 'canceled' = 'held_no_result',
  ) {
    const id = `spr_${crypto.randomUUID().slice(0, 8)}`;
    const closed = ['passed', 'bypassed', 'canceled'].includes(state);
    await env.db.insert(securityPublicRequests).values({
      id,
      project_id: projectId,
      state,
      requested_by_user_id: userId,
      requested_via: 'project',
      target_deployment_id: 'dpl_target',
      cancel_cause: state === 'canceled' ? 'gate_off' : null,
      closed_at: closed ? new Date().toISOString() : null,
    });
    return { id };
  }

  it('sends the held email only while the request is still in that state, and never offers a bypass for urgent findings', async () => {
    const { owner, project } = await setup();
    await scannedDeploy(project.id, 'scan_1', null);
    const finding = await newFinding(project.id, 'scan_1', {
      severity: 'critical',
      title: 'Open redirect',
    });
    const request = await openRequest(project.id, owner.id, 'held_findings');
    await env.db
      .update(securityPublicRequests)
      .set({ blockers: 1, blocker_ids: [`F-${finding.number}`], gate_scan_id: 'scan_1' })
      .where(eq(securityPublicRequests.id, request.id));
    await enqueueSecurityNotification(env.db, {
      kind: 'public_held',
      projectId: project.id,
      requestId: request.id,
      state: 'held_findings',
      gateScanId: 'scan_1',
    });
    const { mail, sent } = mailer();
    await runSecurityNotifications(env.db, mail);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Open redirect');
    expect(sent[0].text).not.toMatch(/bypass/i);
    expect(sent[0].text).toContain('You get this because you asked');

    // A held row for a state the request already left is dropped.
    await env.db
      .update(securityPublicRequests)
      .set({ state: 'canceled', cancel_cause: 'gate_off', closed_at: new Date().toISOString() })
      .where(eq(securityPublicRequests.id, request.id));
    await enqueueSecurityNotification(env.db, {
      kind: 'public_held',
      projectId: project.id,
      requestId: request.id,
      state: 'needs_deploy',
      gateScanId: null,
    });
    expect(await runSecurityNotifications(env.db, mail)).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('sends "now public" only once Zero Trust is off, and says canceled only for gate or policy off', async () => {
    const { owner, project } = await setup();
    const request = await openRequest(project.id, owner.id, 'passed');
    await env.db.insert(projectZeroTrust).values({
      project_id: project.id,
      desired_protected: false,
      effective_protected: true,
      status: 'reconciling',
    });
    await enqueueSecurityNotification(env.db, {
      kind: 'public_now_public',
      projectId: project.id,
      requestId: request.id,
    });
    const { mail, sent } = mailer();
    const t0 = dueNow();
    const waiting = await runSecurityNotifications(env.db, mail, t0);
    expect(sent).toEqual([]);
    expect(waiting.nextAt).not.toBeNull();

    await env.db
      .update(projectZeroTrust)
      .set({ effective_protected: false, status: 'ready' })
      .where(eq(projectZeroTrust.project_id, project.id));
    await runSecurityNotifications(env.db, mail, t0 + 120_000);
    expect(sent.map((message) => message.subject)).toEqual([
      `[Void Cloud] ${project.slug} is now public (security scan passed)`,
    ]);

    // `protect` cancels quietly.
    const quiet = await openRequest(project.id, owner.id, 'canceled');
    await env.db
      .update(securityPublicRequests)
      .set({ cancel_cause: 'protect' })
      .where(eq(securityPublicRequests.id, quiet.id));
    await enqueueSecurityNotification(env.db, {
      kind: 'public_canceled',
      projectId: project.id,
      requestId: quiet.id,
    });
    expect(await runSecurityNotifications(env.db, mail, t0 + 130_000)).toMatchObject({
      skipped: 1,
    });
    expect(sent).toHaveLength(1);
  });
});

describe('cap rows', () => {
  it('queues each threshold once per cap per month', async () => {
    const { project } = await setup();
    const caps = { projectNano: 100_000_000_000, platformNano: null };
    const call = (spent: number) =>
      enqueueSecurityCapNotifications(env.db, {
        projectId: project.id,
        month: '2026-11-01',
        caps,
        projectSpentNano: spent,
        platformSpentNano: 0,
      });
    expect(await call(50_000_000_000)).toBe(false);
    expect(await call(80_000_000_000)).toBe(true);
    expect(await call(85_000_000_000)).toBe(false);
    expect(await call(100_000_000_000)).toBe(true);
    expect(await call(100_000_000_000)).toBe(false);
    const rows = await env.db.select().from(securityNotifications);
    expect(rows.map((row) => row.dedupe_key).sort()).toEqual([
      `cap_project:${project.id}:2026-11-01:100`,
      `cap_project:${project.id}:2026-11-01:80`,
    ]);
  });

  it('emails the owner and project admins for a project cap', async () => {
    const { project } = await setup();
    const admin = await person('admin');
    await member(project.id, admin.id, 'admin');
    await enqueueSecurityCapNotifications(env.db, {
      projectId: project.id,
      month: '2026-11-01',
      caps: { projectNano: 100_000_000_000, platformNano: null },
      projectSpentNano: 100_000_000_000,
      platformSpentNano: 0,
    });
    await env.db
      .insert(securityProjectSpend)
      .values({ project_id: project.id, month: '2026-11-01', spent_nano_usd: 100_000_000_000 });
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: project.id, monthly_cap_cents: 10_000 });
    const { mail, sent } = mailer();
    await runSecurityNotifications(env.db, mail);
    expect(sent.map((message) => message.to).sort()).toEqual([
      'admin@example.com',
      'owner@example.com',
    ]);
    expect(sent[0].subject).toContain('monthly security scan budget used up');
    expect(sent[0].text).toContain('void project security budget --usd');
  });
});
