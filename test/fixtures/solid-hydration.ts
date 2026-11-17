import type { FixtureApp } from '../fixture-app.ts';

const counter = `import { createSignal, createUniqueId, useContext } from 'solid-js';
import { FrontmatterContext } from '@void/solid';
export default function Counter(props) {
  const [count, setCount] = createSignal(props.initial);
  const id = createUniqueId();
  return <section data-counter={props.name} data-frontmatter={useContext(FrontmatterContext).title}>
    <label for={id}>{props.name}</label><input id={id} />
    <button onClick={() => setCount(count() + 1)}>{count()}</button>
  </section>;
}`;

const capture = `window.__ssrCounters = Object.fromEntries(
  Array.from(document.querySelectorAll('[data-counter]')).map(host => {
    const input = host.querySelector('input');
    input.value = 'draft-' + host.dataset.counter;
    return [host.dataset.counter, { button: host.querySelector('button'), input }];
  })
);`;

const files = {
  'components/Counter.tsx': counter,
  'components/AsyncCounter.tsx': `
import { createResource, Suspense } from 'solid-js';
import Counter from './Counter';
export default function AsyncCounter() {
  const [name] = createResource(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return 'async';
  });
  return <Suspense fallback={<p>Loading</p>}>
    <Counter name={name()} initial={50} />
  </Suspense>;
}`,
  'pages/layout.island.tsx': `
import Counter from '../components/Counter' with { island: 'load' };
export default function Layout(props) {
  return <div><Counter name="layout" initial={30} />{props.children}</div>;
}`,
  'pages/index.island.tsx': `
import Counter from '../components/Counter' with { island: 'load' };
import VisibleCounter from '../components/Counter' with { island: 'visible' };
import AsyncCounter from '../components/AsyncCounter' with { island: 'load' };
export const frontmatter = { title: 'Island metadata' };
export default function Page() {
  return <main>
    <Counter name="first" initial={0} /><Counter name="second" initial={10} />
    <AsyncCounter />
    <div style={{ height: '1600px' }} />
    <VisibleCounter name="visible-first" initial={20} />
    <div style={{ height: '1600px' }} />
    <VisibleCounter name="visible-second" initial={40} />
    <script innerHTML={${JSON.stringify(capture)}} />
  </main>;
}`,
  'pages/plain.island.tsx': `
import Counter from '../components/Counter' with { island: 'load' };
export default function Plain() {
  return <main>
    <Counter name="plain" initial={60} />
    <script innerHTML={${JSON.stringify(capture)}} />
  </main>;
}`,
};

export const hydration: FixtureApp = {
  framework: 'solid',
  name: 'hydration',
  files: {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' },
    }),
    ...files,
  },
};
