import type { CompileResult } from './compile.ts';
import { buildRenderChunks } from './emit-shared.ts';
import type { ResolvedIsland } from './emit-shared.ts';

export function emitSolidComponent(
  result: CompileResult,
  islandImports: ReadonlyArray<ResolvedIsland>,
): string {
  const chunks = buildRenderChunks(result.html, islandImports);
  const importAliasByName = new Map<string, string>();

  let code = `import { FrontmatterContext } from "@void/md";\n`;

  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    const alias = `RawIsland${islandIndex}`;
    importAliasByName.set(islandImport.name, alias);
    code += `import ${alias} from ${JSON.stringify(islandImport.specifier)};\n`;
  }

  code += `
const __frontmatter = ${JSON.stringify(result.frontmatter)};
const __headings = ${JSON.stringify(result.headings)};

export const frontmatter = __frontmatter;
export const headings = __headings;
`;

  const bodyLines: Array<string> = [];
  let index = 0;

  for (const chunk of chunks) {
    if (chunk.type === 'html') {
      const htmlName = `__html_chunk_${index++}`;
      code += `\nconst ${htmlName} = ${JSON.stringify(chunk.html)};`;
      bodyLines.push(`<div innerHTML={${htmlName}} />`);
      continue;
    }

    const propsName = `__island_props_${index++}`;
    const importAlias = importAliasByName.get(chunk.islandImport.name) ?? chunk.islandImport.name;
    const propsLiteral = Object.keys(chunk.props).length > 0 ? JSON.stringify(chunk.props) : '{}';
    code += `\nconst ${propsName} = ${propsLiteral};`;
    bodyLines.push(
      `<div data-island=${JSON.stringify(chunk.islandImport.islandId)} data-props={JSON.stringify(${propsName})} data-hydrate=${JSON.stringify(chunk.islandImport.strategy)}><${importAlias} {...${propsName}} /></div>`,
    );
  }

  if (bodyLines.length === 0) {
    bodyLines.push('<></>');
  }

  code += `

export default function MarkdownPage() {
  return (
    <FrontmatterContext.Provider value={__frontmatter}>
      <>
        ${bodyLines.join('\n        ')}
      </>
    </FrontmatterContext.Provider>
  );
}
`;

  return code;
}
