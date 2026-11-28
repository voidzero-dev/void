import type { CompileResult } from './compile.ts';
import { buildRenderChunks } from './emit-shared.ts';
import type { ResolvedIsland } from './emit-shared.ts';

function toSvelteLiteral(value: unknown): string {
  return JSON.stringify(value).replaceAll('</', String.raw`<\/`);
}

export function emitSvelteComponent(
  result: CompileResult,
  islandImports: ReadonlyArray<ResolvedIsland>,
): string {
  const chunks = buildRenderChunks(result.html, islandImports);

  const importAliasByName = new Map<string, string>();
  const frontmatter = toSvelteLiteral(result.frontmatter);
  const headings = toSvelteLiteral(result.headings);

  let source = `<script context="module">
export const frontmatter = ${frontmatter};
export const headings = ${headings};
</script>

<script>
import { setFrontmatter } from "@void/md";
`;

  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    const alias = `RawIsland${islandIndex}`;
    importAliasByName.set(islandImport.name, alias);
    source += `import ${alias} from ${JSON.stringify(islandImport.specifier)};
`;
  }

  source += `
const __frontmatter = ${frontmatter};
setFrontmatter(__frontmatter);
`;

  const body: Array<string> = [];
  let index = 0;

  for (const chunk of chunks) {
    if (chunk.type === 'html') {
      body.push(`{@html ${toSvelteLiteral(chunk.html)}}`);
      continue;
    }

    const propsName = `__island_props_${index++}`;
    const alias = importAliasByName.get(chunk.islandImport.name) ?? chunk.islandImport.name;
    const propsLiteral = Object.keys(chunk.props).length > 0 ? toSvelteLiteral(chunk.props) : '{}';
    source += `const ${propsName} = ${propsLiteral};
`;
    body.push(
      `<div data-island="${chunk.islandImport.islandId}" data-props={JSON.stringify(${propsName})} data-hydrate="${chunk.islandImport.strategy}">{#each [1] as _}<${alias} {...${propsName}} />{/each}</div>`,
    );
  }

  source += `</script>

${body.join('\n')}
`;

  return source;
}
