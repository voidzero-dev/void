import matter from 'gray-matter';
import MarkdownExit from 'markdown-exit';
import type { Token } from 'markdown-exit';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import type { Heading } from './compile.ts';

let metadataCompiler: MarkdownExit | null = null;

function getMetadataCompiler(): MarkdownExit {
  if (metadataCompiler) {
    return metadataCompiler;
  }
  const markdown = new MarkdownExit({ html: true, linkify: true });
  // Footnotes must run before anchor so a `text[^1]` ref in a heading is turned
  // into a footnote_ref token (excluded from heading text) rather than staying
  // literal. Keeps metadata heading text/slug in sync with the rendered anchor
  // ids from `compile()`; otherwise `@void/md/pages` links break for such
  // headings. Registration order mirrors `createCompiler` in compile.ts.
  markdown.use(footnote);
  markdown.use(anchor, {
    permalink: anchor.permalink.ariaHidden({ placement: 'before' }),
  });
  metadataCompiler = markdown;
  return markdown;
}

export function extractHeadings(tokens: ReadonlyArray<Token>): ReadonlyArray<Heading> {
  const headings: Array<Heading> = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (token.type === 'heading_open') {
      const depth = Number(token.tag.slice(1));
      const slug = token.attrGet?.('id') ?? '';
      const inline = tokens[tokenIndex + 1];
      const text = (
        inline?.children
          ?.filter((child) => child.type === 'text' || child.type === 'code_inline')
          .map((child) => child.content)
          .join('') ?? ''
      ).trim();
      headings.push({ depth, slug, text });
    }
  }
  return headings;
}

export type MetadataResult = Readonly<{
  frontmatter: Record<string, unknown>;
  headings: ReadonlyArray<Heading>;
  title: string;
}>;

export function parseFrontmatter(
  source: string,
): Readonly<{ frontmatter: Record<string, unknown>; content: string }> {
  try {
    // Passing options skips gray-matter's cache. It stores a source before parsing it,
    // so without them a second read of invalid frontmatter returns empty data and
    // leaves the fences in the content instead of throwing again.
    const { data: frontmatter, content } = matter(source, {});
    return { frontmatter, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid frontmatter: ${message}`, { cause: error });
  }
}

export function extractMetadata(source: string): MetadataResult {
  const { frontmatter, content } = parseFrontmatter(source);
  const compiler = getMetadataCompiler();

  const env: Record<string, unknown> = {};
  const tokens = compiler.parse(content, env);
  const headings = extractHeadings(tokens);

  const title =
    (frontmatter.title as string) ?? headings.find((heading) => heading.depth === 1)?.text ?? '';

  return { frontmatter, headings, title };
}
