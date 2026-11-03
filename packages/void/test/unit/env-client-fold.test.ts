import { describe, expect, it } from 'vite-plus/test';
import { envClientFoldPlugin } from '../../src/plugin-env-client-fold.ts';

const ROOT = '/project';
type MessagePayload = string | { message: string };
type FoldContext = ReturnType<typeof makeContext>;
type TransformHandler = (this: FoldContext, code: string, id: string) => unknown | Promise<unknown>;
type ConfigResolvedHandler = (
  this: FoldContext,
  config: { env?: Record<string, string> },
) => unknown | Promise<unknown>;
type HookWithHandler<T> = { handler: T };

type TransformResult = {
  code?: string;
  map?: unknown;
};

function makeContext(environmentName = 'client') {
  return {
    environment: { name: environmentName },
    errors: [] as Array<{ message: string }>,
    warnings: [] as Array<{ message: string }>,
    error(payload: MessagePayload) {
      this.errors.push(typeof payload === 'string' ? { message: payload } : payload);
      throw new Error(typeof payload === 'string' ? payload : payload.message);
    },
    warn(payload: MessagePayload) {
      this.warnings.push(typeof payload === 'string' ? { message: payload } : payload);
    },
  };
}

function getTransformHandler(plugin: ReturnType<typeof envClientFoldPlugin>) {
  const t = plugin.transform;
  if (typeof t === 'function') {
    return t as unknown as TransformHandler;
  }
  if (t && typeof t === 'object' && 'handler' in t) {
    return (t as unknown as HookWithHandler<TransformHandler>).handler;
  }
  throw new Error('plugin.transform missing handler');
}

function getConfigResolvedHandler(plugin: ReturnType<typeof envClientFoldPlugin>) {
  const c = plugin.configResolved;
  if (typeof c === 'function') {
    return c as unknown as ConfigResolvedHandler;
  }
  if (c && typeof c === 'object' && 'handler' in c) {
    return (c as unknown as HookWithHandler<ConfigResolvedHandler>).handler;
  }
  return null;
}

type RunOpts = {
  env?: Record<string, string>;
  environmentName?: string;
};

async function runFold(
  code: string,
  id: string,
  opts: RunOpts = {},
): Promise<{ ctx: ReturnType<typeof makeContext>; result: TransformResult | undefined | null }> {
  const plugin = envClientFoldPlugin();
  const ctx = makeContext(opts.environmentName ?? 'client');
  const cr = getConfigResolvedHandler(plugin);
  if (cr) {
    await cr.call(ctx, { env: opts.env ?? {} });
  }
  const handler = getTransformHandler(plugin);
  const result = (await handler.call(ctx, code, id)) as TransformResult | undefined | null;
  return { ctx, result };
}

describe('envClientFoldPlugin', () => {
  it.each([
    'function title(env) { return env.VITE_TITLE; }',
    'const title = ({ env }) => env.VITE_TITLE;',
    'const title = (...env) => env.VITE_TITLE;',
    'function title() { console.log(env.VITE_TITLE); if (true) { var env = {}; } }',
    '{ console.log(env.VITE_TITLE); const env = {}; }',
    'try {} catch (env) { console.log(env.VITE_TITLE); }',
    'for (const env of values) { console.log(env.VITE_TITLE); }',
    'switch (value) { case 0: console.log(env.VITE_TITLE); break; default: let env; }',
    'const title = function env() { return env.VITE_TITLE; };',
    'const Title = class env { title() { return env.VITE_TITLE; } };',
    'class Title { static { console.log(env.VITE_TITLE); var env; } }',
    'class Title { constructor(private env: any) { console.log(env.VITE_TITLE); } }',
    'function title() { enum env { VITE_TITLE }; return env.VITE_TITLE; }',
    'namespace Local { export namespace env { export const VITE_TITLE = "local"; console.log(env.VITE_TITLE); } }',
  ])('preserves shadowed reads in %s', async (body) => {
    const code = `import { env } from 'void/env';\n${body}\nconsole.log(env.VITE_TITLE);`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'build title' },
    });
    expect(result?.code).toContain(body);
    expect(result?.code).toContain('console.log("build title");');
  });

  it('preserves a shadowed namespace and still folds the outer import', async () => {
    const body = 'function title(ns) { return ns.env.VITE_TITLE; }';
    const { result } = await runFold(
      `import * as ns from 'void/env'; ${body} console.log(ns.env.VITE_TITLE);`,
      `${ROOT}/src/page.ts`,
      { env: { VITE_TITLE: 'build title' } },
    );
    expect(result?.code).toContain(body);
    expect(result?.code).toContain('console.log("build title");');
  });

  it('folds imported reads in parameter defaults outside the body var scope', async () => {
    const { result } = await runFold(
      `import { env } from 'void/env'; function title(value = env.VITE_TITLE) { var env; return value; }`,
      `${ROOT}/src/page.ts`,
      { env: { VITE_TITLE: 'build title' } },
    );
    expect(result?.code).toContain('value = "build title"');
  });

  it('folds a switch discriminant outside the case block scope', async () => {
    const { result } = await runFold(
      `import { env } from 'void/env'; switch (env.VITE_TITLE) { default: let env; }`,
      `${ROOT}/src/page.ts`,
      { env: { VITE_TITLE: 'build title' } },
    );
    expect(result?.code).toContain('switch ("build title")');
  });

  it('keeps namespace declarations separate from surrounding imports', async () => {
    const body =
      'namespace Local { export const env = { VITE_TITLE: "local" }; console.log(env.VITE_TITLE); }';
    const { result } = await runFold(
      `import { env } from 'void/env'; ${body} console.log(env.VITE_TITLE);`,
      `${ROOT}/src/page.ts`,
      { env: { VITE_TITLE: 'build title' } },
    );
    expect(result?.code).toContain(body);
    expect(result?.code).toContain('console.log("build title");');
  });

  it('folds a VITE_-prefixed key with a .env value into a string literal', async () => {
    const code = `import { env } from "void/env";\nconsole.log(env.VITE_TITLE);\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'Hello' },
    });
    expect(result?.code).toBeDefined();
    expect(result!.code).toContain(`console.log("Hello")`);
    expect(result!.code).not.toContain('env.VITE_TITLE');
  });

  it('folds env["VITE_FOO"] bracket access with a string literal', async () => {
    const code = `import { env } from "void/env";\nconst v = env["VITE_API"];\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_API: 'https://api.example' },
    });
    expect(result?.code).toContain(`"https://api.example"`);
    expect(result!.code).not.toContain('env["VITE_API"]');
  });

  it('does NOT fold server-only keys (no prefix match)', async () => {
    const code = `import { env } from "void/env";\nconst v = env.STRIPE_KEY;\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      // Server keys aren't in config.env (Vite filters them out), but even
      // if a user somehow passes one, prefix enforcement keeps us honest.
      env: { STRIPE_KEY: 'sk_live_secret' },
    });
    expect(result).toBeFalsy();
  });

  it('leaves dynamic computed access (env[key]) for the runtime Proxy', async () => {
    const code = [
      `import { env } from "void/env";`,
      `const key = "VITE_TITLE";`,
      `console.log(env[key]);`,
    ].join('\n');
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'Hello' },
    });
    expect(result).toBeFalsy();
  });

  it('leaves unknown keys untouched so the runtime Proxy can serve them', async () => {
    const code = `import { env } from "void/env";\nconsole.log(env.VITE_MISSING);\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: {},
    });
    expect(result).toBeFalsy();
  });

  it('is a no-op for non-client environments (ssr / worker)', async () => {
    const code = `import { env } from "void/env";\nconsole.log(env.VITE_TITLE);\n`;
    for (const envName of ['ssr', 'worker', 'rsc']) {
      const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
        environmentName: envName,
        env: { VITE_TITLE: 'Hello' },
      });
      expect(result, `env ${envName}`).toBeFalsy();
    }
  });

  it('skips node_modules', async () => {
    const code = `import { env } from "void/env";\nconsole.log(env.VITE_TITLE);\n`;
    const { result } = await runFold(code, `${ROOT}/node_modules/lib/index.js`, {
      env: { VITE_TITLE: 'Hello' },
    });
    expect(result).toBeFalsy();
  });

  it('folds namespace imports (`import * as voidEnv`)', async () => {
    const code = `import * as voidEnv from "void/env";\nconst t = voidEnv.env.VITE_TITLE;\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'Ns' },
    });
    expect(result?.code).toContain(`"Ns"`);
    expect(result!.code).not.toContain('voidEnv.env.VITE_TITLE');
  });

  it('folds renamed imports (`import { env as e }`)', async () => {
    const code = `import { env as e } from "void/env";\nconst t = e.VITE_TITLE;\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'R' },
    });
    expect(result?.code).toContain(`"R"`);
  });

  it('fast-paths files with no `void/env` mention', async () => {
    const code = `const env = { VITE_TITLE: "x" };\nconsole.log(env.VITE_TITLE);\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'Hello' },
    });
    expect(result).toBeFalsy();
  });

  it('handles multiple folds in one file', async () => {
    const code = [`import { env } from "void/env";`, `console.log(env.VITE_A, env.VITE_B);`].join(
      '\n',
    );
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_A: '1', VITE_B: '2' },
    });
    expect(result?.code).toContain(`console.log("1", "2")`);
  });

  it('reports apply: build and enforce: post', () => {
    const plugin = envClientFoldPlugin();
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('post');
  });
});
