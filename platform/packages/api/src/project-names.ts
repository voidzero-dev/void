import { PLATFORM_HEALTH_HOSTNAME_LABEL } from '@void/platform';
import { EMAIL_RESERVED_SLUGS } from './reserved-slugs.ts';

/**
 * Slugs no project may claim. Three overlapping reasons:
 *
 *  - hostname collisions on `*.void.app` (`www`, `api`, `dash`, `cname`, …),
 *    including the hostname dispatch keeps for platform health probes;
 *  - EMAIL sender identity: `EMAIL_RESERVED_SLUGS` (`../reserved-slugs.ts`).
 *    A project's outbound `from` is `<slug>[+tag]@<EMAIL_SENDER_DOMAIN>`,
 *    so owning a slug owns that mailbox, and a user registering `noreply`
 *    could send mail indistinguishable from the platform's own. That set
 *    is folded in here rather than listed twice: this check only reaches
 *    NEW projects, so the email path enforces the same set on its own
 *    against a project that registered the slug before it was reserved;
 *  - certificate-authority domain-validation mailboxes on the shared mail
 *    domain (`admin`, `administrator`, `hostmaster`, `postmaster`,
 *    `webmaster`): a project receiving one could pass a CA email check and
 *    get a certificate for that domain. Reserved for new projects only.
 */
export const RESERVED_SLUGS = new Set([
  ...EMAIL_RESERVED_SLUGS,
  PLATFORM_HEALTH_HOSTNAME_LABEL,
  'admin',
  'administrator',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'cname',
  'dash',
  'dashboard',
  'docs',
  'ftp',
  'gateway',
  'help',
  'hostmaster',
  'imap',
  'login',
  'mail',
  'ns1',
  'ns2',
  'ns3',
  'ns4',
  'oauth',
  'pop',
  'proxy',
  'register',
  'signup',
  'smtp',
  'sso',
  'staging',
  'static',
  'status',
  'support',
  'webmaster',
  'www',
]);

/**
 * Longest slug a project may claim. The slug is an EMAIL local-part prefix:
 * the runtime's default sender is `<slug>+noreply@<EMAIL_SENDER_DOMAIN>` and
 * inbound mail arrives at `<slug>+<tag>@`. RFC 5321 § 4.5.3.1.1 caps a
 * local-part at 64 octets and `+noreply` takes 8 of them, so a slug over 56
 * has no working default sender (the runtime's `VALID_SLUG` refuses it and
 * `sendEmail` returns `INVALID_FROM`). 56 also sits inside the 63-octet DNS
 * label `<slug>.void.app` needs, which nothing else enforced either.
 */
export const MAX_SLUG_LENGTH = 56;

const PROJECT_NAME_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The shape, length and reserved-name rules for a project slug, which an email
 * alias shares because both name a mailbox on the shared mail domain. Returns
 * the refusal message, or null when `name` is allowed. Short names also need
 * the owner's plan to allow them; callers check that.
 */
export function projectNameError(name: string, label: 'slug' | 'alias'): string | null {
  if (!PROJECT_NAME_SHAPE.test(name)) {
    return `${label} must be lowercase alphanumeric with dashes`;
  }
  if (name.length > MAX_SLUG_LENGTH) {
    return `${label} must be at most ${MAX_SLUG_LENGTH} characters`;
  }
  if (RESERVED_SLUGS.has(name) || name.startsWith('preview-')) {
    return 'this name is reserved';
  }
  return null;
}
