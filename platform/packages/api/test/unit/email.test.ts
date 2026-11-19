import { describe, expect, it } from 'vite-plus/test';
import {
  sendErrorAlertEmail,
  sendInvitationEmail,
  sendProjectInvitationEmail,
  sendWelcomeEmail,
  sendDeployFailedEmail,
  sendSecurityBypassEmail,
  sendSecurityFindingsEmail,
  sendSecurityNowPublicEmail,
  sendSecurityPlatformCapEmail,
  sendSecurityProjectCapEmail,
  sendSecurityPublicCanceledEmail,
  sendSecurityPublicHeldEmail,
  sendSecurityReopenEmail,
} from '../../src/email.ts';

type SentMessage = {
  from: string | EmailAddress;
  to: string;
  subject: string;
  html: string;
  text: string;
};

function mockBinding() {
  const sent: Array<SentMessage> = [];
  const binding = {
    send: async (msg: SentMessage) => {
      sent.push(msg);
    },
  } as unknown as SendEmail;
  return { binding: { EMAIL: binding, DASHBOARD_URL: 'https://dash.void.cloud' }, sent };
}

describe('sendErrorAlertEmail', () => {
  const start = Date.parse('2026-07-16T16:30:00Z');
  const end = Date.parse('2026-07-16T17:30:00Z');

  it('stamps the concrete UTC window instead of the word "recently"', async () => {
    const { binding, sent } = mockBinding();
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 1252, { start, end }, end);
    const msg = sent[0];

    expect(msg.subject).toBe('5xx errors detected: recappi');
    expect(msg.html).toContain('2026-07-16 16:30 UTC');
    expect(msg.html).toContain('2026-07-16 17:30 UTC');
    expect(msg.html).not.toContain('recently');
    expect(msg.text).toContain('2026-07-16 16:30 UTC');
    expect(msg.text).not.toContain('recently');
  });

  it('formats the error count with thousands separators', async () => {
    const { binding, sent } = mockBinding();
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 1252, { start, end }, end);
    expect(sent[0].html).toContain('1,252');
    expect(sent[0].text).toContain('1,252');
  });

  it('recommends the request-level command first, then logs, both sized to the window', async () => {
    const { binding, sent } = mockBinding();
    // 1h window, sent at the last error => ceil(1)+1 = 2h suggested range.
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 1252, { start, end }, end);

    // `requests` is the only view that can show edge-generated / static 5xx,
    // which never reach a worker and so never produce log rows.
    expect(sent[0].text).toContain('void project requests --status 5xx --range 2h');
    expect(sent[0].html).toContain('void project requests --status 5xx --range 2h');
    expect(sent[0].text).toContain('void project logs --level error --range 2h');
    expect(sent[0].html).toContain('void project logs --level error --range 2h');
  });

  it('anchors the suggested range at send time, not at the last error', async () => {
    const { binding, sent } = mockBinding();
    // A point burst at 10:00 whose delivery kept failing until 12:01. A range
    // derived from the window alone would be 1h and would exclude the errors.
    const burst = Date.parse('2026-07-23T10:00:00Z');
    const sentAt = Date.parse('2026-07-23T12:01:00Z');
    await sendErrorAlertEmail(
      binding,
      'u@example.com',
      'recappi',
      7,
      { start: burst, end: burst },
      sentAt,
    );

    expect(sent[0].text).toContain('--range 4h');
    expect(sent[0].text).not.toContain('--range 1h');
    // The window itself is still reported honestly.
    expect(sent[0].text).toContain('2026-07-23 10:00 UTC');
  });

  it('caps the suggested range at the CLI 7-day limit for old windows', async () => {
    const { binding, sent } = mockBinding();
    const oldStart = Date.parse('2026-07-01T00:00:00Z');
    const recentEnd = Date.parse('2026-07-16T00:00:00Z'); // 15 days
    await sendErrorAlertEmail(
      binding,
      'u@example.com',
      'recappi',
      40,
      { start: oldStart, end: recentEnd },
      recentEnd,
    );
    expect(sent[0].text).toContain('--range 7d');
  });

  it('falls back to "recently" wording when no window is known', async () => {
    const { binding, sent } = mockBinding();
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 5, null, Date.now());
    const msg = sent[0];
    expect(msg.html).toContain('recently');
    expect(msg.html).toContain('void project requests --status 5xx --range');
    expect(msg.text).toContain('recently');
  });

  it('links to the dashboard project page', async () => {
    const { binding, sent } = mockBinding();
    await sendErrorAlertEmail(binding, 'u@example.com', 'recappi', 1252, { start, end }, end);
    expect(sent[0].html).toContain('https://dash.void.cloud/projects/recappi');
  });
});

describe('platform email identity', () => {
  const identity = {
    AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
    PLATFORM_INSTALLATION_ID: 'test-installation',
    PLATFORM_DISPLAY_NAME: 'Example <Platform>',
    EMAIL_FROM: 'Example Platform <platform@example.com>',
    DASHBOARD_URL: undefined,
  };

  it('sends invitations and welcomes for the configured platform and sender', async () => {
    const { binding, sent } = mockBinding();
    const env = { ...binding, ...identity };
    await sendInvitationEmail(env, 'member@example.com');
    await sendWelcomeEmail(env, 'member@example.com', '<new-member>');
    expect(sent.map(({ subject }) => subject)).toEqual([
      "You're invited to Example <Platform>",
      'Welcome to Example <Platform>',
    ]);
    for (const msg of sent) {
      expect(msg.from).toBe(identity.EMAIL_FROM);
      expect(msg.html).toContain('Example &lt;Platform&gt;');
      expect(msg.html).not.toContain('Example <Platform>');
      expect(msg.text).toContain("void connect 'api.example.com'");
      expect(msg.html + msg.text).not.toContain('void auth login');
      expect(msg.html + msg.text).not.toContain('void deploy');
      expect(msg.html).toContain('https://api.example.com/invite');
      expect(msg.html + msg.text).not.toMatch(
        /void\.cloud|discord|private beta|source|early-access/i,
      );
    }
    expect(sent[1].html).toContain('&lt;new-member&gt;');
  });

  it('directs project invitees to the CLI without claiming a dashboard flow', async () => {
    const { binding, sent } = mockBinding();
    await sendProjectInvitationEmail(
      { ...binding, ...identity },
      {
        to: 'member@example.com',
        invitationId: 'pinv_a1b2c3d4e5f6',
        projectSlug: 'shared-project',
        inviterLogin: 'owner',
        role: 'collaborator',
      },
    );

    expect(sent[0].html + sent[0].text).toContain("void connect 'api.example.com'");
    expect(sent[0].html + sent[0].text).toContain('void project team accept pinv_a1b2c3d4e5f6');
    expect(sent[0].html + sent[0].text).toContain(
      'https://api.example.com/invite?project-invitation=pinv_a1b2c3d4e5f6',
    );
    expect(sent[0].html + sent[0].text).not.toMatch(/dashboard/i);
  });

  it('keeps deployment and error alerts on the selected platform without a dashboard', async () => {
    const { binding, sent } = mockBinding();
    const env = { ...binding, ...identity };
    await sendDeployFailedEmail(env, 'member@example.com', 'my-project', '<build failed>');
    await sendErrorAlertEmail(env, 'member@example.com', 'my-project', 5, null);
    for (const msg of sent) {
      expect(msg.from).toBe(identity.EMAIL_FROM);
      expect(msg.html).toContain('Example &lt;Platform&gt;');
      expect(msg.text).toContain("void connect 'api.example.com'");
      expect(msg.html + msg.text).not.toContain('void.cloud');
      expect(msg.html).not.toContain('View Project');
    }
    expect(sent[0].html).toContain('&lt;build failed&gt;');
  });

  it('uses an explicitly configured dashboard for project links', async () => {
    const { binding, sent } = mockBinding();
    await sendDeployFailedEmail(
      { ...binding, ...identity, DASHBOARD_URL: 'https://dashboard.example.com' },
      'member@example.com',
      'project & name',
      'failed',
    );
    expect(sent[0].html).toContain('https://dashboard.example.com/projects/project%20%26%20name');
    expect(sent[0].html + sent[0].text).not.toContain('void.cloud');
  });

  it.each([
    { ...identity, EMAIL_FROM: undefined },
    { ...identity, AUTH_REDIRECT_URI: undefined },
    { ...identity, AUTH_REDIRECT_URI: 'javascript:alert(1)' },
    { ...identity, AUTH_REDIRECT_URI: 'https://user:pass@api.example.com/auth/callback' },
    { ...identity, EMAIL_FROM: 'user@example.com\r\nBcc: attacker@example.com' },
    { ...identity, DASHBOARD_URL: 'javascript:alert(1)' },
    // A source deployment on a custom API must not inherit the hosted sender either.
    { ...identity, PLATFORM_INSTALLATION_ID: undefined, EMAIL_FROM: undefined },
  ])('rejects unsafe or incomplete email configuration before sending: %j', async (config) => {
    const { binding, sent } = mockBinding();
    await expect(
      sendInvitationEmail({ ...binding, ...config }, 'member@example.com'),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it('uses a generic default name for a custom source deployment without an installation ID', async () => {
    const { binding, sent } = mockBinding();
    await sendInvitationEmail(
      {
        ...binding,
        ...identity,
        PLATFORM_INSTALLATION_ID: undefined,
        PLATFORM_DISPLAY_NAME: undefined,
      },
      'member@example.com',
    );
    expect(sent[0].subject).toBe("You're invited to Void Platform");
    expect(sent[0].html + sent[0].text).not.toContain('Void Cloud');
    expect(sent[0].text).toContain("void connect 'api.example.com'");
  });

  describe('default sender', () => {
    const installation = {
      ...identity,
      EMAIL_FROM: undefined,
      EMAIL_SENDER_DOMAIN: 'mail.example.com',
    };
    const defaultSender = { name: 'Example <Platform>', email: 'noreply@mail.example.com' };

    it('sends every platform mail from noreply on the platform mail domain', async () => {
      const { binding, sent } = mockBinding();
      const env = { ...binding, ...installation };
      await sendInvitationEmail(env, 'member@example.com');
      await sendProjectInvitationEmail(env, {
        to: 'member@example.com',
        invitationId: 'pinv_a1b2c3d4e5f6',
        projectSlug: 'shared-project',
        inviterLogin: 'owner',
        role: 'reader',
      });
      await sendWelcomeEmail(env, 'member@example.com', 'new-member');
      await sendDeployFailedEmail(env, 'member@example.com', 'my-project', 'failed');
      await sendErrorAlertEmail(env, 'member@example.com', 'my-project', 5, null);
      expect(sent.map(({ from }) => from)).toEqual(Array(5).fill(defaultSender));
    });

    it('keeps an explicit EMAIL_FROM and the hosted sender ahead of it', async () => {
      const { binding, sent } = mockBinding();
      await sendInvitationEmail({ ...binding, ...installation }, 'member@example.com');
      await sendInvitationEmail(
        { ...binding, ...installation, EMAIL_FROM: identity.EMAIL_FROM },
        'member@example.com',
      );
      await sendInvitationEmail(
        { ...binding, EMAIL_SENDER_DOMAIN: 'mail.void.cloud' },
        'member@example.com',
      );
      expect(sent.map(({ from }) => from)).toEqual([
        defaultSender,
        identity.EMAIL_FROM,
        'Void <noreply@void.cloud>',
      ]);
    });

    it.each([
      { ...installation, PLATFORM_DISPLAY_NAME: 'Example\r\nBcc: attacker@example.com' },
      { ...installation, EMAIL_SENDER_DOMAIN: 'mail.example.com\r\nBcc: attacker@example.com' },
    ])('rejects control characters in the sender: %j', async (config) => {
      const { binding, sent } = mockBinding();
      await expect(
        sendInvitationEmail({ ...binding, ...config }, 'member@example.com'),
      ).rejects.toThrow('must not contain control characters');
      expect(sent).toEqual([]);
    });
  });

  it('preserves the Void Cloud sender only for its hosted deployment', async () => {
    const { binding, sent } = mockBinding();
    await sendInvitationEmail(binding, 'member@example.com');
    expect(sent[0].from).toBe('Void <noreply@void.cloud>');
    expect(sent[0].subject).toBe("You're invited to Void Cloud");
    expect(sent[0].text).toContain("void connect 'api.void.cloud'");
  });
});

describe('security emails (spec §12)', () => {
  const finding = (
    over: Partial<Parameters<typeof sendSecurityFindingsEmail>[2]['findings'][number]> = {},
  ): Parameters<typeof sendSecurityFindingsEmail>[2]['findings'][number] => ({
    label: 'F-12',
    severity: 'critical',
    title: 'SQL built from request query',
    file: 'src/routes/api/search.ts',
    urgent: true,
    duplicateNote: null,
    ...over,
  });
  const findingsData = {
    slug: 'acme-web',
    scanCount: 1,
    deployment: { id: 'dpl_8f2c', commit: '4e1b9a2ffff', at: Date.parse('2026-11-10T14:02:00Z') },
    tier: 'source_diff' as const,
    baseDeploymentId: 'dpl_7c20',
    filesScanned: 14,
    coverage: 'complete' as const,
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    provider: null,
    findings: [
      finding(),
      finding({ label: 'F-16', severity: 'medium', title: 'Cookie', urgent: false }),
    ],
    moreFindings: 0,
    leads: 3,
  };

  it('names the counts, the deployment and the reason, and keeps to titles and paths', async () => {
    const { binding, sent } = mockBinding();
    await sendSecurityFindingsEmail(binding, 'a@example.com', findingsData, {
      kind: 'owner_admin',
    });
    const [message] = sent;
    expect(message.subject).toBe(
      '[Void Cloud] acme-web: 2 new security findings (1 critical, 1 medium)',
    );
    expect(message.text).toContain('dpl_8f2c · commit 4e1b9a2 · Nov 10, 14:02 UTC');
    expect(message.text).toContain('changes since dpl_7c20 · source diff · 14 files · complete');
    expect(message.text).toContain('CRITICAL  F-12');
    expect(message.text).toContain('Also 3 new leads that need a human look');
    expect(message.text).toContain('F-12 is urgent: confirmed critical or high.');
    expect(message.text).toContain('You get this because you are an owner or admin of acme-web.');
    expect(message.text).toContain('/security/projects/acme-web');
    expect(message.text).not.toContain('dash.void.cloud');
  });

  it('writes the singular subject and the author footer', async () => {
    const { binding, sent } = mockBinding();
    await sendSecurityFindingsEmail(
      binding,
      'a@example.com',
      { ...findingsData, findings: [finding({ severity: 'medium', urgent: false })], leads: 0 },
      { kind: 'author', deploymentIds: ['dpl_8f2c'] },
    );
    expect(sent[0].subject).toBe('[Void Cloud] acme-web: 1 new security finding (medium)');
    expect(sent[0].text).toContain('You get this because you deployed dpl_8f2c to acme-web.');
    expect(sent[0].text).not.toContain('urgent');
  });

  it('says how many scans a merged email covers and warns when a third party ran the model', async () => {
    const { binding, sent } = mockBinding();
    await sendSecurityFindingsEmail(
      binding,
      'a@example.com',
      { ...findingsData, scanCount: 2, model: 'anthropic/claude-opus-5.5', provider: 'Anthropic' },
      { kind: 'owner_admin' },
    );
    expect(sent[0].text).toContain('2 security scans of acme-web found new issues.');
    expect(sent[0].text).toContain('Run by Anthropic: its usage policy applies and it may refuse.');
  });

  it('escapes model text, cuts it to 120 characters and never links a URL', async () => {
    const { binding, sent } = mockBinding();
    const title = `<img src=x onerror=alert(1)> https://evil.example/${'a'.repeat(200)}`;
    await sendSecurityFindingsEmail(
      binding,
      'a@example.com',
      { ...findingsData, findings: [finding({ title, file: '<b>x</b>.ts' })] },
      { kind: 'owner_admin' },
    );
    const [message] = sent;
    expect(message.html).not.toContain('<img');
    expect(message.html).not.toContain('<b>x</b>');
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(message.html).not.toContain('href="https://evil.example');
    expect(message.html).not.toContain('a'.repeat(121));
    expect(message.text).toContain('…');
  });

  it('shows a possible duplicate and the overflow line', async () => {
    const { binding, sent } = mockBinding();
    await sendSecurityFindingsEmail(
      binding,
      'a@example.com',
      {
        ...findingsData,
        findings: [
          finding({ duplicateNote: 'possible duplicate of F-3, resolved false positive on Nov 2' }),
        ],
        moreFindings: 4,
      },
      { kind: 'owner_admin' },
    );
    expect(sent[0].text).toContain('(possible duplicate of F-3, resolved false positive on Nov 2)');
    expect(sent[0].text).toContain('and 4 more');
    expect(sent[0].subject).toBe('[Void Cloud] acme-web: 5 new security findings');
  });

  it('names the actor role, never the person, in a reopened email, and cuts the comment to 300', async () => {
    const { binding, sent } = mockBinding();
    await sendSecurityReopenEmail(
      binding,
      'a@example.com',
      {
        slug: 'acme-web',
        finding: { label: 'F-12', severity: 'critical', title: 'SQL', file: 'src/a.ts' },
        actorRole: 'admin',
        comment: `Still broken <b>${'x'.repeat(400)}`,
      },
      { kind: 'owner_admin' },
    );
    expect(sent[0].subject).toBe('[Void Cloud] acme-web: F-12 reopened (critical)');
    expect(sent[0].text).toContain('Reopened by a project admin: "Still broken <b>');
    expect(sent[0].html).toContain('Still broken &lt;b&gt;');
    expect(sent[0].text).not.toContain('x'.repeat(301));
  });

  it('shows the raise line that works for a project cap', async () => {
    const { binding, sent } = mockBinding();
    const base = {
      slug: 'acme-web',
      percent: 80 as const,
      spentNano: 80_120_000_000,
      capNano: 100_000_000_000,
      resetLabel: 'Dec 1',
    };
    await sendSecurityProjectCapEmail(
      binding,
      'a@example.com',
      { ...base, raise: { kind: 'project_admin', usdArgument: '100', limitUsd: '$100.00' } },
      { kind: 'owner_admin' },
    );
    await sendSecurityProjectCapEmail(
      binding,
      'a@example.com',
      {
        ...base,
        percent: 100,
        spentNano: 100_000_000_000,
        raise: { kind: 'platform_admin', usdArgument: '150' },
      },
      { kind: 'owner_admin' },
    );
    expect(sent[0].subject).toBe(
      '[Void Cloud] acme-web: 80% of the monthly security scan budget used ($80.12 of $100.00)',
    );
    expect(sent[0].text).toContain('void project security budget --usd 100');
    expect(sent[0].text).toContain('up to the platform limit of $100.00');
    expect(sent[0].text).not.toContain('void platform security budget');
    expect(sent[1].subject).toBe(
      '[Void Cloud] acme-web: monthly security scan budget used up, new deploys are not scanned until Dec 1',
    );
    expect(sent[1].text).toContain('void platform security budget --project acme-web --usd 150');
    expect(sent[1].text).not.toContain('void project security budget');
  });

  it('writes the platform cap email for installation admins', async () => {
    const { binding, sent } = mockBinding();
    await sendSecurityPlatformCapEmail(
      binding,
      'root@example.com',
      {
        percent: 80,
        spentNano: 801_400_000_000,
        capNano: 1_000_000_000_000,
        resetLabel: 'Dec 1',
        raiseUsdArgument: '1500',
      },
      { kind: 'installation_admin' },
    );
    expect(sent[0].subject).toBe(
      '[Void Cloud] Platform: 80% of the monthly security scan budget used ($801.40 of $1,000.00)',
    );
    expect(sent[0].text).toContain('void platform security budget --platform-usd 1500');
    expect(sent[0].text).toContain('You get this because you are an administrator of Void Cloud.');
    expect(sent[0].text).not.toContain('/security/projects/');
  });

  describe('public requests', () => {
    const base = {
      slug: 'acme-web',
      requestedBy: 'a project admin',
      requestedAt: Date.parse('2026-11-17T14:02:00Z'),
      scanned: 'dpl_9a1d · full scan · complete',
      blockers: [finding(), finding({ label: 'F-15', severity: 'high', title: 'No auth' })],
      blockerCount: 2,
    };

    it('never offers a bypass in the held email for urgent findings', async () => {
      const { binding, sent } = mockBinding();
      await sendSecurityPublicHeldEmail(
        binding,
        'a@example.com',
        { ...base, state: 'held_findings', noResultReason: null },
        { kind: 'requester' },
      );
      const [message] = sent;
      expect(message.subject).toBe(
        '[Void Cloud] acme-web stays protected: 2 urgent security findings must be resolved first',
      );
      expect(message.text).toContain('Blocking');
      expect(message.text).toContain('F-15');
      expect(message.text).not.toMatch(/bypass/i);
      expect(message.html).not.toMatch(/bypass/i);
      expect(message.text).toContain('You get this because you asked for acme-web to go public.');
    });

    it('names the bypass command only when there is no result or no deploy to scan', async () => {
      const { binding, sent } = mockBinding();
      await sendSecurityPublicHeldEmail(
        binding,
        'a@example.com',
        {
          ...base,
          blockers: [],
          blockerCount: 0,
          state: 'held_no_result',
          noResultReason: 'refused by anthropic/claude-opus-5.5',
        },
        { kind: 'owner_admin' },
      );
      await sendSecurityPublicHeldEmail(
        binding,
        'a@example.com',
        { ...base, blockers: [], blockerCount: 0, state: 'needs_deploy', noResultReason: null },
        { kind: 'owner_admin' },
      );
      expect(sent[0].subject).toBe(
        '[Void Cloud] acme-web stays protected: the security scan did not finish (refused by anthropic/claude-opus-5.5)',
      );
      expect(sent[0].text).toContain('void project zero-trust bypass --reason');
      expect(sent[1].subject).toBe(
        '[Void Cloud] acme-web stays protected: deploy again so the live code can be scanned',
      );
      expect(sent[1].text).toContain('void project zero-trust bypass --reason');
    });

    it('writes the now-public and canceled emails', async () => {
      const { binding, sent } = mockBinding();
      await sendSecurityNowPublicEmail(
        binding,
        'a@example.com',
        { slug: 'acme-web', how: 'passed' },
        { kind: 'owner_admin' },
      );
      await sendSecurityNowPublicEmail(
        binding,
        'a@example.com',
        { slug: 'acme-web', how: 'bypassed' },
        { kind: 'owner_admin' },
      );
      await sendSecurityPublicCanceledEmail(
        binding,
        'a@example.com',
        { slug: 'acme-web', cause: 'gate_off' },
        { kind: 'owner_admin' },
      );
      expect(sent.map((message) => message.subject)).toEqual([
        '[Void Cloud] acme-web is now public (security scan passed)',
        '[Void Cloud] acme-web is now public (security scan bypassed)',
        '[Void Cloud] acme-web public request canceled: it stays protected',
      ]);
      expect(sent[2].text).toContain('turned off "Scan before a project goes public"');
      expect(sent[2].text).toContain('void project zero-trust public');
    });
  });

  it('names the person and the cut reason in the bypass email', async () => {
    const { binding, sent } = mockBinding();
    await sendSecurityBypassEmail(
      binding,
      'root@example.com',
      {
        slug: 'acme-web',
        actor: 'alice@example.com',
        actorRole: 'project admin',
        at: Date.parse('2026-11-17T15:10:00Z'),
        reason: `Scanner down <script> ${'y'.repeat(400)}`,
        skipped: 'the scan did not finish (timed out)',
        deploymentId: 'dpl_a3f0',
        uncheckedFixes: ['F-15'],
      },
      { kind: 'installation_admin' },
    );
    const [message] = sent;
    expect(message.subject).toBe(
      '[Void Cloud] acme-web: security scan bypassed by a project admin',
    );
    expect(message.text).toContain('alice@example.com (project admin) · Nov 17, 15:10 UTC');
    expect(message.text).toContain('no urgent finding · 1 fix not yet checked by a scan (F-15)');
    expect(message.text).not.toContain('y'.repeat(301));
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.text).toContain('void platform security bypasses --project acme-web');
  });
});
