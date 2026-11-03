import { describe, expect, it } from 'vite-plus/test';
import {
  inferBindingsFromSource,
  mergeBindings,
  type InferredBindings,
} from '../../src/inference/walk.ts';

const NO_BINDINGS: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
  needsLive: false,
  needsEmail: false,
};

const MODULE_BINDINGS = [
  ['void/db', 'needsD1'],
  ['void/kv', 'needsKV'],
  ['void/storage', 'needsR2'],
  ['void/auth', 'needsAuth'],
  ['void/queues', 'needsQueues'],
  ['void/ai', 'needsAI'],
  ['void/sandbox', 'needsSandbox'],
  ['void/email', 'needsEmail'],
  ['void/live', 'needsLive'],
] as const;

describe('inferBindingsFromSource', () => {
  it.each([
    'import { auth as account } from "void/client";',
    'import { "auth" as account } from "void/client";',
    'import { \\u0061uth as account } from "void/client";',
    'import * as client from "void/client"; client.auth.signOut();',
    'import * as client from "void/client/react"; client["auth"].useSession();',
    'import * as client from "void/client"; client["\\x61uth"].signOut();',
    'import * as client from "void/client"; client["aut\\h"].signOut();',
    'import * as client from "void/client"; client["au\\\nth"].signOut();',
    'import * as client from "void/client"; const { auth: account } = client;',
    'import * as client from "void/client"; const alias = client; alias.auth.signOut();',
    'import * as client from "void/client"; namespace Local { export const client = {}; } client.auth.signOut();',
    'const { auth } = await import("void/client");',
    'const client = await import("void/client"); client.auth.signOut();',
    'const value = (await import("void/client"))["auth"];',
    'async function run() { const client = await import("void/client"); client["\\141uth"].signOut(); }',
    'export { auth as account } from "void/client";',
    'export { "\\x61uth" as account } from "void/client";',
    'export * from "void/client";',
    'export * as client from "void/client";',
  ])('infers auth from the imported runtime value: %s', (code) => {
    expect(inferBindingsFromSource(code, 'test.ts')).toEqual({ ...NO_BINDINGS, needsAuth: true });
  });

  it.each([
    'import { fetch as auth } from "void/client";',
    'import { fetch /* auth */ } from "void/client";',
    'import { type auth, fetch } from "void/client";',
    'import type * as client from "void/client"; type T = typeof client.auth;',
    'import * as client from "void/client"; client.fetch("/api");',
    'import * as client from "void/client"; const parts = text.split(/\\s+/); client.fetch("/api");',
    'import * as client from "void/client"; function local(client) { return client.auth; }',
    'import * as client from "void/client"; function local() { client.auth(); var client; }',
    'import * as client from "void/client"; class Local { constructor(private client: any) { client.auth(); } }',
    'import * as client from "void/client"; function local() { enum client { auth }; return client.auth; }',
    'import * as client from "void/client"; const { fetch: auth } = client;',
    'import * as client from "void/client"; client[key];',
    'import * as client from "void/client"; const a = b; const b = a; a.auth;',
    'const { fetch: auth } = await import("void/client");',
    'const client = await import("void/client"); function local(client) { return client.auth; }',
    'export { fetch as auth } from "void/client";',
    'export { type auth, fetch } from "void/client";',
    'export type * from "void/client";',
  ])('ignores aliases, type-only names and unrelated auth properties: %s', (code) => {
    expect(inferBindingsFromSource(code, 'test.ts')).toEqual(NO_BINDINGS);
  });

  it('resolves long namespace alias chains without overflowing the stack', () => {
    const aliases = Array.from(
      { length: 10_000 },
      (_, index) => `const alias${index + 1} = alias${index};`,
    ).join('\n');
    const code = `import * as client from 'void/client'; const alias0 = client;
      ${aliases}
      alias10000.auth.signOut();`;
    expect(inferBindingsFromSource(code, 'test.ts')).toEqual({ ...NO_BINDINGS, needsAuth: true });
  });

  it.each([
    'const { DB, KV: cache } = c.env;',
    'const { ["DB"]: db, [`KV`]: cache } = env;',
    'const { env: { DB, KV } } = c;',
    'export const handler = ({ env: { DB, KV } }) => [DB, KV];',
    'function handler({ env: { DB, KV } = fallback }) {}',
    'function handler({ DB, KV } = env) {}',
    'const { DB, KV } = c.env as Env;',
    '({ DB, KV } = c.env);',
    'const value = [c.env["DB"], env[`KV`]];',
    'const value = [c["env"].DB, c.env?.KV];',
    'const value = [c.env /* keep */ .DB, env // keep\n .KV];',
    'const value = [env.D\\u0042, e\\u006ev.KV];',
    'const value = [c["e\\x6ev"].DB, c["e\\x6ev"].KV];',
    'const value = [c.env["\\x44B"], c.env["\\x4bV"]];',
    'const value = [c.env["D\\B"], c.env["K\\V"]];',
    'const value = [c["\\145nv"]["\\104B"], c["\\145nv"]["\\113V"]];',
    'const value = [c["en\\\nv"]["D\\\nB"], c["en\\\nv"]["K\\\nV"]];',
  ])('infers resources across static env access forms: %s', (code) => {
    expect(inferBindingsFromSource(code, 'test.ts')).toEqual({
      ...NO_BINDINGS,
      needsD1: true,
      needsKV: true,
    });
  });

  it.each([
    'const { DB: env } = unrelated;',
    'const { helper = DB } = env;',
    'const { [DB]: helper } = env;',
    'const value = env[key];',
    'const value = c[env].DB;',
    'const { env: { helper: DB } } = context;',
    'const { env: { SEND_EMAIL } } = context;',
    'const { env: { nested: { DB } } } = context;',
  ])('does not guess dynamic keys or mistake bound names for resources: %s', (code) => {
    expect(inferBindingsFromSource(code, 'test.ts')).toEqual(NO_BINDINGS);
  });

  it('infers every supported resource from renamed destructured properties', () => {
    expect(
      inferBindingsFromSource(
        'const { STORAGE: bucket, AI: ai, SANDBOX: sandbox, QUEUE_EMAILS: queue } = env;',
        'test.ts',
      ),
    ).toEqual({
      ...NO_BINDINGS,
      needsR2: true,
      needsAI: true,
      needsSandbox: true,
      needsQueues: true,
    });
  });

  it.each([
    "const load = () => import('void/ai');",
    'const load = () => import(`void/ai`);',
    "const load = () => import('void/\\u0061i');",
    "const load = () => import(('void/ai'));",
  ])('detects literal dynamic imports in TSX: %s', (statement) => {
    expect(inferBindingsFromSource(`${statement}\nconst view = <div />;`, 'view.tsx').needsAI).toBe(
      true,
    );
  });

  it.each([
    "type T = import('void/ai').AI;",
    "import type {} from 'void/ai';",
    "import { /* keep */ type AI } from 'void/ai';",
    "export type * from 'void/ai';",
    "const load = () => import('void/' + feature);",
    'const load = () => import(`void/${feature}`);',
    '// import("void/ai")\nconst text = "void/ai";',
  ])('does not infer runtime bindings from %s', (code) => {
    expect(inferBindingsFromSource(code, 'test.ts').needsAI).toBe(false);
  });

  it.each([
    "import {} from 'void/ai';",
    "export {} from 'void/ai';",
    "export /* keep */ {} from 'void/ai';",
    "export { /* keep */ } from 'void/ai';",
  ])('retains side-effect module references: %s', (code) => {
    expect(inferBindingsFromSource(code, 'test.ts').needsAI).toBe(true);
  });

  it.each([
    ['c.env.DB', 'needsD1'],
    ['env.DB', 'needsD1'],
    ['c.env.KV', 'needsKV'],
    ['c.env.STORAGE', 'needsR2'],
    ['c.env.QUEUE_EMAILS', 'needsQueues'],
    ['c.env.AI', 'needsAI'],
    ['env.AI', 'needsAI'],
    ['c.env.SANDBOX', 'needsSandbox'],
  ] as const)('detects %s access', (expression, binding) => {
    const code = `export async function handler(c, env) {\n  return ${expression}.get('key');\n}`;
    expect(inferBindingsFromSource(code, 'test.ts')).toEqual({ ...NO_BINDINGS, [binding]: true });
  });

  it('detects multiple bindings in one file', () => {
    const code = `
      export default defineHandler(async (c) => {
        const user = c.env.DB.prepare('SELECT 1').first()
        await c.env.KV.set('key', 'val')
        return user
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(true);
    expect(result.needsR2).toBe(false);
  });

  it('ignores unrelated member expressions', () => {
    const code = `
      const x = foo.bar.DB
      const y = something.env.other
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsD1).toBe(false);
  });

  it('returns empty for files with no bindings', () => {
    const code = `
      export default defineHandler(() => {
        return { status: 'ok' }
      })
    `;
    expect(inferBindingsFromSource(code, 'test.ts')).toEqual(NO_BINDINGS);
  });

  it.each(MODULE_BINDINGS)('detects value imports from %s', (source, binding) => {
    const code = `import { feature } from '${source}';`;
    expect(inferBindingsFromSource(code, 'test.ts')).toEqual({ ...NO_BINDINGS, [binding]: true });
  });

  it('handles invalid code gracefully', () => {
    const result = inferBindingsFromSource('not { valid {{{ code', 'bad.ts');
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
    expect(result.needsAuth).toBe(false);
  });

  it("detects import { auth } from 'void/client'", () => {
    const code = `
      import { auth } from "void/client";
      await auth.signOut();
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAuth).toBe(true);
  });

  it("detects auth imports from 'void/client' alongside other client helpers", () => {
    const code = `
      import { auth, fetch } from "void/client";
      await auth.signIn.email({ email, password });
      await fetch("/api/hello");
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAuth).toBe(true);
  });

  it("detects auth imports from framework-specific 'void/client' subpaths", () => {
    const code = `
      import { auth } from "void/client/react";
      await auth.useSession();
    `;
    const result = inferBindingsFromSource(code, 'test.tsx');
    expect(result.needsAuth).toBe(true);
  });

  it("does not detect auth from 'void/client' when only fetch is imported", () => {
    const code = `
      import { fetch } from "void/client";
      const data = await fetch("/api/hello");
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAuth).toBe(false);
  });

  it("does not detect auth from framework-specific 'void/client' subpaths when only fetch is imported", () => {
    const code = `
      import { fetch } from "void/client/react";
      const data = await fetch("/api/hello");
    `;
    const result = inferBindingsFromSource(code, 'test.tsx');
    expect(result.needsAuth).toBe(false);
  });

  it.each(MODULE_BINDINGS)('ignores type-only imports from %s', (source, binding) => {
    const named = inferBindingsFromSource(`import type { Feature } from '${source}';`, 'types.ts');
    const inline = inferBindingsFromSource(`import { type Feature } from '${source}';`, 'types.ts');
    expect(named[binding]).toBe(false);
    expect(inline[binding]).toBe(false);
  });

  it('ignores type-only AI imports in TSX while retaining value imports', () => {
    const typeOnly = `
      import type { AI } from 'void/ai';
      export const View = () => <div>AI</div>;
    `;
    expect(inferBindingsFromSource(typeOnly, 'View.tsx').needsAI).toBe(false);

    const mixed = `
      import { type AI, ai } from 'void/ai';
      export const View = () => <div>{String(ai)}</div>;
    `;
    expect(inferBindingsFromSource(mixed, 'View.tsx').needsAI).toBe(true);
  });

  it('detects a runtime AI import after an unrelated type import in TSX', () => {
    const code = `
      import type { Props } from './types';
      import { ai } from 'void/ai';
      export const View = () => <div>{String(ai)}</div>;
    `;
    expect(inferBindingsFromSource(code, 'View.tsx').needsAI).toBe(true);
  });

  it('ignores type-only AI re-exports but keeps runtime re-exports', () => {
    expect(inferBindingsFromSource("export type { AI } from 'void/ai';", 'types.ts').needsAI).toBe(
      false,
    );
    expect(inferBindingsFromSource("export { type AI } from 'void/ai';", 'types.ts').needsAI).toBe(
      false,
    );
    expect(inferBindingsFromSource("export { ai } from 'void/ai';", 'index.ts').needsAI).toBe(true);
  });

  it('does not infer email from env.SEND_EMAIL access', () => {
    const code = `
      export const POST = defineHandler(async (c) => {
        return c.env.SEND_EMAIL.send(message);
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsEmail).toBe(false);
  });

  it('does not detect needsAI from unrelated identifiers', () => {
    const code = `
      const AI = someLibrary;
      export const GET = defineHandler(() => {
        return { status: 'ok' }
      })
    `;
    const result = inferBindingsFromSource(code, 'test.ts');
    expect(result.needsAI).toBe(false);
  });

  it("does not detect live infrastructure from 'void/live/client'", () => {
    const code = `
      import { connectLiveStream } from "void/live/client";
      connectLiveStream("/live");
    `;
    const result = inferBindingsFromSource(code, 'client.ts');
    expect(result.needsLive).toBe(false);
  });
});

describe('mergeBindings', () => {
  const flags = Object.keys(NO_BINDINGS) as Array<keyof InferredBindings>;

  it('merges multiple binding results (union)', () => {
    const merged = mergeBindings(flags.map((flag) => ({ ...NO_BINDINGS, [flag]: true })));
    expect(merged).toEqual(Object.fromEntries(flags.map((flag) => [flag, true])));
  });

  it.each(flags)('merges the %s flag alone', (flag) => {
    expect(mergeBindings([NO_BINDINGS, { ...NO_BINDINGS, [flag]: true }])).toEqual({
      ...NO_BINDINGS,
      [flag]: true,
    });
  });

  it('handles empty array', () => {
    expect(mergeBindings([])).toEqual(NO_BINDINGS);
  });
});
