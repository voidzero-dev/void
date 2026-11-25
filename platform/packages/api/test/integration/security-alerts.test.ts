import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { app } from '../../src/index.ts';
import { getPlatformSetting, setPlatformSetting } from '../../src/platform-settings.ts';
import { operatorEvents, projectMembers, users } from '../../src/schema.ts';
import {
  queueSecurityDigest,
  queueSecurityStreakNotifications,
} from '../../src/security/alerts.ts';
import { securityDigestWeek } from '../../src/security/digest.ts';
import {
  enqueueSecurityNotification,
  runSecurityNotifications,
} from '../../src/security/notifications.ts';
import type { SecurityNotifyEnv } from '../../src/security/notifications.ts';
import {
  securityFindings,
  securityNotifications,
  securityScans,
} from '../../src/security/schema.ts';
import { listSecurityProjectStreaks, SECURITY_STREAK_WINDOW } from '../../src/security/streaks.ts';
import {
  SECURITY_WEBHOOK_SETTINGS_KEY,
  securityWebhookSignature,
  setSecurityWebhook,
} from '../../src/security/webhook.ts';
import {
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const OPUS = 'anthropic/claude-opus-5.5';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let env: TestEnv;
/** The keyring env the outbox uses: the webhook secret is bound to this installation id. */
let keyring: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
  keyring = { ...env, PLATFORM_INSTALLATION_ID: 'installation-test' };
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Sent = { to: string; subject: string; text: string };

/** The outbox env: a recording mail binding (or none) and the test keyring. */
function outbox(options: { email?: boolean } = {}) {
  const sent: Array<Sent> = [];
  const mail = {
    EMAIL:
      options.email === false
        ? undefined
        : ({
            send: async (message: Sent) => {
              sent.push(message);
              return { messageId: 'm' };
            },
          } as unknown as SendEmail),
    EMAIL_FROM: 'Void <noreply@example.com>',
    DASHBOARD_URL: undefined,
    PROJECT_SECRET_KEYS_JSON: env.PROJECT_SECRET_KEYS_JSON,
    PROJECT_SECRET_ACTIVE_KEY_VERSION: env.PROJECT_SECRET_ACTIVE_KEY_VERSION,
    PLATFORM_INSTALLATION_ID: 'installation-test',
    AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
  } as SecurityNotifyEnv;
  return { mail, sent };
}

async function person(name: string, role: 'user' | 'admin' = 'user') {
  const user = await createTestUser(env.db, `${name}-${crypto.randomUUID().slice(0, 6)}`);
  await env.db
    .update(users)
    .set({ email: `${name}@example.com`, role })
    .where(eq(users.id, user.id));
  return user;
}

async function savePolicy(overrides: Partial<SecurityPolicy> = {}) {
  const policy = { ...defaultSecurityPolicy(), mode: 'all' as const, revision: 1, ...overrides };
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, policy);
  return policy;
}

async function project(slug = `app-${crypto.randomUUID().slice(0, 6)}`) {
  const owner = await person(`owner-${slug}`);
  const row = await createTestProject(env.db, owner.id, slug);
  const deployment = await createTestDeployment(env.db, row.id, 'live');
  return { owner, project: row, deployment };
}

let sequence = 0;

/** An ended scan, created `ageMs` ago (older first, so the order is the call order). */
async function scan(
  projectId: string,
  deploymentId: string,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  const id = overrides.id ?? `ss_${String(++sequence).padStart(4, '0')}`;
  const at = new Date(Date.now() - 10 * 60_000 + sequence * 1000).toISOString();
  await env.db.insert(securityScans).values({
    status: 'refused',
    failure_cause: 'project',
    trigger: 'deploy',
    model_used: OPUS,
    created_at: at,
    finished_at: at,
    ...overrides,
    id,
    project_id: projectId,
    deployment_id: deploymentId,
  });
  return id;
}

async function rows() {
  return env.db.select().from(securityNotifications);
}

describe('project failure streak email', () => {
  it('mails owner, project admins and installation admins once per streak', async () => {
    await savePolicy();
    const { project: app, deployment, owner } = await project('acme-web');
    const admin = await person('proj-admin');
    await env.db
      .insert(projectMembers)
      .values({ project_id: app.id, user_id: admin.id, role: 'admin' });
    const root = await person('root', 'admin');
    const good = await scan(app.id, deployment.id, { status: 'succeeded', failure_cause: null });
    await scan(app.id, deployment.id);
    await scan(app.id, deployment.id, { status: 'timed_out' });
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(0);
    await scan(app.id, deployment.id, {
      status: 'failed',
      status_reason: 'bad_output',
      error_class: 'not_json',
    });

    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(1);
    // A fourth failure is the same streak: no second email.
    await scan(app.id, deployment.id);
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(0);
    const [row] = await rows();
    expect(row).toMatchObject({
      kind: 'streak_project',
      dedupe_key: `streak_project:${app.id}:${good}`,
    });

    const { mail, sent } = outbox();
    expect(await runSecurityNotifications(env.db, mail)).toMatchObject({ sent: 1, failed: 0 });
    expect(sent.map((message) => message.to).sort()).toEqual([
      `owner-acme-web@example.com`,
      'proj-admin@example.com',
      'root@example.com',
    ]);
    const message = sent[0];
    expect(message.subject).toBe(
      '[Void Platform] acme-web: 4 security scans in a row did not finish',
    );
    expect(message.text).toContain(`refused by ${OPUS}`);
    expect(message.text).toContain('bad output (not_json)');
    expect(message.text).toContain(
      'void project security model @cf/deepseek-ai/deepseek-v4.1-flash-1017',
    );
    expect(message.text).toContain('void platform security fallback on');
    void owner;
    void root;
  });

  it('starts a new streak after a success, and ignores platform failures and old streaks', async () => {
    await savePolicy();
    const { project: app, deployment } = await project();
    for (let i = 0; i < 3; i++) {
      await scan(app.id, deployment.id);
    }
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(1);
    expect((await rows())[0].dedupe_key).toBe(`streak_project:${app.id}:start`);
    // It succeeds after that email was queued.
    const good = await scan(app.id, deployment.id, {
      status: 'succeeded',
      failure_cause: null,
      finished_at: new Date(Date.now() + 1000).toISOString(),
    });
    for (let i = 0; i < 3; i++) {
      await scan(app.id, deployment.id);
    }
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(1);
    expect((await rows()).map((row) => row.dedupe_key)).toContain(
      `streak_project:${app.id}:${good}`,
    );

    const platform = await project();
    for (let i = 0; i < 3; i++) {
      await scan(platform.project.id, platform.deployment.id, {
        status: 'failed',
        status_reason: 'infrastructure',
        failure_cause: 'installation',
      });
    }
    const stale = await project();
    const old = new Date(Date.now() - 3 * DAY).toISOString();
    for (let i = 0; i < 3; i++) {
      await scan(stale.project.id, stale.deployment.id, { created_at: old, finished_at: old });
    }
    const before = (await rows()).length;
    await queueSecurityStreakNotifications(env.db, Date.now());
    const added = (await rows()).slice(before);
    expect(added.every((row) => row.kind !== 'streak_project')).toBe(true);
  });

  it('sends one email per streak even when its key moves (window, retention)', async () => {
    await savePolicy();
    const { project: app, deployment } = await project();
    const good = await scan(app.id, deployment.id, { status: 'succeeded', failure_cause: null });
    for (let i = 0; i < 3; i++) {
      await scan(app.id, deployment.id);
    }
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(1);
    // Past the window the streak loses its `since` scan: the key would become `start`.
    for (let i = 0; i < SECURITY_STREAK_WINDOW; i++) {
      await scan(app.id, deployment.id);
    }
    const [longer] = await listSecurityProjectStreaks(env.db, {
      now: Date.now(),
      projectId: app.id,
    });
    expect(longer?.sinceScanId).toBeNull();
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(0);
    // Retention deleting the scan before the streak moves it the same way.
    await env.db.delete(securityScans).where(eq(securityScans.id, good));
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(0);
    expect((await rows()).filter((row) => row.kind === 'streak_project')).toHaveLength(1);
  });

  it('neither counts nor breaks a streak on a skipped scan, like the panel flag', async () => {
    await savePolicy();
    const { project: app, deployment } = await project();
    await scan(app.id, deployment.id);
    await scan(app.id, deployment.id);
    await scan(app.id, deployment.id, {
      status: 'skipped',
      status_reason: 'backlog',
      failure_cause: null,
    });
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(0);
    await scan(app.id, deployment.id);
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(1);
    const [streak] = await listSecurityProjectStreaks(env.db, {
      now: Date.now(),
      projectId: app.id,
    });
    expect(streak?.failures).toBe(3);
  });

  it('skips the email when a scan succeeded before it went out', async () => {
    await savePolicy();
    await person('root', 'admin');
    const { project: app, deployment } = await project();
    for (let i = 0; i < 3; i++) {
      await scan(app.id, deployment.id);
    }
    await queueSecurityStreakNotifications(env.db, Date.now());
    await scan(app.id, deployment.id, { status: 'succeeded', failure_cause: null });
    const { mail, sent } = outbox();
    expect(await runSecurityNotifications(env.db, mail)).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
  });
});

describe('installation failure email', () => {
  it('mails installation admins once a day when over 20% fail for a platform reason', async () => {
    await savePolicy();
    await person('root', 'admin');
    const { project: app, deployment } = await project();
    for (let i = 0; i < 5; i++) {
      await scan(app.id, deployment.id, { status: 'succeeded', failure_cause: null });
    }
    await scan(app.id, deployment.id, {
      status: 'failed',
      status_reason: 'credits',
      failure_cause: 'installation',
    });
    await scan(app.id, deployment.id, {
      status: 'failed',
      status_reason: 'infrastructure',
      failure_cause: 'installation',
    });
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(0);
    await scan(app.id, deployment.id, {
      status: 'skipped',
      status_reason: 'backlog',
      failure_cause: null,
    });
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(1);
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(0);

    const { mail, sent } = outbox();
    await runSecurityNotifications(env.db, mail);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('root@example.com');
    expect(sent[0].subject).toBe(
      '[Void Platform] Platform: 3 of 8 security scans failed in the last 24 hours',
    );
    expect(sent[0].text).toContain('no AI credits left');
    expect(sent[0].text).toContain('waited over 24 hours in the queue');
  });
});

describe('weekly digest', () => {
  it('is queued only with the digest on, once a week, and counts the week', async () => {
    const now = Date.now();
    const week = securityDigestWeek(now);
    expect(await queueSecurityDigest(env.db, await savePolicy(), now)).toBe(0);
    expect(
      await queueSecurityDigest(env.db, await savePolicy({ digest: true, mode: 'disabled' }), now),
    ).toBe(0);
    const policy = await savePolicy({ digest: true });
    expect(await queueSecurityDigest(env.db, policy, now)).toBe(1);
    expect(await queueSecurityDigest(env.db, policy, now)).toBe(0);

    await person('root', 'admin');
    const { project: app, deployment } = await project();
    const inWeek = new Date(week.fromMs + DAY).toISOString();
    await scan(app.id, deployment.id, {
      status: 'succeeded',
      failure_cause: null,
      created_at: inWeek,
      finished_at: inWeek,
    });
    await scan(app.id, deployment.id, { created_at: inWeek, finished_at: inWeek });
    await env.db.insert(securityFindings).values({
      id: 'sf_1',
      project_id: app.id,
      number: 1,
      fingerprint_key: 'fp-1',
      verdict: 'confirmed',
      severity: 'high',
      title: 'SQL injection in /users',
      category: 'injection',
      first_scan_id: 'ss_x',
      last_seen_scan_id: 'ss_x',
      created_at: inWeek,
    } as typeof securityFindings.$inferInsert);

    const { mail, sent } = outbox();
    await runSecurityNotifications(env.db, mail);
    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message.subject).toContain('[Void Platform] Platform: weekly security summary (');
    expect(message.text).toContain('2 ended: 1 succeeded, 1 failed (project)');
    expect(message.text).toContain('1: 0 critical, 1 high');
    expect(message.text).toContain('1 in 1 project');
    // Counts only: no finding title in the digest.
    expect(message.text).not.toContain('SQL injection');
  });

  it('sends nothing for an empty week', async () => {
    await person('root', 'admin');
    const policy = await savePolicy({ digest: true });
    await queueSecurityDigest(env.db, policy, Date.now());
    const { mail, sent } = outbox();
    expect(await runSecurityNotifications(env.db, mail)).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
  });
});

describe('webhook', () => {
  function receiver(status = 200) {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response(null, { status });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  }

  async function webhookOn() {
    const { secret } = await setSecurityWebhook(keyring, env.db, {
      url: 'https://hooks.example.com/void',
      userId: 'usr_admin',
      now: Date.now(),
    });
    return secret!;
  }

  it('posts a signed copy of each event with ids and counts only, even with email off', async () => {
    await savePolicy();
    const secret = await webhookOn();
    expect(secret).toMatch(/^vwhsec_[0-9a-f]{64}$/);
    // The secret is stored encrypted, never as given.
    expect(
      JSON.stringify(await getPlatformSetting(env.db, SECURITY_WEBHOOK_SETTINGS_KEY)),
    ).not.toContain(secret);

    const { project: app, deployment } = await project('acme-web');
    await scan(app.id, deployment.id, { id: 'scan_1', status: 'succeeded', failure_cause: null });
    await env.db.insert(securityFindings).values({
      id: 'sf_1',
      project_id: app.id,
      number: 7,
      fingerprint_key: 'fp-1',
      verdict: 'confirmed',
      severity: 'critical',
      title: 'Secret in /admin',
      category: 'secrets',
      file: 'src/admin.ts',
      first_scan_id: 'scan_1',
      last_seen_scan_id: 'scan_1',
    } as typeof securityFindings.$inferInsert);
    const { securityFindingEvents } = await import('../../src/security/schema.ts');
    await env.db.insert(securityFindingEvents).values({
      id: 'sfe_1',
      finding_id: 'sf_1',
      project_id: app.id,
      scan_id: 'scan_1',
      actor_kind: 'scanner',
      action: 'created',
    } as typeof securityFindingEvents.$inferInsert);
    await enqueueSecurityNotification(env.db, {
      kind: 'findings',
      projectId: app.id,
      scanId: 'scan_1',
    });
    expect((await rows()).map((row) => row.kind).sort()).toEqual(['findings', 'webhook']);

    const hook = receiver();
    const { mail, sent } = outbox({ email: false });
    const now = Date.now();
    await runSecurityNotifications(env.db, mail, now, { fetch: hook.fetch });
    expect(sent).toHaveLength(0);
    expect(hook.calls).toHaveLength(1);
    const call = hook.calls[0];
    expect(call.url).toBe('https://hooks.example.com/void');
    expect(call.headers.get('X-Void-Event')).toBe('security.findings');
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({
      type: 'security.findings',
      installation: 'installation-test',
      project: { id: app.id, slug: 'acme-web' },
      data: {
        scanIds: ['scan_1'],
        newFindings: 1,
        urgent: 1,
        bySeverity: { critical: 1 },
        findingIds: ['F-7'],
      },
    });
    expect(call.body).not.toContain('Secret in /admin');
    expect(call.body).not.toContain('src/admin.ts');
    expect(call.headers.get('X-Void-Delivery')).toBe(body.id);
    // Signed with the clock at send time.
    const signature = call.headers.get('X-Void-Signature') ?? '';
    const sentAt = Number(signature.slice(2, signature.indexOf(',')));
    expect(sentAt).toBeGreaterThanOrEqual(Math.floor(now / 1000));
    expect(sentAt).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
    expect(signature).toBe(await securityWebhookSignature(secret, sentAt, call.body));
    const states = await rows();
    expect(states.find((row) => row.kind === 'findings')?.status).toBe('skipped');
    expect(states.find((row) => row.kind === 'webhook')?.status).toBe('sent');
  });

  it('posts the streak and digest events too', async () => {
    await savePolicy({ digest: true });
    await webhookOn();
    const { project: app, deployment } = await project('acme-api');
    const good = await scan(app.id, deployment.id, { status: 'succeeded', failure_cause: null });
    const failed: Array<string> = [];
    for (let i = 0; i < 3; i++) {
      failed.unshift(await scan(app.id, deployment.id));
    }
    // Platform failures for the installation flag, on another project.
    const other = await project();
    for (let i = 0; i < 3; i++) {
      await scan(other.project.id, other.deployment.id, {
        status: 'failed',
        status_reason: 'credits',
        failure_cause: 'installation',
      });
    }
    expect(await queueSecurityStreakNotifications(env.db, Date.now())).toBe(2);
    // A digest week with a scan in it.
    const week = securityDigestWeek(Date.now());
    const inWeek = new Date(week.fromMs + DAY).toISOString();
    await scan(other.project.id, other.deployment.id, {
      status: 'succeeded',
      failure_cause: null,
      created_at: inWeek,
      finished_at: inWeek,
    });
    expect(await queueSecurityDigest(env.db, await savePolicy({ digest: true }), Date.now())).toBe(
      1,
    );

    const hook = receiver();
    const { mail } = outbox({ email: false });
    await runSecurityNotifications(env.db, mail, Date.now(), { fetch: hook.fetch });
    const bodies = new Map(
      hook.calls.map((call) => {
        const body = JSON.parse(call.body) as { type: string; data: Record<string, unknown> };
        return [body.type, body] as const;
      }),
    );
    expect(bodies.get('security.streak_project')).toMatchObject({
      project: { id: app.id, slug: 'acme-api' },
      data: { failures: 3, scanIds: failed, sinceScanId: good },
    });
    expect(bodies.get('security.streak_installation')?.data).toMatchObject({
      failed: 3,
      byReason: { credits: 3 },
    });
    expect(bodies.get('security.digest')?.data).toMatchObject({ week: week.week });
    const webhooks = (await rows()).filter((row) => row.kind === 'webhook');
    expect(webhooks.map((row) => row.status)).toEqual(['sent', 'sent', 'sent']);
  });

  it('holds the other webhook rows of a pass after one fails', async () => {
    await savePolicy();
    await webhookOn();
    for (const percent of [80, 100] as const) {
      await enqueueSecurityNotification(env.db, {
        kind: 'cap_platform',
        month: '2026-11-01',
        percent,
      });
    }
    const down = receiver(500);
    const { mail } = outbox();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = Date.now();
    await runSecurityNotifications(env.db, mail, now, { fetch: down.fetch });
    // One POST, not one per row.
    expect(down.calls).toHaveLength(1);
    const webhooks = (await rows()).filter((row) => row.kind === 'webhook');
    expect(webhooks.map((row) => row.status)).toEqual(['pending', 'pending']);
    expect(webhooks.map((row) => row.attempts).sort((a, b) => a - b)).toEqual([0, 1]);
    // Both wait for the backoff: a second pass at once posts nothing.
    await runSecurityNotifications(env.db, mail, now, { fetch: down.fetch });
    expect(down.calls).toHaveLength(1);
  });

  it('retries a failed delivery, and drops it once the webhook is turned off', async () => {
    await savePolicy();
    await webhookOn();
    await enqueueSecurityNotification(env.db, { kind: 'digest', week: '2026-11-09' });
    const down = receiver(500);
    const { mail } = outbox({ email: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runSecurityNotifications(env.db, mail, Date.now(), { fetch: down.fetch });
    // An empty digest week is nothing to tell either way; use a cap event instead.
    await env.db.delete(securityNotifications);
    await enqueueSecurityNotification(env.db, {
      kind: 'cap_platform',
      month: '2026-11-01',
      percent: 80,
    });
    await runSecurityNotifications(env.db, mail, Date.now(), { fetch: down.fetch });
    expect(down.calls).toHaveLength(1);
    const [retrying] = (await rows()).filter((row) => row.kind === 'webhook');
    expect(retrying).toMatchObject({ status: 'pending', attempts: 1 });
    expect(JSON.parse(down.calls[0].body).data).toEqual({ month: '2026-11-01', percent: 80 });

    await setSecurityWebhook(keyring, env.db, { url: null, userId: 'usr_admin', now: Date.now() });
    const up = receiver();
    await runSecurityNotifications(env.db, mail, Date.now() + 10 * 60_000, { fetch: up.fetch });
    expect(up.calls).toHaveLength(0);
    expect((await rows()).find((row) => row.kind === 'webhook')?.status).toBe('skipped');
    // With no webhook set, an event queues no webhook row.
    await enqueueSecurityNotification(env.db, {
      kind: 'cap_platform',
      month: '2026-11-01',
      percent: 100,
    });
    expect((await rows()).filter((row) => row.kind === 'webhook')).toHaveLength(1);
  });

  it('is set through the operator route: preview, secret once, audited by host', async () => {
    await savePolicy();
    const admin = await createTestUser(env.db, 'hook-admin', 'github', undefined, 'free', 'admin');
    const token = await createOperatorToken(env.db, admin);
    const bindings = {
      ...env,
      PLATFORM_CAPABILITIES: JSON.stringify({
        ...getPlatformCapabilities(env),
        securityAudits: true,
      }),
    } as unknown as TestEnv;
    const post = (body: Record<string, unknown>) =>
      app.fetch(
        new Request('http://localhost/operator/v1/security/webhook', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        bindings,
      );
    const preview = await post({ url: 'https://hooks.example.com/void?token=abc', dryRun: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'security.webhook',
      webhook: null,
      preview: expect.arrayContaining([
        expect.stringContaining(
          'Turn on: send security events to https://hooks.example.com/void?token=abc',
        ),
      ]),
    });
    expect(await getPlatformSetting(env.db, SECURITY_WEBHOOK_SETTINGS_KEY)).toBeNull();

    const saved = await post({ url: 'https://hooks.example.com/void?token=abc' });
    expect(saved.status).toBe(200);
    const result = await saved.json<{ secret: string; webhook: { url: string } }>();
    expect(result.secret).toMatch(/^vwhsec_/);
    expect(result.webhook.url).toBe('https://hooks.example.com/void?token=abc');

    const status = await app.fetch(
      new Request('http://localhost/operator/v1/security/status', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      bindings,
    );
    const text = await status.text();
    expect(JSON.parse(text).webhook).toMatchObject({
      url: 'https://hooks.example.com/void?token=abc',
    });
    expect(text).not.toContain(result.secret);

    expect((await post({ url: 'http://hooks.example.com/' })).status).toBe(400);
    const events = await env.db.select().from(operatorEvents);
    const audited = events.filter((event) => JSON.stringify(event).includes('webhook'));
    expect(audited.length).toBeGreaterThan(0);
    expect(JSON.stringify(audited)).not.toContain('token=abc');
    expect(JSON.stringify(audited)).toContain('hooks.example.com');
  });
});
