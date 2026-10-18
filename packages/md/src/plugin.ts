import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'pathslash';
import { glob } from 'tinyglobby';
import { normalizePath, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import { resolvePagesDir } from 'void/pages';
import type { CompileOptions } from './compile.ts';
import { emitReactComponent } from './emit-react.ts';
import { emitSolidComponent } from './emit-solid.ts';
import { emitSvelteComponent } from './emit-svelte.ts';
import { emitVueComponent } from './emit-vue.ts';
import { extractScript } from './extract-script.ts';
import { extractMetadata } from './metadata.ts';

const MD_CLIENT_ENTRY_ID = 'virtual:void-md-client';

type FrameworkAdapter = 'vue' | 'react' | 'svelte' | 'solid';

const ADAPTER_PLUGIN_NAMES: Record<string, FrameworkAdapter> = {
  'void-vue:pages': 'vue',
  'void-react:pages': 'react',
  'void-svelte:pages': 'svelte',
  'void-solid:pages': 'solid',
};

const SVELTE_VIRTUAL_PREFIX = '/@void-md-svelte/';
const SOLID_VIRTUAL_PREFIX = '/@void-md-solid/';

export type MdPage = Readonly<{
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  headings: ReadonlyArray<{ depth: number; slug: string; text: string }>;
}>;

export type MarkdownOptions = Readonly<{
  shiki?: CompileOptions['shiki'];
}>;

function stripPageSuffix(file: string): string {
  return file
    .replace(/\.md$/, '')
    .replace(/\/index$/, '')
    .replace(/^index$/, '');
}

function hasMdFilesWithScript(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const fullPath = join(entry.parentPath, entry.name);
        const content = readFileSync(fullPath, 'utf-8');
        if (/^<script\b/m.test(content)) {
          return true;
        }
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function hasIslandFiles(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && /\.island\./.test(entry.name)) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function voidMarkdown(options?: MarkdownOptions): Array<Plugin> {
  let adapter: FrameworkAdapter | null = null;
  let mdPages: ReadonlyArray<MdPage> = [];
  let root = '';
  let pagesDir = '';
  const svelteModules = new Map<string, string>();
  const solidModules = new Map<string, string>();
  const clientScripts = new Map<string, string>();

  function createVirtualModuleId(
    prefix: string,
    importerId: string,
    source: string,
    extension: string,
  ): string {
    const encoded = Buffer.from(importerId).toString('base64url');
    const hash = createHash('sha1').update(source).digest('hex').slice(0, 8);
    return `${prefix}${encoded}.${hash}.${extension}`;
  }

  async function scanMdPages(): Promise<ReadonlyArray<MdPage>> {
    if (!existsSync(pagesDir)) {
      return [];
    }

    const mdFiles = await glob('**/*.md', { cwd: pagesDir });
    const pages = await Promise.all(
      mdFiles.map(async (file) => {
        const content = readFileSync(join(pagesDir, file), 'utf-8');
        const { body, clientCode } = extractScript(content);
        const result = extractMetadata(body);

        const routeName = stripPageSuffix(file);
        const componentId = routeName || 'index';

        if (clientCode) {
          clientScripts.set(componentId, clientCode);
        }

        return {
          path: '/' + routeName,
          title: result.title,
          frontmatter: result.frontmatter,
          headings: result.headings,
        };
      }),
    );
    return pages.sort((leftPage, rightPage) => leftPage.path.localeCompare(rightPage.path));
  }

  return [
    {
      name: 'void-md',
      enforce: 'pre',

      api: {
        clientEntryId: MD_CLIENT_ENTRY_ID,
        getClientScripts(): Map<string, string> {
          return clientScripts;
        },
      },

      config(config, env) {
        if (env.command === 'serve') {
          return;
        }
        const configRoot = config.root || process.cwd();
        const pagesDir = resolvePagesDir(configRoot);
        if (!existsSync(pagesDir)) {
          return;
        }
        if (hasMdFilesWithScript(pagesDir) && hasIslandFiles(pagesDir)) {
          return {
            environments: {
              client: {
                build: {
                  rollupOptions: {
                    input: { 'md-client': MD_CLIENT_ENTRY_ID },
                  },
                },
              },
            },
          };
        }
      },

      configResolved(config: ResolvedConfig) {
        root = config.root;
        pagesDir = resolvePagesDir(root);
        for (const plugin of config.plugins) {
          const match = ADAPTER_PLUGIN_NAMES[plugin.name];
          if (match) {
            adapter = match;
            break;
          }
        }
        if (!adapter) {
          throw new Error(
            'void-md: No framework adapter detected. Install @void/vue, @void/react, @void/svelte, or @void/solid.',
          );
        }
      },

      async buildStart() {
        svelteModules.clear();
        solidModules.clear();
        clientScripts.clear();
        mdPages = await scanMdPages();
      },

      configureServer(server: ViteDevServer) {
        const normalizedPagesDir = normalizePath(pagesDir);
        const isInPagesDir = (file: string) =>
          file === normalizedPagesDir || file.startsWith(normalizedPagesDir + '/');
        const handleMdChange = async (file: string) => {
          if (!file.endsWith('.md') || !isInPagesDir(normalizePath(file))) {
            return;
          }
          mdPages = await scanMdPages();
          const mod = server.moduleGraph.getModuleById('\0void-md-pages');
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
          }
          for (const [compId] of clientScripts) {
            const scriptMod = server.moduleGraph.getModuleById(
              '\0virtual:void-md-script:' + compId,
            );
            if (scriptMod) {
              server.moduleGraph.invalidateModule(scriptMod);
            }
          }
          const clientMod = server.moduleGraph.getModuleById('\0' + MD_CLIENT_ENTRY_ID);
          if (clientMod) {
            server.moduleGraph.invalidateModule(clientMod);
          }
        };
        server.watcher.on('change', handleMdChange);
        server.watcher.on('add', handleMdChange);
        server.watcher.on('unlink', handleMdChange);
      },

      resolveId: {
        filter: {
          id: /^(@void\/md(\/pages)?|\/@void-md-(svelte|solid)\/|virtual:void-md-(script:|client))/,
        },
        handler(source: string) {
          if (source === MD_CLIENT_ENTRY_ID) {
            return '\0' + MD_CLIENT_ENTRY_ID;
          }
          if (source.startsWith('virtual:void-md-script:')) {
            return '\0' + source;
          }
          if (source === '@void/md') {
            return '\0void-md-runtime';
          }
          if (source === '@void/md/pages') {
            return '\0void-md-pages';
          }
          if (source.startsWith(SVELTE_VIRTUAL_PREFIX) || source.startsWith(SOLID_VIRTUAL_PREFIX)) {
            return source;
          }
        },
      },

      load: {
        filter: {
          // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
          id: /^(\0void-md|\/@void-md-(svelte|solid)\/|\0virtual:void-md-(script:|client))/,
        },
        handler(id: string) {
          if (id === '\0' + MD_CLIENT_ENTRY_ID) {
            return generateMdClientEntry(clientScripts);
          }
          if (id.startsWith('\0virtual:void-md-script:')) {
            const componentId = id.slice('\0virtual:void-md-script:'.length);
            const code = clientScripts.get(componentId);
            if (code) {
              return code;
            }
            throw new Error(`void-md: Missing client script for '${componentId}'.`);
          }

          if (id.startsWith(SVELTE_VIRTUAL_PREFIX)) {
            const source = svelteModules.get(id);
            if (source) {
              return source;
            }
            throw new Error(`void-md: Missing Svelte markdown module '${id}'.`);
          }
          if (id.startsWith(SOLID_VIRTUAL_PREFIX)) {
            const source = solidModules.get(id);
            if (source) {
              return source;
            }
            throw new Error(`void-md: Missing Solid markdown module '${id}'.`);
          }

          if (id === '\0void-md-runtime') {
            if (adapter === 'vue') {
              return `
import { inject } from "vue";
export function useFrontmatter() { return inject("__void_frontmatter", {}); }
`;
            }
            // React and Solid match contexts by identity. The adapter owns the
            // context so its island renderer can provide it above the layouts.
            if (adapter === 'react') {
              return `
import { useContext } from "react";
import { FrontmatterContext } from "@void/react";
export { FrontmatterContext };
export function useFrontmatter() { return useContext(FrontmatterContext) ?? {}; }
`;
            }
            if (adapter === 'svelte') {
              return `
import { getContext, setContext } from "svelte";
const FRONTMATTER_KEY = "__void_frontmatter";
export function setFrontmatter(frontmatter) { setContext(FRONTMATTER_KEY, frontmatter); }
export function useFrontmatter() { return getContext(FRONTMATTER_KEY) ?? {}; }
`;
            }
            if (adapter === 'solid') {
              return `
import { useContext } from "solid-js";
import { FrontmatterContext } from "@void/solid";
export { FrontmatterContext };
export function useFrontmatter() { return useContext(FrontmatterContext) ?? {}; }
`;
            }
            throw new Error('void-md: Adapter is not initialized.');
          }
          if (id === '\0void-md-pages') {
            return `export default ${JSON.stringify(mdPages)};`;
          }
        },
      },

      transform: {
        filter: { id: /\.md$/ },
        async handler(code: string, _id: string) {
          const { body, islandImports, clientCode } = extractScript(code);

          const pagesPrefix = pagesDir + '/';
          if (_id.startsWith(pagesPrefix) && clientCode) {
            const componentId = stripPageSuffix(_id.slice(pagesPrefix.length)) || 'index';
            clientScripts.set(componentId, clientCode);
          }
          const islands = islandImports.map((imp) => {
            const absPath = resolve(dirname(_id), imp.specifier);
            const islandId = normalizePath(relative(root, absPath)).replace(/\.[^.]+$/, '');
            return { ...imp, islandId };
          });

          const { compile } = await import('./compile.ts');
          const result = await compile(body, { shiki: options?.shiki });

          if (adapter === 'vue') {
            return { code: emitVueComponent(result, islands), map: null };
          }

          if (adapter === 'react') {
            return { code: emitReactComponent(result, islands), map: null };
          }

          if (adapter === 'svelte') {
            const virtualId = createVirtualModuleId(SVELTE_VIRTUAL_PREFIX, _id, code, 'svelte');
            svelteModules.set(virtualId, emitSvelteComponent(result, islands));
            return {
              code: `export { default, frontmatter, headings } from ${JSON.stringify(virtualId)};`,
              map: null,
            };
          }

          if (adapter === 'solid') {
            const virtualId = createVirtualModuleId(SOLID_VIRTUAL_PREFIX, _id, code, 'tsx');
            solidModules.set(virtualId, emitSolidComponent(result, islands));
            return {
              code: `export { default, frontmatter, headings } from ${JSON.stringify(virtualId)};`,
              map: null,
            };
          }

          throw new Error(`void-md: Unsupported adapter '${adapter}'.`);
        },
      },
    },
  ];
}

function generateMdClientEntry(scripts: Map<string, string>): string {
  if (scripts.size === 0) {
    return '';
  }
  const lines: Array<string> = [];
  lines.push('const mdScripts = {');
  for (const id of scripts.keys()) {
    lines.push(
      `  ${JSON.stringify(id)}: () => import(${JSON.stringify('virtual:void-md-script:' + id)}),`,
    );
  }
  lines.push('};');
  lines.push(`const mdScriptId = document.getElementById("app")?.getAttribute("data-md-script");`);
  lines.push(`if (mdScriptId && mdScripts[mdScriptId]) mdScripts[mdScriptId]();`);
  return lines.join('\n');
}

export type { CompileOptions, CompileResult } from './compile.ts';
export type { IslandImport, ScriptExtraction } from './extract-script.ts';
