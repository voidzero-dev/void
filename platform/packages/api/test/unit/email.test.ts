import { describe, expect, it } from 'vite-plus/test';
import {
  sendErrorAlertEmail,
  sendInvitationEmail,
  sendProjectInvitationEmail,
  sendWelcomeEmail,
  sendDeployFailedEmail,
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
