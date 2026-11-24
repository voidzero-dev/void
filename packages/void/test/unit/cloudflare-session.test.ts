import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createBundledCloudflareAuthRunner,
  ensureCloudflareAuthentication,
} from '../../src/cli/cloudflare-auth.ts';
import { runCloudflareCommand } from '../../src/cli/cloudflare-cmd.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as terminalOutput from '../../src/cli/output.ts';

const fixture = vi.hoisted(() => ({ cli: '' }));
vi.mock('../../src/cli/preset.ts', () => ({
  resolveCloudflareOperationArgv: () => [process.execPath, fixture.cli],
}));
const oldSession = {
  loggedIn: true,
  authType: 'OAuth Token',
  email: 'personal@example.test',
  accounts: [{ id: 'individual-id', name: 'Personal account' }],
};
const newSession = {
  loggedIn: true,
  authType: 'OAuth Token',
  email: 'work@example.test',
  accounts: [{ id: 'work-id', name: 'VoidZero' }],
};
type State = {
  session?: typeof oldSession;
  nextLogin: typeof newSession;
  commands: Array<{ type: string; configPath?: string }>;
  credentialStores?: Array<string>;
  failLogin?: boolean;
  badWhoami?: boolean;
};
let root: string;
let output: Array<string>;
let stdinTty: PropertyDescriptor | undefined;
let stdoutTty: PropertyDescriptor | undefined;
const read = (): State => JSON.parse(readFileSync(join(root, 'auth-fixture.json'), 'utf8'));
const write = (state: State) =>
  writeFileSync(join(root, 'auth-fixture.json'), JSON.stringify(state));
const pin =
  '{\n // Existing deployment target must not change on login.\n "account_id": "individual-id", "name": "existing-worker"\n}';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-auth-session-'));
  fixture.cli = join(import.meta.dirname, '../fixtures/cloudflare-auth-cli.mjs');
  write({ session: oldSession, nextLogin: newSession, commands: [] });
  writeFileSync(join(root, 'wrangler.jsonc'), pin);
  for (const key of [
    'CLOUDFLARE_API_TOKEN',
    'CF_API_TOKEN',
    'CLOUDFLARE_API_KEY',
    'CF_API_KEY',
    'CLOUDFLARE_EMAIL',
    'CF_EMAIL',
    'CLOUDFLARE_ACCOUNT_ID',
    'CF_ACCOUNT_ID',
  ]) {
    vi.stubEnv(key, '');
  }
  stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  output = [];
  vi.spyOn(terminalOutput, 'printSuccess').mockImplementation((message) => {
    output.push(message);
  });
  vi.spyOn(console, 'log').mockImplementation((message) => {
    output.push(String(message));
  });
  for (const level of ['info', 'success', 'warn'] as const) {
    vi.spyOn(log, level).mockImplementation((message) => {
      output.push(String(message));
    });
  }
});

afterEach(() => {
  for (const [stream, descriptor] of [
    [process.stdin, stdinTty],
    [process.stdout, stdoutTty],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(stream, 'isTTY', descriptor);
    } else {
      Reflect.deleteProperty(stream, 'isTTY');
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('Cloudflare session switching through the bundled CLI runner', () => {
  it('does not open login in a non-interactive shell', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    await expect(runCloudflareCommand(root, { subcommand: 'login' })).rejects.toThrow(
      'interactive terminal',
    );
    expect(read().commands).toEqual([]);
  });

  it('requires a valid identity response after explicit login', async () => {
    write({ ...read(), badWhoami: true });
    await expect(runCloudflareCommand(root, { subcommand: 'login' })).rejects.toThrow(
      'usable session',
    );
    expect(output.join('\n')).not.toContain('Signed in to Cloudflare');
  });

  it('rejects a global API key pair without printing either value', async () => {
    vi.stubEnv('CF_API_KEY', 'synthetic-global-key');
    vi.stubEnv('CLOUDFLARE_EMAIL', 'credential-email@example.test');
    const error = await runCloudflareCommand(root, { subcommand: 'login' }).catch(
      (error: unknown) => error as Error,
    );
    expect(String(error)).toContain('CF_API_KEY');
    expect(String(error)).toContain('CLOUDFLARE_EMAIL');
    expect(String(error)).not.toContain('synthetic-global-key');
    expect(String(error)).not.toContain('credential-email@example.test');
    expect(read().commands).toEqual([]);
  });

  it('explicit login replaces the old session without retargeting the project', async () => {
    await runCloudflareCommand(root, { subcommand: 'login' });
    expect(read().session?.email).toBe(newSession.email);
    expect(output).toEqual(['Successfully logged in to Cloudflare.']);
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(pin);
    await runCloudflareCommand(root, { subcommand: 'status' });
    expect(output.join('\n')).toContain(newSession.email);
    expect(output.join('\n')).toContain('OAuth Token');
    expect(output.join('\n')).toContain('work-id');
    expect(output.join('\n')).toContain('individual-id');
    expect(read().credentialStores).toEqual(['true', 'true', 'true']);
  });

  it.each(['automatic authentication', 'status'])(
    'reuses the existing cf session for %s',
    async (mode) => {
      if (mode === 'status') {
        await runCloudflareCommand(root, { subcommand: 'status' });
      } else {
        await ensureCloudflareAuthentication({
          interactive: true,
          requireAccounts: true,
          runWrangler: createBundledCloudflareAuthRunner(root),
        });
      }
      expect(read().commands.some((args) => args.type === 'auth.login')).toBe(false);
      expect(read().session).toEqual(oldSession);
    },
  );

  it.each(['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'])(
    'rejects browser login masked by %s without exposing the credential',
    async (name) => {
      vi.stubEnv(name, 'synthetic-secret-never-print');
      const error = await runCloudflareCommand(root, { subcommand: 'login' }).catch(
        (error: unknown) => error as Error,
      );
      expect(String(error)).toContain(name);
      expect(String(error)).not.toContain('synthetic-secret-never-print');
      expect(read().commands).toEqual([]);
    },
  );

  it('keeps the old session when browser login fails', async () => {
    write({ ...read(), failLogin: true });
    await expect(runCloudflareCommand(root, { subcommand: 'login' })).rejects.toThrow(
      'did not complete',
    );
    expect(read().session).toEqual(oldSession);
    expect(output.join('\n')).not.toContain('Signed in to Cloudflare');
  });

  it('status distinguishes token authentication and the pinned account', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-secret-never-print');
    await runCloudflareCommand(root, { subcommand: 'status' });
    expect(output.join('\n')).toContain('User API Token');
    expect(output.join('\n')).toContain('CLOUDFLARE_API_TOKEN');
    expect(output.join('\n')).toContain('wrangler.jsonc');
    expect(output.join('\n')).not.toContain('synthetic-secret-never-print');
  });
});
