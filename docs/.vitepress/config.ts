import { fileURLToPath } from 'node:url';
import { extendConfig } from '@voidzero-dev/vitepress-theme/config';
import { defineConfig } from 'vitepress';
import { groupIconMdPlugin, groupIconVitePlugin } from 'vitepress-plugin-group-icons';
import { en } from './config/en.ts';
import { zh } from './config/zh.ts';

const themeHeaderPath = fileURLToPath(
  new URL('./components/oss/Header.vue', import.meta.resolve('@voidzero-dev/vitepress-theme')),
).replaceAll('\\', '/');

const socialLinks = [
  { icon: 'discord', link: 'https://discord.gg/cC6TEVFKSx' },
  { icon: 'x', link: 'https://x.com/voidzerodev' },
  { icon: 'bluesky', link: 'https://bsky.app/profile/voidzero.dev' },
  { icon: 'github', link: 'https://github.com/voidzero-dev' },
];

export default extendConfig(
  defineConfig({
    title: 'Void',
    rewrites: {
      'en/:rest*': ':rest*',
    },
    locales: {
      root: en,
      zh,
    },
    srcExclude: ['README.md'],
    cleanUrls: true,
    head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' }]],
    appearance: 'dark',

    // ./index.server imports in code blocks are false positives
    ignoreDeadLinks: [/\/index$/],

    markdown: {
      config(md) {
        md.use(groupIconMdPlugin);
      },
    },

    vite: {
      plugins: [
        groupIconVitePlugin(),
        {
          name: 'void:locale-logo-links',
          enforce: 'pre',
          // shortcut: localize hard-coded logo links until the shared theme supports locale homes.
          transform(source, id) {
            if (id !== themeHeaderPath) return;
            if (source.match(/href="\/"/g)?.length !== 2) {
              this.error('The shared theme header changed; review its localized logo links.');
            }
            return { code: source.replaceAll('href="/"', ':href="currentLang.link"'), map: null };
          },
        },
      ],
    },

    themeConfig: {
      i18nRouting: true,
      search: {
        provider: 'local',
        options: {
          locales: {
            zh: {
              translations: {
                button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
                modal: {
                  noResultsText: '未找到相关结果',
                  resetButtonTitle: '清除搜索',
                  backButtonTitle: '返回',
                  displayDetails: '显示详细内容',
                  footer: {
                    selectText: '选择',
                    selectKeyAriaLabel: '回车键',
                    navigateText: '切换',
                    navigateUpKeyAriaLabel: '向上方向键',
                    navigateDownKeyAriaLabel: '向下方向键',
                    closeText: '关闭',
                    closeKeyAriaLabel: 'Esc 键',
                  },
                },
              },
            },
          },
        },
      },

      socialLinks,
      footer: {
        copyright: `© ${new Date().getFullYear()} Cloudflare Inc. All Rights Reserved.`,
        social: socialLinks,
      },
    },
  }),
);
