import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import {
  transformerMetaHighlight,
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerNotationFocus,
  transformerNotationErrorLevel,
} from '@shikijs/transformers';
import matter from 'gray-matter';
import MarkdownExit from 'markdown-exit';
import type { RuleCore, Token } from 'markdown-exit';
import anchor from 'markdown-it-anchor';
import attrs from 'markdown-it-attrs';
import { full as emoji } from 'markdown-it-emoji';
import footnote from 'markdown-it-footnote';
import { createHighlighter, bundledLanguages, isSpecialLang, type BundledLanguage } from 'shiki';
import { extractHeadings } from './metadata.ts';
import { containerPlugin } from './plugins/containers.ts';
import { gitHubAlertsPlugin } from './plugins/github-alerts.ts';
import { imagePlugin } from './plugins/image.ts';
import { lineNumberPlugin } from './plugins/line-numbers.ts';
import { linkPlugin } from './plugins/link.ts';
import { CODE_COPY_SCRIPT, preWrapperPlugin } from './plugins/pre-wrapper.ts';
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
  shiki?: {
    themes?: { light: string; dark: string };
    /**
     * @deprecated Has no effect. Code block languages load on demand from
     * Shiki's bundled languages. Remove this option. Removed in the next major
     * version.
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

async function createCompiler(options?: CompileOptions): Promise<MarkdownExit> {
  const markdown = new MarkdownExit({ html: true, linkify: true });

  // Shiki highlighting with JS RegExp engine (no WASM) + lazy language loading
  const themes = options?.shiki?.themes ?? {
    light: 'github-light',
    dark: 'github-dark',
  };
  const highlighter = await createHighlighter({
    engine: createJavaScriptRegexEngine(),
    themes: [themes.light, themes.dark],
    langs: [],
  });
  const shikiTransformers = [
    transformerMetaHighlight(),
    transformerNotationDiff(),
    transformerNotationHighlight(),
    transformerNotationFocus(),
    transformerNotationErrorLevel(),
  ];
  markdown.renderer.rules.fence = async (tokens: ReadonlyArray<Token>, tokenIndex: number) => {
    const token = tokens[tokenIndex];
    const code = token.content;
    let lang = token.info ? token.info.split(/\s+/g)[0] : 'text';
    if (!isSpecialLang(lang) && !highlighter.getLoadedLanguages().includes(lang)) {
      if (lang in bundledLanguages) {
        await highlighter.loadLanguage(lang as BundledLanguage);
      } else {
        lang = 'text';
      }
    }
    // `markdown-it-attrs` strips `{1,3-5}` line-highlight ranges from
    // `token.info`; `stash_fence_info` keeps the original so
    // `transformerMetaHighlight` still sees them.
    const rawInfo = (token.meta as { rawInfo?: string } | null)?.rawInfo ?? token.info;
    return highlighter.codeToHtml(code, {
      lang,
      themes,
      defaultColor: 'light',
      transformers: shikiTransformers,
      meta: { __raw: rawInfo },
    });
  };

  // Code block wrapping (must come after shiki, before line-numbers)
  markdown.use(preWrapperPlugin);

  markdown.use(containerPlugin);
  markdown.use(imagePlugin, { lazyLoading: true });
  markdown.use(linkPlugin);
  markdown.use(lineNumberPlugin);
  markdown.use(gitHubAlertsPlugin);

  // Save the raw fence info (e.g. `ts {1,3-5}`) before `markdown-it-attrs` strips the
  // `{…}`, so `transformerMetaHighlight` still gets the line ranges via `meta.__raw`.
  const stashFenceInfo: RuleCore = (state) => {
    for (const token of state.tokens) {
      if (token.type === 'fence') {
        token.meta = { ...token.meta, rawInfo: token.info };
      }
    }
  };
  markdown.core.ruler.after('block', 'stash_fence_info', stashFenceInfo);

  markdown.use(attrs);
  markdown.use(emoji);

  // After emoji and before anchor, so footnote markers are not treated as
  // heading-anchor targets.
  markdown.use(footnote);

  markdown.use(anchor, {
    permalink: anchor.permalink.ariaHidden({ placement: 'before' }),
  });

  markdown.use(tocPlugin);

  return markdown;
}

export async function compile(source: string, options?: CompileOptions): Promise<CompileResult> {
  const { data: frontmatter, content } = matter(source);
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
