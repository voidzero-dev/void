import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { getPackageDir } from './agents.ts';
import starterStyles from './starter-ui.css?raw';

export const SCAFFOLD_GITIGNORE_LINES = [
  'node_modules',
  'dist',
  '.void',
  '.wrangler',
  '.void-wrangler.jsonc',
  '.env',
  '.env.*',
  '!.env.example',
  '*.tsbuildinfo',
  '.DS_Store',
] as const;

export type ScaffoldFramework = 'react' | 'vue' | 'svelte' | 'solid';
export type ScaffoldStarterMode = 'sqlite' | 'postgresql' | 'mysql' | 'static';
export type ScaffoldToolchain = 'vite-plus' | 'vite';

export const SCAFFOLD_BASE_DEPENDENCIES = {
  hono: '^4.11.9',
} as const;

export const SCAFFOLD_BASE_DEV_DEPENDENCIES = {
  vite: '^8.0.10',
  typescript: '^7.0.2',
} as const;

export const SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES = {
  vite: 'npm:@voidzero-dev/vite-plus-core@^1.3.0',
  'vite-plus': '^1.3.0',
} as const;

export const SCAFFOLD_TOOLCHAIN_OPTIONS = [
  {
    value: 'vite-plus',
    label: 'Vite+',
    hint: 'Uses the Vite+ toolchain and vp commands.',
  },
  {
    value: 'vite',
    label: 'Vite',
    hint: 'Uses plain Vite commands without Vite+.',
  },
] as const;

const REACT_SCAFFOLD_COMPILER_DEV_DEPENDENCIES = {
  'oxc-transform-react': '^0.149.0',
} as const;

export const SCAFFOLD_FRAMEWORK_OPTIONS = [
  { value: 'react', label: 'React', hint: 'TSX Pages starter with the React adapter.' },
  { value: 'vue', label: 'Vue', hint: 'Vue SFC Pages starter with the Vue adapter.' },
  { value: 'svelte', label: 'Svelte', hint: 'Svelte 5 Pages starter with the Svelte adapter.' },
  {
    value: 'solid',
    label: 'Solid',
    hint: 'Fine-grained TSX Pages starter with the Solid adapter.',
  },
] as const;

type ScaffoldFrameworkConfig = {
  label: string;
  docsUrl: string;
  adapterPackage: string;
  adapterImport: string;
  adapterPlugin: string;
  pageExtension: string;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  tsconfigCompilerOptions: Record<string, string>;
};

export const SCAFFOLD_FRAMEWORKS: Record<ScaffoldFramework, ScaffoldFrameworkConfig> = {
  react: {
    label: 'React',
    docsUrl: 'https://react.dev/',
    adapterPackage: '@void/react',
    adapterImport: 'voidReact',
    adapterPlugin: '@void/react/plugin',
    pageExtension: 'tsx',
    dependencies: {
      react: '^19.2.4',
      'react-dom': '^19.2.4',
    },
    devDependencies: {
      ...REACT_SCAFFOLD_COMPILER_DEV_DEPENDENCIES,
      '@types/react': '^19.2.14',
      '@types/react-dom': '^19.2.3',
    },
    tsconfigCompilerOptions: {
      jsx: 'react-jsx',
    },
  },
  vue: {
    label: 'Vue',
    docsUrl: 'https://vuejs.org/',
    adapterPackage: '@void/vue',
    adapterImport: 'voidVue',
    adapterPlugin: '@void/vue/plugin',
    pageExtension: 'vue',
    dependencies: {
      vue: '^3.5.30',
    },
    devDependencies: {},
    tsconfigCompilerOptions: {
      jsx: 'preserve',
    },
  },
  svelte: {
    label: 'Svelte',
    docsUrl: 'https://svelte.dev/',
    adapterPackage: '@void/svelte',
    adapterImport: 'voidSvelte',
    adapterPlugin: '@void/svelte/plugin',
    pageExtension: 'svelte',
    dependencies: {
      svelte: '^5.53.9',
    },
    devDependencies: {},
    tsconfigCompilerOptions: {},
  },
  solid: {
    label: 'Solid',
    docsUrl: 'https://www.solidjs.com/',
    adapterPackage: '@void/solid',
    adapterImport: 'voidSolid',
    adapterPlugin: '@void/solid/plugin',
    pageExtension: 'tsx',
    dependencies: {
      'solid-js': '^1.9.11',
    },
    devDependencies: {},
    tsconfigCompilerOptions: {
      jsx: 'preserve',
      jsxImportSource: 'solid-js',
    },
  },
};

export type PagesStarterTemplate = {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  files: Record<string, string>;
};

export function detectScaffoldFrameworkFromDependencies(
  deps: Record<string, unknown>,
): ScaffoldFramework | undefined {
  for (const [framework, config] of Object.entries(SCAFFOLD_FRAMEWORKS) as Array<
    [ScaffoldFramework, ScaffoldFrameworkConfig]
  >) {
    if (config.adapterPackage in deps) {
      return framework;
    }
  }
  return undefined;
}

export function getScaffoldTsconfigCompilerOptions(
  framework?: ScaffoldFramework,
): Record<string, string> {
  return framework ? { ...SCAFFOLD_FRAMEWORKS[framework].tsconfigCompilerOptions } : {};
}

export function createPagesStarterTemplate(options: {
  framework: ScaffoldFramework;
  starterMode: ScaffoldStarterMode;
  toolchain?: ScaffoldToolchain;
  voidPackageSpec: string;
  adapterPackageSpec: string;
}): PagesStarterTemplate {
  const {
    framework,
    starterMode,
    toolchain = 'vite',
    voidPackageSpec,
    adapterPackageSpec,
  } = options;
  const config = SCAFFOLD_FRAMEWORKS[framework];
  const assets = join(getPackageDir(), 'templates', 'assets');
  const files: PagesStarterTemplate['files'] = {
    'vite.config.ts': getViteConfig(framework, config),
    [`pages/index.${config.pageExtension}`]: getIndexPage(framework, starterMode),
    'pages/style.css': starterStyles,
    'pages/vite-env.d.ts': '/// <reference types="vite/client" />\n',
    'public/stack.svg': readFileSync(join(assets, 'stack.svg'), 'utf8'),
    'public/void.svg': readFileSync(join(assets, 'void.svg'), 'utf8'),
    [`public/${framework}.svg`]: readFileSync(join(assets, `${framework}.svg`), 'utf8'),
    'public/icons.svg': readFileSync(join(assets, 'icons.svg'), 'utf8'),
  };

  if (starterMode !== 'static') {
    files['pages/index.server.ts'] = getIndexServer();
    files['routes/api/hello.ts'] = getHelloRoute(config.label, starterMode);
    files['db/schema.ts'] = getSchemaFile(starterMode);
    files['db/seed.ts'] = getSeedFile();
  }

  return {
    scripts: {
      dev: toolchain === 'vite-plus' ? 'vp dev' : 'vite',
      build: toolchain === 'vite-plus' ? 'vp build' : 'vite build',
      preview: toolchain === 'vite-plus' ? 'vp preview' : 'vite preview',
      // `.void/` is gitignored, so fresh clones and new scaffolds need the
      // generated types before the editor opens tsconfig.json.
      postinstall: 'void prepare',
    },
    dependencies: {
      ...SCAFFOLD_BASE_DEPENDENCIES,
      ...config.dependencies,
      ...(starterMode !== 'static' ? { zod: '^4.6.7' } : {}),
    },
    devDependencies: {
      void: voidPackageSpec,
      ...SCAFFOLD_BASE_DEV_DEPENDENCIES,
      ...(toolchain === 'vite-plus' ? SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES : {}),
      [config.adapterPackage]: adapterPackageSpec,
      ...config.devDependencies,
    },
    files,
  };
}

function getViteConfig(framework: ScaffoldFramework, config: ScaffoldFrameworkConfig): string {
  if (framework === 'react') {
    return `import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { ${config.adapterImport} } from "${config.adapterPlugin}";

export default defineConfig({
  plugins: [
    voidPlugin(),
    ${config.adapterImport}({ react: { compiler: true } }),
  ],
});
`;
  }

  return `import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { ${config.adapterImport} } from "${config.adapterPlugin}";

export default defineConfig({
  plugins: [voidPlugin(), ${config.adapterImport}()],
});
`;
}

function getIndexServer(): string {
  return `import { defineHandler, type InferProps } from "void";
import { db, desc } from "void/db";
import { messages } from "@schema";
import { createInsertSchema } from "void/drizzle-zod";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const rows = await db.select().from(messages).orderBy(desc(messages.id));
  return { messages: rows };
});
export const action = defineHandler.withValidator({
  body: createInsertSchema(messages, { text: schema => schema.trim().min(1).max(1000) }).pick({ text: true }),
})(async (_c, { body }) => {
  await db.insert(messages).values(body);
});
`;
}

function getHelloRoute(
  frameworkLabel: string,
  starterMode: Exclude<ScaffoldStarterMode, 'static'>,
): string {
  const databaseLabel =
    starterMode === 'postgresql' ? 'PostgreSQL' : starterMode === 'mysql' ? 'MySQL' : 'D1';
  return `import { defineHandler } from "void";

export const GET = defineHandler(() => {
  return {
    message: "Hello from Void",
    framework: "${frameworkLabel}",
    database: "${databaseLabel}",
  };
});
`;
}

function getSchemaFile(starterMode: Exclude<ScaffoldStarterMode, 'static'>): string {
  if (starterMode === 'postgresql') {
    return `import { pgTable, serial, text, timestamp } from "void/schema-pg";

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
`;
  }

  if (starterMode === 'mysql') {
    return `import { int, mysqlTable, text, timestamp } from "void/schema-mysql";

export const messages = mysqlTable("messages", {
  id: int("id").autoincrement().primaryKey(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
`;
  }

  return `import { sql } from "void/db";
import { integer, sqliteTable, text } from "void/schema-d1";

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull().default(sql\`(datetime('now'))\`),
});
`;
}

function getSeedFile(): string {
  return `import { defineSeed } from "void/seed";

const SAMPLE_MESSAGES = ["Hello from Void"];

export default defineSeed<typeof import("./schema")>(async ({ db, schema }) => {
  await db.insert(schema.messages).values(
    SAMPLE_MESSAGES.map((text) => ({
      text,
    })),
  );
});
`;
}

function getIndexPage(framework: ScaffoldFramework, starterMode: ScaffoldStarterMode): string {
  const { label, docsUrl } = SCAFFOLD_FRAMEWORKS[framework];
  const hasDatabase = starterMode !== 'static';
  const description =
    starterMode === 'static'
      ? `<p>This starter is running in Pages mode with no database or server code yet.</p>
<p>
  Add <code>pages/*.server.ts</code>, <code>routes/</code>, or <code>void/db</code> when
  you want to grow into full-stack features.
</p>`
      : `<p>
  This starter is running in Pages mode. The list below is loaded from your database in <code>pages/index.server.ts</code>.
</p>
<p>API example: <a href="/api/hello">/api/hello</a></p>`;
  const body = `<main class="starter">
  <section id="center" aria-labelledby="welcome-title">
    <div class="hero">
      <img class="base" src="/stack.svg" width="170" height="179" alt="" />
      <img class="framework" src="/${framework}.svg" alt="${label} logo" />
      <img class="void" src="/void.svg" alt="Void logo" />
    </div>
    <div class="starter-intro">
      <h1 id="welcome-title">Welcome to Void</h1>
      <div class="starter-description">
${indent(description, 8)}
      </div>
    </div>
  </section>${hasDatabase ? `\n  <div class="ticks" aria-hidden="true"></div>\n${indent(getMessagesDemo(framework), 2)}` : ''}
  <div class="ticks" aria-hidden="true"></div>
  <section id="next-steps" aria-label="Resources">
    <div id="docs">
      <svg class="icon" role="presentation" aria-hidden="true">
        <use href="/icons.svg#documentation-icon"></use>
      </svg>
      <h2>Documentation</h2>
      <p>Your questions, answered</p>
      <ul>
        <li>
          <a href="https://void.cloud/guide/quickstart" target="_blank" rel="noreferrer">
            Quickstart
          </a>
        </li>
        <li>
          <a href="${docsUrl}" target="_blank" rel="noreferrer">
            <img class="button-icon" src="/${framework}.svg" alt="" />
            Learn more
          </a>
        </li>
      </ul>
    </div>
    <div id="social">
      <svg class="icon" role="presentation" aria-hidden="true">
        <use href="/icons.svg#social-icon"></use>
      </svg>
      <h2>Connect with us</h2>
      <p>Join the Void community</p>
      <ul>
        <li>
          <a href="https://github.com/voidzero-dev/void" target="_blank" rel="noreferrer">
            <svg class="button-icon" role="presentation" aria-hidden="true">
              <use href="/icons.svg#github-icon"></use>
            </svg>
            GitHub
          </a>
        </li>
        <li>
          <a href="https://discord.gg/cC6TEVFKSx" target="_blank" rel="noreferrer">
            <svg class="button-icon" role="presentation" aria-hidden="true">
              <use href="/icons.svg#discord-icon"></use>
            </svg>
            Discord
          </a>
        </li>
        <li>
          <a href="https://x.com/deploytovoid" target="_blank" rel="noreferrer">
            <svg class="button-icon" role="presentation" aria-hidden="true">
              <use href="/icons.svg#x-icon"></use>
            </svg>
            X.com
          </a>
        </li>
        <li>
          <a href="https://bsky.app/profile/voidzero.dev" target="_blank" rel="noreferrer">
            <svg class="button-icon" role="presentation" aria-hidden="true">
              <use href="/icons.svg#bluesky-icon"></use>
            </svg>
            Bluesky
          </a>
        </li>
      </ul>
    </div>
  </section>
  <div class="ticks" aria-hidden="true"></div>
  <div id="spacer" aria-hidden="true"></div>
</main>`;

  switch (framework) {
    case 'react':
    case 'solid': {
      const jsx = framework === 'react' ? body.replaceAll('class=', 'className=') : body;
      const imports = hasDatabase
        ? `${framework === 'solid' ? 'import { For, Show } from "solid-js";\n' : ''}import { Form, useForm } from "${SCAFFOLD_FRAMEWORKS[framework].adapterPackage}";
import type { Props } from "./index.server";
`
        : '';
      const props = hasDatabase
        ? framework === 'react'
          ? '{ messages }: Props'
          : 'props: Props'
        : '';
      return `${imports}import "./style.css";

export default function HomePage(${props}) {
${hasDatabase ? '  const form = useForm("/", { text: "" });\n\n' : ''}  return (
${indent(jsx, 4)}
  );
}
`;
    }
    case 'vue':
      return `<script setup lang="ts">
${hasDatabase ? 'import { Form, useForm } from "@void/vue";\nimport type { Props } from "./index.server";\n' : ''}import "./style.css";
${hasDatabase ? '\ndefineProps<Props>();\nconst form = useForm("/", { text: "" });\n' : ''}</script>

<template>
${indent(body, 2)}
</template>
`;
    case 'svelte':
      return `<script lang="ts">
${hasDatabase ? '  import { Form, useForm } from "@void/svelte";\n  import type { Props } from "./index.server";\n' : ''}  import "./style.css";
${hasDatabase ? '\n  let { messages }: Props = $props();\n  const form = useForm("/", { text: "" });\n' : ''}</script>

${body}
`;
  }
}

function getMessagesDemo(framework: ScaffoldFramework): string {
  const empty = `<p class="empty-state">
  No messages yet. Run <code>void db seed</code> to load the sample row from <code>db/seed.ts</code>.
</p>`;
  const content = {
    react: `{messages.length === 0 ? (
${indent(empty, 2)}
) : (
  <ul class="messages">
    {messages.map((message) => (
      <li key={message.id}>
        <strong>{message.text}</strong>
        <small>{String(message.createdAt)}</small>
      </li>
    ))}
  </ul>
)}
<Form form={form} className="message-form">
  <label htmlFor="message-text">Message</label>
  <div class="message-fields">
    <input id="message-text" name="text" value={form.data.text} onChange={(event) => form.setData("text", event.target.value)} required maxLength={1000} />
    <button type="submit" disabled={form.pending}>Add message</button>
  </div>
</Form>`,
    vue: `<template v-if="messages.length === 0">
${indent(empty, 2)}
</template>
<ul v-else class="messages">
  <li v-for="message in messages" :key="message.id">
    <strong>{{ message.text }}</strong>
    <small>{{ String(message.createdAt) }}</small>
  </li>
</ul>
<Form :form="form" class="message-form">
  <label for="message-text">Message</label>
  <div class="message-fields">
    <input id="message-text" name="text" v-model="form.data.text" required maxlength="1000" />
    <button type="submit" :disabled="form.pending">Add message</button>
  </div>
</Form>`,
    svelte: `{#if messages.length === 0}
${indent(empty, 2)}
{:else}
  <ul class="messages">
    {#each messages as message (message.id)}
      <li>
        <strong>{message.text}</strong>
        <small>{String(message.createdAt)}</small>
      </li>
    {/each}
  </ul>
{/if}
<Form {form} class="message-form">
  <label for="message-text">Message</label>
  <div class="message-fields">
    <input id="message-text" name="text" bind:value={form.data.text} required maxlength={1000} />
    <button type="submit" disabled={form.pending}>Add message</button>
  </div>
</Form>`,
    solid: `<Show when={props.messages.length > 0} fallback={
${indent(empty, 2)}
}>
  <ul class="messages">
    <For each={props.messages}>{(message) => (
      <li>
        <strong>{message.text}</strong>
        <small>{String(message.createdAt)}</small>
      </li>
    )}</For>
  </ul>
</Show>
<Form form={form} class="message-form">
  <label for="message-text">Message</label>
  <div class="message-fields">
    <input id="message-text" name="text" value={form.data.text} onInput={(event) => form.setData("text", event.currentTarget.value)} required maxLength={1000} />
    <button type="submit" disabled={form.pending}>Add message</button>
  </div>
</Form>`,
  }[framework];
  return `<section class="starter-demo" aria-labelledby="messages-title">
  <div class="demo-content">
    <h2 id="messages-title">Messages</h2>
${indent(content, 4)}
  </div>
</section>`;
}

function indent(source: string, spaces: number): string {
  return source
    .split('\n')
    .map((line) => ' '.repeat(spaces) + line)
    .join('\n');
}
