import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CompileOptions } from '../../src/compile.ts';

const source = '```ts\nconst a = 1;\n```';

// The compiler is created once per module, from the options of the first call.
async function compileFresh(options: CompileOptions): Promise<string> {
  const { compile } = await import('../../src/compile.ts');
  return (await compile(source, options)).html;
}

describe('code block themes', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses the themes option', async () => {
    const html = await compileFresh({ themes: { light: 'github-light', dark: 'github-dark' } });
    expect(html).toContain('class="shiki shiki-themes github-light github-dark"');
  });

  it('still reads the deprecated shiki.themes option', async () => {
    const html = await compileFresh({
      shiki: { themes: { light: 'vitesse-light', dark: 'vitesse-dark' } },
    });
    expect(html).toContain('class="shiki shiki-themes vitesse-light vitesse-dark"');
  });

  it('prefers themes over shiki.themes', async () => {
    const html = await compileFresh({
      themes: { light: 'github-light', dark: 'github-dark' },
      shiki: { themes: { light: 'vitesse-light', dark: 'vitesse-dark' } },
    });
    expect(html).toContain('class="shiki shiki-themes github-light github-dark"');
  });
});
