import type { FixtureApp } from '../fixture-app.ts';

export const markdownScripts: FixtureApp = {
  framework: 'react',
  name: 'markdown-scripts',
  files: {
    'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }),
    'components/Counter.island.tsx': `import { useState } from 'react';
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}`,
    'pages/script.md': `<script>
document.querySelector('#out').textContent = 'set-by-script';
</script>

# Script

<span id="out">unset</span>
`,
    'pages/mixed.md': `<script>
import Counter from '../components/Counter.island.tsx' with { island: 'load' };
document.querySelector('#out').textContent = 'set-by-script';
</script>

# Mixed

<span id="out">unset</span>

<Counter />
`,
  },
};
