import { defineHandler, defineHead } from 'void';
import { getExample, getExamplePreview, imagePath } from '../../src/examples.ts';
import type { RendererChoice } from '../../src/renderer-select.tsx';

export interface Props {
  variant: string;
  values: Record<string, string>;
  renderer: RendererChoice;
  imageUrl: string;
}

export const loader = defineHandler((c) => {
  const example = getExample(c.req.param('variant') ?? '');
  if (!example) {
    return c.notFound();
  }
  const renderer =
    !example.takumiOnly && c.req.query('renderer') === 'browser' ? 'browser' : 'takumi';
  const preview = getExamplePreview(example, renderer);
  const values = Object.fromEntries(
    preview.controls.map((control) => {
      const requested = c.req.query(control.name) ?? control.value;
      const value =
        control.options && !control.options.some((option) => option.value === requested)
          ? control.value
          : requested.slice(0, 200);
      return [control.name, value];
    }),
  );
  return {
    variant: example.id,
    values,
    renderer,
    imageUrl: imagePath(example.id, { ...values, renderer }),
  } satisfies Props;
});

export const head = defineHead<Props>((c, props) => {
  const example = getExample(props.variant)!;
  return {
    title: `${example.title} | ImageResponse Playground`,
    meta: [
      { property: 'og:title', content: example.title },
      { property: 'og:image', content: new URL(props.imageUrl, c.req.url).href },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  };
});
