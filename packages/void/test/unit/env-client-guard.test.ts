import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { envClientGuardPlugin } from '../../src/plugin-env-client-guard.ts';
import { string } from '../../src/runtime/env-helpers.ts';
import { defineEnv } from '../../src/runtime/env-public.ts';

const ROOT = '/project';
type MessagePayload =
  | string
  | { message: string; loc?: { line: number; column: number; file: string } };
type TransformHandler = (
  this: ReturnType<typeof makeContext>,
  code: string,
  id: string,
) => unknown | Promise<unknown>;
type HookWithHandler<T> = { handler: T };

type ContextHooks = {
  errors: Array<{ message: string; loc?: { line: number; column: number; file: string } }>;
  warnings: Array<{
    message: string;
    loc?: { line: number; column: number; file: string };
  }>;
  environmentName: string;
};

function makeContext(environmentName = 'client'): ContextHooks & {
  error: (e: MessagePayload) => never;
  warn: (w: MessagePayload) => void;
  environment: { name: string };
} {
  const ctx: ContextHooks & {
    error: (e: MessagePayload) => never;
    warn: (w: MessagePayload) => void;
    environment: { name: string };
  } = {
    errors: [],
    warnings: [],
    environmentName,
    environment: { name: environmentName },
    error(payload: MessagePayload) {
      const e = typeof payload === 'string' ? { message: payload } : payload;
      ctx.errors.push(e);
      const err = new Error(e.message);
      throw err;
    },
    warn(payload: MessagePayload) {
      const w = typeof payload === 'string' ? { message: payload } : payload;
      ctx.warnings.push(w);
    },
  };
  return ctx;
}

function getTransformHandler(plugin: ReturnType<typeof envClientGuardPlugin>): TransformHandler {
  const t = plugin.transform;
  if (typeof t === 'function') {
    return t as unknown as TransformHandler;
  }
  if (t && typeof t === 'object' && 'handler' in t) {
    return (t as unknown as HookWithHandler<TransformHandler>).handler;
  }
  throw new Error('plugin.transform missing handler');
}

async function runTransform(
  ctx: ReturnType<typeof makeContext>,
  code: string,
  id: string,
): Promise<{ threw: boolean; error?: Error }> {
  const handler = getTransformHandler(envClientGuardPlugin(ROOT));
  try {
    await handler.call(ctx, code, id);
    return { threw: false };
  } catch (err) {
    return { threw: true, error: err as Error };
  }
}

// Reset registered schema between tests.
function resetSchema() {
  defineEnv({});
}

// Force `_hasRegisteredSchema()` to return false by reaching into the
// module's internals — simulates "no env.ts in project". The defineEnv
// flag is one-way (can't be unset), so we mock the module instead for
// the no-schema test.
async function withNoSchema(fn: () => Promise<void>): Promise<void> {
  const mod = await import('../../src/runtime/env-public.ts');
  vi.spyOn(mod, '_hasRegisteredSchema').mockReturnValue(false);
  vi.spyOn(mod, '_getRegisteredSchema').mockReturnValue(null);
  try {
    await fn();
  } finally {
    vi.restoreAllMocks();
  }
}

describe('envClientGuardPlugin', () => {
  it.each([
    `import { env } from 'void/env'; function local(env) { return env.SECRET; }`,
    `import { env } from 'void/env'; function local() { console.log(env.SECRET); var env; }`,
    `import { env } from 'void/env'; { console.log(env.SECRET); let env; }`,
    `import { env } from 'void/env'; try {} catch ({ env }) { console.log(env.SECRET); }`,
    `import * as ns from 'void/env'; const local = (ns) => ns.env.SECRET;`,
    `import { env } from 'void/env'; class Local { constructor(private env: any) { console.log(env.SECRET); } }`,
  ])('accepts reads belonging to local bindings: %s', async (code) => {
    defineEnv({ SECRET: string() });
    const ctx = makeContext();
    expect(await runTransform(ctx, code, `${ROOT}/src/page.ts`)).toEqual({ threw: false });
    expect(ctx.errors).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });

  it('still rejects an imported server key next to a shadowed read', async () => {
    defineEnv({ SECRET: string() });
    const ctx = makeContext();
    const result = await runTransform(
      ctx,
      `import { env } from 'void/env'; function local(env) { return env.SECRET; } console.log(env.SECRET);`,
      `${ROOT}/src/page.ts`,
    );
    expect(result.threw).toBe(true);
    expect(ctx.errors).toHaveLength(1);
  });

  beforeEach(() => {
    resetSchema();
  });

  it('errors when a server-only key is read in a client module', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const ctx = makeContext('client');
    const result = await runTransform(
      ctx,
      `import { env } from "void/env";\nconsole.log(env.STRIPE_KEY);\n`,
      `${ROOT}/src/page.ts`,
    );
    expect(result.threw).toBe(true);
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0]!.message).toContain('STRIPE_KEY');
    expect(ctx.errors[0]!.message).toContain('VITE_*');
    expect(ctx.errors[0]!.loc?.line).toBe(2);
  });

  it('does not error when the key is VITE_-prefixed', async () => {
    defineEnv({ VITE_TITLE: string() });
    const ctx = makeContext('client');
    const result = await runTransform(
      ctx,
      `import { env } from "void/env";\nconsole.log(env.VITE_TITLE);\n`,
      `${ROOT}/src/page.ts`,
    );
    expect(result.threw).toBe(false);
    expect(ctx.errors).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });

  it('catches renamed imports (`import { env as e }`)', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const ctx = makeContext('client');
    const result = await runTransform(
      ctx,
      `import { env as e } from "void/env";\nconst k = e.STRIPE_KEY;\n`,
      `${ROOT}/src/page.ts`,
    );
    expect(result.threw).toBe(true);
    expect(ctx.errors[0]!.message).toContain('STRIPE_KEY');
  });

  it('catches namespace imports (`import * as voidEnv`)', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const ctx = makeContext('client');
    const result = await runTransform(
      ctx,
      `import * as voidEnv from "void/env";\nconst k = voidEnv.env.STRIPE_KEY;\n`,
      `${ROOT}/src/page.ts`,
    );
    expect(result.threw).toBe(true);
    expect(ctx.errors[0]!.message).toContain('STRIPE_KEY');
  });

  it('passes through keys not present in the schema (could be a binding or typo)', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const ctx = makeContext('client');
    const result = await runTransform(
      ctx,
      `import { env } from "void/env";\nconst k = env.RANDOM_THING;\n`,
      `${ROOT}/src/page.ts`,
    );
    expect(result.threw).toBe(false);
    expect(ctx.errors).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });

  it('warns (does not error) on computed access', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const ctx = makeContext('client');
    const result = await runTransform(
      ctx,
      `import { env } from "void/env";\nconst key = "STRIPE_KEY";\nconst k = env[key];\n`,
      `${ROOT}/src/page.ts`,
    );
    expect(result.threw).toBe(false);
    expect(ctx.errors).toEqual([]);
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]!.message).toMatch(/Computed access/);
  });

  it('is a no-op when no env schema is registered', async () => {
    await withNoSchema(async () => {
      const ctx = makeContext('client');
      const result = await runTransform(
        ctx,
        `import { env } from "void/env";\nconsole.log(env.STRIPE_KEY);\n`,
        `${ROOT}/src/page.ts`,
      );
      expect(result.threw).toBe(false);
      expect(ctx.errors).toEqual([]);
      expect(ctx.warnings).toEqual([]);
    });
  });

  it('takes a fast path when the source has no `void/env` import', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const ctx = makeContext('client');
    // env.STRIPE_KEY here is just an arbitrary identifier — there's no
    // void/env import to bind it to, so the guard should not trigger.
    const result = await runTransform(
      ctx,
      `const env = { STRIPE_KEY: "x" };\nconsole.log(env.STRIPE_KEY);\n`,
      `${ROOT}/src/page.ts`,
    );
    expect(result.threw).toBe(false);
    expect(ctx.errors).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });

  it('is a no-op for non-client environments (e.g. ssr / worker)', async () => {
    defineEnv({ STRIPE_KEY: string() });
    for (const envName of ['ssr', 'worker', 'rsc']) {
      const ctx = makeContext(envName);
      const result = await runTransform(
        ctx,
        `import { env } from "void/env";\nconsole.log(env.STRIPE_KEY);\n`,
        `${ROOT}/src/page.ts`,
      );
      expect(result.threw, `env ${envName} should not throw`).toBe(false);
      expect(ctx.errors).toEqual([]);
      expect(ctx.warnings).toEqual([]);
    }
  });

  it('skips node_modules', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const ctx = makeContext('client');
    const result = await runTransform(
      ctx,
      `import { env } from "void/env";\nconsole.log(env.STRIPE_KEY);\n`,
      `${ROOT}/node_modules/some-lib/dist/index.js`,
    );
    expect(result.threw).toBe(false);
    expect(ctx.errors).toEqual([]);
  });

  it('reports file:line:col in error message', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const ctx = makeContext('client');
    const code = [
      `import { env } from "void/env";`,
      ``,
      `export function f() {`,
      `  return env.STRIPE_KEY;`,
      `}`,
    ].join('\n');
    const result = await runTransform(ctx, code, `${ROOT}/src/page.ts`);
    expect(result.threw).toBe(true);
    expect(ctx.errors[0]!.loc).toEqual({
      line: 4,
      column: 10,
      file: `${ROOT}/src/page.ts`,
    });
    expect(ctx.errors[0]!.message).toContain('src/page.ts:4:10');
  });

  it('handles SFC virtual modules with `?vue&type=script&lang.ts` query', async () => {
    defineEnv({ STRIPE_KEY: string() });
    const ctx = makeContext('client');
    const result = await runTransform(
      ctx,
      `import { env } from "void/env";\nconsole.log(env.STRIPE_KEY);\n`,
      `${ROOT}/pages/index.vue?vue&type=script&setup=true&lang.ts`,
    );
    expect(result.threw).toBe(true);
    expect(ctx.errors).toHaveLength(1);
  });
});
