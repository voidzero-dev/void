export const posts = {
  hello: { title: 'Hello from Void', author: 'The Void team', category: 'Getting started' },
  long: {
    title: 'Build full-stack applications on Cloudflare Workers with Vite and Void',
    author: 'The Void team',
    category: 'A longer title',
  },
};

export function getPost(slug: string) {
  return Object.entries(posts).find(([key]) => key === slug)?.[1];
}
