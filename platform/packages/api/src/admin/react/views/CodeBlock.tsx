/** @jsxImportSource react */

import { Fragment, useEffect, useState } from 'react';
import { loadCodeHighlighter } from '../code-highlighting.ts';
import type { CodeLanguage, CodeToken } from '../code-highlighting.ts';

// Keep unusually large output readable without expensive tokenization on the main thread.
const MAX_HIGHLIGHT_LENGTH = 100_000;

export function CodeBlock({ code, language = 'text' }: { code: string; language?: CodeLanguage }) {
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: CodeLanguage;
    lines: Array<Array<CodeToken>>;
  } | null>(null);

  useEffect(() => {
    if (language === 'text' || code.length > MAX_HIGHLIGHT_LENGTH) {
      return;
    }
    let cancelled = false;
    // SSR and the first client render show the complete code immediately. Only the browser
    // loads Shiki; highlighting must not delay navigation or make the Worker tokenize code.
    void loadCodeHighlighter()
      .then((highlight) => {
        if (!cancelled && highlight) {
          setHighlighted({ code, language, lines: highlight(code, language) });
        }
      })
      .catch(() => {
        // Plain code remains available if the browser cannot initialize the regex engine.
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const lines =
    highlighted?.code === code && highlighted.language === language ? highlighted.lines : null;
  return (
    <pre className="void-admin-code-block" data-language={language} tabIndex={0}>
      <code>
        {lines
          ? lines.map((line, index) => (
              <Fragment key={index}>
                {index > 0 && '\n'}
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={token.style}>
                    {token.content}
                  </span>
                ))}
              </Fragment>
            ))
          : code}
      </code>
    </pre>
  );
}
