import { and, eq } from 'drizzle-orm';
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
import {
  securityFindings,
  securityNotifications,
  securityPublicRequests,
  securityScanBypasses,
} from '../../src/schema.ts';
import { projectZeroTrust } from '../../src/schema.ts';
import { SecurityApiError } from '../../src/security/errors.ts';
import { bypassPublicRequest, recheckPublicRequest } from '../../src/security/public-gate-flow.ts';
import { ZeroTrustUnavailableError } from '../../src/zero-trust/errors.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  askPublic,
  gateOwner,
  setupGate,
  succeededScan,
  urgentFinding,
  ztRow,
} from './security-gate-fixtures.ts';
import type { GateSetup } from './security-gate-fixtures.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bypass(s: GateSetup, reason = 'launch day') {
  return bypassPublicRequest(s.platform, env.db, {
    projectId: s.project.id,
    reason,
    actor: gateOwner(s),
  });
}

async function bypassRows(s: GateSetup) {
  return env.db
    .select()
    .from(securityScanBypasses)
    .where(eq(securityScanBypasses.project_id, s.project.id));
}

async function bypassEmails() {
  return env.db
    .select()
    .from(securityNotifications)
    .where(eq(securityNotifications.kind, 'scan_bypass'));
}

async function requestRows(s: GateSetup) {
  return env.db
    .select()
    .from(securityPublicRequests)
    .where(eq(securityPublicRequests.project_id, s.project.id));
}

describe('public gate bypass races', () => {
  it('two bypasses at once leave one record and one email (#72)', async () => {
    const s = await setupGate(env);
    await askPublic(s);

    const results = await Promise.allSettled([bypass(s, 'first'), bypass(s, 'second')]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(SecurityApiError);
    expect(lost[0].reason).toMatchObject({
      status: 409,
      code: expect.stringMatching(/^(public request closed|no public request)$/),
    });
    expect(await bypassRows(s)).toHaveLength(1);
    expect(await bypassEmails()).toHaveLength(1);
    expect((await requestRows(s)).map((row) => row.state)).toEqual(['bypassed']);
    expect((await ztRow(s)).desired_protected).toBe(false);
  });

  it('a second bypass after the first names the closed state (#72)', async () => {
    const s = await setupGate(env);
    await askPublic(s);
    await bypass(s);
    // The caller still holds the request it saw: the check runs under the lock and
    // reads the request by id, so a stale caller learns the final state.
    await expect(bypass(s, 'again')).rejects.toMatchObject({ status: 409 });
    expect(await bypassRows(s)).toHaveLength(1);
    expect(await bypassEmails()).toHaveLength(1);
  });

  it('a bypass racing a protect ends with one consistent outcome (#72)', async () => {
    const s = await setupGate(env);
    await askPublic(s);

    const [bypassed, protectedAgain] = await Promise.allSettled([bypass(s), askPublic(s, true)]);

    expect(protectedAgain.status).toBe('fulfilled');
    const [request] = await requestRows(s);
    const records = await bypassRows(s);
    if (bypassed.status === 'fulfilled') {
      // Bypass first: the request closed as bypassed, then protect ran on a closed request.
      expect(request.state).toBe('bypassed');
      expect(records).toHaveLength(1);
      expect(await bypassEmails()).toHaveLength(1);
    } else {
      // Cancel first: the bypass found the request closed and recorded nothing.
      expect(request.state).toBe('canceled');
      expect(bypassed.reason).toMatchObject({
        status: 409,
        code: expect.stringMatching(/^(public request closed|no public request)$/),
      });
      expect(records).toHaveLength(0);
      expect(await bypassEmails()).toHaveLength(0);
      expect((await ztRow(s)).desired_protected).toBe(true);
    }
  });

  it('a bypass racing a passing scan lets one of them close the request (#72)', async () => {
    const s = await setupGate(env);
    await askPublic(s);
    await succeededScan(s);

    const [rechecked, bypassed] = await Promise.allSettled([
      recheckPublicRequest(s.platform, env.db, s.project.id),
      bypass(s),
    ]);

    expect(rechecked.status).toBe('fulfilled');
    const [request] = await requestRows(s);
    expect(['passed', 'bypassed']).toContain(request.state);
    expect((await ztRow(s)).desired_protected).toBe(false);
    if (request.state === 'passed') {
      expect(bypassed.status).toBe('rejected');
      expect(await bypassRows(s)).toHaveLength(0);
      expect(await bypassEmails()).toHaveLength(0);
    } else {
      expect(bypassed.status).toBe('fulfilled');
      expect(await bypassRows(s)).toHaveLength(1);
    }
  });

  it('refuses a bypass while the installation operation runs or the row is not ready (#89)', async () => {
    const s = await setupGate(env);
    await askPublic(s);
    await env.db
      .update(projectZeroTrust)
      .set({ status: 'reconciling' })
      .where(eq(projectZeroTrust.project_id, s.project.id));

    await expect(bypass(s)).rejects.toBeInstanceOf(ZeroTrustUnavailableError);

    expect(await bypassRows(s)).toHaveLength(0);
    expect(await bypassEmails()).toHaveLength(0);
    const [request] = await requestRows(s);
    expect(request.state).not.toBe('bypassed');
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('refuses a bypass from held findings and allows it once they are resolved (#93)', async () => {
    const s = await setupGate(env);
    await succeededScan(s);
    await urgentFinding(s);
    const asked = await askPublic(s);
    expect(asked.publicRequest?.state).toBe('held_findings');

    await expect(bypass(s)).rejects.toMatchObject({
      status: 409,
      code: 'security public request has urgent findings',
      details: { blockers: { count: 1, ids: ['F-1'] } },
    });
    expect(await bypassRows(s)).toHaveLength(0);
    expect(await bypassEmails()).toHaveLength(0);
    expect((await requestRows(s))[0].state).toBe('held_findings');

    await env.db
      .update(securityFindings)
      .set({
        state: 'resolved',
        resolution: 'false_positive',
        resolved_at: new Date().toISOString(),
      })
      .where(eq(securityFindings.project_id, s.project.id));
    // The scan passes by itself once the finding is closed; a held request that is
    // judged again is no longer held by findings.
    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(rechecked?.state).not.toBe('held_findings');
  });

  it('a bypass after an ingest that found an urgent finding is refused (#94)', async () => {
    const s = await setupGate(env);
    const asked = await askPublic(s);
    expect(asked.publicRequest?.state).toBe('needs_deploy');
    // The ingest committed its finding; its re-check has not run yet.
    await succeededScan(s);
    await urgentFinding(s);

    await expect(bypass(s)).rejects.toMatchObject({
      code: 'security public request has urgent findings',
    });
    expect(await bypassRows(s)).toHaveLength(0);
    expect(await bypassEmails()).toHaveLength(0);

    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);
    expect(rechecked?.state).toBe('held_findings');
    expect((await ztRow(s)).desired_protected).toBe(true);
  });

  it('an ingest after a bypass never protects the project again (#94)', async () => {
    const s = await setupGate(env);
    await askPublic(s);
    await bypass(s);
    expect((await ztRow(s)).desired_protected).toBe(false);

    await succeededScan(s);
    await urgentFinding(s);
    const rechecked = await recheckPublicRequest(s.platform, env.db, s.project.id);

    expect(rechecked).toBeNull();
    expect((await requestRows(s)).map((row) => row.state)).toEqual(['bypassed']);
    expect((await ztRow(s)).desired_protected).toBe(false);
    expect(
      await env.db
        .select()
        .from(securityPublicRequests)
        .where(
          and(
            eq(securityPublicRequests.project_id, s.project.id),
            eq(securityPublicRequests.state, 'held_findings'),
          ),
        ),
    ).toHaveLength(0);
  });
});
