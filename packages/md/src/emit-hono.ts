import type { CompileResult } from './compile.ts';
import { buildRenderChunks, type ResolvedIsland } from './emit-shared.ts';

export function emitHonoComponent(
  result: CompileResult,
  islandImports: ReadonlyArray<ResolvedIsland>,
): string {
  const chunks = buildRenderChunks(result.html, islandImports);

  let code = `import { jsx, Fragment } from "hono/jsx";\n`;
  code += `import { raw } from "hono/html";\n`;
  code += `import { FrontmatterContext } from "@void/md";\n`;

  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    code += `import _raw_island_${islandIndex} from ${JSON.stringify(islandImport.specifier)};\n`;
  }

  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    code += `function ${islandImport.name}(props) {
  return jsx(
    "div",
    {
      "data-island": ${JSON.stringify(islandImport.islandId)},
      "data-props": JSON.stringify(props),
      "data-hydrate": ${JSON.stringify(islandImport.strategy)}
    },
    jsx(_raw_island_${islandIndex}, props)
  );
}\n`;
  }

  const children: Array<string> = [];

  for (const chunk of chunks) {
    if (chunk.type === 'html') {
      // Markdown pages render on the server only, so the HTML needs no wrapper element.
      children.push(`raw(${JSON.stringify(chunk.html)})`);
    } else {
      children.push(`jsx(${chunk.islandImport.name}, ${JSON.stringify(chunk.props)})`);
    }
  }

  if (children.length === 0) {
    children.push('null');
  }

  code += `
const __frontmatter = ${JSON.stringify(result.frontmatter)};
const __headings = ${JSON.stringify(result.headings)};

export const frontmatter = __frontmatter;
export const headings = __headings;

export default function MarkdownPage() {
  return jsx(
    FrontmatterContext.Provider,
    { value: __frontmatter },
    jsx(
      Fragment,
      null,
      ${children.join(',\n      ')}
    )
  );
}
`;

  return code;
}
