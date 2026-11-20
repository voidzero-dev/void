import { AsyncMessage } from '../components/AsyncMessage.tsx';
import { SourceLink } from '../components/SourceLink.tsx';

export default function AsyncContext() {
  return (
    <>
      <h1>Async layouts and context</h1>
      <SourceLink file="pages/async-context.server.tsx" />
      <AsyncMessage name="reader" />
      <p>
        The root layout reads <code>greeting</code> from the query. The async child reads that value
        from JSX context before its first await.
      </p>
      <p>
        <a href="/async-context?greeting=Good%20morning">Try a different greeting</a>
      </p>
    </>
  );
}
