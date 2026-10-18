import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { buildIslandApp, defineIslandCssBuildTest } from '../../../../test/island-css-build.ts';

const packageDir = join(import.meta.dirname, '../..');
const tsconfig = JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } });

defineIslandCssBuildTest({
  packageDir,
  pluginName: 'voidReact',
  files: {
    'tsconfig.json': tsconfig,
    'src/shell.css': '.shell { outline-offset: 7px; }',
    'src/card.module.css': '.card { text-indent: 9px; }',
    'src/badge.css': '.badge { word-spacing: 5px; }',
    'src/Badge.tsx': `import './badge.css';
export default function Badge() { return <b className="badge">Badge</b>; }`,
    'src/Shell.tsx': `import './shell.css';
import styles from './card.module.css';
import Badge from './Badge';
export default function Shell({ children }) {
  return <main className={'shell ' + styles.card}><Badge />{children}</main>;
}`,
    'pages/layout.tsx': `import Shell from '../src/Shell';
export default function Layout({ children }) { return <Shell>{children}</Shell>; }`,
    'pages/index.island.tsx': 'export default function Home() { return <h1>Home</h1>; }',
    // The layout renders Badge without hydrating it; this page hydrates it.
    'pages/badge.island.tsx': `import Badge from '../src/Badge' with { island: 'load' };
export default function BadgePage() { return <Badge />; }`,
  },
  expectedCss: ['.shell{outline-offset:7px}', '{text-indent:9px}', '.badge{word-spacing:5px}'],
});

it('builds island pages without CSS or JavaScript with no stylesheet, script or client runtime', () => {
  const build = buildIslandApp({
    packageDir,
    pluginName: 'voidReact',
    files: {
      'tsconfig.json': tsconfig,
      'pages/layout.tsx':
        'export default function Layout({ children }) { return <main>{children}</main>; }',
      'pages/index.island.tsx': 'export default function Home() { return <h1>Home</h1>; }',
    },
  });
  try {
    for (const file of ['index.html', 'about.html']) {
      const { html } = build.page(file);
      expect(html, file).toContain('</main>');
      expect(html, file).not.toContain('<link');
      expect(html, file).not.toContain('<script');
    }
    // No page loads the islands entry, so it carries no hydration code.
    for (const [file, text] of build.output('client')) {
      expect(text.includes('hydrateRoot'), file).toBe(false);
    }
  } finally {
    build.cleanup();
  }
}, 120_000);

it('keeps the islands client entry out of the server build', () => {
  const build = buildIslandApp({
    packageDir,
    pluginName: 'voidReact',
    files: {
      'tsconfig.json': tsconfig,
      'src/Counter.tsx': 'export default function Counter() { return <button>0</button>; }',
      'pages/index.island.tsx': `import Counter from '../src/Counter' with { island: 'load' };
export default function Home() { return <Counter />; }`,
    },
  });
  try {
    expect(build.page('index.html').html).toContain('<script');
    for (const [file, text] of build.output('ssr')) {
      expect(file).not.toContain('islands-client');
      expect(text.includes('hydrateRoot'), file).toBe(false);
    }
  } finally {
    build.cleanup();
  }
}, 120_000);
