import type { ApiEnv } from './env.ts';
import {
  getPlatformApiUrl,
  getPlatformDisplayName,
  platformConnectCommand,
} from './platform-identity.ts';

type PlatformEmailEnv = Pick<
  ApiEnv['Bindings'],
  | 'EMAIL'
  | 'EMAIL_FROM'
  | 'EMAIL_SENDER_DOMAIN'
  | 'PLATFORM_DISPLAY_NAME'
  | 'PLATFORM_INSTALLATION_ID'
  | 'AUTH_REDIRECT_URI'
  | 'PLATFORM_ENV'
  | 'DASHBOARD_URL'
>;

const BUTTON_STYLE =
  'display:inline-block;background:#000;color:#fff;padding:10px 24px;text-decoration:none;border-radius:4px;font-weight:500';

function emailHtml(body: string, footer: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;color:#1a1a1a">
${body}
<p style="color:#666;font-size:0.85rem;margin-top:24px">${escapeHtml(footer)}</p>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="${BUTTON_STYLE}">${escapeHtml(label)}</a>`;
}

/**
 * EMAIL_FROM overrides the sender. Without it, an installation sends from
 * `noreply@<EMAIL_SENDER_DOMAIN>`, the mailbox that destination verification
 * mail already uses; `noreply` is a reserved slug, so no project owns it.
 */
function platformSender(
  env: PlatformEmailEnv,
  hosted: boolean,
  name: string,
): string | EmailAddress {
  const from = env.EMAIL_FROM?.trim() || (hosted ? 'Void <noreply@void.cloud>' : '');
  const domain = env.EMAIL_SENDER_DOMAIN?.trim();
  if ((!from && !domain) || /[\r\n]/.test(from)) {
    throw new Error(
      'Set EMAIL_FROM to a Cloudflare-verified sender before enabling platform email.',
    );
  }
  if (from) {
    return from;
  }
  // The display name goes in its own field, so the binding encodes it and a
  // name such as `Acme <Ops>` cannot change the address. Control characters
  // could still split the From header.
  if (/\p{Cc}/u.test(name + domain)) {
    throw new Error(
      'PLATFORM_DISPLAY_NAME and EMAIL_SENDER_DOMAIN must not contain control characters.',
    );
  }
  return { name, email: `noreply@${domain}` };
}

function emailConfig(env: PlatformEmailEnv) {
  const apiUrl = getPlatformApiUrl(env);
  const hosted =
    !env.PLATFORM_INSTALLATION_ID &&
    ['https://api.void.cloud', 'https://api.staging.void.cloud'].includes(apiUrl);
  const name = getPlatformDisplayName(env);
  const from = platformSender(env, hosted, name);
  const dashboardUrl =
    env.DASHBOARD_URL ||
    (hosted
      ? env.PLATFORM_ENV === 'staging'
        ? 'https://dash.staging.void.cloud'
        : 'https://dash.void.cloud'
      : undefined);
  if (dashboardUrl) {
    const dashboard = new URL(dashboardUrl);
    if (
      !['http:', 'https:'].includes(dashboard.protocol) ||
      dashboard.username ||
      dashboard.password
    ) {
      throw new Error('DASHBOARD_URL must be an HTTP(S) URL without credentials.');
    }
  }
  return { apiUrl, from, dashboardUrl, name };
}

function dashboardProjectUrl(dashboardUrl: string | undefined, projectSlug: string): string | null {
  return dashboardUrl
    ? new URL(`/projects/${encodeURIComponent(projectSlug)}`, dashboardUrl).href
    : null;
}

async function sendEmail(
  env: PlatformEmailEnv,
  params: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  const { from } = emailConfig(env);
  if (!env.EMAIL) {
    throw new Error('Platform email is not configured.');
  }
  await env.EMAIL.send({ from, ...params });
}

export async function sendInvitationEmail(env: PlatformEmailEnv, to: string): Promise<void> {
  const { apiUrl, name } = emailConfig(env);
  const command = platformConnectCommand(apiUrl);
  const inviteUrl = `${apiUrl}/invite`;
  await sendEmail(env, {
    to,
    subject: `You're invited to ${name}`,
    html: emailHtml(
      `<h2 style="margin-bottom:8px">You're invited to ${escapeHtml(name)}</h2>
<p>An administrator has invited you to deploy applications on ${escapeHtml(name)}.</p>
<p>Connect the Void CLI to this platform. When prompted, sign in with an account whose verified email address matches this invitation:</p>
<pre><code>${escapeHtml(command)}</code></pre>
<p>${button(inviteUrl, 'Get Started')}</p>`,
      "If you didn't expect this invitation, you can ignore this email.",
    ),
    text: `You're invited to ${name}.\n\nAn administrator has invited you to deploy applications on ${name}.\n\nConnect the Void CLI to this platform. When prompted, sign in with an account whose verified email address matches this invitation:\n\n${command}\n\nGet started: ${inviteUrl}\n\nIf you didn't expect this invitation, you can ignore this email.`,
  });
}

export async function sendProjectInvitationEmail(
  env: PlatformEmailEnv,
  params: {
    to: string;
    invitationId: string;
    projectSlug: string;
    inviterLogin: string;
    role: 'reader' | 'collaborator' | 'admin';
  },
): Promise<void> {
  const { apiUrl, name } = emailConfig(env);
  const inviteUrl = new URL('/invite', apiUrl);
  inviteUrl.searchParams.set('project-invitation', params.invitationId);
  const command = platformConnectCommand(apiUrl);
  await sendEmail(env, {
    to: params.to,
    subject: `You're invited to ${params.projectSlug}`,
    html: emailHtml(
      `<h2 style="margin-bottom:8px">You're invited to ${escapeHtml(params.projectSlug)}</h2>
<p><strong>${escapeHtml(params.inviterLogin)}</strong> invited you to join <strong>${escapeHtml(params.projectSlug)}</strong> as ${escapeHtml(params.role)} on ${escapeHtml(name)}.</p>
<p>Connect the Void CLI with this email address, then accept the invitation:</p>
<pre><code>${escapeHtml(command)}
void project team accept ${escapeHtml(params.invitationId)}</code></pre>
<p>${button(inviteUrl.href, 'View Invitation')}</p>`,
      "If you didn't expect this invitation, you can decline it or ignore this email.",
    ),
    text: `You're invited to ${params.projectSlug}\n\n${params.inviterLogin} invited you to join ${params.projectSlug} as ${params.role} on ${name}.\n\nConnect the Void CLI with this email address, then accept the invitation:\n\n${command}\nvoid project team accept ${params.invitationId}\n\nView invitation: ${inviteUrl.href}\n\nIf you didn't expect this invitation, you can decline it or ignore this email.`,
  });
}

export async function sendWelcomeEmail(
  env: PlatformEmailEnv,
  to: string,
  login: string,
): Promise<void> {
  const { apiUrl, name } = emailConfig(env);
  const command = platformConnectCommand(apiUrl);
  await sendEmail(env, {
    to,
    subject: `Welcome to ${name}`,
    html: emailHtml(
      `<h2 style="margin-bottom:8px">Welcome to ${escapeHtml(name)}, ${escapeHtml(login)}</h2>
<p>Your account is ready. Connect the Void CLI to this platform:</p>
<pre><code>${escapeHtml(command)}</code></pre>
<p>The CLI opens your browser to sign in when needed. See the platform setup guide for the next steps.</p>
<p>${button(`${apiUrl}/invite`, 'Platform Setup')}</p>`,
      `You received this email because you signed up for ${name}.`,
    ),
    text: `Welcome to ${name}, ${login}\n\nYour account is ready. Connect the Void CLI to this platform:\n\n${command}\n\nThe CLI opens your browser to sign in when needed. See the platform setup guide for the next steps.\n\nPlatform setup: ${apiUrl}/invite\n\nYou received this email because you signed up for ${name}.`,
  });
}

export async function sendDeployFailedEmail(
  env: PlatformEmailEnv,
  to: string,
  projectSlug: string,
  errorMessage: string,
): Promise<void> {
  const { apiUrl, dashboardUrl, name } = emailConfig(env);
  const truncated = errorMessage.length > 200 ? errorMessage.slice(0, 200) + '...' : errorMessage;
  const projectUrl = dashboardProjectUrl(dashboardUrl, projectSlug);
  const command = platformConnectCommand(apiUrl);
  await sendEmail(env, {
    to,
    subject: `Deploy failed: ${projectSlug}`,
    html: emailHtml(
      `<h2 style="margin-bottom:8px">Deploy failed: ${escapeHtml(projectSlug)}</h2>
<p>A deploy to <strong>${escapeHtml(projectSlug)}</strong> on ${escapeHtml(name)} failed with the following error:</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;font-size:0.85rem">${escapeHtml(truncated)}</pre>
<p>Connect to this platform to inspect the deployment:</p><pre><code>${escapeHtml(command)}
void project status</code></pre>
${projectUrl ? `<p>${button(projectUrl, 'View Project')}</p>` : ''}`,
      `You received this email because you own this project on ${name}.`,
    ),
    text: `Deploy failed: ${projectSlug}\n\nA deploy to ${projectSlug} on ${name} failed with the following error:\n\n${truncated}\n\nConnect to this platform to inspect the deployment:\n${command}\nvoid project status\n${projectUrl ? `\nView project: ${projectUrl}\n` : ''}\nYou received this email because you own this project on ${name}.`,
  });
}

/** Format an epoch-ms instant as `YYYY-MM-DD HH:MM UTC`. */
function utcStamp(ms: number): string {
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/** Insert thousands separators, e.g. 1252 -> "1,252". */
function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Suggest a `--range` value reaching from the moment the email is sent back to
 * the first error in the window, matching the CLI's `^\d+(m|h|d)$` grammar and
 * its 7-day retention cap. Anchoring on send time rather than the last error
 * keeps the command valid when delivery failures retry the alert for hours.
 */
function suggestRange(start: number, sentAt: number): string {
  const hours = Math.ceil((sentAt - start) / 3_600_000) + 1;
  return hours <= 168 ? `${hours}h` : '7d';
}

export async function sendErrorAlertEmail(
  env: PlatformEmailEnv,
  to: string,
  projectSlug: string,
  errorCount: number,
  window: { start: number; end: number } | null,
  sentAt: number = Date.now(),
): Promise<void> {
  const { apiUrl, dashboardUrl, name } = emailConfig(env);
  const projectUrl = dashboardProjectUrl(dashboardUrl, projectSlug);
  const command = platformConnectCommand(apiUrl);
  const count = formatCount(errorCount);
  const when = window
    ? `between ${utcStamp(window.start)} and ${utcStamp(window.end)}`
    : 'recently';
  const range = window ? suggestRange(window.start, sentAt) : '24h';
  const requestsHint = `void project requests --status 5xx --range ${range}`;
  const logsHint = `void project logs --level error --range ${range}`;
  const hintNote =
    'The first lists every 5xx, including errors generated at the edge that never reach your worker; the second adds worker logs and exceptions.';
  await sendEmail(env, {
    to,
    subject: `5xx errors detected: ${projectSlug}`,
    html: emailHtml(
      `<h2 style="margin-bottom:8px">5xx errors detected: ${escapeHtml(projectSlug)}</h2>
<p>Your project <strong>${escapeHtml(projectSlug)}</strong> on ${escapeHtml(name)} returned <strong>${count}</strong> server error responses ${escapeHtml(when)}.</p>
<p style="margin-bottom:4px;color:#444">Connect to this platform and inspect them from the CLI:</p>
<pre style="background:#f4f4f5;padding:12px 16px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.85rem;overflow-x:auto;margin:0 0 8px"><code>${escapeHtml(command)}
${escapeHtml(requestsHint)}
${escapeHtml(logsHint)}</code></pre>
<p style="color:#666;font-size:0.85rem;margin:0 0 16px">${escapeHtml(hintNote)}</p>
${projectUrl ? `<p>${button(projectUrl, 'View Project')}</p>` : ''}`,
      `You will not receive another alert for this project for 24 hours. You received this email because you own this project on ${name}.`,
    ),
    text: `5xx errors detected: ${projectSlug}\n\nYour project ${projectSlug} on ${name} returned ${count} server error responses ${when}.\n\nConnect to this platform and inspect them from the CLI:\n  ${command}\n  ${requestsHint}\n  ${logsHint}\n\n${hintNote}\n${projectUrl ? `\nView project: ${projectUrl}\n` : ''}\nYou will not receive another alert for this project for 24 hours. You received this email because you own this project on ${name}.`,
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
