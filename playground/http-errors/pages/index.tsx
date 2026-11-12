import { Link } from '@void/react';
import type { ReactNode } from 'react';
import { SourceLink } from '../src/source-link.tsx';

const loaderExamples = [
  {
    path: '/loaders/status/403',
    title: 'Loader sets 403',
    file: 'pages/loaders/status/[status].server.ts',
    code: 'c.status(403);\nreturn { message: messages[403] };',
  },
  {
    path: '/loaders/status/503',
    title: 'Loader sets 503',
    file: 'pages/loaders/status/[status].server.ts',
    code: "c.status(503);\nc.header('Retry-After', '120');\nreturn { message: messages[503] };",
  },
  {
    path: '/loaders/validated',
    title: 'Validated loader sets 503',
    file: 'pages/loaders/validated.server.ts',
    code: 'export const loader = defineHandler.withValidator({})((c) => {\n  c.status(503);\n  return { message: messages[503] };\n});',
  },
  {
    path: '/loaders/deferred',
    title: 'Loader sets 429 before deferred streaming',
    file: 'pages/loaders/deferred.server.ts',
    code: 'c.status(429);\nreturn { details: defer(async () => {\n  await new Promise(resolve => setTimeout(resolve, 1000));\n  return messages[429];\n}) };',
  },
] as const;

const middlewareExamples = [
  {
    path: '/middleware/application',
    title: 'Application middleware sets 503',
    file: 'middleware/http-errors.ts',
    code: '// Inside application middleware, for this path:\nc.status(503);\nawait next();',
  },
  {
    path: '/middleware/handler',
    title: 'Handler middleware sets 403',
    file: 'pages/middleware/handler.server.ts',
    code: 'const guard = defineMiddleware(async (c, next) => {\n  c.status(403);\n  await next();\n});\nexport const loader = defineHandler(guard, () => ({ message: messages[403] }));',
  },
] as const;

function Visits({ path }: { path: string }) {
  return (
    <p>
      <a href={path}>Document load</a> | <Link href={path}>Client navigation</Link>
    </p>
  );
}

function Example({
  title,
  file,
  code,
  expected,
  children,
}: {
  title: string;
  file: string;
  code?: string;
  expected: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="example">
      <h3>{title}</h3>
      <p>
        <SourceLink file={file} />
      </p>
      {code && <pre>{code}</pre>}
      <h4>Expected</h4>
      {expected}
      {children}
    </section>
  );
}

export default function Home() {
  return (
    <>
      <h1>HTTP Errors Example</h1>
      <p>
        Explore how loader and middleware APIs affect response statuses, page content, and layouts.
        Compare full document loads, client navigation, deferred streaming, and prefetching.
      </p>
      <p>
        <strong>Related:</strong>{' '}
        <a href="https://github.com/voidzero-dev/void/issues/784">Issue #784</a> |{' '}
        <a href="https://github.com/voidzero-dev/void/pull/788">PR #788</a>
      </p>
      <hr />

      <section aria-labelledby="loaders">
        <h2 id="loaders">Loaders</h2>
        <p>
          Use c.status() to choose the HTTP status while returning props for the requested page. An
          error status does not select _error or stop rendering. Both document loads and client
          navigation display the page with its props and layouts.
        </p>
        <div className="examples">
          {loaderExamples.map(({ path, title, file, code }) => (
            <Example
              key={path}
              title={title}
              file={file}
              code={code}
              expected={
                <p>
                  The response uses the requested status and renders the page with its props and
                  layouts. Client navigation keeps the app’s layout.
                </p>
              }
            >
              <Visits path={path} />
            </Example>
          ))}

          <Example
            title="Prefetch deferred data with HTTP 429"
            file="pages/loaders/deferred.server.ts"
            expected={
              <p>
                HTTP 429, Purpose: prefetch, and a complete JSON payload after the one-second
                deferred task. Prefetching waits for deferred props rather than streaming them.
              </p>
            }
          >
            <p>
              Hover or focus this link without clicking, then inspect the prefetch request in the
              browser’s Network panel.
            </p>
            <Link href="/loaders/deferred" prefetch>
              Hover or focus to prefetch deferred data
            </Link>
          </Example>

          {[401, 403, 410, 429, 503].map((status) => (
            <Example
              key={status}
              title={`Loader throws ${status}`}
              file="pages/loaders/errors/[status].server.ts"
              code={`throw new HTTPException(${status}, { message: messages[${status}] });`}
              expected={
                <p>
                  Stops the loader and renders the nested _error boundary with the thrown HTTP
                  status and message. The root and nested layouts remain visible, and client
                  navigation keeps the app’s layout.
                </p>
              }
            >
              <Visits path={`/loaders/errors/${status}`} />
            </Example>
          ))}

          <Example
            title="Unexpected loader error → root _error, HTTP 500"
            file="pages/loaders/unexpected.server.ts"
            code="throw new Error(messages[500]);"
            expected={<p>HTTP 500 with the root error boundary inside the app’s layout.</p>}
          >
            <Visits path="/loaders/unexpected" />
          </Example>
          <Example
            title="Loader throws 404 → _not-found, HTTP 404"
            file="pages/loaders/not-found.server.ts"
            code="throw new HTTPException(404, { message: messages[404] });"
            expected={<p>HTTP 404 with the not-found boundary inside the app’s layout.</p>}
          >
            <Visits path="/loaders/not-found" />
          </Example>
        </div>
      </section>

      <hr />
      <section aria-labelledby="middleware">
        <h2 id="middleware">Middleware</h2>
        <p>
          Application middleware runs before the route handler. Handler middleware runs as part of
          defineHandler(). Both can set a status and call await next() to render the page normally.
        </p>
        <div className="examples">
          {middlewareExamples.map(({ path, title, file, code }) => (
            <Example
              key={path}
              title={title}
              file={file}
              code={code}
              expected={
                <p>
                  The loader runs and the response uses the middleware’s status, rendering the page
                  with its props and layouts.
                </p>
              }
            >
              <Visits path={path} />
            </Example>
          ))}

          {[403, 503].map((status) => (
            <Example
              key={status}
              title={`Middleware throws ${status}`}
              file="middleware/http-errors.ts"
              code={`// Before await next():\nthrow new HTTPException(${status}, { message: messages[${status}] });`}
              expected={
                <p>
                  Stops the request before its loader runs and renders the root _error boundary with
                  the thrown HTTP status and message. The root layout remains visible, and client
                  navigation keeps it mounted.
                </p>
              }
            >
              <Visits path={`/middleware/errors/${status}`} />
            </Example>
          ))}
        </div>
      </section>
    </>
  );
}
