import { Link } from '@void/react';
import { SourceLink } from '../src/source-link.tsx';

export default function Home() {
  return (
    <>
      <h1>D1 Bookmark Example</h1>
      <p>
        A write succeeds on the primary. A read in the next request can reach a replica that has not
        caught up yet. Compare the same write/read flow with and without a bookmark, using a browser
        redirect or an immediate server-side read through a separate session.
      </p>
      <p>
        <strong>Related:</strong>{' '}
        <a href="https://github.com/voidzero-dev/void/issues/783">Issue #783</a> | PR #XXX: TBD
      </p>
      <details>
        <summary>How to see the difference</summary>
        <ol>
          <li>Deploy to Cloudflare with D1 read replication enabled.</li>
          <li>
            Open the control and choose “Browser redirect (cookie)” or “Immediate server read”.
            Choose a count and “Run trials”.
          </li>
          <li>Look for a stale read: the observed revision differs from the acknowledged write.</li>
          <li>
            Repeat with the same timing and pressure in the manual-bookmark variant, which passes
            the write’s bookmark to the read session.
          </li>
        </ol>
        <p>
          Immediate mode removes the browser round trip between the write and read. Both variants
          create one independent read session per trial; only the fixed variant initializes it with
          the write bookmark. Each trial finishes before the next starts. Browser redirect mode
          demonstrates transport through an HttpOnly cookie instead.
        </p>
        <p>
          This demo does not fake replica lag. Local D1 usually reads fresh in both variants, and
          even a live replica may already be caught up. A fresh control read is not proof of
          consistency. Try from a region far from the primary. The demo disables ISR and response
          caching.
        </p>
        <p>
          Each browser has its own profile per variant. Run trials sequentially in one tab:
          concurrent saves and cookie responses can race. Bookmarks do not promise to include
          unrelated later writes from another client.
        </p>
        <p>
          <a href="https://developers.cloudflare.com/d1/best-practices/read-replication/#start-a-session-from-previous-context-bookmark">
            Cloudflare: resume a D1 session from a bookmark
          </a>
        </p>
      </details>
      <hr />
      <div className="variants">
        <section>
          <h2>Without bookmark</h2>
          <p>
            <SourceLink file="middleware/database.ts" />
          </p>
          <pre>{'// No bookmark transport.'}</pre>
          <p>
            Every request starts unconstrained. A successful save can be followed by a stale read.
          </p>
          <Link href="/without-bookmark">Playground</Link>
        </section>
        <section>
          <h2>Manual bookmark</h2>
          <p>
            <SourceLink file="middleware/database.ts" />
          </p>
          <pre>{`setSession(getCookie(c, 'd1-demo-bookmark') ?? 'first-unconstrained');
await next();
const bookmark = getBookmark();
if (bookmark) setCookie(c, 'd1-demo-bookmark', bookmark, options);`}</pre>
          <p>
            Middleware resumes the previous session using an HttpOnly cookie. The redirected read
            sees data at least as up-to-date as the acknowledged save.
          </p>
          <Link href="/with-bookmark">Playground</Link>
        </section>
      </div>
    </>
  );
}
