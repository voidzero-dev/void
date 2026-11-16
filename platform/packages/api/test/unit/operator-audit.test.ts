import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../src/operator/audit.ts';

describe('operator audit intent normalization', () => {
  it('allowlists canonical actions and action-specific target fields', () => {
    const cases: Array<{
      action: string;
      body?: Record<string, unknown>;
      target: Record<string, unknown>;
    }> = [
      {
        action: 'config/plans/team/set',
        body: {
          name: 'Team',
          expectedRevision: 7,
          allowShortSlugs: true,
          limits: { requestsPerMonth: 42, d1StorageBytes: 100, credential: 'secret' },
          secret: 'hidden',
        },
        target: {
          planId: 'team',
          action: 'set',
          name: 'Team',
          expectedRevision: 7,
          allowShortSlugs: true,
          limits: { requestsPerMonth: 42 },
        },
      },
      {
        action: 'config/plans/pro/set',
        body: { aiLogging: 'metadata', expectedRevision: 8 },
        target: { planId: 'pro', action: 'set', expectedRevision: 8, aiLogging: 'metadata' },
      },
      {
        action: 'config/plans/pro/set',
        body: { aiLogging: 'everything', expectedRevision: 8 },
        target: { planId: 'pro', action: 'set', expectedRevision: 8 },
      },
      {
        action: 'projects/proj_1/ai-logging',
        body: { mode: 'off' },
        target: { projectId: 'proj_1', mode: 'off' },
      },
      {
        action: 'config/plans/add',
        body: { id: 'team', name: 'Team', copyFrom: 'free', expectedRevision: 7 },
        target: {
          planId: 'team',
          action: 'add',
          name: 'Team',
          copyFrom: 'free',
          expectedRevision: 7,
        },
      },
      {
        action: 'users/usr_1/plan',
        body: { plan: 'pro', credential: 'secret' },
        target: { userId: 'usr_1', plan: 'pro' },
      },
      {
        action: 'users/usr_1/suspend',
        body: { reason: 'review' },
        target: { userId: 'usr_1', reason: 'review' },
      },
      { action: 'users/usr_1/restore', target: { userId: 'usr_1' } },
      { action: 'users/usr_1/delete', target: { userId: 'usr_1' } },
      { action: 'projects/proj_1/delete', target: { projectId: 'proj_1' } },
      { action: 'deployments/dpl_1/cancel', target: { deploymentId: 'dpl_1' } },
      {
        action: 'invitations/send',
        body: { emails: ['ADMIN@EXAMPLE.COM'] },
        target: { emails: ['admin@example.com'] },
      },
      { action: 'invitations/inv_1/revoke', target: { invitationId: 'inv_1' } },
      { action: 'signup/restrict', target: { restrictionsEnabled: true } },
      { action: 'signup/open', target: { restrictionsEnabled: false } },
      {
        action: 'signup/allow',
        body: { type: 'email', patterns: ['ONE@EXAMPLE.COM'], note: 'cohort' },
        target: { type: 'email', patterns: ['one@example.com'], note: 'cohort' },
      },
      {
        action: 'signup/remove',
        body: { type: 'email', pattern: 'ONE@EXAMPLE.COM' },
        target: { type: 'email', pattern: 'one@example.com' },
      },
      {
        action: 'signup/disallow',
        body: { type: 'identity', connectionId: 'company', subject: 'Employee-42' },
        target: { type: 'identity', connectionId: 'company', subject: 'Employee-42' },
      },
      { action: 'system/backfill-queue-tokens', target: { entries: 'queue:*' } },
      {
        action: 'system/sandbox-drain',
        target: { applications: 'managed-sandbox-containers' },
      },
      { action: 'system/rotate-proxy-tokens', target: { projects: 'all' } },
      {
        action: 'system/rotate-proxy-tokens',
        body: { all: true },
        target: { projects: 'all' },
      },
      {
        action: 'system/rotate-proxy-tokens',
        body: { project: 'proj_000000000001', credential: 'secret' },
        target: { projects: 'proj_000000000001' },
      },
      {
        action: 'workers/api/rollback',
        body: { environment: 'staging', versionId: 'ver_1' },
        target: { workerName: 'api', environment: 'staging', versionId: 'ver_1' },
      },
      {
        action: 'workers/rollback-all',
        body: {
          environment: 'production',
          versions: { dispatch: 'v1', dashboard: 'v2', ignored: 'secret' },
        },
        target: { environment: 'production', versions: { dispatch: 'v1', dashboard: 'v2' } },
      },
    ];

    for (const testCase of cases) {
      const intent = operatorAuditIntent(testCase.action, testCase.body);
      expect(intent.action).toBe(testCase.action);
      expect(JSON.parse(intent.target)).toEqual(testCase.target);
      expect(intent.target).not.toContain('credential');
      expect(intent.target).not.toContain('secret');
    }
    expect(() => operatorAuditIntent('unknown/mutation', { credential: 'secret' })).toThrow(
      'Unknown audited operator mutation',
    );
  });
});

function auditContext(db: unknown): Context<ApiEnv> {
  return {
    get(name: string) {
      if (name === 'db') {
        return db;
      }
      if (name === 'user') {
        return { id: 'usr_admin', login: 'admin' };
      }
      return undefined;
    },
    header: vi.fn(),
  } as unknown as Context<ApiEnv>;
}

describe('browser audited mutation execution', () => {
  it('fails closed when the durable intent cannot be inserted', async () => {
    const mutation = vi.fn();
    const context = auditContext({
      insert: () => ({ values: vi.fn().mockRejectedValue(new Error('database unavailable')) }),
    });

    await expect(
      executeAuditedMutation(context, operatorAuditIntent('signup/restrict'), mutation),
    ).rejects.toThrow('database unavailable');
    expect(mutation).not.toHaveBeenCalled();
  });

  it('preserves a successful redirect and marks a failed completion as pending', async () => {
    const context = auditContext({
      insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
      update: () => ({
        set: () => ({ where: vi.fn().mockRejectedValue(new Error('completion unavailable')) }),
      }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = Response.redirect('https://example.com/admin/users', 302);

    const result = await executeAuditedMutation(
      context,
      operatorAuditIntent('signup/restrict'),
      async () => ({ response, succeeded: true }),
    );

    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe('https://example.com/admin/users');
    expect(result.headers.get('X-Void-Audit-Id')).toBeTruthy();
    expect(result.headers.get('X-Void-Audit-Status')).toBe('pending');
    expect(error).toHaveBeenCalledWith(
      '[operator] audit completion failed',
      expect.any(String),
      expect.any(Error),
    );
  });
});
