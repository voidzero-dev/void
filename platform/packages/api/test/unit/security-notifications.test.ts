import { describe, expect, it } from 'vite-plus/test';
import { securityDigestWeek } from '../../src/security/digest.ts';
import {
  composeSecurityDigestEmail,
  composeSecurityInstallationStreakEmail,
  composeSecurityProjectStreakEmail,
  composeSecurityPublicHeldEmail,
  cutSecurityEmailText,
  formatSecurityStamp,
  securityActorRoleLabel,
  securityEmailFooter,
} from '../../src/security/notification-copy.ts';
import {
  SECURITY_NOTIFICATION_BACKOFF_MS,
  SECURITY_NOTIFICATION_MAX_ATTEMPTS,
  securityNotificationDedupeKey,
  securityStreakOutcome,
} from '../../src/security/notifications.ts';
import { securityInstallationFailing, securityUtcDay } from '../../src/security/streaks.ts';
import { securityWebhookSignature } from '../../src/security/webhook.ts';

describe('dedupe keys (spec §12 cooldown row)', () => {
  it('keys a findings email by project and scan', () => {
    expect(securityNotificationDedupeKey({ kind: 'findings', projectId: 'p1', scanId: 's1' })).toBe(
      'findings:p1:s1',
    );
  });

  it('keys a cap email by scope, project, month and threshold', () => {
    const project = (percent: 80 | 100) =>
      securityNotificationDedupeKey({
        kind: 'cap_project',
        projectId: 'p1',
        month: '2026-11-01',
        percent,
      });
    expect(project(80)).not.toBe(project(100));
    expect(
      securityNotificationDedupeKey({ kind: 'cap_platform', month: '2026-11-01', percent: 80 }),
    ).toBe('cap_platform:2026-11-01:80');
  });

  it('keys a held email by request, state and gate scan', () => {
    const held = (state: 'held_findings' | 'needs_deploy', gateScanId: string | null) =>
      securityNotificationDedupeKey({
        kind: 'public_held',
        projectId: 'p1',
        requestId: 'r1',
        state,
        gateScanId,
      });
    expect(held('held_findings', 's1')).toBe('public_held:r1:held_findings:s1');
    expect(held('held_findings', 's1')).not.toBe(held('held_findings', 's2'));
    expect(held('needs_deploy', null)).toBe('public_held:r1:needs_deploy:-');
  });

  it('keys one bypass email per bypass and one reopen per reopen', () => {
    expect(
      securityNotificationDedupeKey({
        kind: 'scan_bypass',
        projectId: 'p1',
        requestId: 'r1',
        bypassId: 'b1',
      }),
    ).toBe('scan_bypass:b1');
    expect(
      securityNotificationDedupeKey({
        kind: 'reopen',
        projectId: 'p1',
        findingId: 'f1',
        reopenCount: 2,
      }),
    ).not.toBe(
      securityNotificationDedupeKey({
        kind: 'reopen',
        projectId: 'p1',
        findingId: 'f1',
        reopenCount: 3,
      }),
    );
  });
});

describe('retry', () => {
  it('tries three times with a longer wait before the third', () => {
    expect(SECURITY_NOTIFICATION_MAX_ATTEMPTS).toBe(3);
    expect(SECURITY_NOTIFICATION_BACKOFF_MS).toEqual([60_000, 300_000]);
  });
});

describe('copy helpers', () => {
  it('cuts by characters and keeps text on one line', () => {
    expect(cutSecurityEmailText('a\nb\tc', 10)).toBe('a b c');
    expect(cutSecurityEmailText('x'.repeat(130), 120)).toHaveLength(120);
    expect(cutSecurityEmailText('x'.repeat(130), 120).endsWith('…')).toBe(true);
    // Control characters never reach a header or a terminal.
    expect(cutSecurityEmailText('a\u0000b\u001b[31mc', 20)).toBe('ab[31mc');
    // An emoji is one character, not two UTF-16 units.
    expect(cutSecurityEmailText('😀'.repeat(5), 5)).toBe('😀'.repeat(5));
  });

  it('formats a stamp in UTC', () => {
    expect(formatSecurityStamp(Date.parse('2026-11-10T14:02:00Z'))).toBe('Nov 10, 14:02 UTC');
  });

  it('names a role, never a person', () => {
    expect(securityActorRoleLabel('admin')).toBe('a project admin');
    expect(securityActorRoleLabel('owner')).toBe('the project owner');
    expect(securityActorRoleLabel('installation_admin')).toBe('a platform admin');
    expect(securityActorRoleLabel(null)).toBe('a project member');
  });

  it('writes one footer per reason', () => {
    expect(securityEmailFooter({ kind: 'owner_admin' }, 'acme', 'Void')).toContain(
      'owner or admin of acme',
    );
    expect(
      securityEmailFooter({ kind: 'author', deploymentIds: ['dpl_a', 'dpl_b'] }, 'acme', 'Void'),
    ).toBe('You get this because you deployed dpl_a, dpl_b to acme.');
    expect(securityEmailFooter({ kind: 'installation_admin' }, null, 'Void')).toContain(
      'administrator of Void',
    );
  });

  it('never puts a bypass line in a held-urgent email (invariant)', () => {
    const content = composeSecurityPublicHeldEmail(
      {
        platform: 'Void',
        slug: 'acme',
        state: 'held_findings',
        noResultReason: null,
        requestedBy: 'a project admin',
        requestedAt: 0,
        scanned: null,
        blockers: [],
        blockerCount: 1,
      },
      { kind: 'owner_admin' },
    );
    const all = [
      content.subject,
      content.intro,
      ...content.details,
      ...content.notes,
      ...content.actions,
    ].join('\n');
    expect(all.toLowerCase()).not.toContain('bypass');
  });
});

describe('Phase 2 alerts (M26)', () => {
  it('keys one email per streak, per day and per week', () => {
    expect(
      securityNotificationDedupeKey({ kind: 'streak_project', projectId: 'p1', sinceScanId: 's9' }),
    ).toBe('streak_project:p1:s9');
    expect(
      securityNotificationDedupeKey({ kind: 'streak_project', projectId: 'p1', sinceScanId: null }),
    ).toBe('streak_project:p1:start');
    expect(securityNotificationDedupeKey({ kind: 'streak_installation', day: '2026-11-20' })).toBe(
      'streak_installation:2026-11-20',
    );
    expect(securityNotificationDedupeKey({ kind: 'digest', week: '2026-11-09' })).toBe(
      'digest:2026-11-09',
    );
  });

  it('covers the last full UTC week, Monday to Monday', () => {
    const wednesday = Date.parse('2026-11-18T15:00:00Z');
    expect(securityDigestWeek(wednesday)).toEqual({
      week: '2026-11-09',
      fromMs: Date.parse('2026-11-09T00:00:00Z'),
      toMs: Date.parse('2026-11-16T00:00:00Z'),
    });
    // Monday 00:00 is already the next week; Sunday night is not.
    expect(securityDigestWeek(Date.parse('2026-11-16T00:00:00Z')).week).toBe('2026-11-09');
    expect(securityDigestWeek(Date.parse('2026-11-15T23:59:59Z')).week).toBe('2026-11-02');
  });

  it('flags the installation only with 3+ platform failures over 20% of ended scans', () => {
    expect(securityInstallationFailing({ ended: 10, failed: 3, byReason: {} })).toBe(true);
    expect(securityInstallationFailing({ ended: 15, failed: 3, byReason: {} })).toBe(false);
    expect(securityInstallationFailing({ ended: 2, failed: 2, byReason: {} })).toBe(false);
    expect(securityUtcDay(Date.parse('2026-11-20T23:30:00Z'))).toBe('2026-11-20');
  });

  it('names why each scan of a streak gave no result', () => {
    const scan = { statusReason: null, errorClass: null, model: 'anthropic/claude-opus-5.5' };
    expect(securityStreakOutcome({ ...scan, status: 'refused' })).toBe(
      'refused by anthropic/claude-opus-5.5',
    );
    expect(securityStreakOutcome({ ...scan, status: 'timed_out' })).toBe('timed out');
    expect(
      securityStreakOutcome({
        ...scan,
        status: 'failed',
        statusReason: 'bad_output',
        errorClass: 'not_json',
      }),
    ).toBe('bad output (not_json)');
    expect(securityStreakOutcome({ ...scan, status: 'incomplete', statusReason: 'turn_cap' })).toBe(
      'incomplete (turn cap)',
    );
    expect(
      securityStreakOutcome({ ...scan, status: 'failed', statusReason: 'input_missing' }),
    ).toBe('code not stored');
  });

  it('writes the project streak email with the switch line, and the fallback hint only when off', () => {
    const data = {
      platform: 'Void',
      slug: 'acme',
      failures: 7,
      scans: [
        {
          id: 'scan_3',
          deploymentId: 'dpl_3',
          outcome: 'refused by anthropic/claude-opus-5.5',
          at: Date.parse('2026-11-18T10:00:00Z'),
        },
      ],
      refusedModel: 'anthropic/claude-opus-5.5',
      cfModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      fallbackOn: false,
    };
    const off = composeSecurityProjectStreakEmail(data, { kind: 'owner_admin' });
    expect(off.subject).toBe('[Void] acme: 7 security scans in a row did not finish');
    expect(off.details.join('\n')).toContain('scan_3');
    expect(off.details.at(-1)).toBe('  and 6 more');
    const notes = off.notes.join('\n');
    expect(notes).toContain(
      'void project security model @cf/deepseek-ai/deepseek-v4.1-flash-1017 --project acme',
    );
    expect(notes).toContain('void platform security fallback on');
    expect(off.pageSlug).toBe('acme');
    const on = composeSecurityProjectStreakEmail(
      { ...data, fallbackOn: true },
      { kind: 'owner_admin' },
    );
    expect(on.notes.join('\n')).not.toContain('fallback on');
    const timedOut = composeSecurityProjectStreakEmail(
      { ...data, refusedModel: null },
      { kind: 'installation_admin' },
    );
    expect(timedOut.notes.join('\n')).not.toContain('security model');
    expect(timedOut.footer).toContain('administrator of Void');
  });

  it('writes the installation and digest emails with counts only', () => {
    const installation = composeSecurityInstallationStreakEmail(
      { platform: 'Void', ended: 10, failed: 4, byReason: { infrastructure: 1, credits: 3 } },
      { kind: 'installation_admin' },
    );
    expect(installation.subject).toBe(
      '[Void] Platform: 4 of 10 security scans failed in the last 24 hours',
    );
    expect(installation.details).toEqual([
      '  3     no AI credits left',
      '  1     scanner or container error',
    ]);
    expect(installation.notes[0]).toContain('Workers AI credits');
    expect(installation.pageSlug).toBeNull();

    const digest = composeSecurityDigestEmail(
      {
        platform: 'Void',
        weekLabel: 'Nov 9 – Nov 15',
        scans: {
          ended: 12,
          succeeded: 9,
          projectFailures: 2,
          installationFailures: 1,
          budgetSkips: 0,
        },
        newFindings: { critical: 1, high: 0, medium: 2, low: 0, leads: 1 },
        resolvedFindings: 3,
        openUrgentFindings: 1,
        projectsWithUrgentFindings: 1,
        projectsWithFailureStreaks: 0,
        openPublicRequests: 0,
        bypasses: 0,
      },
      { kind: 'installation_admin' },
    );
    expect(digest.subject).toBe('[Void] Platform: weekly security summary (Nov 9 – Nov 15)');
    expect(digest.details.join('\n')).toContain('3: 1 critical, 0 high, 2 medium, 0 low; 1 lead');
  });
});

describe('webhook signature (M26)', () => {
  it('is HMAC-SHA256 of "<t>.<body>" with the secret, as hex', async () => {
    const signature = await securityWebhookSignature('vwhsec_test', 1_700_000_000, '{"a":1}');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('vwhsec_test'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode('1700000000.{"a":1}'),
    );
    const hex = Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
    expect(signature).toBe(`t=1700000000,v1=${hex}`);
    expect(await securityWebhookSignature('other', 1_700_000_000, '{"a":1}')).not.toBe(signature);
  });
});
