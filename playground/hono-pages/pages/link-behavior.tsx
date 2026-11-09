import { Link, useRouter } from '@void/hono';
import type { Props } from './link-behavior.server.ts';

type LinkBehaviorWindow = Window & {
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
  __preventedNavigate?: boolean;
};

export default function LinkBehaviorPage(props: Props) {
  const router = useRouter();

  return (
    <div>
      <h1>{props.title}</h1>
      <p>
        <Link href={props.absoluteUrl} data-testid="absolute-current-link">
          Current page (absolute)
        </Link>
        <Link href={props.protocolRelativeUrl} data-testid="protocol-relative-current-link">
          Current page (protocol-relative)
        </Link>
        <Link href="http://localhost/link-behavior" data-testid="external-localhost-link">
          External localhost
        </Link>
      </p>
      <p>
        <button
          data-testid="typed-visit"
          onClick={() =>
            router.visit({ pathname: '/users/:id', params: { id: '2' }, query: { tab: 'visit' } })
          }
        >
          Typed visit
        </button>
      </p>

      <p>
        <Link href="?view=compact" data-testid="query-only-link">
          Query-only link
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="onclick-link"
          onClick={() => {
            (window as LinkBehaviorWindow).__linkOnClick = true;
          }}
        >
          User handler then SPA
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="prevented-click-link"
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            (window as LinkBehaviorWindow).__preventedClick = true;
          }}
        >
          Prevented click
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="prevented-navigate-link"
          onNavigate={(event) => {
            event.preventDefault();
            (window as LinkBehaviorWindow).__preventedNavigate = true;
          }}
        >
          Prevented navigate
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="replace-link" replace>
          Replace with users
        </Link>
      </p>

      <p>
        <Link href="/link-behavior" method="post" data-testid="post-link">
          Post to this page
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="reload-link" reloadDocument>
          Reload document
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="blank-link" target="_blank">
          Open users in a new tab
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="download-link" download="users.html">
          Download users
        </Link>
      </p>

      <p>
        <Link
          href="/link-behavior"
          data={{
            tag: ['a', 'b'],
            page: 2,
            active: true,
            skip: null,
            missing: undefined,
          }}
          data-testid="query-data-link"
        >
          Query data
        </Link>
      </p>
    </div>
  );
}
