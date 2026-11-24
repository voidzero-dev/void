import MarkdownExit from 'markdown-exit';
import type { RuleCore, Token } from 'markdown-exit';
import attrs from 'markdown-it-attrs';
import { full as emoji } from 'markdown-it-emoji';
import footnote from 'markdown-it-footnote';
import { createCodeHighlighter } from './highlight.ts';
import { extractHeadings, parseFrontmatter } from './metadata.ts';
import { containerPlugin } from './plugins/containers.ts';
import { gitHubAlertsPlugin } from './plugins/github-alerts.ts';
import { headingAnchorPlugin } from './plugins/heading-anchor.ts';
import { imagePlugin } from './plugins/image.ts';
import { lineNumberPlugin } from './plugins/line-numbers.ts';
import { linkPlugin } from './plugins/link.ts';
import { CODE_COPY_SCRIPT, preWrapperPlugin } from './plugins/pre-wrapper.ts';
import { taskListPlugin } from './plugins/task-lists.ts';
import { tocPlugin } from './plugins/toc.ts';

export type Heading = Readonly<{
  depth: number;
  slug: string;
  text: string;
}>;

export type CompileResult = Readonly<{
  html: string;
  frontmatter: Record<string, unknown>;
  headings: ReadonlyArray<Heading>;
  title: string;
}>;

export type CompileOptions = Readonly<{
  /** Title of the code block copy button. Defaults to `Copy Code`. */
  copyLabel?: string;
  /** Code block color themes. Defaults to `github-light` and `github-dark`. */
  themes?: { light: string; dark: string };
  /** @deprecated Use `themes`. Removed in the next major version. */
  shiki?: {
    /** @deprecated Use the top-level `themes` option. Removed in the next major version. */
    themes?: { light: string; dark: string };
    /**
     * @deprecated Has no effect. Every supported code block language is
     * built in. Remove this option. Removed in the next major version.
     */
    langs?: ReadonlyArray<string>;
  };
}>;

let compilerPromise: Promise<MarkdownExit> | null = null;

async function getCompiler(options?: CompileOptions): Promise<MarkdownExit> {
  if (compilerPromise) {
    return compilerPromise;
  }
  compilerPromise = createCompiler(options);
  return compilerPromise;
}

// Save the raw fence info (e.g. `ts {1,3-5}`) before `markdown-it-attrs` strips the
// `{…}`, so the highlighter still gets the line ranges.
const stashFenceInfo: RuleCore = (state) => {
  for (const token of state.tokens) {
    if (token.type === 'fence') {
      token.meta = { ...token.meta, rawInfo: token.info };
    }
  }
};

async function createCompiler(options?: CompileOptions): Promise<MarkdownExit> {
  const markdown = new MarkdownExit({ html: true, linkify: true });

  const highlight = await createCodeHighlighter(
    options?.themes ?? options?.shiki?.themes ?? { light: 'github-light', dark: 'github-dark' },
  );
  markdown.renderer.rules.fence = (tokens: ReadonlyArray<Token>, tokenIndex: number) => {
    const token = tokens[tokenIndex];
    const lang = token.info ? token.info.split(/\s+/g)[0] : 'text';
    // `markdown-it-attrs` strips `{1,3-5}` line-highlight ranges from
    // `token.info`; `stash_fence_info` keeps the original so the highlighter
    // still sees them.
    const rawInfo = (token.meta as { rawInfo?: string } | null)?.rawInfo ?? token.info;
    return highlight(token.content, lang, rawInfo);
  };

  // Code block wrapping (must come after the fence rule, before line-numbers)
  markdown.use(preWrapperPlugin, { copyLabel: options?.copyLabel });

  markdown.use(containerPlugin);
  markdown.use(imagePlugin, { lazyLoading: true });
  markdown.use(linkPlugin);
  markdown.use(lineNumberPlugin);
  markdown.use(gitHubAlertsPlugin);
  markdown.core.ruler.after('block', 'stash_fence_info', stashFenceInfo);

  markdown.use(attrs);
  markdown.use(emoji);

  // After emoji and before anchor, so footnote markers are not treated as
  // heading-anchor targets.
  markdown.use(footnote);

  markdown.use(taskListPlugin);

  markdown.use(headingAnchorPlugin);

  markdown.use(tocPlugin);

  return markdown;
}

export async function compile(source: string, options?: CompileOptions): Promise<CompileResult> {
  const { frontmatter, content } = parseFrontmatter(source);
  const compiler = await getCompiler(options);

  const env: { codeCopy?: boolean } = {};
  const tokens = compiler.parse(content, env);
  const headings = extractHeadings(tokens);
  let html = await compiler.renderer.renderAsync(tokens, compiler.options, env);
  // At the end, after any island tag: the emitters drop the children of
  // paired island tags, which would also drop a script placed among them.
  if (env.codeCopy) {
    html += CODE_COPY_SCRIPT;
  }

  const title =
    (frontmatter.title as string) ?? headings.find((heading) => heading.depth === 1)?.text ?? '';

  return { html, frontmatter, headings, title };
}
