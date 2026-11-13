import { afterEach, describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { boolean, email, json, number, oneOf, string, url } from '../../src/runtime/env-helpers.ts';
import {
  defineEnv,
  env,
  EnvValidationError,
  validateAllEnv,
  _getRegisteredSchema,
  _getSchemaDefaults,
  _hasRegisteredSchema,
  _prepareEnv,
  _validateEnvOnce,
} from '../../src/runtime/env-public.ts';
import { getRuntimeBinding, requireRuntimeBinding, withRuntimeEnv } from '../../src/runtime/env.ts';
import { ENV_REGISTRY_KEY } from '../../src/shared/env-registry.ts';

// Reset schema between tests so order doesn't leak state.
function resetSchema() {
  defineEnv({});
}

describe('env helpers (Standard Schema)', () => {
  it('string accepts any value, rejects missing', () => {
    expect(string()['~standard'].validate('hello')).toEqual({ value: 'hello' });
    const result = string()['~standard'].validate(undefined);
    expect('issues' in result && result.issues).toBeTruthy();
  });

  it('number parses and rejects NaN', () => {
    expect(number()['~standard'].validate('42')).toEqual({ value: 42 });
    const bad = number()['~standard'].validate('not-a-number');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('boolean accepts true/false/1/0 case-insensitively', () => {
    expect(boolean()['~standard'].validate('true')).toEqual({ value: true });
    expect(boolean()['~standard'].validate('FALSE')).toEqual({ value: false });
    expect(boolean()['~standard'].validate('1')).toEqual({ value: true });
    expect(boolean()['~standard'].validate('0')).toEqual({ value: false });
    const bad = boolean()['~standard'].validate('maybe');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('url validates with new URL()', () => {
    expect(url()['~standard'].validate('https://example.com')).toEqual({
      value: 'https://example.com',
    });
    const bad = url()['~standard'].validate('not a url');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('email validates basic shape', () => {
    expect(email()['~standard'].validate('a@b.com')).toEqual({ value: 'a@b.com' });
    const bad = email()['~standard'].validate('nope');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('oneOf restricts to enum members', () => {
    const schema = oneOf(['development', 'production'] as const);
    expect(schema['~standard'].validate('production')).toEqual({ value: 'production' });
    const bad = schema['~standard'].validate('staging');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('json parses JSON strings', () => {
    const schema = json<{ a: number }>();
    expect(schema['~standard'].validate('{"a":1}')).toEqual({ value: { a: 1 } });
    const bad = schema['~standard'].validate('{not json}');
    expect('issues' in bad && bad.issues).toBeTruthy();
  });

  it('.optional() makes missing valid (returns undefined)', () => {
    const schema = string().optional();
    expect(schema['~standard'].validate(undefined)).toEqual({ value: undefined });
    expect(schema['~standard'].validate('')).toEqual({ value: undefined });
    expect(schema['~standard'].validate('value')).toEqual({ value: 'value' });
  });

  it('.default() supplies a fallback for missing values', () => {
    const schema = number().default(42);
    expect(schema['~standard'].validate(undefined)).toEqual({ value: 42 });
    expect(schema['~standard'].validate('')).toEqual({ value: 42 });
    expect(schema['~standard'].validate('7')).toEqual({ value: 7 });
  });
});

describe('defineEnv + env proxy', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('registers schema and exposes typed values via env proxy', () => {
    defineEnv({
      STRIPE_KEY: string(),
      PORT: number().default(3000),
    });
    withRuntimeEnv({ STRIPE_KEY: 'sk_test', PORT: '4000' }, () => {
      expect(env.STRIPE_KEY).toBe('sk_test');
      expect(env.PORT).toBe(4000);
    });
  });

  it('applies defaults when env value is missing', () => {
    defineEnv({ PORT: number().default(3000) });
    withRuntimeEnv({}, () => {
      expect(env.PORT).toBe(3000);
    });
  });

  it('throws EnvValidationError on access to invalid value', () => {
    defineEnv({ PORT: number() });
    withRuntimeEnv({ PORT: 'not-a-number' }, () => {
      expect(() => env.PORT).toThrow(EnvValidationError);
    });
  });

  it('throws EnvValidationError on access to missing required key', () => {
    defineEnv({ STRIPE_KEY: string() });
    withRuntimeEnv({}, () => {
      expect(() => env.STRIPE_KEY).toThrow(EnvValidationError);
    });
  });

  it('passes through bindings/unknown keys without validation', () => {
    defineEnv({ STRIPE_KEY: string() });
    const fakeDb = { binding: true };
    withRuntimeEnv({ STRIPE_KEY: 'sk', DB: fakeDb }, () => {
      expect(env.DB).toBe(fakeDb);
    });
  });

  it('passes through Object.prototype members without validation', () => {
    defineEnv({ STRIPE_KEY: string() });
    withRuntimeEnv({ STRIPE_KEY: 'sk' }, () => {
      expect(env.hasOwnProperty).toBe(Object.prototype.hasOwnProperty);
      expect(env.constructor).toBe(Object);
      expect(String(env)).toBe('[object Object]');
    });
  });

  it('caches validated values per env identity (no re-validation)', () => {
    let calls = 0;
    const inner = string();
    const counted = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) => {
          calls++;
          return inner['~standard'].validate(v);
        },
      },
    };
    defineEnv({ X: counted });
    const e = { X: 'hello' };
    withRuntimeEnv(e, () => {
      void env.X;
      void env.X;
      void env.X;
    });
    expect(calls).toBe(1);
  });

  it('exposes registered schema via _getRegisteredSchema', () => {
    defineEnv({ FOO: string() });
    expect(Object.keys(_getRegisteredSchema() ?? {})).toEqual(['FOO']);
  });

  it('_hasRegisteredSchema distinguishes defineEnv({}) from never-called', () => {
    // resetSchema() already called defineEnv({}) in beforeEach.
    expect(_hasRegisteredSchema()).toBe(true);
    // Registered schema is still an empty object — not null — but the
    // presence flag tells us defineEnv was explicitly invoked.
    expect(_getRegisteredSchema()).toEqual({});
    // Calling with a real schema also keeps the flag on.
    defineEnv({ FOO: string() });
    expect(_hasRegisteredSchema()).toBe(true);
  });
});

describe('redaction', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('validateAllEnv redacts invalid values from its messages', async () => {
    defineEnv({ PORT: number() });
    const bad = await validateAllEnv({ PORT: 'sk_live_abc123' });
    expect(bad.valid).toBe(false);
    const msg = bad.invalid[0]!.messages.join(' ');
    expect(msg).not.toContain('sk_live_abc123');
    expect(msg).toContain('<redacted>');
  });

  it('runtime proxy throws EnvValidationError with redacted message', () => {
    defineEnv({ STRIPE_KEY: url() });
    withRuntimeEnv({ STRIPE_KEY: 'sk_live_abc_not_a_url' }, () => {
      try {
        void env.STRIPE_KEY;
        throw new Error('expected throw');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain('sk_live_abc_not_a_url');
        expect(msg).toContain('STRIPE_KEY'); // key name survives
        expect(msg).toContain('<redacted>');
      }
    });
  });
});

describe('validateAllEnv (used by dev plugin and CLI)', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('reports valid when all keys satisfied', async () => {
    defineEnv({ STRIPE_KEY: string(), PORT: number().default(3000) });
    const report = await validateAllEnv({ STRIPE_KEY: 'sk' });
    expect(report.valid).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.invalid).toEqual([]);
  });

  it('separates missing vs invalid', async () => {
    defineEnv({
      STRIPE_KEY: string(),
      PORT: number(),
      MODE: oneOf(['a', 'b'] as const),
    });
    const report = await validateAllEnv({ PORT: 'not-num', MODE: 'c' });
    expect(report.valid).toBe(false);
    expect(report.missing).toEqual(['STRIPE_KEY']);
    expect(report.invalid.map((i) => i.key).sort()).toEqual(['MODE', 'PORT']);
  });

  it('returns valid=true when no schema registered', async () => {
    // After resetSchema(), the schema is empty {} — still counts as registered.
    const report = await validateAllEnv({});
    expect(report.valid).toBe(true);
  });

  it('awaits async Standard Schema validators', async () => {
    const asyncValidator = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          await Promise.resolve();
          if (typeof v === 'string' && v.startsWith('ok-')) {
            return { value: v.slice(3) };
          }
          return { issues: [{ message: 'must start with ok-' }] };
        },
      },
    };
    defineEnv({ TOKEN: asyncValidator });
    const good = await validateAllEnv({ TOKEN: 'ok-value' });
    expect(good.valid).toBe(true);
    expect(good.values.get('TOKEN')).toBe('value');

    // Reset the boot state before re-registering to avoid stale caching.
    defineEnv({ TOKEN: asyncValidator });
    const bad = await validateAllEnv({ TOKEN: 'nope' });
    expect(bad.valid).toBe(false);
    expect(bad.invalid.map((i) => i.key)).toEqual(['TOKEN']);
  });
});

describe('_validateEnvOnce (boot-time worker check)', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('passes when env satisfies the schema', async () => {
    defineEnv({ STRIPE_KEY: string() });
    await expect(_validateEnvOnce({ STRIPE_KEY: 'sk_test' })).resolves.toBeUndefined();
  });

  it('throws EnvValidationError listing all missing/invalid keys', async () => {
    defineEnv({ STRIPE_KEY: string(), PORT: number() });
    await expect(_validateEnvOnce({ PORT: 'oops' })).rejects.toBeInstanceOf(EnvValidationError);
    try {
      await _validateEnvOnce({ PORT: 'oops' });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('STRIPE_KEY is required');
      expect(msg).toContain('PORT');
    }
  });

  it('caches success — schema is only run once per isolate', async () => {
    let calls = 0;
    const inner = string();
    const counted = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) => {
          calls++;
          return inner['~standard'].validate(v);
        },
      },
    };
    defineEnv({ X: counted });
    await _validateEnvOnce({ X: 'hello' });
    await _validateEnvOnce({ X: 'hello' });
    await _validateEnvOnce({ X: 'hello' });
    expect(calls).toBe(1);
  });

  it('caches failure so repeat calls re-throw the same error', async () => {
    defineEnv({ STRIPE_KEY: string() });
    let firstError: unknown;
    let secondError: unknown;
    try {
      await _validateEnvOnce({});
    } catch (e) {
      firstError = e;
    }
    try {
      await _validateEnvOnce({});
    } catch (e) {
      secondError = e;
    }
    expect(firstError).toBe(secondError);
  });

  it('is a no-op for an empty schema', async () => {
    await expect(_validateEnvOnce(undefined)).resolves.toBeUndefined();
  });

  it('is reset by a new defineEnv call (HMR semantics)', async () => {
    defineEnv({ A: string() });
    await expect(_validateEnvOnce({})).rejects.toBeInstanceOf(EnvValidationError);
    // Re-import / HMR: schema swaps, boot state resets, new env satisfies new schema
    defineEnv({ B: string() });
    await expect(_validateEnvOnce({ B: 'value' })).resolves.toBeUndefined();
  });

  it('awaits async validators and caches resolved values for sync proxy reads', async () => {
    const asyncUpper = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          await Promise.resolve();
          return typeof v === 'string'
            ? { value: v.toUpperCase() }
            : { issues: [{ message: 'must be a string' }] };
        },
      },
    };
    defineEnv({ TOKEN: asyncUpper });
    const rawEnv = { TOKEN: 'sk_test' };
    // Pre-validate seeds the cache so subsequent sync reads are free.
    await withRuntimeEnv(rawEnv, async () => {
      await _validateEnvOnce(rawEnv);
      expect(env.TOKEN).toBe('SK_TEST');
    });
  });

  it('rethrows from async validator failure', async () => {
    const alwaysFail = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async () => {
          await Promise.resolve();
          return { issues: [{ message: 'nope' }] };
        },
      },
    };
    defineEnv({ TOKEN: alwaysFail });
    await expect(_validateEnvOnce({ TOKEN: 'anything' })).rejects.toBeInstanceOf(
      EnvValidationError,
    );
  });

  describe('serving async values to reads', () => {
    const upper = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          await Promise.resolve();
          return { value: String(v).toUpperCase() };
        },
      },
    };

    // Void's Worker entry validates before it opens the request scope that reads run in.
    it('serves them in a request scope opened after validation', async () => {
      defineEnv({ TOKEN: upper });
      const rawEnv = { TOKEN: 'sk_test' };
      await _validateEnvOnce(rawEnv);
      withRuntimeEnv(rawEnv, () => {
        expect(env.TOKEN).toBe('SK_TEST');
      });
    });

    // Reads can use an object that validation never received, such as the remote dev copy.
    it('serves them to another env object that holds the same values', async () => {
      defineEnv({ TOKEN: upper });
      await _validateEnvOnce({ TOKEN: 'sk_test' });
      withRuntimeEnv({ TOKEN: 'sk_test' }, () => {
        expect(env.TOKEN).toBe('SK_TEST');
      });
    });

    it('serves each key by its own raw value', async () => {
      defineEnv({ PLAIN: string(), TOKEN: upper });
      await _validateEnvOnce({ PLAIN: 'a', TOKEN: 'a' });
      // TOKEN holds another value: the validated one is not served, and it has no async value.
      withRuntimeEnv({ PLAIN: 'a', TOKEN: 'b' }, () => {
        expect(env.PLAIN).toBe('a');
        expect(() => env.TOKEN).toThrow(/Async validator for 'TOKEN'/);
      });
      // Only PLAIN holds another value: TOKEN's raw value is the validated one.
      withRuntimeEnv({ PLAIN: 'b', TOKEN: 'a' }, () => {
        expect([env.PLAIN, env.TOKEN]).toEqual(['b', 'A']);
      });
    });

    // A validation is reused only for an env with the same values.
    it('validates an env with other values again', async () => {
      defineEnv({ PLAIN: string(), TOKEN: upper });
      for (const value of ['a', 'b']) {
        const rawEnv = { PLAIN: value, TOKEN: value };
        await _validateEnvOnce(rawEnv);
        withRuntimeEnv(rawEnv, () => {
          expect([env.PLAIN, env.TOKEN]).toEqual([value, value.toUpperCase()]);
        });
      }
    });

    // Cloudflare can keep an isolate running when only its bindings change, so a request that
    // holds the old values can still run when one with the new values validates.
    it('keeps serving an env after an env with other values validates', async () => {
      defineEnv({ TOKEN: upper });
      const before = { TOKEN: 'a' };
      // Another object with the same values reuses the validation of the first.
      const reused = { TOKEN: 'a' };
      const after = { TOKEN: 'b' };
      await _validateEnvOnce(before);
      await _validateEnvOnce(reused);
      await _validateEnvOnce(after);
      for (const rawEnv of [before, reused]) {
        withRuntimeEnv(rawEnv, () => {
          expect(env.TOKEN).toBe('A');
        });
      }
      withRuntimeEnv(after, () => {
        expect(env.TOKEN).toBe('B');
      });
    });

    it('validates again once a failing value changes', async () => {
      defineEnv({ TOKEN: string() });
      await expect(_validateEnvOnce({})).rejects.toBeInstanceOf(EnvValidationError);
      const fixed = { TOKEN: 'sk_test' };
      await expect(_validateEnvOnce(fixed)).resolves.toBeUndefined();
      withRuntimeEnv(fixed, () => {
        expect(env.TOKEN).toBe('sk_test');
      });
    });

    // Reads outside a request scope use an env of their own: in workerd, the
    // `cloudflare:workers` env, which is not the object that handlers receive.
    describe('outside a request scope', () => {
      const globalScope = globalThis as { __env__?: unknown };

      afterEach(() => {
        delete globalScope.__env__;
      });

      it('serves them when that env holds the same values', async () => {
        defineEnv({ TOKEN: upper });
        globalScope.__env__ = { TOKEN: 'sk_test' };
        await _validateEnvOnce({ TOKEN: 'sk_test' });
        expect(env.TOKEN).toBe('SK_TEST');
      });

      it('does not serve them when that env holds other values', async () => {
        defineEnv({ PLAIN: string(), TOKEN: upper });
        globalScope.__env__ = { PLAIN: 'other', TOKEN: 'other' };
        await _validateEnvOnce({ PLAIN: 'sk_test', TOKEN: 'sk_test' });
        expect(env.PLAIN).toBe('other');
        expect(() => env.TOKEN).toThrow(/Async validator for 'TOKEN'/);
      });

      it('stops serving them once that env holds another value', async () => {
        defineEnv({ TOKEN: upper });
        const outside = { TOKEN: 'sk_test' };
        globalScope.__env__ = outside;
        await _validateEnvOnce({ TOKEN: 'sk_test' });
        expect(env.TOKEN).toBe('SK_TEST');
        outside.TOKEN = 'other';
        expect(() => env.TOKEN).toThrow(/Async validator for 'TOKEN'/);
      });
    });
  });

  it('runs a validator that throws again on the next call', async () => {
    let calls = 0;
    const flaky = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          calls++;
          if (calls === 1) {
            throw new Error('lookup failed');
          }
          return { value: v };
        },
      },
    };
    defineEnv({ TOKEN: flaky });
    await expect(_validateEnvOnce({ TOKEN: 'sk_test' })).rejects.toThrow('lookup failed');
    await expect(_validateEnvOnce({ TOKEN: 'sk_test' })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  // In workerd, a validation that waits on the I/O of a canceled request never settles.
  it('does not wait on a validation that another call left unfinished', async () => {
    let calls = 0;
    const stalls = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => {
          calls++;
          return calls === 1 ? new Promise<never>(() => {}) : Promise.resolve({ value });
        },
      },
    };
    defineEnv({ TOKEN: stalls });
    void _validateEnvOnce({ TOKEN: 'sk_test' });
    await expect(settlesWithin(_validateEnvOnce({ TOKEN: 'sk_test' }), 1000)).resolves.toBe(
      undefined,
    );
  });

  // HMR can register a new schema while a validation awaits.
  it('validates with a schema registered while it waited', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tagged = (tag: string, wait?: Promise<void>) => ({
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (value: unknown) => {
          await wait;
          return { value: `${tag}:${String(value)}` };
        },
      },
    });
    defineEnv({ TOKEN: tagged('old', gate) });
    const rawEnv = { TOKEN: 'sk_test' };
    const validating = _validateEnvOnce(rawEnv);
    defineEnv({ TOKEN: tagged('new') });
    release();
    await validating;
    withRuntimeEnv(rawEnv, () => {
      expect(env.TOKEN).toBe('new:sk_test');
    });
  });
});

/** Rejects when `promise` is still pending after `ms`, rather than at the test timeout. */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('_validateEnvOnce — internal bindings stay hidden from void/env', () => {
  beforeEach(() => {
    resetSchema();
  });

  const passthrough = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (v: unknown) => ({ value: v }),
    },
  };

  it('hides a schema-declared ISR_CACHE while ISR is active, even after boot validation', async () => {
    defineEnv({ ISR_CACHE: passthrough, API_KEY: string() });

    const fakeIsrKv = { __brand: 'isr-kv' };
    // `__VOID_ISR_DEPLOYMENT_ID` present ⇒ ISR active ⇒ ISR_CACHE is internal.
    const rawEnv = { ISR_CACHE: fakeIsrKv, API_KEY: 'sk_live', __VOID_ISR_DEPLOYMENT_ID: 'dep_1' };

    await withRuntimeEnv(rawEnv, async () => {
      // Boot validation runs before the first env read, as at worker boot.
      await _validateEnvOnce(rawEnv);

      expect((env as Record<string, unknown>).ISR_CACHE).toBeUndefined();
      expect('ISR_CACHE' in env).toBe(false);
      expect(Object.keys(env)).not.toContain('ISR_CACHE');
      expect(getRuntimeBinding('ISR_CACHE')).toBeUndefined();
      expect(() => requireRuntimeBinding('ISR_CACHE')).toThrow(
        "env: Missing Cloudflare binding 'ISR_CACHE'.",
      );
      expect(env.API_KEY).toBe('sk_live');
    });
  });

  it('exposes a schema-declared ISR_CACHE when ISR is inactive (no __VOID_ISR_DEPLOYMENT_ID)', async () => {
    defineEnv({ ISR_CACHE: passthrough, API_KEY: string() });

    const fakeIsrKv = { __brand: 'user-kv' };
    const rawEnv = { ISR_CACHE: fakeIsrKv, API_KEY: 'sk_live' };

    await withRuntimeEnv(rawEnv, async () => {
      await _validateEnvOnce(rawEnv);

      expect((env as Record<string, unknown>).ISR_CACHE).toEqual(fakeIsrKv);
      expect('ISR_CACHE' in env).toBe(true);
      expect(Object.keys(env)).toContain('ISR_CACHE');

      expect(getRuntimeBinding('ISR_CACHE')).toEqual(fakeIsrKv);
      expect(requireRuntimeBinding('ISR_CACHE')).toEqual(fakeIsrKv);

      expect(env.API_KEY).toBe('sk_live');
    });
  });
});

/** An async validator that upper-cases a string, with the number of times it ran. */
function asyncUpper() {
  const calls = { count: 0 };
  const validator = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: async (value: unknown) => {
        calls.count++;
        await Promise.resolve();
        return typeof value === 'string'
          ? { value: value.toUpperCase() }
          : { issues: [{ message: 'must be a string' }] };
      },
    },
  };
  return { validator, calls };
}

describe('_prepareEnv (framework Worker entries)', () => {
  beforeEach(resetSchema);

  it('serves defaults, converted values and async results to synchronous reads', async () => {
    defineEnv({ PORT: number().default(48213), DEBUG: boolean(), TOKEN: asyncUpper().validator });
    const rawEnv = { DEBUG: 'false', TOKEN: 'sk_test' };
    await _prepareEnv(rawEnv);
    withRuntimeEnv(rawEnv, () => {
      expect([env.PORT, env.DEBUG, env.TOKEN]).toEqual([48213, false, 'SK_TEST']);
    });
  });

  it('resolves with invalid keys, and fails only the reads of those keys', async () => {
    const crash = new Error('validator crashed');
    defineEnv({
      PORT: number().default(3000),
      STRIPE_KEY: string(),
      TOKEN: asyncUpper().validator,
      CRASH: {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate: async () => {
            throw crash;
          },
        },
      },
    });
    const rawEnv = {};
    await expect(_prepareEnv(rawEnv)).resolves.toBeUndefined();
    withRuntimeEnv(rawEnv, () => {
      expect(env.PORT).toBe(3000);
      expect(() => env.STRIPE_KEY).toThrow(EnvValidationError);
      // A read cannot run an async validator, but it throws the failure that validation found.
      expect(() => env.TOKEN).toThrow('Invalid env "TOKEN": must be a string');
      expect(() => env.CRASH).toThrow(crash);
    });
  });

  it('redacts the raw value from the failure of an async validator', async () => {
    defineEnv({
      TOKEN: {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate: async (value: unknown) => ({
            issues: [{ message: `rejected ${String(value)}` }],
          }),
        },
      },
    });
    const rawEnv = { TOKEN: 'sk_live_abc123' };
    await _prepareEnv(rawEnv);
    withRuntimeEnv(rawEnv, () => {
      expect(() => env.TOKEN).toThrow('Invalid env "TOKEN": rejected <redacted>');
    });
  });

  it('validates once for the same raw values, and again for other values', async () => {
    const { validator, calls } = asyncUpper();
    defineEnv({ TOKEN: validator });
    await _prepareEnv({ TOKEN: 'a' });
    // A dev server can hand each request a new env object.
    const same = { TOKEN: 'a' };
    await _prepareEnv(same);
    expect(calls.count).toBe(1);
    const other = { TOKEN: 'b' };
    await _prepareEnv(other);
    expect(calls.count).toBe(2);
    withRuntimeEnv(same, () => {
      expect(env.TOKEN).toBe('A');
    });
    withRuntimeEnv(other, () => {
      expect(env.TOKEN).toBe('B');
    });
  });

  // A lookup that a validator makes can fail once and succeed for a later request.
  it('runs a validator that threw again on the next call', async () => {
    const lookupFailed = new Error('lookup failed');
    let calls = 0;
    defineEnv({
      TOKEN: {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate: async (value: unknown) => {
            calls++;
            if (calls === 1) {
              throw lookupFailed;
            }
            return { value };
          },
        },
      },
    });
    const rawEnv = { TOKEN: 'sk_test' };
    await _prepareEnv(rawEnv);
    withRuntimeEnv(rawEnv, () => {
      expect(() => env.TOKEN).toThrow(lookupFailed);
    });
    await _prepareEnv(rawEnv);
    withRuntimeEnv(rawEnv, () => {
      expect(env.TOKEN).toBe('sk_test');
    });
    expect(calls).toBe(2);
  });

  it('resolves without an env, as in a prerender in Node', async () => {
    defineEnv({ STRIPE_KEY: string() });
    await expect(_prepareEnv(undefined)).resolves.toBeUndefined();
  });

  // A D1 app's handler receives one env object, and its reads use another: the
  // `cloudflare:workers` env. Nuxt's global env stands in for it here.
  describe('outside a request scope', () => {
    const globalScope = globalThis as { __env__?: unknown };

    afterEach(() => {
      delete globalScope.__env__;
    });

    it('serves the results, failures included, while that env holds the same values', async () => {
      defineEnv({
        PORT: number().default(3000),
        TOKEN: asyncUpper().validator,
        SECRET: asyncUpper().validator,
      });
      const outside = { TOKEN: 'sk_test' };
      globalScope.__env__ = outside;
      await _prepareEnv({ TOKEN: 'sk_test' });
      expect(env.PORT).toBe(3000);
      expect(env.TOKEN).toBe('SK_TEST');
      expect(() => env.SECRET).toThrow('Invalid env "SECRET": must be a string');
      outside.TOKEN = 'other';
      expect(() => env.TOKEN).toThrow(/Async validator for 'TOKEN'/);
    });
  });
});

describe('several copies of void/env in one Worker', () => {
  // `void deploy` bundles a framework app's cron and queue jobs with a copy of their own.
  const registry = () =>
    (globalThis as Record<symbol, { prepare?: typeof _prepareEnv } | undefined>)[
      Symbol.for(ENV_REGISTRY_KEY)
    ];

  async function secondCopy() {
    vi.resetModules();
    return await import('../../src/runtime/env-public.ts');
  }

  beforeEach(resetSchema);

  it('reads the values that the copy holding the schema prepared', async () => {
    const copy = await secondCopy();
    expect(copy.defineEnv).not.toBe(defineEnv);
    defineEnv({ TOKEN: asyncUpper().validator, PORT: number().default(48213) });
    const rawEnv = { TOKEN: 'sk_test' };
    await registry()?.prepare?.(rawEnv);
    withRuntimeEnv(rawEnv, () => {
      expect([copy.env.TOKEN, copy.env.PORT]).toEqual(['SK_TEST', 48213]);
    });
  });

  it('publishes the _prepareEnv of the copy that registered the schema', async () => {
    const copy = await secondCopy();
    defineEnv({ KEY: string() });
    expect(registry()?.prepare).toBeTypeOf('function');
    expect(registry()?.prepare).toBe(_prepareEnv);
    copy.defineEnv({ KEY: string() });
    expect(registry()?.prepare).toBe(copy._prepareEnv);
  });

  it('forgets results in every copy when a schema is registered again', async () => {
    const copy = await secondCopy();
    defineEnv({ PORT: number() });
    withRuntimeEnv({ PORT: '3000' }, () => {
      expect(copy.env.PORT).toBe(3000);
      defineEnv({ PORT: string() });
      expect(copy.env.PORT).toBe('3000');
    });
  });
});

describe('env proxy with async validators', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('throws a helpful error when sync proxy read hits an async validator (no pre-validation)', () => {
    const asyncValidator = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          await Promise.resolve();
          return typeof v === 'string' ? { value: v } : { issues: [{ message: 'must be string' }] };
        },
      },
    };
    defineEnv({ TOKEN: asyncValidator });
    withRuntimeEnv({ TOKEN: 'value' }, () => {
      expect(() => env.TOKEN).toThrow(/env: Async validator for 'TOKEN'/);
      expect(() => env.TOKEN).toThrow(/_validateEnvOnce/);
    });
  });
});

describe('_getSchemaDefaults (used by plugin and deploy CLI)', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('returns defaults for keys with .default(value)', () => {
    defineEnv({
      PORT: number().default(3000),
      MODE: oneOf(['dev', 'prod'] as const).default('dev'),
      DEBUG: boolean().default(false),
    });
    const defaults = _getSchemaDefaults();
    expect(defaults).toEqual({ PORT: '3000', MODE: 'dev', DEBUG: 'false' });
  });

  it('omits required keys (no default)', () => {
    defineEnv({ STRIPE_KEY: string(), PORT: number().default(3000) });
    const defaults = _getSchemaDefaults();
    expect(defaults).toEqual({ PORT: '3000' });
    expect(defaults).not.toHaveProperty('STRIPE_KEY');
  });

  it('omits .optional() keys without a default (undefined value)', () => {
    defineEnv({ DEBUG: string().optional(), MODE: string().default('x') });
    const defaults = _getSchemaDefaults();
    expect(defaults).toEqual({ MODE: 'x' });
    expect(defaults).not.toHaveProperty('DEBUG');
  });

  it('returns {} when no schema is registered', () => {
    expect(_getSchemaDefaults()).toEqual({});
  });

  it('skips async validators (cannot extract sync default)', () => {
    const asyncWithoutDefault = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async (v: unknown) => {
          await Promise.resolve();
          return v === undefined ? { value: 'never-used' } : { value: v };
        },
      },
    };
    defineEnv({ ASYNC: asyncWithoutDefault, SYNC: string().default('s') });
    expect(_getSchemaDefaults()).toEqual({ SYNC: 's' });
  });

  it('stringifies non-string default values', () => {
    defineEnv({
      PORT: number().default(8080),
      ON: boolean().default(true),
    });
    const defaults = _getSchemaDefaults();
    expect(defaults.PORT).toBe('8080');
    expect(defaults.ON).toBe('true');
  });
});
