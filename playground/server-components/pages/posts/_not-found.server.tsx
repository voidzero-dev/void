import type { CloudContext } from 'void';
import { SourceLink } from '../../components/SourceLink.tsx';

export default function PostNotFound(c: CloudContext) {
  return (
    <>
      <h1>Post not found</h1>
      <SourceLink file="pages/posts/_not-found.server.tsx" />
      <p>
        No published post matches <code>{c.req.path}</code>.
      </p>
      <a href="/posts">Back to posts</a>
    </>
  );
}
