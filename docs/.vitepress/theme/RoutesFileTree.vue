<script setup lang="ts">
import { useData } from 'vitepress';
import { computed } from 'vue';
import type { FileTreeItem } from './FileTree.vue';

const { lang } = useData();
const items = computed<Array<FileTreeItem>>(() => [
  {
    name: 'routes/',
    children: [
      {
        name: 'api/',
        children: [
          { name: 'hello.ts', description: '→ GET|POST /api/hello' },
          {
            name: 'users/',
            children: [
              { name: 'index.ts', description: '→ GET|POST /api/users' },
              {
                name: '[id].ts',
                description: '→ GET|PUT|DELETE /api/users/:id',
              },
            ],
          },
          {
            name: 'search/',
            children: [
              {
                name: '[...query].ts',
                description:
                  lang.value === 'zh-CN'
                    ? '→ GET /api/search/*（兜底匹配）'
                    : '→ GET /api/search/* (catch-all)',
              },
            ],
          },
        ],
      },
    ],
  },
]);
</script>

<template>
  <FileTree :items="items" default-expanded />
</template>
