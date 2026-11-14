import { Features, transform, type Selector } from 'lightningcss';

/** Scope selectors at compile time. A leading :root explicitly opts a selector into global CSS. */
export function scopeStyles(css: string, attribute: string, filename: string): string {
  // Flatten nesting first so :root { .global {} } and :root .global {} take the same path.
  const flattened = transform({ filename, code: Buffer.from(css), include: Features.Nesting }).code;
  return transform({
    filename,
    code: flattened,
    minify: true,
    visitor: {
      Selector(selector) {
        if (selector[0]?.type === 'pseudo-class' && selector[0].kind === 'root') {
          return selector;
        }
        const scoped: Selector = [];
        let compound: Selector = [];
        function flush() {
          if (!compound.length) {
            return;
          }
          const pseudo = compound.findIndex((part) => part.type === 'pseudo-element');
          compound.splice(pseudo < 0 ? compound.length : pseudo, 0, {
            type: 'attribute',
            name: attribute,
          });
          scoped.push(...compound);
          compound = [];
        }
        for (const part of selector) {
          if (part.type === 'combinator') {
            flush();
            scoped.push(part);
          } else {
            compound.push(part);
          }
        }
        flush();
        return scoped;
      },
    },
  }).code.toString();
}
