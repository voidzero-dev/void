import { defineHandler } from 'void';
import { ImageResponse } from 'void/image';
import { Card } from '../../../src/card.tsx';
import { getPost } from '../../../src/posts.ts';

export const GET = defineHandler((c) => {
  const post = getPost(c.req.param('slug') ?? '');
  if (!post) {
    return c.notFound();
  }
  return new ImageResponse(
    <Card>
      <div style={{ fontSize: 28, color: '#38bdf8' }}>{post.category}</div>
      <div style={{ fontSize: 72, fontWeight: 700, lineHeight: 1.1 }}>{post.title}</div>
      <div style={{ fontSize: 30, opacity: 0.7 }}>{post.author}</div>
    </Card>,
    { width: 1200, height: 630 },
  );
});
