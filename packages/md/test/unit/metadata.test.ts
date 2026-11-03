import { describe, expect, it } from 'vite-plus/test';
import { compile } from '../../src/compile.ts';
import { extractMetadata } from '../../src/metadata.ts';

describe('extractMetadata', () => {
  it('extracts headings, title, and frontmatter', () => {
    const result = extractMetadata('---\ntitle: Doc\n---\n\n# Heading\n\n## Section');
    expect(result.title).toBe('Doc');
    expect(result.frontmatter.title).toBe('Doc');
    expect(result.headings).toMatchObject([
      { depth: 1, text: 'Heading', slug: 'heading' },
      { depth: 2, text: 'Section', slug: 'section' },
    ]);
  });

  it('keeps rejecting invalid frontmatter after the first read', async () => {
    const source = '---\ntitle\ndescription: Missing colon above\n---\n\n# Heading\n';

    // Dev reads a page for navigation metadata before rendering it. Every
    // read must report the error instead of treating the YAML fences as content.
    expect(() => extractMetadata(source)).toThrow('Invalid frontmatter');
    expect(() => extractMetadata(source)).toThrow('Invalid frontmatter');
    await expect(compile(source)).rejects.toThrow('Invalid frontmatter');
  });

  it('strips footnote refs from heading text/slug to match rendered anchor ids', async () => {
    const source = '## API[^1]\n\nBody[^1].\n\n[^1]: note';

    const meta = extractMetadata(source);
    expect(meta.headings).toMatchObject([{ depth: 2, text: 'API', slug: 'api' }]);

    // The metadata slug must equal the id actually rendered by compile(),
    // so links built from `@void/md/pages` resolve to a real anchor.
    const compiled = await compile(source);
    expect(meta.headings[0]?.slug).toBe(compiled.headings[0]?.slug);
    expect(compiled.html).toContain('id="api"');
  });
});
