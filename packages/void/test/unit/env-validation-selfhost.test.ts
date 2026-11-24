import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  computeInvalidEmittedKeys,
  createDefaultSecretListRunner,
  deriveSelfHostEnvContextFromVars,
  deriveSelfHostSchemaFacts,
  dischargeSelfHostEnvContext,
  readEmittedWorkerVars,
  secretListEnv,
  SelfHostEnvValidationError,
  SelfHostFirstDeployError,
  SelfHostSchemaError,
  SelfHostSecretListError,
} from '../../src/cli/env-validation.ts';
import type { SecretListRunResult, SelfHostSchemaFacts } from '../../src/cli/env-validation.ts';
import { number, string } from '../../src/runtime/env/helpers.ts';
import { defineEnv } from '../../src/runtime/env/public.ts';
import { _resetUnmaskCacheForTests } from '../../src/shared/env-mask.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

const roots: Array<string> = [];

function createTempProject(opts?: { withEnvTs?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'void-selfhost-env-'));
  roots.push(root);
  if (opts?.withEnvTs !== false) {
    // Empty module body is enough — schema is pre-registered via defineEnv.
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
  }
  return root;
}

beforeEach(() => {
  // The schema registry is process-wide; reset it between tests.
  defineEnv({});
});

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function stubRunner(result: SecretListRunResult): {
  run: (operation: CloudflareOperation) => SecretListRunResult;
  calls: Array<CloudflareOperation>;
} {
  const calls: Array<CloudflareOperation> = [];
  return {
    calls,
    run: (operation: CloudflareOperation) => {
      calls.push(operation);
      return result;
    },
  };
}

function okList(names: Array<string>): SecretListRunResult {
  return {
    stdout: '',
    data: names.map((name) => ({ name, type: 'secret_text' })),
    stderr: '',
    status: 0,
  };
}

const CONFIG_PATH = '/tmp/proj/wrangler.jsonc';

const requiredStripe: SelfHostSchemaFacts = {
  hasSchema: true,
  serverKeys: ['STRIPE_KEY'],
  requiredKeys: ['STRIPE_KEY'],
};

describe('deriveSelfHostEnvContextFromVars — ground-truth context from the emitted worker vars', () => {
  it('a required key ABSENT from the emitted vars is absent (only a remote secret can discharge it)', () => {
    const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);

    expect(ctx.absentRequired).toEqual(['STRIPE_KEY']);
    expect(ctx.invalidKeys).toEqual([]);
  });

  it('a required key PRESENT in the emitted vars is not absent', () => {
    const ctx = deriveSelfHostEnvContextFromVars({ STRIPE_KEY: 'sk_live' }, requiredStripe);

    expect(ctx.absentRequired).toEqual([]);
  });

  it('hasSchema:false yields the empty context shape (nothing to gate)', () => {
    const ctx = deriveSelfHostEnvContextFromVars(
      { STRIPE_KEY: '' },
      { hasSchema: false, serverKeys: [], requiredKeys: [] },
    );

    expect(ctx).toEqual({ hasSchema: false, absentRequired: [], invalidKeys: [] });
  });
});

describe('deriveSelfHostSchemaFacts — env-insensitive schema facts', () => {
  it('derives server and required key names while excluding client keys', async () => {
    const root = createTempProject();
    defineEnv({
      STRIPE_KEY: string(),
      API_URL: string(),
      GREETING: string().default('hi'),
      VITE_TITLE: string(),
    });

    const facts = await deriveSelfHostSchemaFacts(root);

    expect(facts.hasSchema).toBe(true);
    // STRIPE_KEY + API_URL reject `undefined` → required; GREETING has a default → not required.
    expect([...facts.requiredKeys].sort()).toEqual(['API_URL', 'STRIPE_KEY']);
    expect(facts.requiredKeys).not.toContain('GREETING');
    expect([...facts.serverKeys].sort()).toEqual(['API_URL', 'GREETING', 'STRIPE_KEY']);
  });

  it('a project with no env.ts has no schema facts', async () => {
    const root = createTempProject({ withEnvTs: false });

    const facts = await deriveSelfHostSchemaFacts(root);

    expect(facts).toEqual({ hasSchema: false, serverKeys: [], requiredKeys: [] });
  });

  const SENTINEL = 'SENTINEL-schema-sk_live_leak-QQZ';

  /** Everything an observer could read off the thrown schema error. */
  function serializeSchemaError(error: unknown): string {
    const e = error as SelfHostSchemaError & Record<string, unknown>;
    return JSON.stringify({
      name: e.name,
      message: e.message,
      stack: e.stack ?? '',
      reason: e.reason,
      own: e,
      ownStr: String(e),
    });
  }

  it('a validator that THROWS while probing requiredness becomes a values-free SelfHostSchemaError', async () => {
    const root = createTempProject();
    defineEnv({
      FOO: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate() {
            throw new Error(`validator rejected ${SENTINEL}`);
          },
        },
      } satisfies StandardSchemaV1<unknown, unknown>,
    });

    vi.stubEnv('VOID_ENV_UNMASK', '1');
    _resetUnmaskCacheForTests();
    try {
      const error = await deriveSelfHostSchemaFacts(root).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSchemaError);
      expect((error as SelfHostSchemaError).reason).toBe('schema-validation-error');
      expect((error as Error).message).not.toContain(SENTINEL);
      expect(serializeSchemaError(error)).not.toContain(SENTINEL);
    } finally {
      vi.unstubAllEnvs();
      _resetUnmaskCacheForTests();
    }
  });

  it('an env.ts that THROWS at evaluation becomes a values-free SelfHostSchemaError', async () => {
    const root = createTempProject({ withEnvTs: false });
    // loadUserEnvFile folds the thrown message into its own error; the boundary must drop it.
    writeFileSync(join(root, 'env.ts'), `throw new Error('env boom ${SENTINEL}');\n`);

    vi.stubEnv('VOID_ENV_UNMASK', '1');
    _resetUnmaskCacheForTests();
    try {
      const error = await deriveSelfHostSchemaFacts(root).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSchemaError);
      expect((error as SelfHostSchemaError).reason).toBe('schema-load-failed');
      expect((error as Error).message).not.toContain(SENTINEL);
      expect(serializeSchemaError(error)).not.toContain(SENTINEL);
    } finally {
      vi.unstubAllEnvs();
      _resetUnmaskCacheForTests();
    }
  });
});

describe('computeInvalidEmittedKeys — schema-invalid emitted values', () => {
  it('flags a required var whose emitted value fails the validator (present, non-empty, malformed)', async () => {
    const root = createTempProject();
    defineEnv({ PORT: number(), API_URL: string() });
    const invalid = await computeInvalidEmittedKeys(root, {
      PORT: 'not-a-number',
      API_URL: 'https://example.com',
    });
    expect(invalid).toEqual(['PORT']);
  });

  it('returns no invalid keys when every emitted value validates', async () => {
    const root = createTempProject();
    defineEnv({ PORT: number() });
    expect(await computeInvalidEmittedKeys(root, { PORT: '8080' })).toEqual([]);
  });

  it('does NOT count a genuinely-ABSENT required value as invalid (a remote secret can still discharge it)', async () => {
    const root = createTempProject();
    defineEnv({ PORT: number(), TOKEN: string() });
    expect(await computeInvalidEmittedKeys(root, {})).toEqual([]);
  });

  it('counts a required value SHIPPED empty (present in the emitted map but rejected)', async () => {
    const root = createTempProject();
    defineEnv({ TOKEN: string() });
    expect(await computeInvalidEmittedKeys(root, { TOKEN: '' })).toEqual(['TOKEN']);
  });

  it('flags an OPTIONAL validator key SHIPPED as "" or null (rejected but bucketed "missing")', async () => {
    const root = createTempProject();
    // Like `z.url().optional()`: accepts undefined, rejects "" and null.
    const optionalRejectingEmpty: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate(value) {
          if (value === undefined) {
            return { value: undefined };
          }
          if (typeof value === 'string' && value.length > 0) {
            return { value };
          }
          return { issues: [{ message: 'invalid' }] };
        },
      },
    };
    defineEnv({ OPT_URL: optionalRejectingEmpty });
    expect(await computeInvalidEmittedKeys(root, { OPT_URL: '' })).toEqual(['OPT_URL']);
    expect(await computeInvalidEmittedKeys(root, { OPT_URL: null })).toEqual(['OPT_URL']);
    expect(await computeInvalidEmittedKeys(root, { OPT_URL: 'https://ok.dev' })).toEqual([]);
    expect(await computeInvalidEmittedKeys(root, {})).toEqual([]);
  });
});

describe('readEmittedWorkerVars — ground-truth worker vars via the deploy pointer', () => {
  it('reads the vars the build baked into the generated wrangler config', () => {
    const root = createTempProject();
    mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
    writeFileSync(
      join(root, '.wrangler', 'deploy', 'config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
    );
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'ssr', 'wrangler.json'),
      JSON.stringify({ vars: { APP_NAME: 'demo', PORT: '8080' } }),
    );
    const result = readEmittedWorkerVars(root);
    expect(result).toEqual({ ok: true, vars: { APP_NAME: 'demo', PORT: '8080' } });
  });

  it('reads vars from a generated JSONC config with comments and trailing commas', () => {
    const root = createTempProject();
    mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
    writeFileSync(
      join(root, '.wrangler', 'deploy', 'config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.jsonc' }),
    );
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'ssr', 'wrangler.jsonc'),
      '{ // project config\n "vars": { "APP_NAME": "demo", }, }',
    );

    expect(readEmittedWorkerVars(root)).toEqual({ ok: true, vars: { APP_NAME: 'demo' } });
  });

  it('fails closed when the build wrote no deploy pointer', () => {
    const root = createTempProject();
    const result = readEmittedWorkerVars(root);
    expect(result.ok).toBe(false);
  });

  it('fails closed on a present-but-malformed vars field (array/scalar), never normalizes to {}', () => {
    for (const badVars of [[], 'nope', 42, null] as Array<unknown>) {
      const root = createTempProject();
      mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
      writeFileSync(
        join(root, '.wrangler', 'deploy', 'config.json'),
        JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
      );
      mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
      writeFileSync(join(root, 'dist', 'ssr', 'wrangler.json'), JSON.stringify({ vars: badVars }));
      const result = readEmittedWorkerVars(root);
      expect(result.ok).toBe(false);
    }
  });

  it('treats an ABSENT vars field as an empty map (a worker with no vars)', () => {
    const root = createTempProject();
    mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
    writeFileSync(
      join(root, '.wrangler', 'deploy', 'config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
    );
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(join(root, 'dist', 'ssr', 'wrangler.json'), JSON.stringify({ name: 'x' }));
    expect(readEmittedWorkerVars(root)).toEqual({ ok: true, vars: {} });
  });
});

describe('dischargeSelfHostEnvContext — ground-truth secret gate', () => {
  function writeConfig(root: string, config: Record<string, unknown>): string {
    const path = join(root, 'wrangler.jsonc');
    writeFileSync(path, JSON.stringify(config));
    return path;
  }

  it('a required key ABSENT from the emitted vars AND from the remote list fails CLOSED naming it', async () => {
    const root = createTempProject({ withEnvTs: false });
    const configPath = writeConfig(root, { name: 'app', account_id: 'acct-1' });
    const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
    const { run } = stubRunner(okList([]));

    const error = await dischargeSelfHostEnvContext(ctx, {
      root,
      configPath,
      accountId: 'acct-1',
      runWrangler: run,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SelfHostEnvValidationError);
    const envError = error as SelfHostEnvValidationError;
    expect(envError.message).toContain('STRIPE_KEY');
    expect(envError.message).toContain('void secret put');
  });

  it('a required key ABSENT locally but PRESENT as a remote secret is discharged using the pinned operation', async () => {
    const root = createTempProject({ withEnvTs: false });
    const configPath = writeConfig(root, { name: 'app', account_id: 'acct-1' });
    const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
    const { run, calls } = stubRunner(okList(['STRIPE_KEY']));

    await expect(
      dischargeSelfHostEnvContext(ctx, {
        root,
        configPath,
        accountId: 'acct-1',
        runWrangler: run,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([{ type: 'secret.list', configPath }]);
  });

  it('a folded INVALID key (an optional value the validator rejected) fails CLOSED with no wrangler spawn', async () => {
    const root = createTempProject({ withEnvTs: false });
    // A remote secret cannot fix a shipped invalid value, even with the same name.
    const ctx = deriveSelfHostEnvContextFromVars(
      {},
      { hasSchema: true, serverKeys: [], requiredKeys: [] },
    );
    ctx.invalidKeys = ['OPT_URL'];
    const { run, calls } = stubRunner(okList(['OPT_URL']));

    const error = await dischargeSelfHostEnvContext(ctx, {
      root,
      configPath: CONFIG_PATH,
      runWrangler: run,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SelfHostEnvValidationError);
    const envError = error as SelfHostEnvValidationError;
    expect(envError.message).toContain('OPT_URL');
    expect(calls).toEqual([]);
  });

  it('a no-schema context passes without consulting wrangler', async () => {
    const root = createTempProject({ withEnvTs: false });
    const ctx = deriveSelfHostEnvContextFromVars(
      {},
      { hasSchema: false, serverKeys: [], requiredKeys: [] },
    );
    const { run, calls } = stubRunner(okList([]));

    await expect(
      dischargeSelfHostEnvContext(ctx, {
        root,
        configPath: CONFIG_PATH,
        runWrangler: run,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  describe('account reconciliation before spawn', () => {
    it('hard-errors (naming both accounts) and NEVER spawns wrangler on a config-vs-option mismatch', async () => {
      const root = createTempProject({ withEnvTs: false });
      const configPath = writeConfig(root, { name: 'app', account_id: 'account-X' });
      // An absent required key would list secrets; the mismatch must stop it first.
      const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
      const { run, calls } = stubRunner(okList(['STRIPE_KEY']));

      const error = await dischargeSelfHostEnvContext(ctx, {
        root,
        configPath,
        accountId: 'account-Y',
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error).not.toBeInstanceOf(SelfHostEnvValidationError);
      const msg = (error as Error).message;
      expect(msg).toContain('account-X');
      expect(msg).toContain('account-Y');
      expect(calls).toEqual([]);
    });
  });

  describe('worker-name reconciliation before spawn', () => {
    it('hard-errors (naming both worker names) and NEVER spawns wrangler on a config-vs-pinned name mismatch', async () => {
      const root = createTempProject({ withEnvTs: false });
      const configPath = writeConfig(root, { name: 'evil-worker', account_id: 'acct-1' });
      const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
      const { run, calls } = stubRunner(okList(['STRIPE_KEY']));

      const error = await dischargeSelfHostEnvContext(ctx, {
        root,
        configPath,
        accountId: 'acct-1',
        workerName: 'app',
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error).not.toBeInstanceOf(SelfHostEnvValidationError);
      const msg = (error as Error).message;
      expect(msg).toContain('evil-worker');
      expect(msg).toContain('app');
      expect(calls).toEqual([]);
    });

    it('proceeds when the config name matches the pinned worker name', async () => {
      const root = createTempProject({ withEnvTs: false });
      const configPath = writeConfig(root, { name: 'app', account_id: 'acct-1' });
      const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
      const { run, calls } = stubRunner(okList(['STRIPE_KEY']));

      await expect(
        dischargeSelfHostEnvContext(ctx, {
          root,
          configPath,
          accountId: 'acct-1',
          workerName: 'app',
          runWrangler: run,
        }),
      ).resolves.toBeUndefined();
      expect(calls.length).toBe(1);
    });
  });

  describe('first-deploy worker-not-found', () => {
    const WORKER_NOT_FOUND_STDERR =
      'Worker "app" not found.\n\n' +
      'If this is a new Worker, run `wrangler deploy` first to create it.\n' +
      "Otherwise, check that the Worker name is correct and you're logged into the right account.";

    it('diagnostic prose cannot authorize a first deploy', async () => {
      const root = createTempProject({ withEnvTs: false });
      const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
      const { run } = stubRunner({ stdout: '', stderr: WORKER_NOT_FOUND_STDERR, status: 1 });
      const error = await dischargeSelfHostEnvContext(ctx, {
        root,
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).catch((error) => error);
      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error).not.toBeInstanceOf(SelfHostFirstDeployError);
      expect(error.message).toContain('reason: nonzero-exit');
    });

    it.each([{ errorCode: 10_007 }, { errorCode: 10_090 }, { failure: 'not-found' as const }])(
      'classifies structured missing-Worker results: %j',
      async (result) => {
        const root = createTempProject({ withEnvTs: false });
        const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
        const { run } = stubRunner({ stdout: '', stderr: '', status: 1, ...result });
        const error = await dischargeSelfHostEnvContext(ctx, {
          root,
          configPath: CONFIG_PATH,
          runWrangler: run,
        }).catch((error) => error);
        expect(error).toBeInstanceOf(SelfHostFirstDeployError);
        expect(error.message).toContain('void secret put STRIPE_KEY');
      },
    );

    it.each([null, Number.NaN, Infinity, -1])(
      'does not infer a first deploy from invalid exit status %s',
      async (status) => {
        const root = createTempProject({ withEnvTs: false });
        const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
        const { run } = stubRunner({
          stdout: '',
          stderr: '',
          status: status as number,
          errorCode: 10_007,
        });
        const error = await dischargeSelfHostEnvContext(ctx, {
          root,
          configPath: CONFIG_PATH,
          runWrangler: run,
        }).catch((error) => error);
        expect(error).toBeInstanceOf(SelfHostSecretListError);
        expect(error).not.toBeInstanceOf(SelfHostFirstDeployError);
      },
    );
  });

  describe('fail-closed wrangler failures', () => {
    async function expectSecretListError(
      result: SecretListRunResult,
    ): Promise<SelfHostSecretListError> {
      const root = createTempProject({ withEnvTs: false });
      const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
      const { run } = stubRunner(result);
      const error = await dischargeSelfHostEnvContext(ctx, {
        root,
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error).not.toBeInstanceOf(SelfHostEnvValidationError);
      return error as SelfHostSecretListError;
    }

    it('a nonzero exit is a hard failure classified structurally (never echoes stderr)', async () => {
      const error = await expectSecretListError({
        stdout: '',
        stderr: 'A request to the Cloudflare API failed.',
        status: 1,
      });
      expect(error.message).toContain('reason: nonzero-exit, status 1');
      expect(error.message).not.toContain('A request to the Cloudflare API failed.');
    });

    it('a signal-killed child is a hard failure even with status 0', async () => {
      const error = await expectSecretListError({
        stdout: '[]',
        stderr: '',
        status: 0,
        signal: 'SIGKILL',
        errorCode: 10_007,
        failure: 'not-found',
      });
      expect(error.message).toContain('reason: signal');
      expect(error.message).toContain('SIGKILL');
    });

    it('a spawn error is a hard failure classified structurally (never echoes the spawn text)', async () => {
      const error = await expectSecretListError({
        stdout: '[]',
        stderr: '',
        status: 0,
        error: 'spawn ENOENT',
        errorCode: 10_007,
        failure: 'not-found',
      });
      expect(error.message).toContain('reason: spawn-error');
      expect(error.message).not.toContain('spawn ENOENT');
    });

    it('a non-array JSON payload is a hard failure', async () => {
      await expectSecretListError({ stdout: '', data: { secrets: [] }, stderr: '', status: 0 });
    });

    it('ANY malformed list member fails the whole list (fail closed)', async () => {
      await expectSecretListError({
        stdout: '',
        data: [{ name: 'STRIPE_KEY' }, { oops: true }],
        stderr: '',
        status: 0,
      });
    });

    it('a non-string name is a malformed member', async () => {
      await expectSecretListError({
        stdout: '',
        data: [{ name: 123 }],
        stderr: '',
        status: 0,
      });
    });

    it('a rejecting seam is wrapped as a hard failure (never echoes the rejection message)', async () => {
      const root = createTempProject({ withEnvTs: false });
      const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
      const error = await dischargeSelfHostEnvContext(ctx, {
        root,
        configPath: CONFIG_PATH,
        runWrangler: () => Promise.reject(new Error('boom')),
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect((error as Error).message).toContain('reason: spawn-error');
      expect((error as Error).message).not.toContain('boom');
    });
  });

  describe('wrangler diagnostics are values-free even under VOID_ENV_UNMASK', () => {
    const SENTINEL = 'SENTINEL-sk_live_51H8xLeak-abcXYZ';

    /** Everything an observer could read off the thrown error. */
    function fullySerialize(error: unknown): string {
      const e = error as SelfHostSecretListError;
      return JSON.stringify({
        name: e.name,
        message: e.message,
        stack: e.stack ?? '',
        own: e,
        ownStr: String(e),
      });
    }

    it.each([
      {
        label: 'nonzero exit (sentinel in stderr)',
        result: { stdout: '', stderr: `boom ${SENTINEL}`, status: 1 } as SecretListRunResult,
        reason: 'nonzero-exit',
      },
      {
        label: 'signal (sentinel in stderr)',
        result: {
          stdout: '',
          stderr: `killed ${SENTINEL}`,
          status: 0,
          signal: 'SIGKILL',
        } as SecretListRunResult,
        reason: 'signal',
      },
      {
        label: 'spawn error (sentinel in the error text)',
        result: {
          stdout: '',
          stderr: '',
          status: 0,
          error: `spawn failed leaking ${SENTINEL}`,
        } as SecretListRunResult,
        reason: 'spawn-error',
      },
      {
        label: 'malformed stdout (sentinel in stdout)',
        result: { stdout: `not-json ${SENTINEL}`, stderr: '', status: 0 } as SecretListRunResult,
        reason: 'malformed-output',
      },
    ])(
      'the thrown error is sentinel-free in message/fields/JSON — $label',
      async ({ result, reason }) => {
        const root = createTempProject({ withEnvTs: false });
        const ctx = deriveSelfHostEnvContextFromVars({}, requiredStripe);
        const { run } = stubRunner(result);
        vi.stubEnv('VOID_ENV_UNMASK', '1');
        _resetUnmaskCacheForTests();
        try {
          const error = (await dischargeSelfHostEnvContext(ctx, {
            root,
            configPath: CONFIG_PATH,
            runWrangler: run,
          }).then(
            () => null,
            (e: unknown) => e,
          )) as SelfHostSecretListError;

          expect(error).toBeInstanceOf(SelfHostSecretListError);
          expect(error.message).toContain(`reason: ${reason}`);
          expect(error.message).not.toContain(SENTINEL);
          expect(fullySerialize(error)).not.toContain(SENTINEL);
        } finally {
          vi.unstubAllEnvs();
          _resetUnmaskCacheForTests();
        }
      },
    );

    it('first-deploy classification uses the provider code and keeps diagnostics sentinel-free', async () => {
      const root = createTempProject({ withEnvTs: false });
      const ctx = deriveSelfHostEnvContextFromVars(
        {},
        {
          hasSchema: true,
          serverKeys: ['FOO', 'API_TOKEN'],
          requiredKeys: ['FOO', 'API_TOKEN'],
        },
      );
      const { run } = stubRunner({
        stdout: '',
        stderr:
          `Worker "app" not found. ${SENTINEL}\n\n` +
          'If this is a new Worker, run `wrangler deploy` first to create it.\n' +
          "Otherwise, check that the Worker name is correct and you're logged into the right account.",
        status: 1,
        errorCode: 10_007,
      });

      const error = (await dischargeSelfHostEnvContext(ctx, {
        root,
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      )) as SelfHostFirstDeployError;

      expect(error).toBeInstanceOf(SelfHostFirstDeployError);
      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error.message).toContain('void secret put FOO');
      expect(error.message).toContain('void secret put API_TOKEN');
      expect(error.message).not.toContain(SENTINEL);
      expect(fullySerialize(error)).not.toContain(SENTINEL);
    });
  });
});

describe('createDefaultSecretListRunner — async spawn with fail-closed provenance', () => {
  function writeScript(root: string, name: string, source: string): string {
    const file = join(root, name);
    writeFileSync(file, source);
    return file;
  }

  it('captures stdout/stderr and a clean exit 0', async () => {
    const root = createTempProject({ withEnvTs: false });
    const script = writeScript(
      root,
      'ok.mjs',
      `const operation = JSON.parse(process.argv[2]);\n` +
        `if (operation.type !== 'secret.list' || operation.configPath !== ${JSON.stringify(CONFIG_PATH)}) process.exit(9);\n` +
        `process.stdout.write(JSON.stringify({ operationResult: 1, data: [{ name: 'FOO', type: 'secret_text' }] }));\n` +
        `process.stderr.write('note');\n`,
    );
    const run = createDefaultSecretListRunner(root, {
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
    });

    const result = await run({ type: 'secret.list', configPath: CONFIG_PATH });

    expect(result.status).toBe(0);
    expect(result.signal ?? null).toBeNull();
    expect(result.error ?? null).toBeNull();
    expect(result.data).toEqual([{ name: 'FOO', type: 'secret_text' }]);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('note');
  });

  it('reports a nonzero exit as-is (the gate classifies it as a hard failure)', async () => {
    const root = createTempProject({ withEnvTs: false });
    const script = writeScript(root, 'fail.mjs', `process.exit(3);\n`);
    const run = createDefaultSecretListRunner(root, {
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
    });

    const result = await run({ type: 'secret.list' });

    expect(result.status).toBe(3);
  });

  it('SIGKILLs a hung child at the hard timeout and reports the signal', async () => {
    const root = createTempProject({ withEnvTs: false });
    const script = writeScript(root, 'hang.mjs', `setInterval(() => {}, 1 << 30);\n`);
    const run = createDefaultSecretListRunner(root, {
      launcher: [process.execPath, script],
      timeoutMs: 300,
    });

    const result = await run({ type: 'secret.list' });

    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('timeout');
  }, 15_000);

  it('reports an unspawnable launcher as an error (never a clean exit)', async () => {
    const root = createTempProject({ withEnvTs: false });
    const run = createDefaultSecretListRunner(root, {
      launcher: [join(root, 'does-not-exist-binary')],
      timeoutMs: 5000,
    });

    const result = await run({ type: 'secret.list' });

    expect(result.error).toBeTruthy();
    expect(result.status).not.toBe(0);
  });

  describe('secretListEnv — child env pinning', () => {
    it('leaves ambient transport env (CLOUDFLARE_API_BASE_URL) untouched', () => {
      vi.stubEnv('CLOUDFLARE_API_BASE_URL', 'https://api.staging.example/client/v4');
      try {
        const env = secretListEnv('acct-1');
        expect(env.CLOUDFLARE_API_BASE_URL).toBe('https://api.staging.example/client/v4');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('scrubs every case-variant of scrubbed/pinned keys on win32 so no ambient spelling can shadow a pin', () => {
      vi.stubEnv('Cloudflare_Account_Id', 'ambient-other-account');
      vi.stubEnv('Wrangler_Log_Sanitize', 'false');
      vi.stubEnv('Cf_Access_Client_Id', 'id');
      try {
        const env = secretListEnv('acct-1', 'win32');
        expect(env.Cloudflare_Account_Id).toBeUndefined();
        expect(env.Wrangler_Log_Sanitize).toBeUndefined();
        expect(env.Cf_Access_Client_Id).toBeUndefined();
        expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct-1');
        expect(env.WRANGLER_LOG_SANITIZE).toBe('true');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('keeps case-variants on POSIX (genuinely different variables there)', () => {
      vi.stubEnv('Cloudflare_Account_Id', 'lowercase-cousin');
      try {
        const env = secretListEnv('acct-1', 'linux');
        expect(env.Cloudflare_Account_Id).toBe('lowercase-cousin');
        expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct-1');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('pins CLOUDFLARE_ACCOUNT_ID and scrubs the CF Access pair in the child env', async () => {
    const root = createTempProject({ withEnvTs: false });
    const script = writeScript(
      root,
      'env.mjs',
      `process.stdout.write(JSON.stringify({operationResult:1,data:{\n` +
        `  account: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,\n` +
        `  accessId: process.env.CF_ACCESS_CLIENT_ID ?? null,\n` +
        `  accessSecret: process.env.CF_ACCESS_CLIENT_SECRET ?? null,\n` +
        `  sanitize: process.env.WRANGLER_LOG_SANITIZE ?? null,\n` +
        `}}));\n`,
    );
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'service-token-id');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'service-token-secret');
    vi.stubEnv('WRANGLER_LOG_SANITIZE', 'false');
    try {
      const run = createDefaultSecretListRunner(root, {
        accountId: 'acct-123',
        launcher: [process.execPath, script],
        timeoutMs: 30_000,
      });

      const result = await run({ type: 'secret.list' });

      expect(result.status).toBe(0);
      expect(result.data).toEqual({
        account: 'acct-123',
        accessId: null,
        accessSecret: null,
        sanitize: 'true',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
