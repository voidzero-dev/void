import { Link } from '@void/react';
import { useState, type ReactNode } from 'react';
import { SourceLink } from '../src/source-link.tsx';

const loaders = [
  {
    mode: 'optional-user',
    title: 'getUser(): optional auth',
    code: 'return { user: getUser() };',
    document: '200 page with user: null.',
    navigation: 'Same page, preserving the layout.',
    note: 'Reading the user does not protect the page.',
  },
  {
    mode: 'optional-session',
    title: 'getSession(): optional session',
    code: 'const state = getSession();\nreturn { user: state?.user ?? null,\n  expiresAt: state?.session.expiresAt ?? null };',
    document: '200 page with null user and expiry.',
    navigation: 'Same page, preserving the layout.',
    note: 'Reading the session does not require one.',
  },
  {
    mode: 'require-auth',
    title: 'requireAuth(): plain-text 401',
    code: 'return { user: requireAuth(c) };',
    document: '401 Unauthorized as plain text, replacing the app.',
    navigation: 'Falls back to a document load. The page and layout are replaced by plain text.',
    note: 'No login redirect; _error is bypassed even though it exists.',
  },
  {
    mode: 'return-redirect',
    title: 'Return a login redirect',
    code: "const user = getUser();\nif (!user) return c.redirect('/login');\nreturn { user };",
    document: '302 to login.',
    navigation: 'Visits login without reloading the document.',
    note: 'Redirects before the protected work runs.',
  },
  {
    mode: 'throw-redirect',
    title: 'Throw a redirect from a helper',
    code: '// Inside requirePageUser(c):\nif (!user) {\n  throw new HTTPException(302, {\n    res: c.redirect(location, 302),\n  });\n}\nreturn user;',
    document: '302 to login.',
    navigation: 'Visits login without reloading the document, like a returned redirect.',
    note: 'The helper stops execution without returning a Response to its caller.',
  },
  {
    mode: 'auth-redirect',
    title: 'requireAuth(): login redirect',
    code: "const user = requireAuth(c, { throwRedirect: '/login' });\nreturn { user };",
    document: '302 to login.',
    navigation: 'Visits login without reloading the document.',
    note: 'Returns the user or throws a redirect.',
  },
  {
    mode: 'not-found',
    title: 'Throw 404 for comparison',
    code: 'const user = getUser();\nif (!user) throw new HTTPException(404);\nreturn { user };',
    document: '404 renders _not-found inside the layout.',
    navigation: 'Same boundary, preserving the layout.',
    note: 'Unlike 401, this HTTPException selects a page boundary. No login redirect.',
  },
  {
    mode: 'unexpected',
    title: 'Throw an ordinary error for comparison',
    code: "const user = getUser();\nif (!user) throw new Error('No user');\nreturn { user };",
    document: '500 renders _error inside the layout.',
    navigation: 'Same boundary, preserving the layout.',
    note: 'An ordinary error is not an authentication response. No login redirect.',
  },
] as const;

const guards = [
  {
    mode: 'require-auth',
    title: 'requireAuth',
    code: 'requireAuth(c);',
    document: '401 plain text, replacing the app.',
    navigation: 'Falls back to a document load, replacing the page and layout with plain text.',
    note: 'No login redirect or server-rendered error boundary.',
  },
  {
    mode: 'return-redirect',
    title: 'Returned redirect',
    code: "if (!getUser()) return c.redirect('/login');",
    document: '302 to login.',
    navigation: 'Visits login without reloading the document.',
    note: 'Redirects before the loader runs.',
  },
  {
    mode: 'throw-redirect',
    title: 'Thrown redirect',
    code: 'requirePageUser(c);',
    document: '302 to login.',
    navigation: 'Visits login without reloading the document.',
    note: 'The shared helper throws a redirect before the loader runs.',
  },
  {
    mode: 'auth-redirect',
    title: 'requireAuth with throwRedirect',
    code: "requireAuth(c, { throwRedirect: '/login' });",
    document: '302 to login.',
    navigation: 'Visits login without reloading the document.',
    note: 'Throws a redirect before the loader runs.',
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
  children,
}: {
  title: string;
  file: string;
  code: string;
  children: ReactNode;
}) {
  return (
    <section className="example">
      <h3>{title}</h3>
      <p>
        <SourceLink file={file} />
      </p>
      <pre>{code}</pre>
      <h4>Expected when signed out</h4>
      {children}
    </section>
  );
}

function ProfileRequest() {
  const [result, setResult] = useState('');
  async function request() {
    try {
      const response = await fetch('/api/profile');
      setResult(
        `HTTP ${response.status}\n${response.headers.get('Content-Type')}\n${await response.text()}`,
      );
    } catch (error) {
      setResult(String(error));
    }
  }
  return (
    <>
      <p>
        <a href="/api/profile">Document load</a> |{' '}
        <button onClick={request}>Fetch API response</button>
      </p>
      <pre role="status">{result}</pre>
    </>
  );
}

export default function Home() {
  return (
    <>
      <h1>Server Auth Errors Example</h1>
      <p>
        Compare server auth in loaders, middleware, API routes, and actions. Each card shows the
        signed-out outcome; sign in and repeat to see the authorized path.
      </p>
      <p>
        <strong>Related:</strong>{' '}
        <a href="https://github.com/voidzero-dev/void/issues/785">Issue #785</a> | PR #XXX
      </p>
      <hr />
      <section aria-labelledby="loaders">
        <h2 id="loaders">Loaders</h2>
        <div className="examples">
          {loaders.map(({ mode, title, code, document, navigation, note }) => (
            <Example key={mode} title={title} file={`pages/loaders/${mode}.server.ts`} code={code}>
              <p>
                <strong>Document load:</strong> {document}
              </p>
              <p>
                <strong>Client navigation:</strong> {navigation}
              </p>
              <p>{note}</p>
              <Visits path={`/loaders/${mode}`} />
            </Example>
          ))}
        </div>
      </section>
      <hr />
      <section aria-labelledby="middleware">
        <h2 id="middleware">Middleware</h2>
        <p>
          These guards run in application middleware before the loader. A successful check continues
          with await next().
        </p>
        <div className="examples">
          {guards.map(({ mode, title, code, document, navigation, note }) => (
            <Example
              key={mode}
              title={title}
              file="middleware/auth.ts"
              code={`${code}\nawait next();`}
            >
              <p>
                <strong>Document load:</strong> {document}
              </p>
              <p>
                <strong>Client navigation:</strong> {navigation}
              </p>
              <p>{note}</p>
              <Visits path={`/middleware/${mode}`} />
            </Example>
          ))}
        </div>
      </section>
      <hr />
      <section aria-labelledby="actions">
        <h2 id="actions">Actions</h2>
        <p>
          The form pages are public. Each offers a native form and an enhanced useForm submission to
          the same protected action. Redirects use 303 so the next request is a GET.
        </p>
        <div className="examples">
          {guards.map(({ mode, title, code }) => (
            <Example
              key={mode}
              title={title}
              file="pages/actions/[mode].server.ts"
              code={
                mode === 'require-auth'
                  ? 'requireAuth(c);\n// Authorized work…'
                  : mode === 'return-redirect'
                    ? "if (!getUser()) return c.redirect('/login', 303);\n// Authorized work…"
                    : mode === 'throw-redirect'
                      ? 'requirePageUser(c, 303);\n// Authorized work…'
                      : `${code}\n// Authorized work…`
              }
            >
              <p>
                <strong>Native form POST:</strong>{' '}
                {mode === 'require-auth'
                  ? '401 plain text, replacing the app.'
                  : '303 to login, followed by a document GET.'}
              </p>
              <p>
                <strong>Enhanced form POST:</strong>{' '}
                {mode === 'require-auth'
                  ? 'Displays 401 inline or throws to the client error boundary.'
                  : 'Visits login without reloading the document.'}
              </p>
              {mode !== 'require-auth' && <p>Signing in does not replay the rejected action.</p>}
              <h4>Expected when signed in</h4>
              <p>
                Both forms redirect to the success page with 303. No application data is written.
              </p>
              <Visits path={`/actions/${mode}`} />
            </Example>
          ))}
        </div>
      </section>
      <hr />
      <section aria-labelledby="api">
        <h2 id="api">API route</h2>
        <div className="examples">
          <Example
            title="requireAuth in an API handler"
            file="routes/api/profile.ts"
            code={'const user = requireAuth(c);\nreturn { name: user.name, email: user.email };'}
          >
            <p>
              <strong>Document load:</strong> 401 plain text, replacing the app.
            </p>
            <p>
              <strong>Fetch API response:</strong> 401 plain text, displayed below without
              navigating.
            </p>
            <p>A fetch caller must check the status before parsing JSON.</p>
            <h4>Expected when signed in</h4>
            <p>Both requests return 200 JSON with the user’s name and email.</p>
            <ProfileRequest />
          </Example>
        </div>
      </section>
    </>
  );
}
