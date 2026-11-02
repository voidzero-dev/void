import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getHookHandler } from '../helpers/vite-hooks.ts';

// The Cloudflare plugin defu-merges the returned patch over `resolved`, so a key
// can only be removed by mutating `resolved`.
type MockCloudflarePluginConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

type MockCloudflarePlugin = Plugin & {
  api: {
    pluginConfig: MockCloudflarePluginConfig;
  };
};

vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));

const tempDirs: Array<string> = [];

function createProjectRoot(
  voidConfig: Record<string, unknown> = {},
  { usesVoidEmail = true }: { usesVoidEmail?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'void-email-config-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' }, ...voidConfig }),
  );
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  if (usesVoidEmail) {
    // An app that actually sends mail, so `needsEmail` is inferred the way it
    // would be for a real project rather than forced through config.
    writeFileSync(
      join(root, 'routes/api/notify.ts'),
      `
import { sendEmail } from "void/email";

export async function POST() {
  await sendEmail({ to: "a@example.com", subject: "hi", text: "hi" });
  return Response.json({});
}
`,
    );
  } else {
    // An app that never imports `void/email` and drives Cloudflare's email
    // API through its own binding, so `needsEmail` is inferred false.
    writeFileSync(
      join(root, 'routes/api/notify.ts'),
      `
import { env } from "cloudflare:workers";

export async function POST() {
  await env.MAILER.send({});
  return Response.json({});
}
`,
    );
  }
  return root;
}

async function resolveCloudflareConfig(
  root: string,
  resolved: Record<string, unknown>,
  configEnv: import('vite').ConfigEnv,
): Promise<Record<string, unknown>> {
  vi.spyOn(process, 'cwd').mockReturnValue(root);

  const { voidPlugin } = await import('../../src/index.ts');
  const plugins = voidPlugin();

  const envPlugin = plugins.find((plugin) => plugin.name === 'void:env');
  const config = getHookHandler(envPlugin?.config) as (
    config: import('vite').UserConfig,
    env: import('vite').ConfigEnv,
  ) => void;
  config({}, configEnv);

  const cloudflarePlugin = plugins.find(
    (plugin): plugin is MockCloudflarePlugin => plugin.name === 'mock:cloudflare',
  );
  if (!cloudflarePlugin) {
    throw new Error('Expected mocked Cloudflare plugin.');
  }

  return cloudflarePlugin.api.pluginConfig.config(resolved);
}

const SERVE: import('vite').ConfigEnv = { command: 'serve', mode: 'development' };
const BUILD: import('vite').ConfigEnv = { command: 'build', mode: 'production' };

/** A root wrangler.jsonc as `void deploy --platform cloudflare` leaves it. */
function provisionedRootConfig(): Record<string, unknown> {
  return {
    assets: { binding: 'ASSETS' },
    send_email: [{ name: 'SEND_EMAIL' }],
    vars: { __VOID_EMAIL_FROM: 'Acme <noreply@mail.acme.com>' },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('mergeBindings email config (void dev)', () => {
  it('strips send_email under serve so the dev inbox is the only sink', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });
    const resolved = provisionedRootConfig();

    const result = await resolveCloudflareConfig(root, resolved, SERVE);

    expect('send_email' in resolved).toBe(false);
    expect('send_email' in result).toBe(false);
  });

  it('injects __VOID_EMAIL_FROM from void.json email.from under serve', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, SERVE);

    expect((result.vars as Record<string, string>).__VOID_EMAIL_FROM).toBe(
      'Acme <noreply@mail.acme.com>',
    );
  });

  it('does not invent a sender when email.from is unset', async () => {
    const root = createProjectRoot();

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, SERVE);

    expect((result.vars as Record<string, string> | undefined)?.__VOID_EMAIL_FROM).toBeUndefined();
  });

  it('strips send_email under serve even when email.from is unset', async () => {
    const root = createProjectRoot();
    const resolved = { send_email: [{ name: 'SEND_EMAIL' }] };

    const result = await resolveCloudflareConfig(root, resolved, SERVE);

    expect('send_email' in resolved).toBe(false);
    expect('send_email' in result).toBe(false);
  });

  it('leaves a SEND_EMAIL entry alone when the app does not import void/email', async () => {
    const root = createProjectRoot({}, { usesVoidEmail: false });
    const resolved = { send_email: [{ name: 'SEND_EMAIL' }] };

    const result = await resolveCloudflareConfig(root, resolved, SERVE);

    expect(resolved.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect('send_email' in result).toBe(false);
  });

  it('strips only the SEND_EMAIL entry when the app also carries its own binding', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });
    const resolved = {
      ...provisionedRootConfig(),
      send_email: [{ name: 'MAILER' }, { name: 'SEND_EMAIL' }, { name: 'ALERTS' }],
    };

    const result = await resolveCloudflareConfig(root, resolved, SERVE);

    expect(resolved.send_email).toEqual([{ name: 'MAILER' }, { name: 'ALERTS' }]);
    expect('send_email' in result).toBe(false);
  });
});

describe('mergeBindings dev inbox vars (void dev)', () => {
  it('injects the inbox binding var and the dev-trigger token together under serve', async () => {
    const root = createProjectRoot();

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, SERVE);

    const vars = result.vars as Record<string, string>;
    expect(vars.__VOID_EMAIL_DEV_INBOX).toBe('ASSETS');
    const persisted = readFileSync(join(root, '.void', 'dev-trigger-token'), 'utf8').trim();
    expect(persisted.length).toBeGreaterThan(0);
    expect(vars.__VOID_EMAIL_DEV_INBOX_TOKEN).toBe(persisted);
  });

  it('injects neither var when the app does not import void/email', async () => {
    const root = createProjectRoot({}, { usesVoidEmail: false });

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, SERVE);

    const vars = result.vars as Record<string, string> | undefined;
    expect(vars?.__VOID_EMAIL_DEV_INBOX).toBeUndefined();
    expect(vars?.__VOID_EMAIL_DEV_INBOX_TOKEN).toBeUndefined();
  });

  it('injects neither var on build — a production wrangler.json carries no dev token', async () => {
    const root = createProjectRoot();

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, BUILD);

    const vars = result.vars as Record<string, string> | undefined;
    expect(vars?.__VOID_EMAIL_DEV_INBOX).toBeUndefined();
    expect(vars?.__VOID_EMAIL_DEV_INBOX_TOKEN).toBeUndefined();
  });
});

describe('dev-trigger token file mode (inbox credential)', () => {
  const tokenPath = (root: string) => join(root, '.void', 'dev-trigger-token');
  const modeOf = (path: string) => statSync(path).mode & 0o777;

  it.skipIf(process.platform === 'win32')(
    'creates a fresh token file owner-only (0600)',
    async () => {
      const root = createProjectRoot();

      await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, SERVE);

      expect(modeOf(tokenPath(root))).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a pre-existing 0644 token file to 0600 and keeps its value',
    async () => {
      const root = createProjectRoot();
      mkdirSync(join(root, '.void'), { recursive: true });
      writeFileSync(tokenPath(root), 'stable-token\n');
      chmodSync(tokenPath(root), 0o644);
      expect(modeOf(tokenPath(root))).toBe(0o644);

      const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, SERVE);

      expect(modeOf(tokenPath(root))).toBe(0o600);
      // Tightening never rotates: saved curl scripts and the worker keep working.
      expect(readFileSync(tokenPath(root), 'utf8')).toBe('stable-token\n');
      const vars = result.vars as Record<string, string>;
      expect(vars.__VOID_EMAIL_DEV_INBOX_TOKEN).toBe('stable-token');
    },
  );

  it('leaves an already owner-only token file alone', async () => {
    const root = createProjectRoot();
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(tokenPath(root), 'stable-token\n', { mode: 0o600 });
    const before = statSync(tokenPath(root));

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, SERVE);

    // Same inode, same mode, same ctime: no chmod was issued on a file that
    // was already tight, so a read-only or foreign-owned token still loads.
    const after = statSync(tokenPath(root));
    expect(after.mode).toBe(before.mode);
    expect(after.ctimeMs).toBe(before.ctimeMs);
    expect(after.ino).toBe(before.ino);
    const vars = result.vars as Record<string, string>;
    expect(vars.__VOID_EMAIL_DEV_INBOX_TOKEN).toBe('stable-token');
  });
});

describe('mergeBindings email config (build)', () => {
  it('passes a root send_email binding through untouched', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });
    const resolved = provisionedRootConfig();

    const result = await resolveCloudflareConfig(root, resolved, BUILD);

    expect(resolved.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect('send_email' in result).toBe(false);
  });

  it('leaves __VOID_EMAIL_FROM to the root wrangler config on build', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, BUILD);

    expect((result.vars as Record<string, string> | undefined)?.__VOID_EMAIL_FROM).toBeUndefined();
  });
});
