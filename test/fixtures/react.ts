import type { FixtureApp } from '../fixture-app.ts';
import { privatePages } from './private-pages.ts';

const tsconfig = JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } });

export const islands: FixtureApp = {
  framework: 'react',
  name: 'islands',
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
    'pages/badge.island.tsx': `import Badge from '../src/Badge' with { island: 'load' };
export default function BadgePage() { return <Badge />; }`,
    ...privatePages(
      'react',
      `import { useState } from 'react';
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}`,
    ),
  },
};

export const bare: FixtureApp = {
  framework: 'react',
  name: 'bare',
  files: {
    'tsconfig.json': tsconfig,
    'pages/layout.tsx':
      'export default function Layout({ children }) { return <main>{children}</main>; }',
    'pages/index.island.tsx': 'export default function Home() { return <h1>Home</h1>; }',
  },
};

export const fixtures: Readonly<Record<string, FixtureApp>> = { islands, bare };
