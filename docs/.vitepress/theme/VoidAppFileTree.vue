<script setup lang="ts">
import type { FileTreeItem } from './FileTree.vue';

const props = defineProps<{ annotations?: boolean }>();

function buildItems(ext: string): Array<FileTreeItem> {
  const d = props.annotations;
  return [
    {
      name: 'pages/',
      description: d ? 'Server-rendered pages' : undefined,
      children: [
        { name: `index${ext}` },
        {
          name: 'users/',
          children: [{ name: `[id]${ext}` }, { name: '[id].server.ts' }],
        },
      ],
    },
    {
      name: 'routes/',
      description: d ? 'API endpoints' : undefined,
      children: [
        {
          name: 'api/',
          children: [{ name: 'hello.ts' }],
        },
      ],
    },
    {
      name: 'db/',
      description: d ? 'Schema and migrations' : undefined,
      collapsed: true,
      children: [
        { name: 'schema.ts' },
        { name: 'migrations/', children: [{ name: '0001_create_users.sql' }] },
      ],
    },
    { name: 'middleware/', collapsed: true, children: [{ name: '01.auth.ts' }] },
    { name: 'crons/', collapsed: true, children: [{ name: 'daily-cleanup.ts' }] },
    { name: 'queues/', collapsed: true, children: [{ name: 'email-sender.ts' }] },
    { name: 'vite.config.ts' },
    { name: 'void.config.ts' },
  ];
}
</script>

<template>
  <FileTree :items="buildItems" adapter-tabs default-expanded />
</template>
