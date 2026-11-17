import { SourceLink } from '../../components/SourceLink.tsx';

export default function CustomLayoutExample() {
  return (
    <>
      <h1>Use a custom layout</h1>
      <SourceLink file="pages/custom-layout/index.server.tsx" />
      <p>
        The <code>layout.server.tsx</code> file in this directory wraps its pages. It adds the Field
        Guide header and footer while keeping the playground’s root navigation.
      </p>
    </>
  );
}
