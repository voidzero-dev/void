import type { CompileResult } from './compile.ts';
import { buildRenderChunks } from './emit-shared.ts';
import type { ResolvedIsland } from './emit-shared.ts';

export function emitVueComponent(
  result: CompileResult,
  islandImports: ReadonlyArray<ResolvedIsland>,
): string {
  const chunks = buildRenderChunks(result.html, islandImports);

  let code = `import { defineComponent, h, createStaticVNode, provide } from "vue";\n`;

  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    code += `import _raw_island_${islandIndex} from ${JSON.stringify(islandImport.specifier)};\n`;
  }

  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    code += `const ${islandImport.name} = { inheritAttrs: false, render() {
  const props = this.$attrs;
  return h("div", {
    "data-island": ${JSON.stringify(islandImport.islandId)},
    "data-props": JSON.stringify(props),
    "data-hydrate": ${JSON.stringify(islandImport.strategy)}
  }, h(_raw_island_${islandIndex}, props));
}};\n`;
  }

  const vnodes: Array<string> = [];

  for (const chunk of chunks) {
    if (chunk.type === 'html') {
      vnodes.push(`createStaticVNode(${JSON.stringify(chunk.html)}, 1)`);
    } else {
      const propsStr = Object.keys(chunk.props).length > 0 ? JSON.stringify(chunk.props) : 'null';
      vnodes.push(`h(${chunk.islandImport.name}, ${propsStr})`);
    }
  }

  // A single root keeps SSR output free of fragment markers on pages without islands.
  const root = islandImports.length > 0 ? `[\n      ${vnodes.join(',\n      ')}\n    ]` : vnodes[0];

  code += `
const __frontmatter = ${JSON.stringify(result.frontmatter)};
const __headings = ${JSON.stringify(result.headings)};

export const frontmatter = __frontmatter;
export const headings = __headings;

export default defineComponent({
  setup() {
    provide("__void_frontmatter", __frontmatter);
    return () => ${root};
  }
});
`;

  return code;
}
