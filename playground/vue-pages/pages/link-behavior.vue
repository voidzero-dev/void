<script setup lang="ts">
import { Link, useRouter } from '@void/vue';
import type { Props } from './link-behavior.server.ts';

defineProps<Props>();
const router = useRouter();

type LinkBehaviorWindow = Window & {
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
  __preventedNavigate?: boolean;
};

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

<template>
  <div>
    <h1>{{ title }}</h1>
    <p>
      <button
        data-testid="typed-visit"
        @click="
          router.visit({ pathname: '/users/:id', params: { id: '2' }, query: { tab: 'visit' } })
        "
      >
        Typed visit
      </button>
    </p>

    <p>
      <Link href="/users" data-testid="onclick-link" @click="setClicked">
        User handler then SPA
      </Link>
    </p>

    <p>
      <Link href="/users" data-testid="prevented-click-link" @click="preventClick">
        Prevented click
      </Link>
    </p>

    <p>
      <Link
        href="/users"
        data-testid="prevented-navigate-link"
        v-bind="{ onNavigate: preventNavigate }"
      >
        Prevented navigate
      </Link>
    </p>

    <p>
      <Link href="/users" data-testid="replace-link" replace>Replace with users</Link>
    </p>

    <p>
      <Link href="/users" data-testid="reload-link" reload-document>Reload document</Link>
    </p>

    <p>
      <Link href="/users" data-testid="blank-link" target="_blank"> Open users in a new tab </Link>
    </p>

    <p>
      <Link href="/users" data-testid="download-link" download="users.html"> Download users </Link>
    </p>

    <p>
      <Link
        href="/link-behavior"
        :data="{
          tag: ['a', 'b'],
          page: 2,
          active: true,
          skip: null,
          missing: undefined,
        }"
        data-testid="query-data-link"
      >
        Query data
      </Link>
    </p>
  </div>
</template>
