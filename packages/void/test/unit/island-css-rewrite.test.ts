import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizePath } from 'vite';
import { describe, it, expect } from 'vite-plus/test';
import {
  collectIslandStyles,
  extractCssImports,
  islandStyleRoots,
  rewriteCssImportForVirtualModule,
} from '../../src/pages/islands-plugin.ts';
import type { PageDefinition } from '../../src/pages/types.ts';

/** Resolve a POSIX-style absolute path to a platform-correct path with forward slashes. */
const p = (posix: string) => normalizePath(resolve(posix));

describe('rewriteCssImportForVirtualModule', () => {
  it('extracts only authored static CSS imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-island-css-'));
    try {
      const path = join(root, 'page.tsx');
      writeFileSync(
        path,
        `import './real.css';\nconst sample = \`example\nimport './fake.css'\`;\nawait import('./later.css');`,
      );
      expect(extractCssImports(path)).toBe('@import "./real.css";');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('rewrites relative CSS import to absolute path', () => {
    const result = rewriteCssImportForVirtualModule(
      'import "./global.css"',
      './global.css',
      p('/project/pages/layout.tsx'),
    );
    expect(result).toBe(`import "${p('/project/pages/global.css')}";`);
  });

  it('rewrites parent-relative CSS import to absolute path', () => {
    const result = rewriteCssImportForVirtualModule(
      'import "../styles/theme.css"',
      '../styles/theme.css',
      p('/project/pages/blog/index.tsx'),
    );
    expect(result).toBe(`import "${p('/project/pages/styles/theme.css')}";`);
  });

  it('preserves bare specifiers (package imports)', () => {
    const result = rewriteCssImportForVirtualModule(
      'import "@void/md/theme.css"',
      '@void/md/theme.css',
      p('/project/pages/layout.tsx'),
    );
    expect(result).toBe('import "@void/md/theme.css";');
  });

  it('preserves absolute specifiers', () => {
    const result = rewriteCssImportForVirtualModule(
      'import "/absolute/path/style.css"',
      '/absolute/path/style.css',
      p('/project/pages/layout.tsx'),
    );
    expect(result).toBe('import "/absolute/path/style.css";');
  });

  it('trims whitespace from non-relative imports', () => {
    const result = rewriteCssImportForVirtualModule(
      '  import "some-lib/styles.css"  ',
      'some-lib/styles.css',
      p('/project/pages/layout.tsx'),
    );
    expect(result).toBe('import "some-lib/styles.css";');
  });
});

describe('collectIslandStyles', () => {
  const graph: Record<string, Array<string>> = {
    '/app/pages/layout.tsx': [
      '/app/src/a.css',
      '/app/src/Shell.tsx',
      '/app/src/c.css',
      '\0virtual:generated.css',
    ],
    '/app/src/Shell.tsx': [
      '/app/src/b.css',
      '/app/src/a.css',
      '/app/src/raw.css?inline',
      '/app/src/link.css?url',
    ],
    '/app/pages/index.island.tsx': [
      '/app/src/Counter.tsx',
      '/app/src/Card.vue?vue&type=style&index=0&scoped=abc&lang.css',
    ],
    '/app/src/Counter.tsx': ['/app/src/counter.css'],
  };
  const getModuleInfo = (id: string) => (graph[id] ? { importedIds: graph[id] } : null);

  it('follows static imports in order, once each, into island components', () => {
    const styles = collectIslandStyles(getModuleInfo, [
      '/app/pages/layout.tsx',
      '/app/pages/index.island.tsx',
    ]);
    expect(styles).toEqual([
      '/app/src/a.css',
      '/app/src/b.css',
      '/app/src/c.css',
      '/app/src/counter.css',
      '/app/src/Card.vue?vue&type=style&index=0&scoped=abc&lang.css',
    ]);
  });

  it('returns null for a build without the pages', () => {
    expect(collectIslandStyles(getModuleInfo, ['/other/page.tsx'])).toBeNull();
  });
});

describe('islandStyleRoots', () => {
  const page = (componentPath: string, island: boolean) =>
    ({
      componentPath,
      componentId: componentPath.slice(0, componentPath.indexOf('.')),
      island,
    }) as PageDefinition;

  it('lists the layouts of island pages outermost first, then the pages, once each', () => {
    const roots = islandStyleRoots(
      {
        pages: [
          page('blog/post.island.tsx', true),
          page('regular.tsx', false),
          page('index.island.tsx', true),
          page('blog/list.md', true),
        ],
        layouts: [
          { directory: '', filePath: 'layout.tsx' },
          { directory: 'blog', filePath: 'blog/layout.tsx' },
        ],
        namedLayouts: [],
      },
      '/app/pages',
    );
    expect(roots).toEqual([
      p('/app/pages/layout.tsx'),
      p('/app/pages/blog/layout.tsx'),
      p('/app/pages/blog/post.island.tsx'),
      p('/app/pages/index.island.tsx'),
      p('/app/pages/blog/list.md'),
    ]);
  });
});
