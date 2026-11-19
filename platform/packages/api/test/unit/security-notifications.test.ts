import { describe, expect, it } from 'vite-plus/test';
import {
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
} from '../../src/security/notifications.ts';

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
