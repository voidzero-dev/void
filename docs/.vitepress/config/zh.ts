import type { DefaultTheme } from 'vitepress';
import { en } from './en.ts';

function localizeSidebar(
  source: DefaultTheme.SidebarItem[],
  translations: DefaultTheme.SidebarItem[],
): DefaultTheme.SidebarItem[] {
  return source.map((item, index) => ({
    ...item,
    text: translations[index].text,
    ...(item.link ? { link: translations[index].link } : {}),
    ...(item.items
      ? { items: localizeSidebar(item.items, translations[index].items ?? []) }
      : {}),
  }));
}

const referenceItems = [
  {
    text: '通用',
    collapsed: false,
    items: [
      { text: '项目结构', link: '/zh/reference/structure' },
      { text: '资源推断', link: '/zh/reference/resource-inference' },
    ],
  },
  {
    text: '配置',
    link: '/zh/reference/config',
    collapsed: true,
    items: [
      { text: 'target', link: '/zh/reference/config#target' },
      { text: 'routing', link: '/zh/reference/config#routing' },
      { text: 'inference', link: '/zh/reference/config#inference' },
      { text: 'output', link: '/zh/reference/config#output' },
      { text: 'remote', link: '/zh/reference/config#remote' },
      { text: 'sandbox', link: '/zh/reference/config#sandbox' },
      { text: 'worker', link: '/zh/reference/config#worker' },
    ],
  },
  {
    text: 'CLI',
    link: '/zh/reference/cli',
    collapsed: true,
    items: [
      { text: '概览', link: '/zh/reference/cli' },
      { text: '项目设置', link: '/zh/reference/cli/setup' },
      { text: '连接与身份验证', link: '/zh/reference/cli/auth' },
      { text: '项目', link: '/zh/reference/cli/project' },
      { text: '部署', link: '/zh/reference/cli/deploy' },
      { text: '数据库', link: '/zh/reference/cli/database' },
      { text: '代码生成', link: '/zh/reference/cli/generate' },
      { text: '密钥与环境变量', link: '/zh/reference/cli/secrets' },
      { text: 'GitHub 与构建', link: '/zh/reference/cli/github' },
      { text: '自定义域名', link: '/zh/reference/cli/domains' },
      { text: '电子邮件', link: '/zh/reference/cli/email' },
      { text: '平台管理', link: '/zh/reference/cli/platform' },
      { text: '平台安装', link: '/zh/reference/cli/platform-installation' },
      { text: '平台配置', link: '/zh/reference/cli/platform-config' },
      { text: '平台用户与项目', link: '/zh/reference/cli/platform-users' },
      { text: '项目零信任访问', link: '/zh/reference/cli/platform-zero-trust' },
      { text: '平台运维', link: '/zh/reference/cli/platform-operations' },
      { text: '平台邮件', link: '/zh/reference/cli/platform-email' },
    ],
  },
  {
    text: 'API',
    link: '/zh/reference/api',
    collapsed: true,
    items: [
      { text: '概览', link: '/zh/reference/api' },
      { text: '插件与配置', link: '/zh/reference/api/plugin' },
      { text: '处理函数与中间件', link: '/zh/reference/api/handlers' },
      { text: '重写', link: '/zh/reference/api/rewrites' },
      { text: '身份验证', link: '/zh/reference/api/auth' },
      { text: 'Fetch 客户端', link: '/zh/reference/api/client' },
      { text: '持久化状态与 WebSockets', link: '/zh/reference/api/durable' },
      { text: '部署产物', link: '/zh/reference/api/deploy' },
      { text: '数据库与初始数据', link: '/zh/reference/api/database' },
      { text: '资源客户端', link: '/zh/reference/api/resources' },
      { text: '类型', link: '/zh/reference/api/types' },
      { text: '环境变量', link: '/zh/reference/api/env' },
      { text: 'Pages 适配器', link: '/zh/reference/api/pages' },
    ],
  },
];

const integrationItems = [
  {
    text: '元框架',
    collapsed: false,
    items: [
      { text: '概览', link: '/zh/integrations/frameworks/overview' },
      { text: 'TanStack Start', link: '/zh/integrations/frameworks/tanstack-start' },
      { text: 'React Router', link: '/zh/integrations/frameworks/react-router' },
      { text: 'Astro', link: '/zh/integrations/frameworks/astro' },
      { text: 'SvelteKit', link: '/zh/integrations/frameworks/sveltekit' },
      { text: 'Nuxt', link: '/zh/integrations/frameworks/nuxt' },
      { text: 'Analog', link: '/zh/integrations/frameworks/analog' },
    ],
  },
  { text: '编程 Agent', link: '/zh/integrations/agents' },
  { text: 'Hono', link: '/zh/integrations/hono' },
  { text: 'Cloudflare', link: '/zh/integrations/cloudflare' },
  { text: 'Node.js / Bun / Deno', link: '/zh/integrations/nodejs-bun-deno' },
];

const platformSidebar = localizeSidebar(en.themeConfig.sidebar['/guide/platform/'], [
  {
    text: '安装',
    collapsed: false,
    items: [
      { text: '概览', link: '/zh/guide/self-hosted-platform' },
      { text: '准备工作', link: '/zh/guide/platform/installation/prerequisites' },
      { text: '凭据', link: '/zh/guide/platform/installation/credentials' },
      { text: '安装平台并配置登录', link: '/zh/guide/platform/installation/setup' },
      { text: '首次部署', link: '/zh/guide/platform/installation/first-deployment' },
      { text: '域名与资源', link: '/zh/guide/platform/installation/domains' },
      { text: '维护与恢复', link: '/zh/guide/platform/installation/maintenance' },
      { text: '通过 CI 安装', link: '/zh/guide/platform/installation/ci' },
      { text: '停用与卸载', link: '/zh/guide/platform/installation/uninstall' },
    ],
  },
  {
    text: '平台管理',
    collapsed: false,
    items: [
      { text: '概览', link: '/zh/guide/platform-administration' },
      { text: '登录与访问权限', link: '/zh/guide/platform/administration/access' },
      { text: '已连接应用', link: '/zh/guide/platform/administration/connected-apps' },
      { text: '用户与项目', link: '/zh/guide/platform/administration/projects' },
      { text: '套餐与限额', link: '/zh/guide/platform/administration/plans' },
      { text: '项目零信任访问', link: '/zh/guide/platform/administration/zero-trust' },
      { text: '电子邮件', link: '/zh/guide/platform/administration/email' },
      { text: '运维', link: '/zh/guide/platform/administration/operations' },
    ],
  },
  {
    text: '开发与定制',
    collapsed: false,
    items: [
      { text: '概览', link: '/zh/guide/platform-development' },
      { text: '本地开发', link: '/zh/guide/platform/development/local' },
      { text: '运行时与源码构建', link: '/zh/guide/platform/development/runtime' },
      { text: 'Schema 与 CI', link: '/zh/guide/platform/development/schema-ci' },
    ],
  },
]);

export const zh = {
  label: '简体中文',
  lang: 'zh-CN',
  description: '用 Vite 构建，用 Void 部署。',
  themeConfig: {
    nav: [
      {
        text: '指南',
        link: '/zh/guide/',
        activeMatch: '^/zh/guide/(?!platform/|self-hosted-platform|platform-administration|platform-development)',
      },
      {
        text: '平台',
        link: '/zh/guide/self-hosted-platform',
        activeMatch: '^/zh/guide/(platform/|self-hosted-platform|platform-administration|platform-development)',
      },
      {
        text: '参考',
        activeMatch: '^/zh/reference/',
        items: referenceItems,
      },
      {
        text: '集成',
        activeMatch: '^/zh/integrations/',
        items: integrationItems,
      },
    ],
    sidebar: {
      '/zh/guide/platform/': platformSidebar,
      '/zh/guide/self-hosted-platform': platformSidebar,
      '/zh/guide/platform-administration': platformSidebar,
      '/zh/guide/platform-development': platformSidebar,
      '/zh/integrations/': localizeSidebar(en.themeConfig.sidebar['/integrations/'], integrationItems),
      '/zh/reference/': localizeSidebar(en.themeConfig.sidebar['/reference/'], referenceItems),
      '/zh/guide/': localizeSidebar(en.themeConfig.sidebar['/guide/'], [
        {
          text: '开始使用',
          items: [
            { text: '什么是 Void？', link: '/zh/guide/' },
            { text: '快速开始', link: '/zh/guide/quickstart' },
            { text: '支持的应用类型', link: '/zh/guide/app-types' },
          ],
        },
        {
          text: '路由与渲染',
          items: [
            { text: '服务端路由', link: '/zh/guide/server-routing' },
            {
              text: '页面路由',
              collapsed: true,
              items: [
                { text: '概览', link: '/zh/guide/pages-routing/overview' },
                { text: '布局与共享数据', link: '/zh/guide/pages-routing/layouts' },
                { text: 'Loader 与 props', link: '/zh/guide/pages-routing/loaders' },
                { text: 'Action 与表单', link: '/zh/guide/pages-routing/actions-and-forms' },
                { text: '视图过渡', link: '/zh/guide/pages-routing/view-transitions' },
                { text: 'Head 管理', link: '/zh/guide/pages-routing/head' },
                { text: 'Islands', link: '/zh/guide/pages-routing/islands' },
                { text: 'Markdown', link: '/zh/guide/pages-routing/markdown' },
              ],
            },
            {
              text: '边缘路由',
              collapsed: true,
              items: [
                { text: '静态资源缓存', link: '/zh/guide/edge/static-assets' },
                { text: '缓存重新验证（ISR）', link: '/zh/guide/edge/revalidation' },
                { text: '边缘预渲染', link: '/zh/guide/edge/prerendering' },
                { text: '自定义响应头', link: '/zh/guide/edge/headers' },
                { text: '重定向', link: '/zh/guide/edge/redirects' },
                { text: '重写', link: '/zh/guide/edge/rewrites' },
              ],
            },
            { text: '自定义 SSR', link: '/zh/guide/ssr' },
            { text: '静态站点生成（SSG）', link: '/zh/guide/ssg' },
          ],
        },
        {
          text: '数据访问',
          items: [
            { text: '类型安全', link: '/zh/guide/type-safety' },
            {
              text: '数据库',
              collapsed: true,
              items: [
                { text: '概览', link: '/zh/guide/database' },
                { text: 'D1 (SQLite)', link: '/zh/guide/database/d1' },
                { text: 'PostgreSQL', link: '/zh/guide/database/postgresql' },
                { text: 'MySQL', link: '/zh/guide/database/mysql' },
              ],
            },
            { text: '类型化 Fetch', link: '/zh/guide/typed-fetch' },
            { text: '键值存储', link: '/zh/guide/kv' },
            { text: '对象存储', link: '/zh/guide/storage' },
            { text: '持久化状态', link: '/zh/guide/durable-state' },
            { text: '环境变量', link: '/zh/guide/env-vars' },
          ],
        },
        {
          text: '后端功能',
          items: [
            { text: '身份验证', link: '/zh/guide/auth' },
            { text: 'AI', link: '/zh/guide/ai' },
            {
              text: '电子邮件',
              link: '/zh/guide/email',
              collapsed: true,
              items: [
                { text: '发送邮件', link: '/zh/guide/email/sending' },
                { text: '接收邮件', link: '/zh/guide/email/receiving' },
                { text: '域名与配置', link: '/zh/guide/email/domains' },
              ],
            },
            { text: '沙箱', link: '/zh/guide/sandboxes' },
            { text: '定时任务', link: '/zh/guide/jobs' },
            { text: '队列', link: '/zh/guide/queues' },
            { text: 'WebSockets', link: '/zh/guide/websockets' },
            { text: '服务端发送事件（SSE）', link: '/zh/guide/sse' },
            { text: '实时事件流', link: '/zh/guide/live' },
          ],
        },
        {
          text: '开发与部署',
          items: [
            { text: '远程开发', link: '/zh/guide/remote-dev' },
            { text: '部署应用', link: '/zh/guide/deployment' },
            { text: '项目协作', link: '/zh/guide/project-collaboration' },
          ],
        },
      ]),
    },
    outline: { label: '本页内容' },
    docFooter: { prev: '上一页', next: '下一页' },
    langMenuLabel: '选择语言',
    navMenuLabel: '主导航',
    sidebarMenuLabel: '目录',
    mobileMenuLabel: '菜单',
    extraMenuLabel: '更多选项',
    returnToTopLabel: '返回顶部',
    skipToContentLabel: '跳转到内容',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    footer: {
      nav: [
        {
          title: '文档',
          items: [
            { text: '指南', link: '/zh/guide/' },
            { text: '集成', link: '/zh/integrations/frameworks/overview' },
            { text: '参考', link: '/zh/reference/structure' },
          ],
        },
        {
          title: '开源项目',
          items: [
            { text: 'Vite+', link: 'https://viteplus.dev' },
            { text: 'Vite', link: 'https://vite.dev' },
            { text: 'Vitest', link: 'https://vitest.dev' },
            { text: 'Rolldown', link: 'https://rolldown.rs' },
            { text: 'Oxc', link: 'https://oxc.rs' },
          ],
        },
        {
          title: 'VoidZero',
          items: [
            { text: 'VoidZero', link: 'https://voidzero.dev' },
            { text: '博客', link: 'https://voidzero.dev/blog' },
          ],
        },
      ],
    },
  },
};
