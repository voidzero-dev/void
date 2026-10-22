import { note } from '@voidzero-dev/vite-plus-prompts';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getHelpPath, hasHelpPage, printHelpPage } from '../../src/cli/help.ts';

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  note: vi.fn(),
  outro: vi.fn(),
}));

describe('CLI help resolver', () => {
  beforeEach(() => {
    vi.mocked(note).mockClear();
  });

  it('resolves top-level help requests', () => {
    expect(getHelpPath(['help'])).toEqual([]);
    expect(getHelpPath(['--help'])).toEqual([]);
    expect(getHelpPath(['-h'])).toEqual([]);
  });

  it('resolves command help requests', () => {
    expect(getHelpPath(['help', 'deploy'])).toEqual(['deploy']);
    expect(getHelpPath(['deploy', '--help'])).toEqual(['deploy']);
    expect(getHelpPath(['deploy', '-h'])).toEqual(['deploy']);
    expect(getHelpPath(['deploy', '--project', 'my-app', '--help'])).toEqual(['deploy']);
    expect(getHelpPath(['deploy', 'my-app', '--help'])).toEqual(['deploy']);
  });

  it('resolves grouped subcommand help requests', () => {
    expect(getHelpPath(['help', 'db', 'execute'])).toEqual(['db', 'execute']);
    expect(getHelpPath(['db', 'help', 'execute'])).toEqual(['db', 'execute']);
    expect(getHelpPath(['db', 'execute', '--help'])).toEqual(['db', 'execute']);
    expect(getHelpPath(['db', 'execute', '--file', 'query.sql', '--help'])).toEqual([
      'db',
      'execute',
    ]);
    expect(getHelpPath(['db', 'execute', 'select 1', '--help'])).toEqual(['db', 'execute']);
  });

  it('preserves unknown grouped subcommands in help requests', () => {
    expect(getHelpPath(['help', 'db', 'stats'])).toEqual(['db', 'stats']);
    expect(getHelpPath(['db', 'stats', '--help'])).toEqual(['db', 'stats']);
    expect(getHelpPath(['project', 'missing', '--help'])).toEqual(['project', 'missing']);
  });

  it('returns null when no help was requested', () => {
    expect(getHelpPath([])).toBeNull();
    expect(getHelpPath(['deploy'])).toBeNull();
    expect(getHelpPath(['db', 'status'])).toBeNull();
  });

  it('tracks known and unknown help pages', () => {
    expect(hasHelpPage(['connect'])).toBe(true);
    expect(hasHelpPage(['platform', 'connect'])).toBe(false);
    expect(getHelpPath(['connect', 'https://platform.example.com', '--help'])).toEqual(['connect']);
    expect(hasHelpPage(['deploy'])).toBe(true);
    expect(hasHelpPage(['db', 'execute'])).toBe(true);
    expect(hasHelpPage(['missing'])).toBe(false);
    expect(hasHelpPage(['db', 'missing'])).toBe(false);
  });

  it('resolves github command help requests', () => {
    expect(getHelpPath(['help', 'github'])).toEqual(['github']);
    expect(getHelpPath(['github', '--help'])).toEqual(['github']);
    expect(getHelpPath(['github', '-h'])).toEqual(['github']);
  });

  it('resolves github subcommand help requests', () => {
    expect(getHelpPath(['help', 'github', 'install'])).toEqual(['github', 'install']);
    expect(getHelpPath(['help', 'github', 'installations'])).toEqual(['github', 'installations']);
    expect(getHelpPath(['help', 'github', 'connect'])).toEqual(['github', 'connect']);
    expect(getHelpPath(['github', 'connect', '--help'])).toEqual(['github', 'connect']);
    expect(getHelpPath(['github', 'status', '--help'])).toEqual(['github', 'status']);
  });

  it('tracks known github help pages', () => {
    expect(hasHelpPage(['github'])).toBe(true);
    expect(hasHelpPage(['github', 'install'])).toBe(true);
    expect(hasHelpPage(['github', 'installations'])).toBe(true);
    expect(hasHelpPage(['github', 'connect'])).toBe(true);
    expect(hasHelpPage(['github', 'status'])).toBe(true);
    expect(hasHelpPage(['github', 'disconnect'])).toBe(true);
    expect(hasHelpPage(['github', 'missing'])).toBe(false);
  });

  it('resolves local resource discovery help and documents JSON output', () => {
    expect(getHelpPath(['info', '--help'])).toEqual(['info']);
    expect(hasHelpPage(['info'])).toBe(true);
    printHelpPage(['info']);
    expect(vi.mocked(note).mock.calls[0]?.[0]).toContain('void info [--json]');
  });

  it('tracks Cloudflare authentication help pages', () => {
    expect(hasHelpPage(['cloudflare'])).toBe(true);
    expect(hasHelpPage(['cloudflare', 'login'])).toBe(true);
    expect(hasHelpPage(['cloudflare', 'status'])).toBe(true);
    expect(hasHelpPage(['cloudflare', 'logout'])).toBe(true);
  });

  it.each(['upgrade', 'repair', 'disable', 'enable'] as const)(
    'prints the correct platform %s usage',
    (command) => {
      printHelpPage(['platform', command]);

      expect(vi.mocked(note).mock.calls[0]?.[0]).toContain(
        `void platform ${command} [id] [--plan]`,
      );
    },
  );
});

describe('rendered help advertises the flags the parser honours', () => {
  it('shows both Git initialization flags on init', () => {
    const page = render(['init']);
    expect(page).toContain('--git');
    expect(page).toContain('--no-git');
  });
  /** The page as handed to clack's `note` (mocked above), ANSI stripped, so an assertion reads like the terminal. */
  function render(path: Array<string>): string {
    vi.mocked(note).mockClear();
    printHelpPage(path);
    const lines = vi.mocked(note).mock.calls.map((call) => String(call[0]));
    // eslint-disable-next-line no-control-regex
    return lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  }

  it('shows --provision on `deploy` with the platform it requires', () => {
    const page = render(['deploy']);
    expect(page).toContain('--provision');
    const line = page.split('\n').find((text) => text.includes('--provision'));
    expect(line).toContain('--platform cloudflare');
  });

  it('lists `db restore` and shows both of its targets', () => {
    expect(getHelpPath(['db', 'restore', '--bookmark', 'x', '--help'])).toEqual(['db', 'restore']);
    expect(render(['db'])).toContain('restore');
    const page = render(['db', 'restore']);
    expect(page).toContain('--bookmark <bookmark>');
    expect(page).toContain('--timestamp <iso-time>');
    expect(page).toContain('--yes');
  });

  it('shows --limit and --project on `email logs`', () => {
    const page = render(['email', 'logs']);

    expect(page).toContain('--limit <n>');
    expect(page).toContain('--project <name>');
  });

  it('states plain limits for remote studio and purge-cache', () => {
    const studio = render(['db', 'studio']);
    expect(studio).not.toContain('not yet');
    expect(studio).toContain('MySQL');
    expect(render(['db'])).toContain('PostgreSQL/MySQL');
    expect(render(['project', 'purge-cache'])).toContain('Void platform');
  });

  it('describes gen model without a migration or CRUD claim', () => {
    const model = render(['gen', 'model']);
    expect(model).not.toContain('migration');
    expect(model).not.toContain('CRUD');
    // The gen page lists `gen migration` on its own, so check only the CRUD claim there.
    expect(render(['gen'])).not.toContain('CRUD');
  });

  it('describes db push for every database, not only D1', () => {
    expect(render(['db', 'push'])).not.toContain('local D1');
    expect(render(['db'])).not.toContain('local D1');
  });

  it('lists proxy token rotation under platform system with its scope flags', () => {
    expect(render(['platform', 'system'])).toContain('rotate-proxy-tokens');
    const page = render(['platform', 'system', 'rotate-proxy-tokens']);
    expect(page).toContain('--project <value>');
    expect(page).toContain('--all');
    expect(page).toContain('Rotate every project');
    expect(page).toContain('--plan');
  });

  it('still shows --project on the email subcommands that take only that', () => {
    for (const sub of ['usage', 'destinations', 'allow', 'disallow']) {
      const page = render(['email', sub]);
      expect(page).toContain('--project <name>');
      expect(page).not.toContain('--limit');
    }
  });

  it('lists `email alias [name]` and shows both usages with --project and --yes', () => {
    expect(render(['email'])).toContain('alias [name]');
    expect(hasHelpPage(['email', 'alias'])).toBe(true);
    expect(getHelpPath(['email', 'alias', 'short', '--yes', '--help'])).toEqual(['email', 'alias']);

    const page = render(['email', 'alias']);
    expect(page).toContain('void email alias [options]');
    expect(page).toContain('void email alias <name> [options]');
    expect(page).toContain('--project <name>');
    expect(page).toContain('--yes');
    expect(page).toContain('permanent');
    expect(page).not.toContain('--limit');
    expect(page).not.toContain('--platform');
  });

  // `status` / `setup` read the local project + wrangler session, never a Void project,
  // so their pages carry `--platform cloudflare` and no `--project`.
  it('shows --platform cloudflare, and no --project, on `email status` and `email setup`', () => {
    for (const sub of ['status', 'setup']) {
      const page = render(['email', sub]);
      expect(page).toContain(`void email ${sub} --platform cloudflare`);
      expect(page).toContain('--platform cloudflare');
      expect(page).not.toContain('--backend');
      expect(page).not.toContain('--project');
    }
    const group = render(['email']);
    expect(group).toContain('status --platform cloudflare');
    expect(group).toContain('setup --platform cloudflare');
  });

  // The nested `domain` group is the one email command with its own verbs; the
  // group entry is on the email page, and every verb keeps its own page so the
  // printed `void help email domain <command>` hint actually resolves.
  it('lists `email domain` on the email page and resolves the domain help pages', () => {
    const group = render(['email']);
    expect(group).toContain('domain <add|status|list|sync|rotate-secret|remove>');

    expect(hasHelpPage(['email', 'domain'])).toBe(true);
    expect(getHelpPath(['email', 'domain', '--help'])).toEqual(['email', 'domain']);
    const page = render(['email', 'domain']);
    for (const verb of [
      'add <domain>',
      'status <domain>',
      'list',
      'sync <domain>',
      'rotate-secret <domain>',
      'remove <domain>',
    ]) {
      expect(page).toContain(verb);
    }
    expect(page).not.toContain('--subdomain');
    expect(page).toContain('--project <name>');

    for (const verb of ['add', 'status', 'list', 'sync', 'rotate-secret', 'remove']) {
      expect(hasHelpPage(['email', 'domain', verb])).toBe(true);
    }
    expect(render(['email', 'domain', 'add'])).toContain(
      'void email domain add <domain> [options]',
    );
    expect(render(['email', 'domain', 'add'])).not.toContain('--subdomain');
    expect(render(['email', 'domain', 'add'])).toContain('--project <name>');

    const removePage = render(['email', 'domain', 'remove']);
    expect(removePage).not.toContain('--force');
    expect(removePage).toContain('--project <name>');
  });
});
