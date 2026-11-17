// Code highlighting for the docs with @pierre/highlights, in place of the
// Shiki highlighter of VitePress. It renders the markup that the theme CSS and
// the copy button select on.
//
// This is a fork of `packages/md/src/highlight.ts` with the class names of
// VitePress. Mirror fixes to the notation handling there.

import { randomUUID } from 'node:crypto';
import { codeToTokens, isSupportedLanguage } from '@pierre/highlights';
import type { Lang, ThemedToken } from '@pierre/highlights';
import dark from '@pierre/highlights/themes/github-dark';
import light from '@pierre/highlights/themes/github-light';

/** The `markdown.highlight` option of VitePress. */
export type CodeHighlighter = (code: string, lang: string, attrs: string) => string;

const OPTIONS = {
  themes: { light, dark },
  defaultColor: false,
  // The theme CSS reads the colors from these variables.
  cssVariablePrefix: '--shiki-',
} as const;

// The contrast fixes that VitePress applies to these two themes, by the CSS
// variable of the theme.
const COLOR_REPLACEMENTS: Record<string, Record<string, string>> = {
  '--shiki-light': {
    '#959da5': '#6c676f',
    '#28a745': '#0e790b',
    '#b08800': '#846312',
    '#e36209': '#c13617',
    '#3192aa': '#05728b',
    '#d73a49': '#c62739',
    '#22863a': '#11782a',
    '#6a737d': '#62687b',
    '#1b7c83': '#06747a',
    '#0366d6': '#0663d0',
    '#cb2431': '#c82430',
  },
  '--shiki-dark': {
    '#586069': '#5b93a3',
    '#6a737d': '#818e99',
    '#ea4a5a': '#ef5564',
    '#2188ff': '#268bf9',
  },
};

const TOKEN_COMMENT = 1;

// The classes a notation gives its line. The block gets the class in `pre`.
const NOTATIONS: Record<string, Readonly<{ line: ReadonlyArray<string>; pre: string }>> = {
  '++': { line: ['diff', 'add'], pre: 'has-diff' },
  '--': { line: ['diff', 'remove'], pre: 'has-diff' },
  highlight: { line: ['highlighted'], pre: 'has-highlighted' },
  hl: { line: ['highlighted'], pre: 'has-highlighted' },
  focus: { line: ['has-focus'], pre: 'has-focused-lines' },
  error: { line: ['highlighted', 'error'], pre: 'has-highlighted' },
  warning: { line: ['highlighted', 'warning'], pre: 'has-highlighted' },
};

const NOTATION_RE = new RegExp(
  `\\s*\\[!code (${Object.keys(NOTATIONS)
    .map((name) => name.replace(/\+/g, '\\+'))
    .join('|')})(?::(\\d+))?\\]`,
  'g',
);
// What is left of a comment once its notations are removed: only delimiters.
const EMPTY_COMMENT_RE = /^\s*(?:\/\/|\/\*|\*\/|<!--|-->|--|[#;%"'*]|\s)*\s*$/;

function escapeHtml(text: string): string {
  return /[&<]/.test(text) ? text.replace(/&/g, '&#x26;').replace(/</g, '&#x3C;') : text;
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, '&#x22;');
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
    const [from, to] = part.split('-').map((value) => parseInt(value, 10));
    if (!Number.isNaN(from)) {
      ranges.push({ from, to: to === undefined || Number.isNaN(to) ? from : to });
    }
  }
  return ranges;
}

type Notation = Readonly<{ line: ReadonlyArray<string>; pre: string; count: number }>;

/**
 * Splits the `[!code ...]` notations from the comments of a line.
 * A comment that held nothing else is removed with them.
 */
function takeNotations(
  tokens: ReadonlyArray<ThemedToken>,
  lang: string,
): Readonly<{ tokens: Array<ThemedToken>; notations: ReadonlyArray<Notation> }> {
  const notations: Array<Notation> = [];
  const kept: Array<ThemedToken> = [];
  const jsx = lang === 'jsx' || lang === 'tsx';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== TOKEN_COMMENT || !token.content.includes('[!code ')) {
      kept.push(token);
      continue;
    }
    const content = token.content.replace(
      NOTATION_RE,
      (_match, name: string, count: string | undefined) => {
        notations.push({ ...NOTATIONS[name], count: count ? Math.max(1, parseInt(count, 10)) : 1 });
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
      // Empty JSX annotation comments own their expression braces. Remove
      // those too so standalone annotations apply to the following code.
      kept.pop();
      index++;
    }
  }
  // The space that separated the code from a removed comment goes with it.
  const last = kept.at(-1);
  if (notations.length > 0 && last) {
    const content = last.content.trimEnd();
    if (!content) {
      kept.pop();
    } else if (content !== last.content) {
      kept[kept.length - 1] = { ...last, content };
    }
  }
  return { tokens: kept, notations };
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
      .map(
        ([property, value]) =>
          `${property}:${COLOR_REPLACEMENTS[property]?.[value.toLowerCase()] ?? value}`,
      )
      .join(';');
    opener = `<span style="${escapeAttribute(css)}">`;
    spanOpeners.set(style, opener);
  }
  return opener;
}

// Match VitePress's non-selectable shell prompts while keeping the text for
// its copy button, which strips the prompt from the cloned block.
function disableShellPromptSelection(
  tokens: ReadonlyArray<ThemedToken>,
): ReadonlyArray<ThemedToken> {
  const content = tokens.map((token) => token.content).join('');
  const promptLength = /^ *[$>] /.exec(content)?.[0].length ?? 0;
  if (!promptLength) {
    return tokens;
  }
  const result: Array<ThemedToken> = [];
  let remaining = promptLength;
  for (const token of tokens) {
    if (remaining === 0) {
      result.push(token);
      continue;
    }
    const count = Math.min(remaining, token.content.length);
    if (count > 0) {
      result.push({
        ...token,
        content: token.content.slice(0, count),
        htmlStyle: {
          ...token.htmlStyle,
          'user-select': 'none',
          '-webkit-user-select': 'none',
        },
      });
      if (count < token.content.length) {
        result.push({ ...token, content: token.content.slice(count) });
      }
      remaining -= count;
    }
  }
  return result;
}

function renderLine(tokens: ReadonlyArray<ThemedToken>, classes: string): string {
  let html = `<span class="${classes}">`;
  // The theme collapses a line that has no element in it.
  if (tokens.length === 0) {
    return `${html}<wbr></span>`;
  }
  // Tokens that look the same share one span, and whitespace joins the token
  // after it. Fewer elements make the page smaller and faster to build.
  let open = '';
  let space = '';
  for (const token of tokens) {
    if (!/\S/.test(token.content)) {
      space += token.content;
      continue;
    }
    const opener = spanOpener(token);
    if (opener !== open) {
      html += `${open ? '</span>' : ''}${opener}`;
      open = opener;
    }
    html += space + escapeHtml(token.content);
    space = '';
  }
  if (space) {
    html += open ? space : `<span>${space}`;
  }
  return `${html}</span></span>`;
}

/**
 * Creates the highlighter for `markdown.highlight`. It renders one `span.line`
 * per line, with the colors of both themes in CSS variables.
 */
export function createCodeHighlighter(): CodeHighlighter {
  // The colors of the block depend on the themes alone.
  const preStyle = escapeAttribute(codeToTokens('', { lang: 'text', ...OPTIONS }).rootStyle ?? '');
  const preClass = 'shiki shiki-themes github-light github-dark';

  return (code, lang, attrs) => {
    // The language may carry the line range: `ts{1,3}`.
    const name = /^[a-zA-Z0-9-_]+/.exec(lang)?.[0] ?? '';
    attrs = `${lang.slice(name.length)} ${attrs}`;
    lang = name.toLowerCase() || 'txt';
    // The build stops here, because nothing else reports a block that would
    // render without colors. VitePress does not apply `languageAlias` to a
    // highlighter of our own.
    // VitePress uses the -vue suffix to allow Vue interpolation in a fence.
    const vueInterpolation = lang.endsWith('-vue');
    if (vueInterpolation) {
      lang = lang.slice(0, -4);
    }
    if (!isSupportedLanguage(lang)) {
      throw new Error(`The docs highlighter has no language '${lang}'. Use one that it has.`);
    }

    // Keep mustaches intact for Vue while preventing the lexer from splitting
    // an interpolation across spans in the compiled template.
    const mustaches = new Map<string, string>();
    const input = vueInterpolation
      ? code.replace(/\{\{.*?\}\}/g, (match) => {
          let marker = mustaches.get(match);
          if (!marker) {
            marker = `vpvue${randomUUID().replaceAll('-', '')}`;
            mustaches.set(match, marker);
          }
          return marker;
        })
      : code;
    const restoreMustaches = (html: string): string => {
      for (const [mustache, marker] of mustaches) {
        html = html.replaceAll(marker, mustache);
      }
      return html;
    };
    const tokensByLine = codeToTokens(input.trimEnd(), { lang: lang as Lang, ...OPTIONS }).tokens;
    const shell = ['shellscript', 'shell', 'bash', 'sh', 'zsh'].includes(lang);
    const highlighted = metaHighlightedRanges(attrs);
    const preClasses = new Set<string>();
    const lines: Array<string> = [];

    // Most blocks have neither notations nor a line range.
    if (!highlighted && !code.includes('[!code ')) {
      for (const tokens of tokensByLine) {
        lines.push(renderLine(shell ? disableShellPromptSelection(tokens) : tokens, 'line'));
      }
    } else {
      // Notations still to apply. One with a `:N` count stays for the lines
      // that follow.
      let running: Array<{ line: ReadonlyArray<string>; remaining: number }> = [];
      tokensByLine.forEach((lineTokens, index) => {
        const { tokens, notations } = takeNotations(lineTokens, lang);
        for (const entry of notations) {
          preClasses.add(entry.pre);
          running.push({ line: entry.line, remaining: entry.count });
        }
        // A line that held only the comment is dropped, and its notations
        // apply from the next line.
        if (notations.length > 0 && tokens.every((token) => !/\S/.test(token.content))) {
          return;
        }
        const classes = new Set(['line']);
        if (highlighted?.some((range) => index + 1 >= range.from && index + 1 <= range.to)) {
          classes.add('highlighted');
        }
        for (const entry of running) {
          for (const lineClass of entry.line) {
            classes.add(lineClass);
          }
          entry.remaining--;
        }
        running = running.filter((entry) => entry.remaining > 0);
        lines.push(
          renderLine(shell ? disableShellPromptSelection(tokens) : tokens, [...classes].join(' ')),
        );
      });
    }

    // Vue-specific fences allow interpolation; other fences render literally.
    return restoreMustaches(
      `<pre class="${[preClass, ...preClasses].join(' ')}" style="${preStyle}" tabindex="0" dir="ltr"${vueInterpolation ? '' : ' v-pre'}>` +
        `<code>${lines.join('\n')}</code></pre>`,
    );
  };
}
