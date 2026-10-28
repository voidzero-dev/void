<script setup lang="ts">
import { useData } from 'vitepress';
import type { FileTreeItem } from './FileTree.vue';

const props = defineProps<{ annotations?: boolean }>();
const { lang } = useData();

function buildItems(ext: string): Array<FileTreeItem> {
  const d = props.annotations;
  const isChinese = lang.value === 'zh-CN';
  return [
    {
      name: 'pages/',
      description: d ? (isChinese ? '服务端渲染页面' : 'Server-rendered pages') : undefined,
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
      description: d ? (isChinese ? 'API 端点' : 'API endpoints') : undefined,
      children: [
        {
          name: 'api/',
          children: [{ name: 'hello.ts' }],
        },
      ],
    },
    {
      name: 'db/',
      description: d ? (isChinese ? 'Schema 与迁移' : 'Schema and migrations') : undefined,
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
    { name: 'void.json' },
  ];
}
</script>

<template>
  <FileTree :items="buildItems" adapter-tabs default-expanded />
</template>
