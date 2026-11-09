type Props = {
  post: { slug: string; title: string; body: string };
};

export default function BlogPost(props: Props) {
  return (
    <div>
      <h1>{props.post.title}</h1>
      <p>{props.post.body}</p>
      <a href="/blog">&larr; Back to Blog</a>
    </div>
  );
}
