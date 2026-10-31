import { describe, expect, it } from 'vite-plus/test';
import { editIslandSource, findIslandImports } from '../../src/pages/island-imports.ts';

describe('island import parsing', () => {
  it('ignores imports in comments and strings and returns exact edit ranges', () => {
    const code = `// import Fake from './Fake' with { island: 'load' };
const example = "import AlsoFake from './Fake' with { island: 'load' }";
import Actual from './Actual' with { island: 'visible' };`;
    const imports = findIslandImports(code, 'page.island.tsx');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      importName: 'Actual',
      specifier: './Actual',
      hydrate: 'visible',
    });
    const changed = editIslandSource(code, [
      { start: imports[0]!.start, end: imports[0]!.end, text: "import Actual from './Wrapper';" },
    ]);
    expect(changed.code).toContain("// import Fake from './Fake'");
    expect(changed.code).toContain("import Actual from './Wrapper';");
    expect(changed.map).toBeDefined();
  });

  it('finds TypeScript imports inside SFC script blocks', () => {
    const code = `<template>import Fake from './Fake' with { island: 'load' }</template>
<script lang="ts">import Counter from './Counter' with { island: 'load', };</script>`;
    expect(findIslandImports(code, 'page.island.vue')).toMatchObject([
      { importName: 'Counter', specifier: './Counter', hydrate: 'load' },
    ]);
  });

  it('finds imports only in the leading script block of a Markdown page', () => {
    const code = `<script>
import Badge from '../components/Badge' with { island: 'load' };
</script>

\`\`\`ts
import Fenced from './Fenced' with { island: 'load' };
\`\`\`

<script>import Later from './Later' with { island: 'load' };</script>

<Badge />
`;
    const imports = findIslandImports(code, 'page.md');
    expect(imports).toMatchObject([
      { importName: 'Badge', specifier: '../components/Badge', hydrate: 'load' },
    ]);
    expect(code.slice(imports[0]!.start, imports[0]!.end)).toBe(
      "import Badge from '../components/Badge' with { island: 'load' };",
    );
  });

  it('treats a Markdown page without a leading script block as text', () => {
    const code = "import Counter from './Counter' with { island: 'load' };\n";
    expect(findIslandImports(code, 'page.md')).toEqual([]);
  });
});
