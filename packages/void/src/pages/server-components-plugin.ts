import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import MagicString from 'magic-string';
import { isAbsolute, join, relative } from 'pathslash';
import { normalizePath, parseSync, transformWithOxc, type Plugin } from 'vite';
import { staticModuleReferences } from '../shared/module-references.ts';
import { scanPages } from './scan.ts';

export const SERVER_VIEW_QUERY = '?void-server-view';
const STYLE_QUERY = '?void-server-view-styles';
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const STYLE = /\.(?:css|pcss|postcss|less|sass|scss|styl|stylus|sss)(?:$|\?)/;
const GUARD = 'virtual:void-server-hook:';
const STYLE_ENTRY = 'virtual:void-server-view-styles';
const PROJECTED_CSS = '?void-projected-css';

export function serverViewStyleId(file: string): string {
  return normalizePath(file) + STYLE_QUERY;
}

const frameworkHooks: Record<string, Array<string>> = {
  react: [
    'use',
    'useActionState',
    'useCallback',
    'useContext',
    'useDebugValue',
    'useDeferredValue',
    'useEffect',
    'useEffectEvent',
    'useId',
    'useImperativeHandle',
    'useInsertionEffect',
    'useLayoutEffect',
    'useMemo',
    'useOptimistic',
    'useReducer',
    'useRef',
    'useState',
    'useSyncExternalStore',
    'useTransition',
  ],
  'react-dom': ['useFormState', 'useFormStatus'],
  'solid-js': [
    'createComputed',
    'createDeferred',
    'createEffect',
    'createMemo',
    'createReaction',
    'createRenderEffect',
    'createResource',
    'createSelector',
    'createSignal',
    'onCleanup',
    'onMount',
    'useContext',
    'useTransition',
  ],
  'solid-js/store': ['createMutable', 'createStore'],
  vue: [
    'computed',
    'inject',
    'onMounted',
    'onUnmounted',
    'provide',
    'reactive',
    'ref',
    'shallowRef',
    'watch',
    'watchEffect',
  ],
  svelte: ['afterUpdate', 'beforeUpdate', 'getContext', 'onDestroy', 'onMount', 'setContext'],
};

/** Keep adapter transforms and styles-only client entries separate from the server import graph. */
export function serverComponentsPlugin(root: string, pagesDir: string): Array<Plugin> {
  async function styleEntries() {
    if (!existsSync(pagesDir)) {
      return [];
    }
    const scan = await scanPages(root, { pagesDir, environment: 'prod' });
    return [
      ...scan.pages.filter((page) => page.serverView).map((page) => page.componentPath),
      ...[...scan.layouts, ...scan.namedLayouts, ...(scan.boundaries ?? [])]
        .filter((view) => view.serverView)
        .map((view) => view.filePath),
    ].map((file) => serverViewStyleId(join(pagesDir, file)));
  }

  return [
    {
      name: 'void:server-components',
      enforce: 'pre',

      configEnvironment: {
        order: 'post',
        async handler(name, config, env) {
          if (env.command === 'serve' && name !== 'client') {
            // Keep hono/jsx, its automatic runtimes and hono/html on the same
            // module graph as the renderer. Optimizing a bare JSX subpath
            // separately creates incompatible JSX nodes and context stores.
            return { optimizeDeps: { exclude: ['hono'] } };
          }
          if (
            name !== 'client' ||
            env.command !== 'build' ||
            config.build?.rollupOptions?.input ||
            existsSync(join(root, 'index.html')) ||
            !(await styleEntries()).length
          ) {
            return;
          }
          return { build: { rollupOptions: { input: STYLE_ENTRY } } };
        },
      },

      async options(options) {
        if (this.environment.name !== 'client') {
          return;
        }
        const styles = await styleEntries();
        if (!styles.length) {
          return;
        }
        const input = options.input;
        if (
          !input ||
          input === STYLE_ENTRY ||
          (input === join(root, 'index.html') && !existsSync(input))
        ) {
          return { ...options, input: styles };
        }
        return {
          ...options,
          input:
            typeof input === 'string' || Array.isArray(input)
              ? [...(typeof input === 'string' ? [input] : input), ...styles]
              : { ...input, ...Object.fromEntries(styles.map((id) => [relative(root, id), id])) },
        };
      },

      async resolveId(source, importer) {
        if (source.startsWith(GUARD)) {
          if (this.environment.name === 'client') {
            this.error('Void server hook guards cannot be imported by client code.');
          }
          return '\0' + source;
        }
        const styles = source.endsWith(STYLE_QUERY) || importer?.endsWith(STYLE_QUERY);
        const server = source.endsWith(SERVER_VIEW_QUERY) || importer?.endsWith(SERVER_VIEW_QUERY);
        if (!styles && !server) {
          return;
        }
        if (server && this.environment.name === 'client') {
          this.error('Void server components cannot be imported by client code.');
        }
        const query = styles ? STYLE_QUERY : SERVER_VIEW_QUERY;
        const request = source.endsWith(query) ? source.slice(0, -query.length) : source;
        const from = importer?.endsWith(query) ? importer.slice(0, -query.length) : importer;
        const resolved = await this.resolve(request, from, { skipSelf: true });
        if (
          !resolved ||
          !isAbsolute(resolved.id) ||
          resolved.external ||
          !SCRIPT.test(resolved.id) ||
          resolved.id.includes('/node_modules/')
        ) {
          if (styles && !STYLE.test(resolved?.id ?? request)) {
            return '\0void:empty-server-view-style';
          }
          if (
            styles &&
            this.environment.mode === 'build' &&
            resolved &&
            /\.module\.[^?]+$/.test(resolved.id)
          ) {
            return { ...resolved, id: resolved.id + PROJECTED_CSS };
          }
          return resolved;
        }
        return { ...resolved, id: normalizePath(resolved.id) + query };
      },

      async load(id) {
        if (id === '\0void:empty-server-view-style') {
          return '';
        }
        if (id.startsWith('\0' + GUARD)) {
          const [framework, importer] = JSON.parse(
            decodeURIComponent(id.slice(GUARD.length + 1)),
          ) as [string, string];
          const resolved = await this.resolve(framework, importer);
          const source = JSON.stringify(resolved && !resolved.external ? resolved.id : framework);
          const hooks = frameworkHooks[framework];
          return `
          import * as original from ${source};
          export * from ${source};
          ${hooks
            .map(
              (hook) => `export function ${hook}() {
            throw new Error(${JSON.stringify(`Void server component ${relative(root, importer)} cannot call ${framework}.${hook}(). Use void/jsx for server JSX or move the hook into a client page.`)});
          }`,
            )
            .join('\n')}
          const hooks = { ${hooks.join(', ')} };
          export default new Proxy(original.default ?? original, {
            get(target, name) { return Object.hasOwn(hooks, name) ? hooks[name] : Reflect.get(target, name); }
          });
        `;
        }
        if (id.endsWith(SERVER_VIEW_QUERY) && this.environment.name === 'client') {
          this.error('Void server components cannot be loaded by client code.');
        }
        if (!id.endsWith(STYLE_QUERY)) {
          return;
        }
        const filename = id.slice(0, -STYLE_QUERY.length);
        this.addWatchFile(filename);
        const code = await readFile(filename, 'utf8');
        const parsed = parseSync(filename, code);
        const imports = [
          ...staticModuleReferences(parsed, code),
          ...parsed.module.dynamicImports.flatMap(({ start, moduleRequest }) =>
            moduleRequest && 'value' in moduleRequest && typeof moduleRequest.value === 'string'
              ? [{ start, source: moduleRequest.value }]
              : [],
          ),
        ].sort((a, b) => a.start - b.start);
        return [...new Set(imports.map((item) => item.source))]
          .map((value) => `import ${JSON.stringify(value)};`)
          .join('\n');
      },

      async transform(code, id) {
        if (!id.endsWith(SERVER_VIEW_QUERY)) {
          return;
        }
        const filename = id.slice(0, -SERVER_VIEW_QUERY.length);
        const { module } = parseSync(filename, code);
        const guard = new MagicString(code);
        const redirect = (request: { start: number; end: number; value: string }) => {
          if (Object.hasOwn(frameworkHooks, request.value)) {
            guard.overwrite(
              request.start,
              request.end,
              JSON.stringify(GUARD + encodeURIComponent(JSON.stringify([request.value, filename]))),
            );
          }
        };
        // SSR can externalize a bare package before resolveId sees it. Redirect
        // these imports in source, while leaving adapter imports untouched.
        for (const item of module.staticImports) {
          if (!item.entries.length || item.entries.some((entry) => !entry.isType)) {
            redirect(item.moduleRequest);
          }
        }
        for (const item of module.staticExports) {
          const request = item.entries.find(
            (entry) => !entry.isType && entry.moduleRequest,
          )?.moduleRequest;
          if (request) {
            redirect(request);
          }
        }
        for (const { moduleRequest } of module.dynamicImports) {
          if (
            moduleRequest &&
            'value' in moduleRequest &&
            typeof moduleRequest.value === 'string'
          ) {
            redirect({ ...moduleRequest, value: moduleRequest.value });
          }
        }
        return transformWithOxc(
          guard.toString(),
          filename,
          {
            jsx: { runtime: 'automatic', importSource: 'void/jsx' },
          },
          guard.hasChanged() ? guard.generateMap({ hires: true, source: filename }) : undefined,
        );
      },
    },
    {
      name: 'void:server-component-css',
      enforce: 'post',
      transform(_code, id) {
        if (id.endsWith(PROJECTED_CSS)) {
          // Vite normally drops unused CSS module exports and their stylesheet.
          return { moduleSideEffects: 'no-treeshake' };
        }
      },
    },
  ];
}
