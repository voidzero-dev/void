import { defineHandler, defineHead } from 'void';
import { getExample, imagePath } from '../../src/examples.ts';

export interface Props {
  variant: string;
  values: Record<string, string>;
  imageUrl: string;
}

export const loader = defineHandler((c) => {
  const example = getExample(c.req.param('variant') ?? '');
  if (!example) {
    return c.notFound();
  }
  const values = Object.fromEntries(
    example.controls.map((control) => {
      const requested = c.req.query(control.name) ?? control.value;
      const value =
        control.options && !control.options.some((option) => option.value === requested)
          ? control.value
          : requested.slice(0, 200);
      return [control.name, value];
    }),
  );
  return { variant: example.id, values, imageUrl: imagePath(example.id, values) } satisfies Props;
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
