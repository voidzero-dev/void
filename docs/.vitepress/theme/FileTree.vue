<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { TreeRoot, TreeItem } from 'reka-ui';
import { useData } from 'vitepress';
import { computed, watch, ref } from 'vue';

export interface FileTreeItem {
  name: string;
  description?: string;
  link?: string;
  children?: Array<FileTreeItem>;
  collapsed?: boolean;
}

const props = defineProps<{
  items: Array<FileTreeItem> | ((ext: string) => Array<FileTreeItem>);
  defaultExpanded?: boolean;
  adapterTabs?: boolean;
}>();

function isFolder(item: FileTreeItem): boolean {
  return !!item.children || item.name.endsWith('/');
}

function getAllFolderNames(items: Array<FileTreeItem>): Array<string> {
  const names: Array<string> = [];
  for (const item of items) {
    if (isFolder(item)) {
      if (!item.collapsed) {
        names.push(item.name);
      }
      if (item.children) {
        names.push(...getAllFolderNames(item.children));
      }
    }
  }
  return names;
}

const resolvedItems = computed(() => {
  if (typeof props.items === 'function') {
    return props.items(extMap[selectedAdapter.value]);
  }
  return props.items;
});

const expanded = ref<Array<string>>(
  props.defaultExpanded ? getAllFolderNames(resolvedItems.value) : [],
);

watch(resolvedItems, (items) => {
  if (props.defaultExpanded) {
    expanded.value = getAllFolderNames(items);
  }
});

watch(selectedAdapter, (val) => {
  localStorage.setItem(ADAPTER_KEY, val);
});

const { isDark } = useData();
</script>

<template>
  <div :class="{ 'file-tree-wrapper': adapterTabs }">
    <div v-if="adapterTabs" class="adapter-tabs">
      <button
        v-for="adapter in adapters"
        :key="adapter"
        :class="{ active: selectedAdapter === adapter }"
        @click="selectedAdapter = adapter"
      >
        <Icon :icon="adapterIcons[adapter]" style="width: 13px; height: 13px; margin-right: 1px" />
        {{ adapter }}
      </button>
    </div>
    <div class="file-tree">
      <TreeRoot
        v-model:expanded="expanded"
        :items="resolvedItems"
        :get-key="(item: FileTreeItem) => item.name"
        :get-children="(item: FileTreeItem) => item.children"
      >
        <TreeNode :tree-items="resolvedItems" :level="0" :dark="isDark" />
      </TreeRoot>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, h, ref } from 'vue';

const adapters = ['React', 'Vue', 'Svelte', 'Solid'] as const;

const adapterIcons: Record<string, string> = {
  React: 'logos:react',
  Vue: 'logos:vue',
  Svelte: 'logos:svelte-icon',
  Solid: 'logos:solidjs-icon',
};

const extMap: Record<string, string> = {
  React: '.tsx',
  Vue: '.vue',
  Svelte: '.svelte',
  Solid: '.tsx',
};

const ADAPTER_KEY = 'vitepress:code-group-tab';
export const selectedAdapter = ref(
  typeof window !== 'undefined' ? localStorage.getItem(ADAPTER_KEY) || 'React' : 'React',
);

export function syncCodeGroups(title: string) {
  document.querySelectorAll('.vp-code-group').forEach((group) => {
    const label = group.querySelector(`.tabs label[data-title="${title}"]`);
    if (!label) {
      return;
    }
    const input = group.querySelector(
      `#${CSS.escape(label.getAttribute('for')!)}`,
    ) as HTMLInputElement | null;
    if (!input || input.checked) {
      return;
    }
    const i = Array.from(group.querySelectorAll('.tabs input')).indexOf(input);
    const blocks = group.querySelector('.blocks');
    if (!blocks || i < 0) {
      return;
    }
    input.checked = true;
    const current = blocks.querySelector('.active');
    if (current) {
      current.classList.remove('active');
    }
    blocks.children[i]?.classList.add('active');
  });
}

let codeGroupListenerInstalled = false;
export function installCodeGroupListener() {
  if (codeGroupListenerInstalled) {
    return;
  }
  codeGroupListenerInstalled = true;
  window.addEventListener('click', (e) => {
    const label = (e.target as Element)?.closest?.(
      '.vp-code-group .tabs label',
    ) as HTMLElement | null;
    if (!label) {
      return;
    }
    const title = label.getAttribute('data-title');
    if (title && (adapters as ReadonlyArray<string>).includes(title)) {
      selectedAdapter.value = title;
    }
  });
}

function isFolder(item: FileTreeItem): boolean {
  return !!item.children || item.name.endsWith('/');
}

const iconSize = { width: '16px', height: '16px', flexShrink: '0' };

function getFileIcon(name: string, dark: boolean): string {
  const light = dark ? '' : 'light-';
  if (name === 'vite.config.ts') {
    return `vscode-icons:file-type-${light}vite`;
  }
  if (name.endsWith('.d.ts')) {
    return 'vscode-icons:file-type-typescriptdef';
  }
  if (name.endsWith('.ts')) {
    return 'vscode-icons:file-type-typescript';
  }
  if (name.endsWith('.vue')) {
    return 'vscode-icons:file-type-vue';
  }
  if (name.endsWith('.tsx')) {
    return 'vscode-icons:file-type-reactts';
  }
  if (name.endsWith('.svelte')) {
    return 'vscode-icons:file-type-svelte';
  }
  if (name.endsWith('.sql')) {
    return 'vscode-icons:file-type-sql';
  }
  if (name.endsWith('.json')) {
    return `vscode-icons:file-type-${light}json`;
  }
  if (name === '.env') {
    return 'vscode-icons:file-type-dotenv';
  }
  if (name.endsWith('.ico')) {
    return 'vscode-icons:file-type-favicon';
  }
  return 'lucide:file';
}

const nodeStyle = (level: number, folder: boolean) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '7px 8px',
  paddingLeft: `${level * 20 + 6}px`,
  borderRadius: '4px',
  cursor: folder ? 'pointer' : 'default',
  whiteSpace: 'nowrap' as const,
});

const TreeNode = defineComponent({
  name: 'TreeNode',
  props: {
    treeItems: { type: Array as () => Array<FileTreeItem>, required: true },
    level: { type: Number, default: 0 },
    dark: { type: Boolean, default: false },
  },
  setup(props) {
    const nameStyle = {
      color: 'var(--vp-c-text-1)',
      fontSize: '14px',
    };

    const descStyle = {
      color: 'var(--vp-c-text-2)',
      fontSize: '12px',
      marginLeft: 'auto',
      paddingLeft: '16px',
    };

    const chevronStyle = {
      ...iconSize,
      color: 'var(--vp-c-text-3)',
      transition: 'transform 0.15s',
    };

    const spacerStyle = { width: '16px', flexShrink: '0' };

    return () =>
      props.treeItems.map((item) => {
        const folder = isFolder(item);
        return h('li', { key: item.name, style: { listStyle: 'none' } }, [
          h(
            TreeItem,
            {
              asChild: true,
              level: props.level,
              value: item,
            },
            {
              default: ({
                isExpanded,
                handleToggle,
              }: {
                isExpanded: boolean;
                handleToggle: () => void;
              }) => [
                h(
                  'div',
                  {
                    class: 'tree-node',
                    style: nodeStyle(props.level, folder),
                    onClick: folder ? handleToggle : undefined,
                  },
                  [
                    folder
                      ? h(Icon, {
                          icon: 'lucide:chevron-right',
                          style: {
                            ...chevronStyle,
                            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                          },
                        })
                      : h('span', { style: spacerStyle }),
                    folder
                      ? h(Icon, {
                          icon: isExpanded ? 'lucide:folder-open' : 'lucide:folder',
                          style: iconSize,
                        })
                      : h(Icon, {
                          icon: getFileIcon(item.name, props.dark),
                          style: iconSize,
                        }),
                    item.link
                      ? h(
                          'a',
                          {
                            href: item.link,
                            style: {
                              ...nameStyle,
                              textDecoration: 'none',
                            },
                          },
                          item.name,
                        )
                      : h('span', { style: nameStyle }, item.name),
                    item.description ? h('span', { style: descStyle }, item.description) : null,
                  ],
                ),
                isExpanded && item.children
                  ? h(
                      'ul',
                      {
                        style: {
                          listStyle: 'none',
                          padding: '0',
                          margin: '0',
                        },
                      },
                      [
                        h(TreeNode, {
                          treeItems: item.children,
                          level: props.level + 1,
                          dark: props.dark,
                        }),
                      ],
                    )
                  : null,
              ],
            },
          ),
        ]);
      });
  },
});
</script>

<style scoped>
.file-tree {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 16px 12px;
  font-size: 14px;
  line-height: 1;
  overflow-x: auto;
  background-color: color-mix(in srgb, var(--vp-c-bg-alt) 50%, var(--vp-c-bg));
}

.file-tree :deep(ul) {
  list-style: none;
  padding: 0;
  margin: 0;
}

.file-tree :deep(li) {
  line-height: normal;
  margin-top: 0;
}

.file-tree :deep(.tree-node:hover) {
  background-color: var(--vp-c-default-soft);
}

.file-tree :deep([data-selected] > .tree-node) {
  background-color: var(--vp-c-brand-soft);
}

.file-tree :deep(a:hover) {
  color: var(--vp-c-brand-1);
}

/* Adapter tabs */
.adapter-tabs {
  display: flex;
  gap: 0;
  overflow-x: auto;
  border: 1px solid var(--vp-c-divider);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  margin-bottom: 0;
  background-color: color-mix(in srgb, var(--vp-c-bg-alt) 50%, var(--vp-c-bg));
}

.adapter-tabs button {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.2s;
}

.adapter-tabs button:hover {
  color: var(--vp-c-text-1);
}

.adapter-tabs button.active {
  color: var(--vp-c-brand-1);
}

.adapter-tabs button.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 20px;
  right: 20px;
  height: 2px;
  background-color: var(--vp-c-brand-1);
}

.adapter-tabs + .file-tree {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
</style>
