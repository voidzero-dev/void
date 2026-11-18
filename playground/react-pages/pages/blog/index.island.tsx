import Counter from './_Counter.tsx' with { island: 'load' };
import PostForm from './_PostForm.tsx' with { island: 'load' };

type Props = {
  posts: ReadonlyArray<{ slug: string; title: string }>;
};

export default function BlogIndex({ posts }: Props) {
  return (
    <div>
      <h1>Blog</h1>
      <Counter initial={0} createdAt={new Date('2026-11-08T00:00:00Z')} />
      <h2>Posts</h2>
      <ul>
        {posts.map((post) => (
          <li key={post.slug}>
            <a href={`/blog/${post.slug}`}>{post.title}</a>
          </li>
        ))}
      </ul>
      <h2>New Post</h2>
      <PostForm />
    </div>
  );
}
