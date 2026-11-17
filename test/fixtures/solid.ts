import type { FixtureApp } from '../fixture-app.ts';
import { privatePages } from './private-pages.ts';
import { hydration } from './solid-hydration.ts';

const cssFiles = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' },
  }),
  'src/shell.css': '.shell { outline-offset: 7px; }',
  'src/card.module.css': '.card { text-indent: 9px; }',
  'src/badge.css': '.badge { word-spacing: 5px; }',
  'src/Badge.tsx': `import './badge.css';
export default function Badge() { return <b class="badge">Badge</b>; }`,
  'src/Shell.tsx': `import './shell.css';
import styles from './card.module.css';
import Badge from './Badge';
export default function Shell(props) {
  return <main class={'shell ' + styles.card}><Badge />{props.children}</main>;
}`,
  'pages/layout.tsx': `import Shell from '../src/Shell';
export default function Layout(props) { return <Shell>{props.children}</Shell>; }`,
  'pages/index.island.tsx': 'export default function Home() { return <h1>Home</h1>; }',
  // The layout renders Badge without hydrating it; this page hydrates it.
  'pages/badge.island.tsx': `import Badge from '../src/Badge' with { island: 'load' };
export default function BadgePage() { return <Badge />; }`,
};

export const islands: FixtureApp = {
  framework: 'solid',
  name: 'islands',
  files: {
    ...cssFiles,
    ...privatePages(
      'solid',
      `import { createSignal } from 'solid-js';
export default function Counter() {
  const [count, setCount] = createSignal(0);
  return <button onClick={() => setCount(count() + 1)}>Count: {count()}</button>;
}`,
    ),
  },
};
export const fixtures: Readonly<Record<string, FixtureApp>> = { islands, hydration };
