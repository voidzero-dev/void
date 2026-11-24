import { codeToTokens, isSupportedLanguage } from '@pierre/highlights';
import type { Lang, Theme, ThemeFamily, ThemedToken } from '@pierre/highlights';

export type CodeThemeNames = Readonly<{ light: string; dark: string }>;

/** Renders a code block. `meta` is the fence info, which may hold a `{1,3-5}` line range. */
export type CodeHighlighter = (code: string, lang: string, meta: string) => string;

// The theme CSS and the code-copy script select on these names.
const CSS_VARIABLE_PREFIX = '--shiki-';

const NOTATION_RE = /\s*\[!code (\+\+|--|highlight|hl|focus|error|warning)(?::(\d+))?\]/g;
// What is left of a comment once its notations are removed: only delimiters.
const EMPTY_COMMENT_RE = /^\s*(?:\/\/|\/\*|\*\/|<!--|-->|--|[#;%"'*]|\s)*\s*$/;
const TOKEN_COMMENT = 1;

// The classes a notation gives its line. The block gets `has-` and the first one.
const NOTATION_CLASSES: Record<string, ReadonlyArray<string>> = {
  '++': ['diff', 'add'],
  '--': ['diff', 'remove'],
  highlight: ['highlighted'],
  hl: ['highlighted'],
  focus: ['focused'],
  error: ['highlighted', 'error'],
  warning: ['highlighted', 'warning'],
};

// Line and block classes come out in this order whatever order the notations appear in.
const LINE_CLASS_ORDER: ReadonlyArray<string> = [
  'highlighted',
  'diff',
  'add',
  'remove',
  'focused',
  'error',
  'warning',
];
const PRE_CLASS_ORDER: ReadonlyArray<string> = ['has-diff', 'has-highlighted', 'has-focused'];

async function loadTheme(name: string): Promise<Theme | ThemeFamily> {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid code theme name '${name}'.`);
  }
  let module: { default?: unknown };
  try {
    module = (await import(`@pierre/highlights/themes/${name}`)) as { default?: unknown };
  } catch (error) {
    // Only a missing module means the name is wrong. Anything else is a broken install.
    if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') {
      throw error;
    }
    throw new Error(`Unknown code theme '${name}'.`, { cause: error });
  }
  // The themes directory also holds modules that are not themes.
  const theme = module.default;
  if (typeof theme !== 'object' || theme === null || !('style' in theme || 'themes' in theme)) {
    throw new Error(`Unknown code theme '${name}'.`);
  }
  return theme as Theme | ThemeFamily;
}

function escapeHtml(text: string): string {
  return /[&<]/.test(text) ? text.replaceAll('&', '&#x26;').replaceAll('<', '&#x3C;') : text;
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', '&#x22;');
}

type LineRange = Readonly<{ from: number; to: number }>;

/** The 1-based line ranges of a `{1,3-5}` list in the fence info, if it has one. */
function metaHighlightedRanges(meta: string): ReadonlyArray<LineRange> | null {
  const match = /\{([\d,-]+)\}/.exec(meta);
  if (!match) {
    return null;
  }
  const ranges: Array<LineRange> = [];
  for (const part of match[1].split(',')) {
    const [from, to] = part.split('-').map((value) => Number.parseInt(value, 10));
    if (!Number.isNaN(from)) {
      ranges.push({ from, to: to === undefined || Number.isNaN(to) ? from : to });
    }
  }
  return ranges;
}

// The highlighter gives every token of one kind the same style object.
const spanOpeners = new WeakMap<object, string>();

function spanOpener(token: ThemedToken): string {
  const style = token.htmlStyle;
  if (!style) {
    return '<span>';
  }
  let opener = spanOpeners.get(style);
  if (opener === undefined) {
    const css = Object.entries(style)
      .map(([property, value]) => `${property}:${value}`)
      .join(';');
    opener = css ? `<span style="${escapeAttribute(css)}">` : '<span>';
    spanOpeners.set(style, opener);
  }
  return opener;
}

function renderLine(tokens: ReadonlyArray<ThemedToken>, classes: string): string {
  let html = `<span class="${classes}">`;
  for (const token of tokens) {
    html += `${spanOpener(token)}${escapeHtml(token.content)}</span>`;
  }
  return `${html}</span>`;
}

type Notation = Readonly<{ classes: ReadonlyArray<string>; count: number }>;

// Markdown examples show code fences as text, so only their HTML comments carry notations.
const MARKDOWN_LANGS: ReadonlySet<string> = new Set(['md', 'markdown', 'mdx']);

/**
 * Splits the `[!code ...]` notations from the comments of a line.
 * A comment that held nothing else is removed with them.
 */
function takeNotations(
  tokens: ReadonlyArray<ThemedToken>,
  lang: string,
): Readonly<{
  tokens: ReadonlyArray<ThemedToken>;
  notations: ReadonlyArray<Notation>;
}> {
  const notations: Array<Notation> = [];
  const kept: Array<ThemedToken> = [];
  const htmlCommentsOnly = MARKDOWN_LANGS.has(lang);
  const jsx = lang === 'jsx' || lang === 'tsx';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (
      token.type !== TOKEN_COMMENT ||
      !token.content.includes('[!code ') ||
      (htmlCommentsOnly && !token.content.trimStart().startsWith('<!--'))
    ) {
      kept.push(token);
      continue;
    }
    const content = token.content.replaceAll(
      NOTATION_RE,
      (_match, name: string, count: string | undefined) => {
        notations.push({
          classes: NOTATION_CLASSES[name],
          count: count ? Math.max(1, Number.parseInt(count, 10)) : 1,
        });
        return '';
      },
    );
    if (!EMPTY_COMMENT_RE.test(content)) {
      kept.push(content === token.content ? token : { ...token, content });
    } else if (
      jsx &&
      kept.at(-1)?.content.trim() === '{' &&
      tokens[index + 1]?.content.trim() === '}'
    ) {
      // JSX comments own their expression braces. Drop those with an empty
      // notation comment so a standalone annotation applies to the next line.
      kept.pop();
      index++;
    }
  }
  return { tokens: kept, notations };
}

function isEmptyLine(tokens: ReadonlyArray<ThemedToken>): boolean {
  return tokens.every((token) => !/\S/.test(token.content));
}

/**
 * Creates the code block highlighter. It renders the block the theme CSS expects:
 * one `span.line` per line, light colors inline and dark colors in CSS variables.
 */
export async function createCodeHighlighter(themeNames: CodeThemeNames): Promise<CodeHighlighter> {
  const [light, dark] = await Promise.all([
    loadTheme(themeNames.light),
    loadTheme(themeNames.dark),
  ]);
  const plainText = 'text' as Lang;
  const options = {
    themes: { light, dark },
    defaultColor: 'light',
    cssVariablePrefix: CSS_VARIABLE_PREFIX,
  } as const;

  // The colors of the block depend on the themes alone.
  const { bg, fg } = codeToTokens('', { lang: plainText, ...options });
  const preClass = `shiki shiki-themes ${themeNames.light} ${themeNames.dark}`;
  const preStyle = escapeAttribute(`background-color:${bg};color:${fg}`);

  return (code, lang, meta) => {
    const result = codeToTokens(code, {
      lang: isSupportedLanguage(lang) ? lang : plainText,
      ...options,
    });
    const highlighted = metaHighlightedRanges(meta);

    // Most blocks have neither notations nor a line range.
    if (!highlighted && !code.includes('[!code ')) {
      const body = result.tokens.map((tokens) => renderLine(tokens, 'line')).join('\n');
      return `<pre class="${preClass}" style="${preStyle}" tabindex="0"><code>${body}</code></pre>`;
    }

    const preClasses = new Set<string>();
    const lines: Array<string> = [];
    // Notations still to apply. One with a `:N` count stays for the lines that follow.
    let running: Array<{ classes: ReadonlyArray<string>; remaining: number }> = [];

    result.tokens.forEach((lineTokens, index) => {
      const { tokens, notations } = takeNotations(lineTokens, lang);
      for (const notation of notations) {
        preClasses.add(`has-${notation.classes[0]}`);
        running.push({ classes: notation.classes, remaining: notation.count });
      }
      // A line that held only the comment is dropped, and its notations apply from the next line.
      if (notations.length > 0 && isEmptyLine(tokens)) {
        return;
      }

      const classes = new Set<string>();
      if (highlighted?.some((range) => index + 1 >= range.from && index + 1 <= range.to)) {
        classes.add('highlighted');
      }
      for (const entry of running) {
        for (const name of entry.classes) {
          classes.add(name);
        }
        entry.remaining--;
      }
      running = running.filter((entry) => entry.remaining > 0);

      const ordered = LINE_CLASS_ORDER.filter((name) => classes.has(name));
      lines.push(renderLine(tokens, ['line', ...ordered].join(' ')));
    });

    const blockClass = [preClass, ...PRE_CLASS_ORDER.filter((name) => preClasses.has(name))].join(
      ' ',
    );
    return `<pre class="${blockClass}" style="${preStyle}" tabindex="0"><code>${lines.join('\n')}</code></pre>`;
  };
}
