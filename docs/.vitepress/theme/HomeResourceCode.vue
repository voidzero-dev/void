<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import { useData } from 'vitepress';

const { frontmatter } = useData();

// These fixed examples share their source text with the rendered, selectable code.
const files = [
  {
    name: 'blog.server.ts',
    source: `import { defineHandler, type InferProps } from 'void';
import { db } from 'void/db';
import { posts } from '@schema';

export const loader = defineHandler(async () => ({
  posts: await db.select().from(posts),
}));

export type Props = InferProps<typeof loader>;`,
  },
  {
    name: 'blog.tsx',
    source: `import type { Props } from './blog.server';

export default function Blog({ posts }: Props) {
  return (
    <ul>
      {posts.map((post) => <li key={post.id}>{post.title}</li>)}
    </ul>
  );
}`,
  },
  {
    name: 'api/decide.ts',
    source: `import { defineHandler } from 'void';
import { ai } from 'void/ai';

export const POST = defineHandler(async (c) => {
  const { question } = await c.req.json();
  return ai
    .run('@cf/cloudflare/clef', {
      model: 'clef',
      state: {},
      questions: {
        decision: { type: 'noul', instructions: question },
      },
    })
    .match({
      ok: (result) => {
        const probability = result.answers.decision.noul;
        return c.json({
          answer: probability >= 0.5 ? 'yes' : 'no',
          probability,
        });
      },
      limited: (limit) => limit.response(),
    });
});`,
  },
].map((file) => ({ ...file, tokens: highlight(file.source) }));

// A small display-only palette for these two snippets keeps a code highlighter
// and its language grammars out of the homepage bundle.
function highlight(source: string) {
  const pattern =
    /(?<comment>\/\/[^\n]*)|(?<string>'[^'\n]*')|(?<keyword>\b(?:import|from|type|typeof|export|const|async|await|default|function|return)\b)|(?<type>\b(?:Props|InferProps)\b)|(?<function>\b(?:defineHandler|select|map|Blog|run|match|json)\b)/g;
  const tokens: Array<{ text: string; tone?: string }> = [];
  let position = 0;
  for (const match of source.matchAll(pattern)) {
    tokens.push({ text: source.slice(position, match.index) });
    tokens.push({
      text: match[0],
      tone: Object.keys(match.groups!).find((group) => match.groups![group] !== undefined),
    });
    position = match.index + match[0].length;
  }
  tokens.push({ text: source.slice(position) });
  return tokens;
}
</script>

<template>
  <div class="resource-code-stage">
    <TabsRoot default-value="blog.server.ts" class="resource-code-window">
      <TabsList
        :aria-label="frontmatter.homeI18n?.resource_files_label ?? 'Resource example files'"
        class="resource-code-tabs"
      >
        <TabsTrigger v-for="file in files" :key="file.name" :value="file.name">
          {{ file.name }}
        </TabsTrigger>
      </TabsList>
      <TabsContent
        v-for="file in files"
        :key="file.name"
        :value="file.name"
        class="resource-code-panel"
      >
        <pre class="resource-code"><code><span
          v-for="(token, index) in file.tokens"
          :key="index"
          :class="token.tone && `syntax-${token.tone}`"
        >{{ token.text }}</span></code></pre>
      </TabsContent>
    </TabsRoot>
  </div>
</template>

<style scoped>
.resource-code-stage {
  display: grid;
  place-items: center;
  width: 100%;
  min-width: 0;
  padding: 48px 32px;
}

.resource-code-window {
  width: 100%;
  min-width: 0;
  overflow: hidden;
  border: 1px solid #ffffff40;
  border-radius: 8px;
  background: #111111;
  box-shadow: 0 16px 48px #14003340;
  color: #e9e5f2;
  font-family: var(--font-mono);
}

.resource-code-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid #ffffff1a;
  background: #ffffff05;
}

.resource-code-tabs :deep([role='tab']) {
  padding: 8px 12px;
  border-radius: 4px;
  color: #aaa4b6;
  font-size: 12px;
  line-height: 18px;
}

.resource-code-tabs :deep([role='tab'][data-state='active']) {
  background: #ffffff0d;
  color: #ffffff;
}

.resource-code-tabs :deep([role='tab']:hover) {
  color: #ffffff;
}

.resource-code-tabs :deep([role='tab']:focus-visible),
.resource-code-panel:focus-visible {
  outline: 2px solid #8c9fff;
  outline-offset: -2px;
}

.resource-code-panel {
  height: 18rem;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: #51475f #111111;
}

.resource-code {
  margin: 0;
  padding: 28px 24px 36px;
  font-family: inherit;
  font-size: 13px;
  line-height: 26px;
  font-variant-ligatures: none;
  tab-size: 2;
  text-align: left;
}

.resource-code code {
  padding: 0;
  border-radius: 0;
  outline: none;
  background: none;
  color: inherit;
  font: inherit;
}

.syntax-keyword {
  color: #b39aff;
}

.syntax-comment {
  color: #777280;
}

.syntax-string {
  color: #a8c98b;
}

.syntax-type {
  color: #e8c480;
}

.syntax-function {
  color: #8c9fff;
}

@media (max-width: 1100px) {
  .resource-code-stage {
    padding: 40px 20px;
  }

  .resource-code {
    padding: 24px 18px 32px;
    font-size: 11px;
    line-height: 23px;
  }
}

@media (max-width: 380px) {
  .resource-code-stage {
    padding: 32px 16px;
  }

  .resource-code-tabs :deep([role='tab']) {
    padding: 8px;
    font-size: 11px;
  }
}
</style>
