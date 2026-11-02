<script lang="ts">
  import { Link, useRouter } from "@void/svelte";
  import type { Props } from "./link-behavior.server.ts";

  type LinkBehaviorWindow = Window & {
    __linkOnClick?: boolean;
    __preventedClick?: boolean;
    __preventedNavigate?: boolean;
  };

  let { title }: Props = $props();
  const router = useRouter();

  function setClicked() {
    (window as LinkBehaviorWindow).__linkOnClick = true;
  }

  function preventClick(event: Event) {
    event.preventDefault();
    (window as LinkBehaviorWindow).__preventedClick = true;
  }

  function preventNavigate(event: { preventDefault(): void }) {
    event.preventDefault();
    (window as LinkBehaviorWindow).__preventedNavigate = true;
  }
</script>

<div>
  <h1>{title}</h1>
  <p>
    <button
      data-testid="typed-visit"
      onclick={() => router.visit({ pathname: "/users/:id", params: { id: "2" }, query: { tab: "visit" } })}
    >
      Typed visit
    </button>
  </p>

  <p>
    <Link href="/users" data-testid="onclick-link" onclick={setClicked}>
      User handler then SPA
    </Link>
  </p>

  <p>
    <Link href="/users" data-testid="prevented-click-link" onclick={preventClick}>
      Prevented click
    </Link>
  </p>

  <p>
    <Link href="/users" data-testid="prevented-navigate-link" onNavigate={preventNavigate}>
      Prevented navigate
    </Link>
  </p>

  <p>
    <Link href="/users" data-testid="replace-link" replace>Replace with users</Link>
  </p>

  <p>
    <Link href="/users" data-testid="reload-link" reloadDocument>Reload document</Link>
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
        tag: ["a", "b"],
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
