import { describe, expect, it } from 'vite-plus/test';
import { createCodeHighlighter } from '../../src/highlight.ts';

const highlight = await createCodeHighlighter({ light: 'github-light', dark: 'github-dark' });

function render(code: string, lang = 'ts', meta = lang): string {
  return highlight(code, lang, meta);
}

/** The class and text of each rendered line. */
function renderedLines(html: string): ReadonlyArray<Readonly<{ classes: string; text: string }>> {
  const code = html.slice(html.indexOf('<code>') + '<code>'.length, html.indexOf('</code>'));
  return code.split('\n').map((line) => ({
    classes: /^<span class="([^"]*)"/.exec(line)?.[1] ?? '',
    text: line
      .replaceAll(/<[^>]+>/g, '')
      .replaceAll('&#x3C;', '<')
      .replaceAll('&#x26;', '&'),
  }));
}

function lineClasses(html: string): ReadonlyArray<string> {
  return renderedLines(html).map((line) => line.classes);
}

function preClasses(html: string): string {
  return /^<pre class="([^"]*)"/.exec(html)?.[1] ?? '';
}

describe('createCodeHighlighter', () => {
  it('renders one line span per line with light and dark colors', () => {
    const html = render('const a = 1;\nconst b = 2;\n');

    expect(preClasses(html)).toBe('shiki shiki-themes github-light github-dark');
    expect(html).toContain('--shiki-dark-bg:');
    expect(html).toMatch(/<span style="color:#[0-9a-f]{6};--shiki-dark:#[0-9a-f]{6}">const /);
    expect(renderedLines(html)).toEqual([
      { classes: 'line', text: 'const a = 1;' },
      { classes: 'line', text: 'const b = 2;' },
      { classes: 'line', text: '' },
    ]);
  });

  it('escapes the code', () => {
    const html = render('<Counter a="1" /> && x\n', 'text');
    expect(html).not.toContain('<Counter');
    expect(renderedLines(html)[0].text).toBe('<Counter a="1" /> && x');
  });

  it('renders an unknown language as plain text', () => {
    const html = render('alpha\n', 'no-such-language');
    expect(renderedLines(html)[0]).toEqual({ classes: 'line', text: 'alpha' });
  });

  it('marks diff lines and removes the notation comment', () => {
    const html = render('a(); // [!code ++]\nb(); // [!code --]\nc();\n');

    expect(preClasses(html)).toContain('has-diff');
    expect(renderedLines(html).slice(0, 3)).toEqual([
      { classes: 'line diff add', text: 'a(); ' },
      { classes: 'line diff remove', text: 'b(); ' },
      { classes: 'line', text: 'c();' },
    ]);
  });

  it('marks highlight, focus, error and warning lines', () => {
    const html = render(
      [
        'a(); // [!code highlight]',
        'b(); // [!code hl]',
        'c(); // [!code focus]',
        'd(); // [!code error]',
        'e(); // [!code warning]',
        '',
      ].join('\n'),
    );

    expect(preClasses(html)).toBe(
      'shiki shiki-themes github-light github-dark has-highlighted has-focused',
    );
    expect(lineClasses(html)).toEqual([
      'line highlighted',
      'line highlighted',
      'line focused',
      'line highlighted error',
      'line highlighted warning',
      'line',
    ]);
  });

  it('keeps the rest of a comment that carries a notation', () => {
    const html = render('a(); // keep this [!code focus]\n');
    expect(renderedLines(html)[0]).toEqual({ classes: 'line focused', text: 'a(); // keep this' });
  });

  it('reads notations from the comment syntax of other languages', () => {
    const shell = render('npm install # [!code ++]\n', 'bash');
    expect(renderedLines(shell)[0]).toEqual({ classes: 'line diff add', text: 'npm install ' });

    const markup = render('<p>x</p> <!-- [!code ++] -->\n', 'html');
    expect(renderedLines(markup)[0]).toEqual({ classes: 'line diff add', text: '<p>x</p> ' });

    const block = render('a { } /* [!code focus] */\n', 'css');
    expect(renderedLines(block)[0]).toEqual({ classes: 'line focused', text: 'a { } ' });
  });

  it('removes a comment that held only a notation, whatever its delimiter', () => {
    const cases: ReadonlyArray<[string, string, string]> = [
      ['lisp', '(a) ; [!code ++]\n', '(a) '],
      ['latex', 'x % [!code ++]\n', 'x '],
      ['sql', 'select 1 -- [!code ++]\n', 'select 1 '],
      ['vim', 'let a=1 " [!code ++]\n', 'let a=1 '],
    ];
    for (const [lang, code, text] of cases) {
      expect(renderedLines(render(code, lang))[0]).toEqual({ classes: 'line diff add', text });
    }
  });

  it('applies a notation with a count to the following lines', () => {
    const html = render('a(); // [!code ++:2]\nb();\nc();\n');
    expect(lineClasses(html)).toEqual(['line diff add', 'line diff add', 'line', 'line']);
  });

  it('applies a notation on its own line to the next line', () => {
    const html = render('a();\n// [!code focus]\nb();\n');
    expect(renderedLines(html)).toEqual([
      { classes: 'line', text: 'a();' },
      { classes: 'line focused', text: 'b();' },
      { classes: 'line', text: '' },
    ]);
  });

  it('applies a counted notation on its own line to the lines after it', () => {
    const html = render('// [!code ++:2]\na();\nb();\nc();\n');
    expect(lineClasses(html)).toEqual(['line diff add', 'line diff add', 'line', 'line']);
  });

  it('drops a JSX comment that held only a notation, with its braces', () => {
    const html = render('  {/* [!code highlight:2] */}\n<A />\n<B />\n<C />\n', 'tsx');
    expect(renderedLines(html)).toEqual([
      { classes: 'line highlighted', text: '<A />' },
      { classes: 'line highlighted', text: '<B />' },
      { classes: 'line', text: '<C />' },
      { classes: 'line', text: '' },
    ]);
  });

  it('removes the braces of a JSX annotation at the end of a line', () => {
    const html = render('<A /> {/* [!code ++] */}\n', 'tsx');
    expect(renderedLines(html)[0]).toEqual({ classes: 'line diff add', text: '<A /> ' });
  });

  it('reads only HTML comments in a Markdown block, so code fences in it stay as written', () => {
    const fence = render('```ts\na(); // [!code ++]\n```\n', 'md');
    expect(preClasses(fence)).not.toContain('has-diff');
    expect(renderedLines(fence)[1]).toEqual({ classes: 'line', text: 'a(); // [!code ++]' });

    const comment = render('<!-- [!code focus] -->\ntext\n', 'md');
    expect(renderedLines(comment)[0]).toEqual({ classes: 'line focused', text: 'text' });
  });

  it('accepts a line range far past the end of the block', () => {
    const html = render('a();\nb();\n', 'ts', 'ts {2-1000000000}');
    expect(lineClasses(html)).toEqual(['line', 'line highlighted', 'line highlighted']);
  });

  describe.each(['jsx', 'tsx'])('%s comment expressions', (lang) => {
    it('removes standalone annotation braces and applies the count to following lines', () => {
      const html = render(
        '<div>\n  { /* [!code --:2] */ }\n  <Old />\n  <Older />\n  <New />\n</div>\n',
        lang,
      );
      expect(renderedLines(html)).toEqual([
        { classes: 'line', text: '<div>' },
        { classes: 'line diff remove', text: '  <Old />' },
        { classes: 'line diff remove', text: '  <Older />' },
        { classes: 'line', text: '  <New />' },
        { classes: 'line', text: '</div>' },
        { classes: 'line', text: '' },
      ]);
    });

    it('removes inline annotation braces without removing the surrounding JSX', () => {
      const html = render('<div><New /> {/* [!code ++] */}</div>\n', lang);
      expect(renderedLines(html)[0]).toEqual({
        classes: 'line diff add',
        text: '<div><New /> </div>',
      });
    });

    it('keeps braces around a comment with remaining text', () => {
      const html = render('<div>{/* keep this [!code focus] */}</div>\n', lang);
      expect(renderedLines(html)[0]).toEqual({
        classes: 'line focused',
        text: '<div>{/* keep this */}</div>',
      });
    });

    it('keeps function body braces around an annotation', () => {
      const html = render('function f() {/* [!code focus] */}\n', lang);
      expect(renderedLines(html)[0]).toEqual({
        classes: 'line focused',
        text: 'function f() {}',
      });
    });
  });

  it('leaves a notation outside a comment alone', () => {
    const html = render('const s = "// [!code ++]";\n');
    expect(preClasses(html)).not.toContain('has-diff');
    expect(renderedLines(html)[0]).toEqual({
      classes: 'line',
      text: 'const s = "// [!code ++]";',
    });
  });

  it('combines a line range from the fence info with a notation', () => {
    const html = render('a(); // [!code ++]\nb();\nc();\n', 'ts', 'ts {1,3}');
    expect(lineClasses(html)).toEqual([
      'line highlighted diff add',
      'line',
      'line highlighted',
      'line',
    ]);
  });

  it('uses the named themes', async () => {
    const other = await createCodeHighlighter({ light: 'vitesse-light', dark: 'vitesse-dark' });
    const html = other('const a = 1;\n', 'ts', 'ts');
    expect(preClasses(html)).toBe('shiki shiki-themes vitesse-light vitesse-dark');
  });

  it('rejects a module in the themes directory that is not a theme', async () => {
    await expect(createCodeHighlighter({ light: 'loader', dark: 'github-dark' })).rejects.toThrow(
      "Unknown code theme 'loader'.",
    );
  });

  it('rejects a theme that does not exist', async () => {
    await expect(
      createCodeHighlighter({ light: 'no-such-theme', dark: 'github-dark' }),
    ).rejects.toThrow("Unknown code theme 'no-such-theme'.");
  });
});
