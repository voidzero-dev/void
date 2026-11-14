import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'pathslash';
import type { Plugin } from 'vite';
import { createPagesPlugin, generateComponentManifest, resolvePagesDir } from 'void/pages';
import { analyze, compile, type ComponentInfo, type ModuleInfo } from './compiler.ts';
import { prepareClient } from './inline.ts';
import type { ViewResources } from './resources.ts';

export interface ViewOptions {
  root?: string;
}
/** Compile TSX views and render Void Pages as documents with optional custom elements. */
export function voidView(options: ViewOptions = {}): Array<Plugin> {
  let root = resolve(options.root ?? process.cwd());
  let modules = new Map<string, ModuleInfo>();
  let graphFiles = new Set<string>();
  let resources: ViewResources;
  let cssImports: Array<string> = [];
  const ignored = new Set(['node_modules', '.git', '.void', 'dist', '.output', '.wrangler']);
  function scan(directory: string, files: Array<string> = []): Array<string> {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        scan(path, files);
      } else if (/\.[jt]sx$/.test(path)) {
        files.push(path);
      }
    }
    return files;
  }
  async function refresh(
    resolveImport: (id: string, importer: string) => Promise<string | undefined>,
  ) {
    const next = new Map(
      scan(root).map((file) => [
        file,
        analyze(readFileSync(file, 'utf8'), file, relative(root, file).replaceAll('\\', '/')),
      ]),
    );
    // Readable names for the usual case; disambiguate same-named components by source identity.
    const counts = new Map<string, number>();
    for (const info of next.values()) {
      for (const component of info.components) {
        const name = component.id.replace(/-[a-f0-9]{8}$/, '');
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    for (const info of next.values()) {
      for (const component of info.components) {
        const name = component.id.replace(/-[a-f0-9]{8}$/, '');
        if (counts.get(name) === 1) {
          component.id = name;
        }
      }
    }
    const metadata = new Map(next);
    async function imported(source: string, importer: string): Promise<ModuleInfo | undefined> {
      const id = (await resolveImport(source, importer))?.split('?')[0];
      if (!id || !/\.[cm]?[jt]sx?$/.test(id)) {
        return;
      }
      let info = metadata.get(id);
      if (!info) {
        info = analyze(readFileSync(id, 'utf8'), id, relative(root, id));
        metadata.set(id, info);
        if (/\.[jt]sx$/.test(id)) {
          next.set(id, info);
        }
      }
      return info;
    }
    type Symbol = { module: ModuleInfo; local: string };
    async function symbol(
      info: ModuleInfo,
      name: string,
      exported = false,
      seen = new Set<string>(),
    ): Promise<Symbol | undefined> {
      const key = info.file + ':' + name + ':' + exported;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      if (exported) {
        const local = info.exports.get(name);
        if (local) {
          return symbol(info, local, false, seen);
        }
        for (const source of info.stars) {
          const target = await imported(source, info.file);
          const found = target && (await symbol(target, name, true, seen));
          if (found) {
            return found;
          }
        }
        return;
      }
      if (
        info.functions.has(name) ||
        info.components.some((component) => component.name === name)
      ) {
        return { module: info, local: name };
      }
      const [base, member] = name.split('.');
      const entry = info.imports.get(base!);
      if (!entry) {
        return;
      }
      const target = await imported(entry.source, info.file);
      return target
        ? symbol(target, entry.imported === '*' ? member! : entry.imported, true, seen)
        : undefined;
    }
    const targets = new Map<ComponentInfo, Array<ComponentInfo>>();
    const calls: Array<{
      parent: ComponentInfo;
      target: ComponentInfo;
      prop: string;
      binding?: string;
      known: boolean;
    }> = [];
    for (const info of next.values()) {
      for (const component of info.components) {
        const dependencies: Array<ComponentInfo> = [];
        const named = new Map<string, ComponentInfo>();
        for (const name of component.dependencies) {
          const resolved = await symbol(info, name);
          const target = resolved?.module.components.find(
            (component) => component.name === resolved.local,
          );
          if (!target || !next.has(resolved!.module.file)) {
            throw new Error(info.file + ': cannot resolve TSX view component ' + name);
          }
          dependencies.push(target);
          named.set(name, target);
        }
        for (const argument of component.callbackArguments) {
          const resolved = argument.value && (await symbol(info, argument.value));
          calls.push({
            parent: component,
            target: named.get(argument.tag)!,
            prop: argument.name,
            binding: argument.value && component.propBindings.get(argument.value),
            known: argument.known || !!(resolved && resolved.module.functions.has(resolved.local)),
          });
        }
        targets.set(component, dependencies);
      }
    }
    // Callback props propagate through forwarding components, regardless of source-file order.
    let changed = true;
    while (changed) {
      changed = false;
      for (const call of calls) {
        if (
          !call.known &&
          !(
            call.binding &&
            (call.parent.callbackProps.has(call.binding) || call.parent.callbackProps.has('*'))
          )
        ) {
          continue;
        }
        call.parent.dynamic = call.target.dynamic = true;
        if (!call.target.callbackProps.has(call.prop)) {
          call.target.callbackProps.add(call.prop);
          changed = true;
        }
      }
    }
    const needed = new Set<ComponentInfo>();
    function include(component: ComponentInfo) {
      if (needed.has(component)) {
        return;
      }
      needed.add(component);
      for (const target of targets.get(component) ?? []) {
        include(target);
      }
    }
    for (const info of next.values()) {
      for (const component of info.components) {
        if (component.dynamic) {
          include(component);
        }
      }
    }
    for (const info of next.values()) {
      compile(info, false);
    }
    resources = {
      components: Object.fromEntries(
        [...next.values()].flatMap((info) =>
          info.components.map((component) => [
            component.id,
            {
              dynamic: component.dynamic,
              dependencies: (targets.get(component) ?? []).map((target) => target.id),
              templates: [...component.templates],
            },
          ]),
        ),
      ),
      ...(await prepareClient(
        next,
        new Set([...needed].map((component) => component.id)),
        resolveImport,
      )),
    };
    // Include component calls reached through ordinary JS helpers as well as JSX tags.
    const sourceComponents = new Map(
      Object.entries(resources.componentUnits).map(([component, unit]) => [unit, component]),
    );
    for (const [id, entry] of Object.entries(resources.componentUnits)) {
      const dependencies = new Set(resources.components[id]!.dependencies);
      const visited = new Set<string>();
      function visit(unit: string) {
        if (visited.has(unit)) {
          return;
        }
        visited.add(unit);
        const component = sourceComponents.get(unit);
        if (component && component !== id) {
          dependencies.add(component);
          return;
        }
        for (const dependency of resources.units[unit]!.dependencies) {
          visit(dependency);
        }
      }
      visit(entry);
      resources.components[id]!.dependencies = [...dependencies];
    }
    cssImports = [];
    for (const info of next.values()) {
      for (const statement of info.program.body) {
        if (
          statement.type === 'ImportDeclaration' &&
          /\.(css|scss|sass|less)(?:\?|$)/.test(statement.source.value)
        ) {
          const css = await resolveImport(statement.source.value, info.file);
          if (css) {
            cssImports.push(css);
          }
        }
      }
    }
    cssImports = [...new Set(cssImports)];
    modules = next;
    graphFiles = new Set(metadata.keys());
  }
  const compiler: Plugin = {
    name: 'void:view:compiler',
    enforce: 'pre',
    config() {
      return { optimizeDeps: { exclude: ['@void/view'] }, ssr: { noExternal: ['@void/view'] } };
    },
    configResolved(resolved) {
      root = resolve(options.root ?? resolved.root);
    },
    async buildStart() {
      await refresh(async (id, importer) => (await this.resolve(id, importer))?.id);
      for (const path of graphFiles) {
        this.addWatchFile(path);
      }
    },
    configureServer(server) {
      const restart = (file: string) => {
        const path = relative(root, file);
        if (
          !server.httpServer?.listening ||
          path.startsWith('..') ||
          !/\.[jt]sx$/.test(path) ||
          path.split('/').some((part) => ignored.has(part) || part.startsWith('.'))
        ) {
          return;
        }
        void server.restart();
      };
      server.watcher.on('add', restart);
      server.watcher.on('unlink', restart);
    },
    transform(code, id, options) {
      const info = modules.get(id.split('?')[0]!);
      if (!info) {
        return;
      }
      // A fresh graph is built by buildStart and on source edits.
      if (code !== info.source) {
        throw new Error(`@void/view: source changed during compilation: ${id}`);
      }
      return compile(info, !options?.ssr);
    },
    async handleHotUpdate(context) {
      if (!graphFiles.has(context.file)) {
        return;
      }
      await refresh(
        async (id, importer) =>
          (await context.server.environments.client.pluginContainer.resolveId(id, importer))?.id,
      );
      for (const environment of Object.values(context.server.environments)) {
        environment.moduleGraph.invalidateAll();
      }
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
  const pages = createPagesPlugin(resolvePagesDir(root), {
    name: 'void:view:pages',
    root,
    config() {
      return {
        build: {
          manifest: true,
          rollupOptions: { input: { 'pages-client': 'virtual:void-pages-client' } },
        },
      };
    },
    generateClient() {
      return cssImports.map((file) => `import ${JSON.stringify(file)};`).join('\n');
    },
    generateRenderer(pageScan) {
      return `
import { render, renderResources } from '@void/view/server';
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from 'void/pages-head';
const resources = ${JSON.stringify(resources)};
${generateComponentManifest(pageScan, resolvePagesDir(root))}
export async function renderPage(page, assets) {
  const Page = (await components[page.component]()).default;
  let content = Page(page.props ?? {});
  const layouts = layoutTree[page.component] ?? [];
  for (let i = layouts.length - 1; i >= 0; i--) {
    const Layout = (await components[layouts[i]]()).default;
    content = Layout({ children: content });
  }
  return '<!doctype html><html' + (page.head ? renderHtmlAttrs(page.head) : '') + '><head>' +
    (page.head ? renderHeadToString(page.head) : '') + assets.css + assets.preloads +
    '</head><body' + (page.head ? renderBodyAttrs(page.head) : '') + '>' + render(content) +
    (page.documentOnly ? '' : renderResources(content.components, resources)) + '</body></html>';
}
`;
    },
  });
  return [compiler, pages];
}
