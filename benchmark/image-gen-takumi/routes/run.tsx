/** @jsxImportSource void/jsx */
import { takumiRenderer } from '@void/image-renderer-takumi';
import { defineHandler } from 'void';
import { ImageResponse } from 'void/image';
import { parseImageQuery } from '../src/query.ts';

export const GET = defineHandler(async (c) => {
  let query;
  try {
    query = parseImageQuery(new URL(c.req.url).searchParams);
  } catch (error) {
    if (error instanceof TypeError) {
      return c.text(error.message, 400, { 'Cache-Control': 'no-store' });
    }
    throw error;
  }

  const { text, iterations, emoji, fallbackFonts, ...options } = query;
  if (iterations === 0) {
    return new Response(null, { headers: { 'Cache-Control': 'no-store' } });
  }

  const content = (
    <div style="display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 64px; background: white; color: black">
      {text}
    </div>
  );

  // Drain each body before rendering again. Do not accumulate PNGs in the stress workload.
  for (let index = 1; index < iterations; index++) {
    await new ImageResponse(content, {
      ...options,
      renderer: [takumiRenderer, { emoji, fallbackFonts }],
    }).arrayBuffer();
  }
  return new ImageResponse(content, {
    ...options,
    renderer: [takumiRenderer, { emoji, fallbackFonts }],
    headers: { 'Cache-Control': 'no-store' },
  });
});
