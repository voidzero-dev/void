import MagicString from 'magic-string';
import { parseSync } from 'vite';
import { isIdentifier, isLiteral, type AstNode, type AstProgram } from '../shared/ast.ts';

export type IslandImportSource = {
  start: number;
  end: number;
  importName: string;
  specifierRaw: string;
  specifier: string;
  hydrate: string;
};

export type IslandSourceEdit = { start: number; end: number; text: string };

export type StaticCssImport = { statement: string; specifier: string };

type ScriptBlock = { source: string; offset: number; filename: string };

// Same leading-script rule as @void/md's extractScript: a markdown page may open
// with a <script> block, and its frontmatter starts right after that block.
export const MARKDOWN_SCRIPT_RE: RegExp = /^<script\b[^>]*>([\s\S]*?)<\/script>\s*\n?/;

/**
 * The whole JS/TS module, each `<script>` block of a Vue/Svelte SFC, or the
 * leading `<script>` block of a Markdown page, with its offset in the file.
 */
export function scriptBlocks(code: string, filename: string): Array<ScriptBlock> {
  if (filename.endsWith('.md')) {
    const match = MARKDOWN_SCRIPT_RE.exec(code);
    if (!match) {
      return [];
    }
    const source = match[1]!;
    return [
      { source, offset: match[0].indexOf(source), filename: filename.replace(/\.md$/, '.ts') },
    ];
  }
  if (!/\.(?:vue|svelte)$/.test(filename)) {
    return [{ source: code, offset: 0, filename }];
  }
  const scriptFilename = filename.replace(/\.(?:vue|svelte)$/, '.ts');
  return [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => {
    const source = match[1]!;
    return { source, offset: match.index! + match[0].indexOf(source), filename: scriptFilename };
  });
}

/** Collect stylesheet imports from authored modules without treating dynamic imports or text as dependencies. */
export function findStaticCssImports(code: string, filename: string): Array<StaticCssImport> {
  if (!code.includes('import')) {
    return [];
  }
  const imports: Array<StaticCssImport> = [];
  for (const script of scriptBlocks(code, filename)) {
    if (!script.source.includes('import')) {
      continue;
    }
    const program = parseSync(script.filename, script.source).program as unknown as AstProgram;
    for (const node of program.body ?? []) {
      const source = node.source as AstNode | undefined;
      if (
        node.type !== 'ImportDeclaration' ||
        !isLiteral(source) ||
        typeof source.value !== 'string' ||
        !/\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/.test(source.value) ||
        node.start === undefined ||
        node.end === undefined
      ) {
        continue;
      }
      imports.push({
        statement: script.source.slice(node.start, node.end),
        specifier: source.value,
      });
    }
  }
  return imports;
}

export function editIslandSource(
  code: string,
  edits: ReadonlyArray<IslandSourceEdit>,
  options?: {
    prepend?: string;
    append?: string;
    insert?: ReadonlyArray<{ offset: number; text: string }>;
  },
): { code: string; map: ReturnType<MagicString['generateMap']> } {
  const ms = new MagicString(code);
  for (const edit of edits) {
    ms.overwrite(edit.start, edit.end, edit.text);
  }
  for (const insertion of options?.insert ?? []) {
    ms.appendLeft(insertion.offset, insertion.text);
  }
  if (options?.prepend) {
    ms.prepend(options.prepend);
  }
  if (options?.append) {
    ms.append(options.append);
  }
  return { code: ms.toString(), map: ms.generateMap({ hires: true }) };
}

/** Read island import attributes from JS/TS, or the script blocks of an SFC or a Markdown page. */
export function findIslandImports(code: string, filename: string): Array<IslandImportSource> {
  if (!code.includes('import') || !code.includes('island')) {
    return [];
  }
  const imports: Array<IslandImportSource> = [];
  for (const script of scriptBlocks(code, filename)) {
    if (!script.source.includes('island')) {
      continue;
    }
    const program = parseSync(script.filename, script.source).program as unknown as AstProgram;
    for (const node of program.body ?? []) {
      if (node.type !== 'ImportDeclaration') {
        continue;
      }
      const specifiers = node.specifiers as Array<AstNode> | undefined;
      const attributes = node.attributes as Array<AstNode> | undefined;
      const first = specifiers?.[0];
      const attribute = attributes?.[0];
      const key = attribute?.key as AstNode | undefined;
      const value = attribute?.value as AstNode | undefined;
      const source = node.source as AstNode | undefined;
      if (
        specifiers?.length !== 1 ||
        first?.type !== 'ImportDefaultSpecifier' ||
        !isIdentifier(first.local as AstNode | undefined) ||
        attributes?.length !== 1 ||
        !isIdentifier(key) ||
        key.name !== 'island' ||
        !isLiteral(value) ||
        typeof value.value !== 'string' ||
        !isLiteral(source) ||
        typeof source.value !== 'string' ||
        source.start === undefined ||
        source.end === undefined ||
        node.start === undefined ||
        node.end === undefined
      ) {
        continue;
      }
      imports.push({
        start: script.offset + node.start,
        end: script.offset + node.end,
        importName: (first.local as { name: string }).name,
        specifierRaw: script.source.slice(source.start, source.end),
        specifier: source.value,
        hydrate: value.value,
      });
    }
  }
  return imports;
}
