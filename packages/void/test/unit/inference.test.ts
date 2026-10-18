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
  needsImages: false,
  usesImageOptimizer: false,
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
    ['c.env.IMAGES', 'needsImages'],
    ['env.IMAGES', 'needsImages'],
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

describe('inferBindingsFromSource image usage', () => {
  const usesImage = (code: string): boolean | undefined =>
    inferBindingsFromSource(code, 'view.tsx').usesImageOptimizer;

  it.each([
    "import { Image } from '@void/react';",
    "import { Image } from '@void/vue';",
    "import { Image } from '@void/svelte';",
    "import { Image } from '@void/solid';",
    "import { getImageProps } from '@void/react';",
    "import { Image as Picture, Link } from '@void/react';",
    "import { Link, type ImageProps, Image } from '@void/react';",
    "import Image from '@void/react/image';",
    "import NextImage, { type ImageProps } from '@void/react/image';",
    "import { Image } from '@void/react/image';",
    "import { getImageProps } from '@void/react/image';",
    "import { getImageProps } from 'void/image';",
    "import * as Void from '@void/react';\nexport const View = () => <Void.Image src='/a.png' alt='' />;",
    "import * as Void from '@void/react';\nconst { props } = Void.getImageProps({ src: '/a.png', alt: '' });",
    "import * as img from 'void/image';\nimg.getImageProps({ src: '/a.png', alt: '' });",
    "export { Image } from '@void/react';",
    "export { Image as Picture } from '@void/vue';",
    "export { default } from '@void/react/image';",
    "export { default as Image } from '@void/react/image';",
    "export * from '@void/react/image';",
    "export { getImageProps } from 'void/image';",
    "const load = () => import('void/image');",
    "const load = () => import('@void/react/image');",
    // `next/image` aliased to `@void/react/image` when migrating from Next.js.
    "import Image from 'next/image';",
    "import NextImage, { getImageProps } from 'next/image';",
    "import { getImageProps } from 'next/image';",
    "import { Image } from 'next/image';",
    "import * as Next from 'next/image';\nexport const View = () => <Next.default src='/a.png' alt='' />;",
    "export { default as Image } from 'next/image';",
    "const load = () => import('next/image');",
  ])('detects %s', (code) => {
    expect(usesImage(code)).toBe(true);
  });

  it.each([
    "import { Link, useForm } from '@void/react';",
    "import type { ImageProps } from '@void/react';",
    "import { type ImageProps } from '@void/react';",
    "import type Image from '@void/react/image';",
    "import type { Image } from '@void/vue';",
    "export type { ImageProps } from '@void/react';",
    "export { type Image } from '@void/react';",
    "import '@void/react';",
    "import '@void/react/image';",
    "import 'void/image';",
    "export * from '@void/react';",
    "const load = () => import('@void/react');",
    "import { defaultLoader, findClosestQuality } from 'void/image';",
    "import type { ImageLoader } from 'void/image';",
    "import * as Void from '@void/react';\nexport const View = () => <Void.Link href='/' />;",
    "import * as Void from '@void/react';\nexport const value = other.Void.Image;",
    "import { Image } from './components/image';",
    "import type Image from 'next/image';",
    "import type { ImageProps } from 'next/image';",
    "import 'next/image';",
    "import * as Next from 'next/image';\nexport type Props = Next.ImageProps;",
    "import Image from 'next/legacy/image';",
    "import Image from '@void/vue/image';",
  ])('ignores %s', (code) => {
    expect(usesImage(code)).toBe(false);
  });

  it('records Image usage without requiring the Images binding', () => {
    expect(inferBindingsFromSource("import { Image } from '@void/react';", 'view.tsx')).toEqual({
      ...NO_BINDINGS,
      usesImageOptimizer: true,
    });
  });

  it('detects Image usage and an env.IMAGES read in one file', () => {
    const code = `
      import { getImageProps } from 'void/image';
      export const GET = defineHandler((c) => c.env.IMAGES.info(stream));
    `;
    expect(inferBindingsFromSource(code, 'route.ts')).toEqual({
      ...NO_BINDINGS,
      needsImages: true,
      usesImageOptimizer: true,
    });
  });

  it('does not detect needsImages from unrelated identifiers', () => {
    const code = `
      const IMAGES = ['/a.png'];
      export const list = config.images.IMAGES;
    `;
    expect(inferBindingsFromSource(code, 'list.ts')).toEqual(NO_BINDINGS);
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
