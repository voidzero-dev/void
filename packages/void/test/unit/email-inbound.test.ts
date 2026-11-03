import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toSlash } from 'pathslash';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  EMAIL_MAX_RESPONSE_BYTES,
  encodeEmailActions,
  readEmailActions,
} from '../../../platform/src/email-protocol.ts';
import { compileRouteTable } from '../../src/router/compile.ts';
import { compileWorkerEntry } from '../../src/router/compile.ts';
import {
  compileEmailPattern,
  hasEmailHandlers,
  scanEmailHandlersSync,
} from '../../src/router/email.ts';
import * as emailBarrel from '../../src/runtime/email.ts';
import {
  buildReplyMessage,
  createMessageProxy,
  defineEmail,
  enactEmailActions,
  isForwardableEmailMessage,
  MAX_INBOUND_BYTES,
  MAX_INBOUND_HEADERS,
  parseEmail,
  ParseEmailError,
  replyEmail,
  type EmailEnvelope,
} from '../../src/runtime/email/inbound.ts';
import { MAX_MESSAGE_BYTES, MimeError } from '../../src/runtime/email/mime.ts';

/** The one shape message the address rule (`email-validator`) throws; it never echoes the address. */
const INVALID_ADDRESS =
  'address is not a valid email address (ASCII local part and dotted domain, RFC 5322 dot-atom; ' +
  "at most 64 characters before the '@' and 254 in total).";
import { createInboundTestHarness } from '../../src/runtime/email/testing.ts';
import { envContext } from '../../src/runtime/env-raw.ts';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class MockEmailMessage {
    constructor(
      readonly from: string,
      readonly to: string,
      readonly raw: ReadableStream<Uint8Array> | string,
    ) {}
  },
}));

const TMP = join(import.meta.dirname, '.tmp-email-inbound');

function setupRoot(files: Record<string, string>): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'email'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const abs = join(TMP, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return TMP;
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('scanEmailHandlersSync', () => {
  it('returns empty when no email/ files exist', () => {
    const root = setupRoot({});
    const scan = scanEmailHandlersSync(root);
    expect(scan.addresses).toEqual([]);
    expect(scan.defaultHandler).toBeUndefined();
    expect(hasEmailHandlers(scan)).toBe(false);
  });

  it('detects per-address handlers under email/', () => {
    const root = setupRoot({
      'email/support.ts': 'export default () => {}',
      'email/billing.ts': 'export default () => {}',
    });
    const scan = scanEmailHandlersSync(root);
    expect(scan.addresses.map((a) => a.address)).toEqual(['billing', 'support']);
    expect(scan.addresses[0].filePath).toBe('billing.ts');
    expect(hasEmailHandlers(scan)).toBe(true);
  });

  it('detects email/_default.ts as fallback', () => {
    const root = setupRoot({
      'email/support.ts': 'export default () => {}',
      'email/_default.ts': 'export default () => {}',
    });
    const scan = scanEmailHandlersSync(root);
    expect(scan.defaultHandler).toBe('_default.ts');
    expect(scan.addresses.map((a) => a.address)).toEqual(['support']);
  });

  it('lowercases address names for case-insensitive routing', () => {
    const root = setupRoot({
      'email/Support.ts': 'export default () => {}',
    });
    const scan = scanEmailHandlersSync(root);
    expect(scan.addresses[0].address).toBe('support');
  });

  it('ignores nested folders', () => {
    const root = setupRoot({
      'email/sub/nested.ts': 'export default () => {}',
      'email/support.ts': 'export default () => {}',
    });
    const scan = scanEmailHandlersSync(root);
    expect(scan.addresses.map((a) => a.address)).toEqual(['support']);
  });

  it('pins the full six-shape dispatch order', () => {
    const root = setupRoot({
      'email/[user].ts': 'export default () => {}',
      'email/[user]+[tag].ts': 'export default () => {}',
      'email/[user]+vip.ts': 'export default () => {}',
      'email/support.ts': 'export default () => {}',
      'email/support+[tag].ts': 'export default () => {}',
      'email/support+vip.ts': 'export default () => {}',
    });
    const scan = scanEmailHandlersSync(root);
    expect(scan.addresses.map((a) => a.address)).toEqual([
      'support+vip',
      'support+[tag]',
      'support',
      '[user]+vip',
      '[user]+[tag]',
      '[user]',
    ]);
    expect(scan.addresses.map((a) => a.pattern.kind)).toEqual([
      'static-tag',
      'static-tag',
      'static',
      'dynamic-tag',
      'dynamic-tag',
      'dynamic',
    ]);
    // The generated dispatcher returns on the first regex that matches, so
    // the exact handler must be the first one that matches `support+vip`.
    const first = scan.addresses.find((a) =>
      new RegExp(a.pattern.regexSource, 'i').test('support+vip'),
    );
    expect(first?.address).toBe('support+vip');
  });

  it('skips files with invalid pattern shapes', () => {
    const root = setupRoot({
      'email/support+ticket+extra.ts': 'export default () => {}', // two `+`
      'email/Bad Name.ts': 'export default () => {}', // space
      'email/[bad-name].ts': 'export default () => {}', // hyphen in param
      'email/ok.ts': 'export default () => {}',
    });
    const scan = scanEmailHandlersSync(root);
    expect(scan.addresses.map((a) => a.address)).toEqual(['ok']);
  });

  it('rejects a second _default.<ext> file instead of letting glob order pick one', () => {
    const root = setupRoot({
      'email/_default.ts': 'export default () => {}',
      'email/_default.js': 'export default () => {}',
    });
    // Glob order is readdir order, so either file may be reported as the
    // "second" one — the error must name both regardless.
    expect(() => scanEmailHandlersSync(root)).toThrow(/is a second default handler next to/);
    expect(() => scanEmailHandlersSync(root)).toThrow(/"_default\.ts"/);
    expect(() => scanEmailHandlersSync(root)).toThrow(/"_default\.js"/);
    expect(() => scanEmailHandlersSync(root)).toThrow(/keep exactly one email\/_default\.\* file/);
  });

  it('matches _default exactly: _Default.ts and _default.test.ts are private helpers, not a collision', () => {
    const root = setupRoot({
      'email/_default.mjs': 'export default () => {}',
      'email/_Default.ts': 'export default () => {}',
      'email/_default.test.ts': 'export default () => {}',
    });
    const scan = scanEmailHandlersSync(root);
    expect(scan.defaultHandler).toBe('_default.mjs');
    expect(scan.addresses).toEqual([]);
  });
});

describe('compileEmailPattern', () => {
  it('compiles static address', () => {
    expect(compileEmailPattern('support')).toEqual({
      kind: 'static',
      regexSource: '^support$',
      paramNames: [],
    });
  });

  it('compiles static + tag', () => {
    expect(compileEmailPattern('support+[ticket]')).toEqual({
      kind: 'static-tag',
      regexSource: '^support\\+([^+@]+)$',
      paramNames: ['ticket'],
    });
  });

  it('compiles dynamic', () => {
    expect(compileEmailPattern('[user]')).toEqual({
      kind: 'dynamic',
      regexSource: '^([^+@]+)$',
      paramNames: ['user'],
    });
  });

  it('compiles dynamic + tag', () => {
    expect(compileEmailPattern('[user]+[tag]')).toEqual({
      kind: 'dynamic-tag',
      regexSource: '^([^+@]+)\\+([^+@]+)$',
      paramNames: ['user', 'tag'],
    });
  });

  it('escapes literal dots', () => {
    expect(compileEmailPattern('alerts.ops')).toEqual({
      kind: 'static',
      regexSource: '^alerts\\.ops$',
      paramNames: [],
    });
  });

  it('returns null for too many `+` separators', () => {
    expect(compileEmailPattern('a+b+c')).toBeNull();
  });

  it('returns null for invalid literal chars', () => {
    expect(compileEmailPattern('hello world')).toBeNull();
  });

  it('lowercases uppercase basenames before compilation', () => {
    // Patterns are lowercased to match the lowercased recipient — uppercase
    // in the filename is fine, just normalized.
    expect(compileEmailPattern('[Foo]')?.paramNames).toEqual(['foo']);
    expect(compileEmailPattern('Support')?.regexSource).toBe('^support$');
  });

  it('returns null for invalid param shapes', () => {
    expect(compileEmailPattern('[1abc]')).toBeNull(); // starts with digit
    expect(compileEmailPattern('[]')).toBeNull(); // empty
  });
});

describe('parseEmail', () => {
  it('parses a minimal RFC 5322 message via postal-mime', async () => {
    const raw =
      'From: a@x.dev\r\n' +
      'To: b@y.dev\r\n' +
      'Subject: Hello\r\n' +
      'Content-Type: text/plain; charset=UTF-8\r\n' +
      '\r\n' +
      'Hi there\r\n';
    const message = {
      from: 'a@x.dev',
      to: 'b@y.dev',
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(raw));
          controller.close();
        },
      }),
    } as unknown as ForwardableEmailMessage;
    const parsed = await parseEmail(message);
    expect(parsed.subject).toBe('Hello');
    expect(parsed.from?.address).toBe('a@x.dev');
    expect(parsed.text?.trim()).toBe('Hi there');
  });

  it('rejects messages over the size cap before reading the stream', async () => {
    const message = {
      from: 'a@x.dev',
      to: 'b@y.dev',
      rawSize: 11 * 1024 * 1024,
      raw: new ReadableStream(),
    } as unknown as ForwardableEmailMessage;
    await expect(parseEmail(message)).rejects.toThrow(/exceeds maximum/);
  });
});

const COMPILE_OPTIONS = {
  honoPath: 'hono',
  honoRoutePath: 'hono/route',
  runtimeEnvPath: 'void/_env',
  projectRoot: '/project',
  homeDir: '/home/test',
  reactRefresh: false,
  auth: null,
  nodeTarget: false,
  emailDir: '/e',
};

/** A route table whose only content is `email`, with handlers under `/e`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compile(email: any): string {
  return compileRouteTable(
    {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
      email,
    },
    '/r',
    '/m',
    '/j',
    '/q',
    null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    COMPILE_OPTIONS as any,
  );
}

describe('compileRouteTable (email)', () => {
  it('emits __emailHandler with _default only', () => {
    const code = compile({ addresses: [], defaultHandler: '_default.ts' });
    expect(code).toContain('export async function __emailHandler');
    expect(code).toContain('"/e/_default.ts"');
    expect(code).toContain('__emailDefault');
  });

  it('omits the email block entirely when no handlers exist', () => {
    const code = compile({ addresses: [] });
    expect(code).not.toContain('__emailHandler');
  });
});

/** Executes the generated `__emailHandler` instead of asserting on its source. */
function buildEmailDispatcher(
  code: string,
  modules: Record<string, { default: unknown }>,
): (message: unknown, env: unknown, ctx: unknown, opts?: { slug?: string }) => Promise<unknown> {
  const start = code.indexOf('const __email');
  const fnStart = code.indexOf('export async function __emailHandler');
  expect(start).toBeGreaterThan(-1);
  expect(fnStart).toBeGreaterThan(start);
  const fnEnd = code.indexOf('\n}\n', fnStart);
  expect(fnEnd).toBeGreaterThan(fnStart);

  const body = code
    .slice(start, fnEnd + 3)
    .replace('export async function __emailHandler', 'async function __emailHandler')
    .replace(/\(\) => import\((".*?")\)/g, '() => __modules[$1]');

  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function('__modules', `${body}\nreturn __emailHandler;`)(modules) as never;
}

describe('generated __emailHandler dispatch (behavioural)', () => {
  const SUPPORT = {
    addresses: [
      {
        address: 'support',
        filePath: 'support.ts',
        pattern: { kind: 'static', regexSource: '^support$', paramNames: [] },
      },
      {
        address: 'support+[ticket]',
        filePath: 'support+[ticket].ts',
        pattern: {
          kind: 'dynamic-tag',
          regexSource: '^support\\+([^+@]+)$',
          paramNames: ['ticket'],
        },
      },
    ],
    defaultHandler: undefined,
  };

  it('routes a platform recipient to its handler after createMessageProxy strips the slug', async () => {
    const calls: Array<{ to: string; params: unknown }> = [];
    const dispatch = buildEmailDispatcher(compile(SUPPORT), {
      '/e/support.ts': {
        default: (
          message: { to: string },
          _env: unknown,
          _ctx: unknown,
          info: { params: unknown },
        ) => {
          calls.push({ to: message.to, params: info.params });
        },
      },
      '/e/support+[ticket].ts': { default: () => calls.push({ to: 'WRONG', params: null }) },
    });

    // The wire recipient the platform delivers, for project slug `acme`.
    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+support@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );

    // The user-visible address has the slug removed - that is the DX contract.
    expect(message.to).toBe('support@mail.void.cloud');

    await dispatch(message, {}, {}, { slug: 'acme' });

    expect(calls).toEqual([{ to: 'support@mail.void.cloud', params: {} }]);
  });

  it('captures the tag parameter from the wire recipient, not the stripped one', async () => {
    const seen: Array<unknown> = [];
    const dispatch = buildEmailDispatcher(compile(SUPPORT), {
      '/e/support.ts': { default: () => seen.push('static') },
      '/e/support+[ticket].ts': {
        default: (_m: unknown, _e: unknown, _c: unknown, info: { params: unknown }) =>
          seen.push(info.params),
      },
    });

    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+support+T-42@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );

    await dispatch(message, {}, {}, { slug: 'acme' });

    expect(seen).toEqual([{ ticket: 'T-42' }]);
  });

  it('matches the full local part when the recipient carries no <slug>+ prefix', async () => {
    // Own-account delivery: Cloudflare hands the worker the address the
    // handler author wrote, with no platform slug in front of it. Nothing
    // was stripped, so nothing is stripped again — `support@` is `support`.
    const hits: Array<string> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[ticket].ts': { default: () => hits.push('ticket') },
      '/e/_default.ts': { default: () => hits.push('default') },
    });

    const { message } = createMessageProxy({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    });

    await dispatch(message, {}, {});

    expect(hits).toEqual(['support']);
  });

  it('keeps the tag of an unprefixed recipient: support+T-42@zone reaches support+[ticket]', async () => {
    // The flagship own-account case. The first `+` here belongs to the
    // TAG, not to a platform slug; stripping through it (the platform rule)
    // would leave `T-42`, which matches nothing, and the mail would land in
    // `_default`. Case is preserved in the captured param.
    const seen: Array<unknown> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => seen.push('static') },
      '/e/support+[ticket].ts': {
        default: (_m: unknown, _e: unknown, _c: unknown, info: { params: unknown }) =>
          seen.push(info.params),
      },
      '/e/_default.ts': { default: () => seen.push('default') },
    });

    const { message } = createMessageProxy({
      from: 'sender@example.com',
      to: 'support+T-42@mail.acme.com',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    });

    await dispatch(message, {}, {});

    expect(seen).toEqual([{ ticket: 'T-42' }]);
  });

  it('runs a verified custom-domain recipient in no-prefix mode even when a slug is passed', async () => {
    // A verified receipt carries `viaDomain` and no `<slug>+` prefix. A platform
    // deployment still injects `__VOID_PROJECT_SLUG`, and the generated
    // handleEmail suppresses it for this lane — and createMessageProxy
    // itself ignores a slug passed alongside viaDomain, so a slug equal to
    // the local-part prefix cannot strip `support+` off the address either.
    const seen: Array<unknown> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => seen.push('static') },
      '/e/support+[ticket].ts': {
        default: (_m: unknown, _e: unknown, _c: unknown, info: { params: unknown }) =>
          seen.push(info.params),
      },
      '/e/_default.ts': { default: () => seen.push('default') },
    });

    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'support+T-42@acme.com',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
        viaDomain: 'acme.com',
      },
      { slug: 'support' },
    );

    // Unstripped: the address IS the one the handler author wrote, and no
    // wire-form `__voidPlatformTo` was preserved because nothing was stripped.
    expect(message.to).toBe('support+T-42@acme.com');
    expect((message as { __voidPlatformTo?: string }).__voidPlatformTo).toBeUndefined();
    expect((message as { __voidRelayDomain?: string }).__voidRelayDomain).toBe('acme.com');

    await dispatch(message, {}, {}, { slug: undefined });

    expect(seen).toEqual([{ ticket: 'T-42' }]);
  });

  it('routes an unprefixed recipient nothing matches to _default', async () => {
    const hits: Array<string> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[ticket].ts': { default: () => hits.push('ticket') },
      '/e/_default.ts': { default: () => hits.push('default') },
    });

    const { message } = createMessageProxy({
      from: 'sender@example.com',
      to: 'billing@mail.acme.com',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    });

    await dispatch(message, {}, {});

    expect(hits).toEqual(['default']);
  });

  it('still strips the platform prefix when a slug was removed and no tag follows', async () => {
    // `<slug>+@<domain>` with the slug injected: the prefix is recorded as
    // `__voidPlatformTo`, the tag after it is empty, and the empty string
    // must fall through to `_default` rather than match `support`.
    const hits: Array<string> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[ticket].ts': { default: () => hits.push('ticket') },
      '/e/_default.ts': { default: () => hits.push('default') },
    });

    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );

    await dispatch(message, {}, {}, { slug: 'acme' });

    expect(hits).toEqual(['default']);
  });

  it('reads a bare <slug>@<domain> on the platform as an EMPTY tag, never as the slug itself', async () => {
    // The platform router forwards a `+`-less recipient (the bare project address) with the
    // slug configured but nothing to strip, so `createMessageProxy` records no
    // `__voidPlatformTo`. Keyed on the marker, the dispatcher would match the full local part
    // and hand `email/[user].ts` `user = acme`; keyed on the configured slug, it is `_default`.
    const hits: Array<string> = [];
    const withDynamic = {
      addresses: [
        ...SUPPORT.addresses,
        {
          address: '[user]',
          filePath: '[user].ts',
          pattern: { kind: 'dynamic', regexSource: '^([^+@]+)$', paramNames: ['user'] },
        },
      ],
      defaultHandler: '_default.ts',
    };
    const modules = {
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[ticket].ts': { default: () => hits.push('ticket') },
      '/e/[user].ts': {
        default: (_m: unknown, _e: unknown, _c: unknown, info: { params: { user: string } }) =>
          hits.push(`user=${info.params.user}`),
      },
      '/e/_default.ts': { default: () => hits.push('default') },
    };
    const dispatch = buildEmailDispatcher(compile(withDynamic), modules);
    const bare = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    ).message;
    expect((bare as { __voidPlatformTo?: string }).__voidPlatformTo).toBeUndefined();

    await dispatch(bare, {}, {}, { slug: 'acme' });
    expect(hits).toEqual(['default']);

    // And with no `_default`, the bare address is rejected rather than routed to `[user]`.
    const rejections: Array<string> = [];
    const strict = buildEmailDispatcher(
      compile({ ...withDynamic, defaultHandler: undefined }),
      modules,
    );
    (bare as { setReject: (reason: string) => void }).setReject = (reason) => {
      rejections.push(reason);
    };
    hits.length = 0;
    await strict(bare, {}, {}, { slug: 'acme' });
    expect(hits).toEqual([]);
    expect(rejections).toHaveLength(1);

    // Own account (no slug configured): `acme@` IS the local part, so `[user]` gets it.
    hits.length = 0;
    await dispatch(
      createMessageProxy({
        from: 'sender@example.com',
        to: 'acme@mail.acme.com',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      }).message,
      {},
      {},
    );
    expect(hits).toEqual(['user=acme']);
  });

  it('rejects an unmatched recipient when the app has no _default handler', async () => {
    const dispatch = buildEmailDispatcher(compile(SUPPORT), {
      '/e/support.ts': { default: () => undefined },
      '/e/support+[ticket].ts': { default: () => undefined },
    });

    const rejections: Array<string> = [];
    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+billing@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );
    (message as { setReject: (reason: string) => void }).setReject = (reason) => {
      rejections.push(reason);
    };

    await dispatch(message, {}, {}, { slug: 'acme' });

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain('no handler matched recipient');
  });

  it('runs the exact-tag handler for support+vip@ when a capturing sibling exists (real scan)', async () => {
    // Scanner → codegen → dispatch, end to end. The hand-built scans above
    // fix their own order; this one takes the order `scanEmailHandlersSync`
    // produces, which is the only thing the generated loop relies on.
    const root = setupRoot({
      'email/[user].ts': 'export default () => {}',
      'email/[user]+[tag].ts': 'export default () => {}',
      'email/[user]+vip.ts': 'export default () => {}',
      'email/support.ts': 'export default () => {}',
      'email/support+[tag].ts': 'export default () => {}',
      'email/support+vip.ts': 'export default () => {}',
    });
    const scan = scanEmailHandlersSync(root);
    const hits: Array<string> = [];
    const dispatch = buildEmailDispatcher(compile(scan), {
      '/e/[user].ts': { default: () => hits.push('[user]') },
      '/e/[user]+[tag].ts': { default: () => hits.push('[user]+[tag]') },
      '/e/[user]+vip.ts': { default: () => hits.push('[user]+vip') },
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[tag].ts': { default: () => hits.push('support+[tag]') },
      '/e/support+vip.ts': { default: () => hits.push('support+vip') },
    });

    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+support+vip@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );
    await dispatch(message, {}, {}, { slug: 'acme' });
    expect(hits).toEqual(['support+vip']);

    const { message: other } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+support+T-42@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );
    await dispatch(other, {}, {}, { slug: 'acme' });
    expect(hits).toEqual(['support+vip', 'support+[tag]']);
  });
});

describe('compileWorkerEntry (email)', () => {
  it('emits the native event gate and authenticated receipt path when hasEmail is true', () => {
    const code = compileWorkerEntry({ hasEmail: true });
    expect(code).toContain(', __emailHandler');
    expect(code).toContain('async email(message)');
    expect(code).toContain(
      'this.env.__VOID_EMAIL_DEPLOYMENT_ID || !__isForwardableEmailMessage(message)',
    );
    expect(code).not.toContain('async email(envelope)');
    expect(code).toContain('emailReceipt: __handleEmailReceipt');
    expect(code).toContain('await __verifyEmailReceiptThroughProxy(');
    expect(code).toContain('await __readEmailEnvelope(request.body)');
    expect(code).toContain('async function handleEmail');
    expect(code).toContain('from "void/_email-protocol"');
    expect(code).not.toContain('from "@void/platform/email-protocol"');
  });

  it('omits the email export when hasEmail is false', () => {
    const code = compileWorkerEntry({ hasEmail: false });
    expect(code).not.toContain('handleEmail');
    expect(code).not.toContain('__emailHandler');
  });

  it('co-exists with queue export when both present', () => {
    const code = compileWorkerEntry({ hasQueues: true, hasEmail: true });
    expect(code).toContain('async queue(batch) { return __voidQueue(batch, this.env, this.ctx); }');
    expect(code).toContain('async email(message)');
  });

  it('rejects envelope RPC and managed calls but accepts a native email event', async () => {
    const code = compileWorkerEntry({ hasEmail: true });
    const method = code.match(/ {2}async email\(message\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(method).toBeDefined();
    const handleEmail = vi.fn(async () => [{ type: 'reject', reason: 'test' }]);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const entryEmail = new Function(
      '__isForwardableEmailMessage',
      'handleEmail',
      `return ({${method}}).email;`,
    )(isForwardableEmailMessage, handleEmail) as (
      this: { env: Record<string, string>; ctx: object },
      message: unknown,
    ) => Promise<void>;
    const envelope = { from: 'sender@example.com', to: 'app@example.com', raw: new Uint8Array() };
    await expect(entryEmail.call({ env: {}, ctx: {} }, envelope)).rejects.toThrow(
      'Native email event required',
    );
    expect(handleEmail).not.toHaveBeenCalled();

    const native = { ...envelope, setReject() {}, async forward() {}, async reply() {} };
    await expect(
      entryEmail.call({ env: { __VOID_EMAIL_DEPLOYMENT_ID: 'deploy_1' }, ctx: {} }, native),
    ).rejects.toThrow('Native email event required');
    expect(handleEmail).not.toHaveBeenCalled();
    await expect(entryEmail.call({ env: {}, ctx: {} }, native)).resolves.toBeUndefined();
    expect(handleEmail).toHaveBeenCalledOnce();
    expect(handleEmail).toHaveBeenCalledWith(native, {}, {});
  });
});

describe('createInboundTestHarness', () => {
  it('routes to a static handler and passes empty params', async () => {
    let receivedInfo: { params: Record<string, string> } | undefined;
    const support = vi.fn(
      async (
        _m: ForwardableEmailMessage,
        _e: unknown,
        _c: ExecutionContext,
        info?: { params: Record<string, string> },
      ) => {
        receivedInfo = info;
      },
    );
    const harness = createInboundTestHarness({ routes: { support } });
    // Production: every recipient is `<slug>+<tag>@mail.void.cloud`; the
    // dispatcher strips through the first `+` before matching, so the
    // handler-side tag is `support`. Tests mirror the wire format.
    const result = await harness.deliver({ from: 'a@x.dev', to: 'myslug+support@app.dev' });
    expect(result.handler).toBe('support');
    expect(result.params).toEqual({});
    expect(support).toHaveBeenCalledTimes(1);
    expect(receivedInfo?.params).toEqual({});
  });

  it('routes to static + tag and extracts the tag param', async () => {
    const handler = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { 'support+[ticket]': handler } });
    const result = await harness.deliver({
      from: 'u@x.dev',
      to: 'myslug+support+abc-123@app.dev',
    });
    expect(result.handler).toBe('support+[ticket]');
    expect(result.params).toEqual({ ticket: 'abc-123' });
  });

  it('routes to dynamic + tag and extracts both params', async () => {
    const handler = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { '[user]+[tag]': handler } });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+alice+welcome@app.dev' });
    expect(result.params).toEqual({ user: 'alice', tag: 'welcome' });
  });

  it('prefers static-tag over static and dynamic', async () => {
    const staticTag = vi.fn(async () => {});
    const staticHandler = vi.fn(async () => {});
    const dynamic = vi.fn(async () => {});
    const harness = createInboundTestHarness({
      routes: {
        'support+[ticket]': staticTag,
        support: staticHandler,
        '[user]': dynamic,
      },
    });
    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support+1@app.dev' });
    expect(staticTag).toHaveBeenCalled();
    expect(staticHandler).not.toHaveBeenCalled();
    expect(dynamic).not.toHaveBeenCalled();

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev' });
    expect(staticHandler).toHaveBeenCalled();

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+random@app.dev' });
    expect(dynamic).toHaveBeenCalled();
  });

  it('prefers an exact tag over a captured tag of the same shape', async () => {
    const exact = vi.fn(async () => {});
    const captured = vi.fn(async () => {});
    // Keys are declared capture-first on purpose: object order must not
    // decide, and neither may the alphabetical `[` < `v` tie-break.
    const harness = createInboundTestHarness({
      routes: { 'support+[tag]': captured, 'support+vip': exact },
    });

    const vip = await harness.deliver({ from: 'u@x.dev', to: 'myslug+support+vip@app.dev' });
    expect(vip.handler).toBe('support+vip');
    expect(vip.params).toEqual({});
    expect(exact).toHaveBeenCalledTimes(1);
    expect(captured).not.toHaveBeenCalled();

    const other = await harness.deliver({ from: 'u@x.dev', to: 'myslug+support+T-42@app.dev' });
    expect(other.handler).toBe('support+[tag]');
    expect(other.params).toEqual({ tag: 'T-42' });
    expect(exact).toHaveBeenCalledTimes(1);
  });

  it('falls through to _default when no per-address pattern matches', async () => {
    const def = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { _default: def } });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'unknown@app.dev' });
    expect(result.handler).toBe('_default');
    expect(def).toHaveBeenCalled();
  });

  it('prefers a matching per-address handler over _default', async () => {
    const def = vi.fn(async () => {});
    const support = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { support, _default: def } });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev' });
    expect(result.handler).toBe('support');
    expect(support).toHaveBeenCalled();
    expect(def).not.toHaveBeenCalled();
  });

  it('returns undefined handler when nothing matches', async () => {
    const harness = createInboundTestHarness({ routes: {} });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'unknown@app.dev' });
    expect(result.handler).toBeUndefined();
  });

  it('setReject is idempotent — subsequent setReject calls are dropped', async () => {
    const handler = defineEmail(async (message) => {
      message.setReject('first reason');
      message.setReject('second reason ignored');
    });
    const harness = createInboundTestHarness({ routes: { _default: handler } });
    await harness.deliver({ from: 'u@x.dev', to: 'anything@app.dev' });
    expect(harness.rejects).toEqual(['first reason']);
  });

  it('throws on invalid route key', () => {
    expect(() => createInboundTestHarness({ routes: { 'a+b+c': async () => {} } })).toThrow(
      /not a valid email pattern/,
    );
  });

  it('matches the recipient case-insensitively', async () => {
    const handler = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { support: handler } });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'MYSLUG+SUPPORT@APP.DEV' });
    expect(result.handler).toBe('support');
  });

  // The codegen twin is 'captures the tag parameter from the wire recipient,
  // not the stripped one'; the two must agree.
  it('preserves the case of a captured tag, like the generated dispatcher', async () => {
    let seen: unknown;
    const harness = createInboundTestHarness({
      routes: {
        'support+[ticket]': async (
          _message: unknown,
          _env: unknown,
          _ctx: unknown,
          info?: { params: Record<string, string> },
        ) => {
          seen = info?.params;
        },
      },
    });

    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+support+T-42@app.dev' });

    expect(result.handler).toBe('support+[ticket]');
    expect(result.params).toEqual({ ticket: 'T-42' });
    expect(seen).toEqual({ ticket: 'T-42' });
  });
});

describe('harness enforces the proxy action bounds, like production', () => {
  // The handler runs against production's own `createMessageProxy`, so the
  // harness throws the same error (class, code, message) at the same call.
  function harnessFor(handler: Parameters<typeof defineEmail>[0]) {
    return createInboundTestHarness({ routes: { _default: defineEmail(handler) } });
  }
  const DELIVERY = { from: 'u@x.dev', to: 'myslug+anything@app.dev' };

  it('throws the proxy error on the 101st queued action, and keeps the 100', async () => {
    let thrown: unknown;
    const harness = harnessFor(async (message) => {
      for (let i = 0; i < 100; i++) {
        await message.forward(`box${i}@example.com`);
      }
      try {
        await message.forward('overflow@example.com');
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('MIME_ERROR');
    expect((thrown as MimeError).message).toBe(
      'email: handler queued more than 100 actions for one message.',
    );
    expect(harness.forwards).toHaveLength(100);
    expect(harness.forwards[99]).toEqual({ to: 'box99@example.com' });
  });

  it('refuses a forward header record with a CRLF in a value at the call, recording nothing for it', async () => {
    let thrown: unknown;
    const harness = harnessFor(async (message) => {
      await message.forward('first@example.com');
      try {
        await message.forward('archive@example.com', {
          'X-Trace': 'abc\r\nBcc: leak@evil.test',
        } as unknown as Headers);
      } catch (e) {
        thrown = e;
      }
      // A record that `new Headers()` accepts is recorded, and the capture
      // exposes it as the `Headers` its type declares.
      await message.forward('archive@example.com', {
        'X-Forwarded-By': 'void-test',
      } as unknown as Headers);
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('MIME_ERROR');
    expect((thrown as MimeError).message).toMatch(/^forward: invalid header/);
    expect(harness.forwards.map((f) => f.to)).toEqual(['first@example.com', 'archive@example.com']);
    expect(harness.forwards[0].headers).toBeUndefined();
    expect(harness.forwards[1].headers).toBeInstanceOf(Headers);
    expect(harness.forwards[1].headers?.get('X-Forwarded-By')).toBe('void-test');
  });

  it('records nothing from a handler that throws, like production', async () => {
    const harness = harnessFor(async (message) => {
      await message.forward('ops@x.dev');
      throw new Error('boom');
    });
    await expect(harness.deliver(DELIVERY)).rejects.toThrow(/boom/);
    expect(harness.forwards).toEqual([]);
    expect(harness.deliveries).toEqual([]);
  });
});

describe('harness rejects an unmatched delivery, like production', () => {
  // The generated dispatcher calls setReject when nothing matches and there
  // is no _default, so the sender gets an NDR; the harness mirrors it.
  it('records the reject when nothing matches and there is no _default', async () => {
    const harness = createInboundTestHarness({ routes: { 'support+[ticket]': async () => {} } });

    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+billing@app.dev' });

    expect(result.handler).toBeUndefined();
    expect(harness.rejects).toHaveLength(1);
    // The reason must match the dispatcher's byte for byte — it reaches the
    // sender's DSN. `__to` is the WIRE address, case preserved.
    expect(harness.rejects[0]).toBe(
      'no handler matched recipient "myslug+billing@app.dev" — add email/_default.ts to handle unmatched mail',
    );
  });

  it('uses the wire address with its original case in the reason', async () => {
    const harness = createInboundTestHarness({ routes: { 'support+[ticket]': async () => {} } });

    await harness.deliver({ from: 'u@x.dev', to: 'MySlug+Billing@App.Dev' });

    expect(harness.rejects[0]).toContain('"MySlug+Billing@App.Dev"');
  });

  it('does not reject when _default handles the unmatched message', async () => {
    const handler = vi.fn(async () => {});
    const harness = createInboundTestHarness({
      routes: { 'support+[ticket]': async () => {}, _default: handler },
    });

    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+billing@app.dev' });

    expect(result.handler).toBe('_default');
    expect(harness.rejects).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects a recipient with no tag when there is no _default', async () => {
    const harness = createInboundTestHarness({ routes: { 'support+[ticket]': async () => {} } });

    await harness.deliver({ from: 'u@x.dev', to: 'myslug@app.dev' });

    expect(harness.rejects).toHaveLength(1);
    expect(harness.rejects[0]).toContain('"myslug@app.dev"');
  });

  it('`slug: null` matches the full local part, like a worker on your own Cloudflare account', async () => {
    // Own-account deploys carry no platform prefix: `support@mail.acme.com` reaches
    // `support`, and the first `+` belongs to the TAG. The default harness would read
    // `support` as a slug and land a plain `support@` in `_default`.
    const seen: Array<string> = [];
    const harness = createInboundTestHarness({
      slug: null,
      routes: {
        support: async () => {
          seen.push('support');
        },
        'support+[ticket]': async (_m, _e, _c, info) => {
          seen.push(`ticket=${info?.params.ticket}`);
        },
        _default: async () => {
          seen.push('default');
        },
      },
    });

    const plain = await harness.deliver({ from: 'u@x.dev', to: 'support@mail.acme.com' });
    expect(plain.handler).toBe('support');
    const tagged = await harness.deliver({ from: 'u@x.dev', to: 'support+T-42@mail.acme.com' });
    expect(tagged.handler).toBe('support+[ticket]');
    expect(tagged.params).toEqual({ ticket: 'T-42' });
    expect(seen).toEqual(['support', 'ticket=T-42']);
    // Nothing was stripped from what the handler sees either.
    const other = await harness.deliver({ from: 'u@x.dev', to: 'billing@mail.acme.com' });
    expect(other.handler).toBe('_default');
  });
});

describe('harness headers match the bytes, like production', () => {
  // In production `buildEnvelope` copies every wire header verbatim, so
  // `message.headers` and `message.raw` agree, and `replyEmail` threads off them.
  it('exposes the generated Message-ID, so replyEmail threads', async () => {
    let seen: string | null = null;
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message: { headers: Headers }) => {
          seen = message.headers.get('Message-ID');
        },
      },
    });

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev', subject: 'Help' });

    expect(seen).toMatch(/^<.+@.+>$/);
  });

  it('exposes headers from a caller-supplied raw MIME', async () => {
    // The `raw:` override hands the harness exact wire bytes.
    const raw = [
      'Message-ID: <fromraw@remote.dev>',
      'From: u@x.dev',
      'To: myslug+support@app.dev',
      'Subject: Help',
      'X-Custom: kept',
      '',
      'body',
      '',
    ].join('\r\n');
    let seen: Record<string, string | null> = {};
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message: { headers: Headers }) => {
          seen = {
            id: message.headers.get('Message-ID'),
            custom: message.headers.get('X-Custom'),
          };
        },
      },
    });

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev', raw });

    expect(seen.id).toBe('<fromraw@remote.dev>');
    expect(seen.custom).toBe('kept');
  });

  it('exposes Subject the way the wire carries it, not decoded', async () => {
    // `buildMime` RFC 2047-encodes a non-ASCII subject and production hands
    // the handler that encoded form. A handler comparing
    // `message.headers.get('Subject')` — the pattern the guide shows — must
    // see the same string in both places.
    let seen: string | null = null;
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message: { headers: Headers }) => {
          seen = message.headers.get('Subject');
        },
      },
    });

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev', subject: 'café' });

    expect(seen).toBe('=?UTF-8?B?Y2Fmw6k=?=');
  });

  it('lets an explicit input header win over the bytes', async () => {
    let seen: string | null = null;
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message: { headers: Headers }) => {
          seen = message.headers.get('Message-ID');
        },
      },
    });

    await harness.deliver({
      from: 'u@x.dev',
      to: 'myslug+support@app.dev',
      subject: 'Help',
      headers: { 'Message-ID': '<explicit@remote.dev>' },
    });

    expect(seen).toBe('<explicit@remote.dev>');
  });
});

describe('admission checks mirrored from the managed router', () => {
  // `routeInbound` refuses a message over `MAX_INBOUND_BYTES` (from
  // `rawSize`) or with more than `MAX_INBOUND_HEADERS` distinct names before
  // dispatch. Platform lane only — an own-account worker has no router.
  const TO = 'myslug+support@app.dev';
  const HEAD = `From: u@x.dev\r\nTo: ${TO}\r\nSubject: big\r\n\r\n`;

  /** A well-formed text message padded to exactly `total` bytes. */
  function rawOfSize(total: number): Uint8Array {
    const head = new TextEncoder().encode(HEAD);
    const out = new Uint8Array(total);
    out.set(head, 0);
    out.fill(0x61, head.byteLength);
    return out;
  }

  function rawWithHeaderLines(lines: Array<string>): string {
    return `${lines.join('\r\n')}\r\n\r\nbody\r\n`;
  }

  /** `n` distinct names on the wire, `From:` and `To:` among them. */
  function distinctHeaderLines(n: number): Array<string> {
    return [
      'From: u@x.dev',
      `To: ${TO}`,
      ...Array.from({ length: n - 2 }, (_, i) => `h${i.toString(36)}: v`),
    ];
  }

  function forwarding() {
    return vi.fn(async (message: ForwardableEmailMessage) => {
      await message.forward('x@example.com');
    });
  }

  it('rejects a message one byte over the size cap without invoking the handler', async () => {
    const handler = forwarding();
    const harness = createInboundTestHarness({ routes: { _default: handler } });

    const result = await harness.deliver({
      from: 'u@x.dev',
      to: TO,
      raw: rawOfSize(MAX_INBOUND_BYTES + 1),
    });

    expect(handler).not.toHaveBeenCalled();
    // Byte-for-byte the router's reason: `<zone>: ...`, the zone being the
    // recipient's domain.
    expect(harness.rejects).toEqual(['app.dev: message too large (max 10485760 bytes)']);
    expect(harness.forwards).toEqual([]);
    // Recorded like a handler's own `setReject`: unhandled, one delivery.
    expect(result).toEqual({ handler: undefined, params: {} });
    expect(harness.deliveries).toEqual([result]);
  });

  it('admits a message exactly at the size cap', async () => {
    const handler = forwarding();
    const harness = createInboundTestHarness({ routes: { _default: handler } });

    const result = await harness.deliver({
      from: 'u@x.dev',
      to: TO,
      raw: rawOfSize(MAX_INBOUND_BYTES),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.handler).toBe('_default');
    expect(harness.rejects).toEqual([]);
    expect(harness.forwards).toEqual([{ to: 'x@example.com' }]);
  });

  it('a handler that calls parseEmail() on a message at the cap still works', async () => {
    // The router's admission and `parseEmail`'s own guard are both `>`, so
    // the largest message the router dispatches is also one `parseEmail`
    // reads.
    let subject: string | undefined;
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message) => {
          subject = (await parseEmail(message)).subject;
          await message.forward('x@example.com');
        },
      },
    });

    await harness.deliver({ from: 'u@x.dev', to: TO, raw: rawOfSize(MAX_INBOUND_BYTES) });

    expect(subject).toBe('big');
    expect(harness.rejects).toEqual([]);
    expect(harness.forwards).toEqual([{ to: 'x@example.com' }]);
  });

  it('rejects a message with one distinct header over the cap without invoking the handler', async () => {
    const handler = forwarding();
    const harness = createInboundTestHarness({ routes: { _default: handler } });

    const result = await harness.deliver({
      from: 'u@x.dev',
      to: TO,
      raw: rawWithHeaderLines(distinctHeaderLines(MAX_INBOUND_HEADERS + 1)),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(harness.rejects).toEqual(['app.dev: too many headers (max 1024)']);
    expect(harness.forwards).toEqual([]);
    expect(result).toEqual({ handler: undefined, params: {} });
  });

  it('admits a message with exactly the header cap, every header visible', async () => {
    let seen: Headers | undefined;
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message) => {
          seen = message.headers;
        },
      },
    });

    await harness.deliver({
      from: 'u@x.dev',
      to: TO,
      raw: rawWithHeaderLines(distinctHeaderLines(MAX_INBOUND_HEADERS)),
    });

    expect(harness.rejects).toEqual([]);
    expect([...seen!.keys()]).toHaveLength(MAX_INBOUND_HEADERS);
    expect(seen!.get(`h${(MAX_INBOUND_HEADERS - 3).toString(36)}`)).toBe('v');
  });

  it.each([
    [
      'repeated names, which a Headers bag folds into one entry',
      Array.from({ length: MAX_INBOUND_HEADERS + 1 }, () => 'Received: from a hop'),
    ],
    [
      'continuation lines, which belong to the header before them',
      ['Subject: a', ...Array.from({ length: MAX_INBOUND_HEADERS + 1 }, () => ' folded')],
    ],
    [
      'the same name in different case',
      Array.from({ length: MAX_INBOUND_HEADERS + 1 }, (_, i) =>
        i % 2 ? 'x-void: b' : 'X-Void: a',
      ),
    ],
  ])('counts distinct names, like the router: %s do not add up', async (_label, lines) => {
    // The router walks the `Headers` Cloudflare built from the wire, and a
    // `Headers` holds one entry per distinct (case-insensitive) name.
    const handler = forwarding();
    const harness = createInboundTestHarness({ routes: { _default: handler } });

    await harness.deliver({ from: 'u@x.dev', to: TO, raw: rawWithHeaderLines(lines) });

    expect(harness.rejects).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("checks size before headers, in the router's order", async () => {
    // Over both caps at once: the router refuses on `rawSize` before it
    // walks a single header, so that is the reason the sender sees.
    const lines = distinctHeaderLines(MAX_INBOUND_HEADERS + 1);
    const headBytes = new TextEncoder().encode(rawWithHeaderLines(lines));
    const raw = new Uint8Array(MAX_INBOUND_BYTES + 1);
    raw.set(headBytes, 0);
    raw.fill(0x61, headBytes.byteLength);
    const handler = forwarding();
    const harness = createInboundTestHarness({ routes: { _default: handler } });

    await harness.deliver({ from: 'u@x.dev', to: TO, raw });

    expect(harness.rejects).toEqual(['app.dev: message too large (max 10485760 bytes)']);
    expect(handler).not.toHaveBeenCalled();
  });

  it("labels the reason with the recipient's domain, lowercased, like the router's zone", async () => {
    const harness = createInboundTestHarness({ routes: { _default: forwarding() } });

    await harness.deliver({
      from: 'u@x.dev',
      to: 'MySlug+Support@Mail.Void.Cloud',
      raw: rawOfSize(MAX_INBOUND_BYTES + 1),
    });
    await harness.deliver({
      from: 'u@x.dev',
      to: 'no-at-sign',
      raw: rawOfSize(MAX_INBOUND_BYTES + 1),
    });

    expect(harness.rejects).toEqual([
      'mail.void.cloud: message too large (max 10485760 bytes)',
      // The router's own fallback label, for a recipient that names no zone.
      'void email: message too large (max 10485760 bytes)',
    ]);
  });

  it('applies neither check on the own-account lane (`slug: null`)', async () => {
    // There is no router in front of a worker on your own Cloudflare
    // account: Cloudflare hands the handler every message it accepts, so a
    // 10 MiB + 1 forward IS reachable there and the harness must not bounce
    // it. (`parseEmail` keeps its own `MAX_MESSAGE_BYTES` guard.)
    const handler = forwarding();
    const harness = createInboundTestHarness({ slug: null, routes: { _default: handler } });

    await harness.deliver({
      from: 'u@x.dev',
      to: 'support@mail.acme.com',
      raw: rawOfSize(MAX_INBOUND_BYTES + 1),
    });
    await harness.deliver({
      from: 'u@x.dev',
      to: 'support@mail.acme.com',
      raw: rawWithHeaderLines(distinctHeaderLines(MAX_INBOUND_HEADERS + 1)),
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(harness.rejects).toEqual([]);
    expect(harness.forwards).toHaveLength(2);
  });
});

/**
 * Builds a reply in a child Node under the tenant isolate's 128 MB heap cap
 * and reports what it cost there. `headersSource` is a JS expression
 * evaluated in the child, so the fixture is built inside the cap too.
 */
function replyInIsolate(headersSource: string): {
  text: string;
  subject: string;
  ms: number;
  heapDeltaMB: number;
} {
  const inboundModule = pathToFileURL(
    toSlash(join(import.meta.dirname, '../../src/runtime/email/inbound.ts')),
  ).href;
  const child = `
    const { buildReplyMessage, createMessageProxy } = await import(process.argv[1]);
    const headers = ${headersSource};
    const raw = new TextEncoder().encode('body');
    const { message } = createMessageProxy(
      {
        from: 'sender@remote.dev',
        to: 'acme+support@mail.void.cloud',
        headers,
        raw,
        rawSize: raw.length,
      },
      { slug: 'acme' },
    );
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });
    const ms = performance.now() - t0;
    const heapDeltaMB = (process.memoryUsage().heapUsed - heap0) / (1024 * 1024);
    const text = new TextDecoder().decode(reply.raw);
    console.log(JSON.stringify({ text, subject: reply.subject, ms, heapDeltaMB }));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--max-old-space-size=128', '--input-type=module', '-e', child, inboundModule],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
    text: string;
    subject: string;
    ms: number;
    heapDeltaMB: number;
  };
}

describe('reply threading survives a hostile inbound header', () => {
  // A remote sender controls the threaded `Message-ID` and `References`.
  // Threading is best-effort: an unusable value is dropped, the reply still goes.
  const HUGE = 'x'.repeat(1100);

  function inbound(headers: Record<string, string>) {
    const raw = new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
    return createMessageProxy(
      {
        from: 'sender@remote.dev',
        to: 'acme+support@mail.void.cloud',
        headers,
        raw,
        rawSize: raw.length,
      },
      { slug: 'acme' },
    ).message;
  }

  it('drops an unusable Message-ID rather than failing the reply', async () => {
    const message = inbound({ 'message-id': `<${HUGE}@remote.dev>`, subject: 'hi' });

    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });

    const text = new TextDecoder().decode(reply.raw);
    expect(text).toContain('Subject: Re: hi');
    expect(text).not.toContain(HUGE);
    expect(Math.max(...text.split('\r\n').map((l) => l.length))).toBeLessThanOrEqual(998);
  });

  // The line guard measures octets, and the only break it may count on is
  // SP or HTAB — the whitespace `foldHeader` folds at.
  const MESSAGE_ID = '<abc@remote.dev>';

  async function replyText(references: string, messageId = MESSAGE_ID): Promise<string> {
    const message = inbound({ references, 'message-id': messageId, subject: 'hi' });
    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });
    return new TextDecoder().decode(reply.raw);
  }

  function widestLineOctets(text: string): number {
    const encoder = new TextEncoder();
    return text.split('\r\n').reduce((max, line) => Math.max(max, encoder.encode(line).length), 0);
  }

  it('keeps an id that exactly fills the line, and drops one octet more', async () => {
    // `References: ` is 12 octets, so 986 is the widest id one line carries.
    // With no Message-ID to append, the header is that one id, unfolded.
    const atBudget = `<${'x'.repeat(984)}>`;
    const overBudget = `<${'x'.repeat(985)}>`;

    const kept = await replyText(atBudget, '');
    expect(kept).toContain(`References: ${atBudget}\r\n`);
    expect(widestLineOctets(kept)).toBe(998);

    const dropped = await replyText(overBudget, '');
    expect(dropped).not.toContain('References:');
    expect(widestLineOctets(dropped)).toBeLessThanOrEqual(998);
  });

  it('measures an id in UTF-8 octets, not UTF-16 units', async () => {
    // 495 units but 988 octets: a code-unit count would pass it.
    const id = `<${'é'.repeat(493)}>`;
    const text = await replyText(id);
    expect(text).not.toContain(id);
    expect(text).toContain(`References: ${MESSAGE_ID}`);
    expect(widestLineOctets(text)).toBeLessThanOrEqual(998);
  });

  it('counts a surrogate pair as one four-octet code point', async () => {
    // A `Headers` value is a ByteString, so nothing above U+00FF arrives this
    // way in production; the count still has to agree with `TextEncoder`,
    // which is what `buildMime` measures the rendered line with.
    const id = `<${'😀'.repeat(247)}>`; // 496 units, 990 octets
    const headers = new Map([
      ['subject', 'hi'],
      ['message-id', MESSAGE_ID],
      ['references', id],
    ]);
    const message = {
      from: 'sender@remote.dev',
      to: 'support@app.dev',
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    } as unknown as ForwardableEmailMessage;
    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });
    const text = new TextDecoder().decode(reply.raw);
    expect(text).not.toContain(id);
    expect(text).toContain(`References: ${MESSAGE_ID}`);
  });

  it('keeps a multibyte id that fits once encoded', async () => {
    const id = `<${'é'.repeat(492)}>`; // 494 units, 986 octets
    const text = await replyText(id, '');
    expect(text).toContain(`References: ${id}\r\n`);
    expect(widestLineOctets(text)).toBe(998);
  });

  it('does not count whitespace the folder cannot fold at as a break', async () => {
    // `\s` matches NBSP and FF, but RFC 5322 §3.2.2 folds only at SP/HTAB and
    // so does `foldHeader`.
    const id = `<${'x'.repeat(600)}@remote.dev>`;
    for (const separator of [' ', '\f']) {
      const text = await replyText(`${id}${separator}${id}`);
      expect(text).not.toContain(id);
      expect(text).toContain(`References: ${MESSAGE_ID}`);
      expect(widestLineOctets(text)).toBeLessThanOrEqual(998);
    }
  });

  it('answers for a chain of MAX_MESSAGE_BYTES in one pass', async () => {
    // Two-character ids with one over-long id at the very end, so the whole
    // chain is scanned before it is refused.
    const chain = 'ab '.repeat(Math.floor(MAX_MESSAGE_BYTES / 3)) + `<${HUGE}@remote.dev>`;
    const started = performance.now();
    const text = await replyText(chain);
    const elapsed = performance.now() - started;
    expect(text).not.toContain(HUGE);
    expect(text).toContain(`References: ${MESSAGE_ID}`);
    // A gross bound: time stands in for the memory the runner cannot cap.
    expect(elapsed).toBeLessThan(1000);
  });

  // The line guard bounds one id, not the chain, so the chain is bounded at
  // 8192 characters; past that the reply keeps the newest ids whole, the
  // parent's id still last.
  const REFERENCES_BUDGET = 8192;

  /** The `References` value of a rendered reply, unfolded; `undefined` when absent. */
  function referencesOf(text: string): string | undefined {
    const headers = text.split('\r\n\r\n')[0].replace(/\r\n(?=[ \t])/g, '');
    return headers
      .split('\r\n')
      .find((line) => line.startsWith('References: '))
      ?.slice('References: '.length);
  }

  it('threads the newest ids of a chain over the budget, inside a 128 MB heap', () => {
    // A `References` just under the inbound cap, of short ids.
    const result = replyInIsolate(
      `{ references: '<a@b> '.repeat(Math.floor((${MAX_MESSAGE_BYTES} - 200) / 6)).trimEnd(), ` +
        `'message-id': ${JSON.stringify(MESSAGE_ID)}, subject: 'hi' }`,
    );
    expect(result.text).toContain(`In-Reply-To: ${MESSAGE_ID}`);
    const references = referencesOf(result.text);
    expect(references).toBeDefined();
    expect(references!.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    expect(references!.startsWith('<a@b> ')).toBe(true);
    expect(references!.endsWith(` <a@b> ${MESSAGE_ID}`)).toBe(true);
    expect(widestLineOctets(result.text)).toBeLessThanOrEqual(998);
    // The bound leaves room for CI's slower runner.
    expect(result.ms).toBeLessThan(5000);
    expect(result.heapDeltaMB).toBeLessThan(16);
  }, 30_000);

  it('keeps the whole chain at the budget, and drops the oldest id one character over', async () => {
    // 900 eight-character ids and one 75-character first id: 8175 characters,
    // which with the parent's ` <abc@remote.dev>` is the budget exactly.
    const rest = Array.from({ length: 900 }, (_, i) => `<${String(i + 1).padStart(4, '0')}@r>`);
    const oldest = `<${'x'.repeat(71)}@r>`;
    const atBudget = [oldest, ...rest].join(' ');
    expect(atBudget.length + 1 + MESSAGE_ID.length).toBe(REFERENCES_BUDGET);

    const kept = referencesOf(await replyText(atBudget));
    expect(kept).toBe(`${atBudget} ${MESSAGE_ID}`);

    const trimmed = referencesOf(await replyText(`<x${oldest.slice(1)} ${rest.join(' ')}`));
    expect(trimmed).toBe(`${rest.join(' ')} ${MESSAGE_ID}`);
    expect(trimmed!.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
  });

  it('never splits an id at the cut', async () => {
    // Long ids, so the character cut lands inside one: that id goes, whole,
    // and the tail starts on the next boundary.
    const ids = Array.from(
      { length: 200 },
      (_, i) => `<${String(i).padStart(3, '0')}${'y'.repeat(96)}@r>`,
    );
    const references = referencesOf(await replyText(ids.join(' ')));
    expect(references).toBeDefined();
    expect(references!.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    const kept = references!.split(' ');
    expect(kept.at(-1)).toBe(MESSAGE_ID);
    for (const id of kept.slice(0, -1)) {
      expect(ids).toContain(id);
    }
    expect(kept.slice(0, -1)).toEqual(ids.slice(ids.length - (kept.length - 1)));
  });

  it('keeps the newest ids without a usable Message-ID', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `<${String(i).padStart(4, '0')}@r>`);
    const text = await replyText(ids.join(' '), '');
    expect(text).not.toContain('In-Reply-To:');
    const references = referencesOf(text);
    expect(references).toBeDefined();
    expect(references!.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    expect(references).not.toContain('<0000@r>');
    expect(references!.endsWith(' <0999@r>')).toBe(true);
  });

  it('threads the newest ids when the id no line can carry is an old one', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `<${String(i).padStart(4, '0')}@r>`);
    // Oldest: outside the tail, so the tail threads.
    const oldestHuge = referencesOf(await replyText(`<${HUGE}@r> ${ids.join(' ')}`));
    expect(oldestHuge).not.toContain(HUGE);
    expect(oldestHuge!.endsWith(` <0999@r> ${MESSAGE_ID}`)).toBe(true);
    // Newest: inside the tail, so only the parent's id is threaded.
    const newestHuge = referencesOf(await replyText(`${ids.join(' ')} <${HUGE}@r>`));
    expect(newestHuge).toBe(MESSAGE_ID);
  });

  it('keeps the actions queued before a reply to a chain over the budget', async () => {
    // `handleEmail` returns the queue only once the handler resolves, so a
    // reply that threw would take the earlier forward with it.
    const references = '<a@b> '.repeat(Math.floor((MAX_MESSAGE_BYTES - 200) / 6)).trimEnd();
    const raw = new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
    const { message, getActions } = createMessageProxy(
      {
        from: 'sender@remote.dev',
        to: 'acme+support@mail.void.cloud',
        headers: { references, 'message-id': MESSAGE_ID, subject: 'hi' },
        raw,
        rawSize: raw.length,
      },
      { slug: 'acme' },
    );
    const handler = defineEmail(async (m) => {
      await m.forward('archive@acme.dev');
      await replyEmail(m, { text: 'thanks', from: 'acme+noreply@x.dev' });
    });

    await handler(message, {}, {} as ExecutionContext);

    const actions = getActions();
    expect(actions.map((a) => a.type)).toEqual(['forward', 'reply']);
    const reply = actions[1];
    if (reply.type !== 'reply') {
      throw new Error('expected reply action');
    }
    expect(new TextDecoder().decode(reply.raw)).toContain(`In-Reply-To: ${MESSAGE_ID}`);
  });

  describe('a control character in a threading id', () => {
    // `\x01` or DEL pass a WHATWG `Headers`, but an RFC 5322 §3.6.4 `msg-id`
    // admits no control: such an id is dropped on its own, never a throw.
    // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the point
    const rawControl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

    function headersOf(text: string): string {
      return text.slice(0, text.indexOf('\r\n\r\n'));
    }

    it('drops a parent Message-ID carrying one: no In-Reply-To, absent from References, reply still sent', async () => {
      const parent = '<abc\x01def@remote.dev>';
      const text = await replyText('<r1@remote.dev>', parent);
      expect(text).toContain('Subject: Re: hi');
      expect(text).not.toContain('In-Reply-To:');
      expect(referencesOf(text)).toBe('<r1@remote.dev>');
      expect(headersOf(text)).not.toMatch(rawControl);
      // With no chain to thread either, the reply carries no threading at all.
      const bare = await replyText('', parent);
      expect(bare).toContain('Subject: Re: hi');
      expect(bare).not.toContain('In-Reply-To:');
      expect(bare).not.toContain('References:');
    });

    it('drops only the id carrying DEL from a References chain; the rest and the parent stay in order', async () => {
      for (const separator of [' ', '\t']) {
        const chain = ['<r1@remote.dev>', '<r\x7f2@remote.dev>', '<r3@remote.dev>'].join(separator);
        const text = await replyText(chain);
        expect(text).toContain(`In-Reply-To: ${MESSAGE_ID}\r\n`);
        expect(referencesOf(text)).toBe(`<r1@remote.dev> <r3@remote.dev> ${MESSAGE_ID}`);
        expect(headersOf(text)).not.toMatch(rawControl);
      }
    });
  });
});

describe('reply subject survives a hostile inbound header', () => {
  // The default reply subject is decoded from the sender's `Subject`. Like
  // threading it is best-effort: repair what can be repaired, fall back to
  // `Re:` for what cannot, and always send the reply.
  const FROM = 'acme+noreply@x.dev';

  function inbound(subject: string) {
    const raw = new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
    return createMessageProxy(
      {
        from: 'sender@remote.dev',
        to: 'acme+support@mail.void.cloud',
        headers: { subject },
        raw,
        rawSize: raw.length,
      },
      { slug: 'acme' },
    ).message;
  }

  function maxLine(reply: { raw: Uint8Array }): number {
    return Math.max(
      ...new TextDecoder()
        .decode(reply.raw)
        .split('\r\n')
        .map((l) => l.length),
    );
  }

  // RFC 2045 §6.7: a robust decoder keeps a malformed `=` escape as-is.
  it('keeps a malformed Q escape literal instead of decoding half of it', async () => {
    const reply = await buildReplyMessage(inbound('=?UTF-8?Q?bad=0Gsubject?='), {
      text: 'thanks',
      from: FROM,
    });
    expect(reply.subject).toBe('Re: bad=0Gsubject');
  });

  it.each([
    ['a well-formed Q-encoded NUL', '=?UTF-8?Q?bad=00subject?='],
    ['a well-formed Q-encoded LF', '=?UTF-8?Q?bad=0Asubject?='],
    ['a well-formed Q-encoded CR', '=?UTF-8?Q?bad=0Dsubject?='],
    // base64('bad\0subject')
    ['a B-encoded NUL', '=?UTF-8?B?YmFkAHN1YmplY3Q=?='],
  ])('replaces %s with a space rather than failing the reply', async (_label, subject) => {
    const reply = await buildReplyMessage(inbound(subject), { text: 'thanks', from: FROM });
    expect(reply.subject).toBe('Re: bad subject');
  });

  it('falls back to a bare Re: for an ASCII subject no line can hold', async () => {
    const reply = await buildReplyMessage(inbound('x'.repeat(1100)), {
      text: 'thanks',
      from: FROM,
    });
    expect(reply.subject).toBe('Re:');
    expect(maxLine(reply)).toBeLessThanOrEqual(998);
  });

  // The fit check must not over-reject: a non-ASCII subject is chunked
  // into 75-character encoded-words that fold, however long it is.
  it('keeps a long non-ASCII subject, which encodes into foldable words', async () => {
    const subject = 'é'.repeat(600);
    const reply = await buildReplyMessage(inbound(subject), { text: 'thanks', from: FROM });
    expect(reply.subject).toBe(`Re: ${subject}`);
    expect(maxLine(reply)).toBeLessThanOrEqual(998);
  });

  it('still prefixes an ordinary subject', async () => {
    const reply = await buildReplyMessage(inbound('=?UTF-8?Q?good=20subject?='), {
      text: 'thanks',
      from: FROM,
    });
    expect(reply.subject).toBe('Re: good subject');
  });

  it('decodes a subject of MAX_MESSAGE_BYTES of encoded-words one word at a time', async () => {
    // MAX_MESSAGE_BYTES of `=?UTF-8?Q?a?=`: adjacent encoded-words join into
    // one ASCII token no line can carry, so the reply falls back to `Re:`.
    const subject = '=?UTF-8?Q?a?= '.repeat(Math.floor(MAX_MESSAGE_BYTES / 14));
    const reply = await buildReplyMessage(inbound(subject), { text: 'thanks', from: FROM });
    expect(reply.subject).toBe('Re:');
  });

  // ONE encoded-word carrying the whole message: a folded `Subject` arrives
  // (unfolded by `Headers`) as a single Q-word, so the decoder sees all of it.
  it('replies to a single Q-encoded word of MAX_MESSAGE_BYTES inside a 128 MB heap', () => {
    const result = replyInIsolate(
      `{ subject: '=?UTF-8?Q?' + 'a'.repeat(${MAX_MESSAGE_BYTES} - 20) + '?=' }`,
    );
    // The decoded word is one ASCII token no line can carry, so the subject
    // falls back — the same answer the many-word shape gets.
    expect(result.subject).toBe('Re:');
    // The bound leaves room for CI's slower runner.
    expect(result.ms).toBeLessThan(5000);
  }, 30_000);

  // A folded `Subject` reaches the decoder unfolded: `Headers` — Cloudflare's
  // `ForwardableEmailMessage.headers` and the proxy's `new Headers(envelope
  // .headers)` alike — rejects CR and LF, so what the payload can carry from a
  // fold is the SP / HTAB that followed the CRLF. That whitespace is a literal
  // byte to the Q decoder, and `prefixReplySubject` folds the run into the
  // single space `_` would have produced.
  it('decodes a Q-word carrying unfolded FWS to the same subject as the unfolded word', async () => {
    const unfolded = await buildReplyMessage(inbound('=?UTF-8?Q?good=20sub_ject?='), {
      text: 'thanks',
      from: FROM,
    });
    const folded = await buildReplyMessage(inbound('=?UTF-8?Q?good=20sub\t ject?='), {
      text: 'thanks',
      from: FROM,
    });
    expect(unfolded.subject).toBe('Re: good sub ject');
    expect(folded.subject).toBe(unfolded.subject);
  });

  it.each([
    ['a lone = at the end', '=?UTF-8?Q?a=?=', 'Re: a='],
    ['a one-digit escape at the end', '=?UTF-8?Q?a=4?=', 'Re: a=4'],
    ['a well-formed escape at the end', '=?UTF-8?Q?a=41?=', 'Re: aA'],
    ['a malformed second digit', '=?UTF-8?Q?a=4G?=', 'Re: a=4G'],
    ['an escape that is the whole payload', '=?UTF-8?Q?=41?=', 'Re: A'],
  ])('keeps the Q escape rules at the payload edge for %s', async (_label, subject, expected) => {
    const reply = await buildReplyMessage(inbound(subject), { text: 'thanks', from: FROM });
    expect(reply.subject).toBe(expected);
  });

  // Aimed past the decoder at the control-character replacements: the
  // decoded subject is bounded before they run.
  it('replies to a 5 MiB subject of alternating tabs and letters inside a 128 MB heap', () => {
    const result = replyInIsolate(`{ subject: '\\ta'.repeat(${(5 * 1024 * 1024) / 2}) }`);
    expect(result.subject).toBe('Re:');
    expect(result.ms).toBeLessThan(200);
    expect(result.heapDeltaMB).toBeLessThan(64);
  }, 30_000);

  // The bound sits on the decoded subject and is checked before the
  // replacements: a subject exactly at it is still repaired, one character
  // over falls back. `\x01` rather than a tab, because `Headers` strips
  // leading and trailing HTTP whitespace and the count must be exact.
  it('repairs a subject exactly at the bound and falls back one character over', async () => {
    const atBound = 'a\x01'.repeat(2048); // 4096 code units
    const kept = await buildReplyMessage(inbound(atBound), { text: 'thanks', from: FROM });
    expect(kept.subject).toBe(`Re: ${'a '.repeat(2048).trim()}`);
    expect(maxLine(kept)).toBeLessThanOrEqual(998);

    const over = await buildReplyMessage(inbound(`${atBound}a`), { text: 'thanks', from: FROM });
    expect(over.subject).toBe('Re:');
  });

  // It is the DECODED length that is bounded: B-encoded, 4096 three-octet
  // characters arrive as a 19,945-character header.
  it('bounds the decoded subject, not the encoded header it arrived in', async () => {
    // Fifteen three-octet characters fill a 45-octet encoded-word exactly,
    // so no character is split across words (RFC 2047 §5).
    const encode = (text: string) => {
      const words: Array<string> = [];
      for (let i = 0; i < text.length; i += 15) {
        const bytes = new TextEncoder().encode(text.slice(i, i + 15));
        words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`);
      }
      return words.join(' ');
    };
    const atBound = '日'.repeat(4096);
    const header = encode(atBound);
    expect(header.length).toBeGreaterThan(4 * atBound.length);

    const kept = await buildReplyMessage(inbound(header), { text: 'thanks', from: FROM });
    expect(kept.subject).toBe(`Re: ${atBound}`);
    expect(maxLine(kept)).toBeLessThanOrEqual(998);
    expect(kept.raw.byteLength).toBeLessThan(32 * 1024);

    const over = await buildReplyMessage(inbound(encode(`${atBound}日`)), {
      text: 'thanks',
      from: FROM,
    });
    expect(over.subject).toBe('Re:');
  });

  // A subject with spaces folds, so only the decoded-length bound keeps its
  // rendered size from failing the reply.
  it('replies to a subject of MAX_MESSAGE_BYTES that folds instead of throwing MimeError from the size check', async () => {
    const raw = new TextEncoder().encode('body');
    const { message, getActions } = createMessageProxy(
      {
        from: 'sender@remote.dev',
        to: 'acme+support@mail.void.cloud',
        headers: { subject: 'a '.repeat(MAX_MESSAGE_BYTES / 2) },
        raw,
        rawSize: raw.length,
      },
      { slug: 'acme' },
    );

    await replyEmail(message, { text: 'thanks', from: FROM });

    const [action] = getActions();
    if (action?.type !== 'reply') {
      throw new Error('expected reply action');
    }
    expect(new TextDecoder().decode(action.raw)).toContain('Subject: Re:\r\n');
  });
});

describe('parseEmail error contract', () => {
  // Every code in `ParseEmailErrorCode` is reachable.
  it('wraps a raw-stream read failure as PARSE_FAILED', async () => {
    // An own-account delivery wraps Cloudflare's native one-shot `raw` with
    // `createMessageProxy`, so the buffering read is what fails.
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream broke mid-delivery'));
      },
    });
    const { message } = createMessageProxy(
      { from: 'a@b.dev', to: 'acme+x@mail.void.cloud', headers: {}, raw, rawSize: 32 },
      { slug: 'acme' },
    );

    await expect(parseEmail(message)).rejects.toSatisfy(
      (e: unknown) => e instanceof ParseEmailError && e.code === 'PARSE_FAILED',
    );
  });

  it('wraps a parser rejection as PARSE_FAILED', async () => {
    // postal-mime refuses past 256 levels of nesting. Build one bomb that
    // trips exactly that, and nothing else.
    const depth = 300;
    let body = 'boom\r\n';
    for (let i = depth; i > 0; i--) {
      const boundary = `b${i}`;
      body =
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
        `--${boundary}\r\n${body}\r\n--${boundary}--\r\n`;
    }
    const raw = new TextEncoder().encode(body);
    const { message } = createMessageProxy(
      { from: 'a@b.dev', to: 'acme+x@mail.void.cloud', headers: {}, raw, rawSize: raw.length },
      { slug: 'acme' },
    );

    await expect(parseEmail(message)).rejects.toSatisfy(
      (e: unknown) => e instanceof ParseEmailError && e.code === 'PARSE_FAILED',
    );
  });

  // `void/email` is the only public path to the error classes, so a handler
  // can `instanceof` them only through it.
  it('reports an oversized message as INBOUND_TOO_LARGE, with the classes void/email exports', async () => {
    expect(emailBarrel.ParseEmailError).toBe(ParseEmailError);
    expect(emailBarrel.MimeError).toBe(MimeError);
    const raw = new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
    const { message } = createMessageProxy(
      {
        from: 'a@b.dev',
        to: 'acme+x@mail.void.cloud',
        headers: {},
        raw,
        rawSize: 100 * 1024 * 1024,
      },
      { slug: 'acme' },
    );

    await expect(parseEmail(message)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof emailBarrel.ParseEmailError &&
        e.code === 'INBOUND_TOO_LARGE' &&
        /exceeds maximum/.test(e.message),
    );
  });
});

describe('buildReplyMessage', () => {
  function makeMessage(headers: Record<string, string>): ForwardableEmailMessage {
    return {
      from: 'user@example.com',
      to: 'support@app.dev',
      headers: new Headers(headers),
      raw: new ReadableStream(),
      rawSize: 0,
    } as unknown as ForwardableEmailMessage;
  }

  // The platform mail domain is injected per environment, so the tests use a
  // non-production value: asserting on it proves the reply address came from
  // the binding and not from a baked-in constant.
  const MAIL_DOMAIN = 'mail.staging.void.cloud';

  // Most reply tests exercise the platform-defaulted `from = <slug>+noreply@…`
  // path. Set both platform bindings once via envContext so each test inside
  // this describe sees them without per-test boilerplate.
  function withSlug<T>(fn: () => T | Promise<T>): T | Promise<T> {
    return envContext.run({ __VOID_PROJECT_SLUG: 'myslug', __VOID_EMAIL_DOMAIN: MAIL_DOMAIN }, fn);
  }

  it('throws rather than falling back to message.to when the slug cannot be a sender', async () => {
    // A slug over 56 characters cannot build `<slug>+noreply@`, which must
    // stay inside RFC 5321's 64-octet local part. Falling through to
    // `message.to` builds the slug-stripped shape the platform reply pin
    // drops, so the handler would see a success and the mail would vanish.
    await envContext.run(
      { __VOID_PROJECT_SLUG: 'a'.repeat(57), __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
      async () => {
        const message = makeMessage({ Subject: 'Help me' });
        await expect(buildReplyMessage(message, { text: 'sure' })).rejects.toThrow(
          /cannot build a default reply sender/,
        );
      },
    );
  });

  it('defaults from/to/subject from the original message', async () => {
    await withSlug(async () => {
      const message = makeMessage({ Subject: 'Help me' });
      const built = await buildReplyMessage(message, { text: 'sure' });
      // Reply-from is the platform sender, so the slug-pin allowlist accepts it.
      expect(built.from).toBe(`myslug+noreply@${MAIL_DOMAIN}`);
      expect(built.to).toBe('user@example.com');
      expect(built.subject).toBe('Re: Help me');
    });
  });

  it('does not double-prefix Re:', async () => {
    await withSlug(async () => {
      const message = makeMessage({ Subject: 'Re: existing thread' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: existing thread');
    });
  });

  it('handles missing subject gracefully', async () => {
    await withSlug(async () => {
      const message = makeMessage({});
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re:');
    });
  });

  it('decodes RFC 2047 encoded-word subjects before prepending Re:', async () => {
    await withSlug(async () => {
      // base64('日本語') in UTF-8 = "5pel5pys6Kqe"
      const message = makeMessage({ Subject: '=?UTF-8?B?5pel5pys6Kqe?=' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: 日本語');
    });
  });

  it('decodes Q-encoded subjects (RFC 2047 quoted-printable variant)', async () => {
    await withSlug(async () => {
      // =?UTF-8?Q?caf=C3=A9?= → "café"
      const message = makeMessage({ Subject: '=?UTF-8?Q?caf=C3=A9?=' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: café');
    });
  });

  it('decodes ISO-8859-1 Q-encoded subjects with the actual charset', async () => {
    await withSlug(async () => {
      // =?iso-8859-1?Q?J=FCrgen?= → "Jürgen"  (0xFC is 'ü' in Latin-1)
      // Decoding the same bytes as UTF-8 would mojibake.
      const message = makeMessage({ Subject: '=?iso-8859-1?Q?J=FCrgen?=' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: Jürgen');
    });
  });

  it('does not double-prefix Re: when the encoded subject already starts with Re:', async () => {
    await withSlug(async () => {
      // base64('Re: hi') = "UmU6IGhp"
      const message = makeMessage({ Subject: '=?UTF-8?B?UmU6IGhp?=' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: hi');
    });
  });

  it('threads via In-Reply-To and starts a References chain', async () => {
    await withSlug(async () => {
      const message = makeMessage({
        Subject: 'Hi',
        'Message-ID': '<orig@example.com>',
      });
      const built = await buildReplyMessage(message, { text: 'ack' });
      const raw = new TextDecoder().decode(built.raw);
      expect(raw).toContain('In-Reply-To: <orig@example.com>');
      expect(raw).toContain('References: <orig@example.com>');
    });
  });

  it('appends to an existing References chain', async () => {
    await withSlug(async () => {
      const message = makeMessage({
        Subject: 'Hi',
        'Message-ID': '<msg2@example.com>',
        References: '<msg1@example.com>',
      });
      const built = await buildReplyMessage(message, { text: 'ack' });
      const raw = new TextDecoder().decode(built.raw);
      expect(raw).toContain('In-Reply-To: <msg2@example.com>');
      expect(raw).toContain('References: <msg1@example.com> <msg2@example.com>');
    });
  });

  it('honors explicit overrides', async () => {
    // No slug needed — explicit `from` skips the defaulting path.
    const message = makeMessage({ Subject: 'Hi' });
    const built = await buildReplyMessage(message, {
      from: 'override@app.dev',
      to: 'someone@else.dev',
      subject: 'Custom subject',
      text: 'ack',
    });
    expect(built.from).toBe('override@app.dev');
    expect(built.to).toBe('someone@else.dev');
    expect(built.subject).toBe('Custom subject');
  });

  it('renders a dotted sender name, handed back as `to`, as one quoted-string', async () => {
    // The default `to` is the bare envelope sender, so no display name is
    // formatted unless the handler passes one — typically the parsed
    // `From`. postal-mime gives the name as its raw text (`Dr. Smith`, the
    // quotes undone), and `buildMime` quotes it again on the way out: `.`
    // is an RFC 5322 special, so the name is not a phrase of atoms.
    const raw = new TextEncoder().encode(
      'From: "Dr. Smith" <user@example.com>\r\n' +
        'To: support@app.dev\r\n' +
        'Subject: Hi\r\n\r\nhello\r\n',
    );
    const message = {
      from: 'user@example.com',
      to: 'support@app.dev',
      headers: new Headers({ Subject: 'Hi' }),
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(raw);
          controller.close();
        },
      }),
      rawSize: raw.length,
    } as unknown as ForwardableEmailMessage;
    const parsed = await parseEmail(message);
    expect(parsed.from).toEqual({ address: 'user@example.com', name: 'Dr. Smith' });
    const sender = parsed.from as { address: string; name: string };
    const built = await buildReplyMessage(message, {
      from: 'override@app.dev',
      to: { email: sender.address, name: sender.name },
      text: 'ack',
    });
    expect(built.to).toBe('user@example.com');
    const text = new TextDecoder().decode(built.raw);
    expect(text).toContain('To: "Dr. Smith" <user@example.com>\r\n');
  });
});

// ---------------------------------------------------------------------------
// The verified receipt path builds a proxy, runs the matching handler, and
// encodes the recorded actions for the platform. This exercises those pieces
// without evaluating the generated Worker module.
// ---------------------------------------------------------------------------

describe('end-to-end: envelope → handler → action queue', () => {
  function makeEnvelope(overrides: Partial<EmailEnvelope> = {}): EmailEnvelope {
    const raw = new TextEncoder().encode(
      'From: sender@example.com\r\n' +
        'To: support+abc-1@app.dev\r\n' +
        'Subject: Help me\r\n' +
        'Message-ID: <orig@example.com>\r\n' +
        'Content-Type: text/plain\r\n' +
        '\r\n' +
        'I have a problem\r\n',
    );
    return {
      from: 'sender@example.com',
      to: 'support+abc-1@app.dev',
      headers: { Subject: 'Help me', 'Message-ID': '<orig@example.com>' },
      raw,
      rawSize: raw.byteLength,
      ...overrides,
    };
  }

  // Mirrors the codegen pattern: build proxy, run handler, return actions.
  async function dispatchToHandler(
    envelope: EmailEnvelope,
    handler: (
      message: ForwardableEmailMessage,
      env: unknown,
      ctx: ExecutionContext,
      info?: { params: Record<string, string> },
    ) => void | Promise<void>,
    info: { params: Record<string, string> } = { params: {} },
  ) {
    const { message, getActions } = createMessageProxy(envelope);
    await handler(message, {}, {} as ExecutionContext, info);
    return getActions();
  }

  it('records a setReject action for the receipt response', async () => {
    const handler = defineEmail(async (message) => {
      message.setReject('not allowed');
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toEqual([{ type: 'reject', reason: 'not allowed' }]);
  });

  it('records a forward action with serialized headers', async () => {
    const handler = defineEmail(async (message) => {
      const fwd = new Headers({ 'X-Forwarded-By': 'void-test' });
      await message.forward('archive@example.com', fwd);
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toEqual([
      {
        type: 'forward',
        to: 'archive@example.com',
        headers: { 'x-forwarded-by': 'void-test' },
      },
    ]);
  });

  it('records a reply action with threaded MIME from replyEmail', async () => {
    // Explicit `from` — without __VOID_PROJECT_SLUG / __VOID_EMAIL_DOMAIN
    // in scope, replyEmail's defaulting path errors. Production threads both
    // from env; bare unit tests pass `from` explicitly to skip that machinery.
    const handler = defineEmail(async (message, _env, _ctx, info) => {
      const ticket = info?.params.ticket ?? 'unknown';
      await replyEmail(message, {
        from: 'support+abc-1@app.dev',
        text: `Got ticket ${ticket}`,
      });
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler, {
      params: { ticket: 'abc-1' },
    });
    expect(actions).toHaveLength(1);
    const reply = actions[0];
    if (reply.type !== 'reply') {
      throw new Error('expected reply action');
    }
    expect(reply.from).toBe('support+abc-1@app.dev');
    expect(reply.to).toBe('sender@example.com');
    expect(reply.raw).toBeInstanceOf(Uint8Array);
    const rawText = new TextDecoder().decode(reply.raw);
    expect(rawText).toContain('Subject: Re: Help me');
    expect(rawText).toContain('In-Reply-To: <orig@example.com>');
    expect(rawText).toContain('References: <orig@example.com>');
    expect(rawText).toContain('Got ticket abc-1');
  });

  it('strips the platform <slug>+ prefix from message.to before user code sees it', async () => {
    // Production: every recipient arrives as `<slug>+<tag>@mail.void.cloud`.
    // The user-visible `message.to` should be the bare `<tag>@<domain>`,
    // matching the address shape user handlers wrote in `email/<addr>.ts`.
    let observedTo: string | undefined;
    let platformTo: string | undefined;
    const handler = defineEmail(async (message) => {
      observedTo = message.to;
      platformTo = (message as unknown as { __voidPlatformTo?: string }).__voidPlatformTo;
    });
    const envelope: EmailEnvelope = {
      from: 'sender@example.com',
      to: 'myslug+support@mail.void.cloud',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    };
    const { message, getActions } = createMessageProxy(envelope, { slug: 'myslug' });
    await handler(message, {}, {} as ExecutionContext, { params: {} });
    expect(getActions()).toEqual([]);
    expect(observedTo).toBe('support@mail.void.cloud');
    expect(platformTo).toBe('myslug+support@mail.void.cloud');
  });

  it('leaves message.to untouched when no slug is provided', async () => {
    // Unit-level safety net: slug-stripping is opt-in (the dispatcher
    // passes the slug explicitly). Without it, the proxy must not mangle
    // the address — local tests / harnesses without a known slug rely on
    // this for predictable behavior.
    let observedTo: string | undefined;
    const handler = defineEmail(async (message) => {
      observedTo = message.to;
    });
    const envelope: EmailEnvelope = {
      from: 'sender@example.com',
      to: 'myslug+support@mail.void.cloud',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    };
    const { message } = createMessageProxy(envelope);
    await handler(message, {}, {} as ExecutionContext, { params: {} });
    expect(observedTo).toBe('myslug+support@mail.void.cloud');
  });

  function replyTestMessage(): ForwardableEmailMessage {
    return {
      from: 'sender@example.com',
      to: 'support@mail.example.dev',
      headers: new Headers({ Subject: 'Hi' }),
      raw: new ReadableStream(),
      rawSize: 0,
    } as unknown as ForwardableEmailMessage;
  }

  it('replyEmail without from replies from message.to when there is no __VOID_PROJECT_SLUG', async () => {
    // No slug means no platform slug-pin to satisfy: the message reached a
    // real address on the developer's own zone, and that address is the
    // reply sender. A domain binding on its own does not change that.
    const built = await envContext.run({ __VOID_EMAIL_DOMAIN: 'mail.staging.void.cloud' }, () =>
      buildReplyMessage(replyTestMessage(), { text: 'ack' }),
    );
    expect(built.from).toBe('support@mail.example.dev');
  });

  it('replyEmail without from errors when __VOID_EMAIL_DOMAIN is unavailable', async () => {
    // No silent fallback: with a slug but no configured mail domain the
    // reply must fail rather than being addressed from the production zone.
    await expect(
      envContext.run({ __VOID_PROJECT_SLUG: 'myslug' }, () =>
        replyEmail(replyTestMessage(), { text: 'ack' }),
      ),
    ).rejects.toThrow(/__VOID_EMAIL_DOMAIN/);
  });

  it('replyEmail keeps an explicit from with neither binding present', async () => {
    // The bindings only feed the default; an explicit sender is untouched.
    const built = await envContext.run({}, () =>
      buildReplyMessage(replyTestMessage(), { from: 'support@app.dev', text: 'ack' }),
    );
    expect(built.from).toBe('support@app.dev');
  });

  it('setReject is terminal: prior forwards are dropped and later forward/reply are no-ops', async () => {
    // CF treats setReject as terminal — once setReject fires, anything
    // queued before it never runs (router drops them) and anything called
    // after is silently discarded. The proxy mirrors that contract by
    // (a) walking back the action queue on setReject to remove preceding
    // forward/reply entries (with one warning describing how many were
    // dropped) and (b) warning + no-op for forward/reply called after.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = defineEmail(async (message) => {
        await message.forward('first@example.com');
        message.setReject('then reject');
        await message.forward('after-reject@example.com');
        await message.reply({
          from: 'support@app.dev',
          to: 'sender@example.com',
          raw: new TextEncoder().encode('Subject: late\r\n\r\nbody\r\n'),
          // The proxy's reply() accepts a duck-typed { from, to, raw },
          // but the ForwardableEmailMessage interface expects EmailMessage.
          // This cast keeps the runtime contract under test while
          // satisfying the public type.
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      });
      const actions = await dispatchToHandler(makeEnvelope(), handler);
      // Only the reject survives — the prior forward was walked back, the
      // later forward/reply are no-ops.
      expect(actions.map((a) => a.type)).toEqual(['reject']);
      // Three warnings: walk-back (prior forward), late forward, late reply.
      expect(warn).toHaveBeenCalledTimes(3);
      const warnMessages = warn.mock.calls.map((c) => String(c[0]));
      expect(warnMessages.some((m) => m.includes('1 forward/reply call'))).toBe(true);
      expect(warnMessages.some((m) => m.includes('forward()'))).toBe(true);
      expect(warnMessages.some((m) => m.includes('reply()'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('reply() refuses a native EmailMessage with a named error', async () => {
    // What workerd's `EmailMessage` looks like to JS: `from` and `to` only —
    // the body has no accessor, so the proxy cannot record it as bytes.
    const native = Object.freeze({ from: 'support@app.dev', to: 'sender@example.com' });
    const handler = defineEmail(async (message) => {
      await message.reply(native as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
    });
    const failure = dispatchToHandler(makeEnvelope(), handler);
    await expect(failure).rejects.toBeInstanceOf(MimeError);
    await expect(failure).rejects.toThrow(/native EmailMessage cannot be replayed/);
    await expect(failure).rejects.toThrow(/replyEmail\(\)/);
  });

  it('reply() rejects a Uint8Array raw over MAX_MESSAGE_BYTES', async () => {
    const handler = defineEmail(async (message) => {
      await message.reply({
        from: 'support@app.dev',
        to: 'sender@example.com',
        raw: new Uint8Array(MAX_MESSAGE_BYTES + 1),
      } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
    });
    await expect(dispatchToHandler(makeEnvelope(), handler)).rejects.toThrow(
      /exceeds Void's sending limit/,
    );
  });

  it('reply() stops reading a stream raw once MAX_MESSAGE_BYTES is exceeded', async () => {
    // A stream that never closes: without the bound, reply() would buffer forever.
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const raw = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const handler = defineEmail(async (message) => {
      await message.reply({
        from: 'support@app.dev',
        to: 'sender@example.com',
        raw,
      } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
    });
    await expect(dispatchToHandler(makeEnvelope(), handler)).rejects.toThrow(
      /exceeds Void's sending limit/,
    );
    expect(cancelled).toBe(true);
    // 5 MiB limit + the chunk that crosses it + the stream's own read-ahead.
    expect(pulls).toBeLessThanOrEqual(7);
  });

  it('bounds a stalled reply stream without awaiting its cancellation', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const raw = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel,
      });
      const handler = defineEmail(async (message) => {
        await message.reply({
          from: 'support@app.dev',
          to: 'sender@example.com',
          raw,
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      });
      const result = dispatchToHandler(makeEnvelope(), handler);
      const rejected = expect(result).rejects.toThrow('email stream timed out');
      await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses the 101st queued action and leaves the queue at 100', async () => {
    // The queue crosses the RPC boundary into the SHARED proxy isolate, where
    // it is walked entry by entry before any quota gate has looked at it.
    // The router enforces the same 100; this is the fast, precise failure.
    let thrown: unknown;
    const handler = defineEmail(async (message) => {
      for (let i = 0; i < 100; i++) {
        await message.forward(`box${i}@example.com`);
      }
      try {
        await message.forward('overflow@example.com');
      } catch (e) {
        thrown = e;
      }
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toHaveLength(100);
    expect(actions.every((a) => a.type === 'forward')).toBe(true);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).message).toMatch(/more than 100 actions/);
  });

  it('accounts for action frames in the cumulative reply budget before recording', async () => {
    const from = 'support@app.dev';
    const to = 'sender@example.com';
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify({ type: 'reply', from, to }),
    ).byteLength;
    const firstSize = 5 * 1024 * 1024;
    const secondSize = EMAIL_MAX_RESPONSE_BYTES - 5 - 2 * (10 + metadataBytes) - firstSize;
    let thrown: unknown;
    const handler = defineEmail(async (message) => {
      const send = (raw: Uint8Array) =>
        message.reply({
          from,
          to,
          raw,
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      await send(new Uint8Array(firstSize));
      await send(new Uint8Array(secondSize));
      try {
        await send(new Uint8Array(1));
      } catch (e) {
        thrown = e;
      }
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toHaveLength(2);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).message).toMatch(/serialized actions/);
    const decoded = await readEmailActions(encodeEmailActions(actions));
    expect(decoded).toHaveLength(2);
    expect(decoded.map((action) => (action.type === 'reply' ? action.raw.byteLength : -1))).toEqual(
      [firstSize, secondSize],
    );
  });

  it('cancels a stream reply at the REMAINING budget, not the per-reply cap', async () => {
    // 7 MiB of reply bodies plus their frames have already been spent, so
    // slightly less than 1 MiB is left. A
    // stream bounded by the per-reply cap would keep pulling to 5 MiB and
    // report the wrong limit; the pull count and the message both pin that
    // the remaining budget is what stopped it.
    //
    // Two prior replies, not one: after a single full-size reply the
    // remaining budget is still below the per-reply cap, but this pins a tighter boundary.
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const raw = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    let thrown: unknown;
    const handler = defineEmail(async (message) => {
      const send = (body: Uint8Array | ReadableStream<Uint8Array>) =>
        message.reply({
          from: 'support@app.dev',
          to: 'sender@example.com',
          raw: body,
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      await send(new Uint8Array(5 * 1024 * 1024));
      await send(new Uint8Array(2 * 1024 * 1024));
      try {
        await send(raw);
      } catch (e) {
        thrown = e;
      }
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toHaveLength(2);
    expect(cancelled).toBe(true);
    // Less than 1 MiB remains; allow the crossing chunk plus read-ahead.
    expect(pulls).toBeLessThanOrEqual(3);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).message).toMatch(/serialized actions/);
  });

  it('does not record a streamed reply that completes after setReject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const raw = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      const { message, getActions } = createMessageProxy(makeEnvelope());
      const pending = message.reply({
        from: 'support@app.dev',
        to: 'sender@example.com',
        raw,
      } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      await Promise.resolve();
      message.setReject('stop');
      controller.enqueue(new TextEncoder().encode('From: support@app.dev\r\n\r\nlate'));
      controller.close();

      await pending;
      expect(getActions()).toEqual([{ type: 'reject', reason: 'stop' }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('completed after setReject'));
    } finally {
      warn.mockRestore();
    }
  });

  it('reserves queue slots for concurrent replies before buffering them', async () => {
    const { message, getActions } = createMessageProxy(makeEnvelope());
    const reply = () =>
      message.reply({
        from: 'support@app.dev',
        to: 'sender@example.com',
        raw: new Uint8Array(),
      } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
    const pending = Array.from({ length: 100 }, reply);
    await expect(reply()).rejects.toThrow(/more than 100 actions/);
    await Promise.all(pending);
    expect(getActions()).toHaveLength(100);
  });

  it.each(['forward', 'reply'] as const)(
    'bounds a nonsettling native %s provider action',
    async (kind) => {
      vi.useFakeTimers();
      try {
        const message = {
          setReject: vi.fn(),
          forward: vi.fn(() => new Promise<void>(() => {})),
          reply: vi.fn(() => new Promise<void>(() => {})),
        } as unknown as ForwardableEmailMessage;
        const action =
          kind === 'forward'
            ? ({ type: 'forward', to: 'archive@example.com' } as const)
            : ({
                type: 'reply',
                from: 'support@app.dev',
                to: 'sender@example.com',
                raw: new Uint8Array(),
              } as const);
        const pending = enactEmailActions(message, [action]);
        const outcome = expect(pending).rejects.toThrow(/outcome unknown/);
        await vi.advanceTimersByTimeAsync(30_000);
        await outcome;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('refuses a forward address over the address-length limit', async () => {
    const over = `${'a'.repeat(320)}@example.com`;
    const handler = defineEmail(async (message) => {
      await message.forward(over);
    });
    await expect(dispatchToHandler(makeEnvelope(), handler)).rejects.toMatchObject({
      code: 'INVALID_TO',
      message: `to address is ${over.length} characters, over the 320-character limit.`,
    });
  });

  it('records a plain header record verbatim, keeping the name casing', async () => {
    const handler = defineEmail(async (message) => {
      // The record form is a runtime affordance (JS handlers, or a cast):
      // `ForwardableEmailMessage.forward` is typed against `Headers`.
      const record = { 'X-Forwarded-By': 'void-test' } as unknown as Headers;
      await message.forward('archive@example.com', record);
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toEqual([
      { type: 'forward', to: 'archive@example.com', headers: { 'X-Forwarded-By': 'void-test' } },
    ]);
  });

  it.each([
    ['a CRLF in a value', { 'X-Trace': 'abc\r\nBcc: leak@evil.test' }],
    ['a NUL in a value', { 'X-Trace': 'abc\0' }],
    ['a non-token name', { 'X Trace': 'abc' }],
  ])(
    'refuses a forward header record with %s at the call, recording nothing for it',
    async (_label, headers) => {
      // The record is replayed through `new Headers()` (natively and in the
      // platform router). What that constructor rejects must fail here, in
      // the handler, not after earlier actions have already fired.
      const { message, getActions } = createMessageProxy(makeEnvelope());
      await message.forward('first@example.com');
      let thrown: unknown;
      try {
        await message.forward('archive@example.com', headers as unknown as Headers);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MimeError);
      expect((thrown as MimeError).code).toBe('MIME_ERROR');
      expect((thrown as MimeError).message).toMatch(/^forward: invalid header/);
      expect(getActions()).toEqual([{ type: 'forward', to: 'first@example.com' }]);
    },
  );

  function headerBag(count: number): Record<string, string> {
    const bag: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      bag[`X-Void-${i}`] = 'v';
    }
    return bag;
  }

  it.each([
    ['33 headers in a record', headerBag(33), 'forward: 33 headers, over the 32-header limit.'],
    [
      '33 headers in a Headers',
      new Headers(headerBag(33)),
      'forward: 33 headers, over the 32-header limit.',
    ],
    [
      'a 1025-character name',
      { ['X'.repeat(1025)]: 'v' },
      'forward: header name is 1025 characters, over the 1024-character limit.',
    ],
    [
      'a 1025-character value in a record',
      { 'X-Void-Tag': 'v'.repeat(1025) },
      'forward: header "X-Void-Tag" value is 1025 characters, over the 1024-character limit.',
    ],
    [
      'a 1025-character value in a Headers',
      new Headers({ 'X-Void-Tag': 'v'.repeat(1025) }),
      'forward: header "x-void-tag" value is 1025 characters, over the 1024-character limit.',
    ],
    [
      'a non-string value',
      { 'X-Void-Tag': 123 },
      'forward: header "X-Void-Tag" value is not a string.',
    ],
  ])(
    'refuses a forward header bag with %s at the call, recording nothing for it',
    async (_label, headers, expected) => {
      // `new Headers()` accepts every one of these, but the platform router's
      // `forwardHeadersWithinBounds` would drop the whole action list.
      const { message, getActions } = createMessageProxy(makeEnvelope());
      await message.forward('first@example.com');
      let thrown: unknown;
      try {
        await message.forward('archive@example.com', headers as unknown as Headers);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MimeError);
      expect((thrown as MimeError).code).toBe('MIME_ERROR');
      expect((thrown as MimeError).message).toBe(expected);
      expect(getActions()).toEqual([{ type: 'forward', to: 'first@example.com' }]);
    },
  );

  it('records 32 forward headers within the wire metadata budget', async () => {
    const bag: Record<string, string> = {};
    for (let i = 0; i < 32; i++) {
      bag[`X-${'a'.repeat(95)}${String(i).padStart(2, '0')}`] = 'v'.repeat(100);
    }
    const { message, getActions } = createMessageProxy(makeEnvelope());
    await message.forward('archive@example.com', bag as unknown as Headers);
    const actions = getActions();
    expect(actions).toHaveLength(1);
    const recorded = (actions[0] as { headers?: Record<string, string> }).headers ?? {};
    expect(Object.keys(recorded)).toHaveLength(32);
    for (const [name, value] of Object.entries(recorded)) {
      expect(name).toHaveLength(99);
      expect(value).toHaveLength(100);
    }
  });

  it('rejects an aggregate forward header bag over the wire metadata budget', async () => {
    const bag: Record<string, string> = {};
    for (let i = 0; i < 32; i++) {
      bag[`X-${i}`] = 'v'.repeat(1024);
    }
    const { message, getActions } = createMessageProxy(makeEnvelope());
    await expect(message.forward('archive@example.com', bag as unknown as Headers)).rejects.toThrow(
      'action metadata exceeds 8192 bytes',
    );
    expect(getActions()).toEqual([]);
  });

  it('normalizes the reject reason as the router does: slice to 1000, then strip controls', () => {
    // The router's own fixture (`email-router.test.ts`): 300 x "line\r\n" is
    // 1800 characters; the first 1000 code units are 166 full lines plus
    // "line", and each CRLF then becomes one space — 834 characters, not
    // 1000. Recorded this way, the native replay hands `setReject()` the
    // string the platform router would, and a harness reports it.
    const { message, getActions } = createMessageProxy(makeEnvelope());
    message.setReject('line\r\n'.repeat(300));
    expect(getActions()).toEqual([{ type: 'reject', reason: 'line '.repeat(166) + 'line' }]);
  });

  it('bounds a multi-megabyte control-laden reject reason before it is recorded', () => {
    // A reason built from the inbound message can be as large as the message
    // and carry a remote sender's CRLF.
    const { message, getActions } = createMessageProxy(makeEnvelope());
    message.setReject(`${'x'.repeat(5 * 1024 * 1024)}\r\n\x00`);
    const [action] = getActions();
    expect(action).toEqual({ type: 'reject', reason: 'x'.repeat(1000) });
  });

  it("records the router's substitute for an empty reason, and a space for a controls-only one", () => {
    // The router checks for empty BEFORE it strips (`validateActions`), so a
    // reason that is only controls becomes one space, not the substitute.
    const empty = createMessageProxy(makeEnvelope());
    empty.message.setReject('');
    expect(empty.getActions()).toEqual([{ type: 'reject', reason: 'rejected by handler' }]);
    const controls = createMessageProxy(makeEnvelope());
    controls.message.setReject('\r\n');
    expect(controls.getActions()).toEqual([{ type: 'reject', reason: ' ' }]);
  });

  it.each([
    ['no @', 'not-an-address'],
    // `forward(rcptTo)` takes a bare address — Cloudflare's "verified
    // destination address" — so the display-name form `sendEmail` parses
    // is not an address here.
    ['a display name', 'Ops <ops@example.com>'],
    ['two @', 'a@b@example.com'],
    ['an empty domain', 'user@'],
    ['an empty local part', '@example.com'],
    ['a list separator', 'a@example.com,b@example.com'],
    ['whitespace', 'a b@example.com'],
    ['a 65-character local part', `${'a'.repeat(65)}@example.com`],
    ['a dot-less domain', 'user@localhost'],
    ['a one-letter domain', 'x@y'],
    ['doubled dots in the local part', 'a..b@example.com'],
    ['a leading dot', '.a@example.com'],
    ['a trailing dot before the @', 'a.@example.com'],
    ['doubled dots in the domain', 'a@example..com'],
    ['a non-ASCII local part', 'jöhn@example.com'],
    ['a quoted local part', '"a b"@example.com'],
  ])(
    'refuses a forward address with %s at the call, recording nothing for it',
    async (_label, to) => {
      // The rule `sendEmail` applies to its `to`, and the one the router drops on.
      const { message, getActions } = createMessageProxy(makeEnvelope());
      await message.forward('first@example.com');
      let thrown: unknown;
      try {
        await message.forward(to);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MimeError);
      expect((thrown as MimeError).code).toBe('INVALID_TO');
      expect((thrown as MimeError).message).toBe(`to: ${INVALID_ADDRESS}`);
      expect(getActions()).toEqual([{ type: 'forward', to: 'first@example.com' }]);
    },
  );

  it('refuses a hand-built reply with a malformed address at the call, recording nothing for it', async () => {
    // The `{ from, to, raw }` reply form bypasses `normalizeEmail`, so it
    // gets the same record-time rule as `forward(to)`: a bad address fails
    // in the handler's own call, before any native replay could fire the
    // actions queued ahead of it.
    const cases: Array<[Record<'from' | 'to', string>, 'INVALID_FROM' | 'INVALID_TO', string]> = [
      [
        { from: 'not-an-address', to: 'ops@example.com' },
        'INVALID_FROM',
        `from: ${INVALID_ADDRESS}`,
      ],
      [
        { from: 'me@example.com', to: 'Ops <ops@example.com>' },
        'INVALID_TO',
        `to: ${INVALID_ADDRESS}`,
      ],
      [
        { from: `${'a'.repeat(65)}@example.com`, to: 'ops@example.com' },
        'INVALID_FROM',
        `from: ${INVALID_ADDRESS}`,
      ],
      [{ from: 'me@example.com', to: 'a..b@example.com' }, 'INVALID_TO', `to: ${INVALID_ADDRESS}`],
    ];
    for (const [addrs, code, expected] of cases) {
      const { message, getActions } = createMessageProxy(makeEnvelope());
      await message.forward('first@example.com');
      let thrown: unknown;
      try {
        await message.reply({
          ...addrs,
          raw: new TextEncoder().encode('Subject: x\r\n\r\nhi'),
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MimeError);
      expect((thrown as MimeError).code).toBe(code);
      expect((thrown as MimeError).message).toBe(expected);
      expect(getActions()).toEqual([{ type: 'forward', to: 'first@example.com' }]);
    }
  });

  it('records every forward address sendEmail would accept', async () => {
    // The same rule as the platform router's `isValidEmailAddress`
    // (`email-validator` on both sides), so everything recorded here is
    // enacted there. A local part of exactly 64 characters, a `+` tag, dots
    // between atoms, a punycode IDN domain and a numeric second character
    // in the TLD are all fine.
    const accepted = [
      'ops+T-42@example.com',
      `${'a'.repeat(64)}@example.com`,
      'first.last@sub.example.com',
      'a@xn--bcher-kva.example',
      'a@b.c1',
    ];
    const { message, getActions } = createMessageProxy(makeEnvelope());
    for (const to of accepted) {
      await message.forward(to);
    }
    expect(getActions()).toEqual(accepted.map((to) => ({ type: 'forward', to })));
  });

  it('setReject still works with a full queue (it shrinks the queue, so it is exempt)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = defineEmail(async (message) => {
        for (let i = 0; i < 100; i++) {
          await message.forward(`box${i}@example.com`);
        }
        // The queue is at MAX_ACTIONS; setReject must not throw here — it
        // purges the 100 forwards and leaves one reject behind.
        message.setReject('not allowed');
      });
      const actions = await dispatchToHandler(makeEnvelope(), handler);
      expect(actions).toEqual([{ type: 'reject', reason: 'not allowed' }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('parseEmail can be called multiple times (cache replays)', async () => {
    // parseEmail caches the buffered raw bytes in a WeakMap keyed by the
    // proxy, so handlers can call it repeatedly without the underlying
    // ReadableStream being "already consumed". After parseEmail, accessing
    // message.raw still yields a usable ReadableStream (a fresh one per
    // access, backed by the cached bytes).
    let firstSubject: string | undefined;
    let secondSubject: string | undefined;
    let rawAfterParse: ReadableStream<Uint8Array> | undefined;
    const handler = defineEmail(async (message) => {
      const first = await parseEmail(message);
      firstSubject = first.subject;
      const second = await parseEmail(message);
      secondSubject = second.subject;
      rawAfterParse = message.raw;
    });
    await dispatchToHandler(makeEnvelope(), handler);
    expect(firstSubject).toBe('Help me');
    expect(secondSubject).toBe('Help me');
    // message.raw is a fresh ReadableStream each access, replayed from cache.
    expect(rawAfterParse).toBeInstanceOf(ReadableStream);
    const reader = rawAfterParse?.getReader();
    const chunks: Array<Uint8Array> = [];
    while (reader) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBeGreaterThan(0);
    const decoded = new TextDecoder().decode(
      chunks.reduce((acc, c) => {
        const merged = new Uint8Array(acc.byteLength + c.byteLength);
        merged.set(acc, 0);
        merged.set(c, acc.byteLength);
        return merged;
      }, new Uint8Array(0)),
    );
    expect(decoded).toContain('Subject: Help me');
  });

  it('returns an empty action queue when the handler does nothing', async () => {
    const handler = defineEmail(async () => {});
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toEqual([]);
  });
});
