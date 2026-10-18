import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IMAGE_MODULE = join(import.meta.dirname, '../../src/runtime/image.ts');

let counter = 0;

/** The `<link>` tags the fixture page's images preload, deduplicated, in render order. */
export const IMAGE_PAGE_PRELOADS: string =
  '<link rel="preload" as="image" imagesrcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x">' +
  '<link rel="preload" as="image" href="/b.png">';

/**
 * Import a generated page or island renderer with its `pageFile` import
 * pointed at a page that renders preloaded `Image`s (two with the same source),
 * so tests run the renderer's real SSR context and `<head>` assembly. Files are
 * written to `dir`, inside this package, so `vue` and `void` resolve.
 */
export async function importRendererWithImagePage(
  renderer: string,
  pageImportPath: string,
  dir: string,
): Promise<Record<string, unknown>> {
  const id = counter++;
  const pagePath = join(dir, `image-page-${id}.ts`);
  writeFileSync(
    pagePath,
    `import { defineComponent, h } from "vue";
import { Image } from ${JSON.stringify(IMAGE_MODULE)};
const lcp = { src: "/lcp.jpg", alt: "LCP", width: 800, height: 400, preload: true };
export default defineComponent({
  setup: () => () =>
    h("main", [
      h(Image, lcp),
      h(Image, { ...lcp, alt: "LCP again" }),
      h(Image, { src: "/b.png", alt: "B", width: 10, height: 10, priority: true, unoptimized: true }),
      h(Image, { src: "/c.png", alt: "C", width: 10, height: 10 }),
    ]),
});
`,
  );
  const quoted = JSON.stringify(pageImportPath);
  if (!renderer.includes(`import(${quoted})`)) {
    throw new Error(`Renderer does not import ${quoted}.`);
  }
  const rendererPath = join(dir, `renderer-${id}.mjs`);
  writeFileSync(
    rendererPath,
    renderer.replace(`import(${quoted})`, `import(${JSON.stringify(pagePath)})`),
  );
  return (await import(rendererPath)) as Record<string, unknown>;
}
