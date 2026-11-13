import type MarkdownExit from 'markdown-exit';
import type { RuleCore, Token } from 'markdown-exit';

const markerRE = /^\[([ xX])\][ \t]+(?=\S)/;

/**
 * GitHub-style task lists: `- [ ] todo` and `- [x] done`. Each item gets a
 * disabled checkbox and the `task-list-item` class, and its list gets
 * `contains-task-list`, which the theme styles.
 */
export function taskListPlugin(md: MarkdownExit): void {
  const rule: RuleCore = (state) => {
    const tokens = state.tokens;
    for (let index = 2; index < tokens.length; index++) {
      const inline = tokens[index];
      if (
        inline.type !== 'inline' ||
        tokens[index - 1].type !== 'paragraph_open' ||
        tokens[index - 2].type !== 'list_item_open'
      ) {
        continue;
      }
      const match = markerRE.exec(inline.content);
      const first = inline.children?.[0];
      if (!match || !first || first.type !== 'text' || !markerRE.test(first.content)) {
        continue;
      }
      const item = tokens[index - 2];
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${
        match[1] === ' ' ? '' : ' checked'
      }> `;
      first.content = first.content.replace(markerRE, '');
      inline.content = inline.content.replace(markerRE, '');
      inline.children!.unshift(checkbox);
      item.attrJoin('class', 'task-list-item');
      const list = findParentList(tokens, index - 2);
      if (list && !list.attrGet('class')?.split(' ').includes('contains-task-list')) {
        list.attrJoin('class', 'contains-task-list');
      }
    }
  };
  md.core.ruler.after('inline', 'task_lists', rule);
}

function findParentList(tokens: ReadonlyArray<Token>, itemIndex: number): Token | undefined {
  const level = tokens[itemIndex].level - 1;
  for (let index = itemIndex - 1; index >= 0; index--) {
    const token = tokens[index];
    if (
      token.level === level &&
      (token.type === 'bullet_list_open' || token.type === 'ordered_list_open')
    ) {
      return token;
    }
  }
  return undefined;
}
