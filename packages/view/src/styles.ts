import { Features, transform, type Selector } from 'lightningcss';

/** Scope selectors at compile time. Static :root rules are global; instance rules stay in their host. */
export function scopeStyles(
  css: string,
  attribute: string,
  filename: string,
  instance = false,
): string {
  // Flatten nesting first so :root { .global {} } and :root .global {} take the same path.
  const flattened = transform({ filename, code: Buffer.from(css), include: Features.Nesting }).code;
  return transform({
    filename,
    code: flattened,
    minify: !instance,
    visitor: {
      Selector(selector) {
        if (selector[0]?.type === 'pseudo-class' && selector[0].kind === 'root') {
          if (!instance) {
            return selector;
          }
          selector = selector.slice(1);
          if (selector[0]?.type === 'combinator') {
            selector = selector.slice(1);
          }
        }
        const scoped: Selector = instance
          ? [
              { type: 'attribute', name: 'data-vv-rid-vvINSTANCE' },
              ...(selector.length
                ? [{ type: 'combinator' as const, value: 'descendant' as const }]
                : []),
            ]
          : [];
        let compound: Selector = [];
        function flush() {
          if (!compound.length) {
            return;
          }
          const pseudo = compound.findIndex((part) => part.type === 'pseudo-element');
          compound.splice(pseudo < 0 ? compound.length : pseudo, 0, {
            type: 'attribute',
            name: instance ? 'data-vv-cid-vvINSTANCE' : attribute,
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
