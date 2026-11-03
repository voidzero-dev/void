import { describe, it, expect } from 'vite-plus/test';
import { RESERVED_SLUGS } from '../../src/project-names.ts';
import { EMAIL_RESERVED_SLUGS, isReservedEmailSlug } from '../../src/reserved-slugs.ts';

describe('reserved slugs (real implementation)', () => {
  it('blocks cname slug (CNAME target)', () => {
    expect(RESERVED_SLUGS.has('cname')).toBe(true);
  });

  it('blocks platform-related slugs', () => {
    for (const slug of ['admin', 'api', 'dash', 'dashboard', 'proxy', 'staging']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });

  it('blocks the hostname dispatch keeps for platform health probes', () => {
    expect(RESERVED_SLUGS.has('void-platform-health')).toBe(true);
  });

  it('blocks infrastructure slugs', () => {
    for (const slug of ['mail', 'smtp', 'ns1', 'ns2', 'ftp']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });

  // A project's outbound `from` is `<slug>[+tag]@<EMAIL_SENDER_DOMAIN>`, so a
  // slug IS a mailbox on the platform mail domain. `noreply` is the platform's
  // own verification sender — the proxy's internal allow-list is exactly
  // `noreply@<domain>` — and the rest are the addresses recipients and mail
  // providers treat as authoritative for a whole domain.
  it('blocks email-identity slugs', () => {
    for (const slug of ['noreply', 'postmaster', 'abuse', 'bounce', 'security']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });

  // A certificate authority may prove control of a domain by mailing one of
  // these local-parts, and a project slug is a mailbox on the shared mail
  // domain. The three newer names are refused only at create time, so an
  // existing project that already holds one keeps receiving its mail.
  it('blocks the CA domain-validation mailboxes', () => {
    for (const slug of ['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
    for (const slug of ['administrator', 'hostmaster', 'webmaster']) {
      expect(isReservedEmailSlug(slug)).toBe(false);
    }
  });

  it('allows normal project slugs', () => {
    for (const slug of ['my-app', 'cool-project', 'hello-world', 'test123']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(false);
    }
  });

  it('has a reasonable minimum size', () => {
    expect(RESERVED_SLUGS.size).toBeGreaterThanOrEqual(30);
  });
});

// The five email-identity slugs were reserved only when email shipped, so a
// project registered before that can still hold one and the create-time
// check above never sees it. The email path (api backfill, proxy send,
// inbound router) therefore enforces `EMAIL_RESERVED_SLUGS` on its own; this
// pins that set to the create-time list so the two cannot drift apart.
describe('email-reserved slugs (shared with the proxy)', () => {
  it('is exactly the email-identity subset', () => {
    expect([...EMAIL_RESERVED_SLUGS].sort()).toEqual([
      'abuse',
      'bounce',
      'noreply',
      'postmaster',
      'security',
    ]);
  });

  it('is a subset of the create-time reserved list', () => {
    for (const slug of EMAIL_RESERVED_SLUGS) {
      expect(RESERVED_SLUGS.has(slug), `${slug} must also be refused at create`).toBe(true);
    }
  });

  it('isReservedEmailSlug refuses each email identity', () => {
    for (const slug of EMAIL_RESERVED_SLUGS) {
      expect(isReservedEmailSlug(slug)).toBe(true);
    }
  });

  it('isReservedEmailSlug leaves hostname-only reservations and ordinary slugs alone', () => {
    // Reserved since the first commit, so no project can hold one; and a
    // hostname collision is not a mailbox.
    for (const slug of ['www', 'api', 'mail', 'smtp', 'imap', 'pop']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
      expect(isReservedEmailSlug(slug)).toBe(false);
    }
    for (const slug of ['my-app', 'noreply-tools', 'abuse-report', 'postmaster2']) {
      expect(isReservedEmailSlug(slug)).toBe(false);
    }
  });
});
