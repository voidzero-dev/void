import type MarkdownExit from 'markdown-exit';
import type { RuleCore, Token } from 'markdown-exit';

const markerRE = /^\[!(TIP|NOTE|INFO|IMPORTANT|WARNING|CAUTION|DANGER)\]([^\n\r]*)/i;

const titleMark: Record<string, string> = {
  tip: 'TIP',
  note: 'NOTE',
  info: 'INFO',
  important: 'IMPORTANT',
  warning: 'WARNING',
  caution: 'CAUTION',
  danger: 'DANGER',
};

type AlertToken = Token & {
  meta?: { title: string; type: string };
};

const rule: RuleCore = (state) => {
  const tokens = state.tokens as ReadonlyArray<AlertToken>;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    if (tokens[tokenIndex].type === 'blockquote_open') {
      const startIndex = tokenIndex;
      const open = tokens[startIndex];
      let endIndex = tokenIndex + 1;
      while (
        endIndex < tokens.length &&
        (tokens[endIndex].type !== 'blockquote_close' || tokens[endIndex].level !== open.level)
      ) {
        endIndex++;
      }
      if (endIndex === tokens.length) {
        continue;
      }
      const close = tokens[endIndex];
      const firstContent = tokens
        .slice(startIndex, endIndex + 1)
        .find((token) => token.type === 'inline');
      if (!firstContent) {
        continue;
      }
      const match = firstContent.content.match(markerRE);
      if (!match) {
        continue;
      }
      const type = match[1].toLowerCase();
      const title = match[2].trim() || titleMark[type];
      firstContent.content = firstContent.content.slice(match[0].length).trimStart();
      open.type = 'github_alert_open';
      open.tag = 'div';
      open.meta = { title, type };
      close.type = 'github_alert_close';
      close.tag = 'div';
    }
  }
};

/**
 * GitHub-flavored alerts: > [!NOTE], > [!TIP], > [!WARNING], etc.
 * Ported from VitePress.
 */
export function gitHubAlertsPlugin(md: MarkdownExit): void {
  md.core.ruler.after('block', 'github-alerts', rule);

  md.renderer.rules.github_alert_open = function (tokens: ReadonlyArray<AlertToken>, idx: number) {
    const { title, type } = tokens[idx].meta!;
    return `<div class="${type} custom-block github-alert"><p class="custom-block-title">${title}</p>\n`;
  };
}
