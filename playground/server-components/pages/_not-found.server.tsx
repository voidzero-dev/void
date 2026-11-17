import { SourceLink } from '../components/SourceLink.tsx';

export default function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <SourceLink file="pages/_not-found.server.tsx" />
      <p>No page matches this URL. Void rendered the root not-found boundary.</p>
    </>
  );
}
