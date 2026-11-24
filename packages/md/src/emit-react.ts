import type { CompileResult } from './compile.ts';
import { buildRenderChunks } from './emit-shared.ts';
import type { ResolvedIsland } from './emit-shared.ts';

export function emitReactComponent(
  result: CompileResult,
  islandImports: ReadonlyArray<ResolvedIsland>,
): string {
  const chunks = buildRenderChunks(result.html, islandImports);

  let code = `import React from "react";\n`;
  code += `import { FrontmatterContext } from "@void/md";\n`;

  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    code += `import _raw_island_${islandIndex} from ${JSON.stringify(islandImport.specifier)};\n`;
  }

  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    code += `function ${islandImport.name}(props) {
  return React.createElement(
    "div",
    {
      "data-island": ${JSON.stringify(islandImport.islandId)},
      "data-props": JSON.stringify(props),
      "data-hydrate": ${JSON.stringify(islandImport.strategy)}
    },
    React.createElement(_raw_island_${islandIndex}, props)
  );
}\n`;
  }

  const children: Array<string> = [];

  for (const chunk of chunks) {
    if (chunk.type === 'html') {
      children.push(
        `React.createElement("div", { dangerouslySetInnerHTML: { __html: ${JSON.stringify(chunk.html)} } })`,
      );
    } else {
      const propsCode = Object.keys(chunk.props).length > 0 ? JSON.stringify(chunk.props) : 'null';
      children.push(`React.createElement(${chunk.islandImport.name}, ${propsCode})`);
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
  return React.createElement(
    FrontmatterContext.Provider,
    { value: __frontmatter },
    React.createElement(
      React.Fragment,
      null,
      ${children.join(',\n      ')}
    )
  );
}
`;

  return code;
}
