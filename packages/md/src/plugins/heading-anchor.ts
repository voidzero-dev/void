import type { MarkdownExit, PluginWithOptions } from 'markdown-exit';
import anchor from 'markdown-it-anchor';

export function headingAnchorPlugin(markdown: MarkdownExit): void {
  // Both parsers support the same plugin API, but markdown-it 15's private
  // Ruler fields prevent its plugin types from accepting markdown-exit.
  const plugin = anchor as unknown as PluginWithOptions<anchor.AnchorOptions>;
  markdown.use(plugin, {
    permalink: anchor.permalink.ariaHidden({ placement: 'before' }),
  });
}
