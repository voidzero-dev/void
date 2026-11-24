import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import json from 'shiki/langs/json.mjs';
import shell from 'shiki/langs/shellscript.mjs';
import type { CodeLanguage, CodeToken } from './code-highlighting.ts';
import Dunkel from './themes/dunkel.ts';
import Licht from './themes/licht.ts';

let highlighter: ReturnType<typeof createHighlighterCoreSync> | undefined;

export function highlightCode(code: string, language: Exclude<CodeLanguage, 'text'>) {
  highlighter ??= createHighlighterCoreSync({
    engine: createJavaScriptRegexEngine(),
    langs: [json, shell],
    themes: [Licht, Dunkel],
  });
  return highlighter
    .codeToTokens(code, {
      lang: language,
      themes: { light: 'Licht', dark: 'Dunkel' },
      defaultColor: 'light-dark()',
    })
    .tokens.map((line): Array<CodeToken> =>
      line.map((token) => ({
        content: token.content,
        style: Object.fromEntries(
          Object.entries(token.htmlStyle ?? {}).map(([property, value]) => [
            property.startsWith('--')
              ? property
              : property.replaceAll(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
            value,
          ]),
        ),
      })),
    );
}
