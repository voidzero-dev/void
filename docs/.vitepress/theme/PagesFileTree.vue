<script setup lang="ts">
import { useData } from 'vitepress';
import type { FileTreeItem } from './FileTree.vue';

const { lang } = useData();

function buildItems(ext: string): Array<FileTreeItem> {
  const isChinese = lang.value === 'zh-CN';
  return [
    {
      name: 'pages/',
      children: [
        {
          name: `layout${ext}`,
          description: isChinese ? '根布局（包裹所有页面）' : 'Root layout (wraps all pages)',
        },
        { name: `index${ext}`, description: '→ /' },
        {
          name: 'index.server.ts',
          description: isChinese ? '/ 的服务端 loader 和 Action' : 'Server-side loader & action for /',
        },
        { name: `about${ext}`, description: '→ /about' },
        {
          name: 'users/',
          children: [
            {
              name: `layout${ext}`,
              description: isChinese ? '/users/* 的嵌套布局' : 'Nested layout for /users/*',
            },
            { name: `[id]${ext}`, description: '→ /users/:id' },
            {
              name: '[id].server.ts',
              description: isChinese
                ? '/users/:id 的服务端 loader 和 Action'
                : 'Server-side loader & action for /users/:id',
            },
          ],
        },
        {
          name: 'blog/',
          children: [
            {
              name: 'hello.md',
              description: isChinese ? '→ /blog/hello（Markdown 页面）' : '→ /blog/hello (Markdown page)',
            },
          ],
        },
      ],
    },
  ];
}
</script>

<template>
  <FileTree :items="buildItems" adapter-tabs default-expanded />
</template>
