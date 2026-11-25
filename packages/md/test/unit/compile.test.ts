import { describe, expect, it } from 'vite-plus/test';
import { compile } from '../../src/compile.ts';

describe('compile', () => {
  it('compiles basic markdown to HTML', { timeout: 30_000 }, async () => {
    const result = await compile('# Hello\n\nWorld');
    expect(result.html).toContain('<h1');
    expect(result.html).toContain('Hello');
    expect(result.html).toContain('<p>World</p>');
  });

  it('extracts frontmatter', async () => {
    const result = await compile('---\ntitle: My Page\ndescription: A test\n---\n\n# Content');
    expect(result.frontmatter.title).toBe('My Page');
    expect(result.frontmatter.description).toBe('A test');
    expect(result.title).toBe('My Page');
  });

  it('uses first h1 as title when no frontmatter title', async () => {
    const result = await compile('# Hello World\n\nContent');
    expect(result.title).toBe('Hello World');
  });

  it('extracts headings', async () => {
    const result = await compile('# Title\n\n## Section 1\n\n### Subsection\n\n## Section 2');
    expect(result.headings).toHaveLength(4);
    expect(result.headings[0]).toMatchObject({ depth: 1, text: 'Title' });
    expect(result.headings[1]).toMatchObject({ depth: 2, text: 'Section 1' });
    expect(result.headings[2]).toMatchObject({ depth: 3, text: 'Subsection' });
    expect(result.headings[3]).toMatchObject({ depth: 2, text: 'Section 2' });
  });

  // The 0-based indices of code lines that carry the `highlighted` class.
  // (The highlighter emits one `<span class="line">` per line plus a trailing empty line,
  // so we compare highlighted positions rather than a fixed line count.)
  const highlightedLineIndices = (html: string): ReadonlyArray<number> =>
    [...html.matchAll(/<span class="(line[^"]*)"/g)].flatMap((match, index) =>
      match[1].includes('highlighted') ? [index] : [],
    );

  it('highlights a single {N} fence line (markdown-it-attrs must not eat it)', async () => {
    const result = await compile('```ts {2}\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```');
    expect(highlightedLineIndices(result.html)).toEqual([1]);
  });

  it('highlights a {N-M} line range and a combined {a,c-d} set', async () => {
    const range = await compile('```ts {2-3}\nlet a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;\n```');
    expect(highlightedLineIndices(range.html)).toEqual([1, 2]);

    const combined = await compile(
      '```ts {1,3-4}\nlet a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;\n```',
    );
    expect(highlightedLineIndices(combined.html)).toEqual([0, 2, 3]);
  });

  it('highlights {N} even for languages without comment syntax (e.g. text)', async () => {
    const result = await compile('```text {1}\nalpha\nbeta\n```');
    expect(highlightedLineIndices(result.html)).toEqual([0]);
  });

  it('leaves fences without curly meta unhighlighted', async () => {
    const result = await compile('```ts\nconst a = 1;\nconst b = 2;\n```');
    expect(result.html).not.toContain('highlighted');
  });

  it('highlights code blocks with the default light and dark themes', async () => {
    const result = await compile('```ts\nconst a = 1;\n```');
    expect(result.html).toContain('class="shiki shiki-themes github-light github-dark"');
  });

  it('still applies markdown-it-attrs to non-fence content', async () => {
    const result = await compile('Hello {.greeting}\n');
    expect(result.html).toContain('greeting');
  });

  it('adds anchor links to headings', async () => {
    const result = await compile('## My Heading');
    expect(result.html).toContain('id=');
    expect(result.html).toContain('my-heading');
  });

  it('renders footnotes exactly once (no double-accumulation from shared env)', async () => {
    const result = await compile('Here is a footnote reference.[^1]\n\n[^1]: The footnote body.');
    // Ref marker, back-reference target, and the footnote block each appear once.
    expect(result.html.match(/id="fnref1"/g)).toHaveLength(1);
    expect(result.html.match(/id="fn1"/g)).toHaveLength(1);
    expect(result.html.match(/class="footnotes"/g)).toHaveLength(1);
    expect(result.html.match(/class="footnote-item"/g)).toHaveLength(1);
    expect(result.html).toContain('The footnote body.');
  });

  it('handles empty source', async () => {
    const result = await compile('');
    expect(result.html).toBe('');
    expect(result.frontmatter).toEqual({});
    expect(result.headings).toEqual([]);
    expect(result.title).toBe('');
  });

  it('handles frontmatter only', async () => {
    const result = await compile('---\ntitle: Test\n---\n');
    expect(result.frontmatter.title).toBe('Test');
    expect(result.title).toBe('Test');
  });
});
