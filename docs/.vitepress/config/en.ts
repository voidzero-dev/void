import type { IconOption } from '@voidzero-dev/vitepress-theme';

const referenceItems = [
  {
    text: 'General',
    collapsed: false,
    items: [
      { text: 'Project Structure', link: '/reference/structure' },
      { text: 'Resource Inference', link: '/reference/resource-inference' },
    ],
  },
  {
    text: 'Config',
    link: '/reference/config',
    collapsed: true,
    items: [
      { text: 'target', link: '/reference/config#target' },
      { text: 'routing', link: '/reference/config#routing' },
      { text: 'inference', link: '/reference/config#inference' },
      { text: 'output', link: '/reference/config#output' },
      { text: 'remote', link: '/reference/config#remote' },
      { text: 'sandbox', link: '/reference/config#sandbox' },
      { text: 'worker', link: '/reference/config#worker' },
    ],
  },
  {
    text: 'CLI',
    link: '/reference/cli',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/reference/cli' },
      { text: 'Project Setup', link: '/reference/cli/setup' },
      { text: 'Connections and Authentication', link: '/reference/cli/auth' },
      { text: 'Projects', link: '/reference/cli/project' },
      { text: 'Deployment', link: '/reference/cli/deploy' },
      { text: 'Database', link: '/reference/cli/database' },
      { text: 'Code Generation', link: '/reference/cli/generate' },
      { text: 'Secrets and Environment', link: '/reference/cli/secrets' },
      { text: 'GitHub and Builds', link: '/reference/cli/github' },
      { text: 'Custom Domains', link: '/reference/cli/domains' },
      { text: 'Email', link: '/reference/cli/email' },
      { text: 'Platform Management', link: '/reference/cli/platform' },
      { text: 'Platform Installation', link: '/reference/cli/platform-installation' },
      { text: 'Platform Configuration', link: '/reference/cli/platform-config' },
      { text: 'Platform Users and Projects', link: '/reference/cli/platform-users' },
      { text: 'Project Zero Trust', link: '/reference/cli/platform-zero-trust' },
      { text: 'Platform Operations', link: '/reference/cli/platform-operations' },
      { text: 'Platform Email', link: '/reference/cli/platform-email' },
    ],
  },
  {
    text: 'API',
    link: '/reference/api',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/reference/api' },
      { text: 'Plugin and Configuration', link: '/reference/api/plugin' },
      { text: 'Handlers and Middleware', link: '/reference/api/handlers' },
      { text: 'Rewrites', link: '/reference/api/rewrites' },
      { text: 'Authentication', link: '/reference/api/auth' },
      { text: 'Fetch Client', link: '/reference/api/client' },
      { text: 'Durable State and WebSockets', link: '/reference/api/durable' },
      { text: 'Deployment artifacts', link: '/reference/api/deploy' },
      { text: 'Database and Seeding', link: '/reference/api/database' },
      { text: 'Resource Clients', link: '/reference/api/resources' },
      { text: 'Types', link: '/reference/api/types' },
      { text: 'Environment Variables', link: '/reference/api/env' },
      { text: 'Pages Adapters', link: '/reference/api/pages' },
    ],
  },
];

const referenceLinks = {
  text: 'Reference',
  activeMatch: '/reference/',
  items: referenceItems,
};

const integrationItems = [
  {
    text: 'Meta Frameworks',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/integrations/frameworks/overview' },
      { text: 'TanStack Start', link: '/integrations/frameworks/tanstack-start' },
      { text: 'React Router', link: '/integrations/frameworks/react-router' },
      { text: 'Astro', link: '/integrations/frameworks/astro' },
      { text: 'SvelteKit', link: '/integrations/frameworks/sveltekit' },
      { text: 'Nuxt', link: '/integrations/frameworks/nuxt' },
      { text: 'Analog', link: '/integrations/frameworks/analog' },
    ],
  },
  { text: 'Coding Agents', link: '/integrations/agents' },
  { text: 'Hono', link: '/integrations/hono' },
  { text: 'Cloudflare', link: '/integrations/cloudflare' },
  { text: 'Node.js / Bun / Deno', link: '/integrations/nodejs-bun-deno' },
];

const integrationLinks = {
  text: 'Integrations',
  activeMatch: '/integrations/',
  items: integrationItems,
};

const platformSidebar = [
  {
    text: 'Installation',
    icon: 'lucide:cloud',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/guide/self-hosted-platform' },
      { text: 'Prerequisites', link: '/guide/platform/installation/prerequisites' },
      { text: 'Credentials', link: '/guide/platform/installation/credentials' },
      { text: 'Install and Configure Login', link: '/guide/platform/installation/setup' },
      { text: 'First Deployment', link: '/guide/platform/installation/first-deployment' },
      { text: 'Domains and Resources', link: '/guide/platform/installation/domains' },
      { text: 'Maintenance and Recovery', link: '/guide/platform/installation/maintenance' },
      { text: 'Install from CI', link: '/guide/platform/installation/ci' },
      { text: 'Disable and Uninstall', link: '/guide/platform/installation/uninstall' },
    ],
  },
  {
    text: 'Administration',
    icon: 'lucide:settings',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/guide/platform-administration' },
      { text: 'Sign-in and Access', link: '/guide/platform/administration/access' },
      { text: 'Connected apps', link: '/guide/platform/administration/connected-apps' },
      { text: 'Users and Projects', link: '/guide/platform/administration/projects' },
      { text: 'Plans and Limits', link: '/guide/platform/administration/plans' },
      { text: 'Project Zero Trust', link: '/guide/platform/administration/zero-trust' },
      { text: 'Email', link: '/guide/platform/administration/email' },
      { text: 'Operations', link: '/guide/platform/administration/operations' },
    ],
  },
  {
    text: 'Development & Customization',
    icon: 'lucide:code',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/guide/platform-development' },
      { text: 'Local Development', link: '/guide/platform/development/local' },
      { text: 'Runtime and Source Builds', link: '/guide/platform/development/runtime' },
      { text: 'Schema and CI', link: '/guide/platform/development/schema-ci' },
    ],
  },
];

const companyLinks = {
  text: 'VoidZero',
  items: [
    { text: 'VoidZero', link: 'https://voidzero.dev' },
    { text: 'Blog', link: 'https://voidzero.dev/blog' },
  ],
};

export const en = {
  label: 'English',
  lang: 'en-US',
  description: 'Build with Vite. Deploy with Void.',
  themeConfig: {
    nav: [
      {
        text: 'Guide',
        link: '/guide/',
        activeMatch:
          '^/guide/(?!platform/|self-hosted-platform|platform-administration|platform-development)',
      },
      {
        text: 'Platform',
        link: '/guide/self-hosted-platform',
        activeMatch:
          '^/guide/(platform/|self-hosted-platform|platform-administration|platform-development)',
      },
      referenceLinks,
      integrationLinks,
    ],

    sidebar: {
      '/guide/platform/': platformSidebar,
      '/guide/self-hosted-platform': platformSidebar,
      '/guide/platform-administration': platformSidebar,
      '/guide/platform-development': platformSidebar,
      '/guide/': [
        {
          text: 'Getting Started',
          icon: 'lucide:rocket',
          collapsed: false,
          items: [
            { text: 'Introduction', link: '/guide/' },
            { text: 'Quickstart', link: '/guide/quickstart' },
            { text: 'Supported App Types', link: '/guide/app-types' },
          ],
        },
        {
          text: 'Routing & Rendering',
          icon: 'lucide:route',
          collapsed: false,
          items: [
            { text: 'Server Routing', link: '/guide/server-routing' },
            {
              text: 'Pages Routing',
              collapsed: true,
              items: [
                { text: 'Overview', link: '/guide/pages-routing/overview' },
                { text: 'Layouts & Shared Data', link: '/guide/pages-routing/layouts' },
                { text: 'Loaders & Props', link: '/guide/pages-routing/loaders' },
                { text: 'Actions & Forms', link: '/guide/pages-routing/actions-and-forms' },
                { text: 'View Transitions', link: '/guide/pages-routing/view-transitions' },
                { text: 'Head Management', link: '/guide/pages-routing/head' },
                { text: 'Islands', link: '/guide/pages-routing/islands' },
                { text: 'Markdown', link: '/guide/pages-routing/markdown' },
              ],
            },
            {
              text: 'Edge Routing',
              collapsed: true,
              items: [
                { text: 'Static Assets Caching', link: '/guide/edge/static-assets' },
                { text: 'Revalidation (ISR)', link: '/guide/edge/revalidation' },
                { text: 'Edge Prerendering', link: '/guide/edge/prerendering' },
                { text: 'Custom Headers', link: '/guide/edge/headers' },
                { text: 'Redirects', link: '/guide/edge/redirects' },
                { text: 'Rewrites', link: '/guide/edge/rewrites' },
              ],
            },
            { text: 'Custom SSR', link: '/guide/ssr' },
            { text: 'SSG', link: '/guide/ssg' },
          ],
        },
        {
          text: 'Data',
          icon: 'lucide:database',
          collapsed: false,
          items: [
            { text: 'Type Safety', link: '/guide/type-safety' },
            {
              text: 'Database',
              collapsed: true,
              items: [
                { text: 'Overview', link: '/guide/database' },
                { text: 'D1 (SQLite)', link: '/guide/database/d1' },
                { text: 'PostgreSQL', link: '/guide/database/postgresql' },
                { text: 'MySQL', link: '/guide/database/mysql' },
              ],
            },
            { text: 'Typed Fetch', link: '/guide/typed-fetch' },
            { text: 'Key-Value Storage', link: '/guide/kv' },
            { text: 'Object Storage', link: '/guide/storage' },
            { text: 'Durable State', link: '/guide/durable-state' },
            { text: 'Environment Variables', link: '/guide/env-vars' },
          ],
        },
        {
          text: 'Backend Features',
          icon: 'lucide:blocks',
          collapsed: false,
          items: [
            { text: 'Authentication', link: '/guide/auth' },
            { text: 'AI', link: '/guide/ai' },
            {
              text: 'Email',
              link: '/guide/email',
              collapsed: true,
              items: [
                { text: 'Sending Email', link: '/guide/email/sending' },
                { text: 'Receiving Email', link: '/guide/email/receiving' },
                { text: 'Domains and Setup', link: '/guide/email/domains' },
              ],
            },
            { text: 'Sandboxes', link: '/guide/sandboxes' },
            { text: 'Cron Jobs', link: '/guide/jobs' },
            { text: 'Queues', link: '/guide/queues' },
            { text: 'WebSockets', link: '/guide/websockets' },
            { text: 'Server-Sent Events', link: '/guide/sse' },
            { text: 'Live Event Streams', link: '/guide/live' },
          ],
        },
        {
          text: 'Development & Deployment',
          icon: 'lucide:rocket',
          collapsed: false,
          items: [
            { text: 'Remote Development', link: '/guide/remote-dev' },
            { text: 'Deploying Your App', link: '/guide/deployment' },
            { text: 'Project Collaboration', link: '/guide/project-collaboration' },
          ],
        },
      ],
      '/integrations/': (() => {
        const frameworkIcons: Record<string, IconOption> = {
          'TanStack Start': 'simple-icons:tanstack',
          'React Router': {
            light: 'logos:react-router',
            dark: 'vscode-icons:file-type-reactrouter',
          },
          Astro: { light: 'logos:astro-icon', dark: 'simple-icons:astro' },
          SvelteKit: 'logos:svelte-icon',
          Nuxt: 'logos:nuxt-icon',
          Analog: 'logos:analog',
        };
        const itemIcons: Record<string, IconOption> = {
          'Coding Agents': 'lucide:bot',
          Hono: 'logos:hono',
          Cloudflare: 'devicon:cloudflare',
          'Node.js / Bun / Deno': 'material-icon-theme:nodejs-alt',
        };
        return integrationItems.map((item) =>
          item.text === 'Meta Frameworks'
            ? {
                ...item,
                icon: 'lucide:blocks',
                items: item.items?.map((child) => ({
                  ...child,
                  icon: frameworkIcons[child.text],
                })),
              }
            : { ...item, icon: itemIcons[item.text] },
        );
      })(),
      '/reference/': (() => {
        const icons: Record<string, string> = {
          General: 'lucide:book-open',
          'Project Structure': 'lucide:folder-tree',
          'Resource Inference': 'lucide:scan-search',
          Config: 'lucide:settings',
          API: 'lucide:code',
          CLI: 'lucide:terminal',
        };
        return referenceItems.map((item) => ({
          ...item,
          icon: icons[item.text],
          items: item.items?.map((child) => ({
            ...child,
            icon: icons[child.text] ?? child.icon,
          })),
        }));
      })(),
    },

    footer: {
      nav: [
        {
          title: 'Docs',
          items: [
            { text: 'Guide', link: '/guide/' },
            { text: 'Integrations', link: '/integrations/frameworks/overview' },
            { text: 'Reference', link: '/reference/structure' },
          ],
        },
        {
          title: 'Open Source',
          items: [
            { text: 'Vite+', link: 'https://viteplus.dev' },
            { text: 'Vite', link: 'https://vite.dev' },
            { text: 'Vitest', link: 'https://vitest.dev' },
            { text: 'Rolldown', link: 'https://rolldown.rs' },
            { text: 'Oxc', link: 'https://oxc.rs' },
          ],
        },
        {
          title: companyLinks.text,
          items: companyLinks.items,
        },
      ],
    },
  },
};
