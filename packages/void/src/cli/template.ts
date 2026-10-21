export const SCAFFOLD_GITIGNORE_LINES = [
  'node_modules',
  'dist',
  '.void',
  '.wrangler',
  '.void-wrangler.jsonc',
  '.cloudflare',
  'cloudflare.config.ts',
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
  const files: Record<string, string> = {
    'vite.config.ts': getViteConfig(framework, config),
    [`pages/index.${config.pageExtension}`]: getIndexPage(framework, starterMode),
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
  if (starterMode === 'static') {
    switch (framework) {
      case 'react':
        return `export default function HomePage() {
  return (
    <main>
      <h1>Welcome to Void</h1>
      <p>This starter is running in Pages mode with no database or server code yet.</p>
      <p>
        Add <code>pages/*.server.ts</code>, <code>routes/</code>, or <code>void/db</code> when
        you want to grow into full-stack features.
      </p>
    </main>
  );
}
`;
      case 'vue':
        return `<template>
  <main>
    <h1>Welcome to Void</h1>
    <p>This starter is running in Pages mode with no database or server code yet.</p>
    <p>
      Add <code>pages/*.server.ts</code>, <code>routes/</code>, or <code>void/db</code> when you
      want to grow into full-stack features.
    </p>
  </main>
</template>
`;
      case 'svelte':
        return `<main>
  <h1>Welcome to Void</h1>
  <p>This starter is running in Pages mode with no database or server code yet.</p>
  <p>
    Add <code>pages/*.server.ts</code>, <code>routes/</code>, or <code>void/db</code> when you
    want to grow into full-stack features.
  </p>
</main>
`;
      case 'solid':
        return `export default function HomePage() {
  return (
    <main>
      <h1>Welcome to Void</h1>
      <p>This starter is running in Pages mode with no database or server code yet.</p>
      <p>
        Add <code>pages/*.server.ts</code>, <code>routes/</code>, or <code>void/db</code> when
        you want to grow into full-stack features.
      </p>
    </main>
  );
}
`;
    }
  }

  switch (framework) {
    case 'react':
      return `import { Form, useForm } from "${SCAFFOLD_FRAMEWORKS[framework].adapterPackage}";
import type { Props } from "./index.server";

export default function HomePage({ messages }: Props) {
  const form = useForm("/", { text: "" });
  return (
    <main>
      <h1>Welcome to Void</h1>
      <p>
        This starter is running in Pages mode. The list below is loaded from your database in
        <code> pages/index.server.ts</code>.
      </p>
      <p>
        API example: <a href="/api/hello">/api/hello</a>
      </p>
      {messages.length === 0 ? (
        <p>
          No messages yet. Run <code>void db seed</code> to load the sample row from
          <code> db/seed.ts</code>.
        </p>
      ) : (
        <ul>
          {messages.map((message) => (
            <li key={message.id}>
              <strong>{message.text}</strong>
              <br />
              <small>{String(message.createdAt)}</small>
            </li>
          ))}
        </ul>
      )}
      <Form form={form}>
        <label>Message <input value={form.data.text} onChange={event => form.setData("text", event.target.value)} /></label>
        <button disabled={form.pending}>Add message</button>
      </Form>
    </main>
  );
}
`;
    case 'vue':
      return `<script setup lang="ts">
import type { Props } from "./index.server";
import { Form, useForm } from "@void/vue";

defineProps<Props>();
const form = useForm("/", { text: "" });
</script>

<template>
  <main>
    <h1>Welcome to Void</h1>
    <p>
      This starter is running in Pages mode. The list below is loaded from your database in
      <code>pages/index.server.ts</code>.
    </p>
    <p>
      API example: <a href="/api/hello">/api/hello</a>
    </p>
    <p v-if="messages.length === 0">
      No messages yet. Run <code>void db seed</code> to load the sample row from
      <code>db/seed.ts</code>.
    </p>
    <ul v-else>
      <li v-for="message in messages" :key="message.id">
        <strong>{{ message.text }}</strong>
        <br />
        <small>{{ String(message.createdAt) }}</small>
      </li>
    </ul>
    <Form :form="form">
      <label>Message <input v-model="form.data.text" /></label>
      <button :disabled="form.pending">Add message</button>
    </Form>
  </main>
</template>
`;
    case 'svelte':
      return `<script lang="ts">
  import type { Props } from "./index.server";
  import { Form, useForm } from "@void/svelte";
  const form = useForm("/", { text: "" });

  let { messages }: Props = $props();
</script>

<main>
  <h1>Welcome to Void</h1>
  <p>
    This starter is running in Pages mode. The list below is loaded from your database in
    <code>pages/index.server.ts</code>.
  </p>
  <p>
    API example: <a href="/api/hello">/api/hello</a>
  </p>
  {#if messages.length === 0}
    <p>
      No messages yet. Run <code>void db seed</code> to load the sample row from
      <code>db/seed.ts</code>.
    </p>
  {:else}
    <ul>
      {#each messages as message (message.id)}
        <li>
          <strong>{message.text}</strong>
          <br />
          <small>{String(message.createdAt)}</small>
        </li>
      {/each}
    </ul>
  {/if}
  <Form {form}>
    <label>Message <input bind:value={form.data.text} /></label>
    <button disabled={form.pending}>Add message</button>
  </Form>
</main>
`;
    case 'solid':
      return `import { Form, useForm } from "${SCAFFOLD_FRAMEWORKS[framework].adapterPackage}";
import type { Props } from "./index.server";

export default function HomePage(props: Props) {
  const form = useForm("/", { text: "" });
  return (
    <main>
      <h1>Welcome to Void</h1>
      <p>
        This starter is running in Pages mode. The list below is loaded from your database in
        <code> pages/index.server.ts</code>.
      </p>
      <p>
        API example: <a href="/api/hello">/api/hello</a>
      </p>
      {props.messages.length === 0 ? (
        <p>
          No messages yet. Run <code>void db seed</code> to load the sample row from
          <code> db/seed.ts</code>.
        </p>
      ) : (
        <ul>
          {props.messages.map((message) => (
            <li>
              <strong>{message.text}</strong>
              <br />
              <small>{String(message.createdAt)}</small>
            </li>
          ))}
        </ul>
      )}
      <Form form={form}>
        <label>Message <input value={form.data.text} onInput={event => form.setData("text", event.target.value)} /></label>
        <button disabled={form.pending}>Add message</button>
      </Form>
    </main>
  );
}
`;
  }
}
