import { describe, expect, it } from 'vite-plus/test';
import { parseProjectArgs, projectSubcommands } from '../../src/cli/project-args.ts';

describe('parseProjectArgs', () => {
  describe('token', () => {
    it('parses bounded credential creation and revocation', () => {
      expect(
        parseProjectArgs([
          'token',
          'create',
          '--project',
          'app',
          '--name',
          'github-actions',
          '--expires-in',
          '30',
          '--json',
        ]),
      ).toEqual({
        subcommand: 'token',
        action: 'create',
        credentialId: '',
        projectSlug: 'app',
        name: 'github-actions',
        expiresInDays: 30,
        json: true,
      });
      expect(parseProjectArgs(['token', 'revoke', 'credential-id'])).toMatchObject({
        subcommand: 'token',
        action: 'revoke',
        credentialId: 'credential-id',
      });
    });

    it('rejects missing actions, IDs, and unbounded expiry', () => {
      expect(() => parseProjectArgs(['token'])).toThrow('create|list|renew|revoke');
      expect(() => parseProjectArgs(['token', 'renew'])).toThrow('requires a credential ID');
      expect(() => parseProjectArgs(['token', 'create', '--expires-in', '91'])).toThrow(
        'integer from 1 to 90',
      );
    });
  });

  describe('team', () => {
    it('opens the team command group without requiring an action', () => {
      expect(parseProjectArgs(['team'])).toEqual({ subcommand: 'team', action: '' });
    });

    it('parses project-scoped team commands', () => {
      expect(parseProjectArgs(['team', 'list', '--project', 'my-app'])).toEqual({
        subcommand: 'team',
        action: 'list',
        projectSlug: 'my-app',
      });
      expect(
        parseProjectArgs(['team', 'invite', 'member@example.com', '--role', 'collaborator']),
      ).toEqual({
        subcommand: 'team',
        action: 'invite',
        email: 'member@example.com',
        role: 'collaborator',
        projectSlug: '',
      });
      expect(parseProjectArgs(['team', 'role', 'user_1', 'admin'])).toEqual({
        subcommand: 'team',
        action: 'role',
        userId: 'user_1',
        role: 'admin',
        projectSlug: '',
      });
      expect(parseProjectArgs(['team', 'remove', 'user_1'])).toEqual({
        subcommand: 'team',
        action: 'remove',
        userId: 'user_1',
        projectSlug: '',
      });
      expect(parseProjectArgs(['team', 'revoke', 'invite_1'])).toEqual({
        subcommand: 'team',
        action: 'revoke',
        invitationId: 'invite_1',
        projectSlug: '',
      });
    });

    it('parses invitation inbox commands without a project', () => {
      expect(parseProjectArgs(['team', 'pending'])).toEqual({
        subcommand: 'team',
        action: 'pending',
      });
      expect(parseProjectArgs(['team', 'accept', 'invite_1'])).toEqual({
        subcommand: 'team',
        action: 'accept',
        invitationId: 'invite_1',
      });
      expect(parseProjectArgs(['team', 'decline', 'invite_1'])).toEqual({
        subcommand: 'team',
        action: 'decline',
        invitationId: 'invite_1',
      });
    });

    it('requires a registered email input and valid roles', () => {
      for (const email of ['member', '@example.com', 'member@']) {
        expect(() => parseProjectArgs(['team', 'invite', email, '--role', 'reader'])).toThrow(
          'Invitee must be a registered email address',
        );
      }
      expect(() =>
        parseProjectArgs(['team', 'invite', 'member@example.com', '--role', 'owner']),
      ).toThrow("Invalid role 'owner'");
      expect(() => parseProjectArgs(['team', 'role', 'user_1', 'owner'])).toThrow(
        "Invalid role 'owner'",
      );
    });

    it('rejects project selection for invitation inbox commands', () => {
      expect(() => parseProjectArgs(['team', 'pending', '--project', 'my-app'])).toThrow(
        '--project is not used with team pending',
      );
    });
  });

  describe('zero-trust', () => {
    it('opens the group and parses every project operation', () => {
      expect(parseProjectArgs(['zero-trust'])).toEqual({
        subcommand: 'zero-trust',
        action: '',
        projectSlug: '',
      });
      for (const action of ['status', 'protect', 'public', 'reconcile'] as const) {
        expect(parseProjectArgs(['zero-trust', action, '--project', 'my-app'])).toEqual({
          subcommand: 'zero-trust',
          action,
          projectSlug: 'my-app',
        });
      }
    });

    it('rejects unknown operations and malformed project selection', () => {
      for (const action of ['remove', 'enable', 'disable']) {
        expect(() => parseProjectArgs(['zero-trust', action])).toThrow(
          'status|protect|public|reconcile',
        );
      }
      expect(() => parseProjectArgs(['zero-trust', 'status', '--project'])).toThrow(
        '--project requires a value',
      );
      expect(() =>
        parseProjectArgs(['zero-trust', 'status', '--project', 'one', '--project', 'two']),
      ).toThrow("Duplicate flag '--project'");
    });
  });

  describe('cancel', () => {
    it('parses cancel without a deployment id', () => {
      expect(parseProjectArgs(['cancel'])).toEqual({
        subcommand: 'cancel',
        deployId: '',
      });
    });

    it('parses cancel with a deployment id', () => {
      expect(parseProjectArgs(['cancel', 'dpl_123'])).toEqual({
        subcommand: 'cancel',
        deployId: 'dpl_123',
      });
    });

    it('errors on unexpected argument', () => {
      expect(() => parseProjectArgs(['cancel', 'dpl_123', 'extra'])).toThrow(
        "project: Unexpected argument 'extra'.",
      );
    });
  });

  describe('logs', () => {
    it('parses logs with no flags', () => {
      expect(parseProjectArgs(['logs'])).toEqual({
        subcommand: 'logs',
        filter: '',
        range: '1h',
        deployment: '',
        level: '',
      });
    });

    it('parses --filter, --range, --deployment, and --level together', () => {
      expect(
        parseProjectArgs([
          'logs',
          '--filter',
          'websocket',
          '--range',
          '30m',
          '--deployment',
          'dpl_abc',
          '--level',
          'error',
        ]),
      ).toEqual({
        subcommand: 'logs',
        filter: 'websocket',
        range: '30m',
        deployment: 'dpl_abc',
        level: 'error',
      });
    });

    it('accepts every documented level', () => {
      for (const v of ['error', 'warn', 'info', 'log', 'debug', 'all']) {
        const parsed = parseProjectArgs(['logs', '--level', v]);
        if (parsed.subcommand !== 'logs') {
          throw new Error('expected logs subcommand');
        }
        expect(parsed.level).toBe(v);
      }
    });

    it('rejects an invalid --level value', () => {
      expect(() => parseProjectArgs(['logs', '--level', 'fatal'])).toThrow(
        "project: Invalid --level 'fatal'. Use one of error|warn|info|log|debug|all.",
      );
    });

    it('rejects unknown flags', () => {
      expect(() => parseProjectArgs(['logs', '--bogus'])).toThrow(
        "project: Unexpected argument '--bogus'.",
      );
    });
  });

  describe('requests', () => {
    it('parses requests with no flags', () => {
      expect(parseProjectArgs(['requests'])).toEqual({
        subcommand: 'requests',
        status: '',
        range: '1h',
      });
    });

    it('parses --status and --range together', () => {
      expect(parseProjectArgs(['requests', '--status', '5xx', '--range', '30m'])).toEqual({
        subcommand: 'requests',
        status: '5xx',
        range: '30m',
      });
    });

    it('accepts status classes, exact codes, and all', () => {
      for (const v of ['2xx', '4xx', '5xx', '500', '404', 'all']) {
        const parsed = parseProjectArgs(['requests', '--status', v]);
        if (parsed.subcommand !== 'requests') {
          throw new Error('expected requests subcommand');
        }
        expect(parsed.status).toBe(v);
      }
    });

    it('rejects an invalid --status value', () => {
      expect(() => parseProjectArgs(['requests', '--status', 'oops'])).toThrow(
        "project: Invalid --status 'oops'. Use a class like 5xx or an exact code like 500.",
      );
    });

    it('rejects exact codes outside the 100-599 HTTP range', () => {
      for (const v of ['000', '099', '600', '999']) {
        expect(() => parseProjectArgs(['requests', '--status', v])).toThrow(
          `project: Invalid --status '${v}'. Use a class like 5xx or an exact code like 500.`,
        );
      }
    });

    it('rejects unknown flags', () => {
      expect(() => parseProjectArgs(['requests', '--bogus'])).toThrow(
        "project: Unexpected argument '--bogus'.",
      );
    });
  });

  describe('purge-cache', () => {
    it('parses purge-cache', () => {
      expect(parseProjectArgs(['purge-cache'])).toEqual({
        subcommand: 'purge-cache',
        projectSlug: '',
      });
    });

    it('parses purge-cache with --project', () => {
      expect(parseProjectArgs(['purge-cache', '--project', 'my-app'])).toEqual({
        subcommand: 'purge-cache',
        projectSlug: 'my-app',
      });
    });

    it('errors on unexpected argument', () => {
      expect(() => parseProjectArgs(['purge-cache', 'extra'])).toThrow(
        "project: Unexpected argument 'extra'.",
      );
    });
  });

  describe('unknown-flag rejection', () => {
    // status/link/rollback/cancel previously captured a leading flag as the positional id.
    it('rejects an unknown flag for status instead of capturing it as the name', () => {
      expect(() => parseProjectArgs(['status', '--foo'])).toThrow("project: Unknown flag '--foo'.");
    });

    it('rejects an unknown flag for link', () => {
      expect(() => parseProjectArgs(['link', '--foo'])).toThrow("project: Unknown flag '--foo'.");
    });

    it('rejects an unknown flag for rollback', () => {
      expect(() => parseProjectArgs(['rollback', '--foo'])).toThrow(
        "project: Unknown flag '--foo'.",
      );
    });

    it('accepts --platform cloudflare for rollback in either position', () => {
      expect(parseProjectArgs(['rollback', '--platform', 'cloudflare'])).toEqual({
        subcommand: 'rollback',
        deployId: '',
        platform: 'cloudflare',
      });
      expect(parseProjectArgs(['rollback', 'abc123', '--platform=cloudflare'])).toEqual({
        subcommand: 'rollback',
        deployId: 'abc123',
        platform: 'cloudflare',
      });
      expect(parseProjectArgs(['rollback', 'abc123'])).toEqual({
        subcommand: 'rollback',
        deployId: 'abc123',
      });
    });

    it('offers --platform as a rollback flag in the interactive list', () => {
      const rollback = projectSubcommands.find((entry) => entry.name === 'rollback');
      expect(rollback?.arg).toBe('[deployId]');
      expect(rollback?.flags).toEqual([
        expect.objectContaining({ name: '--platform', arg: 'cloudflare' }),
      ]);
      // The prompt passes the id and each flag value as separate argv items.
      expect(parseProjectArgs(['rollback', 'abc123', '--platform', 'cloudflare'])).toEqual({
        subcommand: 'rollback',
        deployId: 'abc123',
        platform: 'cloudflare',
      });
    });

    it.each([['void'], ['']])('rejects rollback --platform %o', (value) => {
      expect(() => parseProjectArgs(['rollback', `--platform=${value}`])).toThrow(
        "accepts only 'cloudflare'",
      );
    });

    it('rejects rollback --platform without a value', () => {
      expect(() => parseProjectArgs(['rollback', '--platform'])).toThrow(
        "accepts only 'cloudflare'",
      );
    });

    it('rejects --platform for cancel', () => {
      expect(() => parseProjectArgs(['cancel', '--platform', 'cloudflare'])).toThrow(
        "project: Unknown flag '--platform'.",
      );
    });

    it('rejects an unknown flag for cancel', () => {
      expect(() => parseProjectArgs(['cancel', '--foo'])).toThrow("project: Unknown flag '--foo'.");
    });

    it('still accepts a valid positional id', () => {
      expect(parseProjectArgs(['status', 'my-app'])).toEqual({
        subcommand: 'status',
        name: 'my-app',
      });
    });
  });
});
